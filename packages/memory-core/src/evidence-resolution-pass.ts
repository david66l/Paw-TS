import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type MemoryEvidenceCandidateFusionV2,
  type MemoryEvidenceNotebookHitV1,
  type MemoryEvidenceNotebookV1,
  buildMemoryEvidenceNotebookV1,
  rankMemoryEvidenceCandidatesV2,
} from "./evidence-first.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./evidence-query-planner.js";
import type {
  MemoryEvidenceIndexSearchResultV1,
  MemoryEvidenceIndexV1,
  MemoryEvidenceResolutionV1,
} from "./evidence-resolution-contracts.js";
import {
  abortError,
  buildDialogueSourceDiscoveryV1,
  buildPlannedEvidencePacketSources,
  buildPrimaryEvidencePacketSources,
  filterEvidenceSearchResultForRole,
  filterRequirementHits,
  isAbort,
  mergeEvidenceHits,
  namedError,
} from "./evidence-resolver-helpers.js";
import {
  type SupportSelectionStateV1,
  mergeSupportSelectionsV1,
  selectEvidenceSupportV1,
} from "./evidence-support-pass.js";
import type {
  MemoryEvidenceSupportSelectorV1,
  MemoryEvidenceTriageAssessmentV1,
} from "./evidence-support-selector.js";
import {
  DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
  type MemorySourceLocalEvidenceBudgetV1,
  type MemorySourceLocalEvidenceHitV1,
  type MemorySourceLocalEvidenceHydratorV1,
  type MemorySourceLocalEvidenceLocatorV1,
  type MemorySourceLocalEvidenceResultV1,
  type MemorySourceLocalizationReportV1,
  hydrateMemorySourceLocalEvidenceResultV1,
  isMemorySourceLocalEvidenceEligibleV1,
  memorySourceLocalEvidenceFailureCodeV1,
  validateMemorySourceLocalEvidenceResultV1,
} from "./source-local-evidence-locator.js";

const MAX_DIALOGUE_DISCOVERY_SOURCES_V1 = 4;

