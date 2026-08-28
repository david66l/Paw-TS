import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import type {
  MemoryEvidenceClosureAuditorV1,
  MemoryEvidenceClosureVerdictV1,
} from "./evidence-closure-auditor.js";
import {
  type MemoryEvidenceCandidateFusionV2,
  type MemoryEvidenceCandidateRankListV2,
  type MemoryEvidenceNotebookHitV1,
  type MemoryEvidenceNotebookV1,
  PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
  PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
  type RankedMemoryEvidenceSourceV2,
  buildMemoryEvidenceNotebookV1,
  memoryEvidenceOrdinalAnchorScoreV1,
  memoryEvidenceSupportScoreV1,
  rankMemoryEvidenceCandidatesV2,
} from "./evidence-first.js";
import {
  type MemoryEvidenceQueryIntentV3,
  type MemoryEvidenceQueryPlannerV3,
  type MemoryEvidenceRequirementV3,
  classifyMemoryEvidenceQueryV3,
} from "./evidence-query-planner.js";
import type {
  MemoryEvidenceSupportSelectorV1,
  MemoryEvidenceTriageAssessmentV1,
} from "./evidence-support-selector.js";
import {
  DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
  type MemorySourceLocalEvidenceBudgetV1,
  type MemorySourceLocalEvidenceLocatorV1,
  type MemorySourceLocalizationReportV1,
  isMemorySourceLocalEvidenceEligibleV1,
  validateMemorySourceLocalEvidenceResultV1,
} from "./source-local-evidence-locator.js";

export const PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1 =
  "paw.memory-evidence-resolver.v9:source-local-assistant-supplement" as const;

export interface MemoryEvidenceIndexSearchResultV1 {
  readonly lists: readonly MemoryEvidenceCandidateRankListV2[];
  /** Hydrated exact evidence keyed by evidenceRef. */
  readonly hits: readonly MemoryEvidenceNotebookHitV1[];
  /** A failed channel may degrade independently without discarding the other. */
  readonly degradedChannels?: readonly ("l0" | "l1")[];
}

export interface MemoryEvidenceIndexV1 {
  readonly indexVersion: string;
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
    answerRole: "current" | "ambiguous" | "supporting" | "candidate" | "mixed";
  }>[];
  readonly telemetry: MemoryEvidenceCandidateFusionV2["telemetry"];
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly resolutionRevision: string;
}

/**
 * Shared plugin-owned evidence pipeline. The caller query and bounded planner
 * requirements participate in capped discovery. Each pass locks its source
 * set; one independently audited repair may drill into those sources but can
 * never introduce a new source. The selector can bind supplied evidence
 * addresses but cannot introduce a source, address, or search of its own.
 */
