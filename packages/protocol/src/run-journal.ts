/**
 * Paw Next's canonical, append-only run journal protocol.
 *
 * This module contains wire values and strict validation only. It deliberately
 * has no storage, reducer, provider, workspace, or UI dependencies.
 */

export const RUN_JOURNAL_SCHEMA_VERSION_V1 = "paw.run-journal.v1" as const;

export const WORK_SEGMENT_POLICY_VERSION_V1 = "paw.work-segment.v1" as const;

export const MEMORY_RETRIEVAL_POLICY_VERSION_V1 =
  "paw.memory-retrieval.v1" as const;

export const MEMORY_WRITE_POLICY_VERSION_V1 = "paw.memory-writer.v1" as const;

export const MEMORY_ATOM_PROPOSAL_SCHEMA_VERSION_V1 =
  "paw.memory-atom-proposal.v1" as const;

export const MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1 =
  "paw.memory-topic-organization.v1" as const;

export const MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1 =
  "paw.memory-topic-proposal.v1" as const;

export const MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1 =
  "paw.memory-topic-evidence-planner.v1" as const;

export const MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1 =
  "paw.memory-persona-evidence-projector.v1" as const;

export const MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1 =
  "paw.memory-raw-evidence-resolver.v1" as const;

export const MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1 =
  "paw.memory-evidence-coverage-planner.v1" as const;

export const COMPLETION_REVIEW_POLICY_VERSION_V1 =
  "paw.completion-review.v1" as const;

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A complete JSON payload, stored inline or by a stable content reference. */
export type DurableJsonPayloadV1 =
  | Readonly<{
      kind: "inline";
      value: JsonValue;
      hash: string;
    }>
  | Readonly<{
      kind: "artifact_ref";
      artifactRef: string;
      hash: string;
    }>;

export const MODEL_RESPONSE_SCHEMA_VERSION_V1 =
  "paw.model-response.v1" as const;

export interface ModelResponseUsageV1 {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly cacheMissPromptTokens?: number;
}

export interface ModelResponseToolCallV1 {
  readonly callId: string;
  readonly name: string;
  readonly rawArguments: string;
  readonly args: Readonly<{ readonly [key: string]: JsonValue }>;
  readonly sourceIndex: number;
  readonly argumentsValid: boolean;
}

/** The one provider-neutral, durable successful/truncated model response DTO. */
export interface ModelResponseV1 {
  readonly schemaVersion: typeof MODEL_RESPONSE_SCHEMA_VERSION_V1;
  readonly providerProtocol: "openai-compatible" | "anthropic-compatible";
  /** Exact provider-visible assistant text; it may be empty for tool-only turns. */
  readonly assistantContent: string;
  /** Provider reasoning retained for audit only, never generic request replay. */
  readonly auditThinking?: string;
  /** Exact provider-supported reasoning state eligible for native passback. */
  readonly reasoningPassback?: string;
  readonly finishReason?: string;
  readonly usage?: ModelResponseUsageV1;
  readonly toolCalls: readonly ModelResponseToolCallV1[];
}

export interface InputAttachmentV1 {
  readonly attachmentId: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType?: string;
  /** Inline values must be strings; artifact resolvers must produce a string. */
  readonly content: DurableJsonPayloadV1;
}

export const TOOL_OBSERVATION_SCHEMA_VERSION_V1 =
  "paw.tool-observation.v1" as const;

/** Model-visible, status-preserving tool evidence. */
export interface ToolObservationV1 {
  readonly schemaVersion: typeof TOOL_OBSERVATION_SCHEMA_VERSION_V1;
  readonly summary: string;
  readonly isError: boolean;
  readonly payload?: DurableJsonPayloadV1;
}

export const TASK_CHECKPOINT_SCHEMA_VERSION_V1 =
  "paw.task-checkpoint.v1" as const;

export interface TaskCheckpointItemV1 {
  readonly statement: string;
  readonly sourceSeqs: readonly number[];
}

/** Structured compact state for the current run, never long-term memory. */
export interface TaskCheckpointV1 {
  readonly schemaVersion: typeof TASK_CHECKPOINT_SCHEMA_VERSION_V1;
  readonly goal?: TaskCheckpointItemV1;
  readonly confirmedFacts: readonly TaskCheckpointItemV1[];
  readonly currentHypotheses: readonly TaskCheckpointItemV1[];
  readonly ruledOut: readonly TaskCheckpointItemV1[];
  readonly changedFiles: readonly TaskCheckpointItemV1[];
  readonly verification: readonly TaskCheckpointItemV1[];
  readonly unresolved: readonly TaskCheckpointItemV1[];
  readonly nextAction?: TaskCheckpointItemV1;
}

export interface MemorySourceRefV1 {
  readonly kind: "memory_store_evidence";
  readonly ref: string;
}

/** Provider-neutral long-term memory evidence selected for one model boundary. */
export interface MemoryCardV1 {
  readonly id: string;
  readonly revision: number;
  readonly kind: "semantic" | "episodic" | "procedural" | "profile" | "trial";
  readonly statement: string;
  readonly applicability: "applicable" | "reference" | "trial";
  readonly scope: Readonly<{
    repositoryId: string;
    branch?: string;
  }>;
  readonly sources: readonly MemorySourceRefV1[];
  readonly confidence: number;
  /** Source-observed validity time used to distinguish current from historical evidence. */
  readonly validFrom?: string;
  readonly contentHash: string;
}

export type MemoryAtomKindV1 =
  | "semantic"
  | "episodic"
  | "profile"
  | "instruction";

export type MemoryAtomActionV1 = "store" | "update" | "merge" | "skip";

/** A model proposal is evidence only; the deterministic writer remains authoritative. */
export interface MemoryAtomProposalV1 {
  readonly schemaVersion: typeof MEMORY_ATOM_PROPOSAL_SCHEMA_VERSION_V1;
  readonly atomId: string;
  readonly kind: MemoryAtomKindV1;
  readonly action: MemoryAtomActionV1;
  readonly statement: string;
  readonly keywords: readonly string[];
  readonly authority: "user_asserted" | "agent_verified" | "agent_inferred";
  readonly confidence: number;
  readonly priority: number;
  readonly sourceSeqs: readonly number[];
  readonly targetIds: readonly string[];
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly contentHash: string;
}

export type MemoryTopicFamilyV1 =
  | "semantic"
  | "episodic"
  | "profile"
  | "instruction"
  | "mixed";

export interface MemoryTopicMemberProposalV1 {
  readonly memoryId: string;
  readonly role: "primary" | "supporting";
  readonly confidence: number;
  readonly basis: "model_proposed" | "explicit_relation" | "user_asserted";
}

/** Model output is durable evidence only; the plugin derives topic/snapshot IDs. */
export interface MemoryTopicProposalV1 {
  readonly schemaVersion: typeof MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1;
  readonly proposalId: string;
  readonly scopeFingerprint: string;
  readonly family: MemoryTopicFamilyV1;
  readonly canonicalName: string;
  readonly normalizedName: string;
  readonly targetTopicId?: string;
  readonly members: readonly MemoryTopicMemberProposalV1[];
  readonly confidence: number;
}

export interface MemoryTopicIndexEntryV1 {
  readonly topicId: string;
  readonly snapshotId: string;
  readonly family: MemoryTopicFamilyV1;
  readonly canonicalName: string;
  readonly normalizedName: string;
  readonly memberCount: number;
  readonly trajectoryCount: number;
  readonly projectionHash: string;
}

export interface MemoryTopicEvidenceStateV1 {
  readonly topicId: string;
  readonly snapshotId: string;
  readonly trajectoryId: string;
  readonly memoryId: string;
  readonly state: "current" | "historical";
  readonly statement: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly evidenceRefs: readonly string[];
}

/** Query-independent L3 claim projected from active, source-grounded atoms. */
export interface MemoryPersonaClaimV1 {
  readonly memoryId: string;
  readonly kind: "profile";
  readonly statement: string;
  readonly confidence: number;
  readonly validFrom: string;
  readonly evidenceRefs: readonly string[];
}

export interface MemoryRawEvidenceSpanV1 {
  readonly evidenceRef: string;
  readonly memoryIds: readonly string[];
  readonly content: string;
  readonly contentHash: string;
}

/** A query-specific evidence need proposed by the planner, not a fixed taxonomy. */
export interface MemoryEvidenceRequirementV1 {
  readonly requirementId: string;
  readonly description: string;
  readonly priority: "required" | "supporting";
  readonly minimumEvidence: number;
}

/** Deterministically derived coverage for one dynamic requirement. */
export interface MemoryEvidenceCoverageItemV1 {
  readonly requirementId: string;
  readonly status: "covered" | "partial" | "missing";
  readonly memoryIds: readonly string[];
  readonly topicIds: readonly string[];
}

export type ModelSettlementStatusV1 =
  | "completed"
  | "truncated"
  | "failed"
  | "cancelled"
  | "unknown"
  | "rejected";

export type ToolSettlementStatusV1 =
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"
  | "rejected";

export type TaskCheckpointDistillationStatusV1 =
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"
  | "truncated";

export type CompletionReviewTriggerV1 =
  | "user_requested"
  | "project_required"
  | "non_trivial_change"
  | "missing_fresh_verification"
  | "fresh_verification_failed"
  | "fresh_verification_inconclusive"
  | "model_requested";

export type CompletionReviewVerdictV1 =
  | "allow"
  | "block"
  | "await_user"
  | "unknown";

/** Objective observations that may be supplied to the control reducer. */
export type InputFactV1 =
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
      trigger:
        | "task_terminal"
        | "work_segment_terminal"
        | "explicit_user_request";
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
      boundary:
        | "after_model_turn_without_tool_calls"
        | "after_tool_batch_settled";
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

export type AttemptStartedFactV1 = Extract<
  InputFactV1,
  { type: "attempt.started" }
>;
export type InputAcceptedFactV1 = Extract<
  InputFactV1,
  { type: "input.accepted" }
>;
export type InputPromotedFactV1 = Extract<
  InputFactV1,
  { type: "input.promoted" }
>;
export type WorkSegmentStartedFactV1 = Extract<
  InputFactV1,
  { type: "work.segment_started" }
>;
export type MemoryRetrievalSettledFactV1 = Extract<
  InputFactV1,
  { type: "memory.retrieval_settled" }
>;
export type MemoryWriteClaimedFactV1 = Extract<
  InputFactV1,
  { type: "memory.write_claimed" }
>;
export type MemoryCandidateStagedFactV1 = Extract<
  InputFactV1,
  { type: "memory.candidate_staged" }
>;
export type MemoryWriteSettledFactV1 = Extract<
  InputFactV1,
  { type: "memory.write_settled" }
>;
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
export type ModelDispatchRecordedFactV1 = Extract<
  InputFactV1,
  { type: "model.dispatch_recorded" }
>;
export type ModelSettledFactV1 = Extract<
  InputFactV1,
  { type: "model.settled" }
>;
export type ToolCallObservedFactV1 = Extract<
  InputFactV1,
  { type: "tool.call_observed" }
>;
export type ToolDispatchRecordedFactV1 = Extract<
  InputFactV1,
  { type: "tool.dispatch_recorded" }
>;
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
export type AbortRequestedFactV1 = Extract<
  InputFactV1,
  { type: "abort.requested" }
>;
export type RuntimeFailedFactV1 = Extract<
  InputFactV1,
  { type: "runtime.failed" }
>;
export type PolicyRequestRecordedFactV1 = Extract<
  InputFactV1,
  { type: "policy.request_recorded" }
>;
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

export type ContinueDecisionActionV1 = Extract<
  ControlDecisionActionV1,
  { kind: "continue" }
>;
export type WaitDecisionActionV1 = Extract<
  ControlDecisionActionV1,
  { kind: "wait" }
>;
export type CompleteDecisionActionV1 = Extract<
  ControlDecisionActionV1,
  { kind: "complete" }
>;
export type IncompleteDecisionActionV1 = Extract<
  ControlDecisionActionV1,
  { kind: "incomplete" }
>;
export type FailedDecisionActionV1 = Extract<
  ControlDecisionActionV1,
  { kind: "failed" }
>;

/**
 * 用户决策（2026-08-21）：因崩溃修复产生的 incomplete 终局允许接续新工作
 * 段。范围只限 repair 结算的 unknown 族原因；预算耗尽等其余 incomplete 仍
 * 不可开段（开段也无法推进，应开新 run）。
 */
export const CRASH_RECOVERY_INCOMPLETE_REASONS_V1: ReadonlySet<string> =
  new Set(["model-result-unknown", "tool-result-unknown"]);

export function isCrashRecoveryIncompleteReasonV1(reason: string): boolean {
  return CRASH_RECOVERY_INCOMPLETE_REASONS_V1.has(reason);
}

export function isCrashRecoveryIncompleteActionV1(
  action: ControlDecisionActionV1,
): boolean {
  return (
    action.kind === "incomplete" &&
    isCrashRecoveryIncompleteReasonV1(action.reasonCode)
  );
}
export type AbortDecisionActionV1 = Extract<
  ControlDecisionActionV1,
  { kind: "abort" }
>;

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

/** Parse a durable model response without importing a provider or runtime. */
export function parseModelResponseV1(value: unknown): ModelResponseV1 {
  assertModelResponse(value);
  return value as ModelResponseV1;
}

export function assertModelResponseV1(
  value: unknown,
): asserts value is ModelResponseV1 {
  assertModelResponse(value);
}

export function isModelResponseV1(value: unknown): value is ModelResponseV1 {
  try {
    parseModelResponseV1(value);
    return true;
  } catch {
    return false;
  }
}

export function parseToolObservationV1(value: unknown): ToolObservationV1 {
  assertToolObservation(value, "tool observation");
  return value as ToolObservationV1;
}

export function assertToolObservationV1(
  value: unknown,
): asserts value is ToolObservationV1 {
  assertToolObservation(value, "tool observation");
}

