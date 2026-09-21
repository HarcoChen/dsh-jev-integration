import type { IntegrationConfig, ProtocolError, RuntimeState } from '../../protocol/src/index.js';
export interface DshSessionHeader {
    cwd?: string;
}
export interface DshSessionLike {
    id?: string;
    header?: DshSessionHeader;
}
export interface ToolExecutionLike {
    name?: string;
    arguments?: unknown;
    args?: unknown;
    signal?: AbortSignal;
    agent?: {
        session?: DshSessionLike;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
export type PreToolDecisionLike = {
    kind: 'allow';
    action?: 'allow';
} | {
    kind: 'deny';
    action?: 'deny';
    reason: string;
} | {
    kind: 'ask';
    action?: 'ask';
    prompt?: string;
    reason?: string;
    details?: Record<string, unknown>;
} | {
    kind: 'cancel';
    action?: 'cancel';
};
export type PreToolNext = () => Promise<PreToolDecisionLike> | PreToolDecisionLike;
export interface WorkspaceLike {
    id: string;
}
export interface WorkspaceRegistryLike {
    resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
}
export interface FetchRoute {
    path: string;
    methods: readonly ('GET' | 'HEAD' | 'POST')[];
    requestBody: 'buffered' | 'streaming';
    fetch(request: Request): Promise<Response>;
}
export interface ConnectionLike {
    fetch: {
        register(route: FetchRoute): Promise<() => Promise<void>> | (() => Promise<void>);
    };
}
export interface LoggerLike {
    debug?(message: string, ...args: unknown[]): void;
    info?(message: string, ...args: unknown[]): void;
    warn?(message: string, ...args: unknown[]): void;
    error?(message: string, ...args: unknown[]): void;
}
export interface CordisContextLike {
    get?(name: string): unknown;
    provide?(name: string, value: unknown): unknown;
    effect?(effect: () => void | (() => void | Promise<void>), label?: string): unknown;
    inject?(services: readonly string[], callback: (ctx: CordisContextLike) => void): unknown;
    on?(event: string, callback: (...args: unknown[]) => unknown): (() => void) | void;
    connection?: ConnectionLike;
    workspaceRegistry?: WorkspaceRegistryLike;
    logger?: LoggerLike;
    [key: string]: unknown;
}
export interface RuntimePluginOptions {
    enabled?: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    advisoryTimeoutMs?: number;
    askThreshold?: number;
    blockThreshold?: number;
    guardedTools?: string[];
    persistenceRootDir?: string;
    integrationCommit?: string;
    dshRuntimeVersion?: string;
    fetch?: typeof globalThis.fetch;
}
export interface IntegrationStatus {
    state: RuntimeState;
    config: IntegrationConfig;
}
export interface RouteErrorResponse {
    ok: false;
    error: ProtocolError;
}
//# sourceMappingURL=types.d.ts.map