export function createMemoryEvidenceResolverV1(input: {
  readonly index: MemoryEvidenceIndexV1;
  readonly planner?: MemoryEvidenceQueryPlannerV3;
  readonly supportSelector?: MemoryEvidenceSupportSelectorV1;
  readonly sourceLocalLocator?: MemorySourceLocalEvidenceLocatorV1;
  readonly sourceLocalBudget?: MemorySourceLocalEvidenceBudgetV1;
  readonly evidenceTimeUpperBound?: string;
  readonly closureAuditor?: MemoryEvidenceClosureAuditorV1;
  readonly maxSources?: number;
  /** Exact addresses retained inside each selected source before hydration. */
  readonly maxEvidencePerSource?: number;
  readonly maxHitsPerRequirement?: number;
  readonly maxNotebookChars?: number;
}): Readonly<{
  resolverVersion: typeof PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1;
  resolve(
    query: string,
    signal: AbortSignal,
  ): Promise<MemoryEvidenceResolutionV1>;
}> {
  const maxSources = boundedInteger(input.maxSources ?? 8, 1, 16);
  const maxEvidencePerSource = boundedInteger(
    input.maxEvidencePerSource ?? 8,
    1,
    16,
  );
  const maxHitsPerRequirement = boundedInteger(
    input.maxHitsPerRequirement ?? 2,
    1,
    4,
  );
  const maxNotebookChars = boundedInteger(
    input.maxNotebookChars ?? 4_096,
    256,
    16_384,
  );
  return Object.freeze({
    resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
    async resolve(query: string, signal: AbortSignal) {
      const value = boundedQuery(query);
      const intent = classifyMemoryEvidenceQueryV3(value);
      const primary = await input.index.search(value, signal);
      const primaryFusion = rankMemoryEvidenceCandidatesV2({
        lists: primary.lists,
        maxSources,
        maxEvidencePerSource,
      });
      const directCertificateStatus: MemoryEvidenceResolutionV1["directCertificateStatus"] =
        intent.needsPlanning
          ? "not_applicable"
          : hasDeterministicDirectCertificate(
                value,
                primary.hits,
                primaryFusion.sources.map((source) => source.sourceId),
                intent.roleConstraint === "assistant",
              )
            ? "deterministic_direct"
            : "missing";
      let requirements: readonly MemoryEvidenceRequirementV3[] = [];
      let plannerStatus: MemoryEvidenceResolutionV1["plannerStatus"] =
        intent.needsPlanning ? "fallback" : "not_needed";
      const shouldPlan =
        input.planner !== undefined &&
        (intent.needsPlanning ||
          directCertificateStatus !== "deterministic_direct");
      if (shouldPlan && input.planner) {
        try {
          const plan = await input.planner.plan(value, signal, {
            force: !intent.needsPlanning,
          });
          if (plan.requirements.length === 0) {
            throw namedError("MemoryEvidenceQueryPlanRequirementsEmpty");
          }
          requirements = plan.requirements;
          plannerStatus = "completed";
        } catch (error) {
          if (signal.aborted || isAbort(error)) throw abortError();
          plannerStatus = "fallback";
        }
      }
      // An empty requirement set must not bypass semantic verification. Bind
      // the original question as one root requirement and run the same support
      // gate used by decomposed queries, including deterministic direct hits.
      if (requirements.length === 0 && input.supportSelector) {
        requirements = Object.freeze([
          createRootEvidenceRequirement(value, intent),
        ]);
      }
      const pass = await resolveEvidencePass({
        index: input.index,
        supportSelector: input.supportSelector,
        query: value,
        intent,
        primary,
        requirements,
        maxSources,
        maxEvidencePerSource,
        maxHitsPerRequirement,
        maxNotebookChars,
        directCertificateStatus,
        sourceLocalLocator: input.sourceLocalLocator,
        sourceLocalBudget:
          input.sourceLocalBudget ??
          DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
        evidenceTimeUpperBound: input.evidenceTimeUpperBound,
        signal,
      });
      let closureAuditStatus: MemoryEvidenceResolutionV1["closureAuditStatus"] =
        input.closureAuditor ? "not_needed" : "not_configured";
      let closureVerdict: MemoryEvidenceClosureVerdictV1 | undefined;
      const closureRepairCount: 0 | 1 = 0;
      let closureAuditRevision: string | undefined;
      const shouldAudit =
        input.closureAuditor !== undefined &&
        requirements.length > 0 &&
        pass.notebook.coverage.every((item) => item.status === "covered") &&
        (intent.roleConstraint === "assistant" ||
          intent.temporalMode !== "any" ||
          intent.answerShape !== "lookup" ||
          requirements.length > 1 ||
          (directCertificateStatus === "missing" &&
            pass.fusion.sources.length > 1));
      if (shouldAudit && input.closureAuditor) {
        const selectedEvidence = selectedNotebookEvidence(
          pass.requirementHits,
          pass.notebook,
        );
        try {
          const audit = await input.closureAuditor.audit(
            {
              query: value,
              intent,
              requirements,
              selectedEvidence,
              maxMissingRequirements: Math.min(2, 4 - requirements.length),
            },
            signal,
          );
          closureAuditStatus = "completed";
          // The old model-driven repair loop is intentionally audit-only. It
          // must not perform retrieval or alter source fusion; source-local
          // evidence now enters solely through the independent locator port.
          closureVerdict =
            audit.verdict === "repair" ? "insufficient" : audit.verdict;
          closureAuditRevision = audit.auditRevision;
        } catch (error) {
          if (signal.aborted || isAbort(error)) throw abortError();
          closureAuditStatus = "fallback";
        }
      }
      const {
        fusion,
        degradedChannels,
        supportSelectorStatus,
        supportSelectionRevision,
        supportAssessments,
        sourceLocalization,
        notebook,
        packetSources,
      } = pass;
      const revisionBody = {
        resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
        indexVersion: input.index.indexVersion,
        fusionVersion: PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
        notebookVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
        intent,
        directCertificateStatus,
        plannerStatus,
        supportSelectorStatus,
        closureAuditStatus,
        closureVerdict,
        closureRepairCount,
        supportAssessments,
        sourceLocalization,
        degradedChannels,
        ...(input.supportSelector === undefined
          ? {}
          : { supportSelectorVersion: input.supportSelector.selectorVersion }),
        ...(supportSelectionRevision === undefined
          ? {}
          : { supportSelectionRevision }),
        ...(input.closureAuditor === undefined
          ? {}
          : { closureAuditorVersion: input.closureAuditor.auditorVersion }),
        ...(closureAuditRevision === undefined ? {} : { closureAuditRevision }),
        requirements: requirements.map(({ searchText, ...requirement }) => ({
          ...requirement,
          searchTextHash: hashCanonicalJsonV1(searchText as JsonValue),
        })),
        sources: fusion.sources.map((source) => ({
          sourceId: source.sourceId,
          evidenceRefs: source.evidence.map((item) => item.evidenceRef),
        })),
        coverage: notebook.coverage,
        packetSources: packetSources.map((source) => ({
          sourceId: source.sourceId,
          evidenceRefs: source.evidenceRefs,
        })),
      };
      return Object.freeze({
        resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
        indexVersion: input.index.indexVersion,
        intent,
        directCertificateStatus,
        plannerStatus,
        supportSelectorStatus,
        closureAuditStatus,
        ...(closureVerdict === undefined ? {} : { closureVerdict }),
        closureRepairCount,
        supportAssessments,
        sourceLocalization,
        degradedChannels,
        ...(input.supportSelector === undefined
          ? {}
          : { supportSelectorVersion: input.supportSelector.selectorVersion }),
        ...(supportSelectionRevision === undefined
          ? {}
          : { supportSelectionRevision }),
        ...(input.closureAuditor === undefined
          ? {}
          : { closureAuditorVersion: input.closureAuditor.auditorVersion }),
        ...(closureAuditRevision === undefined ? {} : { closureAuditRevision }),
        requirements,
        sources: fusion.sources,
        primaryHits: primary.hits,
        packetSources,
        telemetry: fusion.telemetry,
        notebook,
        resolutionRevision: hashCanonicalJsonV1(
          revisionBody as unknown as JsonValue,
        ),
      });
    },
  });
}