export interface MemoryEvidenceResolutionPassV1 {
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

export async function resolveEvidencePass(input: {
  readonly index: MemoryEvidenceIndexV1;
  readonly supportSelector?: MemoryEvidenceSupportSelectorV1;
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly primary: MemoryEvidenceIndexSearchResultV1;
  /** Same index response before the primary user-authority projection. */
  readonly primaryUnfiltered: MemoryEvidenceIndexSearchResultV1;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly maxSources: number;
  readonly maxEvidencePerSource: number;
  readonly maxHitsPerRequirement: number;
  readonly maxNotebookChars: number;
  readonly directCertificateStatus: MemoryEvidenceResolutionV1["directCertificateStatus"];
  readonly sourceLocalLocator?: MemorySourceLocalEvidenceLocatorV1;
  readonly sourceLocalHydrator?: MemorySourceLocalEvidenceHydratorV1;
  readonly sourceLocalBudget?: MemorySourceLocalEvidenceBudgetV1;
  readonly certifiedAssistantDialogueCandidate: boolean;
  readonly evidenceTimeUpperBound?: string;
  readonly excludedEvidenceRefs?: ReadonlySet<string>;
  readonly signal: AbortSignal;
}): Promise<MemoryEvidenceResolutionPassV1> {
  const supplementalUnfiltered = await Promise.all(
    input.requirements.map((requirement) =>
      requirement.searchText === input.query
        ? Promise.resolve(input.primaryUnfiltered)
        : input.index.search(requirement.searchText, input.signal),
    ),
  );
  const supplemental = supplementalUnfiltered.map((result) =>
    filterEvidenceSearchResultForRole(result, input.intent.roleConstraint),
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
  const localEligible = isMemorySourceLocalEvidenceEligibleV1({
    answerShape: input.intent.answerShape,
    temporalMode: input.intent.temporalMode,
    roleConstraint: input.intent.roleConstraint,
    requirements: input.requirements,
    supportSelectorConfigured: input.supportSelector !== undefined,
    certifiedAssistantDialogueCandidate:
      input.certifiedAssistantDialogueCandidate,
  });
  // Eligible dialogue retrieval gets a bounded, source-only second view. L0
  // addresses may widen the locator lock, but neither hit text nor extra
  // sources enter primary fusion or the model-facing packet by themselves.
  const dialogueCandidateSourceIds = localEligible
    ? rankMemoryEvidenceCandidatesV2({
        lists: [
          {
            searchText: input.query,
            result: buildDialogueSourceDiscoveryV1(
              input.primaryUnfiltered,
              sourceIds,
              input.index.evidenceRefBelongsToSource,
            ),
          },
          ...input.requirements.flatMap((requirement, index) =>
            requirement.searchText === input.query
              ? []
              : [
                  {
                    searchText: requirement.searchText,
                    result: buildDialogueSourceDiscoveryV1(
                      supplementalUnfiltered[index] ?? input.primaryUnfiltered,
                      sourceIds,
                      input.index.evidenceRefBelongsToSource,
                    ),
                  },
                ],
          ),
        ].flatMap(({ result }, searchIndex) =>
          result.lists.map((list, listIndex) => ({
            ...list,
            retrieverId: `${list.retrieverId}:dialogue-${searchIndex}-${listIndex}`,
            weight: list.weight * (searchIndex === 0 ? 1 : 0.8),
          })),
        ),
        maxSources: Math.min(
          input.maxSources,
          MAX_DIALOGUE_DISCOVERY_SOURCES_V1,
        ),
        maxEvidencePerSource: input.maxEvidencePerSource,
      }).sources.map((source) => source.sourceId)
    : Object.freeze([]);
  const sourceLocalLockedIds = localEligible
    ? Object.freeze([...new Set([...sourceIds, ...dialogueCandidateSourceIds])])
    : sourceIds;
  const baselineRequirementHits = input.requirements.map((_, index) =>
    mergeEvidenceHits(
      supplemental[index]?.hits ?? [],
      input.primary.hits,
    ).filter((hit) => !input.excludedEvidenceRefs?.has(hit.evidenceRef)),
  );
  let requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[] =
    baselineRequirementHits;
  let localEvidenceRefs = new Set<string>();
  const gapFillOnly =
    localEligible &&
    input.intent.roleConstraint === "user" &&
    !input.certifiedAssistantDialogueCandidate;
  let supportSelection: SupportSelectionStateV1 | undefined;
  let gapRequirementIndexes: readonly number[] = Object.freeze([]);
  if (gapFillOnly && input.supportSelector) {
    try {
      supportSelection = await selectEvidenceSupportV1({
        selector: input.supportSelector,
        query: input.query,
        requirements: input.requirements,
        requirementHits: baselineRequirementHits,
        selectedSourceIds: sourceLocalLockedIds,
        roleConstraint: input.intent.roleConstraint,
        certifiedAssistantDialogueCandidate: false,
        localEvidenceRefs,
        signal: input.signal,
      });
      if (supportSelection.status === "completed") {
        const baselineSelection = supportSelection;
        const baselineNotebook = buildMemoryEvidenceNotebookV1({
          requirements: input.requirements.map((requirement, index) => ({
            requirementId: requirement.requirementId,
            label: requirement.label,
            searchText: requirement.searchText,
            selection:
              requirement.temporalMode === "latest" ? "latest" : "ranked",
            relation: requirement.relation ?? "direct",
            coverageMode:
              requirement.coverageMode ??
              (requirement.temporalMode === "latest" ? "latest" : "any"),
            minimumEvidence: requirement.minimumEvidence ?? 1,
            roleConstraint: requirement.roleConstraint,
            certifiedDialogueEvidenceRefs: Object.freeze([]),
            hits: filterRequirementHits(
              baselineRequirementHits[index] ?? [],
              baselineSelection.selectedRefsByRequirement.get(
                requirement.requirementId,
              ),
            ),
          })),
          allowedSourceIds: sourceLocalLockedIds,
          maxHitsPerRequirement: input.maxHitsPerRequirement,
          maxChars: input.maxNotebookChars,
          allowContextOnly: false,
        });
        gapRequirementIndexes = Object.freeze(
          baselineNotebook.coverage.flatMap((coverage, index) =>
            coverage.status === "covered" ? [] : [index],
          ),
        );
      }
    } catch (error) {
      if (input.signal.aborted || isAbort(error)) throw abortError();
      supportSelection = Object.freeze({
        status: "fallback",
        assessments: Object.freeze([]),
        selectedRefsByRequirement: new Map(
          input.requirements.map((requirement) => [
            requirement.requirementId,
            new Set<string>(),
          ]),
        ),
      });
    }
  }
  let sourceLocalization: MemorySourceLocalizationReportV1 = Object.freeze({
    status: "not_needed",
    reasonCode:
      gapFillOnly && supportSelection?.status === "completed"
        ? "baseline_closed"
        : gapFillOnly
          ? "baseline_selector_unavailable"
          : "route_ineligible",
    addedCandidateCount: 0,
    selectedCandidateCount: 0,
  });
  const shouldLocateLocal =
    localEligible &&
    sourceLocalLockedIds.length > 0 &&
    (!gapFillOnly || gapRequirementIndexes.length > 0);
  if (shouldLocateLocal) {
    if (!input.sourceLocalLocator) {
      sourceLocalization = Object.freeze({
        status: "not_configured",
        reasonCode: "locator_missing",
        addedCandidateCount: 0,
        selectedCandidateCount: 0,
      });
    } else if (!input.sourceLocalHydrator) {
      sourceLocalization = Object.freeze({
        status: "not_configured",
        reasonCode: "hydrator_missing",
        locatorVersion: input.sourceLocalLocator.locatorVersion,
        addedCandidateCount: 0,
        selectedCandidateCount: 0,
      });
    } else {
      try {
        const located: Array<
          Readonly<{
            requirementIndex: number;
            result: MemorySourceLocalEvidenceResultV1;
            hits: readonly MemorySourceLocalEvidenceHitV1[];
          }>
        > = [];
        const requirementIndexes = gapFillOnly
          ? gapRequirementIndexes
          : input.requirements.map((_, index) => index);
        for (const requirementIndex of requirementIndexes) {
          const requirement = input.requirements[requirementIndex];
          if (!requirement)
            throw namedError("MemoryEvidenceRequirementMissing");
          const request = Object.freeze({
            requirement,
            ...(input.certifiedAssistantDialogueCandidate
              ? { assistantDialogueCandidate: true }
              : {}),
            lockedSourceIds: Object.freeze([...sourceLocalLockedIds]),
            ...(input.evidenceTimeUpperBound === undefined
              ? {}
              : { evidenceTimeUpperBound: input.evidenceTimeUpperBound }),
            budget:
              input.sourceLocalBudget ??
              DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
          });
          const locatedResult = await input.sourceLocalLocator.locate(
            request,
            input.signal,
          );
          validateMemorySourceLocalEvidenceResultV1({
            locator: input.sourceLocalLocator,
            request,
            result: locatedResult,
          });
          const result = await hydrateMemorySourceLocalEvidenceResultV1({
            hydrator: input.sourceLocalHydrator,
            request,
            result: locatedResult,
            signal: input.signal,
          });
          const hits = validateMemorySourceLocalEvidenceResultV1({
            locator: input.sourceLocalLocator,
            request,
            result,
          });
          located.push(Object.freeze({ requirementIndex, result, hits }));
        }
        localEvidenceRefs = new Set(
          located.flatMap(({ hits }) => hits.map((hit) => hit.evidenceRef)),
        );
        requirementHits = Object.freeze(
          baselineRequirementHits.map((hits, index) =>
            mergeEvidenceHits(
              located.find((item) => item.requirementIndex === index)?.hits ??
                [],
              hits,
            ),
          ),
        );
        const results = located.map(({ result }) => result);
        const locatorRevisions = results.map(
          (result) => result.locatorRevision,
        );
        const telemetry = Object.freeze({
          lexicalCandidates: results.reduce(
            (total, result) => total + result.telemetry.lexicalCandidates,
            0,
          ),
          denseCandidates: results.reduce(
            (total, result) => total + result.telemetry.denseCandidates,
            0,
          ),
          anchorCount: results.reduce(
            (total, result) => total + result.telemetry.anchorCount,
            0,
          ),
          includedTurnCount: results.reduce(
            (total, result) => total + result.telemetry.includedTurnCount,
            0,
          ),
          renderedChars: results.reduce(
            (total, result) => total + result.telemetry.renderedChars,
            0,
          ),
          cacheHit: results.every((result) => result.telemetry.cacheHit),
          durationMs: results.reduce(
            (total, result) => total + result.telemetry.durationMs,
            0,
          ),
        });
        sourceLocalization = Object.freeze({
          status:
            localEvidenceRefs.size === 0 ? "completed_empty" : "completed",
          reasonCode:
            localEvidenceRefs.size === 0
              ? "no_anchor"
              : "evidence_anchor_found",
          locatorVersion: input.sourceLocalLocator.locatorVersion,
          hydratorVersion: input.sourceLocalHydrator.hydratorVersion,
          locatorRevision:
            locatorRevisions.length === 1
              ? locatorRevisions[0]
              : hashCanonicalJsonV1({
                  schemaVersion: "paw.memory-source-local-batch-revision.v1",
                  revisions: locatorRevisions,
                }),
          telemetry,
          addedCandidateCount: localEvidenceRefs.size,
          selectedCandidateCount: 0,
        });
      } catch (error) {
        if (input.signal.aborted || isAbort(error)) throw abortError();
        const failureCode = memorySourceLocalEvidenceFailureCodeV1(error);
        const invalid = failureCode !== undefined;
        sourceLocalization = Object.freeze({
          status: invalid ? "invalid_result" : "fallback",
          reasonCode: invalid ? "result_rejected" : "locator_failed",
          ...(failureCode === undefined ? {} : { failureCode }),
          locatorVersion: input.sourceLocalLocator.locatorVersion,
          hydratorVersion: input.sourceLocalHydrator.hydratorVersion,
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
    try {
      if (!supportSelection) {
        supportSelection = await selectEvidenceSupportV1({
          selector: input.supportSelector,
          query: input.query,
          requirements: input.requirements,
          requirementHits,
          selectedSourceIds: sourceLocalLockedIds,
          roleConstraint: input.intent.roleConstraint,
          certifiedAssistantDialogueCandidate:
            input.certifiedAssistantDialogueCandidate,
          localEvidenceRefs,
          signal: input.signal,
        });
      } else if (
        gapFillOnly &&
        supportSelection.status === "completed" &&
        localEvidenceRefs.size > 0 &&
        gapRequirementIndexes.length > 0
      ) {
        const gapRequirements = gapRequirementIndexes.flatMap((index) => {
          const requirement = input.requirements[index];
          return requirement ? [requirement] : [];
        });
        const gapHits = gapRequirementIndexes.map((index) =>
          (requirementHits[index] ?? []).filter((hit) =>
            localEvidenceRefs.has(hit.evidenceRef),
          ),
        );
        const repairSelection = await selectEvidenceSupportV1({
          selector: input.supportSelector,
          query: input.query,
          requirements: gapRequirements,
          requirementHits: gapHits,
          selectedSourceIds: sourceLocalLockedIds,
          roleConstraint: input.intent.roleConstraint,
          certifiedAssistantDialogueCandidate: false,
          localEvidenceRefs,
          signal: input.signal,
        });
        if (repairSelection.status === "completed") {
          supportSelection = mergeSupportSelectionsV1(
            supportSelection,
            repairSelection,
          );
        }
      }
      supportSelectorStatus = supportSelection.status;
      supportSelectionRevision = supportSelection.revision;
      supportAssessments = supportSelection.assessments;
      selectedRefsByRequirement = supportSelection.selectedRefsByRequirement;
    } catch (error) {
      if (input.signal.aborted || isAbort(error)) throw abortError();
      if (gapFillOnly && supportSelection?.status === "completed") {
        requirementHits = baselineRequirementHits;
        localEvidenceRefs = new Set();
        sourceLocalization = Object.freeze({
          ...sourceLocalization,
          status: "fallback",
          reasonCode: "selector_failed",
          addedCandidateCount: 0,
          selectedCandidateCount: 0,
        });
        supportSelectorStatus = supportSelection.status;
        supportSelectionRevision = supportSelection.revision;
        supportAssessments = supportSelection.assessments;
        selectedRefsByRequirement = supportSelection.selectedRefsByRequirement;
      } else {
        supportSelectorStatus = "fallback";
        selectedRefsByRequirement = new Map(
          input.requirements.map((requirement) => [
            requirement.requirementId,
            new Set<string>(),
          ]),
        );
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
  const selectedLocalCount = new Set(
    [...(selectedRefsByRequirement?.values() ?? [])]
      .flatMap((refs) => [...refs])
      .filter((ref) => localEvidenceRefs.has(ref)),
  ).size;
  if (sourceLocalization.status === "completed") {
    sourceLocalization = Object.freeze({
      ...sourceLocalization,
      selectedCandidateCount: selectedLocalCount,
    });
  }
  // An ambiguous dialogue query may open assistant evidence only after the
  // selector has bound exact evidence refs. Unselected fallback context stays
  // closed even after a successful selection, and all assistant context stays
  // closed when selection fails.
  const allowSelectedContextOnly =
    input.intent.roleConstraint === "assistant" ||
    (input.intent.roleConstraint === "any" &&
      supportSelectorStatus === "completed") ||
    (input.certifiedAssistantDialogueCandidate &&
      supportSelectorStatus === "completed");
  const allowFallbackContextOnly = input.intent.roleConstraint === "assistant";
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
      roleConstraint: requirement.roleConstraint,
      certifiedDialogueEvidenceRefs: Object.freeze([...localEvidenceRefs]),
      hits: filterRequirementHits(
        requirementHits[index] ?? [],
        selectedRefsByRequirement?.get(requirement.requirementId),
      ),
    })),
    allowedSourceIds: sourceLocalLockedIds,
    maxHitsPerRequirement: input.maxHitsPerRequirement,
    maxChars: input.maxNotebookChars,
    allowContextOnly: allowSelectedContextOnly,
  });
  const nonSupportingRefs = new Set(
    supportAssessments.flatMap((assessment) => [
      ...assessment.contradictingEvidenceRefs,
      ...assessment.unknownEvidenceRefs,
    ]),
  );
  const selectedRefs = new Set(
    [...(selectedRefsByRequirement?.values() ?? [])].flatMap((refs) => [
      ...refs,
    ]),
  );
  const retainUnselectedLocalAssistantCandidates =
    input.intent.roleConstraint === "assistant" &&
    supportSelectorStatus === "completed" &&
    sourceLocalization.status === "completed" &&
    notebook.coverage.some((item) => item.status !== "covered");
  const packetFallbackHits = mergeEvidenceHits(
    requirementHits
      .flat()
      .filter(
        (hit) =>
          (nonSupportingRefs.has(hit.evidenceRef) &&
            !localEvidenceRefs.has(hit.evidenceRef)) ||
          (retainUnselectedLocalAssistantCandidates &&
            localEvidenceRefs.has(hit.evidenceRef) &&
            !selectedRefs.has(hit.evidenceRef)),
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
          allowContextOnly: allowFallbackContextOnly,
          includeFallback:
            input.intent.temporalMode !== "latest" ||
            notebook.coverage.some((item) => item.status !== "covered") ||
            nonSupportingRefs.size > 0,
          fallbackAnswerRole:
            input.directCertificateStatus === "deterministic_direct"
              ? "supporting"
              : "candidate",
          maxFallbackChars: input.maxNotebookChars,
          roleConstraint: input.intent.roleConstraint,
          certifiedDialogueEvidenceRefs: localEvidenceRefs,
        })
      : buildPrimaryEvidencePacketSources(
          input.primary.hits,
          sourceIds,
          allowFallbackContextOnly,
          2,
          input.maxNotebookChars,
          new Set(),
          "supporting",
          input.query,
          input.intent.roleConstraint,
          localEvidenceRefs,
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