export function isToolObservationV1(
  value: unknown,
): value is ToolObservationV1 {
  try {
    parseToolObservationV1(value);
    return true;
  } catch {
    return false;
  }
}

export function parseTaskCheckpointV1(value: unknown): TaskCheckpointV1 {
  assertTaskCheckpoint(value, "task checkpoint");
  return value as TaskCheckpointV1;
}

export function assertTaskCheckpointV1(
  value: unknown,
): asserts value is TaskCheckpointV1 {
  assertTaskCheckpoint(value, "task checkpoint");
}

export function isTaskCheckpointV1(value: unknown): value is TaskCheckpointV1 {
  try {
    parseTaskCheckpointV1(value);
    return true;
  } catch {
    return false;
  }
}

/** Parse and strictly validate an untrusted Paw Next journal value. */
export function parseRunJournalEnvelopeV1(
  value: unknown,
): RunJournalEnvelopeV1 {
  const envelope = expectObject(value, "journal envelope");
  assertExactKeys(
    envelope,
    ["schemaVersion", "sessionId", "runId", "seq", "ts", "record"],
    [],
    "journal envelope",
  );
  assertExact(
    envelope.schemaVersion,
    RUN_JOURNAL_SCHEMA_VERSION_V1,
    "schemaVersion",
  );
  assertId(envelope.sessionId, "sessionId");
  assertId(envelope.runId, "runId");
  assertPositiveInteger(envelope.seq, "seq");
  assertNonNegativeInteger(envelope.ts, "ts");
  assertRecord(envelope.record);

  const record = envelope.record as RunJournalRecordV1;
  if (
    record.kind === "derived_decision" &&
    record.decision.inputThroughSeq >= (envelope.seq as number)
  ) {
    throw new Error("inputThroughSeq must precede the decision envelope");
  }
  return value as RunJournalEnvelopeV1;
}

export function assertRunJournalEnvelopeV1(
  value: unknown,
): asserts value is RunJournalEnvelopeV1 {
  parseRunJournalEnvelopeV1(value);
}

/** Validate that two canonical envelopes form one contiguous run prefix. */
export function assertRunJournalEnvelopeCanFollowV1(
  previous: RunJournalEnvelopeV1,
  next: RunJournalEnvelopeV1,
): void {
  parseRunJournalEnvelopeV1(previous);
  parseRunJournalEnvelopeV1(next);
  if (next.sessionId !== previous.sessionId) {
    throw new Error("journal sessionId changed within one run");
  }
  if (next.runId !== previous.runId) {
    throw new Error("journal runId changed within one run");
  }
  if (next.seq !== previous.seq + 1) {
    throw new Error("journal seq must be contiguous");
  }
  if (next.record.kind === "derived_decision") {
    if (previous.record.kind !== "input_fact") {
      throw new Error("derived decision must immediately follow an input fact");
    }
    if (next.record.decision.inputThroughSeq !== previous.seq) {
      throw new Error("derived decision inputThroughSeq is stale");
    }
  }
}

/** Parse a complete authoritative prefix and validate its ordering invariants. */
export function parseRunJournalPrefixV1(
  values: readonly unknown[],
): readonly RunJournalEnvelopeV1[] {
  const envelopes = values.map(parseRunJournalEnvelopeV1);
  const first = envelopes[0];
  if (first && first.seq !== 1) {
    throw new Error("journal prefix must start at seq 1");
  }
  for (let index = 1; index < envelopes.length; index += 1) {
    assertRunJournalEnvelopeCanFollowV1(
      envelopes[index - 1] as RunJournalEnvelopeV1,
      envelopes[index] as RunJournalEnvelopeV1,
    );
  }
  assertLifecycleIdentities(envelopes);
  return envelopes;
}

export function isRunJournalEnvelopeV1(
  value: unknown,
): value is RunJournalEnvelopeV1 {
  try {
    parseRunJournalEnvelopeV1(value);
    return true;
  } catch {
    return false;
  }
}

function assertRecord(value: unknown): void {
  const record = expectObject(value, "record");
  if (record.kind === "input_fact") {
    assertExactKeys(record, ["kind", "fact"], [], "input record");
    assertInputFact(record.fact);
    return;
  }
  if (record.kind === "derived_decision") {
    assertExactKeys(record, ["kind", "decision"], [], "decision record");
    assertDerivedDecision(record.decision);
    return;
  }
  throw new Error("Unsupported journal record kind");
}