interface MemoryEvidenceResolutionPassV1 {
  readonly fusion: MemoryEvidenceCandidateFusionV2;
  readonly degradedChannels: readonly ("l0" | "l1")[];
  readonly requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[];
  readonly supportSelectorStatus: MemoryEvidenceResolutionV1["supportSelectorStatus"];
  readonly supportSelectionRevision?: string;
  readonly supportAssessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  readonly sourceLocalization: MemorySourceLocalizationReportV1;
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly packetSources: MemoryEvidenceResolutionV1["packetSources"];
}

async function resolveEvidencePass(input: {
  readonly index: MemoryEvidenceIndexV1;
  readonly supportSelector?: MemoryEvidenceSupportSelectorV1;
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly primary: MemoryEvidenceIndexSearchResultV1;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly maxSources: number;
  readonly maxEvidencePerSource: number;
  readonly maxHitsPerRequirement: number;
  readonly maxNotebookChars: number;
  readonly directCertificateStatus: MemoryEvidenceResolutionV1["directCertificateStatus"];
  readonly sourceLocalLocator?: MemorySourceLocalEvidenceLocatorV1;
  readonly sourceLocalBudget?: MemorySourceLocalEvidenceBudgetV1;
  readonly evidenceTimeUpperBound?: string;
  readonly excludedEvidenceRefs?: ReadonlySet<string>;
  readonly signal: AbortSignal;
}): Promise<MemoryEvidenceResolutionPassV1> {
  const supplemental = await Promise.all(
    input.requirements.map((requirement) =>
      requirement.searchText === input.query
        ? Promise.resolve(input.primary)
        : input.index.search(requirement.searchText, input.signal),
    ),
  );
  const discoveryResults: Array<
    Readonly<{
      searchText: string;
      result: MemoryEvidenceIndexSearchResultV1;
    }>
  > = [{ searchText: input.query, result: input.primary }];
  const seenDiscoveryTexts = new Set([input.query]);
  for (const [index, requirement] of input.requirements.entries()) {
    if (seenDiscoveryTexts.has(requirement.searchText)) continue;
    const result = supplemental[index];
    if (!result) throw namedError("MemoryEvidenceDiscoveryMissing");
    seenDiscoveryTexts.add(requirement.searchText);
    discoveryResults.push({ searchText: requirement.searchText, result });
  }
  const fusion = rankMemoryEvidenceCandidatesV2({
    lists: discoveryResults.flatMap(({ result }, searchIndex) =>
      result.lists.map((list, listIndex) => ({
        ...list,
        retrieverId: `${list.retrieverId}:discovery-${searchIndex}-${listIndex}`,
        weight: list.weight * (searchIndex === 0 ? 1 : 0.8),
      })),
    ),
    maxSources: input.maxSources,
    maxEvidencePerSource: input.maxEvidencePerSource,
  });
  const degradedChannels = Object.freeze(
    [
      ...new Set(
        discoveryResults.flatMap(({ result }) => result.degradedChannels ?? []),
      ),
    ].sort(),
  ) as readonly ("l0" | "l1")[];
  const sourceIds = fusion.sources.map((source) => source.sourceId);
  const baselineRequirementHits = input.requirements.map((_, index) =>
    mergeEvidenceHits(
      supplemental[index]?.hits ?? [],
      input.primary.hits,
    ).filter((hit) => !input.excludedEvidenceRefs?.has(hit.evidenceRef)),
  );
  let requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[] =
    baselineRequirementHits;
  let localEvidenceRefs = new Set<string>();
  let sourceLocalization: MemorySourceLocalizationReportV1 = Object.freeze({
    status: "not_needed",
    reasonCode: "route_ineligible",
    addedCandidateCount: 0,
    selectedCandidateCount: 0,
  });
  const localEligible = isMemorySourceLocalEvidenceEligibleV1({
    answerShape: input.intent.answerShape,
    temporalMode: input.intent.temporalMode,
    roleConstraint: input.intent.roleConstraint,
    requirements: input.requirements,
    supportSelectorConfigured: input.supportSelector !== undefined,
  });
  if (localEligible && sourceIds.length > 0) {
    if (!input.sourceLocalLocator) {
      sourceLocalization = Object.freeze({
        status: "not_configured",
        reasonCode: "locator_missing",
        addedCandidateCount: 0,
        selectedCandidateCount: 0,
      });
    } else {
      const requirement = input.requirements[0];
      if (!requirement) throw namedError("MemorySourceLocalRequirementMissing");
      const request = Object.freeze({
        requirement,
        lockedSourceIds: Object.freeze([...sourceIds]),
        ...(input.evidenceTimeUpperBound === undefined
          ? {}
          : { evidenceTimeUpperBound: input.evidenceTimeUpperBound }),
        budget:
          input.sourceLocalBudget ??
          DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
      });
      try {
        const result = await input.sourceLocalLocator.locate(
          request,
          input.signal,
        );
        const hits = validateMemorySourceLocalEvidenceResultV1({
          locator: input.sourceLocalLocator,
          request,
          result,
        });
        localEvidenceRefs = new Set(hits.map((hit) => hit.evidenceRef));
        requirementHits = Object.freeze([
          mergeEvidenceHits(hits, baselineRequirementHits[0] ?? []),
        ]);
        sourceLocalization = Object.freeze({
          status: hits.length === 0 ? "completed_empty" : "completed",
          reasonCode:
            hits.length === 0 ? "no_anchor" : "assistant_anchor_found",
          locatorVersion: result.locatorVersion,
          locatorRevision: result.locatorRevision,
          telemetry: result.telemetry,
          addedCandidateCount: hits.length,
          selectedCandidateCount: 0,
        });
      } catch (error) {
        if (input.signal.aborted || isAbort(error)) throw abortError();
        const invalid =
          error instanceof Error &&
          error.name.startsWith("MemorySourceLocalEvidence");
        sourceLocalization = Object.freeze({
          status: invalid ? "invalid_result" : "fallback",
          reasonCode: invalid ? "result_rejected" : "locator_failed",
          locatorVersion: input.sourceLocalLocator.locatorVersion,
          addedCandidateCount: 0,
          selectedCandidateCount: 0,
        });
      }
    }
  }
  let supportSelectorStatus: MemoryEvidenceResolutionV1["supportSelectorStatus"] =
    input.requirements.length === 0
      ? "not_needed"
      : input.supportSelector
        ? "fallback"
        : "not_configured";
  let supportSelectionRevision: string | undefined;
  let supportAssessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[] =
    Object.freeze([]);
  let selectedRefsByRequirement:
    | ReadonlyMap<string, ReadonlySet<string>>
    | undefined;
  if (input.requirements.length > 0 && input.supportSelector) {
    const candidates = selectSupportCandidates(
      requirementHits,
      sourceIds,
      input.intent.roleConstraint === "assistant",
      32,
    );
    if (candidates.length > 0) {
      try {
        const selection = await input.supportSelector.select(
          { query: input.query, requirements: input.requirements, candidates },
          input.signal,
        );
        selectedRefsByRequirement = new Map(
          selection.assessments.map((assessment) => [
            assessment.requirementId,
            new Set(assessment.supportingEvidenceRefs),
          ]),
        );
        supportAssessments = selection.assessments;
        supportSelectionRevision = selection.selectionRevision;
        supportSelectorStatus = "completed";
      } catch (error) {
        if (input.signal.aborted || isAbort(error)) throw abortError();
        supportSelectorStatus = "fallback";
        if (localEvidenceRefs.size > 0) {
          requirementHits = baselineRequirementHits;
          localEvidenceRefs = new Set();
          sourceLocalization = Object.freeze({
            ...sourceLocalization,
            status: "fallback",
            reasonCode: "selector_failed",
            addedCandidateCount: 0,
            selectedCandidateCount: 0,
          });
        }
      }
    }
  }
  const selectedLocalCount = [...(selectedRefsByRequirement?.values() ?? [])]
    .flatMap((refs) => [...refs])
    .filter((ref) => localEvidenceRefs.has(ref)).length;
  if (sourceLocalization.status === "completed") {
    sourceLocalization = Object.freeze({
      ...sourceLocalization,
      selectedCandidateCount: selectedLocalCount,
    });
  }
  const notebook = buildMemoryEvidenceNotebookV1({
    requirements: input.requirements.map((requirement, index) => ({
      requirementId: requirement.requirementId,
      label: requirement.label,
      searchText: requirement.searchText,
      selection: requirement.temporalMode === "latest" ? "latest" : "ranked",
      relation: requirement.relation ?? "direct",
      coverageMode:
        requirement.coverageMode ??
        (requirement.temporalMode === "latest" ? "latest" : "any"),
      minimumEvidence: requirement.minimumEvidence ?? 1,
      hits: filterRequirementHits(
        requirementHits[index] ?? [],
        selectedRefsByRequirement?.get(requirement.requirementId),
      ),
    })),
    allowedSourceIds: sourceIds,
    maxHitsPerRequirement: input.maxHitsPerRequirement,
    maxChars: input.maxNotebookChars,
    allowContextOnly: input.intent.roleConstraint === "assistant",
  });
  const nonSupportingRefs = new Set(
    supportAssessments.flatMap((assessment) => [
      ...assessment.contradictingEvidenceRefs,
      ...assessment.unknownEvidenceRefs,
    ]),
  );
  const packetFallbackHits = mergeEvidenceHits(
    requirementHits
      .flat()
      .filter(
        (hit) =>
          nonSupportingRefs.has(hit.evidenceRef) &&
          !localEvidenceRefs.has(hit.evidenceRef),
      ),
    input.primary.hits,
  ).filter((hit) => !input.excludedEvidenceRefs?.has(hit.evidenceRef));
  const packetSources =
    input.requirements.length > 0
      ? buildPlannedEvidencePacketSources({
          query: input.query,
          notebook,
          primaryHits: packetFallbackHits,
          selectedSourceIds: sourceIds,
          allowContextOnly: input.intent.roleConstraint === "assistant",
          includeFallback:
            input.intent.temporalMode !== "latest" ||
            notebook.coverage.some((item) => item.status !== "covered") ||
            nonSupportingRefs.size > 0,
          fallbackAnswerRole:
            input.directCertificateStatus === "deterministic_direct"
              ? "supporting"
              : "candidate",
          maxFallbackChars: input.maxNotebookChars,
        })
      : buildPrimaryEvidencePacketSources(
          input.primary.hits,
          sourceIds,
          input.intent.roleConstraint === "assistant",
          2,
          input.maxNotebookChars,
          new Set(),
          "supporting",
          input.query,
        );
  return Object.freeze({
    fusion,
    degradedChannels,
    requirementHits,
    supportSelectorStatus,
    ...(supportSelectionRevision === undefined
      ? {}
      : { supportSelectionRevision }),
    supportAssessments,
    sourceLocalization,
    notebook,
    packetSources,
  });
}

