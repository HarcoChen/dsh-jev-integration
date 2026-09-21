import type { StatisticsSnapshot } from '../../protocol/src/index.js';
import type { IntegrationPersistence } from './persistence.js';
export interface CallResultMeasurement {
    ok: boolean;
    latencyMs: number;
    requestBytes: number;
    responseBytes: number;
    timedOut?: boolean;
    cancelled?: boolean;
}
export declare class StatisticsStore {
    private readonly persistence;
    private readonly scopes;
    private persistQueue;
    private onChanged?;
    private onPersistenceError?;
    readonly ready: Promise<void>;
    constructor(persistence: IntegrationPersistence);
    setOnChanged(callback: (snapshot: StatisticsSnapshot) => void): void;
    setOnPersistenceError(callback: (error: unknown) => void): void;
    private load;
    private getOrCreate;
    private persist;
    private changed;
    get(workspaceId: string, sessionId?: string): StatisticsSnapshot;
    begin(workspaceId: string, sessionId: string | undefined, requestBytes: number): () => void;
    recordCall(workspaceId: string, sessionId: string | undefined, measurement: CallResultMeasurement, decision?: 'allow' | 'ask' | 'deny'): void;
    recordSkipped(workspaceId: string, sessionId?: string): void;
    reset(workspaceId: string, sessionId?: string): Promise<StatisticsSnapshot>;
    flush(): Promise<void>;
}
//# sourceMappingURL=stats.d.ts.map