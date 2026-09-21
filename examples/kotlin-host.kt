import ai.deepseek.dsh.jev.CapabilitiesResponse
import ai.deepseek.dsh.jev.ConfigUpdateRequest
import ai.deepseek.dsh.jev.IntegrationConfigPatch
import ai.deepseek.dsh.jev.JevIntegrationProtocol
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.contentType
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import kotlinx.serialization.Serializable

@Serializable
data class SuccessEnvelope<T>(val ok: Boolean, val data: T)

suspend fun probeAndSetNextTurn(client: HttpClient, baseUrl: String, workspaceId: String) {
    val capabilities = client.get("$baseUrl${JevIntegrationProtocol.capabilitiesPath}")
        .body<SuccessEnvelope<CapabilitiesResponse>>().data
    check(capabilities.protocolVersion == JevIntegrationProtocol.protocolVersion)
    check(capabilities.pluginMounted && capabilities.capabilities.stateEvents)

    client.post("$baseUrl${JevIntegrationProtocol.configPath}") {
        contentType(ContentType.Application.Json)
        setBody(ConfigUpdateRequest(
            workspaceId = workspaceId,
            scope = "next-turn",
            patch = IntegrationConfigPatch(enabled = true),
        ))
    }
}
