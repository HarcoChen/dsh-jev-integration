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
const registeredTools = new Map()
const registeredGuards = []
let jevAttempts = 0
let safetyFailures = 0
let failFeatureCalls = false
let decisionFailures = false
let tokenFailureMode = undefined
let lastJevBody
let nativePrunerCalls = 0
let semanticShapeAttempts = 0
services.set('tools', {
  register(definition) {
    registeredTools.set(definition.name, definition)
    return () => registeredTools.delete(definition.name)
  },
  guard(guard) {
    registeredGuards.push(guard)
    return () => {
      const index = registeredGuards.indexOf(guard)
      if (index >= 0) registeredGuards.splice(index, 1)
    }
  },
})
const fakeSkills = Array.from({ length: 8 }, (_, index) => ({
  name: index === 0 ? 'typescript-debugging' : `unused-skill-${index}`,
  description: index === 0 ? 'Debug TypeScript build and type errors.' : 'Unrelated reference skill.',
  whenToUse: index === 0 ? 'Use when a TypeScript build or typecheck fails.' : 'Use for unrelated tasks.',
  invocation: { modelInvocable: true },
}))
services.set('skills', {
  async snapshot() { return { skills: fakeSkills, complete: true } },
  async get(name) {
    return { name, description: `Advice for ${name}.`, content: name === 'typescript-debugging' ? 'Run typecheck first, then inspect the first compiler error.' : '' }
  },
})
services.set('tokenMeter', {
  estimateMessage(message) {
    const text = JSON.stringify(message)
    return Math.ceil(text.length / 4)
  },
  measure(session) {
    const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
    return { totalTokens: Math.ceil(JSON.stringify(messages).length / 4) }
  },
})
services.set('toolResultPruner', {
  measureContent(blocks) {
    return blocks.filter(block => block?.type === 'text').reduce((total, block) => total + Array.from(block.text).length, 0)
  },
  pruneContent(blocks) {
    nativePrunerCalls += 1
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n')
    if (text.length <= 5_000) return null
    const kept = `${text.slice(0, 1_000)}\n[DSH native deterministic prune]\n${text.slice(-500)}`
    return [{ type: 'text', text: kept }]
  },
})
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
    const body = JSON.parse(init.body)
    lastJevBody = body
    if (Object.keys(body.questions).some(key => key.startsWith('kind_'))) semanticShapeAttempts += 1
    assert.equal(body.model, 'jev-latest')
    assert.equal(typeof body.state, 'string')
    if (tokenFailureMode === 'timeout' && Object.keys(body.questions).some(key => key.startsWith('kind_'))) throw new DOMException('timed out', 'AbortError')
    if (tokenFailureMode === '429' && Object.keys(body.questions).some(key => key.startsWith('kind_'))) return new Response('rate limited', { status: 429 })
    if (tokenFailureMode === '5xx' && Object.keys(body.questions).some(key => key.startsWith('kind_'))) return new Response('upstream failed', { status: 503 })
    if (body.questions.is_destructive && safetyFailures++ === 0) throw new TypeError('fetch failed')
    if (failFeatureCalls && (Object.keys(body.questions).some(key => key.startsWith('tool_')) || Object.keys(body.questions).some(key => key.startsWith('skill_')))) throw new TypeError('feature unavailable')
    if (decisionFailures && (Object.keys(body.questions).some(key => key.startsWith('rank_')) || Object.keys(body.questions).some(key => key === 'holds') || Object.keys(body.questions).some(key => key === 'supported'))) throw new TypeError('decision unavailable')
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
    if (Object.keys(body.questions).some(key => key.startsWith('tool_'))) {
      const answers = {}
      for (const [key, question] of Object.entries(body.questions)) {
        answers[key] = { type: 'score', score: String(question.instructions).includes('read_file') ? 2 : 0.5, confidence: 0.95 }
      }
      return new Response(JSON.stringify({ answers }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (Object.keys(body.questions).some(key => key.startsWith('skill_'))) {
      const answers = {}
      for (const [key, question] of Object.entries(body.questions)) {
        answers[key] = { type: 'score', score: String(question.instructions).includes('typescript-debugging') ? 2 : 0.1, confidence: 0.95 }
      }
      return new Response(JSON.stringify({ answers }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (Object.keys(body.questions).some(key => key.startsWith('rank_'))) {
      const answers = {}
      for (const [key] of Object.entries(body.questions)) answers[key] = { type: 'score', score: 2, confidence: 0.95 }
      return new Response(JSON.stringify({ answers }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (body.questions.holds) {
      return new Response(JSON.stringify({ answers: { holds: { type: 'noul', noul: 0.9 } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (Object.keys(body.questions).some(key => key === 'supported')) {
      const answers = {}
      for (const [key, question] of Object.entries(body.questions)) answers[key] = question.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: question.type, score: 2, confidence: 0.95 }
      return new Response(JSON.stringify({ answers }), { status: 200, headers: { 'content-type': 'application/json' } })
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
assert.equal(capabilities.data.capabilities.toolPruner, true)
assert.equal(capabilities.data.capabilities.skillRouter, true)
assert.equal(capabilities.data.capabilities.decisionTools, true)
assert.equal(capabilities.data.capabilities.deterministicSafetyGuard, true)
assert.equal(capabilities.data.capabilities.tokenMeter, true)
assert.equal(capabilities.data.capabilities.toolResultPruner, true)
assert.equal(capabilities.data.capabilities.tokenOptimization, true)

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
    tokenOptimization: {
      enabled: true,
      deterministicFirst: true,
      minInputTokens: 1,
      minEstimatedSavingsTokens: 1,
      semanticFallback: true,
      maxDecisionLatencyMs: 1000,
    },
    doneGate: { enabled: true },
    toolPruner: { enabled: true, maxTools: 2, minKeep: 1, minConfidence: 0.5 },
    skillRouter: { enabled: true, minCandidates: 8, maxSkills: 1, minConfidence: 0.5 },
    decisionTools: { enabled: true },
    deterministicSafetyGuard: {
      enabled: true,
      customRules: [{ id: 'deny-temp-rm', category: 'destructive', pattern: 'rm\\s+-rf\\s+/var/tmp', reason: 'custom temporary tree rule' }],
    },
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
await new Promise(resolve => setTimeout(resolve, 0))
const promptAssemble = handlers.get('system-prompt/assemble')
assert.ok(promptAssemble, 'system-prompt/assemble hook was mounted')
const featureSession = {
  id: 'session-feature',
  header: { cwd: '/workspace' },
  deriveMessages() {
    return [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the TypeScript build and inspect the relevant files.' }] }]
  },
}
const originalAssembly = {
  sections: [],
  contexts: [{ name: 'user-context', order: 1, text: 'Keep this user context.' }],
  tools: [
    { name: 'read_file', description: 'Read a file.' },
    { name: 'irrelevant_one', description: 'Unrelated cloud deployment.' },
    { name: 'irrelevant_two', description: 'Unrelated image editing.' },
    { name: 'irrelevant_three', description: 'Unrelated database migration.' },
    { name: 'irrelevant_four', description: 'Unrelated browser automation.' },
  ],
  variables: {},
}
const assembled = await promptAssemble(originalAssembly, { agent: { session: featureSession }, scope: featureSession, signal: new AbortController().signal }, async () => originalAssembly)
assert.equal(assembled.tools.some(tool => tool.name === 'read_file'), true, 'tool pruner must retain necessary tools')
assert.ok(assembled.tools.length < originalAssembly.tools.length, 'tool pruner should remove low-ranked schemas')
assert.equal(assembled.contexts.some(context => context.name === 'user-context'), true, 'skill router must preserve user contexts')
assert.ok(assembled.contexts.some(context => context.name === 'dsh-jev:skill-router'), 'skill router should add advice context')
assert.ok(registeredTools.has('jev_ask'), 'jev_ask should be registered only after explicit enablement')
assert.ok(registeredTools.has('jev_rank'), 'jev_rank should be registered')
assert.ok(registeredTools.has('jev_check'), 'jev_check should be registered')
const askOutput = await registeredTools.get('jev_ask').execute({ state: 'build evidence', questions: [{ id: 'supported', kind: 'noul', instructions: 'Is the evidence sufficient?' }] }, { agent: { session: featureSession }, signal: new AbortController().signal })
assert.equal(askOutput.ok, true)
const rankOutput = await registeredTools.get('jev_rank').execute({ state: 'build task', criterion: 'relevance', candidates: [{ id: 'ts', label: 'TypeScript compiler' }, { id: 'image', label: 'unrelated image' }] }, { agent: { session: featureSession }, signal: new AbortController().signal })
assert.equal(rankOutput.ok, true)
const checkOutput = await registeredTools.get('jev_check').execute({ state: 'build passed', claim: 'The build is complete', threshold: 0.7 }, { agent: { session: featureSession }, signal: new AbortController().signal })
assert.equal(checkOutput.holds, true)
const boundedAskOutput = await registeredTools.get('jev_ask').execute({ state: 'x'.repeat(20_000), questions: [{ id: 'supported', kind: 'noul', instructions: 'Is the evidence sufficient?' }] }, { agent: { session: featureSession }, signal: new AbortController().signal })
assert.equal(boundedAskOutput.unknown, true, 'decision tools should reject overlong state without sending it')
decisionFailures = true
const failOpenDecision = await registeredTools.get('jev_rank').execute({ state: 'build task', criterion: 'relevance', candidates: [{ id: 'ts', label: 'TypeScript compiler' }] }, { agent: { session: featureSession }, signal: new AbortController().signal })
decisionFailures = false
assert.equal(failOpenDecision.unknown, true, 'decision tool failures should return structured unknown')
const cancelledController = new AbortController()
cancelledController.abort()
const cancelledDecision = await registeredTools.get('jev_check').execute({ state: 'build passed', claim: 'The build is complete' }, { agent: { session: featureSession }, signal: cancelledController.signal })
assert.equal(cancelledDecision.unknown, true, 'decision tools should observe cancellation')
assert.ok(registeredGuards.length >= 1, 'deterministic guard should be installed when tools.guard exists')
const deniedByDeterministic = registeredGuards[0]({ name: 'bash', arguments: { command: 'sudo rm -rf /tmp/build' }, agent: { session: featureSession } })
assert.ok(deniedByDeterministic, 'deterministic guard should deny dangerous commands')
const deniedPrivilege = registeredGuards[0]({ name: 'bash', arguments: { command: 'sudo -n id' }, agent: { session: featureSession } })
assert.ok(deniedPrivilege, 'deterministic guard should deny privilege elevation')
const deniedCredentialLeak = registeredGuards[0]({ name: 'bash', arguments: { command: 'printf %s "$TYPESAFE_API_KEY"' }, agent: { session: featureSession } })
assert.ok(deniedCredentialLeak, 'deterministic guard should deny credential exposure')
const allowedByDeterministic = registeredGuards[0]({ name: 'bash', arguments: { command: 'printf hello' }, agent: { session: featureSession } })
assert.equal(allowedByDeterministic, undefined)
const deniedByCustomRule = registeredGuards[0]({ name: 'bash', arguments: { command: 'rm -rf /var/tmp/dsh-jev' }, agent: { session: featureSession } })
assert.ok(deniedByCustomRule, 'custom deterministic safety rule should deny matching commands')
failFeatureCalls = true
const failOpenAssembly = await promptAssemble(originalAssembly, { agent: { session: featureSession }, scope: featureSession, signal: new AbortController().signal }, async () => originalAssembly)
failFeatureCalls = false
assert.equal(failOpenAssembly.tools.length, originalAssembly.tools.length, 'pruner timeout must fail open')
const preExecute = handlers.get('tools/pre-execute')
assert.ok(preExecute, 'tools/pre-execute hook was mounted')
const attemptsBeforeSafety = jevAttempts
const decision = await preExecute({
  name: 'bash',
  arguments: { command: 'rm -rf /' },
  agent: { session: { id: 'session-smoke', header: { cwd: '/workspace' } } },
}, async () => ({ kind: 'allow', action: 'allow' }))
assert.equal(decision.kind, 'deny')
assert.equal(jevAttempts - attemptsBeforeSafety, 2, 'transient Jev failure should be retried once')

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
const attemptsBeforeSemanticShape = semanticShapeAttempts
const shapedDecision = await postExecute({ name: 'bash', arguments: { command: 'build' }, agent: shaperAgent }, {
  isError: false,
  content: [{ type: 'text', text: longOutput }],
}, async () => ({ kind: 'accept', action: 'accept' }))
assert.equal(shapedDecision.kind, 'accept')
assert.ok(Array.isArray(shapedDecision.content), 'result shaper should preserve DSH content blocks')
assert.ok(String(shapedDecision.content[0].text).includes('lines dropped'))
assert.ok(semanticShapeAttempts > attemptsBeforeSemanticShape, 'semantic fallback should run when native pruning is insufficient')
assert.ok(String(shapedDecision.content[0].text).includes('ERROR failed item 999'), 'semantic shaping must preserve failure content')

const deterministicOutput = `${Array.from({ length: 500 }, (_, index) => `INFO repeated item ${index}`).join('\n')}\nWARNING keep this warning\nERROR keep this error\n`
const attemptsBeforeDeterministic = semanticShapeAttempts
const deterministicDecision = await postExecute({ name: 'bash', arguments: { command: 'collect' }, agent: { session: { id: 'session-deterministic', header: { cwd: '/workspace' } } } }, {
  isError: false,
  content: [{ type: 'text', text: deterministicOutput }],
}, async () => ({ kind: 'accept', action: 'accept' }))
assert.ok(nativePrunerCalls >= 2, 'native DSH result pruner should run before semantic fallback')
assert.equal(semanticShapeAttempts, attemptsBeforeDeterministic, 'deterministic pruning should avoid a Jev decision when it is sufficient')
assert.ok(String(deterministicDecision.content[0].text).includes('WARNING keep this warning'))
assert.ok(String(deterministicDecision.content[0].text).includes('ERROR keep this error'))

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

await preExecute({
  name: 'bash',
  arguments: { command: 'curl -H "Authorization: Bearer super-secret-token-value"' },
  agent: { session: featureSession },
}, async () => ({ kind: 'allow', action: 'allow' }))

const statsRoute = routes.get('GET /api/dsh-jev/stats')
const safetyStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-smoke'))).json()
assert.equal(safetyStats.data.totalCalls, 1)
assert.equal(safetyStats.data.denyDecisions, 1)
const loopStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-loop'))).json()
assert.ok(loopStats.data.loopGuardInterruptions >= 1)
const shaperStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-shaper'))).json()
assert.ok(shaperStats.data.resultShaperCalls >= 1)
assert.ok(shaperStats.data.decisionCalls >= 1, 'semantic result shaping should record decision calls')
assert.ok(shaperStats.data.decisionLatencyMs >= 0)
assert.ok(shaperStats.data.inputTokensBefore !== null)
assert.ok(shaperStats.data.inputTokensAfter !== null)
assert.ok(shaperStats.data.tokensRemoved !== null)
assert.ok(shaperStats.data.netTokensSaved !== null)
assert.equal(shaperStats.data.estimatedCostUsd, null)
assert.equal(shaperStats.data.cacheHitRate, null)
const deterministicStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-deterministic'))).json()
assert.ok(deterministicStats.data.skippedLowRoi >= 1, 'deterministic/low-ROI skips should be counted')
const doneStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-done'))).json()
assert.ok(doneStats.data.doneGateInterventions >= 1)
const featureStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-feature'))).json()
assert.ok(featureStats.data.toolPrunerCalls >= 1)
assert.ok(featureStats.data.toolPrunerFailOpen >= 1)
assert.ok(featureStats.data.toolPrunerToolsSeen >= originalAssembly.tools.length)
assert.ok(featureStats.data.toolPrunerRemovedChars > 0)
assert.ok(featureStats.data.skillRouterCalls >= 1)
assert.ok(featureStats.data.skillRouterFailOpen >= 1)
assert.ok(featureStats.data.skillRouterAdviceCount >= 1)
assert.ok(featureStats.data.decisionToolCalls >= 3)
assert.ok(featureStats.data.decisionToolUnknown >= 1)
assert.ok(featureStats.data.decisionToolFailOpen >= 2)
assert.ok(featureStats.data.deterministicGuardChecks >= 4)
assert.ok(featureStats.data.deterministicGuardDenies >= 3)
assert.ok(featureStats.data.deterministicRuleHits['deny-temp-rm'] >= 1)
assert.ok(featureStats.data.credentialClassHits['suspected-credential'] >= 1)
assert.equal(String(lastJevBody.state).includes('TYPESAFE_API_KEY'), false, 'credential references must be redacted before Jev')

for (const [mode, expected] of [['timeout', 'timeout'], ['429', '429'], ['5xx', '5xx']]) {
  tokenFailureMode = mode
  const failureSession = { id: `session-token-${mode}`, header: { cwd: '/workspace' } }
  await postExecute({ name: 'bash', arguments: { command: 'build' }, agent: { session: failureSession } }, {
    isError: false,
    content: [{ type: 'text', text: longOutput }],
  }, async () => ({ kind: 'accept', action: 'accept' }))
  const failureStats = await (await statsRoute.fetch(new Request(`http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-token-${mode}`))).json()
  assert.ok(failureStats.data.failOpen >= 1, `${mode} must fail open`)
  assert.equal(failureStats.data.lastFailureType, expected)
}
tokenFailureMode = undefined
const cancelledTokenController = new AbortController()
cancelledTokenController.abort()
await postExecute({ name: 'bash', arguments: { command: 'build' }, signal: cancelledTokenController.signal, agent: { session: { id: 'session-token-cancel', header: { cwd: '/workspace' } } } }, {
  isError: false,
  content: [{ type: 'text', text: longOutput }],
}, async () => ({ kind: 'accept', action: 'accept' }))
const cancelledTokenStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-token-cancel'))).json()
assert.equal(cancelledTokenStats.data.lastFailureType, 'cancel')

services.delete('tokenMeter')
await postExecute({ name: 'bash', arguments: { command: 'build' }, agent: { session: { id: 'session-no-meter', header: { cwd: '/workspace' } } } }, {
  isError: false,
  content: [{ type: 'text', text: longOutput }],
}, async () => ({ kind: 'accept', action: 'accept' }))
const noMeterStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-no-meter'))).json()
assert.equal(noMeterStats.data.inputTokensBefore, null)
assert.equal(noMeterStats.data.inputTokensAfter, null)
assert.equal(noMeterStats.data.tokensRemoved, null)
assert.equal(noMeterStats.data.netTokensSaved, null)
services.set('tokenMeter', {
  estimateMessage(message) { return Math.ceil(JSON.stringify(message).length / 4) },
  measure() { return { totalTokens: 0 } },
})

const sessionDisposed = handlers.get('session/disposed')
assert.ok(sessionDisposed, 'session/disposed hook was mounted')
const disposedStatsSession = { id: 'session-disposed-stats', header: { cwd: '/workspace' } }
await postExecute({ name: 'bash', arguments: { command: 'collect' }, agent: { session: disposedStatsSession } }, {
  isError: false,
  content: [{ type: 'text', text: deterministicOutput }],
}, async () => ({ kind: 'accept', action: 'accept' }))
await sessionDisposed(disposedStatsSession)
const clearedStats = await (await statsRoute.fetch(new Request('http://runtime/api/dsh-jev/stats?workspaceId=workspace-smoke&sessionId=session-disposed-stats'))).json()
assert.equal(clearedStats.data.decisionCalls, 0, 'disposed session statistics must not leak into a reused session id')

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
console.log('dsh-jev-integration smoke: PASS (mount, capabilities, config, token meter/pruner, ROI gates, fail-open, safety redaction, session isolation, policy hooks, state, SSE)')
