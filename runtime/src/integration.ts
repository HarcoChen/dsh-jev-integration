import {
  ERROR_CODE_NAMES,
  MIN_DSH_RUNTIME_VERSION,
  PROTOCOL_VERSION,
  type CapabilitiesResponse,
  type ConfigScope,
  type ConfigResponse,
  type ErrorCode,
  type IntegrationConfigPatch,
  type RuntimeState,
  type StateEvent,
  type StateEventType,
  type StatisticsSnapshot,
} from '../../protocol/src/index.js'
import { ConfigState, validateConfigPatch } from './config-state.js'
import { JevClient, JevClientError, noulProbability, type JevCallRequest, type JevCallResult, type JevQuestion } from './jev-client.js'
import { IntegrationPersistence } from './persistence.js'
import { DoneEvidencePolicy, type CompletionTrace } from './policies/done-gate.js'
import { LoopGuardPolicy } from './policies/loop-guard.js'
import { extractText as extractShaperText, replaceText } from './policies/result-shaper.js'
import { ResultShaperPolicy } from './policies/result-shaper.js'
import { JevSkillRouterPolicy } from './policies/skill-router.js'
import { JevToolPrunerService, type ToolPruneResult } from './policies/tool-pruner.js'
import { evaluateDeterministicSafety } from './policies/deterministic-safety.js'
import { registerDecisionTools } from './decision-tools.js'
import { StatisticsStore } from './stats.js'
import type {
  AgentTurnStoppingPayload,
  ConnectionLike,
  CordisContextLike,
  FetchRoute,
  PostToolDecisionLike,
  PostToolNext,
  PreToolDecisionLike,
  PreToolNext,
  RuntimePluginOptions,
  ToolResultLike,
  ToolExecutionLike,
  ToolPrunerServiceLike,
  ToolsServiceLike,
  SkillsServiceLike,
  ToolSchemaLike,
  WorkspaceLike,
} from './types.js'
import { VERSION } from './version.js'

interface ScopeIdentity {
  workspaceId: string
  sessionId?: string
}

interface Availability {
  available: boolean
  reason?: string
  errorCode?: ErrorCode
}

interface Subscriber {
  workspaceId: string
  sessionId?: string
  callback: (event: StateEvent) => void
}

function scopeKey(identity: ScopeIdentity): string {
  return JSON.stringify([identity.workspaceId, identity.sessionId ?? null])
}

function parseUrl(request: Request): URL {
  return new URL(request.url, 'http://dsh-jev.local')
}

function jsonResponse(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

function success<T>(data: T): Response {
  return jsonResponse({ ok: true, data })
}

function errorResponse(code: ErrorCode, message: string, status: number, details?: Record<string, unknown>, retryable = false): Response {
  const error: { code: ErrorCode; name: string; message: string; retryable: boolean; details?: Record<string, unknown> } = {
    code,
    name: ERROR_CODE_NAMES[code],
    message,
    retryable,
  }
  if (details !== undefined) error.details = details
  return jsonResponse({ ok: false, error }, status)
}

function requiredQuery(url: URL, name: string): string | Response {
  const value = url.searchParams.get(name)?.trim()
  return value ? value : errorResponse('DJE-0002', `${name} is required`, 400)
}

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim()
  return value || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function serviceFromContext<T>(context: CordisContextLike, name: string): T | undefined {
  try {
    const value = context.get?.(name)
    if (value !== undefined) return value as T
  } catch {
    // Optional Cordis services may throw when the service is not injected.
  }
  try {
    const direct = context[name]
    return direct === undefined ? undefined : direct as T
  } catch {
    return undefined
  }
}

interface PromptAssemblyLike {
  sections?: unknown[]
  contexts?: unknown[]
  tools?: ToolSchemaLike[]
  variables?: Record<string, string | undefined>
  [key: string]: unknown
}

interface PromptAssembleContextLike {
  agent?: unknown
  scope?: unknown
  signal?: AbortSignal
}

function extractPromptAgent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (isRecord(value.agent)) return value.agent
  if (isRecord(value.scope) && isRecord(value.scope.session)) return value.scope
  return undefined
}

function extractAgentIntent(agent: unknown, assembly: PromptAssemblyLike): string {
  if (isRecord(agent)) {
    const session = isRecord(agent.session) ? agent.session : undefined
    const derive = session?.deriveMessages
    if (typeof derive === 'function') {
      try {
        const messages = derive.call(session) as unknown
        if (Array.isArray(messages)) {
          const userMessages = messages
            .filter(message => isRecord(message) && isUserSource(message.source))
            .map(message => extractTextFromMessage(message))
            .filter(Boolean)
          const last = userMessages.at(-1)
          if (last) return last.slice(-4_000)
        }
      } catch {
        // Fall back to the assembly when a host-provided session is partial.
      }
    }
  }
  const candidates: string[] = []
  for (const section of assembly.sections ?? []) {
    if (isRecord(section) && typeof section.text === 'string') candidates.push(section.text)
  }
  for (const context of assembly.contexts ?? []) {
    if (isRecord(context) && typeof context.text === 'string') candidates.push(context.text)
  }
  return candidates.join('\n').slice(-4_000)
}

function toolSchemaNames(tools: readonly ToolSchemaLike[]): Set<string> {
  return new Set(tools.map(tool => tool.name).filter(Boolean))
}

async function parseBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

function eventMatches(subscriber: Subscriber, event: StateEvent): boolean {
  return subscriber.workspaceId === event.workspaceId && (subscriber.sessionId === undefined || subscriber.sessionId === event.sessionId)
}

function extractSession(value: unknown): { id?: string; cwd?: string } {
  if (!isRecord(value)) return {}
  const header = isRecord(value.header) ? value.header : undefined
  const id = typeof value.id === 'string' ? value.id : undefined
  const cwd = header && typeof header.cwd === 'string' ? header.cwd : undefined
  const result: { id?: string; cwd?: string } = {}
  if (id !== undefined) result.id = id
  if (cwd !== undefined) result.cwd = cwd
  return result
}

function extractTurnEvent(value: unknown): { type?: string } {
  if (!isRecord(value)) return {}
  const type = typeof value.type === 'string' ? value.type : undefined
  return type === undefined ? {} : { type }
}

function extractEventData(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.data)) return undefined
  return value.data
}

function extractTextFromMessage(value: unknown): string {
  if (!isRecord(value)) return ''
  const direct = extractShaperText(value.content)
  if (direct) return direct
  if (!Array.isArray(value.content)) return ''
  return value.content
    .filter(block => isRecord(block) && block.type === 'tool-result')
    .map(block => extractShaperText(block.content) ?? '')
    .filter(text => text.length > 0)
    .join('\n')
}

function isUserSource(value: unknown): boolean {
  return isRecord(value) && value.kind === 'user'
}

function isCompletionAgent(value: unknown): value is { session?: unknown; steer?: (message: unknown) => void } {
  return Boolean(value) && typeof value === 'object'
}

function asNext(value: unknown): PreToolNext {
  return typeof value === 'function' ? value as PreToolNext : async () => ({ kind: 'allow', action: 'allow' })
}

function responseScopeForSource(source: ConfigResponse['source']): ConfigScope {
  if (source === 'workspace') return 'workspace'
  if (source === 'session') return 'session'
  if (source === 'next-turn') return 'next-turn'
  // `default` and the read-only `startup` composition layer are deployment-
  // wide values, so the response shape uses global as their writable scope.
  return 'global'
}

const ADVISORY_RETRIES = 1
const ADVISORY_RETRY_DELAY_MS = 150

