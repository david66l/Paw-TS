import type {
  MemoryEvidenceBindingV1,
  MemoryEvidenceDispositionBindingV1,
  MemoryEvidenceUseV1,
} from "./evidence-origin.js";

/** Runtime-independent evidence packet contract exposed by the memory core. */
export const PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1 =
  "paw.memory-context-resolver.v5:item-bound-evidence-use" as const;

export interface MemoryRawEvidenceSpanV1 {
  readonly evidenceRef: string;
  readonly memoryIds: readonly string[];
  readonly content: string;
  readonly contentHash: string;
}

export interface MemoryResolvedContextEvidenceV1 {
  readonly memoryId: string;
  readonly layer: "L0" | "L1" | "L2";
  readonly statement: string;
  readonly state?: "current" | "historical";
  readonly supportRole?: "supporting" | "contradicting" | "contextual";
  readonly validFrom?: string;
  readonly evidenceRefs: readonly string[];
  /** Canonical per-item mapping on evidence-first packets. */
  readonly evidenceBindings?: readonly MemoryEvidenceBindingV1[];
  /** Present on evidence-first packets; legacy context adapters may omit it. */
  readonly evidenceUses?: readonly MemoryEvidenceUseV1[];
}

export interface MemoryResolvedTopicStateV1 {
  readonly memoryId: string;
  readonly kind: "semantic" | "episodic" | "profile" | "vault_ref";
  readonly statement: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly status: "current" | "historical";
  readonly evidenceRefs: readonly string[];
}

export interface MemoryResolvedContextTopicV1 {
  readonly topicId: string;
  readonly name: string;
  readonly family: string;
  readonly dossierId: string;
  readonly currentConclusions: readonly MemoryResolvedTopicStateV1[];
  readonly evolutions: readonly Readonly<{
    relationId: string;
    previous: MemoryResolvedTopicStateV1;
    current: MemoryResolvedTopicStateV1;
    evidenceRefs: readonly string[];
  }>[];
  readonly conflicts: readonly Readonly<{
    relationId: string;
    left: MemoryResolvedTopicStateV1;
    right: MemoryResolvedTopicStateV1;
    resolutionStatus: "unresolved" | "historical";
    evidenceRefs: readonly string[];
  }>[];
}

export interface MemoryResolvedContextPacketV1 {
  readonly schemaVersion: "paw.memory-resolved-context.v1";
  readonly resolverVersion: typeof PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1;
  readonly packetRevision: string;
  readonly mode: "planned" | "deterministic_fallback";
  readonly stop: "sufficient" | "partial" | "missing";
  readonly requirements: readonly Readonly<{
    requirementId: string;
    description: string;
    priority: "required" | "supporting";
    minimumEvidence: number;
    status: "covered" | "partial" | "missing";
    selectedEvidenceCount: number;
    supportingMemoryIds: readonly string[];
    contradictingMemoryIds: readonly string[];
    unknownMemoryIds: readonly string[];
    evidenceDispositions?: readonly Readonly<MemoryEvidenceDispositionBindingV1>[];
  }>[];
  readonly verification: Readonly<{
    status: "verified" | "not_configured" | "failed";
    verifierVersion?: string;
    verificationRevision?: string;
    supportingCount: number;
    contradictionCount: number;
    unknownCount: number;
    reasonCode?: string;
  }>;
  readonly evidence: readonly MemoryResolvedContextEvidenceV1[];
  readonly topics: readonly MemoryResolvedContextTopicV1[];
  readonly spans: readonly MemoryRawEvidenceSpanV1[];
}

export interface MemoryContextResolverV1 {
  readonly resolverVersion: typeof PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1;
  resolve(
    query: string,
    signal: AbortSignal,
  ): Promise<MemoryResolvedContextPacketV1>;
}
