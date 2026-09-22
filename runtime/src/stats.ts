import type { StatisticsSnapshot } from '../../protocol/src/index.js'
import type { IntegrationPersistence, PersistedStatsFile } from './persistence.js'

function scopeKey(workspaceId: string, sessionId?: string): string {
  return JSON.stringify([workspaceId, sessionId ?? null])
}

function createSnapshot(workspaceId: string, sessionId?: string): StatisticsSnapshot {
  const now = new Date().toISOString()
  const snapshot: StatisticsSnapshot = {
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
    toolPrunerCalls: 0,
    toolPrunerSkipped: 0,
    toolPrunerLowConfidence: 0,
    toolPrunerFailOpen: 0,
    toolPrunerToolsSeen: 0,
    toolPrunerToolsKept: 0,
    toolPrunerRemovedChars: 0,
    toolPrunerLatencyMs: 0,
    skillRouterCalls: 0,
    skillRouterSkipped: 0,
    skillRouterLowConfidence: 0,
    skillRouterFailOpen: 0,
    skillRouterAdviceCount: 0,
    skillRouterAdviceChars: 0,
    skillRouterLatencyMs: 0,
    decisionToolCalls: 0,
    decisionToolUnknown: 0,
    decisionToolFailOpen: 0,
    decisionToolLatencyMs: 0,
    deterministicGuardChecks: 0,
    deterministicGuardDenies: 0,
  }
  if (sessionId !== undefined) snapshot.sessionId = sessionId
  return snapshot
}

function cloneSnapshot(snapshot: StatisticsSnapshot): StatisticsSnapshot {
  return { ...snapshot }
}

export interface CallResultMeasurement {
  ok: boolean
  latencyMs: number
  requestBytes: number
  responseBytes: number
  timedOut?: boolean
  cancelled?: boolean
}

export class StatisticsStore {
  private readonly scopes = new Map<string, StatisticsSnapshot>()
  private persistQueue: Promise<void> = Promise.resolve()
  private onChanged?: (snapshot: StatisticsSnapshot) => void
  private onPersistenceError?: (error: unknown) => void
  public readonly ready: Promise<void>

  public constructor(private readonly persistence: IntegrationPersistence) {
    this.ready = this.load()
  }

  public setOnChanged(callback: (snapshot: StatisticsSnapshot) => void): void {
    this.onChanged = callback
  }

  public setOnPersistenceError(callback: (error: unknown) => void): void {
    this.onPersistenceError = callback
  }

  private async load(): Promise<void> {
    const value = await this.persistence.loadStats()
    for (const [key, snapshot] of Object.entries(value.scopes)) {
      if (snapshot && typeof snapshot.workspaceId === 'string') {
        const defaults = createSnapshot(snapshot.workspaceId, snapshot.sessionId)
        this.scopes.set(key, { ...defaults, ...snapshot })
      }
    }
  }

  private getOrCreate(workspaceId: string, sessionId?: string): StatisticsSnapshot {
    const key = scopeKey(workspaceId, sessionId)
    const existing = this.scopes.get(key)
    if (existing) return existing
    const created = createSnapshot(workspaceId, sessionId)
    this.scopes.set(key, created)
    return created
  }

  private persist(): void {
    const file: PersistedStatsFile = {
      version: 1,
      scopes: Object.fromEntries([...this.scopes.entries()].map(([key, value]) => [key, cloneSnapshot(value)])),
    }
    this.persistQueue = this.persistQueue
      .catch(() => undefined)
      .then(() => this.persistence.saveStats(file))
      .catch(error => {
        this.onPersistenceError?.(error)
      })
  }

  private changed(snapshot: StatisticsSnapshot): void {
    this.persist()
    this.onChanged?.(cloneSnapshot(snapshot))
  }

  public get(workspaceId: string, sessionId?: string): StatisticsSnapshot {
    return cloneSnapshot(this.getOrCreate(workspaceId, sessionId))
  }