function isRetryableAdvisoryError(error: unknown): error is JevClientError {
  if (!(error instanceof JevClientError)) return false
  if (error.kind === 'timeout' || error.kind === 'network') return true
  return error.kind === 'http' && (error.status === 429 || (error.status !== undefined && error.status >= 500))
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new JevClientError('cancelled', 'Jev call was cancelled before retry'))
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new JevClientError('cancelled', 'Jev call was cancelled before retry'))
    }
    timer = setTimeout(finish, delayMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function callAdvisoryWithRetry(
  client: JevClient,
  request: JevCallRequest,
  options: { timeoutMs: number; signal?: AbortSignal },
  onRetry: (attempt: number, error: JevClientError) => void,
): Promise<JevCallResult> {
  let retry = 0
  for (;;) {
    try {
      return await client.systemOne(request, options)
    } catch (error) {
      if (!(error instanceof JevClientError) || !isRetryableAdvisoryError(error) || retry >= ADVISORY_RETRIES || options.signal?.aborted) {
        throw error
      }
      retry += 1
      onRetry(retry, error)
      await waitForRetry(ADVISORY_RETRY_DELAY_MS * retry, options.signal)
    }
  }
}

export class JevIntegration {
  public readonly name = 'dsh-jev-integration'
  public readonly persistence: IntegrationPersistence
  public readonly configState: ConfigState
  public readonly stats: StatisticsStore
  public readonly ready: Promise<void>

  private readonly context: CordisContextLike
  private readonly options: RuntimePluginOptions
  private readonly availability = new Map<string, Availability>()
  private readonly activeRequests = new Map<string, number>()
  private readonly lastDecisions = new Map<string, RuntimeState['lastDecision']>()
  private readonly lastErrors = new Map<string, { code: ErrorCode; message: string }>()
  private readonly subscribers = new Set<Subscriber>()
  private readonly loopGuard = new LoopGuardPolicy()
  private readonly resultShaper = new ResultShaperPolicy()
  private readonly doneGate = new DoneEvidencePolicy()
  private readonly skillRouter = new JevSkillRouterPolicy()
  private readonly ownToolPruner = new JevToolPrunerService()
  private readonly sessionTraces = new Map<string, CompletionTrace>()
  private readonly sessionEventQueues = new Map<string, Promise<void>>()
  private readonly sessionScopes = new Map<string, ScopeIdentity>()
  private readonly sessionObjects = new Map<string, unknown>()
  private readonly disposedSessions = new Set<string>()
  private readonly hookDisposers: Array<() => void> = []
  private decisionToolDisposers: Array<() => void> = []
  private readonly decisionToolNames = new Set<string>()
  private decisionToolsRegistered = false
  private toolPrunerService: ToolPrunerServiceLike | undefined
  private toolPrunerProvidedDisposer: (() => void) | undefined
  private deterministicGuardDisposer: (() => void) | undefined
  private extensionsReady = false
  private readonly routeDisposers: Array<() => Promise<void>> = []
  private serviceDisposer: (() => void) | undefined
  private eventSequence = 0
  private mounted = false
  private endpointAvailable = false
  private endpointReason = 'connection-unavailable'
  private connectionRegistrationStarted = false
  private routeReady: Promise<void> = Promise.resolve()

  public constructor(context: CordisContextLike, options: RuntimePluginOptions = {}) {
    this.context = context
    this.options = options
    this.persistence = new IntegrationPersistence(options.persistenceRootDir)
    const startupPatch: IntegrationConfigPatch = {}
    if (options.enabled !== undefined) startupPatch.enabled = options.enabled
    if (options.baseUrl !== undefined) startupPatch.baseUrl = options.baseUrl
    if (options.model !== undefined) startupPatch.model = options.model
    if (options.timeoutMs !== undefined) startupPatch.timeoutMs = options.timeoutMs
    if (options.advisoryTimeoutMs !== undefined) startupPatch.advisoryTimeoutMs = options.advisoryTimeoutMs
    if (options.askThreshold !== undefined) startupPatch.askThreshold = options.askThreshold
    if (options.blockThreshold !== undefined) startupPatch.blockThreshold = options.blockThreshold
    if (options.guardedTools !== undefined) startupPatch.guardedTools = [...options.guardedTools]
    if (options.loopGuard !== undefined) startupPatch.loopGuard = { ...options.loopGuard }
    if (options.resultShaper !== undefined) startupPatch.resultShaper = { ...options.resultShaper }
    if (options.doneGate !== undefined) startupPatch.doneGate = { ...options.doneGate }
    if (options.toolPruner !== undefined) startupPatch.toolPruner = { ...options.toolPruner }
    if (options.skillRouter !== undefined) startupPatch.skillRouter = { ...options.skillRouter }
    if (options.decisionTools !== undefined) startupPatch.decisionTools = { ...options.decisionTools }
    if (options.deterministicSafetyGuard !== undefined) startupPatch.deterministicSafetyGuard = { ...options.deterministicSafetyGuard }
    const validation = validateConfigPatch(startupPatch)
    this.configState = new ConfigState(this.persistence, validation.patch ?? {})
    this.stats = new StatisticsStore(this.persistence)
    this.stats.setOnChanged(snapshot => this.emitStatsChanged(snapshot))
    this.stats.setOnPersistenceError(error => this.context.logger?.warn?.(`dsh-jev-integration: stats persistence failed: ${String(error)}`))
    this.ready = Promise.all([this.configState.ready, this.stats.ready]).then(() => undefined)
  }

  public async whenReady(): Promise<void> {
    await this.ready
    await this.routeReady
  }

  public mount(): this {
    if (this.mounted) return this
    this.mounted = true
    const provided = this.context.provide?.('jevIntegration', this)
    if (typeof provided === 'function') this.serviceDisposer = provided as () => void
    this.registerHooks()
    void this.ready.then(() => this.installRuntimeExtensions()).catch(error => {
      this.context.logger?.warn?.(`dsh-jev-integration: optional Runtime extensions unavailable: ${String(error)}`)
    })
    this.routeReady = this.mountConnectionRoutes()
    this.context.effect?.(() => () => this.dispose())
    return this
  }

  public async dispose(): Promise<void> {
    if (!this.mounted) return
    this.mounted = false
    for (const disposer of this.hookDisposers.splice(0)) disposer()
    for (const disposer of this.decisionToolDisposers.splice(0)) disposer()
    this.decisionToolNames.clear()
    this.toolPrunerProvidedDisposer?.()
    this.toolPrunerProvidedDisposer = undefined
    this.deterministicGuardDisposer?.()
    this.deterministicGuardDisposer = undefined
    this.toolPrunerService = undefined
    this.extensionsReady = false
    this.serviceDisposer?.()
    this.serviceDisposer = undefined
    for (const disposer of this.routeDisposers.splice(0)) {
      try {
        await disposer()
      } catch (error) {
        this.context.logger?.warn?.(`dsh-jev-integration: route cleanup failed: ${String(error)}`)
      }
    }
    // Deliberately do not stop or reset a shared Jev client: another Connection
    // may still be using this Runtime. Only this integration's subscriptions go.
    this.subscribers.clear()
    this.sessionTraces.clear()
    this.sessionEventQueues.clear()
    this.sessionScopes.clear()
    this.sessionObjects.clear()
    this.disposedSessions.clear()
    this.endpointAvailable = false
    this.endpointReason = 'plugin-unmounted'
    this.connectionRegistrationStarted = false
  }

  private registerHooks(): void {
    const preDisposer = this.context.on?.('tools/pre-execute', ((exec: unknown, next: unknown) => this.preExecute(exec, asNext(next))) as (...args: unknown[]) => unknown)
    if (typeof preDisposer === 'function') this.hookDisposers.push(preDisposer)
    const postDisposer = this.context.on?.(
      'tools/post-execute',
      ((exec: unknown, result: unknown, next: unknown) => this.postExecute(
        exec,
        result,
        typeof next === 'function' ? next as PostToolNext : async () => ({ kind: 'accept', action: 'accept' }),
      )) as (...args: unknown[]) => unknown,
    )
    if (typeof postDisposer === 'function') this.hookDisposers.push(postDisposer)
    const preStepDisposer = this.context.on?.('agent/pre-step', ((payload: unknown, next: unknown) => {
      this.resetPolicyForNewUserMessage(payload)
      return typeof next === 'function' ? (next as () => Promise<unknown>)() : undefined
    }) as (...args: unknown[]) => unknown)
    if (typeof preStepDisposer === 'function') this.hookDisposers.push(preStepDisposer)
    const stoppingDisposer = this.context.on?.('agent/turn-stopping', ((payload: unknown) => {
      return this.onTurnStopping(payload)
    }) as (...args: unknown[]) => unknown)
    if (typeof stoppingDisposer === 'function') this.hookDisposers.push(stoppingDisposer)
    const sessionDisposer = this.context.on?.('session/event', ((session: unknown, event: unknown) => {
      return this.enqueueSessionEvent(session, event)
    }) as (...args: unknown[]) => unknown)
    if (typeof sessionDisposer === 'function') this.hookDisposers.push(sessionDisposer)
    const sessionDisposedDisposer = this.context.on?.('session/disposed', ((session: unknown) => {
      return this.disposeSessionState(session)
    }) as (...args: unknown[]) => unknown)
    if (typeof sessionDisposedDisposer === 'function') this.hookDisposers.push(sessionDisposedDisposer)
    const promptDisposer = this.context.on?.(
      'system-prompt/assemble',
      ((assembly: unknown, assembleContext: unknown, next: unknown) => this.onPromptAssemble(
        assembly,
        assembleContext,
        typeof next === 'function' ? next as () => Promise<unknown> : undefined,
      )) as (...args: unknown[]) => unknown,
    )
    if (typeof promptDisposer === 'function') this.hookDisposers.push(promptDisposer)
  }

  private getToolsService(): ToolsServiceLike | undefined {
    return serviceFromContext<ToolsServiceLike>(this.context, 'tools')
  }

  private getSkillsService(): SkillsServiceLike | undefined {
    return serviceFromContext<SkillsServiceLike>(this.context, 'skills')
  }

  private executionIdentity(exec: ToolExecutionLike): ScopeIdentity | undefined {
    const session = exec.agent && isRecord(exec.agent) ? exec.agent.session : undefined
    const sessionId = extractSession(session).id
    if (sessionId !== undefined) return this.sessionScopes.get(sessionId)
    return undefined
  }

  private installRuntimeExtensions(): void {
    if (!this.mounted || this.extensionsReady) return
    this.extensionsReady = true
    const existingPruner = serviceFromContext<ToolPrunerServiceLike>(this.context, 'toolPruner')
    if (existingPruner?.pruneTools) {
      this.toolPrunerService = existingPruner
    } else if (typeof this.context.provide === 'function') {
      try {
        // A bare DSH Runtime has no upstream `ctx.toolPruner`; expose this
        // Jev-backed implementation through the same service seam. If the
        // host refuses the optional provider, the prompt hook fails open.
        const provided = this.context.provide?.('toolPruner', this.ownToolPruner)
        this.toolPrunerService = this.ownToolPruner
        if (typeof provided === 'function') this.toolPrunerProvidedDisposer = provided as () => void
      } catch (error) {
        this.context.logger?.debug?.(`dsh-jev-integration: ctx.toolPruner is not providable: ${String(error)}`)
      }
    }
    const tools = this.getToolsService()
    if (tools?.guard) {
      try {
        const registered = tools.guard((execution) => {
          const identity = this.executionIdentity(execution)
          const resolved = this.configState.resolve(identity?.workspaceId ?? '__deterministic-guard__', identity?.sessionId)
          const match = evaluateDeterministicSafety(execution, resolved.values.guardedTools, resolved.values.deterministicSafetyGuard)
          if (identity) this.stats.recordDeterministicGuard(identity.workspaceId, identity.sessionId, match !== undefined)
          return match === undefined ? undefined : `[DSH Jev deterministic safety] ${match.reason}. Review the command and request explicit approval.`
        })
        if (typeof registered === 'function') this.deterministicGuardDisposer = registered as () => void
      } catch (error) {
        this.context.logger?.debug?.(`dsh-jev-integration: ctx.tools.guard is unavailable: ${String(error)}`)
      }
    }
    void this.refreshDecisionToolsRegistration()
  }

  private async refreshDecisionToolsRegistration(workspaceId?: string, sessionId?: string): Promise<void> {
    if (!this.mounted || !this.extensionsReady) return
    await this.ready
    if (!this.mounted || !this.extensionsReady) return
    const resolved = this.configState.resolve(workspaceId ?? '__decision-tools__', sessionId)
    const shouldRegister = resolved.values.enabled && resolved.values.decisionTools.enabled
    if (!shouldRegister) {
      // Tool definitions live at the Runtime service scope, while enablement
      // may be workspace/session-specific. Keep a shared registration for
      // other clients and hide these names in the narrower prompt assembly;
      // dispose() is the lifecycle boundary that unregisters them.
      return
    }
    if (this.decisionToolsRegistered) return
    const tools = this.getToolsService()
    if (!tools?.register) return
    const config = resolved.values.decisionTools
    try {
      this.decisionToolNames.clear()
      this.decisionToolDisposers = registerDecisionTools(tools, {
        config,
        register: definition => tools.register?.(definition),
        onRegistered: name => this.decisionToolNames.add(name),
        resolveConfig: exec => {
          const session = exec?.agent && isRecord(exec.agent) ? exec.agent.session : undefined
          const sessionIdForConfig = extractSession(session).id
          const identity = sessionIdForConfig === undefined ? undefined : this.sessionScopes.get(sessionIdForConfig)
          return this.configState.resolve(
            identity?.workspaceId ?? workspaceId ?? '__decision-tools__',
            identity?.sessionId ?? sessionIdForConfig ?? sessionId,
          ).values.decisionTools
        },
        call: async (request, options, exec) => {
          const session = exec?.agent && isRecord(exec.agent) ? exec.agent.session : undefined
          const identity = await this.resolveWorkspace(session)
          if (!identity) throw new JevClientError('missing-api-key', 'workspace/session scope is unavailable')
          const current = this.configState.resolve(identity.workspaceId, identity.sessionId)
          if (!current.values.enabled || !current.values.decisionTools.enabled) throw new JevClientError('missing-api-key', 'decision tools are disabled for this scope')
          const client = new JevClient(current.values, this.options.apiKey, this.options.fetch)
          return this.invokePolicy(identity, client, request, options.timeoutMs, options.signal)
        },
        record: (outcome, latencyMs, exec) => {
          const identity = (exec ? this.executionIdentity(exec) : undefined)
            ?? (workspaceId ? { workspaceId, ...(sessionId !== undefined ? { sessionId } : {}) } : undefined)
          if (identity) this.stats.recordDecisionTool(identity.workspaceId, identity.sessionId, outcome, latencyMs)
        },
      })
      this.decisionToolsRegistered = this.decisionToolNames.size > 0
    } catch (error) {
      this.decisionToolDisposers = []
      this.decisionToolNames.clear()
      this.context.logger?.warn?.(`dsh-jev-integration: decision tool registration failed: ${String(error)}`)
    }
  }

  private async onPromptAssemble(
    assemblyValue: unknown,
    contextValue: unknown,
    next?: () => Promise<unknown>,
  ): Promise<unknown> {
    let assembledValue: unknown
    try {
      assembledValue = next ? await next() : assemblyValue
    } catch (error) {
      this.context.logger?.warn?.(`dsh-jev-integration: prompt assembly downstream failed: ${String(error)}`)
      return assemblyValue
    }
    await this.ready
    if (!this.mounted || !isRecord(assembledValue)) return assembledValue
    const assembly = assembledValue as PromptAssemblyLike
    const assembleContext = isRecord(contextValue) ? contextValue as PromptAssembleContextLike : {}
    const agent = extractPromptAgent(assembleContext)
    const session = agent && isRecord(agent) ? agent.session : undefined
    const identity = await this.resolveWorkspace(session)
    if (!identity) return assembledValue
    if (identity.sessionId !== undefined) this.sessionScopes.set(identity.sessionId, identity)
    const resolved = this.configState.resolve(identity.workspaceId, identity.sessionId)
    if (!resolved.values.enabled && Array.isArray(assembly.tools)) {
      return { ...assembly, tools: assembly.tools.filter(tool => !this.decisionToolNames.has(tool.name)) }
    }
    if (!resolved.values.enabled) return assembledValue
    const intent = extractAgentIntent(agent, assembly)
    const client = new JevClient(resolved.values, this.options.apiKey, this.options.fetch)
    if (!(await client.hasApiKey())) {
      if (resolved.values.toolPruner.enabled) this.stats.recordToolPruner(identity.workspaceId, identity.sessionId, 'fail-open', assembly.tools?.length ?? 0, assembly.tools?.length ?? 0)
      if (resolved.values.skillRouter.enabled) this.stats.recordSkillRouter(identity.workspaceId, identity.sessionId, 'fail-open')
      if (!resolved.values.decisionTools.enabled && Array.isArray(assembly.tools)) {
        return { ...assembly, tools: assembly.tools.filter(tool => !this.decisionToolNames.has(tool.name)) }
      }
      return assembledValue
    }
    let output: PromptAssemblyLike = { ...assembly }
    if (!resolved.values.decisionTools.enabled && Array.isArray(output.tools)) {
      // Decision tools are registered at the Runtime service scope, while a
      // config can be narrower. Hide only our own schemas for disabled scopes;
      // all DSH-provided tools and permission rules remain untouched.
      output.tools = output.tools.filter(tool => !this.decisionToolNames.has(tool.name))
    }
    if (resolved.values.toolPruner.enabled && Array.isArray(output.tools) && this.toolPrunerService?.pruneTools) {
      // Prune the already-filtered model-facing list. This prevents a stale
      // decision-tool schema from being reintroduced when a narrower scope has
      // disabled this integration's registered tools.
      const candidates = output.tools
      try {
        let pruneResult: ToolPruneResult
        if (this.toolPrunerService === this.ownToolPruner) {
          pruneResult = await this.ownToolPruner.prune(intent, candidates, {
            config: resolved.values.toolPruner,
            call: (request, options) => this.invokePolicy(identity, client, request, options.timeoutMs, options.signal),
            ...(assembleContext.signal !== undefined ? { signal: assembleContext.signal } : {}),
          })
        } else {
          const started = Date.now()
          const returned = await this.toolPrunerService.pruneTools(intent, candidates, {
            config: resolved.values.toolPruner,
            call: (request, options) => this.invokePolicy(identity, client, request, options.timeoutMs, options.signal),
            ...(assembleContext.signal !== undefined ? { signal: assembleContext.signal } : {}),
          })
          const names = toolSchemaNames(candidates)
          const returnedNames = new Set(returned.map(tool => tool.name).filter(name => names.has(name)))
          const mandatory = new Set(['run_code', 'skill', 'jev_ask', 'jev_rank', 'jev_check', ...resolved.values.toolPruner.alwaysRetain])
          const safeTools = candidates.filter(tool => returnedNames.has(tool.name) || mandatory.has(tool.name))
          pruneResult = {
            tools: safeTools.length > 0 ? safeTools : candidates,
            outcome: 'call',
            seen: candidates.length,
            kept: safeTools.length > 0 ? safeTools.length : candidates.length,
            removedChars: Math.max(0, JSON.stringify(candidates).length - JSON.stringify(safeTools.length > 0 ? safeTools : candidates).length),
            latencyMs: Date.now() - started,
          }
        }
        this.stats.recordToolPruner(identity.workspaceId, identity.sessionId, pruneResult.outcome, pruneResult.seen, pruneResult.kept, pruneResult.removedChars, pruneResult.latencyMs)
        output.tools = pruneResult.tools as ToolSchemaLike[]
      } catch {
        this.stats.recordToolPruner(identity.workspaceId, identity.sessionId, 'fail-open', candidates.length, candidates.length)
      }
    } else if (resolved.values.toolPruner.enabled) {
      this.stats.recordToolPruner(
        identity.workspaceId,
        identity.sessionId,
        this.toolPrunerService === undefined ? 'fail-open' : 'skipped',
        assembly.tools?.length ?? 0,
        assembly.tools?.length ?? 0,
      )
    }
    if (resolved.values.skillRouter.enabled) {
      const skills = this.getSkillsService()
      if (!skills) {
        this.stats.recordSkillRouter(identity.workspaceId, identity.sessionId, 'skipped')
      } else {
        const routed = await this.skillRouter.route(intent, {
          config: resolved.values.skillRouter,
          service: skills,
          call: (request, options) => this.invokePolicy(identity, client, request, options.timeoutMs, options.signal),
          ...(extractSession(session).cwd !== undefined ? { cwd: extractSession(session).cwd } : {}),
          ...(assembleContext.scope !== undefined || agent !== undefined ? { scope: assembleContext.scope ?? agent } : {}),
          ...(assembleContext.signal !== undefined ? { signal: assembleContext.signal } : {}),
        })
        this.stats.recordSkillRouter(identity.workspaceId, identity.sessionId, routed.outcome, routed.adviceCount, routed.adviceChars, routed.latencyMs)
        if (routed.advice.length > 0) {
          const contexts = Array.isArray(output.contexts) ? output.contexts.filter(context => !(isRecord(context) && context.name === 'dsh-jev:skill-router')) : []
          contexts.push({ name: 'dsh-jev:skill-router', order: 7_500, text: routed.advice.join('\n\n') })
          output.contexts = contexts
        }
      }
    }
    return output
  }

  private getConnection(context = this.context): ConnectionLike | undefined {
    // Cordis only exposes service properties on a context that declared the
    // service in `inject`. `ctx.get()` is safe for the optional connection;
    // keep the direct-property fallback for the small host/test contexts that
    // implement the service as a plain object.
    let viaGet: unknown
    try {
      viaGet = context.get?.('connection')
    } catch {
      viaGet = undefined
    }
    if (isRecord(viaGet) && isRecord(viaGet.fetch) && typeof viaGet.fetch.register === 'function') return viaGet as unknown as ConnectionLike
    try {
      const direct = context.connection
      if (direct && isRecord(direct.fetch) && typeof direct.fetch.register === 'function') return direct
    } catch {
      // An uninjected Cordis property is intentionally ignored; the inject
      // callback below will retry when Connection becomes available.
    }
    return undefined
  }

  private async mountConnectionRoutes(): Promise<void> {
    const immediate = this.getConnection()
    if (immediate) {
      await this.registerConnectionRoutes(immediate)
      return
    }
    this.endpointAvailable = false
    this.endpointReason = 'connection-unavailable'
    this.context.inject?.(['connection'], child => {
      const connection = this.getConnection(child)
      if (connection) void this.registerConnectionRoutes(connection)
    })
  }

  private async registerConnectionRoutes(connection: ConnectionLike): Promise<void> {
    if (this.endpointAvailable || this.connectionRegistrationStarted) return
    this.connectionRegistrationStarted = true
    const routes: FetchRoute[] = [
      { path: '/api/dsh-jev/capabilities', methods: ['GET'], requestBody: 'buffered', fetch: request => this.routeCapabilities(request) },
      { path: '/api/dsh-jev/config', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => this.routeConfig(request) },
      { path: '/api/dsh-jev/state', methods: ['GET'], requestBody: 'buffered', fetch: request => this.routeState(request) },
      { path: '/api/dsh-jev/stats', methods: ['GET'], requestBody: 'buffered', fetch: request => this.routeStats(request) },
      { path: '/api/dsh-jev/stats/reset', methods: ['POST'], requestBody: 'buffered', fetch: request => this.routeStatsReset(request) },
      { path: '/api/dsh-jev/events', methods: ['GET'], requestBody: 'streaming', fetch: request => this.routeEvents(request) },
    ]
    try {
      for (const route of routes) {
        const disposer = await connection.fetch.register(route)
        this.routeDisposers.push(disposer)
      }
      this.endpointAvailable = true
      this.endpointReason = 'ready'
      this.context.logger?.info?.('dsh-jev-integration: Connection endpoints mounted')
    } catch (error) {
      for (const disposer of this.routeDisposers.splice(0)) {
        try {
          await disposer()
        } catch {
          // The original registration already failed; keep the retry bounded.
        }
      }
      this.endpointAvailable = false
      this.endpointReason = 'route-registration-failed'
      this.connectionRegistrationStarted = false
      this.context.logger?.warn?.(`dsh-jev-integration: Connection endpoint registration failed: ${String(error)}`)
    }
  }

  private async resolveWorkspace(session: unknown): Promise<ScopeIdentity | undefined> {
    const identity = extractSession(session)
    if (!identity.id && !identity.cwd) return undefined
    if (!identity.cwd) return identity.id ? undefined : undefined
    let registry: { resolveByPath?: (path: string) => Promise<WorkspaceLike | undefined> } | undefined
    try {
      registry = this.context.get?.('workspaceRegistry') as { resolveByPath?: (path: string) => Promise<WorkspaceLike | undefined> } | undefined
    } catch {
      registry = undefined
    }
    if (registry === undefined) {
      try {
        registry = this.context.workspaceRegistry
      } catch {
        registry = undefined
      }
    }
    if (!registry?.resolveByPath) return undefined
    try {
      const workspace = await registry.resolveByPath(identity.cwd)
      if (!workspace?.id) return undefined
      const result: ScopeIdentity = { workspaceId: workspace.id }
      if (identity.id !== undefined) result.sessionId = identity.id
      return result
    } catch {
      return undefined
    }
  }

  private availabilityFor(identity: ScopeIdentity): Availability | undefined {
    return this.availability.get(scopeKey(identity))
  }

  private async getState(identity: ScopeIdentity): Promise<RuntimeState> {
    await this.ready
    const resolved = this.configState.resolve(identity.workspaceId, identity.sessionId)
    const key = scopeKey(identity)
    const storedAvailability = this.availabilityFor(identity)
    let available = storedAvailability?.available
    let reason = storedAvailability?.reason
    if (available === undefined) {
      const client = new JevClient(resolved.values, this.options.apiKey, this.options.fetch)
      available = await client.hasApiKey()
      if (!available) reason = 'missing-api-key'
    }
    const state: RuntimeState = {
      workspaceId: identity.workspaceId,
      userRequested: { enabled: resolved.requestedEnabled, source: resolved.requestedEnabledSource },
      effective: {
        enabled: resolved.values.enabled,
        active: resolved.values.enabled && available,
        values: resolved.values,
        source: resolved.source,
      },
      available,
      executing: (this.activeRequests.get(key) ?? 0) > 0,
      activeRequests: this.activeRequests.get(key) ?? 0,
      updatedAt: new Date().toISOString(),
    }
    if (identity.sessionId !== undefined) state.sessionId = identity.sessionId
    if (reason !== undefined) state.availabilityReason = reason
    const lastDecision = this.lastDecisions.get(key)
    if (lastDecision !== undefined) state.lastDecision = lastDecision
    const lastError = this.lastErrors.get(key)
    if (lastError) {
      state.lastErrorCode = lastError.code
      state.lastErrorMessage = lastError.message
    }
    return state
  }

  private setAvailability(identity: ScopeIdentity, available: boolean, reason?: string, errorCode?: ErrorCode): void {
    const value: Availability = { available }
    if (reason !== undefined) value.reason = reason
    if (errorCode !== undefined) value.errorCode = errorCode
    this.availability.set(scopeKey(identity), value)
    if (errorCode !== undefined && reason !== undefined) this.lastErrors.set(scopeKey(identity), { code: errorCode, message: reason })
    if (available) this.lastErrors.delete(scopeKey(identity))
    void this.publishState(identity)
  }

  private setDecision(identity: ScopeIdentity, decision: RuntimeState['lastDecision']): void {
    this.lastDecisions.set(scopeKey(identity), decision)
    void this.publishState(identity)
  }

  private incrementActive(identity: ScopeIdentity): void {
    const key = scopeKey(identity)
    this.activeRequests.set(key, (this.activeRequests.get(key) ?? 0) + 1)
    void this.publishState(identity)
  }

  private decrementActive(identity: ScopeIdentity): void {
    const key = scopeKey(identity)
    const count = Math.max(0, (this.activeRequests.get(key) ?? 1) - 1)
    if (count === 0) this.activeRequests.delete(key)
    else this.activeRequests.set(key, count)
    void this.publishState(identity)
  }

  private async invokePolicy(
    identity: ScopeIdentity,
    client: JevClient,
    request: JevCallRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<JevCallResult> {
    const requestBytesEstimate = new TextEncoder().encode(JSON.stringify({
      model: request.model ?? client.model,
      state: typeof request.state === 'string' ? request.state : JSON.stringify(request.state),
      questions: request.questions,
    })).byteLength
    const finishActive = this.stats.begin(identity.workspaceId, identity.sessionId, requestBytesEstimate)
    this.incrementActive(identity)
    const started = Date.now()
    try {
      const callOptions: { timeoutMs: number; signal?: AbortSignal } = signal === undefined ? { timeoutMs } : { timeoutMs, signal }
      const result = await callAdvisoryWithRetry(client, request, callOptions, (attempt, error) => {
        this.context.logger?.debug?.(`dsh-jev-integration: retrying Jev policy (${attempt}/${ADVISORY_RETRIES}) after ${error.kind}`)
      })
      this.stats.recordCall(identity.workspaceId, identity.sessionId, {
        ok: true,
        latencyMs: Date.now() - started,
        requestBytes: result.requestBytes,
        responseBytes: result.responseBytes,
      })
      this.setAvailability(identity, true)
      return result
    } catch (error) {
      const jevError = error instanceof JevClientError ? error : undefined
      this.stats.recordCall(identity.workspaceId, identity.sessionId, {
        ok: false,
        latencyMs: Date.now() - started,
        requestBytes: requestBytesEstimate,
        responseBytes: 0,
        timedOut: jevError?.kind === 'timeout',
        cancelled: jevError?.kind === 'cancelled',
      })
      const code: ErrorCode = jevError?.kind === 'timeout'
        ? 'DJE-0008'
        : jevError?.kind === 'cancelled'
          ? 'DJE-0009'
          : 'DJE-0007'
      const message = jevError?.message ?? (error instanceof Error ? error.message : String(error))
      this.setAvailability(identity, false, message, code)
      throw error
    } finally {
      finishActive()
      this.decrementActive(identity)
    }
  }

  private async preExecute(execValue: unknown, next: PreToolNext): Promise<PreToolDecisionLike> {
    await this.ready
    const exec = isRecord(execValue) ? execValue as ToolExecutionLike : {}
    const toolName = typeof exec.name === 'string' ? exec.name : ''
    const session = exec.agent && isRecord(exec.agent) ? exec.agent.session : undefined
    const identity = await this.resolveWorkspace(session)
    if (!identity) return next()
    if (identity.sessionId !== undefined) this.sessionScopes.set(identity.sessionId, identity)
    const resolved = this.configState.resolve(identity.workspaceId, identity.sessionId)
    if (!resolved.values.enabled || !resolved.values.guardedTools.includes(toolName)) {
      this.stats.recordSkipped(identity.workspaceId, identity.sessionId)
      this.setDecision(identity, 'skipped')
      return next()
    }
    const client = new JevClient(resolved.values, this.options.apiKey, this.options.fetch)
    if (!(await client.hasApiKey())) {
      this.stats.recordSkipped(identity.workspaceId, identity.sessionId)
      this.setAvailability(identity, false, 'missing-api-key', 'DJE-0007')
      this.setDecision(identity, 'skipped')
      return next()
    }
    const state = {
      workspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      tool: toolName,
      arguments: exec.arguments ?? exec.args,
    }
    const questions: Record<string, JevQuestion> = {
      is_destructive: { type: 'noul', instructions: 'Does this tool call attempt unrecoverable destruction such as rm -rf, dropping a database, or wiping git history?' },
      is_exfiltration: { type: 'noul', instructions: 'Does this tool call send private credentials, keys, or secrets to a remote endpoint?' },
      is_jailbreak: { type: 'noul', instructions: 'Does this tool call contain an injection payload, jailbreak attempt, or deliberate sandbox escape?' },
      risk_score: {
        type: 'score',
        instructions: 'Rate the overall risk and potential irreversible damage of executing this tool action.',
        criteria: [
          'Low risk: standard development or read/write operations',
          'Moderate risk: broad file modification, network egress, or elevated command',
          'Critical risk: catastrophic deletion, privilege violation, or active credential leak',
        ],
      },
    }
    const requestBytesEstimate = new TextEncoder().encode(JSON.stringify({ model: resolved.values.model, state: JSON.stringify(state), questions })).byteLength
    const finishActive = this.stats.begin(identity.workspaceId, identity.sessionId, requestBytesEstimate)
    this.incrementActive(identity)
    const callStarted = Date.now()
    try {
      const callOptions: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: resolved.values.advisoryTimeoutMs }
      if (exec.signal !== undefined) callOptions.signal = exec.signal
      const result = await callAdvisoryWithRetry(client, { state, questions }, callOptions, (attempt, error) => {
        this.context.logger?.debug?.(`dsh-jev-integration: retrying Jev advisory (${attempt}/${ADVISORY_RETRIES}) after ${error.kind}`)
      })
      const hazards = ['is_destructive', 'is_exfiltration', 'is_jailbreak']
        .map(key => noulProbability(result.answers[key]))
        .filter((value): value is number => typeof value === 'number')
      const riskScore = result.answers.risk_score?.type === 'score' && !result.answers.risk_score.unknown && typeof result.answers.risk_score.score === 'number'
        ? result.answers.risk_score.score
        : undefined
      const maxHazard = hazards.length > 0 ? Math.max(...hazards) : undefined
      let decision: 'allow' | 'ask' | 'deny' = 'allow'
      if ((maxHazard !== undefined && maxHazard >= resolved.values.blockThreshold) || (riskScore !== undefined && riskScore >= 1.7)) decision = 'deny'
      else if ((maxHazard !== undefined && maxHazard >= resolved.values.askThreshold) || (riskScore !== undefined && riskScore >= 0.7)) decision = 'ask'
      const measurement = { ok: true, latencyMs: Date.now() - callStarted, requestBytes: result.requestBytes, responseBytes: result.responseBytes }
      this.stats.recordCall(identity.workspaceId, identity.sessionId, measurement, decision)
      this.setAvailability(identity, true)
      this.setDecision(identity, decision)
      if (decision === 'deny') {
        return { kind: 'deny', action: 'deny', reason: `[DSH Jev] Execution blocked: hazard probability ${((maxHazard ?? 0) * 100).toFixed(0)}%.` }
      }
      if (decision === 'ask') {
        return {
          kind: 'ask',
          action: 'ask',
          prompt: `[DSH Jev] Approval required: estimated hazard ${(Math.max(maxHazard ?? 0, (riskScore ?? 0) / 2) * 100).toFixed(0)}%.`,
          reason: 'Potentially destructive or sensitive tool action',
        }
      }
      return next()
    } catch (error) {
      const jevError = error instanceof JevClientError ? error : undefined
      const kind = jevError?.kind
      const code: ErrorCode = kind === 'timeout' ? 'DJE-0008' : kind === 'cancelled' ? 'DJE-0009' : 'DJE-0007'
      const message = jevError?.message ?? (error instanceof Error ? error.message : String(error))
      const timedOut = kind === 'timeout'
      const cancelled = kind === 'cancelled'
      this.stats.recordCall(identity.workspaceId, identity.sessionId, {
        ok: false,
        latencyMs: Date.now() - callStarted,
        requestBytes: requestBytesEstimate,
        responseBytes: 0,
        timedOut,
        cancelled,
      }, 'allow')
      // Jev is an optional advisory layer: a timeout, missing key, cancellation,
      // or upstream failure never blocks the normal DSH tool pipeline.
      this.setAvailability(identity, false, message, code)
      this.setDecision(identity, 'allow')
      this.context.logger?.warn?.(`dsh-jev-integration: Jev advisory skipped for ${toolName}: ${message}`)
      return next()
    } finally {
      finishActive()
      this.decrementActive(identity)
    }
  }

  private async postExecute(execValue: unknown, resultValue: unknown, next: PostToolNext): Promise<PostToolDecisionLike> {
    const baseDecision = await next()
    const exec = isRecord(execValue) ? execValue as ToolExecutionLike : {}
    const result = isRecord(resultValue) ? resultValue as ToolResultLike : { content: resultValue }
    const session = exec.agent && isRecord(exec.agent) ? exec.agent.session : undefined
    const identity = await this.resolveWorkspace(session)
    if (!identity) return baseDecision
    const resolved = this.configState.resolve(identity.workspaceId, identity.sessionId)
    if (!resolved.values.enabled) return baseDecision
    if (!resolved.values.loopGuard.enabled && !resolved.values.resultShaper.enabled) return baseDecision
    const client = new JevClient(resolved.values, this.options.apiKey, this.options.fetch)
    if (!(await client.hasApiKey())) return baseDecision

    let decision = baseDecision
    if (resolved.values.loopGuard.enabled) {
      const loopOutcome = await this.loopGuard.inspect(
        exec,
        result,
        resolved.values.loopGuard,
        (request, options) => this.invokePolicy(identity, client, request, options.timeoutMs, options.signal),
      )
      if (loopOutcome.action === 'warning' || loopOutcome.action === 'interrupt') {
        this.stats.recordLoopGuard(identity.workspaceId, identity.sessionId, loopOutcome.action)
        if (loopOutcome.context !== undefined && decision.kind !== 'block') {
          decision = this.appendAdditionalContext(decision, loopOutcome.context)
        }
      } else if (loopOutcome.action === 'uncertain') {
        this.stats.recordLoopGuard(identity.workspaceId, identity.sessionId, 'uncertain')
      }
    }

    if (
      resolved.values.resultShaper.enabled
      && result.isError !== true
      && decision.kind !== 'block'
      && !Object.hasOwn(decision, 'content')
      && !Object.hasOwn(decision, 'value')
    ) {
      const originalText = extractShaperText(result.content)
      if (originalText !== undefined && this.resultShaper.shouldConsider(exec, originalText, resolved.values.resultShaper)) {
        const shaped = await this.resultShaper.shape(
          originalText,
          exec.name ?? '',
          exec,
          resolved.values.resultShaper,
          (request, options) => this.invokePolicy(identity, client, request, options.timeoutMs, options.signal),
        )
        if (shaped !== undefined) {
          this.stats.recordResultShape(identity.workspaceId, identity.sessionId, originalText.length - shaped.text.length)
          decision = {
            ...decision,
            kind: 'accept',
            action: 'accept',
            content: replaceText(result.content, shaped.text),
          } as PostToolDecisionLike
        }
      }
    }
    return decision
  }

  private appendAdditionalContext(decision: PostToolDecisionLike, context: unknown): PostToolDecisionLike {
    const existing = Array.isArray(decision.additionalContexts) ? decision.additionalContexts : []
    return { ...decision, additionalContexts: [...existing, context] } as PostToolDecisionLike
  }

  private resetPolicyForNewUserMessage(payloadValue: unknown): void {
    if (!isRecord(payloadValue)) return
    const messages = Array.isArray(payloadValue.messages) ? payloadValue.messages : []
    if (!messages.some(message => isRecord(message) && isUserSource(message.source))) return
    const agent = payloadValue.agent
    this.loopGuard.reset(agent)
    this.resultShaper.reset(agent)
    this.doneGate.reset(agent)
  }

  private sessionQueueKey(sessionValue: unknown): string | undefined {
    const session = extractSession(sessionValue)
    return session.id
  }

  private clearSessionTrace(sessionId: string): void {
    for (const traceKey of this.sessionTraces.keys()) {
      try {
        const parsed = JSON.parse(traceKey) as unknown
        if (Array.isArray(parsed) && parsed[1] === sessionId) this.sessionTraces.delete(traceKey)
      } catch {
        // The key is internal JSON; an invalid key cannot match a live trace.
      }
    }
  }

  private async disposeSessionState(sessionValue: unknown): Promise<void> {
    const sessionId = this.sessionQueueKey(sessionValue)
    if (sessionId === undefined) return
    const knownSession = this.sessionObjects.get(sessionId)
    if (knownSession !== undefined && knownSession !== sessionValue) return
    this.sessionObjects.set(sessionId, sessionValue)
    // Mark first: an event already waiting on workspace resolution must not
    // recreate a trace after disposal has started.
    this.disposedSessions.add(sessionId)
    const pending = this.sessionEventQueues.get(sessionId)
    await pending?.catch(() => undefined)
    // A new Session object may have been opened with the same id while the
    // old queue was draining. The old disposal must not clear the new state.
    if (this.sessionObjects.get(sessionId) !== sessionValue) return
    if (this.sessionEventQueues.get(sessionId) === pending) this.sessionEventQueues.delete(sessionId)
    this.clearSessionTrace(sessionId)
    const identity = this.sessionScopes.get(sessionId) ?? await this.resolveWorkspace(sessionValue)
    if (identity?.sessionId !== undefined) this.configState.clearSession(identity.workspaceId, identity.sessionId)
    this.sessionScopes.delete(sessionId)
  }

  private enqueueSessionEvent(sessionValue: unknown, eventValue: unknown): Promise<void> {
    const key = this.sessionQueueKey(sessionValue)
    if (key !== undefined) {
      const knownSession = this.sessionObjects.get(key)
      if (knownSession !== undefined && knownSession !== sessionValue) this.disposedSessions.delete(key)
      this.sessionObjects.set(key, sessionValue)
      if (this.disposedSessions.has(key)) return Promise.resolve()
    }
    if (key === undefined) return this.onSessionEvent(sessionValue, eventValue)
    const previous = this.sessionEventQueues.get(key) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(() => this.onSessionEvent(sessionValue, eventValue))
      .catch(error => {
        this.context.logger?.warn?.(`dsh-jev-integration: session event processing failed: ${String(error)}`)
      })
    this.sessionEventQueues.set(key, current)
    void current.finally(() => {
      if (this.sessionEventQueues.get(key) === current) this.sessionEventQueues.delete(key)
    }).catch(() => undefined)
    return current
  }

  private async waitForSessionEvents(sessionValue: unknown): Promise<void> {
    const key = this.sessionQueueKey(sessionValue)
    if (key === undefined) return
    await this.sessionEventQueues.get(key)
  }

  private async onSessionEvent(sessionValue: unknown, eventValue: unknown): Promise<void> {
    if (!this.mounted) return
    const sessionId = this.sessionQueueKey(sessionValue)
    if (sessionId !== undefined && this.disposedSessions.has(sessionId)) return
    const event = extractTurnEvent(eventValue)
    const identity = await this.resolveWorkspace(sessionValue)
    if (!identity?.sessionId) return
    if (!this.mounted || this.disposedSessions.has(identity.sessionId) || this.sessionObjects.get(identity.sessionId) !== sessionValue) return
    this.sessionScopes.set(identity.sessionId, identity)
    const key = scopeKey(identity)
    const data = extractEventData(eventValue)
    if (event.type === 'turn/start') {
      const turn = data && typeof data.turn === 'number' ? data.turn : 0
      this.sessionTraces.set(key, { turn, claim: '', evidence: [] })
      if (this.configState.consumeNextTurn(identity.workspaceId, identity.sessionId)) {
        void this.publishState(identity)
      }
      return
    }
    const trace = this.sessionTraces.get(key)
    if (!trace || !data) return
    if (event.type === 'user/message') {
      const source = isRecord(data.source) ? data.source : undefined
      if (isUserSource(source)) {
        const text = extractTextFromMessage(data)
        if (text) trace.userPrompt = text
      }
    } else if (event.type === 'assistant/message') {
      const message = isRecord(data.message) ? data.message : data
      const text = extractTextFromMessage(message)
      if (text) trace.claim = text
    } else if (event.type === 'tool/result') {
      const message = isRecord(data.message) ? data.message : data
      const content = extractTextFromMessage(message)
      const blocks = isRecord(message) && Array.isArray(message.content) ? message.content : []
      const isError = blocks.some(block => isRecord(block) && block.type === 'tool-result' && block.isError === true)
      if (content) trace.evidence.push({ text: content, isError })
    }
  }

  private async onTurnStopping(payloadValue: unknown): Promise<void> {
    if (!this.mounted) return
    await this.ready
    if (!isRecord(payloadValue)) return
    const payload = payloadValue as AgentTurnStoppingPayload
    const agent = payload.agent
    if (!isCompletionAgent(agent)) return
    const session = isRecord(agent) ? agent.session : undefined
    const sessionId = this.sessionQueueKey(session)
    const knownSession = sessionId === undefined ? undefined : this.sessionObjects.get(sessionId)
    if (sessionId !== undefined && knownSession !== undefined && knownSession !== session) return
    if (sessionId !== undefined && this.disposedSessions.has(sessionId)) return
    await this.waitForSessionEvents(session)
    if (sessionId !== undefined && this.disposedSessions.has(sessionId)) return
    const identity = await this.resolveWorkspace(session)
    if (!identity?.sessionId) return
    const resolved = this.configState.resolve(identity.workspaceId, identity.sessionId)
    if (!resolved.values.enabled || !resolved.values.doneGate.enabled) return
    const trace = this.sessionTraces.get(scopeKey(identity))
    if (!trace) return
    const client = new JevClient(resolved.values, this.options.apiKey, this.options.fetch)
    if (!(await client.hasApiKey())) return
    const outcome = await this.doneGate.inspect(
      agent,
      trace,
      resolved.values.doneGate,
      (request, options) => this.invokePolicy(identity, client, request, options.timeoutMs, options.signal),
      payload.signal,
    )
    if (outcome.action === 'intervene' && outcome.context !== undefined) {
      this.stats.recordDoneGate(identity.workspaceId, identity.sessionId, 'intervention')
      const steer = (agent as { steer?: (message: unknown) => void }).steer
      if (typeof steer === 'function') {
        try {
          steer(outcome.context)
        } catch (error) {
          this.context.logger?.warn?.(`dsh-jev-integration: done/evidence steering failed: ${String(error)}`)
        }
      }
    } else if (outcome.action === 'uncertain') {
      this.stats.recordDoneGate(identity.workspaceId, identity.sessionId, 'uncertain')
    } else if (outcome.action === 'pass') {
      this.stats.recordDoneGate(identity.workspaceId, identity.sessionId, 'pass')
    }
  }

  private emit(type: StateEventType, identity: ScopeIdentity, state?: RuntimeState, stats?: StatisticsSnapshot): void {
    const event: StateEvent = {
      id: `${Date.now()}-${++this.eventSequence}`,
      type,
      at: new Date().toISOString(),
      workspaceId: identity.workspaceId,
    }
    if (identity.sessionId !== undefined) event.sessionId = identity.sessionId
    if (state !== undefined) event.state = state
    if (stats !== undefined) event.stats = stats
    for (const subscriber of [...this.subscribers]) {
      if (!eventMatches(subscriber, event)) continue
      try {
        subscriber.callback(event)
      } catch {
        this.subscribers.delete(subscriber)
      }
    }
  }

  private async publishState(identity: ScopeIdentity): Promise<void> {
    if (!this.mounted) return
    try {
      this.emit('state.changed', identity, await this.getState(identity))
    } catch (error) {
      this.context.logger?.warn?.(`dsh-jev-integration: state publication failed: ${String(error)}`)
    }
  }

  private emitStatsChanged(snapshot: StatisticsSnapshot): void {
    const identity: ScopeIdentity = { workspaceId: snapshot.workspaceId }
    if (snapshot.sessionId !== undefined) identity.sessionId = snapshot.sessionId
    this.emit('stats.changed', identity, undefined, snapshot)
  }

  public subscribe(identity: ScopeIdentity, callback: (event: StateEvent) => void): () => void {
    const subscriber: Subscriber = { workspaceId: identity.workspaceId, callback }
    if (identity.sessionId !== undefined) subscriber.sessionId = identity.sessionId
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  public async capabilities(workspaceId?: string, sessionId?: string): Promise<CapabilitiesResponse> {
    await this.ready
    if (this.mounted && !this.extensionsReady) this.installRuntimeExtensions()
    const resolved = this.configState.resolve(workspaceId ?? '__capabilities__', sessionId)
    const client = new JevClient(resolved.values, this.options.apiKey, this.options.fetch)
    const stored = workspaceId === undefined ? undefined : this.availability.get(scopeKey({ workspaceId, ...(sessionId !== undefined ? { sessionId } : {}) }))
    const available = stored?.available ?? await client.hasApiKey()
    const result: CapabilitiesResponse = {
      integrationVersion: VERSION.integration,
      integrationCommit: this.options.integrationCommit ?? VERSION.commit,
      protocolVersion: PROTOCOL_VERSION,
      runtimeCompatibility: {
        minimumDshRuntime: MIN_DSH_RUNTIME_VERSION,
        testedDshRuntime: this.options.dshRuntimeVersion ?? MIN_DSH_RUNTIME_VERSION,
        requiredFeatures: [
          'connection.fetch',
          'tools/pre-execute',
          'tools/post-execute',
          'agent/pre-step',
          'agent/turn-stopping',
          'session/event',
          'system-prompt/assemble',
          'tools.register',
          'tools.guard',
        ],
      },
      pluginMounted: this.mounted,
      endpointAvailable: this.endpointAvailable,
      capabilities: {
        configRead: true,
        configWrite: true,
        stateRead: true,
        statsRead: true,
        statsReset: true,
        stateEvents: true,
        preExecuteHook: this.mounted,
        postExecuteHook: this.mounted,
        loopGuard: this.mounted,
        resultShaper: this.mounted,
        doneEvidenceGate: this.mounted,
        turnStoppingHook: this.mounted,
        nextTurnOverride: this.mounted,
        toolPruner: this.mounted && this.toolPrunerService !== undefined,
        skillRouter: this.mounted && Boolean(this.getSkillsService()),
        decisionTools: this.mounted && Boolean(this.getToolsService()?.register),
        deterministicSafetyGuard: this.mounted && Boolean(this.getToolsService()?.guard),
      },
      jev: { baseUrl: resolved.values.baseUrl, model: resolved.values.model, available },
    }
    if (!this.endpointAvailable) result.endpointReason = this.endpointReason
    if (stored?.reason !== undefined) result.jev.reason = stored.reason
    else if (!available) result.jev.reason = 'missing-api-key'
    return result
  }

  private async routeCapabilities(request: Request): Promise<Response> {
    try {
      const url = parseUrl(request)
      return success(await this.capabilities(optionalQuery(url, 'workspaceId'), optionalQuery(url, 'sessionId')))
    } catch (error) {
      return errorResponse('DJE-0005', String(error), 503, undefined, true)
    }
  }

  private async routeConfig(request: Request): Promise<Response> {
    try {
      const url = parseUrl(request)
      if (request.method === 'GET') {
        const workspaceValue = requiredQuery(url, 'workspaceId')
        if (workspaceValue instanceof Response) return workspaceValue
        const sessionId = optionalQuery(url, 'sessionId')
        const resolved = this.configState.resolve(workspaceValue, sessionId)
        const source = resolved.source
        const response: ConfigResponse = {
          workspaceId: workspaceValue,
          persisted: source === 'global' || source === 'workspace',
          scope: responseScopeForSource(source),
          source,
          values: resolved.values,
        }
        if (sessionId !== undefined) response.sessionId = sessionId
        return success(response)
      }
      const body = await parseBody(request)
      if (!isRecord(body)) return errorResponse('DJE-0001', 'request body must be an object', 400)
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : ''
      if (!workspaceId) return errorResponse('DJE-0002', 'workspaceId is required', 400)
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined
      const scope = body.scope
      if (scope !== 'global' && scope !== 'workspace' && scope !== 'session' && scope !== 'next-turn') {
        return errorResponse('DJE-0004', 'scope must be global, workspace, session, or next-turn', 400)
      }
      if ((scope === 'session' || scope === 'next-turn') && !sessionId) return errorResponse('DJE-0003', 'sessionId is required for session and next-turn scopes', 400)
      const validated = validateConfigPatch(body.patch)
      if (!validated.patch) return errorResponse('DJE-0001', validated.error ?? 'invalid config patch', 400)
      if (scope === 'global' || scope === 'workspace') {
        await this.configState.setPersisted(scope, workspaceId, validated.patch)
      } else {
        this.configState.setEphemeral(scope, workspaceId, sessionId as string, validated.patch)
      }
      const resolved = this.configState.resolve(workspaceId, sessionId)
      const response: ConfigResponse = {
        workspaceId,
        persisted: scope === 'global' || scope === 'workspace',
        scope,
        source: resolved.source,
        values: resolved.values,
      }
      if (sessionId !== undefined) response.sessionId = sessionId
      const identity: ScopeIdentity = { workspaceId }
      if (sessionId !== undefined) identity.sessionId = sessionId
      this.emit('config.changed', identity, await this.getState(identity))
      void this.refreshDecisionToolsRegistration(workspaceId, sessionId)
      return success(response)
    } catch (error) {
      this.context.logger?.warn?.(`dsh-jev-integration: config request failed: ${String(error)}`)
      if (error instanceof Error && error.message.includes('request body is not valid JSON')) {
        return errorResponse('DJE-0001', error.message, 400)
      }
      return errorResponse('DJE-0010', 'configuration could not be persisted', 500, undefined, true)
    }
  }

  private async routeState(request: Request): Promise<Response> {
    const url = parseUrl(request)
    const workspaceValue = requiredQuery(url, 'workspaceId')
    if (workspaceValue instanceof Response) return workspaceValue
    try {
      const identity: ScopeIdentity = { workspaceId: workspaceValue }
      const sessionId = optionalQuery(url, 'sessionId')
      if (sessionId !== undefined) identity.sessionId = sessionId
      return success(await this.getState(identity))
    } catch (error) {
      return errorResponse('DJE-0005', String(error), 503, undefined, true)
    }
  }

  private async routeStats(request: Request): Promise<Response> {
    const url = parseUrl(request)
    const workspaceValue = requiredQuery(url, 'workspaceId')
    if (workspaceValue instanceof Response) return workspaceValue
    const sessionId = optionalQuery(url, 'sessionId')
    await this.stats.ready
    const snapshot = this.stats.get(workspaceValue, sessionId)
    return success(snapshot)
  }

  private async routeStatsReset(request: Request): Promise<Response> {
    try {
      const url = parseUrl(request)
      const body = await parseBody(request)
      const workspaceId = isRecord(body) && typeof body.workspaceId === 'string' ? body.workspaceId.trim() : optionalQuery(url, 'workspaceId')
      if (!workspaceId) return errorResponse('DJE-0002', 'workspaceId is required', 400)
      const sessionId = isRecord(body) && typeof body.sessionId === 'string' ? body.sessionId.trim() : optionalQuery(url, 'sessionId')
      return success(await this.stats.reset(workspaceId, sessionId))
    } catch (error) {
      return errorResponse('DJE-0011', 'statistics could not be reset or persisted', 500, { reason: String(error) }, true)
    }
  }

  private async routeEvents(request: Request): Promise<Response> {
    const url = parseUrl(request)
    const workspaceValue = requiredQuery(url, 'workspaceId')
    if (workspaceValue instanceof Response) return workspaceValue
    const sessionId = optionalQuery(url, 'sessionId')
    const identity: ScopeIdentity = { workspaceId: workspaceValue }
    if (sessionId !== undefined) identity.sessionId = sessionId
    const encoder = new TextEncoder()
    let closed = false
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
    let unsubscribe: () => void = () => undefined
    const close = () => {
      if (closed) return
      closed = true
      unsubscribe()
      try {
        controllerRef?.close()
      } catch {
        // A client can race cancellation with close; it is already detached.
      }
    }
    const stream = new ReadableStream<Uint8Array>({
      start: controller => {
        controllerRef = controller
        unsubscribe = this.subscribe(identity, event => {
          if (!closed) controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`))
        })
        request.signal.addEventListener('abort', close, { once: true })
        void this.getState(identity).then(state => {
          if (!closed) {
            const initial: StateEvent = {
              id: `${Date.now()}-${++this.eventSequence}`,
              type: 'state.changed',
              at: new Date().toISOString(),
              workspaceId: identity.workspaceId,
              state,
            }
            if (identity.sessionId !== undefined) initial.sessionId = identity.sessionId
            controller.enqueue(encoder.encode(`id: ${initial.id}\ndata: ${JSON.stringify(initial)}\n\n`))
          }
        }).catch(error => controller.error(error))
      },
      cancel: close,
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }
}

export function apply(context: CordisContextLike, options: RuntimePluginOptions = {}): () => void {
  const existing = context.get?.('jevIntegration')
  if (existing instanceof JevIntegration) return () => undefined
  const integration = new JevIntegration(context, options).mount()
  return () => {
    void integration.dispose()
  }
}

export function createIntegration(context: CordisContextLike, options: RuntimePluginOptions = {}): JevIntegration {
  return new JevIntegration(context, options)
}
