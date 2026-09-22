/**
 * Language-neutral protocol model for the DSH/Jev Runtime integration.
 *
 * The JSON Schema in ../schema is the normative wire contract. These TypeScript
 * declarations deliberately contain no Runtime or IDE dependencies so they can
 * be copied/generated into either host.
 */

export const INTEGRATION_VERSION = '0.1.0' as const
export const PROTOCOL_VERSION = '1.1' as const
export const MIN_DSH_RUNTIME_VERSION = '0.1.5-rc.1' as const
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1/systemone' as const
export const DEFAULT_JEV_MODEL = 'jev-latest' as const

export const DEFAULT_GUARDED_TOOLS = [
  'bash',
  'pwsh',
  'terminal',
  'run_command',
  'execute_command',
  'run_code',
  'write_to_file',
  'replace_file_content',
] as const

export interface LoopGuardConfig {
  enabled: boolean
  triggerThreshold: number
  noProgressThreshold: number
  pLoopThreshold: number
  minConfidence: number
  cooldownSteps: number
  maxHistory: number
  deferExactRepeats: boolean
  requestTimeoutMs: number
  include: string[]
  exclude: string[]
}

export interface ResultShaperConfig {
  enabled: boolean
  shapeTools: string[]
  thresholdChars: number
  maxPerTurn: number
  keepKinds: string[]
  minKindConfidence: number
  maxClusters: number
  sampleChars: number
  requestTimeoutMs: number
}

export interface DoneGateConfig {
  enabled: boolean
  blockThreshold: number
  minEvidenceItems: number
  requestTimeoutMs: number
  maxClaimChars: number
  cooldownTurns: number
}

export interface ToolPrunerConfig {
  enabled: boolean
  maxTools: number
  minScoreThreshold: number
  minConfidence: number
  minIntentChars: number
  minKeep: number
  maxCandidates: number
  requestTimeoutMs: number
  alwaysRetain: string[]
}

export interface SkillRouterConfig {
  enabled: boolean
  minCandidates: number
  minIntentChars: number
  maxSkills: number
  maxCandidates: number
  minScore: number
  minConfidence: number
  nameMatchBoost: number
  maxAdviceChars: number
  requestTimeoutMs: number
}

export interface DecisionToolsConfig {
  enabled: boolean
  requestTimeoutMs: number
  maxStateChars: number
  maxQuestionChars: number
  maxQuestions: number
  maxCandidates: number
  maxCandidateChars: number
  maxResultChars: number
}

export interface DeterministicSafetyGuardConfig {
  enabled: boolean
  maxArgumentChars: number
}

export const DEFAULT_LOOP_GUARD: LoopGuardConfig = {
  // Semantic post-execute calls are opt-in because tool output and trajectory
  // samples leave the Runtime for the configured Jev endpoint.
  enabled: false,
  triggerThreshold: 2,
  noProgressThreshold: 0.3,
  pLoopThreshold: 0.6,
  minConfidence: 0.5,
  cooldownSteps: 3,
  maxHistory: 8,
  deferExactRepeats: true,
  requestTimeoutMs: 3_500,
  include: [],
  exclude: [],
}

export const DEFAULT_RESULT_SHAPER: ResultShaperConfig = {
  // Result shaping changes model-visible content and is deliberately opt-in.
  enabled: false,
  shapeTools: ['bash', 'pwsh', 'terminal', 'run_command', 'execute_command'],
  thresholdChars: 8_000,
  maxPerTurn: 2,
  keepKinds: ['warning', 'failure'],
  minKindConfidence: 0.6,
  maxClusters: 24,
  sampleChars: 400,
  requestTimeoutMs: 4_000,
}

export const DEFAULT_DONE_GATE: DoneGateConfig = {
  // Completion/evidence checking is experimental and must be explicitly enabled
  // by the host after explaining that the latest assistant claim is sent to Jev.
  enabled: false,
  blockThreshold: 0.75,
  minEvidenceItems: 1,
  requestTimeoutMs: 3_500,
  maxClaimChars: 4_000,
  cooldownTurns: 1,
}

export const DEFAULT_TOOL_PRUNER: ToolPrunerConfig = {
  // Tool schemas are sent to Jev only when a host explicitly enables this
  // model-visible optimization and the integration itself is enabled.
  enabled: false,
  maxTools: 8,
  minScoreThreshold: 2,
  minConfidence: 0.5,
  minIntentChars: 8,
  minKeep: 3,
  maxCandidates: 50,
  requestTimeoutMs: 4_000,
  alwaysRetain: [
    'run_code', 'skill', 'jev_ask', 'jev_rank', 'jev_check',
    'read_file', 'write_to_file', 'write_file', 'edit_file',
    'str_replace_editor', 'bash', 'terminal', 'pwsh', 'run_command',
    'execute_command', 'grep', 'glob', 'find_by_name', 'view_file',
    'replace_file_content',
  ],
}

