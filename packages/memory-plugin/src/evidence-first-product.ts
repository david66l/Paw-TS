/**
 * Narrow product entrypoint for the evidence-first read path.
 *
 * Keep this barrel free of Aspect, Facet, and temporal-graph exports. Product
 * composition imports this subpath so legacy/shadow graph modules are not part
 * of the runtime dependency closure merely because the package also exposes
 * them from its backwards-compatible root entrypoint.
 */
export {
  createEvidenceFirstMemoryContextResolverV1,
  PAW_MEMORY_EVIDENCE_ANSWER_CONTRACT_VERSION_V1,
  projectEvidenceFirstMemoryAnswerContractV1,
  projectEvidenceFirstMemoryContextPacketV1,
  type MemoryEvidenceAnswerContractV1,
} from "./evidence-context-adapter.js";
export {
  PAW_MEMORY_PRODUCT_EVIDENCE_INDEX_VERSION_V1,
  createProductMemoryEvidenceIndexV1,
  evidenceSourceIdV1,
} from "./evidence-index-adapter.js";
export {
  PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
  createJsonMemoryEvidenceQueryPlannerV3,
  type MemoryEvidenceQueryIntentV3,
  type MemoryEvidenceQueryPlannerV3,
  type MemoryEvidenceRequirementV3,
} from "./evidence-query-planner.js";
export {
  PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
  createMemoryEvidenceResolverV1,
  type MemoryEvidenceIndexSearchResultV1,
  type MemoryEvidenceIndexV1,
  type MemoryEvidenceResolutionV1,
} from "./evidence-resolver.js";
export {
  PAW_MEMORY_EVIDENCE_SUPPORT_SELECTOR_VERSION_V1,
  createJsonMemoryEvidenceSupportSelectorV1,
  type MemoryEvidenceSupportSelectorV1,
  type MemoryEvidenceTriageAssessmentV1,
} from "./evidence-support-selector.js";
