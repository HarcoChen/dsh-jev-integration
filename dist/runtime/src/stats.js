function scopeKey(workspaceId, sessionId) {
    return JSON.stringify([workspaceId, sessionId ?? null]);
}
function createSnapshot(workspaceId, sessionId) {
    const now = new Date().toISOString();
    const snapshot = {
        workspaceId,
        since: now,
        resetAt: now,
        totalCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        timeoutCalls: 0,
        cancelledCalls: 0,
        skippedCalls: 0,
        allowDecisions: 0,
        askDecisions: 0,
        denyDecisions: 0,
        totalLatencyMs: 0,
        maxLatencyMs: 0,
        totalRequestBytes: 0,
        totalResponseBytes: 0,
        activeCalls: 0,
        loopGuardChecks: 0,
        loopGuardWarnings: 0,
        loopGuardInterruptions: 0,
        loopGuardUncertain: 0,
        doneGateChecks: 0,
        doneGateInterventions: 0,
        doneGateUncertain: 0,
        resultShaperCalls: 0,
        resultShaperCharsRemoved: 0,
    };
    if (sessionId !== undefined)
        snapshot.sessionId = sessionId;
    return snapshot;
}
function cloneSnapshot(snapshot) {
    return { ...snapshot };
}
export class StatisticsStore {
    persistence;
    scopes = new Map();
    persistQueue = Promise.resolve();
    onChanged;
    onPersistenceError;
    ready;
    constructor(persistence) {
        this.persistence = persistence;
        this.ready = this.load();
    }
    setOnChanged(callback) {
        this.onChanged = callback;
    }
    setOnPersistenceError(callback) {
        this.onPersistenceError = callback;
    }
    async load() {
        const value = await this.persistence.loadStats();
        for (const [key, snapshot] of Object.entries(value.scopes)) {
            if (snapshot && typeof snapshot.workspaceId === 'string') {
                const defaults = createSnapshot(snapshot.workspaceId, snapshot.sessionId);
                this.scopes.set(key, { ...defaults, ...snapshot });
            }
        }
    }
    getOrCreate(workspaceId, sessionId) {
        const key = scopeKey(workspaceId, sessionId);
        const existing = this.scopes.get(key);
        if (existing)
            return existing;
        const created = createSnapshot(workspaceId, sessionId);
        this.scopes.set(key, created);
        return created;
    }
    persist() {
        const file = {
            version: 1,
            scopes: Object.fromEntries([...this.scopes.entries()].map(([key, value]) => [key, cloneSnapshot(value)])),
        };
        this.persistQueue = this.persistQueue
            .catch(() => undefined)
            .then(() => this.persistence.saveStats(file))
            .catch(error => {
            this.onPersistenceError?.(error);
        });
    }
    changed(snapshot) {
        this.persist();
        this.onChanged?.(cloneSnapshot(snapshot));
    }
    get(workspaceId, sessionId) {
        return cloneSnapshot(this.getOrCreate(workspaceId, sessionId));
    }
    begin(workspaceId, sessionId, requestBytes) {
        const snapshot = this.getOrCreate(workspaceId, sessionId);
        snapshot.totalCalls += 1;
        snapshot.activeCalls += 1;
        snapshot.totalRequestBytes += requestBytes;
        this.changed(snapshot);
        let finished = false;
        return () => {
            if (finished)
                return;
            finished = true;
            snapshot.activeCalls = Math.max(0, snapshot.activeCalls - 1);
            this.changed(snapshot);
        };
    }
    recordCall(workspaceId, sessionId, measurement, decision) {
        const snapshot = this.getOrCreate(workspaceId, sessionId);
        if (measurement.ok)
            snapshot.successfulCalls += 1;
        else
            snapshot.failedCalls += 1;
        if (measurement.timedOut)
            snapshot.timeoutCalls += 1;
        if (measurement.cancelled)
            snapshot.cancelledCalls += 1;
        snapshot.totalLatencyMs += Math.max(0, measurement.latencyMs);
        snapshot.maxLatencyMs = Math.max(snapshot.maxLatencyMs, Math.max(0, measurement.latencyMs));
        snapshot.totalResponseBytes += Math.max(0, measurement.responseBytes);
        if (decision === 'allow')
            snapshot.allowDecisions += 1;
        if (decision === 'ask')
            snapshot.askDecisions += 1;
        if (decision === 'deny')
            snapshot.denyDecisions += 1;
        this.changed(snapshot);
    }
    recordSkipped(workspaceId, sessionId) {
        const snapshot = this.getOrCreate(workspaceId, sessionId);
        snapshot.skippedCalls += 1;
        this.changed(snapshot);
    }
    recordLoopGuard(workspaceId, sessionId, outcome) {
        const snapshot = this.getOrCreate(workspaceId, sessionId);
        snapshot.loopGuardChecks += 1;
        if (outcome === 'warning')
            snapshot.loopGuardWarnings += 1;
        if (outcome === 'interrupt')
            snapshot.loopGuardInterruptions += 1;
        if (outcome === 'uncertain')
            snapshot.loopGuardUncertain += 1;
        this.changed(snapshot);
    }
    recordDoneGate(workspaceId, sessionId, outcome) {
        const snapshot = this.getOrCreate(workspaceId, sessionId);
        snapshot.doneGateChecks += 1;
        if (outcome === 'intervention')
            snapshot.doneGateInterventions += 1;
        if (outcome === 'uncertain')
            snapshot.doneGateUncertain += 1;
        this.changed(snapshot);
    }
    recordResultShape(workspaceId, sessionId, charsRemoved) {
        const snapshot = this.getOrCreate(workspaceId, sessionId);
        snapshot.resultShaperCalls += 1;
        snapshot.resultShaperCharsRemoved += Math.max(0, Math.floor(charsRemoved));
        this.changed(snapshot);
    }
    async reset(workspaceId, sessionId) {
        await this.ready;
        const replacement = createSnapshot(workspaceId, sessionId);
        this.scopes.set(scopeKey(workspaceId, sessionId), replacement);
        this.changed(replacement);
        await this.persistQueue;
        return cloneSnapshot(replacement);
    }
    async flush() {
        await this.persistQueue;
    }
}
//# sourceMappingURL=stats.js.map