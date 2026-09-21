/**
 * Language-neutral protocol model for the DSH/Jev Runtime integration.
 *
 * The JSON Schema in ../schema is the normative wire contract. These TypeScript
 * declarations deliberately contain no Runtime or IDE dependencies so they can
 * be copied/generated into either host.
 */
export const INTEGRATION_VERSION = '0.1.0';
export const PROTOCOL_VERSION = '1.0';
export const MIN_DSH_RUNTIME_VERSION = '0.1.5-rc.1';
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_JEV_MODEL = 'jev-latest';
export const DEFAULT_GUARDED_TOOLS = [
    'bash',
    'pwsh',
    'terminal',
    'run_command',
    'execute_command',
    'run_code',
    'write_to_file',
    'replace_file_content',
];
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
];
export const ERROR_CODE_NAMES = {
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
};
export const DEFAULT_CONFIG = {
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
};
export function isErrorCode(value) {
    return typeof value === 'string' && ERROR_CODES.includes(value);
}
export function makeProtocolError(code, message, details, retryable = false) {
    const error = {
        code,
        name: ERROR_CODE_NAMES[code],
        message,
        retryable,
    };
    if (details !== undefined)
        error.details = details;
    return error;
}
//# sourceMappingURL=index.js.map