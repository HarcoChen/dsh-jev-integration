import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../dist/runtime/src/index.js'

const persistenceRoot = await mkdtemp(join(tmpdir(), 'dsh-jev-integration-'))
const routes = new Map()
const services = new Map()
const disposers = []
const handlers = new Map()
let jevAttempts = 0
const context = {
  get(name) {
    return services.get(name)
  },
  provide(name, value) {
    services.set(name, value)
  },
  on(_event, _callback) {
    handlers.set(_event, _callback)
    const dispose = () => undefined
    disposers.push(dispose)
    return dispose
  },
  effect(effect) {
    const cleanup = effect()
    if (typeof cleanup === 'function') disposers.push(cleanup)
  },
  workspaceRegistry: {
    async resolveByPath() {
      return { id: 'workspace-smoke' }
    },
  },
  connection: {
    fetch: {
      async register(route) {
        routes.set(`${route.methods.join(',')} ${route.path}`, route)
        return async () => routes.delete(`${route.methods.join(',')} ${route.path}`)
      },
    },
  },
  logger: { warn() {}, info() {} },
}

const disposePlugin = apply(context, {
  apiKey: 'smoke-key',
  persistenceRootDir: persistenceRoot,
  fetch: async (_url, init) => {
    jevAttempts += 1
    assert.equal(init.method, 'POST')
    if (jevAttempts === 1) throw new TypeError('fetch failed')
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'jev-latest')
    assert.equal(typeof body.state, 'string')
    assert.ok(body.questions.is_destructive)
    return new Response(JSON.stringify({
      answers: {
        is_destructive: { type: 'noul', noul: 0.9 },
        is_exfiltration: { type: 'noul', noul: 0.01 },
        is_jailbreak: { type: 'noul', noul: 0.01 },
        risk_score: { type: 'score', score: 2 },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  },
})
const integration = services.get('jevIntegration')
assert.ok(integration, 'integration service was provided')
await integration.whenReady()

const capabilitiesRoute = routes.get('GET /api/dsh-jev/capabilities')
assert.ok(capabilitiesRoute, 'capabilities route was mounted')
const capabilitiesResponse = await capabilitiesRoute.fetch(new Request('http://runtime/api/dsh-jev/capabilities'))
assert.equal(capabilitiesResponse.status, 200)
const capabilities = await capabilitiesResponse.json()
assert.equal(capabilities.ok, true)
assert.equal(capabilities.data.protocolVersion, '1.0')
assert.equal(capabilities.data.pluginMounted, true)

const configRoute = routes.get('GET,POST /api/dsh-jev/config')
assert.ok(configRoute, 'config route was mounted')
const updateResponse = await configRoute.fetch(new Request('http://runtime/api/dsh-jev/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    workspaceId: 'workspace-smoke',
    scope: 'workspace',
    patch: { enabled: false },
  }),
}))
assert.equal(updateResponse.status, 200)
const updated = await updateResponse.json()
assert.equal(updated.data.values.enabled, false)

const stateRoute = routes.get('GET /api/dsh-jev/state')
const stateResponse = await stateRoute.fetch(new Request('http://runtime/api/dsh-jev/state?workspaceId=workspace-smoke'))
const state = await stateResponse.json()
assert.equal(state.data.userRequested.enabled, false)
assert.equal(state.data.effective.enabled, false)
assert.equal(state.data.executing, false)

const enableResponse = await configRoute.fetch(new Request('http://runtime/api/dsh-jev/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'workspace-smoke', scope: 'workspace', patch: { enabled: true } }),
}))
assert.equal(enableResponse.status, 200)
const preExecute = handlers.get('tools/pre-execute')
assert.ok(preExecute, 'tools/pre-execute hook was mounted')
const decision = await preExecute({
  name: 'bash',
  arguments: { command: 'rm -rf /' },
  agent: { session: { id: 'session-smoke', header: { cwd: '/workspace' } } },
}, async () => ({ kind: 'allow', action: 'allow' }))
assert.equal(decision.kind, 'deny')
assert.equal(jevAttempts, 2, 'transient Jev failure should be retried once')

const statsRoute = routes.get('GET /api/dsh-jev/stats')
const statsResponse = await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-smoke'))
const stats = await statsResponse.json()
assert.equal(stats.data.totalCalls, 1)
assert.equal(stats.data.denyDecisions, 1)

const nextTurnResponse = await configRoute.fetch(new Request('http://runtime/api/dsh-jev/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'workspace-smoke', sessionId: 'session-smoke', scope: 'next-turn', patch: { enabled: false } }),
}))
assert.equal(nextTurnResponse.status, 200)
const sessionStateBeforeTurn = await stateRoute.fetch(new Request('http://runtime/api/dsh-jev/state?workspaceId=workspace-smoke&sessionId=session-smoke'))
assert.equal((await sessionStateBeforeTurn.json()).data.effective.enabled, false)
const sessionEvent = handlers.get('session/event')
assert.ok(sessionEvent, 'session/event hook was mounted')
await sessionEvent({ id: 'session-smoke', header: { cwd: '/workspace' } }, { type: 'turn/start', data: { turn: 1 } })
await new Promise(resolve => setTimeout(resolve, 0))
const sessionStateAfterTurn = await stateRoute.fetch(new Request('http://runtime/api/dsh-jev/state?workspaceId=workspace-smoke&sessionId=session-smoke'))
assert.equal((await sessionStateAfterTurn.json()).data.effective.enabled, true)

const eventsRoute = routes.get('GET /api/dsh-jev/events')
const eventsResponse = await eventsRoute.fetch(new Request('http://runtime/api/dsh-jev/events?workspaceId=workspace-smoke'))
assert.equal(eventsResponse.headers.get('content-type'), 'text/event-stream; charset=utf-8')
const reader = eventsResponse.body.getReader()
const firstEvent = await reader.read()
assert.equal(firstEvent.done, false)
await reader.cancel()

await integration.dispose()
await integration.stats.flush()
disposePlugin()
await rm(persistenceRoot, { recursive: true, force: true })
console.log('dsh-jev-integration smoke: PASS (mount, capabilities, config, state, SSE)')
