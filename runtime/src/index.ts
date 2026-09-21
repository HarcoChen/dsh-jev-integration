/** Shared DSH Runtime integration layer for the Jev System One service. */

export { apply, createIntegration, JevIntegration } from './integration.js'
export {
  JevClient,
  JevClientError,
  choice,
  noul,
  noulProbability,
  score,
  scoreConfidence,
  topBucketProbability,
} from './jev-client.js'
export { DoneEvidencePolicy, looksLikeCompletionClaim } from './policies/done-gate.js'
export { LoopGuardPolicy, evaluateStuckTrajectory } from './policies/loop-guard.js'
export { ResultShaperPolicy, clusterLines, extractText, looksRepetitive, replaceText } from './policies/result-shaper.js'
export { VERSION } from './version.js'
export const name = 'dsh-jev-integration'
export const inject: string[] = []
export type {
  ConnectionLike,
  CordisContextLike,
  PreToolDecisionLike,
  PostToolDecisionLike,
  PostToolNext,
  RuntimePluginOptions,
  ToolResultLike,
  ToolExecutionLike,
} from './types.js'
