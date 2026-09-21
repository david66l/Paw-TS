/** The journal's fact union, its per-fact aliases, and the envelope around it. */
import type { EnvironmentAuditEvidenceV1 } from "../environment-audit.js";
import type { DurableJsonPayloadV1, JsonValue } from "./primitives.js";
import type {
  COMPLETION_REVIEW_POLICY_VERSION_V1,
  MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1,
  MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
  MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
  MEMORY_RETRIEVAL_POLICY_VERSION_V1,
  MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
  MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1,
  MEMORY_WRITE_POLICY_VERSION_V1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  WORK_SEGMENT_POLICY_VERSION_V1,
} from "./versions.js";
import type {
  CompletionReviewTriggerV1,
  CompletionReviewVerdictV1,
} from "./wire-completion-review.js";
import type {
  MemoryAtomProposalV1,
  MemoryCardV1,
  MemoryEvidenceCoverageItemV1,
  MemoryEvidenceRequirementV1,
  MemoryPersonaClaimV1,
  MemoryRawEvidenceSpanV1,
  MemoryTopicEvidenceStateV1,
  MemoryTopicIndexEntryV1,
  MemoryTopicProposalV1,
} from "./wire-memory.js";
import type { InputAttachmentV1, ModelSettlementStatusV1 } from "./wire-model-response.js";
import type { TaskCheckpointDistillationStatusV1 } from "./wire-task-checkpoint.js";
import type { ToolObservationV1, ToolSettlementStatusV1 } from "./wire-tool.js";

