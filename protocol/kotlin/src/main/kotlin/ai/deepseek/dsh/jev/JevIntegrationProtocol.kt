package ai.deepseek.dsh.jev

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Wire constants shared with the JSON Schema and TypeScript declarations. */
object JevIntegrationProtocol {
    const val integrationVersion: String = "0.1.0"
    const val protocolVersion: String = "1.0"
    const val minimumDshRuntime: String = "0.1.5-rc.1"
    const val capabilitiesPath: String = "/api/dsh-jev/capabilities"
    const val configPath: String = "/api/dsh-jev/config"
    const val statePath: String = "/api/dsh-jev/state"
    const val statsPath: String = "/api/dsh-jev/stats"
    const val statsResetPath: String = "/api/dsh-jev/stats/reset"
    const val eventsPath: String = "/api/dsh-jev/events"
}

enum class ConfigScope(val wireValue: String) {
    GLOBAL("global"),
    WORKSPACE("workspace"),
    SESSION("session"),
    NEXT_TURN("next-turn"),
}

enum class ConfigSource(val wireValue: String) {
    DEFAULT("default"),
    GLOBAL("global"),
    WORKSPACE("workspace"),
    SESSION("session"),
    NEXT_TURN("next-turn"),
}

@Serializable
data class IntegrationConfig(
    val enabled: Boolean = false,
    val baseUrl: String = "https://api.typesafe.ai/v1/systemone",
    val model: String = "jev-latest",
    val timeoutMs: Int = 2000,
    val advisoryTimeoutMs: Int = 3500,
    val askThreshold: Double = 0.5,
    val blockThreshold: Double = 0.85,
    val guardedTools: List<String> = listOf(
        "bash", "pwsh", "terminal", "run_command", "execute_command",
        "run_code", "write_to_file", "replace_file_content",
    ),
)

@Serializable
data class IntegrationConfigPatch(
    val enabled: Boolean? = null,
    val baseUrl: String? = null,
    val model: String? = null,
    val timeoutMs: Int? = null,
    val advisoryTimeoutMs: Int? = null,
    val askThreshold: Double? = null,
    val blockThreshold: Double? = null,
    val guardedTools: List<String>? = null,
)

@Serializable
data class EffectiveConfig(
    val enabled: Boolean,
    val active: Boolean,
    val values: IntegrationConfig,
    val source: String,
)

@Serializable
data class UserRequestedConfig(
    val enabled: Boolean,
    val source: String,
)

@Serializable
data class RuntimeState(
    val workspaceId: String,
    val sessionId: String? = null,
    val userRequested: UserRequestedConfig,
    val effective: EffectiveConfig,
    val available: Boolean,
    val availabilityReason: String? = null,
    val executing: Boolean,
    val activeRequests: Int,
    val lastDecision: String? = null,
    val lastErrorCode: String? = null,
    val lastErrorMessage: String? = null,
    val updatedAt: String,
)

@Serializable
data class StatisticsSnapshot(
    val workspaceId: String,
    val sessionId: String? = null,
    val since: String,
    val resetAt: String,
    val totalCalls: Long,
    val successfulCalls: Long,
    val failedCalls: Long,
    val timeoutCalls: Long,
    val cancelledCalls: Long,
    val skippedCalls: Long,
    val allowDecisions: Long,
    val askDecisions: Long,
    val denyDecisions: Long,
    val totalLatencyMs: Double,
    val maxLatencyMs: Double,
    val totalRequestBytes: Long,
    val totalResponseBytes: Long,
    val activeCalls: Long,
)

@Serializable
data class RuntimeCompatibility(
    val minimumDshRuntime: String,
    val testedDshRuntime: String,
    val requiredFeatures: List<String>,
)

@Serializable
data class JevAvailability(
    val baseUrl: String,
    val model: String,
    val available: Boolean,
    val reason: String? = null,
)

@Serializable
data class CapabilityFlags(
    val configRead: Boolean,
    val configWrite: Boolean,
    val stateRead: Boolean,
    val statsRead: Boolean,
    val statsReset: Boolean,
    val stateEvents: Boolean,
    val preExecuteHook: Boolean,
    val nextTurnOverride: Boolean,
)

@Serializable
data class CapabilitiesResponse(
    val integrationVersion: String,
    val integrationCommit: String,
    val protocolVersion: String,
    val runtimeCompatibility: RuntimeCompatibility,
    val pluginMounted: Boolean,
    val endpointAvailable: Boolean,
    val endpointReason: String? = null,
    val capabilities: CapabilityFlags,
    val jev: JevAvailability,
)

@Serializable
data class ConfigUpdateRequest(
    val workspaceId: String,
    val sessionId: String? = null,
    val scope: String,
    val patch: IntegrationConfigPatch,
)

@Serializable
data class ConfigResponse(
    val workspaceId: String,
    val sessionId: String? = null,
    val persisted: Boolean,
    val scope: String,
    val source: String,
    val values: IntegrationConfig,
)

@Serializable
data class ProtocolError(
    val code: String,
    val name: String,
    val message: String,
    val details: Map<String, JsonElement>? = null,
    val retryable: Boolean,
)

@Serializable
data class ErrorEnvelope(
    val ok: Boolean = false,
    val error: ProtocolError,
)

@Serializable
data class StateEvent(
    val id: String,
    val type: String,
    val at: String,
    val workspaceId: String,
    val sessionId: String? = null,
    val state: RuntimeState? = null,
    val stats: StatisticsSnapshot? = null,
)

object JevErrorCodes {
    const val INVALID_REQUEST = "DJE-0001"
    const val WORKSPACE_REQUIRED = "DJE-0002"
    const val SESSION_REQUIRED = "DJE-0003"
    const val UNSUPPORTED_SCOPE = "DJE-0004"
    const val INTEGRATION_UNAVAILABLE = "DJE-0005"
    const val RUNTIME_INCOMPATIBLE = "DJE-0006"
    const val JEV_UNAVAILABLE = "DJE-0007"
    const val JEV_TIMEOUT = "DJE-0008"
    const val JEV_CANCELLED = "DJE-0009"
    const val CONFIG_PERSISTENCE_FAILED = "DJE-0010"
    const val STATS_PERSISTENCE_FAILED = "DJE-0011"
}
