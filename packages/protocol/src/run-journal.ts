/**
 * Paw Next's canonical, append-only run journal protocol.
 *
 * This module contains wire values and strict validation only. It deliberately
 * has no storage, reducer, provider, workspace, or UI dependencies.
 *
 * The implementation lives in `./journal/`. This file re-exports the same names it
 * always did -- the split does not widen the surface `@paw/protocol` publishes,
 * even though the internal validators now have to cross module boundaries.
 */
export {
  type InputFactV1,
  type AttemptStartedFactV1,
  type InputAcceptedFactV1,
  type InputPromotedFactV1,
  type WorkSegmentStartedFactV1,
  type MemoryRetrievalSettledFactV1,
  type MemoryWriteClaimedFactV1,
  type MemoryCandidateStagedFactV1,
  type MemoryWriteSettledFactV1,
  type MemoryTopicOrganizationClaimedFactV1,
  type MemoryTopicCandidateStagedFactV1,
  type MemoryTopicOrganizationSettledFactV1,
  type MemoryTopicEvidenceSettledFactV1,
  type MemoryPersonaProjectionSettledFactV1,
  type MemoryRawEvidenceSettledFactV1,
  type MemoryEvidenceCoverageSettledFactV1,
  type ModelDispatchRecordedFactV1,
  type ModelSettledFactV1,
  type ToolCallObservedFactV1,
  type ToolDispatchRecordedFactV1,
  type ToolPermissionResolvedFactV1,
  type ToolEffectCheckpointAllocatedFactV1,
  type ToolSettledFactV1,
  type RuntimeActivityStartedFactV1,
  type RuntimeActivitySettledFactV1,
  type AbortRequestedFactV1,
  type RuntimeFailedFactV1,
  type PolicyRequestRecordedFactV1,
  type CompletionReviewClaimedFactV1,
  type CompletionReviewSettledFactV1,
  type ContextCheckpointRecordedFactV1,
  type ContextCheckpointDistillationClaimedFactV1,
  type ContextCheckpointDistillationSettledFactV1,
  type ControlDecisionActionV1,
  type ContinueDecisionActionV1,
  type WaitDecisionActionV1,
  type CompleteDecisionActionV1,
  type IncompleteDecisionActionV1,
  type FailedDecisionActionV1,
  type AbortDecisionActionV1,
  type DerivedDecisionV1,
  type RunJournalRecordV1,
  type RunJournalEnvelopeV1,
  CRASH_RECOVERY_INCOMPLETE_REASONS_V1,
  isCrashRecoveryIncompleteReasonV1,
  isCrashRecoveryIncompleteActionV1,
} from "./journal/facts.js";
export {
  parseModelResponseV1,
  assertModelResponseV1,
  isModelResponseV1,
  parseToolObservationV1,
  assertToolObservationV1,
  isToolObservationV1,
  parseTaskCheckpointV1,
  assertTaskCheckpointV1,
  isTaskCheckpointV1,
  parseRunJournalEnvelopeV1,
  assertRunJournalEnvelopeV1,
  assertRunJournalEnvelopeCanFollowV1,
  parseRunJournalPrefixV1,
  isRunJournalEnvelopeV1,
} from "./journal/parse.js";
export type {
  JsonPrimitive,
  JsonValue,
  DurableJsonPayloadV1,
} from "./journal/primitives.js";
export {
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  WORK_SEGMENT_POLICY_VERSION_V1,
  MEMORY_RETRIEVAL_POLICY_VERSION_V1,
  MEMORY_WRITE_POLICY_VERSION_V1,
  MEMORY_ATOM_PROPOSAL_SCHEMA_VERSION_V1,
  MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1,
  MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1,
  MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
  MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
  MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
  MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1,
  COMPLETION_REVIEW_POLICY_VERSION_V1,
  MODEL_RESPONSE_SCHEMA_VERSION_V1,
  TOOL_OBSERVATION_SCHEMA_VERSION_V1,
  TASK_CHECKPOINT_SCHEMA_VERSION_V1,
} from "./journal/versions.js";
export type {
  CompletionReviewTriggerV1,
  CompletionReviewVerdictV1,
} from "./journal/wire-completion-review.js";
export type {
  MemorySourceRefV1,
  MemoryCardV1,
  MemoryAtomKindV1,
  MemoryAtomActionV1,
  MemoryAtomProposalV1,
  MemoryTopicFamilyV1,
  MemoryTopicMemberProposalV1,
  MemoryTopicProposalV1,
  MemoryTopicIndexEntryV1,
  MemoryTopicEvidenceStateV1,
  MemoryPersonaClaimV1,
  MemoryRawEvidenceSpanV1,
  MemoryEvidenceRequirementV1,
  MemoryEvidenceCoverageItemV1,
} from "./journal/wire-memory.js";
export type {
  ModelResponseUsageV1,
  ModelResponseToolCallV1,
  ModelResponseV1,
  InputAttachmentV1,
  ModelSettlementStatusV1,
} from "./journal/wire-model-response.js";
export type {
  TaskCheckpointItemV1,
  TaskCheckpointV1,
  TaskCheckpointDistillationStatusV1,
} from "./journal/wire-task-checkpoint.js";
export type {
  ToolObservationV1,
  ToolSettlementStatusV1,
} from "./journal/wire-tool.js";