/** Objective observations that may be supplied to the control reducer. */
export type InputFactV1 =
  | Readonly<{
      /** Host clock sample for an explicitly bounded user-work item. Never model input authority. */
      type: "execution.budget_observed";
      inputId: string;
      deadlineAtMs: number;
      observedAtMs: number;
      reserveMs: number;
      admissionPolicy?: "recent_round_floor_v1";
    }>
  | Readonly<{
      type: "attempt.started";
      goalHash: string;
      configHash: string;
    }>
  | Readonly<{
      /** Durable inbox admission. It is audit state, not model-visible input. */
      type: "input.accepted";
      inputId: string;
      delivery: "steer" | "queue";
      content: string;
      contentHash: string;
      callerId: string;
      attachments?: readonly InputAttachmentV1[];
    }>
  | Readonly<{
      type: "input.promoted";
      inputId: string;
      delivery: "initial" | "steer" | "queue";
      content: string;
      contentHash: string;
      attachments?: readonly InputAttachmentV1[];
    }>
  | Readonly<{
      /** Starts another user-work segment inside the same authoritative run. */
      type: "work.segment_started";
      /** The bootstrap segment is implicit index 0; persisted segments start at 1. */
      segmentIndex: number;
      inputId: string;
      reducerVersion: string;
      previousDecisionStateHash: string;
      previousAction: ControlDecisionActionV1;
      policyVersion: typeof WORK_SEGMENT_POLICY_VERSION_V1;
    }>
  | Readonly<{
      /** Exact memory evidence available to Context for one query identity. */
      type: "memory.retrieval_settled";
      queryId: string;
      trigger: "task_start" | "work_segment_start";
      providerVersion: string;
      policyVersion: typeof MEMORY_RETRIEVAL_POLICY_VERSION_V1;
      status: "completed" | "degraded" | "failed" | "disabled";
      cards: readonly MemoryCardV1[];
      reasonCode?: string;
    }>
  | Readonly<{
      /** Durable at-most-once claim made before any memory extraction model call. */
      type: "memory.write_claimed";
      writeId: string;
      trigger: "task_terminal" | "work_segment_terminal" | "explicit_user_request";
      policyVersion: typeof MEMORY_WRITE_POLICY_VERSION_V1;
      extractorVersion: string;
      scopeFingerprint: string;
      sourceFromSeq: number;
      sourceThroughSeq: number;
      sourceInputHash: string;
      claimedAt: number;
    }>
  | Readonly<{
      /** Bounded, schema-validated proposal persisted before store mutation. */
      type: "memory.candidate_staged";
      writeId: string;
      proposalHash: string;
      atoms: readonly MemoryAtomProposalV1[];
    }>
  | Readonly<{
      /** Terminal observation for one write claim; contains identifiers, never raw prompts. */
      type: "memory.write_settled";
      writeId: string;
      status: "completed" | "noop" | "failed" | "interrupted";
      proposalHash?: string;
      storedIds: readonly string[];
      invalidatedIds: readonly string[];
      skippedAtomIds: readonly string[];
      reasonCode?: string;
      settledAt: number;
    }>
  | Readonly<{
      /** At-most-once claim before a topic-organization model call. */
      type: "memory.topic_organization_claimed";
      organizationId: string;
      policyVersion: typeof MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1;
      extractorVersion: string;
      scopeFingerprint: string;
      sourceWriteId: string;
      sourceProposalHash: string;
      sourceMemoryIds: readonly string[];
      sourceRevision: string;
      claimedAt: number;
    }>
  | Readonly<{
      /** Validated topic proposals persisted before any projection mutation. */
      type: "memory.topic_candidate_staged";
      organizationId: string;
      proposalHash: string;
      topics: readonly MemoryTopicProposalV1[];
    }>
  | Readonly<{
      /** Content-free settlement for one topic organization claim. */
      type: "memory.topic_organization_settled";
      organizationId: string;
      status: "completed" | "noop" | "failed" | "interrupted";
      proposalHash?: string;
      topicIds: readonly string[];
      snapshotIds: readonly string[];
      reasonCode?: string;
      settledAt: number;
    }>
  | Readonly<{
      /** Query-bound, deterministic topic index and trajectory evidence plan. */
      type: "memory.topic_evidence_settled";
      queryId: string;
      plannerVersion: typeof MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1;
      scopeFingerprint: string;
      status: "completed" | "noop" | "failed";
      indexRevision: string;
      indexEntries: readonly MemoryTopicIndexEntryV1[];
      evidenceStates: readonly MemoryTopicEvidenceStateV1[];
      reasonCode?: string;
      settledAt: number;
    }>
  | Readonly<{
      /** Query-bound receipt for a deterministic, query-independent L3 projection. */
      type: "memory.persona_projection_settled";
      queryId: string;
      projectorVersion: typeof MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1;
      scopeFingerprint: string;
      status: "completed" | "noop" | "failed";
      projectionRevision: string;
      projectionKey: string;
      claims: readonly MemoryPersonaClaimV1[];
      sourceCount: number;
      reasonCode?: string;
      settledAt: number;
    }>
  | Readonly<{
      /** Bounded L0 source text resolved only from already-selected evidence refs. */
      type: "memory.raw_evidence_settled";
      queryId: string;
      resolverVersion: typeof MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1;
      scopeFingerprint: string;
      status: "completed" | "noop" | "failed";
      resolutionRevision: string;
      spans: readonly MemoryRawEvidenceSpanV1[];
      reasonCode?: string;
      settledAt: number;
    }>
  | Readonly<{
      /** Query-bound requirements, coverage, and bounded gap expansion. */
      type: "memory.evidence_coverage_settled";
      queryId: string;
      plannerVersion: typeof MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1;
      scopeFingerprint: string;
      status: "completed" | "noop" | "failed";
      planRevision: string;
      requirements: readonly MemoryEvidenceRequirementV1[];
      coverage: readonly MemoryEvidenceCoverageItemV1[];
      supplementalStates: readonly MemoryTopicEvidenceStateV1[];
      spans: readonly MemoryRawEvidenceSpanV1[];
      reasonCode?: string;
      settledAt: number;
    }>
  | Readonly<{
      type: "model.dispatch_recorded";
      modelCallId: string;
      /** Strictly increases across the run; AgentLoop additionally requires N+1. */
      turn: number;
      requestHash: string;
    }>
  | Readonly<{
      type: "model.settled";
      modelCallId: string;
      turn: number;
      status: ModelSettlementStatusV1;
      hasToolCalls: boolean;
      hasVisibleOutput: boolean;
      response?: DurableJsonPayloadV1;
      finishReason?: string;
      errorCode?: string;
    }>
  | Readonly<{
      type: "tool.call_observed";
      callId: string;
      modelCallId: string;
      turn: number;
      tool: string;
      args: JsonValue;
      /** Zero-based position in the provider's native tool-call array. */
      order: number;
    }>
  | Readonly<{
      type: "tool.dispatch_recorded";
      callId: string;
      turn: number;
      /** Must equal the observed call's zero-based order. */
      sourceIndex: number;
      batchId: string;
      mode: "serial" | "parallel";
    }>
  | Readonly<{
      type: "tool.permission_resolved";
      turn: number;
      sourceIndex: number;
      callId: string;
      tool: string;
      policyVersion: string;
      resolution: "allow_once" | "allow_rule" | "deny";
      source: "base_policy" | "user_prompt" | "run_rule";
      ruleId?: string;
    }>
  | Readonly<{
      type: "tool.effect_checkpoint_allocated";
      callId: string;
      turn: number;
      sourceIndex: number;
      checkpointSeq: number;
    }>
  | Readonly<{
      type: "tool.settled";
      callId: string;
      status: ToolSettlementStatusV1;
      result?: JsonValue;
      resultHash?: string;
      errorCode?: string;
      /** Optional only for read compatibility; new Context requires it. */
      observation?: ToolObservationV1;
    }>
  | Readonly<{
      /** A run-owned asynchronous activity accepted by a Runtime extension. */
      type: "runtime.activity_started";
      activityId: string;
      activityKind: string;
      label: string;
      startedAt: number;
      metadata?: JsonValue;
    }>
  | Readonly<{
      /** Durable terminal observation for a previously started activity. */
      type: "runtime.activity_settled";
      /** Optional host-owned result; never model-authored activity metadata. */
      result?: JsonValue;
      activityId: string;
      status: "completed" | "failed" | "cancelled" | "unknown";
      settledAt: number;
      summary: string;
    }>
  | Readonly<{
      type: "abort.requested";
      source: "user" | "host" | "signal";
      reason?: string;
    }>
  | Readonly<{
      type: "runtime.failed";
      area: "input" | "context" | "runtime";
      errorCode: string;
      message: string;
      retryable: boolean;
    }>
  | Readonly<{
      type: "policy.request_recorded";
      policyId: string;
      policyVersion: string;
      request: "continue" | "wait" | "complete" | "incomplete";
      reasonCode: string;
    }>
  | Readonly<{
      /** Durable identity for one candidate-bound completion review. */
      type: "completion.review_claimed";
      reviewId: string;
      candidateHash: string;
      policyVersion: typeof COMPLETION_REVIEW_POLICY_VERSION_V1;
      reviewerId: string;
      triggers: readonly CompletionReviewTriggerV1[];
      sourceThroughSeq: number;
      claimedAt: number;
    }>
  | Readonly<{
      /** Terminal observation for one completion review claim. */
      type: "completion.review_settled";
      environmentAudit?: EnvironmentAuditEvidenceV1;
      reviewId: string;
      status: "completed" | "failed" | "cancelled" | "unknown";
      verdict: CompletionReviewVerdictV1;
      reasonCode: string;
      summary: string;
      settledAt: number;
    }>
  | Readonly<{
      type: "context.checkpoint_distillation_claimed";
      claimId: string;
      checkpointId: string;
      boundary: "after_model_turn_without_tool_calls" | "after_tool_batch_settled";
      supersedesCheckpointId?: string;
      policyVersion: string;
      sourceFromSeq: number;
      sourceThroughSeq: number;
      sourceInputHash: string;
    }>
  | Readonly<{
      type: "context.checkpoint_distillation_settled";
      claimId: string;
      status: TaskCheckpointDistillationStatusV1;
      checkpoint?: DurableJsonPayloadV1;
      errorCode?: string;
    }>
  | Readonly<{
      type: "context.checkpoint_recorded";
      checkpointId: string;
      distillationClaimId?: string;
      supersedesCheckpointId?: string;
      policyVersion: string;
      sourceFromSeq: number;
      sourceThroughSeq: number;
      /** Hash of sequenced input facts inside the covered source range. */
      sourceInputHash: string;
      checkpoint: DurableJsonPayloadV1;
    }>;

