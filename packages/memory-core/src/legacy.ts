/**
 * Frozen compatibility surface for Paw's versioned V15 integration.
 *
 * New hosts should import the small default entrypoint. Serialized schema
 * revisions remain explicit even when public TypeScript names do not carry a
 * V1/V2/V3 suffix.
 */
export {
  createMemoryEvidenceAnswerPolicyV1,
  PAW_MEMORY_EVIDENCE_ANSWER_POLICY_VERSION_V1,
  type MemoryEvidenceAnswerOperationV1,
  type MemoryEvidenceAnswerPolicyV1,
} from "./evidence-answer-policy.js";
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
  DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
  PAW_MEMORY_SOURCE_LOCAL_EVIDENCE_LOCATOR_PORT_VERSION_V1,
  isMemorySourceLocalEvidenceEligibleV1,
  hasMemorySourceLocalDialogueCertificateV1,
  hydrateMemorySourceLocalEvidenceResultV1,
  memorySourceLocalAnchorKindsV1,
  memorySourceLocalEvidenceCacheKeyV1,
  validateMemorySourceLocalEvidenceResultV1,
  type MemorySourceLocalEvidenceBudgetV1,
  type MemorySourceLocalAnchorKindV1,
  type MemorySourceLocalEvidenceHitV1,
  type MemorySourceLocalEvidenceHydratorV1,
  type MemorySourceLocalHydratedEvidenceV1,
  type MemorySourceLocalEvidenceLocatorV1,
  type MemorySourceLocalEvidenceRequestV1,
  type MemorySourceLocalEvidenceResultV1,
  type MemorySourceLocalEvidenceTelemetryV1,
  type MemorySourceLocalizationReportV1,
  type MemorySourceLocalizationStatusV1,
} from "./source-local-evidence-locator.js";
export {
  PAW_MEMORY_EVIDENCE_CLOSURE_AUDITOR_VERSION_V1,
  buildMemoryEvidenceClosureAuditRequestV1,
  createJsonMemoryEvidenceClosureAuditorV1,
  parseMemoryEvidenceClosureAuditV1,
  type MemoryEvidenceClosureAuditInputV1,
  type MemoryEvidenceClosureAuditV1,
  type MemoryEvidenceClosureAuditorV1,
  type MemoryEvidenceClosureVerdictV1,
} from "./evidence-closure-auditor.js";
export {
  PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
  buildMemoryEvidenceQueryPlanRequestV3,
  classifyMemoryEvidenceQueryV3,
  createJsonMemoryEvidenceQueryPlannerV3,
  needsCertifiedAssistantDialogueCandidateV1,
  needsMemoryEvidenceRoleResolutionV1,
  parseMemoryEvidenceQueryPlanV3,
  type MemoryEvidenceAnswerShapeV3,
  type MemoryEvidenceQueryIntentV3,
  type MemoryEvidenceQueryPlanV3,
  type MemoryEvidenceQueryPlannerV3,
  type MemoryEvidenceRequirementV3,
  type MemoryEvidenceRoleConstraintV3,
  type MemoryEvidenceTemporalModeV3,
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
  buildMemoryEvidenceSupportSelectionRequestV1,
  createJsonMemoryEvidenceSupportSelectorV1,
  parseMemoryEvidenceSupportSelectionV1,
  type MemoryEvidenceSupportSelectionV1,
  type MemoryEvidenceSupportSelectionInputV1,
  type MemoryEvidenceSupportSelectorV1,
  type MemoryEvidenceTriageAssessmentV1,
} from "./evidence-support-selector.js";
export {
  buildMemoryConversationTurnBundleV1,
  buildMemoryEvidenceNotebookV1,
  isAssistantMemoryQueryV1,
  PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1,
  PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
  PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1,
  PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
  memoryEvidenceOrdinalAnchorScoreV1,
  memoryEvidenceSupportScoreV1,
  projectMemoryEvidenceExcerptV1,
  rankMemoryEvidenceCandidatesV2,
  rankMemoryEvidenceSourcesV1,
  selectRankedMemoryConversationBundlesV1,
  type MemoryConversationTurnBundleV1,
  type MemoryConversationTurnKindV1,
  type MemoryConversationTurnV1,
  type MemoryEvidenceAuthorityV2,
  type MemoryEvidenceCandidateFusionV2,
  type MemoryEvidenceCandidateRankListV2,
  type MemoryEvidenceCandidateV2,
  type MemoryEvidenceChannelV1,
  type MemoryEvidenceKindV2,
  type MemoryEvidenceNotebookHitV1,
  type MemoryEvidenceNotebookRequirementV1,
  type MemoryEvidenceNotebookV1,
  type MemoryEvidenceSourceFusionV1,
  type MemoryEvidenceSourceRankListV1,
  type RankedMemoryEvidenceCandidateV2,
  type RankedMemoryEvidenceSourceV1,
  type RankedMemoryEvidenceSourceV2,
  type SelectedMemoryConversationBundlesV1,
} from "./evidence-first.js";
export {
  PAW_MEMORY_STATE_REDUCER_VERSION_V1,
  compareStateObservationV1,
  inferMemoryStateSemanticsV1,
  resolveMemoryStateObservationsV1,
  type MemoryStateEpistemicStatusV1,
  type MemoryStateKindV1,
  type MemoryStateObservationV1,
  type MemoryStateResolutionV1,
  type MemoryStateValueQualifierV1,
} from "./state-observation.js";
export {
  createInMemoryEvidenceStoreV1,
  type InMemoryCardInputV1,
  type InMemoryEvidenceInputV1,
  type InMemoryEvidenceStoreV1,
} from "./in-memory-store.js";
export type {
  MemoryProductArchiveV1,
  MemoryProductCardV1,
  MemoryProductProfileV1,
  MemoryProductProviderV1,
  MemoryProductRawEvidenceV1,
  MemoryProductScopeV1,
} from "./product-ports.js";
export type { MemoryWriterModelV1 } from "./model-port.js";
export {
  PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
  type MemoryContextResolverV1,
  type MemoryRawEvidenceSpanV1,
  type MemoryResolvedContextEvidenceV1,
  type MemoryResolvedContextPacketV1,
  type MemoryResolvedContextTopicV1,
  type MemoryResolvedTopicStateV1,
} from "./context-contract.js";