export const DEFAULT_SKILL_ROUTER: SkillRouterConfig = {
  // Routing advice is model-visible and therefore remains opt-in.
  enabled: false,
  minCandidates: 8,
  minIntentChars: 12,
  maxSkills: 2,
  maxCandidates: 32,
  minScore: 1.5,
  minConfidence: 0.5,
  nameMatchBoost: 0.6,
  maxAdviceChars: 1_200,
  requestTimeoutMs: 4_000,
}

export const DEFAULT_DECISION_TOOLS: DecisionToolsConfig = {
  // These tools send model-provided state to Jev and are never model-visible
  // until explicitly enabled by the host.
  enabled: false,
  requestTimeoutMs: 3_500,
  maxStateChars: 12_000,
  maxQuestionChars: 1_500,
  maxQuestions: 16,
  maxCandidates: 50,
  maxCandidateChars: 600,
  maxResultChars: 4_000,
}

export const DEFAULT_DETERMINISTIC_SAFETY_GUARD: DeterministicSafetyGuardConfig = {
  // This guard is local, synchronous, and does not send content to Jev. Keep
  // the baseline protection active whenever DSH exposes tools.guard().
  enabled: true,
  maxArgumentChars: 32_000,
}

export const ERROR_CODES = [
  'DJE-0001',
  'DJE-0002',
  'DJE-0003',
  'DJE-0004',
  'DJE-0005',
  'DJE-0006',
  'DJE-0007',
  'DJE-0008',
  'DJE-0009',
  'DJE-0010',
  'DJE-0011',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export const ERROR_CODE_NAMES: Record<ErrorCode, string> = {
  'DJE-0001': 'INVALID_REQUEST',
  'DJE-0002': 'WORKSPACE_REQUIRED',
  'DJE-0003': 'SESSION_REQUIRED',
  'DJE-0004': 'UNSUPPORTED_SCOPE',
  'DJE-0005': 'INTEGRATION_UNAVAILABLE',
  'DJE-0006': 'RUNTIME_INCOMPATIBLE',
  'DJE-0007': 'JEV_UNAVAILABLE',
  'DJE-0008': 'JEV_TIMEOUT',
  'DJE-0009': 'JEV_CANCELLED',
  'DJE-0010': 'CONFIG_PERSISTENCE_FAILED',
  'DJE-0011': 'STATS_PERSISTENCE_FAILED',
}

export type ConfigScope = 'global' | 'workspace' | 'session' | 'next-turn'
// `startup` is a read-only Runtime composition source. It is never accepted as
// a POST scope and is not written to the integration persistence file.
export type ConfigSource = 'default' | 'startup' | 'global' | 'workspace' | 'session' | 'next-turn'
export type StateEventType = 'state.changed' | 'config.changed' | 'stats.changed'
export type JevDecision = 'allow' | 'ask' | 'deny' | 'skipped'

export interface IntegrationConfig {
  enabled: boolean
  baseUrl: string
  model: string
  timeoutMs: number
  advisoryTimeoutMs: number
  askThreshold: number
  blockThreshold: number
  guardedTools: string[]
  loopGuard: LoopGuardConfig
  resultShaper: ResultShaperConfig
  doneGate: DoneGateConfig
  toolPruner: ToolPrunerConfig
  skillRouter: SkillRouterConfig
  decisionTools: DecisionToolsConfig
  deterministicSafetyGuard: DeterministicSafetyGuardConfig
}

export type IntegrationConfigPatch = Partial<Omit<IntegrationConfig, 'loopGuard' | 'resultShaper' | 'doneGate' | 'toolPruner' | 'skillRouter' | 'decisionTools' | 'deterministicSafetyGuard'>> & {
  loopGuard?: Partial<LoopGuardConfig>
  resultShaper?: Partial<ResultShaperConfig>
  doneGate?: Partial<DoneGateConfig>
  toolPruner?: Partial<ToolPrunerConfig>
  skillRouter?: Partial<SkillRouterConfig>
  decisionTools?: Partial<DecisionToolsConfig>
  deterministicSafetyGuard?: Partial<DeterministicSafetyGuardConfig>
}

export const DEFAULT_CONFIG: IntegrationConfig = {
  // Jev is an optional, privacy-sensitive advisory layer. Hosts must explicitly
  // enable it from their settings or a scoped Runtime override.
  enabled: false,
  baseUrl: DEFAULT_JEV_BASE_URL,
  model: DEFAULT_JEV_MODEL,
  timeoutMs: 2_000,
  // Match dsh-jev's semantic safety inspection budget. The Runtime also makes
  // one bounded retry for transient timeout/network/429/5xx failures.
  advisoryTimeoutMs: 3_500,
  askThreshold: 0.5,
  blockThreshold: 0.85,
  guardedTools: [...DEFAULT_GUARDED_TOOLS],
  loopGuard: { ...DEFAULT_LOOP_GUARD, include: [], exclude: [] },
  resultShaper: { ...DEFAULT_RESULT_SHAPER, shapeTools: [...DEFAULT_RESULT_SHAPER.shapeTools], keepKinds: [...DEFAULT_RESULT_SHAPER.keepKinds] },
  doneGate: { ...DEFAULT_DONE_GATE },
  toolPruner: { ...DEFAULT_TOOL_PRUNER, alwaysRetain: [...DEFAULT_TOOL_PRUNER.alwaysRetain] },
  skillRouter: { ...DEFAULT_SKILL_ROUTER },
  decisionTools: { ...DEFAULT_DECISION_TOOLS },
  deterministicSafetyGuard: { ...DEFAULT_DETERMINISTIC_SAFETY_GUARD },
}

export interface EffectiveConfig {
  enabled: boolean
  active: boolean
  values: IntegrationConfig
  source: ConfigSource
}

export interface UserRequestedConfig {
  enabled: boolean
  source: ConfigSource
}

export interface RuntimeState {
  workspaceId: string
  sessionId?: string
  userRequested: UserRequestedConfig
  effective: EffectiveConfig
  available: boolean
  availabilityReason?: string
  executing: boolean
  activeRequests: number
  lastDecision?: JevDecision
  lastErrorCode?: ErrorCode
  lastErrorMessage?: string
  updatedAt: string
}

export interface StatisticsSnapshot {
  workspaceId: string
  sessionId?: string
  since: string
  resetAt: string
  totalCalls: number
  successfulCalls: number
  failedCalls: number
  timeoutCalls: number
  cancelledCalls: number
  skippedCalls: number
  allowDecisions: number
  askDecisions: number
  denyDecisions: number
  totalLatencyMs: number
  maxLatencyMs: number
  totalRequestBytes: number
  totalResponseBytes: number
  activeCalls: number
  loopGuardChecks: number
  loopGuardWarnings: number
  loopGuardInterruptions: number
  loopGuardUncertain: number
  doneGateChecks: number
  doneGateInterventions: number
  doneGateUncertain: number
  resultShaperCalls: number
  resultShaperCharsRemoved: number
  toolPrunerCalls: number
  toolPrunerSkipped: number
  toolPrunerLowConfidence: number
  toolPrunerFailOpen: number
  toolPrunerToolsSeen: number
  toolPrunerToolsKept: number
  toolPrunerRemovedChars: number
  toolPrunerLatencyMs: number
  skillRouterCalls: number
  skillRouterSkipped: number
  skillRouterLowConfidence: number
  skillRouterFailOpen: number
  skillRouterAdviceCount: number
  skillRouterAdviceChars: number
  skillRouterLatencyMs: number
  decisionToolCalls: number
  decisionToolUnknown: number
  decisionToolFailOpen: number
  decisionToolLatencyMs: number
  deterministicGuardChecks: number
  deterministicGuardDenies: number
}

export interface RuntimeCompatibility {
  minimumDshRuntime: string
  testedDshRuntime: string
  requiredFeatures: string[]
}

export interface CapabilitiesResponse {
  integrationVersion: string
  integrationCommit: string
  protocolVersion: string
  runtimeCompatibility: RuntimeCompatibility
  pluginMounted: boolean
  endpointAvailable: boolean
  endpointReason?: string
  capabilities: {
    configRead: boolean
    configWrite: boolean
    stateRead: boolean
    statsRead: boolean
    statsReset: boolean
    stateEvents: boolean
    preExecuteHook: boolean
    postExecuteHook: boolean
    loopGuard: boolean
    resultShaper: boolean
    doneEvidenceGate: boolean
    turnStoppingHook: boolean
    nextTurnOverride: boolean
    toolPruner: boolean
    skillRouter: boolean
    decisionTools: boolean
    deterministicSafetyGuard: boolean
  }
  jev: {
    baseUrl: string
    model: string
    available: boolean
    reason?: string
  }
}

export interface ConfigUpdateRequest {
  workspaceId: string
  sessionId?: string
  scope: ConfigScope
  patch: IntegrationConfigPatch
}

export interface ConfigResponse {
  workspaceId: string
  sessionId?: string
  persisted: boolean
  scope: ConfigScope
  source: ConfigSource
  values: IntegrationConfig
}

export interface StatisticsResetRequest {
  workspaceId: string
  sessionId?: string
}

export interface ProtocolError {
  code: ErrorCode
  name: string
  message: string
  details?: Record<string, unknown>
  retryable: boolean
}

export interface ErrorResponse {
  ok: false
  error: ProtocolError
}

export interface StateEvent {
  id: string
  type: StateEventType
  at: string
  workspaceId: string
  sessionId?: string
  state?: RuntimeState
  stats?: StatisticsSnapshot
}

export interface SuccessResponse<T> {
  ok: true
  data: T
}

export type ProtocolResponse<T> = SuccessResponse<T> | ErrorResponse

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

export function makeProtocolError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  retryable = false
): ProtocolError {
  const error: ProtocolError = {
    code,
    name: ERROR_CODE_NAMES[code],
    message,
    retryable,
  }
  if (details !== undefined) error.details = details
  return error
}