function assertLifecycleIdentities(
  envelopes: readonly RunJournalEnvelopeV1[],
): void {
  const acceptedInputs = new Map<
    string,
    Extract<InputFactV1, { type: "input.accepted" }>
  >();
  const promotedInputIds = new Set<string>();
  const models = new Map<
    string,
    {
      readonly turn: number;
      settled: boolean;
      hasToolCalls: boolean;
      nextToolOrder: number;
    }
  >();
  const tools = new Map<
    string,
    {
      readonly turn: number;
      readonly sourceIndex: number;
      readonly tool: string;
      dispatched: boolean;
      settled: boolean;
      permissionResolution?: "allow_once" | "allow_rule" | "deny";
      checkpointSeq?: number;
    }
  >();
  let latestEffectCheckpointSeq = 0;
  let latestModelTurn = 0;
  const checkpointIds = new Set<string>();
  const checkpointClaimIds = new Set<string>();
  const claimedCheckpointIds = new Set<string>();
  const checkpointClaims = new Map<
    string,
    {
      readonly checkpointId: string;
      readonly supersedesCheckpointId?: string;
      readonly policyVersion: string;
      readonly sourceFromSeq: number;
      readonly sourceThroughSeq: number;
      readonly sourceInputHash: string;
      settlement?: Extract<
        InputFactV1,
        { type: "context.checkpoint_distillation_settled" }
      >;
      recorded: boolean;
    }
  >();
  let openCheckpointClaimId: string | undefined;
  let completedUnrecordedClaimId: string | undefined;
  let latestCheckpoint:
    | {
        readonly checkpointId: string;
        readonly sourceFromSeq: number;
        readonly sourceThroughSeq: number;
      }
    | undefined;
  let terminalDecisionBoundaryOpen = false;
  let terminalBoundaryReducerVersion: string | undefined;
  let terminalBoundaryAction: ControlDecisionActionV1 | undefined;
  const unauthorizedPromotionReducerVersions = new Set<string>();
  const enabledSegmentReducerVersions = new Set<string>();
  const memoryQueryIds = new Set<string>();
  const memoryPersonaProjectionQueryIds = new Set<string>();
  const memoryRawEvidenceQueryIds = new Set<string>();
  const memoryTopicEvidenceQueryIds = new Set<string>();
  const memoryEvidenceCoverageQueryIds = new Set<string>();
  const memoryWrites = new Map<
    string,
    {
      readonly sourceFromSeq: number;
      readonly sourceThroughSeq: number;
      proposalHash?: string;
      staged: boolean;
      settled: boolean;
      settlementStatus?: "completed" | "noop" | "failed" | "interrupted";
      settlementIds?: ReadonlySet<string>;
    }
  >();
  const topicOrganizations = new Map<
    string,
    {
      readonly sourceWriteId: string;
      readonly scopeFingerprint: string;
      proposalHash?: string;
      topicCount?: number;
      staged: boolean;
      settled: boolean;
    }
  >();
  const activities = new Map<
    string,
    { readonly activityKind: string; settled: boolean }
  >();
  const completionReviews = new Map<
    string,
    { readonly candidateHash: string; settled: boolean }
  >();
  let expectedSegmentIndex = 1;

  for (
    let envelopeIndex = 0;
    envelopeIndex < envelopes.length;
    envelopeIndex += 1
  ) {
    const envelope = envelopes[envelopeIndex] as RunJournalEnvelopeV1;
    if (envelope.record.kind === "derived_decision") {
      const action = envelope.record.decision.action;
      if (
        action.kind === "complete" &&
        [...activities.values()].some((activity) => !activity.settled)
      ) {
        throw new Error("completed decision cannot abandon active activities");
      }
      if (action.kind !== "continue") {
        terminalDecisionBoundaryOpen = true;
        terminalBoundaryReducerVersion =
          envelope.record.decision.reducerVersion;
        terminalBoundaryAction = action;
      }
      continue;
    }
    const fact = envelope.record.fact;
    switch (fact.type) {
      case "input.accepted": {
        if (
          acceptedInputs.has(fact.inputId) ||
          promotedInputIds.has(fact.inputId)
        ) {
          throw new Error(`duplicate accepted input: ${fact.inputId}`);
        }
        acceptedInputs.set(fact.inputId, fact);
        break;
      }
      case "input.promoted": {
        if (promotedInputIds.has(fact.inputId)) {
          throw new Error(`duplicate promoted input: ${fact.inputId}`);
        }
        const accepted = acceptedInputs.get(fact.inputId);
        if (fact.delivery !== "initial" && !accepted) {
          throw new Error(
            `promoted ${fact.delivery} input has no durable admission: ${fact.inputId}`,
          );
        }
        if (accepted && !sameAcceptedInputPromotion(accepted, fact)) {
          throw new Error(`promoted input identity mismatch: ${fact.inputId}`);
        }
        promotedInputIds.add(fact.inputId);
        if (
          fact.delivery !== "initial" &&
          terminalDecisionBoundaryOpen &&
          terminalBoundaryReducerVersion !== undefined
        ) {
          if (
            enabledSegmentReducerVersions.has(terminalBoundaryReducerVersion)
          ) {
            throw new Error(
              "terminal promotion requires a work segment marker",
            );
          }
          unauthorizedPromotionReducerVersions.add(
            terminalBoundaryReducerVersion,
          );
        }
        break;
      }
      case "work.segment_started": {
        if (fact.segmentIndex !== expectedSegmentIndex) {
          throw new Error("work segment indexes must be contiguous from 1");
        }
        const previous = envelopes[envelopeIndex - 1];
        if (!previous || previous.record.kind !== "derived_decision") {
          throw new Error("work segment must immediately follow a decision");
        }
        const decision = previous.record.decision;
        if (
          decision.action.kind !== "complete" &&
          !(
            decision.action.kind === "wait" &&
            decision.action.waitFor === "user"
          ) &&
          !isCrashRecoveryIncompleteActionV1(decision.action)
        ) {
          throw new Error(
            "work segment requires an eligible terminal decision",
          );
        }
        if (fact.reducerVersion !== decision.reducerVersion) {
          throw new Error(
            "work segment reducerVersion does not match decision",
          );
        }
        if (fact.previousDecisionStateHash !== decision.stateHash) {
          throw new Error("work segment previous decision stateHash mismatch");
        }
        if (!sameControlDecisionAction(fact.previousAction, decision.action)) {
          throw new Error("work segment previous action mismatch");
        }
        if (unauthorizedPromotionReducerVersions.has(fact.reducerVersion)) {
          throw new Error("terminal promotion requires a work segment marker");
        }
        if (!acceptedInputs.has(fact.inputId)) {
          throw new Error(
            `work segment input has no durable admission: ${fact.inputId}`,
          );
        }
        if (promotedInputIds.has(fact.inputId)) {
          throw new Error(
            `work segment input is already promoted: ${fact.inputId}`,
          );
        }
        const next = envelopes[envelopeIndex + 1];
        if (
          !next ||
          next.record.kind !== "input_fact" ||
          next.record.fact.type !== "input.promoted" ||
          next.record.fact.inputId !== fact.inputId
        ) {
          throw new Error(
            "work segment must immediately precede its promotion",
          );
        }
        if ([...models.values()].some((model) => !model.settled)) {
          throw new Error("work segment cannot cross an unsettled model call");
        }
        if ([...tools.values()].some((tool) => !tool.settled)) {
          throw new Error(
            "work segment cannot cross an unsettled tool lifecycle",
          );
        }
        if (openCheckpointClaimId || completedUnrecordedClaimId) {
          throw new Error(
            "work segment cannot cross pending checkpoint distillation",
          );
        }
        expectedSegmentIndex += 1;
        enabledSegmentReducerVersions.add(fact.reducerVersion);
        terminalDecisionBoundaryOpen = false;
        terminalBoundaryReducerVersion = undefined;
        terminalBoundaryAction = undefined;
        unauthorizedPromotionReducerVersions.delete(fact.reducerVersion);
        break;
      }
      case "memory.retrieval_settled": {
        if (memoryQueryIds.has(fact.queryId)) {
          throw new Error(`duplicate memory retrieval query: ${fact.queryId}`);
        }
        memoryQueryIds.add(fact.queryId);
        break;
      }
      case "memory.persona_projection_settled": {
        if (!memoryQueryIds.has(fact.queryId)) {
          throw new Error(
            "memory persona projection requires a retrieval query",
          );
        }
        if (memoryPersonaProjectionQueryIds.has(fact.queryId)) {
          throw new Error(
            `duplicate memory persona projection query: ${fact.queryId}`,
          );
        }
        memoryPersonaProjectionQueryIds.add(fact.queryId);
        break;
      }
      case "memory.raw_evidence_settled": {
        if (!memoryQueryIds.has(fact.queryId)) {
          throw new Error("memory raw evidence requires a retrieval query");
        }
        if (memoryRawEvidenceQueryIds.has(fact.queryId)) {
          throw new Error(
            `duplicate memory raw evidence query: ${fact.queryId}`,
          );
        }
        memoryRawEvidenceQueryIds.add(fact.queryId);
        break;
      }
      case "memory.topic_evidence_settled": {
        if (!memoryQueryIds.has(fact.queryId)) {
          throw new Error("memory topic evidence requires a retrieval query");
        }
        if (memoryTopicEvidenceQueryIds.has(fact.queryId)) {
          throw new Error(
            `duplicate memory topic evidence query: ${fact.queryId}`,
          );
        }
        memoryTopicEvidenceQueryIds.add(fact.queryId);
        break;
      }
      case "memory.evidence_coverage_settled": {
        if (!memoryQueryIds.has(fact.queryId)) {
          throw new Error(
            "memory evidence coverage requires a retrieval query",
          );
        }
        if (
          !memoryTopicEvidenceQueryIds.has(fact.queryId) ||
          !memoryRawEvidenceQueryIds.has(fact.queryId)
        ) {
          throw new Error(
            "memory evidence coverage requires prior topic and raw evidence",
          );
        }
        if (memoryEvidenceCoverageQueryIds.has(fact.queryId)) {
          throw new Error(
            `duplicate memory evidence coverage query: ${fact.queryId}`,
          );
        }
        memoryEvidenceCoverageQueryIds.add(fact.queryId);
        break;
      }
      case "memory.write_claimed": {
        if (memoryWrites.has(fact.writeId)) {
          throw new Error(`duplicate memory write claim: ${fact.writeId}`);
        }
        if (fact.sourceThroughSeq >= envelope.seq) {
          throw new Error("memory write cannot cover itself or future facts");
        }
        memoryWrites.set(fact.writeId, {
          sourceFromSeq: fact.sourceFromSeq,
          sourceThroughSeq: fact.sourceThroughSeq,
          staged: false,
          settled: false,
        });
        break;
      }
      case "memory.candidate_staged": {
        const write = memoryWrites.get(fact.writeId);
        if (!write) {
          throw new Error(
            `memory candidate has no write claim: ${fact.writeId}`,
          );
        }
        if (write.staged || write.settled) {
          throw new Error(`duplicate memory candidate stage: ${fact.writeId}`);
        }
        for (const atom of fact.atoms) {
          if (
            atom.sourceSeqs.some(
              (seq) =>
                seq < write.sourceFromSeq || seq > write.sourceThroughSeq,
            )
          ) {
            throw new Error(
              `memory atom source is outside claimed range: ${atom.atomId}`,
            );
          }
        }
        write.proposalHash = fact.proposalHash;
        write.staged = true;
        break;
      }
      case "memory.write_settled": {
        const write = memoryWrites.get(fact.writeId);
        if (!write) {
          throw new Error(
            `memory write settlement has no claim: ${fact.writeId}`,
          );
        }
        if (write.settled) {
          throw new Error(`duplicate memory write settlement: ${fact.writeId}`);
        }
        if (
          (fact.status === "completed" || fact.status === "noop") &&
          !write.staged
        ) {
          throw new Error(
            `memory ${fact.status} settlement requires staged candidates`,
          );
        }
        if (
          fact.proposalHash !== undefined &&
          fact.proposalHash !== write.proposalHash
        ) {
          throw new Error("memory write proposal hash mismatch");
        }
        if (
          write.staged &&
          fact.status !== "interrupted" &&
          fact.proposalHash === undefined
        ) {
          throw new Error("staged memory settlement requires proposal hash");
        }
        write.settled = true;
        write.settlementStatus = fact.status;
        write.settlementIds = new Set([
          ...fact.storedIds,
          ...fact.invalidatedIds,
        ]);
        break;
      }
      case "memory.topic_organization_claimed": {
        if (topicOrganizations.has(fact.organizationId)) {
          throw new Error(
            `duplicate memory topic organization claim: ${fact.organizationId}`,
          );
        }
        const sourceWrite = memoryWrites.get(fact.sourceWriteId);
        if (
          !sourceWrite?.settled ||
          (sourceWrite.settlementStatus !== "completed" &&
            sourceWrite.settlementStatus !== "noop")
        ) {
          throw new Error(
            "memory topic organization requires a completed source write",
          );
        }
        if (
          fact.sourceProposalHash !== sourceWrite.proposalHash ||
          fact.sourceMemoryIds.some((id) => !sourceWrite.settlementIds?.has(id))
        ) {
          throw new Error("memory topic organization source mismatch");
        }
        topicOrganizations.set(fact.organizationId, {
          sourceWriteId: fact.sourceWriteId,
          scopeFingerprint: fact.scopeFingerprint,
          staged: false,
          settled: false,
        });
        break;
      }
      case "memory.topic_candidate_staged": {
        const organization = topicOrganizations.get(fact.organizationId);
        if (!organization) {
          throw new Error("memory topic candidate has no organization claim");
        }
        if (organization.staged || organization.settled) {
          throw new Error("duplicate memory topic candidate stage");
        }
        if (
          fact.topics.some(
            (topic) => topic.scopeFingerprint !== organization.scopeFingerprint,
          )
        ) {
          throw new Error("memory topic candidate scope mismatch");
        }
        organization.proposalHash = fact.proposalHash;
        organization.topicCount = fact.topics.length;
        organization.staged = true;
        break;
      }
      case "memory.topic_organization_settled": {
        const organization = topicOrganizations.get(fact.organizationId);
        if (!organization) {
          throw new Error("memory topic settlement has no organization claim");
        }
        if (organization.settled) {
          throw new Error("duplicate memory topic organization settlement");
        }
        if (
          (fact.status === "completed" || fact.status === "noop") &&
          !organization.staged
        ) {
          throw new Error("successful memory topic settlement requires stage");
        }
        if (
          fact.proposalHash !== undefined &&
          fact.proposalHash !== organization.proposalHash
        ) {
          throw new Error("memory topic proposal hash mismatch");
        }
        if (
          organization.staged &&
          fact.status !== "interrupted" &&
          fact.proposalHash === undefined
        ) {
          throw new Error(
            "staged memory topic settlement requires proposal hash",
          );
        }
        if (
          fact.status === "completed" &&
          (organization.topicCount === 0 ||
            fact.topicIds.length !== organization.topicCount)
        ) {
          throw new Error("completed memory topic settlement count mismatch");
        }
        if (
          fact.status === "noop" &&
          (organization.topicCount !== 0 || fact.topicIds.length !== 0)
        ) {
          throw new Error("noop memory topic settlement must have no topics");
        }
        organization.settled = true;
        break;
      }
      case "model.dispatch_recorded": {
        if (terminalDecisionBoundaryOpen) {
          throw new Error(
            "model dispatch requires a work segment after terminal decision",
          );
        }
        if (models.has(fact.modelCallId)) {
          throw new Error(`duplicate model dispatch: ${fact.modelCallId}`);
        }
        if (fact.turn <= latestModelTurn) {
          throw new Error("model dispatch turns must be strictly increasing");
        }
        models.set(fact.modelCallId, {
          turn: fact.turn,
          settled: false,
          hasToolCalls: false,
          nextToolOrder: 0,
        });
        latestModelTurn = fact.turn;
        break;
      }
      case "model.settled": {
        const model = models.get(fact.modelCallId);
        if (!model) {
          throw new Error(
            `model settlement has no dispatch: ${fact.modelCallId}`,
          );
        }
        if (model.turn !== fact.turn) {
          throw new Error(
            `model settlement turn mismatch: ${fact.modelCallId}`,
          );
        }
        if (model.settled) {
          throw new Error(`duplicate model settlement: ${fact.modelCallId}`);
        }
        model.settled = true;
        model.hasToolCalls = fact.hasToolCalls;
        break;
      }
      case "tool.call_observed": {
        const model = models.get(fact.modelCallId);
        if (!model) {
          throw new Error(
            `observed tool call has no model dispatch: ${fact.modelCallId}`,
          );
        }
        if (!model.settled) {
          throw new Error(
            `observed tool call precedes model settlement: ${fact.modelCallId}`,
          );
        }
        if (model.turn !== fact.turn) {
          throw new Error(
            `observed tool call turn mismatch: ${fact.modelCallId}`,
          );
        }
        if (!model.hasToolCalls) {
          throw new Error(
            `observed tool call contradicts model settlement: ${fact.modelCallId}`,
          );
        }
        if (fact.order !== model.nextToolOrder) {
          throw new Error(
            `observed tool call order is not contiguous: ${fact.modelCallId}`,
          );
        }
        if (tools.has(fact.callId)) {
          throw new Error(`duplicate observed tool call: ${fact.callId}`);
        }
        tools.set(fact.callId, {
          turn: fact.turn,
          sourceIndex: fact.order,
          tool: fact.tool,
          dispatched: false,
          settled: false,
        });
        model.nextToolOrder += 1;
        break;
      }
      case "tool.dispatch_recorded": {
        const tool = tools.get(fact.callId);
        if (!tool) {
          throw new Error(`tool dispatch has no observed call: ${fact.callId}`);
        }
        if (tool.turn !== fact.turn || tool.sourceIndex !== fact.sourceIndex) {
          throw new Error(`tool dispatch identity mismatch: ${fact.callId}`);
        }
        if (tool.dispatched) {
          throw new Error(`duplicate tool dispatch: ${fact.callId}`);
        }
        if (tool.settled) {
          throw new Error(`tool dispatch follows settlement: ${fact.callId}`);
        }
        tool.dispatched = true;
        break;
      }
      case "tool.permission_resolved": {
        const tool = tools.get(fact.callId);
        if (!tool) {
          throw new Error(
            `tool permission has no observed call: ${fact.callId}`,
          );
        }
        if (!tool.dispatched) {
          throw new Error(`tool permission has no dispatch: ${fact.callId}`);
        }
        if (tool.settled) {
          throw new Error(`tool permission follows settlement: ${fact.callId}`);
        }
        if (
          tool.turn !== fact.turn ||
          tool.sourceIndex !== fact.sourceIndex ||
          tool.tool !== fact.tool
        ) {
          throw new Error(`tool permission identity mismatch: ${fact.callId}`);
        }
        if (tool.permissionResolution !== undefined) {
          throw new Error(`duplicate tool permission: ${fact.callId}`);
        }
        tool.permissionResolution = fact.resolution;
        break;
      }
      case "tool.effect_checkpoint_allocated": {
        const tool = tools.get(fact.callId);
        if (!tool) {
          throw new Error(
            `tool effect checkpoint has no observed call: ${fact.callId}`,
          );
        }
        if (!tool.dispatched) {
          throw new Error(
            `tool effect checkpoint has no dispatch: ${fact.callId}`,
          );
        }
        if (tool.settled) {
          throw new Error(
            `tool effect checkpoint follows settlement: ${fact.callId}`,
          );
        }
        if (tool.turn !== fact.turn || tool.sourceIndex !== fact.sourceIndex) {
          throw new Error(
            `tool effect checkpoint identity mismatch: ${fact.callId}`,
          );
        }
        if (
          tool.permissionResolution !== "allow_once" &&
          tool.permissionResolution !== "allow_rule"
        ) {
          throw new Error(
            `tool effect checkpoint requires allowed permission: ${fact.callId}`,
          );
        }
        if (tool.checkpointSeq !== undefined) {
          throw new Error(`duplicate tool effect checkpoint: ${fact.callId}`);
        }
        if (fact.checkpointSeq <= latestEffectCheckpointSeq) {
          throw new Error(
            "tool effect checkpoint sequence must be strictly increasing",
          );
        }
        tool.checkpointSeq = fact.checkpointSeq;
        latestEffectCheckpointSeq = fact.checkpointSeq;
        break;
      }
      case "tool.settled": {
        const tool = tools.get(fact.callId);
        if (!tool) {
          throw new Error(
            `tool settlement has no observed call: ${fact.callId}`,
          );
        }
        if (tool.settled) {
          throw new Error(`duplicate tool settlement: ${fact.callId}`);
        }
        const maySettleWithoutDispatch =
          fact.status === "cancelled" || fact.status === "rejected";
        if (!tool.dispatched && !maySettleWithoutDispatch) {
          throw new Error(`tool settlement has no dispatch: ${fact.callId}`);
        }
        if (
          tool.permissionResolution === "deny" &&
          fact.status !== "rejected"
        ) {
          throw new Error(
            `denied tool permission requires rejected settlement: ${fact.callId}`,
          );
        }
        if (
          (fact.status === "completed" || fact.status === "unknown") &&
          tool.permissionResolution !== "allow_once" &&
          tool.permissionResolution !== "allow_rule"
        ) {
          throw new Error(
            `executed tool settlement requires allowed permission: ${fact.callId}`,
          );
        }
        tool.settled = true;
        break;
      }
      case "runtime.activity_started": {
        if (terminalDecisionBoundaryOpen) {
          throw new Error(
            `runtime activity cannot start after a terminal decision: ${fact.activityId}`,
          );
        }
        if (activities.has(fact.activityId)) {
          throw new Error(`duplicate runtime activity: ${fact.activityId}`);
        }
        activities.set(fact.activityId, {
          activityKind: fact.activityKind,
          settled: false,
        });
        break;
      }
      case "runtime.activity_settled": {
        const activity = activities.get(fact.activityId);
        if (!activity) {
          throw new Error(
            `runtime activity settlement has no start: ${fact.activityId}`,
          );
        }
        if (activity.settled) {
          throw new Error(
            `duplicate runtime activity settlement: ${fact.activityId}`,
          );
        }
        activity.settled = true;
        if (
          terminalBoundaryAction?.kind === "wait" &&
          terminalBoundaryAction.waitFor === "external"
        ) {
          terminalDecisionBoundaryOpen = false;
          terminalBoundaryReducerVersion = undefined;
          terminalBoundaryAction = undefined;
        }
        break;
      }
      case "completion.review_claimed": {
        if (completionReviews.has(fact.reviewId)) {
          throw new Error(`duplicate completion review: ${fact.reviewId}`);
        }
        if (fact.sourceThroughSeq >= envelope.seq) {
          throw new Error(
            "completion review cannot cover itself or future facts",
          );
        }
        completionReviews.set(fact.reviewId, {
          candidateHash: fact.candidateHash,
          settled: false,
        });
        break;
      }
      case "completion.review_settled": {
        const review = completionReviews.get(fact.reviewId);
        if (!review) {
          throw new Error(
            `completion review settlement has no claim: ${fact.reviewId}`,
          );
        }
        if (review.settled) {
          throw new Error(
            `duplicate completion review settlement: ${fact.reviewId}`,
          );
        }
        review.settled = true;
        break;
      }
      case "context.checkpoint_distillation_claimed": {
        if (openCheckpointClaimId || completedUnrecordedClaimId) {
          throw new Error("checkpoint distillation already has pending work");
        }
        if (checkpointClaimIds.has(fact.claimId)) {
          throw new Error(
            `duplicate checkpoint distillation claim: ${fact.claimId}`,
          );
        }
        if (
          checkpointIds.has(fact.checkpointId) ||
          claimedCheckpointIds.has(fact.checkpointId)
        ) {
          throw new Error(`duplicate context checkpoint: ${fact.checkpointId}`);
        }
        if (fact.sourceThroughSeq >= envelope.seq) {
          throw new Error(
            "checkpoint distillation cannot cover itself or future facts",
          );
        }
        if (!latestCheckpoint && fact.supersedesCheckpointId !== undefined) {
          throw new Error(
            "first checkpoint distillation cannot supersede another",
          );
        }
        if (
          latestCheckpoint &&
          fact.supersedesCheckpointId !== latestCheckpoint.checkpointId
        ) {
          throw new Error("checkpoint distillation supersession is stale");
        }
        if (
          latestCheckpoint &&
          (fact.sourceFromSeq > latestCheckpoint.sourceFromSeq ||
            fact.sourceThroughSeq < latestCheckpoint.sourceThroughSeq)
        ) {
          throw new Error(
            "checkpoint distillation source range must be monotonic",
          );
        }
        checkpointClaimIds.add(fact.claimId);
        claimedCheckpointIds.add(fact.checkpointId);
        checkpointClaims.set(fact.claimId, {
          checkpointId: fact.checkpointId,
          ...(fact.supersedesCheckpointId === undefined
            ? {}
            : { supersedesCheckpointId: fact.supersedesCheckpointId }),
          policyVersion: fact.policyVersion,
          sourceFromSeq: fact.sourceFromSeq,
          sourceThroughSeq: fact.sourceThroughSeq,
          sourceInputHash: fact.sourceInputHash,
          recorded: false,
        });
        openCheckpointClaimId = fact.claimId;
        break;
      }
      case "context.checkpoint_distillation_settled": {
        const claim = checkpointClaims.get(fact.claimId);
        if (!claim) {
          throw new Error(
            `checkpoint distillation settlement has no claim: ${fact.claimId}`,
          );
        }
        if (openCheckpointClaimId !== fact.claimId) {
          throw new Error(
            `checkpoint distillation settlement is not active: ${fact.claimId}`,
          );
        }
        if (claim.settlement) {
          throw new Error(
            `duplicate checkpoint distillation settlement: ${fact.claimId}`,
          );
        }
        if (fact.status === "completed") {
          const checkpoint = fact.checkpoint as DurableJsonPayloadV1;
          if (checkpoint.kind === "inline") {
            assertCheckpointSourcesInRange(
              checkpoint.value as unknown as TaskCheckpointV1,
              claim.sourceFromSeq,
              claim.sourceThroughSeq,
            );
          }
          completedUnrecordedClaimId = fact.claimId;
        }
        claim.settlement = fact;
        openCheckpointClaimId = undefined;
        break;
      }
      case "context.checkpoint_recorded": {
        if (openCheckpointClaimId) {
          throw new Error(
            "context checkpoint cannot bypass active distillation",
          );
        }
        if (completedUnrecordedClaimId) {
          if (fact.distillationClaimId !== completedUnrecordedClaimId) {
            throw new Error(
              "context checkpoint must record the completed distillation",
            );
          }
        } else if (fact.distillationClaimId !== undefined) {
          throw new Error("context checkpoint has no completed distillation");
        }
        if (checkpointIds.has(fact.checkpointId)) {
          throw new Error(`duplicate context checkpoint: ${fact.checkpointId}`);
        }
        if (fact.sourceThroughSeq >= envelope.seq) {
          throw new Error(
            "context checkpoint cannot cover itself or future facts",
          );
        }
        if (!latestCheckpoint && fact.supersedesCheckpointId !== undefined) {
          throw new Error("first context checkpoint cannot supersede another");
        }
        if (
          latestCheckpoint &&
          fact.supersedesCheckpointId !== latestCheckpoint.checkpointId
        ) {
          throw new Error("context checkpoint supersession is stale");
        }
        if (
          latestCheckpoint &&
          (fact.sourceFromSeq > latestCheckpoint.sourceFromSeq ||
            fact.sourceThroughSeq < latestCheckpoint.sourceThroughSeq)
        ) {
          throw new Error("context checkpoint source range must be monotonic");
        }
        if (fact.distillationClaimId !== undefined) {
          const claim = checkpointClaims.get(fact.distillationClaimId);
          const settlement = claim?.settlement;
          if (
            !claim ||
            !settlement ||
            settlement.status !== "completed" ||
            settlement.checkpoint === undefined ||
            claim.recorded
          ) {
            throw new Error(
              "context checkpoint distillation binding is incomplete",
            );
          }
          if (
            claim.checkpointId !== fact.checkpointId ||
            claim.supersedesCheckpointId !== fact.supersedesCheckpointId ||
            claim.policyVersion !== fact.policyVersion ||
            claim.sourceFromSeq !== fact.sourceFromSeq ||
            claim.sourceThroughSeq !== fact.sourceThroughSeq ||
            claim.sourceInputHash !== fact.sourceInputHash ||
            !sameDurableJsonPayload(settlement.checkpoint, fact.checkpoint)
          ) {
            throw new Error("context checkpoint distillation binding mismatch");
          }
          claim.recorded = true;
          completedUnrecordedClaimId = undefined;
        } else if (claimedCheckpointIds.has(fact.checkpointId)) {
          throw new Error(
            "context checkpoint cannot bypass its distillation claim",
          );
        }
        checkpointIds.add(fact.checkpointId);
        latestCheckpoint = {
          checkpointId: fact.checkpointId,
          sourceFromSeq: fact.sourceFromSeq,
          sourceThroughSeq: fact.sourceThroughSeq,
        };
        break;
      }
    }
  }
}

