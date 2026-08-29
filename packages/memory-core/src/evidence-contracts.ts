import type {
  MemoryEvidenceBindingV1,
  MemoryEvidenceUseV1,
} from "./evidence-origin.js";

/** Stable contracts shared by evidence discovery, ranking, and notebook stages. */
export const PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1 =
  "paw.memory-evidence-first.v1";
export const PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2 =
  "paw.memory-evidence-candidate-fusion.v2";
export const PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1 =
  "paw.memory-conversation-bundle.v2:explicit-assistant-output-recall";
export const PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1 =
  "paw.memory-evidence-notebook.v10:item-bound-evidence-use";

export type MemoryEvidenceChannelV1 = "l0" | "l1";

export interface MemoryEvidenceSourceRankListV1 {
  readonly channel: MemoryEvidenceChannelV1;
  readonly weight: number;
  /** Ordered best-first. Duplicates in one channel count only once. */
  readonly sourceIds: readonly string[];
}

export interface RankedMemoryEvidenceSourceV1 {
  readonly sourceId: string;
  readonly score: number;
  readonly channelHits: number;
  readonly channels: readonly MemoryEvidenceChannelV1[];
  readonly bestRank: number;
}

export interface MemoryEvidenceSourceFusionV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1;
  readonly sources: readonly RankedMemoryEvidenceSourceV1[];
  readonly telemetry: Readonly<{
    inputListCount: number;
    l0CandidateCount: number;
    l1CandidateCount: number;
    fusedCandidateCount: number;
    dualChannelCount: number;
    returnedCount: number;
  }>;
}

export type MemoryEvidenceAuthorityV2 =
  | "user_asserted"
  | "user_confirmed_dialogue"
  | "context_only"
  | "derived"
  | "mixed";

export type MemoryEvidenceKindV2 =
  | MemoryConversationTurnKindV1
  | "source_chunk"
  | "source_span"
  | "derived_atom";

/** Content-free address hydrated only after fusion selects its source. */
export interface MemoryEvidenceCandidateV2 {
  readonly candidateId: string;
  readonly sourceId: string;
  readonly evidenceRef: string;
  readonly sourceKind: MemoryEvidenceKindV2;
  readonly authority: MemoryEvidenceAuthorityV2;
  readonly observedAt?: string;
}

export interface MemoryEvidenceCandidateRankListV2 {
  readonly channel: MemoryEvidenceChannelV1;
  readonly retrieverId: string;
  readonly weight: number;
  /** Ordered best-first. Candidate addresses are deduplicated within a list. */
  readonly candidates: readonly MemoryEvidenceCandidateV2[];
}

export interface RankedMemoryEvidenceCandidateV2
  extends MemoryEvidenceCandidateV2 {
  readonly score: number;
  readonly listHits: number;
  readonly channels: readonly MemoryEvidenceChannelV1[];
  readonly bestRank: number;
}

export interface RankedMemoryEvidenceSourceV2 {
  readonly sourceId: string;
  readonly score: number;
  readonly channelHits: number;
  readonly channels: readonly MemoryEvidenceChannelV1[];
  readonly bestRank: number;
  readonly evidence: readonly RankedMemoryEvidenceCandidateV2[];
}

export interface MemoryEvidenceCandidateFusionV2 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2;
  readonly sources: readonly RankedMemoryEvidenceSourceV2[];
  readonly telemetry: Readonly<{
    inputListCount: number;
    l0CandidateCount: number;
    l1CandidateCount: number;
    fusedCandidateCount: number;
    fusedSourceCount: number;
    dualChannelSourceCount: number;
    returnedSourceCount: number;
    returnedEvidenceCount: number;
  }>;
}

export type MemoryConversationTurnKindV1 =
  | "user_input"
  | "assistant_output"
  | "tool_observation"
  | "verification"
  | "outcome"
  | "source_document";

export interface MemoryConversationTurnV1 {
  readonly evidenceRef?: string;
  readonly sourceSeq: number;
  readonly sourceKind: MemoryConversationTurnKindV1;
  readonly content: string;
  readonly hit: boolean;
}

export interface MemoryConversationTurnBundleV1 {
  readonly policyVersion: typeof PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1;
  readonly text: string;
  readonly hitSeq: number;
  readonly authority:
    | "user_asserted"
    | "user_confirmed_dialogue"
    | "context_only";
  readonly includedTurns: number;
  readonly includedEvidence: readonly Readonly<{
    evidenceRef: string;
    sourceKind: MemoryConversationTurnKindV1;
    turnOrder: number;
  }>[];
  readonly chars: number;
}

export interface SelectedMemoryConversationBundlesV1 {
  readonly text: string;
  readonly selectedBundles: number;
  readonly chars: number;
}

export interface MemoryEvidenceNotebookHitV1 {
  readonly sourceId: string;
  readonly evidenceRef: string;
  readonly content: string;
  readonly authority: MemoryEvidenceAuthorityV2;
  readonly observedAt?: string;
  /** Monotonic order inside one scoped history; disambiguates equal timestamps. */
  readonly observedOrder?: number;
  /** Stable episode/session order, independent of ingestion time. */
  readonly episodeOrder?: number;
  /** Stable turn order inside one episode/session. */
  readonly turnOrder?: number;
  /** Optional stable event identity shared by cross-session restatements. */
  readonly eventKey?: string;
  /** Exact role of the anchor turn when the hit came from conversational L0. */
  readonly sourceKind?: MemoryConversationTurnKindV1;
  /** Exact addresses of bounded neighbors rendered inside this hit. */
  readonly contextEvidenceRefs?: readonly string[];
}

export interface MemoryEvidenceNotebookRequirementV1 {
  readonly requirementId: string;
  readonly label: string;
  readonly searchText: string;
  readonly selection?: "ranked" | "latest";
  readonly relation?: "direct" | "temporal" | "comparative" | "inferred";
  readonly coverageMode?: "any" | "all" | "latest" | "convergent";
  readonly minimumEvidence?: number;
  /** Required answer provenance; defaults to user for legacy callers. */
  readonly roleConstraint?: "user" | "assistant" | "any";
  /** Exact refs that passed the source-local dialogue certificate. */
  readonly certifiedDialogueEvidenceRefs?: readonly string[];
  /** Ordered best-first for this requirement. */
  readonly hits: readonly MemoryEvidenceNotebookHitV1[];
}

export interface MemoryEvidenceNotebookV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1;
  readonly sources: readonly Readonly<{
    sourceId: string;
    text: string;
    evidenceRefs: readonly string[];
    evidenceBindings: readonly MemoryEvidenceBindingV1[];
    evidenceUses: readonly MemoryEvidenceUseV1[];
    answerRole: "current" | "ambiguous" | "supporting" | "mixed";
  }>[];
  readonly coverage: readonly Readonly<{
    requirementId: string;
    status: "covered" | "partial" | "missing";
    selectedHitCount: number;
    /** Independent episodes satisfying closure; duplicates never inflate it. */
    independentEvidenceCount: number;
    /** Count interpreted by coverageMode and used for the final closure gate. */
    closureEvidenceCount: number;
    /** Exact evidence selected for this requirement, never a packet-wide copy. */
    selectedEvidenceRefs: readonly string[];
    /** Superseded evidence retained for audit, never rendered as answer context. */
    historicalEvidenceRefs: readonly string[];
    /** Unresolved peers that prevent a latest-state requirement from closing. */
    unresolvedEvidenceRefs: readonly string[];
  }>[];
  readonly selectedHitCount: number;
  readonly chars: number;
}
