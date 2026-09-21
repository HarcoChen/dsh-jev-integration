# dsh-jev-integration

`dsh-jev-integration` is the shared Jev Runtime integration layer for DSH-IDE
and DSH-IntelliJ. Both hosts can pin a commit under `vendor/dsh-jev-integration`
and talk to the same Runtime plugin. This repository contains no VS Code or
IntelliJ UI and no IDE SDK dependency.

The implementation is based on the local DSH sources in
`../dsh-ide/deepseek-harness` (Connection exact Fetch routes,
`tools/pre-execute`, `session/event`, and workspace resolution) and the local
Jev source checkout `/tmp/dsh-jev-research` at commit `b672902` (dsh-jev
0.2.0). The Jev request is a real TypeSafe System One HTTP request; no fake SDK
or globally installed Jev plugin is required.

## Responsibilities and layout

The Runtime plugin registers the Jev advisory hook, manages configuration,
state, statistics and SSE subscriptions, and exposes authenticated DSH
Connection endpoints. Hosts own settings UI, Composer/session presentation,
their Runtime process, and attach/reconnect lifecycle. A client disconnect
only removes its own event subscription; it never stops a shared Runtime or
Jev service.

```
dsh-jev-integration/
  runtime/       Cordis plugin, Jev HTTP client, hooks, persistence, routes
  protocol/      JSON Schema, TypeScript declarations, Kotlin consumer model
  scripts/       reproducible build and non-test smoke command
  examples/      minimal TypeScript/Kotlin host calls
```

The current protocol is `1.0`, integration version is `0.1.0`, and the tested
DSH Runtime compatibility floor is `0.1.5-rc.2` (the same floor used by the
local dsh-jev package). Release builds report the exact commit through
`DSH_JEV_INTEGRATION_COMMIT`; an unset local build reports `unresolved` rather
than fabricating a hash.

## Build and distribution

From this checkout:

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm smoke
pnpm pack:check
```

`npm` can be used equivalently. `dist/` is the reproducible package output:

- `dist/runtime/src/index.js` and declarations: Runtime entry point;
- `dist/runtime/cordis.patch.yml`: copied DSH bundle patch;
- `dist/protocol/src/`: TypeScript protocol consumer;
- `dist/protocol/schema/`: packaged JSON Schema.

The published/tarball files also include the Kotlin model and notices. No Jev
binary, platform resource, model weights, or IDE plugin is bundled. Supply
`TYPESAFE_API_KEY` in the Runtime environment, or use the existing
`$HOME/.dsh/.env` convention. The secret is never written to
`config.json`/`stats.json`.

## Mounting and reuse

For a Runtime owned by an IDE, build this package and install it into the DSH
profile that the IDE starts:

```sh
dsh plugin --profile <profile-name> add /absolute/path/dsh-jev-integration
```

The package manifest points DSH at `runtime/cordis.patch.yml`; restart only a
Runtime that the host owns. An existing/remote Runtime must first be probed:

```text
GET <runtime-base>/api/dsh-jev/capabilities
```

The host compares `integrationVersion`, `integrationCommit`, `protocolVersion`,
`runtimeCompatibility`, and required capability flags on every attach and
reconnect. Missing or incompatible integration returns a visible unavailable
result. This package does not assume that a foreign Runtime supports dynamic
mounting and never restarts or rewrites one it does not own. A Runtime reload
or plugin re-mount is idempotent: the service name, hooks, exact routes, and
subscriptions are registered once per Runtime scope.

For a remote Runtime, use the same authenticated HTTPS paths through the DSH
Connection base URL. The host does not install a Jev IDE plugin; only the
Runtime needs the package and an API key.

## Configuration and state

The complete precedence and protocol contract are in
[`protocol/README.md`](protocol/README.md). In brief, defaults and the Runtime
startup patch are followed by persisted global/workspace values, then
in-memory session and one-shot next-turn overrides. Only global/workspace
values persist under `$DSH_HOME/jev-integration/`. `workspaceId` always means a
DSH Workspace resolved from `session.header.cwd`, never an IDE project path.

The state response intentionally separates:

- `userRequested.enabled`: what the highest-priority caller asked for;
- `effective.enabled`/`effective.values`: the resolved Runtime configuration;
- `available` and `availabilityReason`: whether Jev can currently be used;
- `executing` and `activeRequests`: calls currently in flight.

With the default `enabled=true` and no API key, DSH continues normally and the
state reports `available=false`/`missing-api-key`. The hook uses the actual
Jev System One question shapes. Jev timeout defaults to the source-compatible
800 ms advisory budget in the hook, while the client default remains 2000 ms.
No infinite retry is performed.

## Minimal host calls

TypeScript (the host already owns authentication and the Runtime base URL):

```ts
import type { CapabilitiesResponse, ConfigUpdateRequest } from 'dsh-jev-integration/protocol'

const base = runtimeBaseUrl
const capabilities = await fetch(`${base}/api/dsh-jev/capabilities`).then(r => r.json()) as {
  ok: true; data: CapabilitiesResponse
}
if (capabilities.data.protocolVersion !== '1.0' || !capabilities.data.pluginMounted) {
  throw new Error('DSH Jev integration is missing or incompatible')
}

const update: ConfigUpdateRequest = {
  workspaceId: dshWorkspaceId,
  scope: 'next-turn',
  patch: { enabled: true },
}
await fetch(`${base}/api/dsh-jev/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(update),
})

const events = new EventSource(`${base}/api/dsh-jev/events?workspaceId=${encodeURIComponent(dshWorkspaceId)}`)
events.onmessage = event => renderRuntimeState(JSON.parse(event.data))
```

Kotlin consumers can use the included `JevIntegrationProtocol.kt` with
`kotlinx.serialization` and an HTTP client. The same request shape is:

```kotlin
val capabilities: CapabilitiesResponse = client.get(
    "$base/api/dsh-jev/capabilities"
).body<SuccessEnvelope<CapabilitiesResponse>>().data
check(capabilities.protocolVersion == JevIntegrationProtocol.protocolVersion)

client.post("$base/api/dsh-jev/config") {
    contentType(ContentType.Application.Json)
    setBody(ConfigUpdateRequest(workspaceId, scope = "next-turn",
        patch = IntegrationConfigPatch(enabled = true)))
}
```

The Kotlin model intentionally has no IntelliJ dependency; the host chooses its
HTTP/auth stack.

## Validation and known limits

Validated in this checkout:

- TypeScript strict typecheck with the DSH workspace TypeScript 5.9.3 compiler;
- reproducible `node scripts/build.mjs` output;
- non-unit smoke command mounting a fake Connection and exercising capabilities,
  config POST, state and SSE;
- DSH source inspection against exact route/hook/workspace contracts.

Not claimed as verified here: a live TypeSafe request (no real API key was
used), a full DSH process boot with this new package, remote authentication,
and Kotlin compilation (the environment has no `kotlinc`; the model targets
`kotlinx.serialization`). These are the remaining integration checks for host
repositories. This task intentionally adds no unit tests and does not modify
DSH-IDE, DSH-IntelliJ, global DSH configuration, or real user sessions.

Please review the protocol precedence, headless `ask` handling, and whether the
default `enabled=true` matches each host's settings UX before pinning this
commit. Hosts should pin the commit reported with the final delivery.