function sameControlDecisionAction(
  left: ControlDecisionActionV1,
  right: ControlDecisionActionV1,
): boolean {
  return (
    left.kind === right.kind &&
    left.reasonCode === right.reasonCode &&
    (left.kind !== "wait" ||
      (right.kind === "wait" && left.waitFor === right.waitFor))
  );
}

function sameDurableJsonPayload(
  left: DurableJsonPayloadV1,
  right: DurableJsonPayloadV1,
): boolean {
  if (left.kind !== right.kind || left.hash !== right.hash) return false;
  if (left.kind === "artifact_ref" && right.kind === "artifact_ref") {
    return left.artifactRef === right.artifactRef;
  }
  if (left.kind === "inline" && right.kind === "inline") {
    return sameJsonValue(left.value, right.value);
  }
  return false;
}

function sameAcceptedInputPromotion(
  accepted: Extract<InputFactV1, { type: "input.accepted" }>,
  promoted: Extract<InputFactV1, { type: "input.promoted" }>,
): boolean {
  return (
    accepted.delivery === promoted.delivery &&
    accepted.content === promoted.content &&
    accepted.contentHash === promoted.contentHash &&
    sameInputAttachments(accepted.attachments, promoted.attachments)
  );
}

function sameInputAttachments(
  left: readonly InputAttachmentV1[] | undefined,
  right: readonly InputAttachmentV1[] | undefined,
): boolean {
  const leftItems = left ?? [];
  const rightItems = right ?? [];
  return (
    leftItems.length === rightItems.length &&
    leftItems.every((item, index) => {
      const other = rightItems[index];
      return (
        other !== undefined &&
        item.attachmentId === other.attachmentId &&
        item.type === other.type &&
        item.name === other.name &&
        item.mimeType === other.mimeType &&
        sameDurableJsonPayload(item.content, other.content)
      );
    })
  );
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) =>
        sameJsonValue(item, right[index] as JsonValue),
      )
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Readonly<Record<string, JsonValue>>;
  const rightRecord = right as Readonly<Record<string, JsonValue>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameJsonValue(
          leftRecord[key] as JsonValue,
          rightRecord[key] as JsonValue,
        ),
    )
  );
}