function selectedNotebookEvidence(
  requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[],
  notebook: MemoryEvidenceNotebookV1,
): readonly MemoryEvidenceNotebookHitV1[] {
  const selectedRefs = new Set(
    notebook.coverage.flatMap((item) => item.selectedEvidenceRefs),
  );
  return mergeEvidenceHits(requirementHits.flat(), []).filter((hit) =>
    selectedRefs.has(hit.evidenceRef),
  );
}

function createRootEvidenceRequirement(
  query: string,
  intent: MemoryEvidenceQueryIntentV3,
): MemoryEvidenceRequirementV3 {
  return Object.freeze({
    requirementId: "root-requirement",
    label: query.slice(0, 192),
    searchText: query.slice(0, 192),
    temporalMode: intent.temporalMode,
    roleConstraint: intent.roleConstraint,
    relation:
      intent.temporalMode === "latest"
        ? "temporal"
        : intent.answerShape === "compare" || intent.answerShape === "aggregate"
          ? "comparative"
          : "direct",
    coverageMode: intent.temporalMode === "latest" ? "latest" : "any",
    minimumEvidence: 1,
  });
}

function selectSupportCandidates(
  requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[],
  selectedSourceIds: readonly string[],
  allowContextOnly: boolean,
  maximum: number,
): readonly MemoryEvidenceNotebookHitV1[] {
  const allowed = new Set(selectedSourceIds);
  const rows = requirementHits.map((hits) =>
    hits.filter(
      (hit) =>
        allowed.has(hit.sourceId) &&
        (hit.authority !== "context_only" || allowContextOnly),
    ),
  );
  const output: MemoryEvidenceNotebookHitV1[] = [];
  const seen = new Set<string>();
  for (let rank = 0; output.length < maximum; rank += 1) {
    let found = false;
    for (const hits of rows) {
      const hit = hits[rank];
      if (!hit) continue;
      found = true;
      if (seen.has(hit.evidenceRef)) continue;
      seen.add(hit.evidenceRef);
      output.push(hit);
      if (output.length >= maximum) break;
    }
    if (!found) break;
  }
  return Object.freeze(output);
}

