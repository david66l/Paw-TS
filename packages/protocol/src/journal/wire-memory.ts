/** Memory pipeline wire values (cards, atoms, topics, persona, evidence). */
import type {
  MEMORY_ATOM_PROPOSAL_SCHEMA_VERSION_V1,
  MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1,
} from "./versions.js";

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

export type MemoryAtomKindV1 = "semantic" | "episodic" | "profile" | "instruction";

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

export type MemoryTopicFamilyV1 = "semantic" | "episodic" | "profile" | "instruction" | "mixed";

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