function assertInputFact(value: unknown): void {
  const fact = expectObject(value, "input fact");
  switch (fact.type) {
    case "attempt.started":
      assertExactKeys(fact, ["type", "goalHash", "configHash"], [], fact.type);
      assertNonEmptyString(fact.goalHash, "goalHash");
      assertNonEmptyString(fact.configHash, "configHash");
      return;
    case "input.accepted":
      assertExactKeys(
        fact,
        ["type", "inputId", "delivery", "content", "contentHash", "callerId"],
        ["attachments"],
        fact.type,
      );
      assertId(fact.inputId, "inputId");
      assertOneOf(fact.delivery, ["steer", "queue"], "delivery");
      assertNonEmptyString(fact.content, "content");
      assertNonEmptyString(fact.contentHash, "contentHash");
      assertId(fact.callerId, "callerId");
      if (hasOwn(fact, "attachments")) {
        assertInputAttachments(fact.attachments);
      }
      return;
    case "input.promoted":
      assertExactKeys(
        fact,
        ["type", "inputId", "delivery", "content", "contentHash"],
        ["attachments"],
        fact.type,
      );
      assertId(fact.inputId, "inputId");
      assertOneOf(fact.delivery, ["initial", "steer", "queue"], "delivery");
      assertNonEmptyString(fact.content, "content");
      assertNonEmptyString(fact.contentHash, "contentHash");
      if (hasOwn(fact, "attachments")) {
        assertInputAttachments(fact.attachments);
      }
      return;
    case "work.segment_started":
      assertExactKeys(
        fact,
        [
          "type",
          "segmentIndex",
          "inputId",
          "reducerVersion",
          "previousDecisionStateHash",
          "previousAction",
          "policyVersion",
        ],
        [],
        fact.type,
      );
      assertPositiveInteger(fact.segmentIndex, "segmentIndex");
      assertId(fact.inputId, "inputId");
      assertNonEmptyString(fact.reducerVersion, "reducerVersion");
      assertNonEmptyString(
        fact.previousDecisionStateHash,
        "previousDecisionStateHash",
      );
      assertControlDecisionAction(fact.previousAction, "previousAction");
      assertExact(
        fact.policyVersion,
        WORK_SEGMENT_POLICY_VERSION_V1,
        "policyVersion",
      );
      return;
    case "memory.retrieval_settled":
      assertExactKeys(
        fact,
        [
          "type",
          "queryId",
          "trigger",
          "providerVersion",
          "policyVersion",
          "status",
          "cards",
        ],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "queryId");
      assertOneOf(
        fact.trigger,
        ["task_start", "work_segment_start"],
        "memory trigger",
      );
      assertNonEmptyString(fact.providerVersion, "providerVersion");
      assertExact(
        fact.policyVersion,
        MEMORY_RETRIEVAL_POLICY_VERSION_V1,
        "policyVersion",
      );
      assertOneOf(
        fact.status,
        ["completed", "degraded", "failed", "disabled"],
        "memory status",
      );
      if (!Array.isArray(fact.cards) || fact.cards.length > 64) {
        throw new Error("memory cards must be a bounded array");
      }
      for (const card of fact.cards) assertMemoryCard(card);
      assertOptionalStringField(fact, "reasonCode");
      if (
        (fact.status === "failed" || fact.status === "disabled") &&
        fact.cards.length > 0
      ) {
        throw new Error(`${fact.status} memory retrieval cannot contain cards`);
      }
      return;
    case "memory.write_claimed":
      assertExactKeys(
        fact,
        [
          "type",
          "writeId",
          "trigger",
          "policyVersion",
          "extractorVersion",
          "scopeFingerprint",
          "sourceFromSeq",
          "sourceThroughSeq",
          "sourceInputHash",
          "claimedAt",
        ],
        [],
        fact.type,
      );
      assertId(fact.writeId, "memory writeId");
      assertOneOf(
        fact.trigger,
        ["task_terminal", "work_segment_terminal", "explicit_user_request"],
        "memory write trigger",
      );
      assertExact(
        fact.policyVersion,
        MEMORY_WRITE_POLICY_VERSION_V1,
        "memory write policyVersion",
      );
      assertNonEmptyString(fact.extractorVersion, "memory extractorVersion");
      assertNonEmptyString(fact.scopeFingerprint, "memory scopeFingerprint");
      assertPositiveInteger(fact.sourceFromSeq, "memory sourceFromSeq");
      assertPositiveInteger(fact.sourceThroughSeq, "memory sourceThroughSeq");
      if ((fact.sourceFromSeq as number) > (fact.sourceThroughSeq as number)) {
        throw new Error("memory source range is reversed");
      }
      assertNonEmptyString(fact.sourceInputHash, "memory sourceInputHash");
      assertNonNegativeInteger(fact.claimedAt, "memory claimedAt");
      return;
    case "memory.candidate_staged":
      assertExactKeys(
        fact,
        ["type", "writeId", "proposalHash", "atoms"],
        [],
        fact.type,
      );
      assertId(fact.writeId, "memory writeId");
      assertNonEmptyString(fact.proposalHash, "memory proposalHash");
      if (!Array.isArray(fact.atoms) || fact.atoms.length > 16) {
        throw new Error("memory atoms must be a bounded array");
      }
      for (const atom of fact.atoms) assertMemoryAtomProposal(atom);
      return;
    case "memory.write_settled":
      assertExactKeys(
        fact,
        [
          "type",
          "writeId",
          "status",
          "storedIds",
          "invalidatedIds",
          "skippedAtomIds",
          "settledAt",
        ],
        ["proposalHash", "reasonCode"],
        fact.type,
      );
      assertId(fact.writeId, "memory writeId");
      assertOneOf(
        fact.status,
        ["completed", "noop", "failed", "interrupted"],
        "memory write status",
      );
      assertOptionalStringField(fact, "proposalHash");
      assertOptionalStringField(fact, "reasonCode");
      for (const field of [
        "storedIds",
        "invalidatedIds",
        "skippedAtomIds",
      ] as const) {
        const ids = fact[field];
        if (!Array.isArray(ids) || ids.length > 32) {
          throw new Error(`${field} must be a bounded array`);
        }
        const seen = new Set<string>();
        for (const id of ids) {
          assertId(id, field);
          if (seen.has(id as string)) {
            throw new Error(`${field} must not contain duplicate ids`);
          }
          seen.add(id as string);
        }
      }
      assertNonNegativeInteger(fact.settledAt, "memory settledAt");
      return;
    case "memory.topic_organization_claimed":
      assertExactKeys(
        fact,
        [
          "type",
          "organizationId",
          "policyVersion",
          "extractorVersion",
          "scopeFingerprint",
          "sourceWriteId",
          "sourceProposalHash",
          "sourceMemoryIds",
          "sourceRevision",
          "claimedAt",
        ],
        [],
        fact.type,
      );
      assertId(fact.organizationId, "memory topic organizationId");
      assertExact(
        fact.policyVersion,
        MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1,
        "memory topic organization policyVersion",
      );
      assertNonEmptyString(
        fact.extractorVersion,
        "memory topic extractorVersion",
      );
      assertNonEmptyString(
        fact.scopeFingerprint,
        "memory topic scopeFingerprint",
      );
      assertId(fact.sourceWriteId, "memory topic sourceWriteId");
      assertNonEmptyString(
        fact.sourceProposalHash,
        "memory topic sourceProposalHash",
      );
      assertUniqueBoundedIds(
        fact.sourceMemoryIds,
        64,
        "memory topic sourceMemoryIds",
        true,
      );
      assertNonEmptyString(fact.sourceRevision, "memory topic sourceRevision");
      assertNonNegativeInteger(fact.claimedAt, "memory topic claimedAt");
      return;
    case "memory.topic_candidate_staged":
      assertExactKeys(
        fact,
        ["type", "organizationId", "proposalHash", "topics"],
        [],
        fact.type,
      );
      assertId(fact.organizationId, "memory topic organizationId");
      assertNonEmptyString(fact.proposalHash, "memory topic proposalHash");
      if (!Array.isArray(fact.topics) || fact.topics.length > 16) {
        throw new Error("memory topics must be a bounded array");
      }
      for (const topic of fact.topics) assertMemoryTopicProposal(topic);
      return;
    case "memory.topic_organization_settled":
      assertExactKeys(
        fact,
        [
          "type",
          "organizationId",
          "status",
          "topicIds",
          "snapshotIds",
          "settledAt",
        ],
        ["proposalHash", "reasonCode"],
        fact.type,
      );
      assertId(fact.organizationId, "memory topic organizationId");
      assertOneOf(
        fact.status,
        ["completed", "noop", "failed", "interrupted"],
        "memory topic organization status",
      );
      assertOptionalStringField(fact, "proposalHash");
      assertOptionalStringField(fact, "reasonCode");
      assertUniqueBoundedIds(fact.topicIds, 16, "memory topicIds", false);
      assertUniqueBoundedIds(
        fact.snapshotIds,
        16,
        "memory topic snapshotIds",
        false,
      );
      if (fact.topicIds.length !== fact.snapshotIds.length) {
        throw new Error(
          "memory topicIds and snapshotIds must have equal length",
        );
      }
      if (fact.status !== "completed" && fact.topicIds.length > 0) {
        throw new Error(
          "non-completed memory topic organization cannot publish ids",
        );
      }
      assertNonNegativeInteger(
        fact.settledAt,
        "memory topic organization settledAt",
      );
      return;
    case "memory.topic_evidence_settled": {
      assertExactKeys(
        fact,
        [
          "type",
          "queryId",
          "plannerVersion",
          "scopeFingerprint",
          "status",
          "indexRevision",
          "indexEntries",
          "evidenceStates",
          "settledAt",
        ],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "memory topic evidence queryId");
      assertExact(
        fact.plannerVersion,
        MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
        "memory topic evidence plannerVersion",
      );
      assertNonEmptyString(
        fact.scopeFingerprint,
        "memory topic evidence scopeFingerprint",
      );
      assertOneOf(
        fact.status,
        ["completed", "noop", "failed"],
        "memory topic evidence status",
      );
      assertNonEmptyString(
        fact.indexRevision,
        "memory topic evidence indexRevision",
      );
      if (!Array.isArray(fact.indexEntries) || fact.indexEntries.length > 128) {
        throw new Error("memory topic index entries must be a bounded array");
      }
      const topicIds = new Set<string>();
      const snapshotIds = new Set<string>();
      for (const entry of fact.indexEntries) {
        assertMemoryTopicIndexEntry(entry);
        if (topicIds.has(entry.topicId) || snapshotIds.has(entry.snapshotId)) {
          throw new Error("memory topic index identities must be unique");
        }
        topicIds.add(entry.topicId);
        snapshotIds.add(entry.snapshotId);
      }
      if (
        !Array.isArray(fact.evidenceStates) ||
        fact.evidenceStates.length > 32
      ) {
        throw new Error("memory topic evidence states must be a bounded array");
      }
      const evidenceIds = new Set<string>();
      for (const state of fact.evidenceStates) {
        assertMemoryTopicEvidenceState(state);
        if (
          !topicIds.has(state.topicId) ||
          !snapshotIds.has(state.snapshotId)
        ) {
          throw new Error("memory topic evidence is outside the settled index");
        }
        const identity = `${state.topicId}\n${state.trajectoryId}\n${state.memoryId}`;
        if (evidenceIds.has(identity)) {
          throw new Error("memory topic evidence states must be unique");
        }
        evidenceIds.add(identity);
      }
      assertOptionalStringField(fact, "reasonCode");
      if (fact.status === "completed" && fact.evidenceStates.length === 0) {
        throw new Error("completed memory topic evidence requires states");
      }
      if (fact.status !== "completed" && fact.evidenceStates.length > 0) {
        throw new Error(
          "non-completed memory topic evidence cannot contain states",
        );
      }
      if (fact.status === "failed" && fact.indexEntries.length > 0) {
        throw new Error("failed memory topic evidence cannot contain an index");
      }
      assertNonNegativeInteger(
        fact.settledAt,
        "memory topic evidence settledAt",
      );
      return;
    }
    case "memory.persona_projection_settled": {
      assertExactKeys(
        fact,
        [
          "type",
          "queryId",
          "projectorVersion",
          "scopeFingerprint",
          "status",
          "projectionRevision",
          "projectionKey",
          "claims",
          "sourceCount",
          "settledAt",
        ],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "memory persona projection queryId");
      assertExact(
        fact.projectorVersion,
        MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
        "memory persona projection projectorVersion",
      );
      assertNonEmptyString(
        fact.scopeFingerprint,
        "memory persona projection scopeFingerprint",
      );
      assertOneOf(
        fact.status,
        ["completed", "noop", "failed"],
        "memory persona projection status",
      );
      assertNonEmptyString(
        fact.projectionRevision,
        "memory persona projection revision",
      );
      assertNonEmptyString(fact.projectionKey, "memory persona projection key");
      if (!Array.isArray(fact.claims) || fact.claims.length > 64) {
        throw new Error("memory persona claims must be a bounded array");
      }
      const claimIds = new Set<string>();
      for (const claim of fact.claims) {
        assertMemoryPersonaClaim(claim);
        if (claimIds.has(claim.memoryId)) {
          throw new Error("memory persona claim identities must be unique");
        }
        claimIds.add(claim.memoryId);
      }
      assertNonNegativeInteger(
        fact.sourceCount,
        "memory persona projection sourceCount",
      );
      if ((fact.sourceCount as number) > 128) {
        throw new Error("memory persona projection sourceCount is too large");
      }
      assertOptionalStringField(fact, "reasonCode");
      if (fact.status === "completed" && fact.claims.length === 0) {
        throw new Error("completed memory persona projection requires claims");
      }
      if (fact.status !== "completed" && fact.claims.length > 0) {
        throw new Error(
          "non-completed memory persona projection cannot contain claims",
        );
      }
      if (fact.status !== "completed" && fact.sourceCount !== 0) {
        throw new Error(
          "non-completed memory persona projection cannot contain sources",
        );
      }
      assertNonNegativeInteger(
        fact.settledAt,
        "memory persona projection settledAt",
      );
      return;
    }
    case "memory.raw_evidence_settled": {
      assertExactKeys(
        fact,
        [
          "type",
          "queryId",
          "resolverVersion",
          "scopeFingerprint",
          "status",
          "resolutionRevision",
          "spans",
          "settledAt",
        ],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "memory raw evidence queryId");
      assertExact(
        fact.resolverVersion,
        MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
        "memory raw evidence resolverVersion",
      );
      assertNonEmptyString(
        fact.scopeFingerprint,
        "memory raw evidence scopeFingerprint",
      );
      assertOneOf(
        fact.status,
        ["completed", "noop", "failed"],
        "memory raw evidence status",
      );
      assertNonEmptyString(
        fact.resolutionRevision,
        "memory raw evidence resolutionRevision",
      );
      if (!Array.isArray(fact.spans) || fact.spans.length > 16) {
        throw new Error("memory raw evidence spans must be a bounded array");
      }
      const refs = new Set<string>();
      let totalChars = 0;
      for (const span of fact.spans) {
        assertMemoryRawEvidenceSpan(span);
        if (refs.has(span.evidenceRef)) {
          throw new Error("memory raw evidence refs must be unique");
        }
        refs.add(span.evidenceRef);
        totalChars += span.content.length;
      }
      if (totalChars > 16_384) {
        throw new Error("memory raw evidence content is too large");
      }
      assertOptionalStringField(fact, "reasonCode");
      if (fact.status === "completed" && fact.spans.length === 0) {
        throw new Error("completed memory raw evidence requires spans");
      }
      if (fact.status !== "completed" && fact.spans.length > 0) {
        throw new Error(
          "non-completed memory raw evidence cannot contain spans",
        );
      }
      assertNonNegativeInteger(fact.settledAt, "memory raw evidence settledAt");
      return;
    }
    case "memory.evidence_coverage_settled": {
      assertExactKeys(
        fact,
        [
          "type",
          "queryId",
          "plannerVersion",
          "scopeFingerprint",
          "status",
          "planRevision",
          "requirements",
          "coverage",
          "supplementalStates",
          "spans",
          "settledAt",
        ],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "memory evidence coverage queryId");
      assertExact(
        fact.plannerVersion,
        MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1,
        "memory evidence coverage plannerVersion",
      );
      assertNonEmptyString(
        fact.scopeFingerprint,
        "memory evidence coverage scopeFingerprint",
      );
      assertOneOf(
        fact.status,
        ["completed", "noop", "failed"],
        "memory evidence coverage status",
      );
      assertNonEmptyString(
        fact.planRevision,
        "memory evidence coverage planRevision",
      );
      if (!Array.isArray(fact.requirements) || fact.requirements.length > 6) {
        throw new Error("memory evidence requirements must be a bounded array");
      }
      const requirementIds = new Set<string>();
      let requirementChars = 0;
      for (const requirement of fact.requirements) {
        assertMemoryEvidenceRequirement(requirement);
        if (requirementIds.has(requirement.requirementId)) {
          throw new Error("memory evidence requirement ids must be unique");
        }
        requirementIds.add(requirement.requirementId);
        requirementChars += requirement.description.length;
      }
      if (requirementChars > 4_096) {
        throw new Error("memory evidence requirements are too large");
      }
      if (
        !Array.isArray(fact.coverage) ||
        fact.coverage.length !== fact.requirements.length
      ) {
        throw new Error("memory evidence coverage must match requirements");
      }
      const coverageRequirementIds = new Set<string>();
      const coveredMemoryIds = new Set<string>();
      const expandedTopicIds = new Set<string>();
      for (const item of fact.coverage) {
        assertMemoryEvidenceCoverageItem(item);
        if (
          !requirementIds.has(item.requirementId) ||
          coverageRequirementIds.has(item.requirementId)
        ) {
          throw new Error("memory evidence coverage requirement is invalid");
        }
        coverageRequirementIds.add(item.requirementId);
        for (const id of item.memoryIds) coveredMemoryIds.add(id);
        for (const id of item.topicIds) expandedTopicIds.add(id);
      }
      if (
        !Array.isArray(fact.supplementalStates) ||
        fact.supplementalStates.length > 16
      ) {
        throw new Error("memory supplemental states must be a bounded array");
      }
      const supplementalIds = new Set<string>();
      let supplementalChars = 0;
      for (const state of fact.supplementalStates) {
        assertMemoryTopicEvidenceState(state);
        if (
          supplementalIds.has(state.memoryId) ||
          !expandedTopicIds.has(state.topicId) ||
          !coveredMemoryIds.has(state.memoryId)
        ) {
          throw new Error("memory supplemental state is outside coverage");
        }
        supplementalIds.add(state.memoryId);
        supplementalChars += state.statement.length;
      }
      if (supplementalChars > 8_192) {
        throw new Error("memory supplemental states are too large");
      }
      if (!Array.isArray(fact.spans) || fact.spans.length > 16) {
        throw new Error("memory coverage spans must be a bounded array");
      }
      const spanRefs = new Set<string>();
      let spanChars = 0;
      for (const span of fact.spans) {
        assertMemoryRawEvidenceSpan(span);
        if (
          spanRefs.has(span.evidenceRef) ||
          span.memoryIds.some(
            (id: unknown) =>
              typeof id !== "string" || !coveredMemoryIds.has(id),
          )
        ) {
          throw new Error("memory coverage span is outside covered evidence");
        }
        spanRefs.add(span.evidenceRef);
        spanChars += span.content.length;
      }
      if (spanChars > 16_384) {
        throw new Error("memory coverage span content is too large");
      }
      assertOptionalStringField(fact, "reasonCode");
      if (fact.status === "completed" && fact.requirements.length === 0) {
        throw new Error("completed memory evidence coverage requires a plan");
      }
      if (
        fact.status !== "completed" &&
        (fact.requirements.length > 0 ||
          fact.coverage.length > 0 ||
          fact.supplementalStates.length > 0 ||
          fact.spans.length > 0)
      ) {
        throw new Error(
          "non-completed memory evidence coverage cannot contain a plan",
        );
      }
      assertNonNegativeInteger(
        fact.settledAt,
        "memory evidence coverage settledAt",
      );
      return;
    }
    case "model.dispatch_recorded":
      assertExactKeys(
        fact,
        ["type", "modelCallId", "turn", "requestHash"],
        [],
        fact.type,
      );
      assertId(fact.modelCallId, "modelCallId");
      assertPositiveInteger(fact.turn, "turn");
      assertNonEmptyString(fact.requestHash, "requestHash");
      return;
    case "model.settled":
      assertExactKeys(
        fact,
        [
          "type",
          "modelCallId",
          "turn",
          "status",
          "hasToolCalls",
          "hasVisibleOutput",
        ],
        ["response", "finishReason", "errorCode"],
        fact.type,
      );
      assertId(fact.modelCallId, "modelCallId");
      assertPositiveInteger(fact.turn, "turn");
      assertOneOf(
        fact.status,
        [
          "completed",
          "truncated",
          "failed",
          "cancelled",
          "unknown",
          "rejected",
        ],
        "model status",
      );
      assertBoolean(fact.hasToolCalls, "hasToolCalls");
      assertBoolean(fact.hasVisibleOutput, "hasVisibleOutput");
      if (hasOwn(fact, "response")) {
        assertDurableJsonPayload(fact.response, "response");
        const response = fact.response as DurableJsonPayloadV1;
        if (response.kind === "inline") {
          assertModelResponse(response.value);
        }
      }
      assertOptionalStringField(fact, "finishReason");
      assertOptionalStringField(fact, "errorCode");
      if (
        (fact.status === "completed" || fact.status === "truncated") &&
        fact.response === undefined
      ) {
        throw new Error(
          `${fact.status} model settlement requires a durable response`,
        );
      }
      if (
        (fact.status === "failed" || fact.status === "rejected") &&
        fact.errorCode === undefined
      ) {
        throw new Error(`${fact.status} model settlement requires errorCode`);
      }
      return;
    case "tool.call_observed":
      assertExactKeys(
        fact,
        ["type", "callId", "modelCallId", "turn", "tool", "args", "order"],
        [],
        fact.type,
      );
      assertId(fact.callId, "callId");
      assertId(fact.modelCallId, "modelCallId");
      assertPositiveInteger(fact.turn, "turn");
      assertNonEmptyString(fact.tool, "tool");
      assertJsonValue(fact.args, "args");
      assertNonNegativeInteger(fact.order, "order");
      return;
    case "tool.dispatch_recorded":
      assertExactKeys(
        fact,
        ["type", "callId", "turn", "sourceIndex", "batchId", "mode"],
        [],
        fact.type,
      );
      assertId(fact.callId, "callId");
      assertPositiveInteger(fact.turn, "turn");
      assertNonNegativeInteger(fact.sourceIndex, "sourceIndex");
      assertId(fact.batchId, "batchId");
      assertOneOf(fact.mode, ["serial", "parallel"], "dispatch mode");
      return;
    case "tool.permission_resolved":
      assertExactKeys(
        fact,
        [
          "type",
          "turn",
          "sourceIndex",
          "callId",
          "tool",
          "policyVersion",
          "resolution",
          "source",
        ],
        ["ruleId"],
        fact.type,
      );
      assertPositiveInteger(fact.turn, "turn");
      assertNonNegativeInteger(fact.sourceIndex, "sourceIndex");
      assertId(fact.callId, "callId");
      assertNonEmptyString(fact.tool, "tool");
      assertNonEmptyString(fact.policyVersion, "policyVersion");
      assertOneOf(
        fact.resolution,
        ["allow_once", "allow_rule", "deny"],
        "permission resolution",
      );
      assertOneOf(
        fact.source,
        ["base_policy", "user_prompt", "run_rule"],
        "permission source",
      );
      if (hasOwn(fact, "ruleId")) assertId(fact.ruleId, "ruleId");
      if (fact.resolution === "allow_rule" && !hasOwn(fact, "ruleId")) {
        throw new Error("allow_rule permission requires ruleId");
      }
      if (fact.source === "run_rule" && fact.resolution !== "allow_rule") {
        throw new Error("run_rule source requires allow_rule resolution");
      }
      if (fact.source === "base_policy" && fact.resolution === "allow_rule") {
        throw new Error("base_policy cannot create allow_rule permission");
      }
      return;
    case "tool.effect_checkpoint_allocated":
      assertExactKeys(
        fact,
        ["type", "callId", "turn", "sourceIndex", "checkpointSeq"],
        [],
        fact.type,
      );
      assertId(fact.callId, "callId");
      assertPositiveInteger(fact.turn, "turn");
      assertNonNegativeInteger(fact.sourceIndex, "sourceIndex");
      assertPositiveInteger(fact.checkpointSeq, "checkpointSeq");
      return;
    case "tool.settled":
      assertExactKeys(
        fact,
        ["type", "callId", "status"],
        ["result", "resultHash", "errorCode", "observation"],
        fact.type,
      );
      assertId(fact.callId, "callId");
      assertOneOf(
        fact.status,
        ["completed", "failed", "cancelled", "unknown", "rejected"],
        "tool status",
      );
      if (hasOwn(fact, "result")) assertJsonValue(fact.result, "result");
      assertOptionalStringField(fact, "resultHash");
      assertOptionalStringField(fact, "errorCode");
      if (hasOwn(fact, "observation")) {
        assertToolObservation(fact.observation, "observation");
        const observation = fact.observation as ToolObservationV1;
        if (fact.status !== "completed" && !observation.isError) {
          throw new Error(
            `${fact.status} tool settlement observation must be an error`,
          );
        }
      }
      if (
        (fact.status === "failed" || fact.status === "rejected") &&
        fact.errorCode === undefined
      ) {
        throw new Error(`${fact.status} tool settlement requires errorCode`);
      }
      return;
    case "runtime.activity_started":
      assertExactKeys(
        fact,
        ["type", "activityId", "activityKind", "label", "startedAt"],
        ["metadata"],
        fact.type,
      );
      assertId(fact.activityId, "activityId");
      assertId(fact.activityKind, "activityKind");
      assertSingleLineString(fact.label, "label");
      assertNonNegativeInteger(fact.startedAt, "startedAt");
      if (hasOwn(fact, "metadata")) {
        assertJsonValue(fact.metadata, "metadata");
      }
      return;
    case "runtime.activity_settled":
      assertExactKeys(
        fact,
        ["type", "activityId", "status", "settledAt", "summary"],
        [],
        fact.type,
      );
      assertId(fact.activityId, "activityId");
      assertOneOf(
        fact.status,
        ["completed", "failed", "cancelled", "unknown"],
        "runtime activity status",
      );
      assertNonNegativeInteger(fact.settledAt, "settledAt");
      assertSingleLineString(fact.summary, "summary");
      return;
    case "abort.requested":
      assertExactKeys(fact, ["type", "source"], ["reason"], fact.type);
      assertOneOf(fact.source, ["user", "host", "signal"], "abort source");
      assertOptionalStringField(fact, "reason");
      return;
    case "runtime.failed":
      assertExactKeys(
        fact,
        ["type", "area", "errorCode", "message", "retryable"],
        [],
        fact.type,
      );
      assertOneOf(fact.area, ["input", "context", "runtime"], "failure area");
      assertId(fact.errorCode, "errorCode");
      assertNonEmptyString(fact.message, "message");
      assertBoolean(fact.retryable, "retryable");
      return;
    case "policy.request_recorded":
      assertExactKeys(
        fact,
        ["type", "policyId", "policyVersion", "request", "reasonCode"],
        [],
        fact.type,
      );
      assertId(fact.policyId, "policyId");
      assertNonEmptyString(fact.policyVersion, "policyVersion");
      assertOneOf(
        fact.request,
        ["continue", "wait", "complete", "incomplete"],
        "policy request",
      );
      assertId(fact.reasonCode, "reasonCode");
      return;
    case "completion.review_claimed":
      assertExactKeys(
        fact,
        [
          "type",
          "reviewId",
          "candidateHash",
          "policyVersion",
          "reviewerId",
          "triggers",
          "sourceThroughSeq",
          "claimedAt",
        ],
        [],
        fact.type,
      );
      assertId(fact.reviewId, "reviewId");
      if (
        typeof fact.candidateHash !== "string" ||
        !/^[0-9a-f]{64}$/u.test(fact.candidateHash)
      ) {
        throw new Error("completion review candidateHash must be sha256 hex");
      }
      assertExact(
        fact.policyVersion,
        COMPLETION_REVIEW_POLICY_VERSION_V1,
        "policyVersion",
      );
      assertId(fact.reviewerId, "reviewerId");
      if (!Array.isArray(fact.triggers) || fact.triggers.length === 0) {
        throw new Error("completion review triggers must be non-empty");
      }
      for (const trigger of fact.triggers) {
        assertOneOf(
          trigger,
          [
            "user_requested",
            "project_required",
            "non_trivial_change",
            "missing_fresh_verification",
            "fresh_verification_failed",
            "fresh_verification_inconclusive",
            "model_requested",
          ],
          "completion review trigger",
        );
      }
      if (new Set(fact.triggers).size !== fact.triggers.length) {
        throw new Error("completion review triggers must be unique");
      }
      assertPositiveInteger(fact.sourceThroughSeq, "sourceThroughSeq");
      assertNonNegativeInteger(fact.claimedAt, "claimedAt");
      return;
    case "completion.review_settled":
      assertExactKeys(
        fact,
        [
          "type",
          "reviewId",
          "status",
          "verdict",
          "reasonCode",
          "summary",
          "settledAt",
        ],
        [],
        fact.type,
      );
      assertId(fact.reviewId, "reviewId");
      assertOneOf(
        fact.status,
        ["completed", "failed", "cancelled", "unknown"],
        "completion review status",
      );
      assertOneOf(
        fact.verdict,
        ["allow", "block", "await_user", "unknown"],
        "completion review verdict",
      );
      assertId(fact.reasonCode, "reasonCode");
      assertSingleLineString(fact.summary, "summary");
      assertNonNegativeInteger(fact.settledAt, "settledAt");
      if (fact.status === "completed" && fact.verdict === "unknown") {
        throw new Error("completed completion review requires a verdict");
      }
      if (fact.status !== "completed" && fact.verdict !== "unknown") {
        throw new Error("non-completed completion review must be unknown");
      }
      return;
    case "context.checkpoint_distillation_claimed": {
      assertExactKeys(
        fact,
        [
          "type",
          "claimId",
          "checkpointId",
          "boundary",
          "policyVersion",
          "sourceFromSeq",
          "sourceThroughSeq",
          "sourceInputHash",
        ],
        ["supersedesCheckpointId"],
        fact.type,
      );
      assertId(fact.claimId, "claimId");
      assertId(fact.checkpointId, "checkpointId");
      assertOneOf(
        fact.boundary,
        ["after_model_turn_without_tool_calls", "after_tool_batch_settled"],
        "checkpoint distillation boundary",
      );
      if (hasOwn(fact, "supersedesCheckpointId")) {
        assertId(fact.supersedesCheckpointId, "supersedesCheckpointId");
      }
      assertId(fact.policyVersion, "policyVersion");
      assertPositiveInteger(fact.sourceFromSeq, "sourceFromSeq");
      assertPositiveInteger(fact.sourceThroughSeq, "sourceThroughSeq");
      if ((fact.sourceFromSeq as number) > (fact.sourceThroughSeq as number)) {
        throw new Error(
          "context checkpoint distillation source range is invalid",
        );
      }
      assertSingleLineString(fact.sourceInputHash, "sourceInputHash");
      return;
    }
    case "context.checkpoint_distillation_settled": {
      assertExactKeys(
        fact,
        ["type", "claimId", "status"],
        ["checkpoint", "errorCode"],
        fact.type,
      );
      assertId(fact.claimId, "claimId");
      assertOneOf(
        fact.status,
        ["completed", "failed", "cancelled", "unknown", "truncated"],
        "checkpoint distillation status",
      );
      if (hasOwn(fact, "checkpoint")) {
        assertDurableJsonPayload(fact.checkpoint, "checkpoint");
        const checkpoint = fact.checkpoint as DurableJsonPayloadV1;
        if (checkpoint.kind === "inline") {
          assertTaskCheckpoint(checkpoint.value, "checkpoint.value");
        }
      }
      assertOptionalStringField(fact, "errorCode");
      if (fact.status === "completed" && !hasOwn(fact, "checkpoint")) {
        throw new Error(
          "completed checkpoint distillation requires checkpoint",
        );
      }
      if (fact.status !== "completed" && hasOwn(fact, "checkpoint")) {
        throw new Error(
          "non-completed checkpoint distillation cannot persist checkpoint",
        );
      }
      if (fact.status !== "completed" && !hasOwn(fact, "errorCode")) {
        throw new Error(
          "non-completed checkpoint distillation requires errorCode",
        );
      }
      if (fact.status === "completed" && hasOwn(fact, "errorCode")) {
        throw new Error(
          "completed checkpoint distillation cannot carry errorCode",
        );
      }
      return;
    }
    case "context.checkpoint_recorded": {
      assertExactKeys(
        fact,
        [
          "type",
          "checkpointId",
          "policyVersion",
          "sourceFromSeq",
          "sourceThroughSeq",
          "sourceInputHash",
          "checkpoint",
        ],
        ["distillationClaimId", "supersedesCheckpointId"],
        fact.type,
      );
      assertId(fact.checkpointId, "checkpointId");
      if (hasOwn(fact, "distillationClaimId")) {
        assertId(fact.distillationClaimId, "distillationClaimId");
      }
      if (hasOwn(fact, "supersedesCheckpointId")) {
        assertId(fact.supersedesCheckpointId, "supersedesCheckpointId");
      }
      assertId(fact.policyVersion, "policyVersion");
      assertPositiveInteger(fact.sourceFromSeq, "sourceFromSeq");
      assertPositiveInteger(fact.sourceThroughSeq, "sourceThroughSeq");
      if ((fact.sourceFromSeq as number) > (fact.sourceThroughSeq as number)) {
        throw new Error("context checkpoint source range is invalid");
      }
      assertSingleLineString(fact.sourceInputHash, "sourceInputHash");
      assertDurableJsonPayload(fact.checkpoint, "checkpoint");
      const payload = fact.checkpoint as DurableJsonPayloadV1;
      if (payload.kind === "inline") {
        assertTaskCheckpoint(payload.value, "checkpoint.value");
        assertCheckpointSourcesInRange(
          payload.value as unknown as TaskCheckpointV1,
          fact.sourceFromSeq as number,
          fact.sourceThroughSeq as number,
        );
      }
      return;
    }
    default:
      throw new Error("Unsupported input fact type");
  }
}

