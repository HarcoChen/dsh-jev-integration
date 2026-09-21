# Jev integration protocol 1.0

The JSON Schema at [`schema/jev-integration.schema.json`](schema/jev-integration.schema.json)
is the wire contract. TypeScript consumers can import `dsh-jev-integration/protocol`;
Kotlin consumers can copy/use
[`JevIntegrationProtocol.kt`](kotlin/src/main/kotlin/ai/deepseek/dsh/jev/JevIntegrationProtocol.kt)
with `kotlinx.serialization`. The Runtime routes use the DSH Connection exact
Fetch mechanism and return `{ "ok": true, "data": ... }` on success or
`{ "ok": false, "error": ... }` on failure. The SSE route sends the event
object directly as each `data:` payload.

## Scope and precedence

`workspaceId` is always the DSH Workspace identity resolved by
`workspaceRegistry.resolveByPath(session.header.cwd)`. It is not an IDE project
identifier. A hook that cannot resolve a DSH workspace does not invent one and
lets the normal DSH pipeline continue.

The effective configuration is layered in this order (later layers win):

1. built-in defaults;
2. the Runtime composition/startup patch (`runtime/cordis.patch.yml`);
3. persisted global values;
4. persisted per-workspace values;
5. in-memory per-session values;
6. in-memory `next-turn` values.

Only global and workspace writes are persisted in
`$DSH_HOME/jev-integration/config.json` (or
`DSH_JEV_INTEGRATION_HOME` when explicitly set). Session and next-turn writes
are lost when the Runtime/plugin scope ends. A `next-turn` value is consumed
exactly once on that DSH session's durable `session/event` with
`event.type == "turn/start"`; it is not consumed by an arbitrary IDE event.

Defaults are `enabled=false`, base URL
`https://api.typesafe.ai/v1/systemone`, model `jev-latest`, request timeout
2000 ms, advisory hook timeout 3500 ms, ask threshold 0.50, block threshold
0.85, and the guarded tool list in the TypeScript/Kotlin declarations. The
Runtime retries one transient timeout/network/429/5xx advisory failure and
never retries malformed answers or permanent HTTP failures. Enabled is a user
request, not a guarantee that Jev is reachable. `effective.enabled` is the
resolved configuration value; `effective.active` additionally requires Jev
availability. `executing`/`activeRequests` describe calls currently in flight.
`available=false` exposes a reason such as `missing-api-key` or the last
upstream error.

Because a guarded tool's complete arguments are sent to TypeSafe when enabled,
hosts must show their privacy notice and explicitly set `enabled: true`. This
repository is a minimal integration: loop guard, `tools/post-execute`, tool
pruner, `jev_stats`, skill router, and result shaper remain outside its scope.

The capability endpoint does not issue an eager external health request. Before
the first call, `available` means credentials are configured; after a call it
also reflects the latest observed upstream result. This keeps attach/reconnect
probing safe and avoids charging or blocking a host merely because it inspected
capabilities.

## Endpoints

All endpoints are under the authenticated DSH Connection `/api` channel.

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| GET | `/api/dsh-jev/capabilities` | optional query | version, compatibility, mounted endpoint, Jev availability |
| GET | `/api/dsh-jev/config?workspaceId=...&sessionId=...` | workspace required | resolved values and source |
| POST | `/api/dsh-jev/config` | JSON body | `scope` is `global`, `workspace`, `session`, or `next-turn` |
| GET | `/api/dsh-jev/state?workspaceId=...&sessionId=...` | workspace required | desired/effective/available/executing state |
| GET | `/api/dsh-jev/stats?workspaceId=...&sessionId=...` | workspace required | persisted measurable counters |
| POST | `/api/dsh-jev/stats/reset` | JSON/query | resets only the selected workspace/session scope |
| GET | `/api/dsh-jev/events?workspaceId=...&sessionId=...` | workspace required | SSE initial state plus state/config/stats changes |

`POST /config` uses `{workspaceId, sessionId?, scope, patch}`. The
`sessionId` field is required for `session` and `next-turn` scopes. The exact
Fetch registry currently supported by DSH accepts GET/HEAD/POST, so this is a
POST update rather than an invented PUT/RPC transport.

Stable error codes are `DJE-0001 INVALID_REQUEST`, `DJE-0002
WORKSPACE_REQUIRED`, `DJE-0003 SESSION_REQUIRED`, `DJE-0004 UNSUPPORTED_SCOPE`,
`DJE-0005 INTEGRATION_UNAVAILABLE`, `DJE-0006 RUNTIME_INCOMPATIBLE`,
`DJE-0007 JEV_UNAVAILABLE`, `DJE-0008 JEV_TIMEOUT`, `DJE-0009 JEV_CANCELLED`,
`DJE-0010 CONFIG_PERSISTENCE_FAILED`, and `DJE-0011
STATS_PERSISTENCE_FAILED`. Error responses include `retryable`; no endpoint
performs an unbounded retry.

## Jev call and failure semantics

The Runtime follows the actual local `dsh-jev` 0.2.0 client contract: one POST
to the configured System One URL, JSON fields `model`, `state` (stringified
when an object), and `questions`; questions use the real `noul` and `score`
forms; answers are read from `answers`, `results`, or the response object and
normalized using the real `noul`/`probability` fields. API credentials are read
from `TYPESAFE_API_KEY` or the existing `$HOME/.dsh/.env` convention. The key
is not returned or persisted.

Jev is an optional advisory layer. A timeout, cancellation, missing key,
network/HTTP error, or malformed answer is counted and exposed, then the DSH
tool continues (`allow`/fail-open). A valid hazard result can return `ask` or
`deny` using the configured thresholds; the DSH host owns how a headless
session handles `ask`. DSH's own permission/safety checks remain authoritative.

Stats count only measured calls, bytes, durations, outcomes, decisions and
active calls. There is no estimated cost field and reset affects only the
selected scope.
