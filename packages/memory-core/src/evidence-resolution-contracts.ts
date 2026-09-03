import type { MemoryEvidenceClosureVerdictV1 } from "./evidence-closure-auditor.js";
import type {
  MemoryEvidenceCandidateFusionV2,
  MemoryEvidenceCandidateRankListV2,
  MemoryEvidenceNotebookHitV1,
  MemoryEvidenceNotebookV1,
  RankedMemoryEvidenceSourceV2,
} from "./evidence-first.js";
import type { MemoryEvidenceObligationShapeV1 } from "./evidence-obligation.js";
import type {
  MemoryEvidenceBindingV1,
  MemoryEvidenceUseV1,
} from "./evidence-origin.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./evidence-query-planner.js";
import type { MemoryEvidenceReaderProjectionBuildResultV1 } from "./evidence-reader-projection-v1.js";
import type { MemoryEvidenceRepairCommitReportV1 } from "./evidence-repair-dominance.js";
import type { MemoryEvidenceSanitizationTransactionReportV1 } from "./evidence-sanitization-projection.js";
import type { MemoryEvidenceTriageAssessmentV1 } from "./evidence-support-selector.js";
import type { MemoryRequirementFairAcquisitionReportV1 } from "./requirement-fair-acquisition.js";
import type { MemorySourceLocalizationReportV1 } from "./source-local-evidence-locator.js";
import type { MemoryResolvedStateFrameV2 } from "./state-frame-v2.js";

export const PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1 =
  "paw.memory-evidence-resolver.v34:temporal-source-aperture-reserve" as const;

export type MemoryEvidenceClosureModeV1 = "disabled" | "observe" | "repair";

export interface MemoryEvidenceIndexSearchResultV1 {
  readonly lists: readonly MemoryEvidenceCandidateRankListV2[];
  /** Hydrated exact evidence keyed by evidenceRef. */
  readonly hits: readonly MemoryEvidenceNotebookHitV1[];
  /** A failed channel may degrade independently without discarding the other. */
  readonly degradedChannels?: readonly ("l0" | "l1")[];
}

export interface MemoryEvidenceIndexV1 {
  readonly indexVersion: string;
  /**
   * Adapter-owned address boundary. Implementations with namespaced evidence
   * refs must prove source membership without teaching the core their schema.
   * The indexVersion must change when this mapping changes.
   */
  readonly evidenceRefBelongsToSource?: (
    sourceId: string,
    evidenceRef: string,
  ) => boolean;
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<MemoryEvidenceIndexSearchResultV1>;
}

/**
 * The resolver's per-requirement evidence ledger. Only `supportingEvidenceRefs`
 * contribute to closure. Candidate and contradicting refs remain visible to
 * the reader without being promoted to proof.
 */
export interface MemoryEvidenceRequirementLedgerEntryV1 {
  readonly requirementId: string;
  readonly supportingEvidenceRefs: readonly string[];
  readonly candidateEvidenceRefs: readonly string[];
  readonly contradictingEvidenceRefs: readonly string[];
}

