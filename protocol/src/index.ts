/**
 * Language-neutral protocol model for the DSH/Jev Runtime integration.
 *
 * The JSON Schema in ../schema is the normative wire contract. These TypeScript
 * declarations deliberately contain no Runtime or IDE dependencies so they can
 * be copied/generated into either host.
 */

export const INTEGRATION_VERSION = '0.1.0' as const
export const PROTOCOL_VERSION = '1.0' as const
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
}

export type IntegrationConfigPatch = Partial<IntegrationConfig>

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
    nextTurnOverride: boolean
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