function filterRequirementHits(
  hits: readonly MemoryEvidenceNotebookHitV1[],
  selectedRefs: ReadonlySet<string> | undefined,
): readonly MemoryEvidenceNotebookHitV1[] {
  if (selectedRefs === undefined) return hits;
  return Object.freeze(hits.filter((hit) => selectedRefs.has(hit.evidenceRef)));
}

function buildPrimaryEvidencePacketSources(
  hits: readonly MemoryEvidenceNotebookHitV1[],
  selectedSourceIds: readonly string[],
  allowContextOnly: boolean,
  maxHitsPerSource: number,
  maxChars: number,
  excludedEvidenceRefs: ReadonlySet<string> = new Set(),
  answerRole: "supporting" | "candidate" = "supporting",
  query = "",
): readonly Readonly<{
  sourceId: string;
  text: string;
  evidenceRefs: readonly string[];
  answerRole: "supporting" | "candidate";
}>[] {
  const output: Array<{
    sourceId: string;
    text: string;
    evidenceRefs: readonly string[];
    answerRole: "supporting" | "candidate";
  }> = [];
  let chars = 0;
  for (const sourceId of selectedSourceIds) {
    const selected = hits
      .filter(
        (hit) =>
          hit.sourceId === sourceId &&
          !excludedEvidenceRefs.has(hit.evidenceRef) &&
          (hit.authority !== "context_only" || allowContextOnly),
      )
      .map((hit, rank) => ({
        hit,
        rank,
        ordinalScore: memoryEvidenceOrdinalAnchorScoreV1(hit.content, query),
      }))
      .sort(
        (left, right) =>
          right.ordinalScore - left.ordinalScore || left.rank - right.rank,
      )
      .slice(0, maxHitsPerSource);
    if (selected.length === 0) continue;
    const text = [
      "[Primary exact memory evidence]",
      ...selected.map(
        ({ hit }) =>
          `[authority=${hit.authority}; observed=${hit.observedAt ?? "unknown"}; evidence=${hit.evidenceRef}]\n${hit.content}`,
      ),
    ].join("\n\n");
    if (chars + text.length > maxChars) continue;
    output.push({
      sourceId,
      text,
      evidenceRefs: Object.freeze(selected.map(({ hit }) => hit.evidenceRef)),
      answerRole,
    });
    chars += text.length;
  }
  return Object.freeze(output.map((item) => Object.freeze(item)));
}

