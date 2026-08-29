/**
 * Stable, small public surface for hosts embedding Paw Memory.
 *
 * Versioned implementation names remain available from `@paw/memory-core/legacy`
 * while serialized schemas keep their explicit protocol revisions.
 */
export { createEvidenceFirstMemoryContextResolverV1 as createContextResolver } from "./evidence-context-adapter.js";
export { createProductMemoryEvidenceIndexV1 as createEvidenceIndex } from "./evidence-index-adapter.js";
export { createJsonMemoryEvidenceQueryPlannerV3 as createJsonQueryPlanner } from "./evidence-query-planner.js";
export { createMemoryEvidenceResolverV1 as createEvidenceResolver } from "./evidence-resolver.js";
export { createJsonMemoryEvidenceSupportSelectorV1 as createJsonSupportSelector } from "./evidence-support-selector.js";
export { createInMemoryEvidenceStoreV1 as createInMemoryStore } from "./in-memory-store.js";

export type {
  MemoryContextResolverV1 as ContextResolver,
  MemoryResolvedContextPacketV1 as ResolvedContext,
} from "./context-contract.js";
export type {
  MemoryEvidenceIndexV1 as EvidenceIndex,
  MemoryEvidenceResolutionV1 as EvidenceResolution,
} from "./evidence-resolver.js";
export type { MemoryWriterModelV1 as StructuredOutputModel } from "./model-port.js";
export type {
  MemoryProductArchiveV1 as EvidenceArchive,
  MemoryProductProviderV1 as EvidenceProvider,
  MemoryProductScopeV1 as MemoryScope,
} from "./product-ports.js";