function assertMemoryCard(value: unknown): void {
  const card = expectObject(value, "memory card");
  assertExactKeys(
    card,
    [
      "id",
      "revision",
      "kind",
      "statement",
      "applicability",
      "scope",
      "sources",
      "confidence",
      "contentHash",
    ],
    [],
    "memory card",
  );
  assertId(card.id, "memory card id");
  assertPositiveInteger(card.revision, "memory card revision");
  assertOneOf(
    card.kind,
    ["semantic", "episodic", "procedural", "profile", "trial"],
    "memory card kind",
  );
  assertNonEmptyString(card.statement, "memory card statement");
  if ((card.statement as string).length > 16_384) {
    throw new Error("memory card statement is too large");
  }
  assertOneOf(
    card.applicability,
    ["applicable", "reference", "trial"],
    "memory card applicability",
  );
  const scope = expectObject(card.scope, "memory card scope");
  assertExactKeys(scope, ["repositoryId"], ["branch"], "memory card scope");
  assertNonEmptyString(scope.repositoryId, "memory card repositoryId");
  assertOptionalStringField(scope, "branch");
  if (
    !Array.isArray(card.sources) ||
    card.sources.length === 0 ||
    card.sources.length > 32
  ) {
    throw new Error("memory card sources must be a non-empty bounded array");
  }
  for (const value of card.sources) {
    const source = expectObject(value, "memory card source");
    assertExactKeys(source, ["kind", "ref"], [], "memory card source");
    assertExact(source.kind, "memory_store_evidence", "memory source kind");
    assertNonEmptyString(source.ref, "memory source ref");
  }
  if (
    typeof card.confidence !== "number" ||
    !Number.isFinite(card.confidence) ||
    card.confidence < 0 ||
    card.confidence > 1
  ) {
    throw new Error("memory card confidence must be between 0 and 1");
  }
  assertNonEmptyString(card.contentHash, "memory card contentHash");
}

