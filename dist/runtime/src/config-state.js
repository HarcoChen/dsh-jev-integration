import { DEFAULT_CONFIG, } from '../../protocol/src/index.js';
function scopeKey(workspaceId, sessionId) {
    return `${workspaceId}\u0000${sessionId}`;
}
function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}
function mergeConfig(base, patch) {
    const next = { ...base };
    if (patch.enabled !== undefined)
        next.enabled = patch.enabled;
    if (patch.baseUrl !== undefined)
        next.baseUrl = patch.baseUrl;
    if (patch.model !== undefined)
        next.model = patch.model;
    if (patch.timeoutMs !== undefined)
        next.timeoutMs = patch.timeoutMs;
    if (patch.advisoryTimeoutMs !== undefined)
        next.advisoryTimeoutMs = patch.advisoryTimeoutMs;
    if (patch.askThreshold !== undefined)
        next.askThreshold = patch.askThreshold;
    if (patch.blockThreshold !== undefined)
        next.blockThreshold = patch.blockThreshold;
    if (patch.guardedTools !== undefined)
        next.guardedTools = [...patch.guardedTools];
    return next;
}
function patchWithoutUnknown(value) {
    const allowed = {};
    if (value.enabled !== undefined)
        allowed.enabled = value.enabled;
    if (value.baseUrl !== undefined)
        allowed.baseUrl = value.baseUrl;
    if (value.model !== undefined)
        allowed.model = value.model;
    if (value.timeoutMs !== undefined)
        allowed.timeoutMs = value.timeoutMs;
    if (value.advisoryTimeoutMs !== undefined)
        allowed.advisoryTimeoutMs = value.advisoryTimeoutMs;
    if (value.askThreshold !== undefined)
        allowed.askThreshold = value.askThreshold;
    if (value.blockThreshold !== undefined)
        allowed.blockThreshold = value.blockThreshold;
    if (value.guardedTools !== undefined)
        allowed.guardedTools = [...value.guardedTools];
    return allowed;
}
export function validateConfigPatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return { error: 'patch must be an object' };
    const candidate = value;
    const allowedKeys = new Set([
        'enabled',
        'baseUrl',
        'model',
        'timeoutMs',
        'advisoryTimeoutMs',
        'askThreshold',
        'blockThreshold',
        'guardedTools',
    ]);
    for (const key of Object.keys(candidate)) {
        if (!allowedKeys.has(key))
            return { error: `unsupported config field: ${key}` };
    }
    if (candidate.enabled !== undefined && typeof candidate.enabled !== 'boolean')
        return { error: 'enabled must be boolean' };
    if (candidate.baseUrl !== undefined) {
        if (typeof candidate.baseUrl !== 'string' || candidate.baseUrl.length === 0)
            return { error: 'baseUrl must be a non-empty URL' };
        try {
            const url = new URL(candidate.baseUrl);
            if (url.protocol !== 'https:' && url.protocol !== 'http:')
                return { error: 'baseUrl must use http or https' };
        }
        catch {
            return { error: 'baseUrl must be a valid URL' };
        }
    }
    if (candidate.model !== undefined && (typeof candidate.model !== 'string' || candidate.model.length === 0)) {
        return { error: 'model must be a non-empty string' };
    }
    for (const key of ['timeoutMs', 'advisoryTimeoutMs']) {
        const number = candidate[key];
        if (number !== undefined && (!Number.isInteger(number) || Number(number) < 1 || Number(number) > 120_000)) {
            return { error: `${key} must be an integer from 1 to 120000` };
        }
    }
    for (const key of ['askThreshold', 'blockThreshold']) {
        const number = candidate[key];
        if (number !== undefined && (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1)) {
            return { error: `${key} must be a number from 0 to 1` };
        }
    }
    if (candidate.guardedTools !== undefined) {
        if (!Array.isArray(candidate.guardedTools) || candidate.guardedTools.some((tool) => typeof tool !== 'string' || tool.length === 0)) {
            return { error: 'guardedTools must be a non-empty-string array' };
        }
        if (new Set(candidate.guardedTools).size !== candidate.guardedTools.length)
            return { error: 'guardedTools must be unique' };
    }
    const patch = patchWithoutUnknown(candidate);
    const merged = mergeConfig(DEFAULT_CONFIG, patch);
    if (merged.blockThreshold < merged.askThreshold)
        return { error: 'blockThreshold must be at least askThreshold' };
    return { patch };
}
export class ConfigState {
    persistence;
    persistedGlobal = {};
    persistedWorkspaces = {};
    sessionOverrides = new Map();
    nextTurnOverrides = new Map();
    startupPatch;
    ready;
    constructor(persistence, startupPatch = {}) {
        this.persistence = persistence;
        this.startupPatch = patchWithoutUnknown(startupPatch);
        this.ready = this.load();
    }
    async load() {
        const persisted = await this.persistence.loadConfig();
        this.persistedGlobal = patchWithoutUnknown(persisted.global);
        this.persistedWorkspaces = {};
        for (const [workspaceId, patch] of Object.entries(persisted.workspaces)) {
            this.persistedWorkspaces[workspaceId] = patchWithoutUnknown(patch);
        }
    }
    layers(workspaceId, sessionId) {
        const layers = [
            { source: 'default', patch: {} },
            { source: 'global', patch: this.persistedGlobal },
            { source: 'workspace', patch: this.persistedWorkspaces[workspaceId] ?? {} },
        ];
        if (sessionId) {
            layers.push({ source: 'session', patch: this.sessionOverrides.get(scopeKey(workspaceId, sessionId)) ?? {} });
            layers.push({ source: 'next-turn', patch: this.nextTurnOverrides.get(scopeKey(workspaceId, sessionId)) ?? {} });
        }
        // The startup patch is the runtime composition layer. It intentionally sits
        // above persisted defaults so an operator can pin a deployment-wide value.
        layers.splice(1, 0, { source: 'startup', patch: this.startupPatch });
        return layers;
    }
    resolve(workspaceId, sessionId) {
        const layers = this.layers(workspaceId, sessionId);
        let values = { ...DEFAULT_CONFIG, guardedTools: [...DEFAULT_CONFIG.guardedTools] };
        let source = 'default';
        let requestedEnabled = values.enabled;
        let requestedEnabledSource = 'default';
        for (const layer of layers) {
            values = mergeConfig(values, layer.patch);
            if (Object.keys(layer.patch).length > 0)
                source = layer.source;
            if (hasOwn(layer.patch, 'enabled') && layer.patch.enabled !== undefined) {
                requestedEnabled = layer.patch.enabled;
                requestedEnabledSource = layer.source;
            }
        }
        return { values, source, requestedEnabled, requestedEnabledSource };
    }
    async setPersisted(scope, workspaceId, patch) {
        if (scope === 'global')
            this.persistedGlobal = { ...this.persistedGlobal, ...patch };
        else
            this.persistedWorkspaces[workspaceId] = { ...(this.persistedWorkspaces[workspaceId] ?? {}), ...patch };
        const file = {
            version: 1,
            global: this.persistedGlobal,
            workspaces: this.persistedWorkspaces,
        };
        await this.persistence.saveConfig(file);
    }
    setEphemeral(scope, workspaceId, sessionId, patch) {
        const target = scope === 'session' ? this.sessionOverrides : this.nextTurnOverrides;
        const key = scopeKey(workspaceId, sessionId);
        target.set(key, { ...(target.get(key) ?? {}), ...patch });
    }
    consumeNextTurn(workspaceId, sessionId) {
        return this.nextTurnOverrides.delete(scopeKey(workspaceId, sessionId));
    }
    clearSession(workspaceId, sessionId) {
        const key = scopeKey(workspaceId, sessionId);
        this.sessionOverrides.delete(key);
        this.nextTurnOverrides.delete(key);
    }
}
//# sourceMappingURL=config-state.js.map