export type AttemptStartedFactV1 = Extract<InputFactV1, { type: "attempt.started" }>;

export type InputAcceptedFactV1 = Extract<InputFactV1, { type: "input.accepted" }>;

export type InputPromotedFactV1 = Extract<InputFactV1, { type: "input.promoted" }>;

export type WorkSegmentStartedFactV1 = Extract<InputFactV1, { type: "work.segment_started" }>;

export type MemoryRetrievalSettledFactV1 = Extract<
  InputFactV1,
  { type: "memory.retrieval_settled" }
>;

export type MemoryWriteClaimedFactV1 = Extract<InputFactV1, { type: "memory.write_claimed" }>;

export type MemoryCandidateStagedFactV1 = Extract<InputFactV1, { type: "memory.candidate_staged" }>;

export type MemoryWriteSettledFactV1 = Extract<InputFactV1, { type: "memory.write_settled" }>;

export type MemoryTopicOrganizationClaimedFactV1 = Extract<
  InputFactV1,
  { type: "memory.topic_organization_claimed" }
>;

export type MemoryTopicCandidateStagedFactV1 = Extract<
  InputFactV1,
  { type: "memory.topic_candidate_staged" }
>;

export type MemoryTopicOrganizationSettledFactV1 = Extract<
  InputFactV1,
  { type: "memory.topic_organization_settled" }