export interface MemoryEvidenceResolutionV1 {
  readonly resolverVersion: typeof PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1;
  readonly indexVersion: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly plannerStatus: "not_needed" | "completed" | "fallback";
  readonly plannerFailureCode?: string;
  readonly obligationShape: MemoryEvidenceObligationShapeV1;
  readonly obligationStatus: "satisfied" | "fallback";
  readonly supportSelectorStatus:
    | "not_needed"
    | "not_configured"
    | "completed"
    | "partial"
    | "fallback";
  readonly closureAuditStatus:
    | "not_needed"
    | "not_configured"
    | "completed"
    | "fallback";
  /** Auditors observe by default; only an explicit repair profile may rewrite a packet. */
  readonly closureMode: MemoryEvidenceClosureModeV1;
  readonly closureVerdict?: MemoryEvidenceClosureVerdictV1;
  /** Content-free count from the initial verifier report. */
  readonly closureDeficiencyCount: number;
  /**
   * Unique evidence addresses that the semantic auditor considered unhelpful.
   * This is an advisory signal for the replan; it is never an authorization to
   * delete source memory from the reader packet.
   */
  readonly closureSemanticRejectedEvidenceCount: number;
  readonly closureRepairCount: 0 | 1;
  readonly closureRepairMode: "none" | "replan";
  /** Content-free two-phase commit report for an attempted closure repair. */
  readonly closureRepairCommit?: MemoryEvidenceRepairCommitReportV1;
  /**
   * Reserved for an explicit host-owned invalidation transaction. Semantic
   * closure-auditor rejections never populate this field.
   */
  readonly closureRepairSanitization?: MemoryEvidenceSanitizationTransactionReportV1;
  readonly closureAuditFailureCode?: string;
  readonly closureAuditRevision?: string;
  readonly closureAuditorVersion?: string;
  readonly supportSelectionRevision?: string;
  readonly supportSelectorVersion?: string;
  readonly stateFrameStatus?: "completed" | "partial" | "fallback";
  readonly stateFrameFailureCode?: string;
  readonly stateFrameFailureStage?: "coverage_certificate" | "state_shadow";
  readonly stateBinderVersion?: string;
  readonly stateBindingRevision?: string;
  readonly stateVerifierVersion?: string;
  readonly stateVerificationRevision?: string;
  /** Shadow-only identity; deliberately excluded from resolutionRevision. */
  readonly stateShadowAuditRevision?: string;
  readonly stateFrame?: MemoryResolvedStateFrameV2;
  /** Shadow build result; adapters must explicitly gate reader use. */
  readonly readerProjectionBuild?: MemoryEvidenceReaderProjectionBuildResultV1;
  readonly stateFrameTelemetry?: Readonly<{
    groupCount: number;
    committedGroupCount: number;
    failedGroupCount: number;
    selectorGroupCount: number;
    selectorCommittedGroupCount: number;
    selectorFailedGroupCount: number;
    unassessedRequirementCount: number;
    slotCount: number;
    completeSlotCount: number;
    partialSlotCount: number;
    missingSlotCount: number;
    conflictSlotCount: number;
    sourceLockItemCount: number;
    proposedObservationCount: number;
    validatedObservationCount: number;
    rejectedObservationCount: number;
    bindingCertificatePolicyVersion: string;
    bindingCertificateCount: number;
    mechanicalBindingProfilePolicyVersion: string;
    mechanicalBindingProfileCount: number;
    mechanicallyCompleteBindingCount: number;
    mechanicallyIncompleteBindingCount: number;
    mechanicalBindingProofFailureCounts: Readonly<Record<string, number>>;
    mechanicalBindingSummaryRevision: string;
    unsupportedCompleteSlotCount: number;
    unsupportedDerivedOperationCount: number;
    executionStatus?:
      | "complete"
      | "partial"
      | "missing"
      | "conflict"
      | "unsupported";
    executionProgramRevision?: string;
    executionRevision?: string;
    executionCompleteNodeCount?: number;
    executionPartialNodeCount?: number;
    executionMissingNodeCount?: number;
    executionConflictNodeCount?: number;
    executionUnsupportedNodeCount?: number;
    executionOperationStatusCounts?: Readonly<
      Record<string, Readonly<Record<string, number>>>
    >;
    executionAnswerOperandStatusCounts?: Readonly<
      Record<string, Readonly<Record<string, number>>>
    >;
    executionAnswerOperationStatusCounts?: Readonly<
      Record<string, Readonly<Record<string, number>>>
    >;
    executionReasonCounts?: Readonly<Record<string, number>>;
    executionPlanBlockedReasonCounts?: Readonly<Record<string, number>>;
    executionAggregateOperator?: string;
    executionAggregationUnit?: string;
    executionAggregateCountBasis?: string;
    executionAggregateMaterializationExact?: boolean;
    executionAggregateMaterializationState?:
      | "exact"
      | "inexact"
      | "not_materialized";
    executionDurationEndpointPolicy?: string;
    executionDurationEndpointContractKind?: string;
    executionDurationEndpointOrdering?: string;
    executionDurationOperandGroupCount?: number;
    executionDurationRawEndpointCount?: number;
    executionDurationDistinctClaimCount?: number;
    executionDurationDistinctEventCount?: number;
    executionDurationEndpointTimeBasisCounts?: Readonly<Record<string, number>>;
    executionDurationEndpointRoleCounts?: Readonly<Record<string, number>>;
    executionDurationStateBindingCertificateCount?: number;
    executionDurationEndpointCertificateMaterialized?: boolean;
    executionDurationClosureBasis?: "closed_endpoint_set" | "not_closed";
    executionPersonalizationCoverageCertificateMaterialized?: boolean;
    executionPersonalizationConstraintCount?: number;
    executionPersonalizationLifecycleCertificateCount?: number;
    executionReaderProjectionStatus?: "projected" | "rejected";
    executionReaderProjectionKind?:
      | "temporal_duration"
      | "aggregate"
      | "personalization"
      | "evidence_groups";
    executionReaderProjectionRejectedReason?: string;
    executionReaderProjectionCertificateCount?: number;
    executionReadNodeCompleteCount?: number;
    executionReadNodeBlockedCount?: number;
    assistantValidatedObservationCount: number;
    uncertifiedAssistantValidatedObservationCount: number;
  }>;
  readonly supportAssessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  readonly sourceLocalization: MemorySourceLocalizationReportV1;
  readonly degradedChannels: readonly ("l0" | "l1")[];
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly requirementEvidence: readonly Readonly<MemoryEvidenceRequirementLedgerEntryV1>[];
  readonly sources: readonly RankedMemoryEvidenceSourceV2[];
  /** Content-free pre-lock policy trace and cache identity. */
  readonly sourceAcquisition: MemoryRequirementFairAcquisitionReportV1;
  readonly primaryHits: readonly MemoryEvidenceNotebookHitV1[];
  /** Canonical model-facing packet shared by product and benchmark adapters. */
  readonly packetSources: readonly Readonly<{
    sourceId: string;
    text: string;
    evidenceRefs: readonly string[];
    evidenceBindings: readonly MemoryEvidenceBindingV1[];
    evidenceUses: readonly MemoryEvidenceUseV1[];
    answerRole: "current" | "ambiguous" | "supporting" | "candidate" | "mixed";
  }>[];
  readonly telemetry: MemoryEvidenceCandidateFusionV2["telemetry"];
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly resolutionRevision: string;
}
