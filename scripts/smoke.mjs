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
  baseUrl: 'https://startup.example.test/v1/systemone',
  persistenceRootDir: persistenceRoot,
  fetch: async (_url, init) => {
    jevAttempts += 1
    assert.equal(init.method, 'POST')
    if (jevAttempts === 1) throw new TypeError('fetch failed')
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'jev-latest')
    assert.equal(typeof body.state, 'string')
    if (Object.keys(body.questions).some(key => key.startsWith('kind_'))) {
      const answers = {}
      for (const [key, question] of Object.entries(body.questions)) {
        answers[key] = {
          type: 'choice',
          choice: String(question.instructions).includes('ERROR') ? 'failure' : 'routine_progress',
          confidence: 0.95,
        }
      }
      return new Response(JSON.stringify({ answers }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (body.questions.has_progress) {
      return new Response(JSON.stringify({ answers: {
        has_progress: { type: 'noul', noul: 0.05 },
        stuck_severity: { type: 'score', score: 1.9, confidence: 0.95, probabilities: { '0': 0.01, '1': 0.04, '2': 0.95 } },
      } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (body.questions.claims_completion) {
      return new Response(JSON.stringify({ answers: {
        claims_completion: { type: 'noul', noul: 0.95 },
        evidence_sufficient: { type: 'noul', noul: 0.05 },
      } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
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
assert.equal(capabilities.data.protocolVersion, '1.1')
assert.equal(capabilities.data.pluginMounted, true)

const configRoute = routes.get('GET,POST /api/dsh-jev/config')
assert.ok(configRoute, 'config route was mounted')
const initialConfigResponse = await configRoute.fetch(new Request('http://runtime/api/dsh-jev/config?workspaceId=workspace-smoke'))
const initialConfig = await initialConfigResponse.json()
assert.equal(initialConfig.data.source, 'startup')
assert.equal(initialConfig.data.scope, 'global')
assert.equal(initialConfig.data.persisted, false)
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
  body: JSON.stringify({ workspaceId: 'workspace-smoke', scope: 'workspace', patch: {
    enabled: true,
    loopGuard: { enabled: true, triggerThreshold: 1 },
    resultShaper: { enabled: true, thresholdChars: 100, maxPerTurn: 2 },
    doneGate: { enabled: true },
  } }),
}))
assert.equal(enableResponse.status, 200)
const enabledConfig = await enableResponse.clone().json()
assert.equal(enabledConfig.data.values.loopGuard.triggerThreshold, 1)
const nestedPatchResponse = await configRoute.fetch(new Request('http://runtime/api/dsh-jev/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'workspace-smoke', scope: 'workspace', patch: {
    loopGuard: { requestTimeoutMs: 3200 },
  } }),
}))
assert.equal(nestedPatchResponse.status, 200)
const nestedConfig = await nestedPatchResponse.json()
assert.equal(nestedConfig.data.values.loopGuard.triggerThreshold, 1, 'nested config updates should deep-merge')
const preExecute = handlers.get('tools/pre-execute')
assert.ok(preExecute, 'tools/pre-execute hook was mounted')
const decision = await preExecute({
  name: 'bash',
  arguments: { command: 'rm -rf /' },
  agent: { session: { id: 'session-smoke', header: { cwd: '/workspace' } } },
}, async () => ({ kind: 'allow', action: 'allow' }))
assert.equal(decision.kind, 'deny')
assert.equal(jevAttempts, 2, 'transient Jev failure should be retried once')

const postExecute = handlers.get('tools/post-execute')
assert.ok(postExecute, 'tools/post-execute hook was mounted')
const sessionEvent = handlers.get('session/event')
assert.ok(sessionEvent, 'session/event hook was mounted')
const loopAgent = { session: { id: 'session-loop', header: { cwd: '/workspace' } } }
const loopDecision = await postExecute({ name: 'bash', arguments: { command: 'echo loop' }, agent: loopAgent }, {
  isError: false,
  content: [{ type: 'text', text: 'same output' }],
}, async () => ({ kind: 'accept', action: 'accept' }))
assert.equal(loopDecision.kind, 'accept')
assert.ok(Array.isArray(loopDecision.additionalContexts), 'loop guard should attach a corrective context')

const shaperAgent = { session: { id: 'session-shaper', header: { cwd: '/workspace' } } }
const longOutput = `${Array.from({ length: 140 }, (_, index) => `INFO processed item ${index}`).join('\n')}\nERROR failed item 999\n`
const shapedDecision = await postExecute({ name: 'bash', arguments: { command: 'build' }, agent: shaperAgent }, {
  isError: false,
  content: [{ type: 'text', text: longOutput }],
}, async () => ({ kind: 'accept', action: 'accept' }))
assert.equal(shapedDecision.kind, 'accept')
assert.ok(Array.isArray(shapedDecision.content), 'result shaper should preserve DSH content blocks')
assert.ok(String(shapedDecision.content[0].text).includes('lines dropped'))

const doneSession = { id: 'session-done', header: { cwd: '/workspace' } }
await sessionEvent(doneSession, { type: 'turn/start', data: { turn: 2 } })
await sessionEvent(doneSession, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'implement the feature' }] } })
await sessionEvent(doneSession, { type: 'tool/result', data: {
  message: { content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: 'build passed' }] }] },
} })
await sessionEvent(doneSession, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已完成，实现了这个功能。' }] } } })
let steered
const stopping = handlers.get('agent/turn-stopping')
assert.ok(stopping, 'agent/turn-stopping hook was mounted')
await stopping({
  agent: { session: doneSession, steer(message) { steered = message } },
  turn: 2,
  signal: new AbortController().signal,
})
assert.ok(steered, 'done/evidence gate should steer an unsupported completion claim')

const statsRoute = routes.get('GET /api/dsh-jev/stats')
const safetyStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-smoke'))).json()
assert.equal(safetyStats.data.totalCalls, 1)
assert.equal(safetyStats.data.denyDecisions, 1)
const loopStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-loop'))).json()
assert.ok(loopStats.data.loopGuardInterruptions >= 1)
const shaperStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-shaper'))).json()
assert.ok(shaperStats.data.resultShaperCalls >= 1)
const doneStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-done'))).json()
assert.ok(doneStats.data.doneGateInterventions >= 1)

const sessionOverrideResponse = await configRoute.fetch(new Request('http://runtime/api/dsh-jev/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'workspace-smoke', sessionId: 'session-done', scope: 'session', patch: {
    doneGate: { enabled: false },
  } }),
}))
assert.equal(sessionOverrideResponse.status, 200)
const disposedConfig = await (await configRoute.fetch(new Request('http://runtime/api/dsh-jev/config?workspaceId=workspace-smoke&sessionId=session-done'))).json()
assert.equal(disposedConfig.data.values.doneGate.enabled, false)
const sessionDisposed = handlers.get('session/disposed')
assert.ok(sessionDisposed, 'session/disposed hook was mounted')
await sessionDisposed(doneSession)
const configAfterDispose = await (await configRoute.fetch(new Request('http://runtime/api/dsh-jev/config?workspaceId=workspace-smoke&sessionId=session-done'))).json()
assert.equal(configAfterDispose.data.values.doneGate.enabled, true, 'session config should be cleared on disposal')

const nextTurnResponse = await configRoute.fetch(new Request('http://runtime/api/dsh-jev/config', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ workspaceId: 'workspace-smoke', sessionId: 'session-smoke', scope: 'next-turn', patch: { enabled: false } }),
}))
assert.equal(nextTurnResponse.status, 200)
const sessionStateBeforeTurn = await stateRoute.fetch(new Request('http://runtime/api/dsh-jev/state?workspaceId=workspace-smoke&sessionId=session-smoke'))
assert.equal((await sessionStateBeforeTurn.json()).data.effective.enabled, false)
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
console.log('dsh-jev-integration smoke: PASS (mount, capabilities, config, policy hooks, state, SSE)')