function buildPlannedEvidencePacketSources(input: {
  readonly query: string;
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly primaryHits: readonly MemoryEvidenceNotebookHitV1[];
  readonly selectedSourceIds: readonly string[];
  readonly allowContextOnly: boolean;
  readonly includeFallback: boolean;
  readonly fallbackAnswerRole: "supporting" | "candidate";
  readonly maxFallbackChars: number;
}): MemoryEvidenceResolutionV1["packetSources"] {
  if (!input.includeFallback) return input.notebook.sources;
  const selectedRefs = new Set(
    input.notebook.coverage.flatMap((item) => item.selectedEvidenceRefs),
  );
  const fallback = buildPrimaryEvidencePacketSources(
    input.primaryHits,
    input.selectedSourceIds,
    input.allowContextOnly,
    1,
    input.maxFallbackChars,
    selectedRefs,
    input.fallbackAnswerRole,
    input.query,
  );
  const bySource = new Map<
    string,
    {
      parts: string[];
      evidenceRefs: string[];
      answerRoles: Set<
        "current" | "ambiguous" | "supporting" | "candidate" | "mixed"
      >;
    }
  >();
  for (const source of [...input.notebook.sources, ...fallback]) {
    const current = bySource.get(source.sourceId) ?? {
      parts: [],
      evidenceRefs: [],
      answerRoles: new Set(),
    };
    current.parts.push(source.text);
    current.evidenceRefs.push(...source.evidenceRefs);
    current.answerRoles.add(source.answerRole);
    bySource.set(source.sourceId, current);
  }
  const orderedIds = [
    ...input.selectedSourceIds,
    ...input.notebook.sources.map((source) => source.sourceId),
  ];
  return Object.freeze(
    [...new Set(orderedIds)].flatMap((sourceId) => {
      const value = bySource.get(sourceId);
      if (!value) return [];
      return [
        Object.freeze({
          sourceId,
          text: value.parts.join("\n\n[Bounded primary fallback]\n"),
          evidenceRefs: Object.freeze([...new Set(value.evidenceRefs)]),
          answerRole: singleAnswerRole(value.answerRoles),
        }),
      ];
    }),
  );
}

