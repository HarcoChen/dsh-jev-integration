package ai.deepseek.dsh.jev

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/** Wire constants shared with the JSON Schema and TypeScript declarations. */
object JevIntegrationProtocol {
    const val integrationVersion: String = "0.1.0"
    const val protocolVersion: String = "1.1"
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
    STARTUP("startup"),
    GLOBAL("global"),
    WORKSPACE("workspace"),
    SESSION("session"),
    NEXT_TURN("next-turn"),
}

@Serializable
data class LoopGuardConfig(
    val enabled: Boolean = false,
    val triggerThreshold: Int = 2,
    val noProgressThreshold: Double = 0.3,
    val pLoopThreshold: Double = 0.6,
    val minConfidence: Double = 0.5,
    val cooldownSteps: Int = 3,
    val maxHistory: Int = 8,
    val deferExactRepeats: Boolean = true,
    val requestTimeoutMs: Int = 3500,
    val include: List<String> = emptyList(),
    val exclude: List<String> = emptyList(),
)

@Serializable
data class ResultShaperConfig(
    val enabled: Boolean = false,
    val shapeTools: List<String> = listOf("bash", "pwsh", "terminal", "run_command", "execute_command"),
    val thresholdChars: Int = 8000,
    val maxPerTurn: Int = 2,
    val keepKinds: List<String> = listOf("warning", "failure"),
    val minKindConfidence: Double = 0.6,
    val maxClusters: Int = 24,
    val sampleChars: Int = 400,
    val requestTimeoutMs: Int = 4000,
)

@Serializable
data class DoneGateConfig(
    val enabled: Boolean = false,
    val blockThreshold: Double = 0.75,
    val minEvidenceItems: Int = 1,
    val requestTimeoutMs: Int = 3500,
    val maxClaimChars: Int = 4000,
    val cooldownTurns: Int = 1,
)

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
    val loopGuard: LoopGuardConfig = LoopGuardConfig(),
    val resultShaper: ResultShaperConfig = ResultShaperConfig(),
    val doneGate: DoneGateConfig = DoneGateConfig(),
)

@Serializable
data class LoopGuardConfigPatch(
    val enabled: Boolean? = null,
    val triggerThreshold: Int? = null,
    val noProgressThreshold: Double? = null,
    val pLoopThreshold: Double? = null,
    val minConfidence: Double? = null,
    val cooldownSteps: Int? = null,
    val maxHistory: Int? = null,
    val deferExactRepeats: Boolean? = null,
    val requestTimeoutMs: Int? = null,
    val include: List<String>? = null,
    val exclude: List<String>? = null,
)

@Serializable
data class ResultShaperConfigPatch(
    val enabled: Boolean? = null,
    val shapeTools: List<String>? = null,
    val thresholdChars: Int? = null,
    val maxPerTurn: Int? = null,
    val keepKinds: List<String>? = null,
    val minKindConfidence: Double? = null,
    val maxClusters: Int? = null,
    val sampleChars: Int? = null,
    val requestTimeoutMs: Int? = null,
)

@Serializable
data class DoneGateConfigPatch(
    val enabled: Boolean? = null,
    val blockThreshold: Double? = null,
    val minEvidenceItems: Int? = null,
    val requestTimeoutMs: Int? = null,
    val maxClaimChars: Int? = null,
    val cooldownTurns: Int? = null,
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
    val loopGuard: LoopGuardConfigPatch? = null,
    val resultShaper: ResultShaperConfigPatch? = null,
    val doneGate: DoneGateConfigPatch? = null,
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
    val loopGuardChecks: Long = 0,
    val loopGuardWarnings: Long = 0,
    val loopGuardInterruptions: Long = 0,
    val loopGuardUncertain: Long = 0,
    val doneGateChecks: Long = 0,
    val doneGateInterventions: Long = 0,
    val doneGateUncertain: Long = 0,
    val resultShaperCalls: Long = 0,
    val resultShaperCharsRemoved: Long = 0,
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
    val postExecuteHook: Boolean = false,
    val loopGuard: Boolean = false,
    val resultShaper: Boolean = false,
    val doneEvidenceGate: Boolean = false,
    val turnStoppingHook: Boolean = false,
    val nextTurnOverride: Boolean = false,
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