>;

export type MemoryTopicEvidenceSettledFactV1 = Extract<
  InputFactV1,
  { type: "memory.topic_evidence_settled" }
>;

export type MemoryPersonaProjectionSettledFactV1 = Extract<
  InputFactV1,
  { type: "memory.persona_projection_settled" }
>;

export type MemoryRawEvidenceSettledFactV1 = Extract<
  InputFactV1,
  { type: "memory.raw_evidence_settled" }
>;

export type MemoryEvidenceCoverageSettledFactV1 = Extract<
  InputFactV1,
  { type: "memory.evidence_coverage_settled" }
>;

export type ModelDispatchRecordedFactV1 = Extract<InputFactV1, { type: "model.dispatch_recorded" }>;

export type ModelSettledFactV1 = Extract<InputFactV1, { type: "model.settled" }>;

export type ToolCallObservedFactV1 = Extract<InputFactV1, { type: "tool.call_observed" }>;

export type ToolDispatchRecordedFactV1 = Extract<InputFactV1, { type: "tool.dispatch_recorded" }>;

export type ToolPermissionResolvedFactV1 = Extract<
  InputFactV1,
  { type: "tool.permission_resolved" }
>;

export type ToolEffectCheckpointAllocatedFactV1 = Extract<
  InputFactV1,
  { type: "tool.effect_checkpoint_allocated" }
>;

export type ToolSettledFactV1 = Extract<InputFactV1, { type: "tool.settled" }>;

export type RuntimeActivityStartedFactV1 = Extract<
  InputFactV1,
  { type: "runtime.activity_started" }
>;

export type RuntimeActivitySettledFactV1 = Extract<
  InputFactV1,
  { type: "runtime.activity_settled" }
>;