function assertMemoryAtomProposal(value: unknown): void {
  const atom = expectObject(value, "memory atom proposal");
  assertExactKeys(
    atom,
    [
      "schemaVersion",
      "atomId",
      "kind",
      "action",
      "statement",
      "keywords",
      "authority",
      "confidence",
      "priority",
      "sourceSeqs",
      "targetIds",
      "contentHash",
    ],
    ["validFrom", "validTo"],
    "memory atom proposal",
  );
  assertExact(
    atom.schemaVersion,
    MEMORY_ATOM_PROPOSAL_SCHEMA_VERSION_V1,
    "memory atom schemaVersion",
  );
  assertId(atom.atomId, "memory atomId");
  assertOneOf(
    atom.kind,
    ["semantic", "episodic", "profile", "instruction"],
    "memory atom kind",
  );
  assertOneOf(
    atom.action,
    ["store", "update", "merge", "skip"],
    "memory atom action",
  );
  assertNonEmptyString(atom.statement, "memory atom statement");
  if ((atom.statement as string).length > 4_096) {
    throw new Error("memory atom statement is too large");
  }
  if (!Array.isArray(atom.keywords) || atom.keywords.length > 12) {
    throw new Error("memory atom keywords must be a bounded array");
  }
  for (const keyword of atom.keywords) {
    assertSingleLineString(keyword, "memory atom keyword");
  }
  assertOneOf(
    atom.authority,
    ["user_asserted", "agent_verified", "agent_inferred"],
    "memory atom authority",
  );
  if (
    typeof atom.confidence !== "number" ||
    !Number.isFinite(atom.confidence) ||
    atom.confidence < 0 ||
    atom.confidence > 1
  ) {
    throw new Error("memory atom confidence must be between 0 and 1");
  }
  if (
    !Number.isSafeInteger(atom.priority) ||
    (atom.priority as number) < 0 ||
    (atom.priority as number) > 100
  ) {
    throw new Error("memory atom priority must be between 0 and 100");
  }
  if (
    !Array.isArray(atom.sourceSeqs) ||
    atom.sourceSeqs.length === 0 ||
    atom.sourceSeqs.length > 32
  ) {
    throw new Error("memory atom sourceSeqs must be a non-empty bounded array");
  }
  let previousSeq = 0;
  for (const seq of atom.sourceSeqs) {
    assertPositiveInteger(seq, "memory atom sourceSeq");
    if ((seq as number) <= previousSeq) {
      throw new Error("memory atom sourceSeqs must be strictly increasing");
    }
    previousSeq = seq as number;
  }
  if (!Array.isArray(atom.targetIds) || atom.targetIds.length > 16) {
    throw new Error("memory atom targetIds must be a bounded array");
  }
  const targets = new Set<string>();
  for (const id of atom.targetIds) {
    assertId(id, "memory atom targetId");
    if (targets.has(id as string)) {
      throw new Error("memory atom targetIds must be unique");
    }
    targets.add(id as string);
  }
  if (atom.action === "store" && atom.targetIds.length > 0) {
    throw new Error("store memory atom cannot target existing ids");
  }
  if (
    (atom.action === "update" || atom.action === "merge") &&
    atom.targetIds.length === 0
  ) {
    throw new Error(`${atom.action as string} memory atom requires targets`);
  }
  assertOptionalStringField(atom, "validFrom");
  assertOptionalStringField(atom, "validTo");
  assertNonEmptyString(atom.contentHash, "memory atom contentHash");
}

function assertMemoryTopicProposal(value: unknown): void {
  const topic = expectObject(value, "memory topic proposal");
  assertExactKeys(
    topic,
    [
      "schemaVersion",
      "proposalId",
      "scopeFingerprint",
      "family",
      "canonicalName",
      "normalizedName",
      "members",
      "confidence",
    ],
    ["targetTopicId"],
    "memory topic proposal",
  );
  assertExact(
    topic.schemaVersion,
    MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1,
    "memory topic schemaVersion",
  );
  assertId(topic.proposalId, "memory topic proposalId");
  assertNonEmptyString(topic.scopeFingerprint, "memory topic scopeFingerprint");
  assertOneOf(
    topic.family,
    ["semantic", "episodic", "profile", "instruction", "mixed"],
    "memory topic family",
  );
  assertSingleLineString(topic.canonicalName, "memory topic canonicalName");
  assertSingleLineString(topic.normalizedName, "memory topic normalizedName");
  if (
    (topic.canonicalName as string).length > 96 ||
    (topic.normalizedName as string).length > 96
  ) {
    throw new Error("memory topic name is too large");
  }
  if (hasOwn(topic, "targetTopicId")) {
    assertId(topic.targetTopicId, "memory topic targetTopicId");
  }
  if (
    !Array.isArray(topic.members) ||
    topic.members.length === 0 ||
    topic.members.length > 256
  ) {
    throw new Error("memory topic members must be a non-empty bounded array");
  }
  const memberIds = new Set<string>();
  for (const value of topic.members) {
    const member = expectObject(value, "memory topic member");
    assertExactKeys(
      member,
      ["memoryId", "role", "confidence", "basis"],
      [],
      "memory topic member",
    );
    assertId(member.memoryId, "memory topic member memoryId");
    assertOneOf(
      member.role,
      ["primary", "supporting"],
      "memory topic member role",
    );
    assertUnitInterval(member.confidence, "memory topic member confidence");
    assertOneOf(
      member.basis,
      ["model_proposed", "explicit_relation", "user_asserted"],
      "memory topic member basis",
    );
    if (memberIds.has(member.memoryId as string)) {
      throw new Error("memory topic members must have unique memory ids");
    }
    memberIds.add(member.memoryId as string);
  }
  assertUnitInterval(topic.confidence, "memory topic confidence");
}

function assertMemoryTopicIndexEntry(value: unknown): void {
  const entry = expectObject(value, "memory topic index entry");
  assertExactKeys(
    entry,
    [
      "topicId",
      "snapshotId",
      "family",
      "canonicalName",
      "normalizedName",
      "memberCount",
      "trajectoryCount",
      "projectionHash",
    ],
    [],
    "memory topic index entry",
  );
  assertId(entry.topicId, "memory topic index topicId");
  assertId(entry.snapshotId, "memory topic index snapshotId");
  assertOneOf(
    entry.family,
    ["semantic", "episodic", "profile", "instruction", "mixed"],
    "memory topic index family",
  );
  assertSingleLineString(
    entry.canonicalName,
    "memory topic index canonicalName",
  );
  assertSingleLineString(
    entry.normalizedName,
    "memory topic index normalizedName",
  );
  if (
    (entry.canonicalName as string).length > 96 ||
    (entry.normalizedName as string).length > 96
  ) {
    throw new Error("memory topic index name is too large");
  }
  assertNonNegativeInteger(entry.memberCount, "memory topic index memberCount");
  assertNonNegativeInteger(
    entry.trajectoryCount,
    "memory topic index trajectoryCount",
  );
  assertNonEmptyString(
    entry.projectionHash,
    "memory topic index projectionHash",
  );
}

function assertMemoryTopicEvidenceState(value: unknown): void {
  const state = expectObject(value, "memory topic evidence state");
  assertExactKeys(
    state,
    [
      "topicId",
      "snapshotId",
      "trajectoryId",
      "memoryId",
      "state",
      "statement",
      "validFrom",
      "evidenceRefs",
    ],
    ["validTo"],
    "memory topic evidence state",
  );
  assertId(state.topicId, "memory topic evidence topicId");
  assertId(state.snapshotId, "memory topic evidence snapshotId");
  assertId(state.trajectoryId, "memory topic evidence trajectoryId");
  assertId(state.memoryId, "memory topic evidence memoryId");
  assertOneOf(
    state.state,
    ["current", "historical"],
    "memory topic evidence state kind",
  );
  assertNonEmptyString(state.statement, "memory topic evidence statement");
  if ((state.statement as string).length > 4_096) {
    throw new Error("memory topic evidence statement is too large");
  }
  assertNonEmptyString(state.validFrom, "memory topic evidence validFrom");
  assertOptionalStringField(state, "validTo");
  if (!Array.isArray(state.evidenceRefs) || state.evidenceRefs.length > 32) {
    throw new Error("memory topic evidence refs must be a bounded array");
  }
  const refs = new Set<string>();
  for (const ref of state.evidenceRefs) {
    assertNonEmptyString(ref, "memory topic evidence ref");
    if (refs.has(ref as string)) {
      throw new Error("memory topic evidence refs must be unique");
    }
    refs.add(ref as string);
  }
}

function assertMemoryPersonaClaim(value: unknown): void {
  const claim = expectObject(value, "memory persona claim");
  assertExactKeys(
    claim,
    [
      "memoryId",
      "kind",
      "statement",
      "confidence",
      "validFrom",
      "evidenceRefs",
    ],
    [],
    "memory persona claim",
  );
  assertId(claim.memoryId, "memory persona claim memoryId");
  assertOneOf(claim.kind, ["profile"], "memory persona claim kind");
  assertNonEmptyString(claim.statement, "memory persona claim statement");
  if ((claim.statement as string).length > 4_096) {
    throw new Error("memory persona claim statement is too large");
  }
  assertUnitInterval(claim.confidence, "memory persona claim confidence");
  assertNonEmptyString(claim.validFrom, "memory persona claim validFrom");
  if (!Array.isArray(claim.evidenceRefs) || claim.evidenceRefs.length > 32) {
    throw new Error("memory persona claim refs must be a bounded array");
  }
  const refs = new Set<string>();
  for (const ref of claim.evidenceRefs) {
    assertNonEmptyString(ref, "memory persona claim ref");
    if ((ref as string).length > 1_024) {
      throw new Error("memory persona claim ref is too large");
    }
    if (refs.has(ref as string)) {
      throw new Error("memory persona claim refs must be unique");
    }
    refs.add(ref as string);
  }
}

function assertMemoryRawEvidenceSpan(value: unknown): void {
  const span = expectObject(value, "memory raw evidence span");
  assertExactKeys(
    span,
    ["evidenceRef", "memoryIds", "content", "contentHash"],
    [],
    "memory raw evidence span",
  );
  assertNonEmptyString(span.evidenceRef, "memory raw evidence ref");
  if ((span.evidenceRef as string).length > 1_024) {
    throw new Error("memory raw evidence ref is too large");
  }
  assertUniqueBoundedIds(
    span.memoryIds,
    32,
    "memory raw evidence memoryIds",
    true,
  );
  assertNonEmptyString(span.content, "memory raw evidence content");
  if ((span.content as string).length > 8_192) {
    throw new Error("memory raw evidence span content is too large");
  }
  assertNonEmptyString(span.contentHash, "memory raw evidence contentHash");
}

function assertMemoryEvidenceRequirement(
  value: unknown,
): asserts value is MemoryEvidenceRequirementV1 {
  const requirement = expectObject(value, "memory evidence requirement");
  assertExactKeys(
    requirement,
    ["requirementId", "description", "priority", "minimumEvidence"],
    [],
    "memory evidence requirement",
  );
  assertId(requirement.requirementId, "memory evidence requirementId");
  assertSingleLineString(
    requirement.description,
    "memory evidence requirement description",
  );
  if ((requirement.description as string).length > 1_024) {
    throw new Error("memory evidence requirement description is too large");
  }
  assertOneOf(
    requirement.priority,
    ["required", "supporting"],
    "memory evidence requirement priority",
  );
  assertPositiveInteger(
    requirement.minimumEvidence,
    "memory evidence minimumEvidence",
  );
  if ((requirement.minimumEvidence as number) > 3) {
    throw new Error("memory evidence minimumEvidence is too large");
  }
}

