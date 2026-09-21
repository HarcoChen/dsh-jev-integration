import { ERROR_CODE_NAMES, MIN_DSH_RUNTIME_VERSION, PROTOCOL_VERSION, } from '../../protocol/src/index.js';
import { ConfigState, validateConfigPatch } from './config-state.js';
import { JevClient, JevClientError, noulProbability } from './jev-client.js';
import { IntegrationPersistence } from './persistence.js';
import { StatisticsStore } from './stats.js';
import { VERSION } from './version.js';
function scopeKey(identity) {
    return JSON.stringify([identity.workspaceId, identity.sessionId ?? null]);
}
function parseUrl(request) {
    return new URL(request.url, 'http://dsh-jev.local');
}
function jsonResponse(value, status = 200, headers) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    });
}
function success(data) {
    return jsonResponse({ ok: true, data });
}
function errorResponse(code, message, status, details, retryable = false) {
    const error = {
        code,
        name: ERROR_CODE_NAMES[code],
        message,
        retryable,
    };
    if (details !== undefined)
        error.details = details;
    return jsonResponse({ ok: false, error }, status);
}
function requiredQuery(url, name) {
    const value = url.searchParams.get(name)?.trim();
    return value ? value : errorResponse('DJE-0002', `${name} is required`, 400);
}
function optionalQuery(url, name) {
    const value = url.searchParams.get(name)?.trim();
    return value || undefined;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
async function parseBody(request) {
    const text = await request.text();
    if (!text.trim())
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error('request body is not valid JSON');
    }
}
function eventMatches(subscriber, event) {
    return subscriber.workspaceId === event.workspaceId && (subscriber.sessionId === undefined || subscriber.sessionId === event.sessionId);
}
function extractSession(value) {
    if (!isRecord(value))
        return {};
    const header = isRecord(value.header) ? value.header : undefined;
    const id = typeof value.id === 'string' ? value.id : undefined;
    const cwd = header && typeof header.cwd === 'string' ? header.cwd : undefined;
    const result = {};
    if (id !== undefined)
        result.id = id;
    if (cwd !== undefined)
        result.cwd = cwd;
    return result;
}
function extractTurnEvent(value) {
    if (!isRecord(value))
        return {};
    const type = typeof value.type === 'string' ? value.type : undefined;
    return type === undefined ? {} : { type };
}
function asNext(value) {
    return typeof value === 'function' ? value : async () => ({ kind: 'allow', action: 'allow' });
}
const ADVISORY_RETRIES = 1;
const ADVISORY_RETRY_DELAY_MS = 150;
function isRetryableAdvisoryError(error) {
    if (!(error instanceof JevClientError))
        return false;
    if (error.kind === 'timeout' || error.kind === 'network')
        return true;
    return error.kind === 'http' && (error.status === 429 || (error.status !== undefined && error.status >= 500));
}
function waitForRetry(delayMs, signal) {
    if (signal?.aborted)
        return Promise.reject(new JevClientError('cancelled', 'Jev call was cancelled before retry'));
    return new Promise((resolve, reject) => {
        let timer;
        const finish = () => {
            if (timer !== undefined)
                clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve();
        };
        const onAbort = () => {
            if (timer !== undefined)
                clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(new JevClientError('cancelled', 'Jev call was cancelled before retry'));
        };
        timer = setTimeout(finish, delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
async function callAdvisoryWithRetry(client, request, options, onRetry) {
    let retry = 0;
    for (;;) {
        try {
            return await client.systemOne(request, options);
        }
        catch (error) {
            if (!(error instanceof JevClientError) || !isRetryableAdvisoryError(error) || retry >= ADVISORY_RETRIES || options.signal?.aborted) {
                throw error;
            }
            retry += 1;
            onRetry(retry, error);
            await waitForRetry(ADVISORY_RETRY_DELAY_MS * retry, options.signal);
        }
    }
}
export class JevIntegration {
    name = 'dsh-jev-integration';
    persistence;
    configState;
    stats;
    ready;
    context;
    options;
    availability = new Map();
    activeRequests = new Map();
    lastDecisions = new Map();
    lastErrors = new Map();
    subscribers = new Set();
    hookDisposers = [];
    routeDisposers = [];
    serviceDisposer;
    eventSequence = 0;
    mounted = false;
    endpointAvailable = false;
    endpointReason = 'connection-unavailable';
    connectionRegistrationStarted = false;
    routeReady = Promise.resolve();
    constructor(context, options = {}) {
        this.context = context;
        this.options = options;
        this.persistence = new IntegrationPersistence(options.persistenceRootDir);
        const startupPatch = {};
        if (options.enabled !== undefined)
            startupPatch.enabled = options.enabled;
        if (options.baseUrl !== undefined)
            startupPatch.baseUrl = options.baseUrl;
        if (options.model !== undefined)
            startupPatch.model = options.model;
        if (options.timeoutMs !== undefined)
            startupPatch.timeoutMs = options.timeoutMs;
        if (options.advisoryTimeoutMs !== undefined)
            startupPatch.advisoryTimeoutMs = options.advisoryTimeoutMs;
        if (options.askThreshold !== undefined)
            startupPatch.askThreshold = options.askThreshold;
        if (options.blockThreshold !== undefined)
            startupPatch.blockThreshold = options.blockThreshold;
        if (options.guardedTools !== undefined)
            startupPatch.guardedTools = [...options.guardedTools];
        const validation = validateConfigPatch(startupPatch);
        this.configState = new ConfigState(this.persistence, validation.patch ?? {});
        this.stats = new StatisticsStore(this.persistence);
        this.stats.setOnChanged(snapshot => this.emitStatsChanged(snapshot));
        this.stats.setOnPersistenceError(error => this.context.logger?.warn?.(`dsh-jev-integration: stats persistence failed: ${String(error)}`));
        this.ready = Promise.all([this.configState.ready, this.stats.ready]).then(() => undefined);
    }
    async whenReady() {
        await this.ready;
        await this.routeReady;
    }
    mount() {
        if (this.mounted)
            return this;
        this.mounted = true;
        const provided = this.context.provide?.('jevIntegration', this);
        if (typeof provided === 'function')
            this.serviceDisposer = provided;
        this.registerHooks();
        this.routeReady = this.mountConnectionRoutes();
        this.context.effect?.(() => () => this.dispose());
        return this;
    }
    async dispose() {
        if (!this.mounted)
            return;
        this.mounted = false;
        for (const disposer of this.hookDisposers.splice(0))
            disposer();
        this.serviceDisposer?.();
        this.serviceDisposer = undefined;
        for (const disposer of this.routeDisposers.splice(0)) {
            try {
                await disposer();
            }
            catch (error) {
                this.context.logger?.warn?.(`dsh-jev-integration: route cleanup failed: ${String(error)}`);
            }
        }
        // Deliberately do not stop or reset a shared Jev client: another Connection
        // may still be using this Runtime. Only this integration's subscriptions go.
        this.subscribers.clear();
        this.endpointAvailable = false;
        this.endpointReason = 'plugin-unmounted';
        this.connectionRegistrationStarted = false;
    }
    registerHooks() {
        const preDisposer = this.context.on?.('tools/pre-execute', ((exec, next) => this.preExecute(exec, asNext(next))));
        if (typeof preDisposer === 'function')
            this.hookDisposers.push(preDisposer);
        const sessionDisposer = this.context.on?.('session/event', ((session, event) => {
            void this.onSessionEvent(session, event);
        }));
        if (typeof sessionDisposer === 'function')
            this.hookDisposers.push(sessionDisposer);
    }
    getConnection(context = this.context) {
        // Cordis only exposes service properties on a context that declared the
        // service in `inject`. `ctx.get()` is safe for the optional connection;
        // keep the direct-property fallback for the small host/test contexts that
        // implement the service as a plain object.
        let viaGet;
        try {
            viaGet = context.get?.('connection');
        }
        catch {
            viaGet = undefined;
        }
        if (isRecord(viaGet) && isRecord(viaGet.fetch) && typeof viaGet.fetch.register === 'function')
            return viaGet;
        try {
            const direct = context.connection;
            if (direct && isRecord(direct.fetch) && typeof direct.fetch.register === 'function')
                return direct;
        }
        catch {
            // An uninjected Cordis property is intentionally ignored; the inject
            // callback below will retry when Connection becomes available.
        }
        return undefined;
    }
    async mountConnectionRoutes() {
        const immediate = this.getConnection();
        if (immediate) {
            await this.registerConnectionRoutes(immediate);
            return;
        }
        this.endpointAvailable = false;
        this.endpointReason = 'connection-unavailable';
        this.context.inject?.(['connection'], child => {
            const connection = this.getConnection(child);
            if (connection)
                void this.registerConnectionRoutes(connection);
        });
    }
    async registerConnectionRoutes(connection) {
        if (this.endpointAvailable || this.connectionRegistrationStarted)
            return;
        this.connectionRegistrationStarted = true;
        const routes = [
            { path: '/api/dsh-jev/capabilities', methods: ['GET'], requestBody: 'buffered', fetch: request => this.routeCapabilities(request) },
            { path: '/api/dsh-jev/config', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: request => this.routeConfig(request) },
            { path: '/api/dsh-jev/state', methods: ['GET'], requestBody: 'buffered', fetch: request => this.routeState(request) },
            { path: '/api/dsh-jev/stats', methods: ['GET'], requestBody: 'buffered', fetch: request => this.routeStats(request) },
            { path: '/api/dsh-jev/stats/reset', methods: ['POST'], requestBody: 'buffered', fetch: request => this.routeStatsReset(request) },
            { path: '/api/dsh-jev/events', methods: ['GET'], requestBody: 'streaming', fetch: request => this.routeEvents(request) },
        ];
        try {
            for (const route of routes) {
                const disposer = await connection.fetch.register(route);
                this.routeDisposers.push(disposer);
            }
            this.endpointAvailable = true;
            this.endpointReason = 'ready';
            this.context.logger?.info?.('dsh-jev-integration: Connection endpoints mounted');
        }
        catch (error) {
            for (const disposer of this.routeDisposers.splice(0)) {
                try {
                    await disposer();
                }
                catch {
                    // The original registration already failed; keep the retry bounded.
                }
            }
            this.endpointAvailable = false;
            this.endpointReason = 'route-registration-failed';
            this.connectionRegistrationStarted = false;
            this.context.logger?.warn?.(`dsh-jev-integration: Connection endpoint registration failed: ${String(error)}`);
        }
    }
    async resolveWorkspace(session) {
        const identity = extractSession(session);
        if (!identity.id && !identity.cwd)
            return undefined;
        if (!identity.cwd)
            return identity.id ? undefined : undefined;
        let registry;
        try {
            registry = this.context.get?.('workspaceRegistry');
        }
        catch {
            registry = undefined;
        }
        if (registry === undefined) {
            try {
                registry = this.context.workspaceRegistry;
            }
            catch {
                registry = undefined;
            }
        }
        if (!registry?.resolveByPath)
            return undefined;
        try {
            const workspace = await registry.resolveByPath(identity.cwd);
            if (!workspace?.id)
                return undefined;
            const result = { workspaceId: workspace.id };
            if (identity.id !== undefined)
                result.sessionId = identity.id;
            return result;
        }
        catch {
            return undefined;
        }
    }
    availabilityFor(identity) {
        return this.availability.get(scopeKey(identity));
    }
    async getState(identity) {
        await this.ready;
        const resolved = this.configState.resolve(identity.workspaceId, identity.sessionId);
        const key = scopeKey(identity);
        const storedAvailability = this.availabilityFor(identity);
        let available = storedAvailability?.available;
        let reason = storedAvailability?.reason;
        if (available === undefined) {
            const client = new JevClient(resolved.values, this.options.apiKey, this.options.fetch);
            available = await client.hasApiKey();
            if (!available)
                reason = 'missing-api-key';
        }
        const state = {
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
        };
        if (identity.sessionId !== undefined)
            state.sessionId = identity.sessionId;
        if (reason !== undefined)
            state.availabilityReason = reason;
        const lastDecision = this.lastDecisions.get(key);
        if (lastDecision !== undefined)
            state.lastDecision = lastDecision;
        const lastError = this.lastErrors.get(key);
        if (lastError) {
            state.lastErrorCode = lastError.code;
            state.lastErrorMessage = lastError.message;
        }
        return state;
    }
    setAvailability(identity, available, reason, errorCode) {
        const value = { available };
        if (reason !== undefined)
            value.reason = reason;
        if (errorCode !== undefined)
            value.errorCode = errorCode;
        this.availability.set(scopeKey(identity), value);
        if (errorCode !== undefined && reason !== undefined)
            this.lastErrors.set(scopeKey(identity), { code: errorCode, message: reason });
        if (available)
            this.lastErrors.delete(scopeKey(identity));
        void this.publishState(identity);
    }
    setDecision(identity, decision) {
        this.lastDecisions.set(scopeKey(identity), decision);
        void this.publishState(identity);
    }
    incrementActive(identity) {
        const key = scopeKey(identity);
        this.activeRequests.set(key, (this.activeRequests.get(key) ?? 0) + 1);
        void this.publishState(identity);
    }
    decrementActive(identity) {
        const key = scopeKey(identity);
        const count = Math.max(0, (this.activeRequests.get(key) ?? 1) - 1);
        if (count === 0)
            this.activeRequests.delete(key);
        else
            this.activeRequests.set(key, count);
        void this.publishState(identity);
    }
    async preExecute(execValue, next) {
        await this.ready;
        const exec = isRecord(execValue) ? execValue : {};
        const toolName = typeof exec.name === 'string' ? exec.name : '';
        const session = exec.agent && isRecord(exec.agent) ? exec.agent.session : undefined;
        const identity = await this.resolveWorkspace(session);
        if (!identity)
            return next();
        const resolved = this.configState.resolve(identity.workspaceId, identity.sessionId);
        if (!resolved.values.enabled || !resolved.values.guardedTools.includes(toolName)) {
            this.stats.recordSkipped(identity.workspaceId, identity.sessionId);
            this.setDecision(identity, 'skipped');
            return next();
        }
        const client = new JevClient(resolved.values, this.options.apiKey, this.options.fetch);
        if (!(await client.hasApiKey())) {
            this.stats.recordSkipped(identity.workspaceId, identity.sessionId);
            this.setAvailability(identity, false, 'missing-api-key', 'DJE-0007');
            this.setDecision(identity, 'skipped');
            return next();
        }
        const state = {
            workspaceId: identity.workspaceId,
            sessionId: identity.sessionId,
            tool: toolName,
            arguments: exec.arguments ?? exec.args,
        };
        const questions = {
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
        };
        const requestBytesEstimate = new TextEncoder().encode(JSON.stringify({ model: resolved.values.model, state: JSON.stringify(state), questions })).byteLength;
        const finishActive = this.stats.begin(identity.workspaceId, identity.sessionId, requestBytesEstimate);
        this.incrementActive(identity);
        const callStarted = Date.now();
        try {
            const callOptions = { timeoutMs: resolved.values.advisoryTimeoutMs };
            if (exec.signal !== undefined)
                callOptions.signal = exec.signal;
            const result = await callAdvisoryWithRetry(client, { state, questions }, callOptions, (attempt, error) => {
                this.context.logger?.debug?.(`dsh-jev-integration: retrying Jev advisory (${attempt}/${ADVISORY_RETRIES}) after ${error.kind}`);
            });
            const hazards = ['is_destructive', 'is_exfiltration', 'is_jailbreak']
                .map(key => noulProbability(result.answers[key]))
                .filter((value) => typeof value === 'number');
            const riskScore = result.answers.risk_score?.type === 'score' && !result.answers.risk_score.unknown && typeof result.answers.risk_score.score === 'number'
                ? result.answers.risk_score.score
                : undefined;
            const maxHazard = hazards.length > 0 ? Math.max(...hazards) : undefined;
            let decision = 'allow';
            if ((maxHazard !== undefined && maxHazard >= resolved.values.blockThreshold) || (riskScore !== undefined && riskScore >= 1.7))
                decision = 'deny';
            else if ((maxHazard !== undefined && maxHazard >= resolved.values.askThreshold) || (riskScore !== undefined && riskScore >= 0.7))
                decision = 'ask';
            const measurement = { ok: true, latencyMs: Date.now() - callStarted, requestBytes: result.requestBytes, responseBytes: result.responseBytes };
            this.stats.recordCall(identity.workspaceId, identity.sessionId, measurement, decision);
            this.setAvailability(identity, true);
            this.setDecision(identity, decision);
            if (decision === 'deny') {
                return { kind: 'deny', action: 'deny', reason: `[DSH Jev] Execution blocked: hazard probability ${((maxHazard ?? 0) * 100).toFixed(0)}%.` };
            }
            if (decision === 'ask') {
                return {
                    kind: 'ask',
                    action: 'ask',
                    prompt: `[DSH Jev] Approval required: estimated hazard ${(Math.max(maxHazard ?? 0, (riskScore ?? 0) / 2) * 100).toFixed(0)}%.`,
                    reason: 'Potentially destructive or sensitive tool action',
                };
            }
            return next();
        }
        catch (error) {
            const jevError = error instanceof JevClientError ? error : undefined;
            const kind = jevError?.kind;
            const code = kind === 'timeout' ? 'DJE-0008' : kind === 'cancelled' ? 'DJE-0009' : 'DJE-0007';
            const message = jevError?.message ?? (error instanceof Error ? error.message : String(error));
            const timedOut = kind === 'timeout';
            const cancelled = kind === 'cancelled';
            this.stats.recordCall(identity.workspaceId, identity.sessionId, {
                ok: false,
                latencyMs: Date.now() - callStarted,
                requestBytes: requestBytesEstimate,
                responseBytes: 0,
                timedOut,
                cancelled,
            }, 'allow');
            // Jev is an optional advisory layer: a timeout, missing key, cancellation,
            // or upstream failure never blocks the normal DSH tool pipeline.
            this.setAvailability(identity, false, message, code);
            this.setDecision(identity, 'allow');
            this.context.logger?.warn?.(`dsh-jev-integration: Jev advisory skipped for ${toolName}: ${message}`);
            return next();
        }
        finally {
            finishActive();
            this.decrementActive(identity);
        }
    }
    async onSessionEvent(sessionValue, eventValue) {
        const event = extractTurnEvent(eventValue);
        if (event.type !== 'turn/start')
            return;
        const identity = await this.resolveWorkspace(sessionValue);
        if (!identity?.sessionId)
            return;
        if (this.configState.consumeNextTurn(identity.workspaceId, identity.sessionId)) {
            void this.publishState(identity);
        }
    }
    emit(type, identity, state, stats) {
        const event = {
            id: `${Date.now()}-${++this.eventSequence}`,
            type,
            at: new Date().toISOString(),
            workspaceId: identity.workspaceId,
        };
        if (identity.sessionId !== undefined)
            event.sessionId = identity.sessionId;
        if (state !== undefined)
            event.state = state;
        if (stats !== undefined)
            event.stats = stats;
        for (const subscriber of [...this.subscribers]) {
            if (!eventMatches(subscriber, event))
                continue;
            try {
                subscriber.callback(event);
            }
            catch {
                this.subscribers.delete(subscriber);
            }
        }
    }
    async publishState(identity) {
        if (!this.mounted)
            return;
        try {
            this.emit('state.changed', identity, await this.getState(identity));
        }
        catch (error) {
            this.context.logger?.warn?.(`dsh-jev-integration: state publication failed: ${String(error)}`);
        }
    }
    emitStatsChanged(snapshot) {
        const identity = { workspaceId: snapshot.workspaceId };
        if (snapshot.sessionId !== undefined)
            identity.sessionId = snapshot.sessionId;
        this.emit('stats.changed', identity, undefined, snapshot);
    }
    subscribe(identity, callback) {
        const subscriber = { workspaceId: identity.workspaceId, callback };
        if (identity.sessionId !== undefined)
            subscriber.sessionId = identity.sessionId;
        this.subscribers.add(subscriber);
        return () => this.subscribers.delete(subscriber);
    }
    async capabilities(workspaceId, sessionId) {
        await this.ready;
        const resolved = this.configState.resolve(workspaceId ?? '__capabilities__', sessionId);
        const client = new JevClient(resolved.values, this.options.apiKey, this.options.fetch);
        const stored = workspaceId === undefined ? undefined : this.availability.get(scopeKey({ workspaceId, ...(sessionId !== undefined ? { sessionId } : {}) }));
        const available = stored?.available ?? await client.hasApiKey();
        const result = {
            integrationVersion: VERSION.integration,
            integrationCommit: this.options.integrationCommit ?? VERSION.commit,
            protocolVersion: PROTOCOL_VERSION,
            runtimeCompatibility: {
                minimumDshRuntime: MIN_DSH_RUNTIME_VERSION,
                testedDshRuntime: this.options.dshRuntimeVersion ?? MIN_DSH_RUNTIME_VERSION,
                requiredFeatures: ['connection.fetch', 'tools/pre-execute', 'session/event'],
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
                nextTurnOverride: this.mounted,
            },
            jev: { baseUrl: resolved.values.baseUrl, model: resolved.values.model, available },
        };
        if (!this.endpointAvailable)
            result.endpointReason = this.endpointReason;
        if (stored?.reason !== undefined)
            result.jev.reason = stored.reason;
        else if (!available)
            result.jev.reason = 'missing-api-key';
        return result;
    }
    async routeCapabilities(request) {
        try {
            const url = parseUrl(request);
            return success(await this.capabilities(optionalQuery(url, 'workspaceId'), optionalQuery(url, 'sessionId')));
        }
        catch (error) {
            return errorResponse('DJE-0005', String(error), 503, undefined, true);
        }
    }
    async routeConfig(request) {
        try {
            const url = parseUrl(request);
            if (request.method === 'GET') {
                const workspaceValue = requiredQuery(url, 'workspaceId');
                if (workspaceValue instanceof Response)
                    return workspaceValue;
                const sessionId = optionalQuery(url, 'sessionId');
                const resolved = this.configState.resolve(workspaceValue, sessionId);
                const source = resolved.source;
                const response = {
                    workspaceId: workspaceValue,
                    persisted: source === 'global' || source === 'workspace',
                    scope: source === 'default' ? 'global' : source,
                    source,
                    values: resolved.values,
                };
                if (sessionId !== undefined)
                    response.sessionId = sessionId;
                return success(response);
            }
            const body = await parseBody(request);
            if (!isRecord(body))
                return errorResponse('DJE-0001', 'request body must be an object', 400);
            const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
            if (!workspaceId)
                return errorResponse('DJE-0002', 'workspaceId is required', 400);
            const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined;
            const scope = body.scope;
            if (scope !== 'global' && scope !== 'workspace' && scope !== 'session' && scope !== 'next-turn') {
                return errorResponse('DJE-0004', 'scope must be global, workspace, session, or next-turn', 400);
            }
            if ((scope === 'session' || scope === 'next-turn') && !sessionId)
                return errorResponse('DJE-0003', 'sessionId is required for session and next-turn scopes', 400);
            const validated = validateConfigPatch(body.patch);
            if (!validated.patch)
                return errorResponse('DJE-0001', validated.error ?? 'invalid config patch', 400);
            if (scope === 'global' || scope === 'workspace') {
                await this.configState.setPersisted(scope, workspaceId, validated.patch);
            }
            else {
                this.configState.setEphemeral(scope, workspaceId, sessionId, validated.patch);
            }
            const resolved = this.configState.resolve(workspaceId, sessionId);
            const response = {
                workspaceId,
                persisted: scope === 'global' || scope === 'workspace',
                scope,
                source: resolved.source,
                values: resolved.values,
            };
            if (sessionId !== undefined)
                response.sessionId = sessionId;
            const identity = { workspaceId };
            if (sessionId !== undefined)
                identity.sessionId = sessionId;
            this.emit('config.changed', identity, await this.getState(identity));
            return success(response);
        }
        catch (error) {
            this.context.logger?.warn?.(`dsh-jev-integration: config request failed: ${String(error)}`);
            if (error instanceof Error && error.message.includes('request body is not valid JSON')) {
                return errorResponse('DJE-0001', error.message, 400);
            }
            return errorResponse('DJE-0010', 'configuration could not be persisted', 500, undefined, true);
        }
    }
    async routeState(request) {
        const url = parseUrl(request);
        const workspaceValue = requiredQuery(url, 'workspaceId');
        if (workspaceValue instanceof Response)
            return workspaceValue;
        try {
            const identity = { workspaceId: workspaceValue };
            const sessionId = optionalQuery(url, 'sessionId');
            if (sessionId !== undefined)
                identity.sessionId = sessionId;
            return success(await this.getState(identity));
        }
        catch (error) {
            return errorResponse('DJE-0005', String(error), 503, undefined, true);
        }
    }
    async routeStats(request) {
        const url = parseUrl(request);
        const workspaceValue = requiredQuery(url, 'workspaceId');
        if (workspaceValue instanceof Response)
            return workspaceValue;
        const sessionId = optionalQuery(url, 'sessionId');
        await this.stats.ready;
        const snapshot = this.stats.get(workspaceValue, sessionId);
        return success(snapshot);
    }
    async routeStatsReset(request) {
        try {
            const url = parseUrl(request);
            const body = await parseBody(request);
            const workspaceId = isRecord(body) && typeof body.workspaceId === 'string' ? body.workspaceId.trim() : optionalQuery(url, 'workspaceId');
            if (!workspaceId)
                return errorResponse('DJE-0002', 'workspaceId is required', 400);
            const sessionId = isRecord(body) && typeof body.sessionId === 'string' ? body.sessionId.trim() : optionalQuery(url, 'sessionId');
            return success(await this.stats.reset(workspaceId, sessionId));
        }
        catch (error) {
            return errorResponse('DJE-0011', 'statistics could not be reset or persisted', 500, { reason: String(error) }, true);
        }
    }
    async routeEvents(request) {
        const url = parseUrl(request);
        const workspaceValue = requiredQuery(url, 'workspaceId');
        if (workspaceValue instanceof Response)
            return workspaceValue;
        const sessionId = optionalQuery(url, 'sessionId');
        const identity = { workspaceId: workspaceValue };
        if (sessionId !== undefined)
            identity.sessionId = sessionId;
        const encoder = new TextEncoder();
        let closed = false;
        let controllerRef;
        let unsubscribe = () => undefined;
        const close = () => {
            if (closed)
                return;
            closed = true;
            unsubscribe();
            try {
                controllerRef?.close();
            }
            catch {
                // A client can race cancellation with close; it is already detached.
            }
        };
        const stream = new ReadableStream({
            start: controller => {
                controllerRef = controller;
                unsubscribe = this.subscribe(identity, event => {
                    if (!closed)
                        controller.enqueue(encoder.encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`));
                });
                request.signal.addEventListener('abort', close, { once: true });
                void this.getState(identity).then(state => {
                    if (!closed) {
                        const initial = {
                            id: `${Date.now()}-${++this.eventSequence}`,
                            type: 'state.changed',
                            at: new Date().toISOString(),
                            workspaceId: identity.workspaceId,
                            state,
                        };
                        if (identity.sessionId !== undefined)
                            initial.sessionId = identity.sessionId;
                        controller.enqueue(encoder.encode(`id: ${initial.id}\ndata: ${JSON.stringify(initial)}\n\n`));
                    }
                }).catch(error => controller.error(error));
            },
            cancel: close,
        });
        return new Response(stream, {
            status: 200,
            headers: {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            },
        });
    }
}
export function apply(context, options = {}) {
    const existing = context.get?.('jevIntegration');
    if (existing instanceof JevIntegration)
        return () => undefined;
    const integration = new JevIntegration(context, options).mount();
    return () => {
        void integration.dispose();
    };
}
export function createIntegration(context, options = {}) {
    return new JevIntegration(context, options);
}
//# sourceMappingURL=integration.js.map