export type AbortRequestedFactV1 = Extract<InputFactV1, { type: "abort.requested" }>;

export type RuntimeFailedFactV1 = Extract<InputFactV1, { type: "runtime.failed" }>;

export type PolicyRequestRecordedFactV1 = Extract<InputFactV1, { type: "policy.request_recorded" }>;

export type CompletionReviewClaimedFactV1 = Extract<
  InputFactV1,
  { type: "completion.review_claimed" }
>;

export type CompletionReviewSettledFactV1 = Extract<
  InputFactV1,
  { type: "completion.review_settled" }
>;

export type ContextCheckpointRecordedFactV1 = Extract<
  InputFactV1,
  { type: "context.checkpoint_recorded" }
>;

export type ContextCheckpointDistillationClaimedFactV1 = Extract<
  InputFactV1,
  { type: "context.checkpoint_distillation_claimed" }
>;

export type ContextCheckpointDistillationSettledFactV1 = Extract<
  InputFactV1,
  { type: "context.checkpoint_distillation_settled" }
>;

export type ControlDecisionActionV1 =
  | Readonly<{ kind: "continue"; reasonCode: string }>
  | Readonly<{
      kind: "wait";
      waitFor: "user" | "external";
      reasonCode: string;
    }>
  | Readonly<{ kind: "complete"; reasonCode: string }>
  | Readonly<{ kind: "incomplete"; reasonCode: string }>
  | Readonly<{ kind: "failed"; reasonCode: string }>
  | Readonly<{ kind: "abort"; reasonCode: string }>;

export type ContinueDecisionActionV1 = Extract<ControlDecisionActionV1, { kind: "continue" }>;

export type WaitDecisionActionV1 = Extract<ControlDecisionActionV1, { kind: "wait" }>;

export type CompleteDecisionActionV1 = Extract<ControlDecisionActionV1, { kind: "complete" }>;

export type IncompleteDecisionActionV1 = Extract<ControlDecisionActionV1, { kind: "incomplete" }>;

export type FailedDecisionActionV1 = Extract<ControlDecisionActionV1, { kind: "failed" }>;

/**
 * 用户决策（2026-08-21）：因崩溃修复产生的 incomplete 终局允许接续新工作
 * 段。范围只限 repair 结算的 unknown 族原因；预算耗尽等其余 incomplete 仍
 * 不可开段（开段也无法推进，应开新 run）。
 */
export const CRASH_RECOVERY_INCOMPLETE_REASONS_V1: ReadonlySet<string> = new Set([
  "model-result-unknown",
  "tool-result-unknown",
]);

export function isCrashRecoveryIncompleteReasonV1(reason: string): boolean {
  return CRASH_RECOVERY_INCOMPLETE_REASONS_V1.has(reason);
}

export function isCrashRecoveryIncompleteActionV1(action: ControlDecisionActionV1): boolean {
  return action.kind === "incomplete" && isCrashRecoveryIncompleteReasonV1(action.reasonCode);
}

export type AbortDecisionActionV1 = Extract<ControlDecisionActionV1, { kind: "abort" }>;

/**
 * A persisted reducer output. It is replay evidence, never a reducer input.
 */
export interface DerivedDecisionV1 {
  readonly type: "control.decided";
  readonly reducerVersion: string;
  readonly inputThroughSeq: number;
  readonly stateHash: string;
  readonly action: ControlDecisionActionV1;
}

export type RunJournalRecordV1 =
  | Readonly<{ kind: "input_fact"; fact: InputFactV1 }>
  | Readonly<{
      kind: "derived_decision";
      decision: DerivedDecisionV1;
    }>;

/** The only durable envelope used by the Paw Next run journal. */
export interface RunJournalEnvelopeV1 {
  readonly schemaVersion: typeof RUN_JOURNAL_SCHEMA_VERSION_V1;
  readonly sessionId: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: number;
  readonly record: RunJournalRecordV1;
}
