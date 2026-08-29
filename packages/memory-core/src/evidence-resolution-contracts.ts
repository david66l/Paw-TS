import type { MemoryEvidenceClosureVerdictV1 } from "./evidence-closure-auditor.js";
import type {
  MemoryEvidenceCandidateFusionV2,
  MemoryEvidenceCandidateRankListV2,
  MemoryEvidenceNotebookHitV1,
  MemoryEvidenceNotebookV1,
  RankedMemoryEvidenceSourceV2,
} from "./evidence-first.js";
import type {
  MemoryEvidenceBindingV1,
  MemoryEvidenceUseV1,
} from "./evidence-origin.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./evidence-query-planner.js";
import type { MemoryEvidenceTriageAssessmentV1 } from "./evidence-support-selector.js";
import type { MemorySourceLocalizationReportV1 } from "./source-local-evidence-locator.js";

export const PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1 =
  "paw.memory-evidence-resolver.v16:item-certified-evidence-binding" as const;

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

export interface MemoryEvidenceResolutionV1 {
  readonly resolverVersion: typeof PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1;
  readonly indexVersion: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly directCertificateStatus:
    | "deterministic_direct"
    | "missing"
    | "not_applicable";
  readonly plannerStatus: "not_needed" | "completed" | "fallback";
  readonly supportSelectorStatus:
    | "not_needed"
    | "not_configured"
    | "completed"
    | "fallback";
  readonly closureAuditStatus:
    | "not_needed"
    | "not_configured"
    | "completed"
    | "fallback";
  readonly closureVerdict?: MemoryEvidenceClosureVerdictV1;
  readonly closureRepairCount: 0 | 1;
  readonly closureAuditRevision?: string;
  readonly closureAuditorVersion?: string;
  readonly supportSelectionRevision?: string;
  readonly supportSelectorVersion?: string;
  readonly supportAssessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  readonly sourceLocalization: MemorySourceLocalizationReportV1;
  readonly degradedChannels: readonly ("l0" | "l1")[];
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly sources: readonly RankedMemoryEvidenceSourceV2[];
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