function assertMemoryEvidenceCoverageItem(
  value: unknown,
): asserts value is MemoryEvidenceCoverageItemV1 {
  const item = expectObject(value, "memory evidence coverage item");
  assertExactKeys(
    item,
    ["requirementId", "status", "memoryIds", "topicIds"],
    [],
    "memory evidence coverage item",
  );
  assertId(item.requirementId, "memory evidence coverage requirementId");
  assertOneOf(
    item.status,
    ["covered", "partial", "missing"],
    "memory evidence coverage item status",
  );
  assertUniqueBoundedIds(
    item.memoryIds,
    16,
    "memory evidence coverage memoryIds",
    false,
  );
  assertUniqueBoundedIds(
    item.topicIds,
    8,
    "memory evidence coverage topicIds",
    false,
  );
  if (item.status === "missing" && item.memoryIds.length > 0) {
    throw new Error(
      "missing memory evidence coverage cannot contain memoryIds",
    );
  }
  if (item.status === "covered" && item.memoryIds.length === 0) {
    throw new Error("covered memory evidence coverage requires memoryIds");
  }
}

function assertUniqueBoundedIds(
  value: unknown,
  maximumLength: number,
  field: string,
  requireNonEmpty: boolean,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximumLength ||
    (requireNonEmpty && value.length === 0)
  ) {
    throw new Error(`${field} must be a bounded array`);
  }
  const ids = new Set<string>();
  for (const id of value) {
    assertId(id, field);
    if (ids.has(id as string)) {
      throw new Error(`${field} must not contain duplicate ids`);
    }
    ids.add(id as string);
  }
}

function assertUnitInterval(value: unknown, field: string): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`${field} must be between 0 and 1`);
  }
}

function assertTaskCheckpoint(value: unknown, field: string): void {
  const checkpoint = expectObject(value, field);
  assertExactKeys(
    checkpoint,
    [
      "schemaVersion",
      "confirmedFacts",
      "currentHypotheses",
      "ruledOut",
      "changedFiles",
      "verification",
      "unresolved",
    ],
    ["goal", "nextAction"],
    field,
  );
  assertExact(
    checkpoint.schemaVersion,
    TASK_CHECKPOINT_SCHEMA_VERSION_V1,
    `${field}.schemaVersion`,
  );
  if (hasOwn(checkpoint, "goal")) {
    assertTaskCheckpointItem(checkpoint.goal, `${field}.goal`);
  }
  if (hasOwn(checkpoint, "nextAction")) {
    assertTaskCheckpointItem(checkpoint.nextAction, `${field}.nextAction`);
  }
  const listFields = [
    "confirmedFacts",
    "currentHypotheses",
    "ruledOut",
    "changedFiles",
    "verification",
    "unresolved",
  ] as const;
  let itemCount =
    hasOwn(checkpoint, "goal") || hasOwn(checkpoint, "nextAction") ? 1 : 0;
  for (const listField of listFields) {
    const items = checkpoint[listField];
    if (!Array.isArray(items)) {
      throw new Error(`${field}.${listField} must be an array`);
    }
    items.forEach((item, index) =>
      assertTaskCheckpointItem(item, `${field}.${listField}[${index}]`),
    );
    itemCount += items.length;
  }
  if (itemCount === 0) {
    throw new Error(`${field} must contain at least one sourced item`);
  }
}

function assertTaskCheckpointItem(value: unknown, field: string): void {
  const item = expectObject(value, field);
  assertExactKeys(item, ["statement", "sourceSeqs"], [], field);
  assertNonEmptyString(item.statement, `${field}.statement`);
  if (!Array.isArray(item.sourceSeqs) || item.sourceSeqs.length === 0) {
    throw new Error(`${field}.sourceSeqs must be a non-empty array`);
  }
  let previous = 0;
  for (const seq of item.sourceSeqs) {
    assertPositiveInteger(seq, `${field}.sourceSeqs`);
    if ((seq as number) <= previous) {
      throw new Error(`${field}.sourceSeqs must be strictly increasing`);
    }
    previous = seq as number;
  }
}

function assertCheckpointSourcesInRange(
  checkpoint: TaskCheckpointV1,
  fromSeq: number,
  throughSeq: number,
): void {
  for (const item of taskCheckpointItems(checkpoint)) {
    if (item.sourceSeqs.some((seq) => seq < fromSeq || seq > throughSeq)) {
      throw new Error(
        "task checkpoint source seq is outside its covered range",
      );
    }
  }
}

function taskCheckpointItems(
  checkpoint: TaskCheckpointV1,
): readonly TaskCheckpointItemV1[] {
  return [
    ...(checkpoint.goal ? [checkpoint.goal] : []),
    ...checkpoint.confirmedFacts,
    ...checkpoint.currentHypotheses,
    ...checkpoint.ruledOut,
    ...checkpoint.changedFiles,
    ...checkpoint.verification,
    ...checkpoint.unresolved,
    ...(checkpoint.nextAction ? [checkpoint.nextAction] : []),
  ];
}

function assertDerivedDecision(value: unknown): void {
  const decision = expectObject(value, "derived decision");
  assertExactKeys(
    decision,
    ["type", "reducerVersion", "inputThroughSeq", "stateHash", "action"],
    [],
    "derived decision",
  );
  assertExact(decision.type, "control.decided", "decision type");
  assertNonEmptyString(decision.reducerVersion, "reducerVersion");
  assertPositiveInteger(decision.inputThroughSeq, "inputThroughSeq");
  assertNonEmptyString(decision.stateHash, "stateHash");
  assertControlDecisionAction(decision.action, "decision action");
}

function assertControlDecisionAction(value: unknown, field: string): void {
  const action = expectObject(value, field);
  if (action.kind === "wait") {
    assertExactKeys(action, ["kind", "waitFor", "reasonCode"], [], field);
    assertOneOf(action.waitFor, ["user", "external"], "waitFor");
  } else {
    assertExactKeys(action, ["kind", "reasonCode"], [], field);
    assertOneOf(
      action.kind,
      ["continue", "complete", "incomplete", "failed", "abort"],
      "decision action kind",
    );
  }
  assertId(action.reasonCode, "reasonCode");
}

function assertModelResponse(value: unknown): void {
  const response = expectObject(value, "model response");
  assertExactKeys(
    response,
    ["schemaVersion", "providerProtocol", "assistantContent", "toolCalls"],
    ["auditThinking", "reasoningPassback", "finishReason", "usage"],
    "model response",
  );
  assertExact(
    response.schemaVersion,
    MODEL_RESPONSE_SCHEMA_VERSION_V1,
    "model response.schemaVersion",
  );
  assertOneOf(
    response.providerProtocol,
    ["openai-compatible", "anthropic-compatible"],
    "model response.providerProtocol",
  );
  if (typeof response.assistantContent !== "string") {
    throw new Error("model response.assistantContent must be a string");
  }
  assertOptionalStringField(response, "auditThinking");
  assertOptionalStringField(response, "reasoningPassback");
  if (
    response.providerProtocol === "anthropic-compatible" &&
    hasOwn(response, "reasoningPassback")
  ) {
    throw new Error(
      "anthropic-compatible model response cannot use string reasoningPassback",
    );
  }
  assertOptionalStringField(response, "finishReason");
  if (hasOwn(response, "usage")) assertModelResponseUsage(response.usage);
  if (!Array.isArray(response.toolCalls)) {
    throw new Error("model response.toolCalls must be an array");
  }
  const ids = new Set<string>();
  response.toolCalls.forEach((call, sourceIndex) => {
    assertModelResponseToolCall(call, sourceIndex);
    const callId = (call as Record<string, unknown>).callId as string;
    if (ids.has(callId)) {
      throw new Error(`model response has duplicate callId: ${callId}`);
    }
    ids.add(callId);
  });
}

function assertModelResponseUsage(value: unknown): void {
  const usage = expectObject(value, "model response.usage");
  assertExactKeys(
    usage,
    [],
    [
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "cachedPromptTokens",
      "cacheMissPromptTokens",
    ],
    "model response.usage",
  );
  if (Object.keys(usage).length === 0) {
    throw new Error("model response.usage must contain at least one counter");
  }
  for (const field of [
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "cachedPromptTokens",
    "cacheMissPromptTokens",
  ]) {
    if (hasOwn(usage, field)) {
      assertNonNegativeInteger(usage[field], `model response.usage.${field}`);
    }
  }
}

function assertModelResponseToolCall(
  value: unknown,
  expectedSourceIndex: number,
): void {
  const call = expectObject(
    value,
    `model response.toolCalls[${expectedSourceIndex}]`,
  );
  const field = `model response.toolCalls[${expectedSourceIndex}]`;
  assertExactKeys(
    call,
    ["callId", "name", "rawArguments", "args", "sourceIndex", "argumentsValid"],
    [],
    field,
  );
  assertId(call.callId, `${field}.callId`);
  assertNonEmptyString(call.name, `${field}.name`);
  if (typeof call.rawArguments !== "string") {
    throw new Error(`${field}.rawArguments must be a string`);
  }
  const args = expectObject(call.args, `${field}.args`);
  assertJsonValue(args, `${field}.args`);
  assertNonNegativeInteger(call.sourceIndex, `${field}.sourceIndex`);
  if (call.sourceIndex !== expectedSourceIndex) {
    throw new Error("model response tool sourceIndex must be contiguous");
  }
  assertBoolean(call.argumentsValid, `${field}.argumentsValid`);

  let parsed: unknown;
  let parsedObject: Record<string, unknown> | undefined;
  try {
    parsed = JSON.parse(call.rawArguments as string) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (Object.getPrototypeOf(parsed) === Object.prototype ||
        Object.getPrototypeOf(parsed) === null)
    ) {
      parsedObject = parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid raw JSON is valid evidence only when argumentsValid is false.
  }
  if (call.argumentsValid) {
    if (!parsedObject || !jsonValuesEqual(parsedObject, args)) {
      throw new Error(
        `${field} valid rawArguments must exactly match normalized args`,
      );
    }
  } else if (parsedObject || Object.keys(args).length !== 0) {
    throw new Error(
      `${field} invalid arguments must preserve non-object raw input and empty args`,
    );
  }
}

function assertInputAttachments(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("attachments must be a non-empty array");
  }
  const ids = new Set<string>();
  value.forEach((item, index) => {
    const attachment = expectObject(item, `attachments[${index}]`);
    assertExactKeys(
      attachment,
      ["attachmentId", "type", "name", "content"],
      ["mimeType"],
      `attachments[${index}]`,
    );
    assertId(attachment.attachmentId, `attachments[${index}].attachmentId`);
    if (ids.has(attachment.attachmentId as string)) {
      throw new Error("attachments contain a duplicate attachmentId");
    }
    ids.add(attachment.attachmentId as string);
    assertOneOf(attachment.type, ["image", "file"], "attachment type");
    assertNonEmptyString(attachment.name, `attachments[${index}].name`);
    assertOptionalStringField(attachment, "mimeType");
    assertDurableJsonPayload(
      attachment.content,
      `attachments[${index}].content`,
    );
    const content = attachment.content as DurableJsonPayloadV1;
    if (content.kind === "inline" && typeof content.value !== "string") {
      throw new Error("inline attachment content must be a string");
    }
  });
}

function assertToolObservation(value: unknown, field: string): void {
  const observation = expectObject(value, field);
  assertExactKeys(
    observation,
    ["schemaVersion", "summary", "isError"],
    ["payload"],
    field,
  );
  assertExact(
    observation.schemaVersion,
    TOOL_OBSERVATION_SCHEMA_VERSION_V1,
    `${field}.schemaVersion`,
  );
  assertNonEmptyString(observation.summary, `${field}.summary`);
  assertBoolean(observation.isError, `${field}.isError`);
  if (hasOwn(observation, "payload")) {
    assertDurableJsonPayload(observation.payload, `${field}.payload`);
  }
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonValuesEqual(item, right[index]))
    );
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        jsonValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function expectObject(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!hasOwn(value, key)) throw new Error(`${field}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not allowed`);
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExact(value: unknown, expected: string, field: string): void {
  if (value !== expected) throw new Error(`${field} must be ${expected}`);
}

function assertId(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value)
  ) {
    throw new Error(`${field} must be a stable non-empty id`);
  }
}

function assertNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertSingleLineString(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8_192 ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${field} must be a bounded single-line string`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

function assertOptionalStringField(
  value: Record<string, unknown>,
  field: string,
): void {
  if (hasOwn(value, field)) assertNonEmptyString(value[field], field);
}

function assertBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
}

function assertPositiveInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function assertOneOf(
  value: unknown,
  expected: readonly string[],
  field: string,
): void {
  if (typeof value !== "string" || !expected.includes(value)) {
    throw new Error(`${field} has an unsupported value`);
  }
}

function assertDurableJsonPayload(value: unknown, field: string): void {
  const payload = expectObject(value, field);
  if (payload.kind === "inline") {
    assertExactKeys(payload, ["kind", "value", "hash"], [], field);
    assertJsonValue(payload.value, `${field}.value`);
    assertSingleLineString(payload.hash, `${field}.hash`);
    return;
  }
  if (payload.kind === "artifact_ref") {
    assertExactKeys(payload, ["kind", "artifactRef", "hash"], [], field);
    assertId(payload.artifactRef, `${field}.artifactRef`);
    assertSingleLineString(payload.hash, `${field}.hash`);
    return;
  }
  throw new Error(`${field}.kind has an unsupported value`);
}

function assertJsonValue(value: unknown, field: string): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must be valid JSON`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${field}[${index}]`));
    return;
  }
  const record = expectObject(value, field);
  for (const [key, item] of Object.entries(record)) {
    assertJsonValue(item, `${field}.${key}`);
  }
}
