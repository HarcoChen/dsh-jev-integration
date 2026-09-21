import type { CapabilitiesResponse, ConfigUpdateRequest, RuntimeState } from '../protocol/src/index.js'

export async function attachJevRuntime(runtimeBaseUrl: string, workspaceId: string): Promise<() => void> {
  const capabilitiesResponse = await fetch(`${runtimeBaseUrl}/api/dsh-jev/capabilities`)
  const envelope = await capabilitiesResponse.json() as { ok: boolean; data?: CapabilitiesResponse; error?: unknown }
  if (!capabilitiesResponse.ok || !envelope.ok || !envelope.data) throw new Error(`Jev integration probe failed: ${JSON.stringify(envelope.error)}`)
  if (envelope.data.protocolVersion !== '1.1' || !envelope.data.pluginMounted || !envelope.data.capabilities.stateEvents) {
    throw new Error(`Incompatible dsh-jev-integration ${envelope.data.integrationVersion}/${envelope.data.integrationCommit}`)
  }
  const events = new EventSource(`${runtimeBaseUrl}/api/dsh-jev/events?workspaceId=${encodeURIComponent(workspaceId)}`)
  events.onmessage = event => {
    const value = JSON.parse(event.data) as { state?: RuntimeState }
    if (value.state) renderState(value.state)
  }
  return () => events.close()
}

export async function setNextTurn(runtimeBaseUrl: string, workspaceId: string, enabled: boolean): Promise<void> {
  const request: ConfigUpdateRequest = { workspaceId, scope: 'next-turn', patch: { enabled } }
  const response = await fetch(`${runtimeBaseUrl}/api/dsh-jev/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw new Error(await response.text())
}

function renderState(_state: RuntimeState): void {
  // Host UI owns rendering; this example intentionally has no IDE dependency.
}