  public begin(workspaceId: string, sessionId: string | undefined, requestBytes: number): () => void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    snapshot.totalCalls += 1
    snapshot.activeCalls += 1
    snapshot.totalRequestBytes += requestBytes
    this.changed(snapshot)
    let finished = false
    return () => {
      if (finished) return
      finished = true
      snapshot.activeCalls = Math.max(0, snapshot.activeCalls - 1)
      this.changed(snapshot)
    }
  }

  public recordCall(
    workspaceId: string,
    sessionId: string | undefined,
    measurement: CallResultMeasurement,
    decision?: 'allow' | 'ask' | 'deny'
  ): void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    if (measurement.ok) snapshot.successfulCalls += 1
    else snapshot.failedCalls += 1
    if (measurement.timedOut) snapshot.timeoutCalls += 1
    if (measurement.cancelled) snapshot.cancelledCalls += 1
    snapshot.totalLatencyMs += Math.max(0, measurement.latencyMs)
    snapshot.maxLatencyMs = Math.max(snapshot.maxLatencyMs, Math.max(0, measurement.latencyMs))
    snapshot.totalResponseBytes += Math.max(0, measurement.responseBytes)
    if (decision === 'allow') snapshot.allowDecisions += 1
    if (decision === 'ask') snapshot.askDecisions += 1
    if (decision === 'deny') snapshot.denyDecisions += 1
    this.changed(snapshot)
  }

  public recordSkipped(workspaceId: string, sessionId?: string): void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    snapshot.skippedCalls += 1
    this.changed(snapshot)
  }

  public recordLoopGuard(workspaceId: string, sessionId: string | undefined, outcome: 'warning' | 'interrupt' | 'uncertain'): void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    snapshot.loopGuardChecks += 1
    if (outcome === 'warning') snapshot.loopGuardWarnings += 1
    if (outcome === 'interrupt') snapshot.loopGuardInterruptions += 1
    if (outcome === 'uncertain') snapshot.loopGuardUncertain += 1
    this.changed(snapshot)
  }

  public recordDoneGate(workspaceId: string, sessionId: string | undefined, outcome: 'intervention' | 'uncertain' | 'pass'): void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    snapshot.doneGateChecks += 1
    if (outcome === 'intervention') snapshot.doneGateInterventions += 1
    if (outcome === 'uncertain') snapshot.doneGateUncertain += 1
    this.changed(snapshot)
  }

  public recordResultShape(workspaceId: string, sessionId: string | undefined, charsRemoved: number): void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    snapshot.resultShaperCalls += 1
    snapshot.resultShaperCharsRemoved += Math.max(0, Math.floor(charsRemoved))
    this.changed(snapshot)
  }

  public recordToolPruner(
    workspaceId: string,
    sessionId: string | undefined,
    outcome: 'call' | 'skipped' | 'low-confidence' | 'fail-open',
    seen = 0,
    kept = 0,
    removedChars = 0,
    latencyMs = 0,
  ): void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    if (outcome !== 'skipped') snapshot.toolPrunerCalls += 1
    if (outcome === 'skipped') snapshot.toolPrunerSkipped += 1
    if (outcome === 'low-confidence') snapshot.toolPrunerLowConfidence += 1
    if (outcome === 'fail-open') snapshot.toolPrunerFailOpen += 1
    snapshot.toolPrunerToolsSeen += Math.max(0, Math.floor(seen))
    snapshot.toolPrunerToolsKept += Math.max(0, Math.floor(kept))
    snapshot.toolPrunerRemovedChars += Math.max(0, Math.floor(removedChars))
    snapshot.toolPrunerLatencyMs += Math.max(0, latencyMs)
    this.changed(snapshot)
  }

  public recordSkillRouter(
    workspaceId: string,
    sessionId: string | undefined,
    outcome: 'call' | 'skipped' | 'low-confidence' | 'fail-open',
    adviceCount = 0,
    adviceChars = 0,
    latencyMs = 0,
  ): void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    if (outcome !== 'skipped') snapshot.skillRouterCalls += 1
    if (outcome === 'skipped') snapshot.skillRouterSkipped += 1
    if (outcome === 'low-confidence') snapshot.skillRouterLowConfidence += 1
    if (outcome === 'fail-open') snapshot.skillRouterFailOpen += 1
    snapshot.skillRouterAdviceCount += Math.max(0, Math.floor(adviceCount))
    snapshot.skillRouterAdviceChars += Math.max(0, Math.floor(adviceChars))
    snapshot.skillRouterLatencyMs += Math.max(0, latencyMs)
    this.changed(snapshot)
  }

  public recordDecisionTool(
    workspaceId: string,
    sessionId: string | undefined,
    outcome: 'call' | 'unknown' | 'fail-open',
    latencyMs = 0,
  ): void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    snapshot.decisionToolCalls += 1
    if (outcome === 'unknown') snapshot.decisionToolUnknown += 1
    if (outcome === 'fail-open') snapshot.decisionToolFailOpen += 1
    snapshot.decisionToolLatencyMs += Math.max(0, latencyMs)
    this.changed(snapshot)
  }

  public recordDeterministicGuard(workspaceId: string, sessionId: string | undefined, denied: boolean): void {
    const snapshot = this.getOrCreate(workspaceId, sessionId)
    snapshot.deterministicGuardChecks += 1
    if (denied) snapshot.deterministicGuardDenies += 1
    this.changed(snapshot)
  }

  public async reset(workspaceId: string, sessionId?: string): Promise<StatisticsSnapshot> {
    await this.ready
    const replacement = createSnapshot(workspaceId, sessionId)
    this.scopes.set(scopeKey(workspaceId, sessionId), replacement)
    this.changed(replacement)
    await this.persistQueue
    return cloneSnapshot(replacement)
  }

  public async flush(): Promise<void> {
    await this.persistQueue
  }
}