function singleAnswerRole<T extends string>(
  roles: ReadonlySet<T>,
): T | "mixed" {
  return roles.size === 1 ? (roles.values().next().value ?? "mixed") : "mixed";
}

function mergeEvidenceHits(
  focused: readonly MemoryEvidenceNotebookHitV1[],
  primary: readonly MemoryEvidenceNotebookHitV1[],
): readonly MemoryEvidenceNotebookHitV1[] {
  const output: MemoryEvidenceNotebookHitV1[] = [];
  const seenRefs = new Set<string>();
  const seenContent = new Set<string>();
  for (const hit of [...focused, ...primary]) {
    const evidenceRef = hit.evidenceRef.trim();
    const content = hit.content.trim().replace(/\s+/gu, " ");
    const contentKey = `${hit.sourceId.trim()}\0${content}`;
    if (
      !evidenceRef ||
      !content ||
      seenRefs.has(evidenceRef) ||
      seenContent.has(contentKey)
    ) {
      continue;
    }
    seenRefs.add(evidenceRef);
    seenContent.add(contentKey);
    output.push(hit);
  }
  return Object.freeze(output);
}

function hasDeterministicDirectCertificate(
  query: string,
  hits: readonly MemoryEvidenceNotebookHitV1[],
  selectedSourceIds: readonly string[],
  allowContextOnly: boolean,
): boolean {
  const allowed = new Set(selectedSourceIds);
  const scoreBySource = new Map<string, number>();
  for (const hit of hits) {
    const sourceId = hit.sourceId.trim();
    if (
      !allowed.has(sourceId) ||
      !hit.evidenceRef.trim() ||
      !hit.content.trim() ||
      (hit.authority === "context_only" && !allowContextOnly)
    ) {
      continue;
    }
    const score = memoryEvidenceSupportScoreV1(query, hit.content);
    scoreBySource.set(
      sourceId,
      Math.max(scoreBySource.get(sourceId) ?? 0, score),
    );
  }
  const scores = [...scoreBySource.values()].sort(
    (left, right) => right - left,
  );
  const best = scores[0] ?? 0;
  const runnerUp = scores[1] ?? 0;
  // This is intentionally a narrow, deterministic certificate: a hydrated
  // exact address must contain meaningful query evidence and be materially
  // stronger than every competing source. Anything ambiguous pays for the
  // bounded planner instead of being declared sufficient by source count.
  return best >= 4 && (scores.length === 1 || best >= runnerUp + 2);
}

function boundedQuery(query: string): string {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryEvidenceResolverQueryInvalid");
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw namedError("MemoryEvidenceResolverBudgetInvalid");
  }
  return value;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function abortError(): Error {
  return namedError("AbortError");
}
