import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type MemoryDialogueCertificateRegistryV1,
  compileMemoryDialogueCertificateRegistryV1,
} from "./dialogue-certificate.js";
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
import { buildMemoryEvidenceRequirementLedgerV1 } from "./evidence-requirement-ledger.js";
import type {
  MemoryEvidenceIndexSearchResultV1,
  MemoryEvidenceIndexV1,
  MemoryEvidenceResolutionV1,
} from "./evidence-resolution-contracts.js";
import {
  abortError,
  applyMemoryDeterministicSupportFloorV1,
  buildDialogueSourceDiscoveryV1,
  buildPlannedEvidencePacketSources,
  buildPrimaryEvidencePacketSources,
  enforceSelectedEvidenceAuthority,
  filterEvidenceSearchResultForRole,
  filterRequirementHits,
  isAbort,
  mergeEvidenceHits,
  namedError,
  selectSupportCandidates,
} from "./evidence-resolver-helpers.js";
import {
  PAW_MEMORY_EVIDENCE_SELECTOR_GROUP_POLICY_V1,
  compileMemoryEvidenceSelectorGroupsV1,
} from "./evidence-selector-groups.js";
import type {
  MemoryEvidenceSupportSelectorV1,
  MemoryEvidenceTriageAssessmentV1,
} from "./evidence-support-selector.js";
import {
  type MemoryQueryAnswerOriginMaterializationModeV1,
  type MemoryQueryAnswerOriginV1,
  authorizeMemoryQueryAnswerOriginMaterializationV1,
  memoryQueryAnswerOriginAllowsLateBindingV1,
} from "./query-answer-origin.js";
import type { MemoryEvidenceBoundTemporalConstraintV1 } from "./query-plan-contracts.js";
import {
  type MemoryRequirementFairAcquisitionReportV1,
  buildMemoryRequirementFairAcquisitionV1,
} from "./requirement-fair-acquisition.js";
import {
  type MemorySelectorExecutionGroupInputV1,
  type MemorySelectorExecutionSnapshotV1,
  compileMemorySelectorExecutionSnapshotV1,
} from "./selector-execution-snapshot-v1.js";
import {
  DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
  type MemoryDialoguePredecessorProofV1,
  type MemoryDialoguePredecessorVerifierV1,
  type MemorySourceLocalEvidenceBudgetV1,
  type MemorySourceLocalEvidenceHitV1,
  type MemorySourceLocalEvidenceHydratorV1,
  type MemorySourceLocalEvidenceLocatorV1,
  type MemorySourceLocalEvidenceResultV1,
  type MemorySourceLocalLeafEligibilityV2,
  type MemorySourceLocalLeafExecutionReportV2,
  type MemorySourceLocalizationReportV1,
  evaluateMemorySourceLocalLeafEligibilityV2,
  hasMemorySourceLocalDialogueCertificateV1,
  hydrateMemorySourceLocalEvidenceResultV1,
  isMemorySourceLocalEvidenceEligibleV1,
  isMemorySourceLocalEvidenceRouteEligibleV2,
  memorySourceLocalEvidenceFailureCodeV1,
  validateMemoryDialoguePredecessorVerificationV1,
  validateMemorySourceLocalEvidenceResultV1,
} from "./source-local-evidence-locator.js";
import { routeMemorySourceLocalExecutionV1 } from "./source-local-execution-router.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "./temporal-constraint.js";

const MAX_DIALOGUE_DISCOVERY_SOURCES_V1 = 4;
const MAX_RESPONDING_ASSISTANT_CANDIDATES_V1 = 8;
// The adapter now allocates one pair-level slot per locked source before any
// source receives a second slot. Keep all eight primary sources in aperture.
const RESPONDING_ASSISTANT_PROMPT_ANCHORS_PER_SOURCE_V1 = 1 as const;

export interface MemoryEvidenceResolutionPassV1 {
  /** Query answer slots after evidence-grounded role alternatives are bound. */
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly fusion: MemoryEvidenceCandidateFusionV2;
  readonly sourceAcquisition: MemoryRequirementFairAcquisitionReportV1;
  readonly degradedChannels: readonly ("l0" | "l1")[];
  readonly requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[];
  readonly supportSelectorStatus: MemoryEvidenceResolutionV1["supportSelectorStatus"];
  readonly supportSelectionRevision?: string;
  readonly supportAssessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  /** Internal post-authority transaction state; excluded from formal packets. */
  readonly selectorExecutionSnapshot?: MemorySelectorExecutionSnapshotV1;
  readonly sourceLocalization: MemorySourceLocalizationReportV1;
  /** Exact source aperture used by source-local lookup in this pass. */
  readonly lockedSourceIds: readonly string[];
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly requirementEvidence: MemoryEvidenceResolutionV1["requirementEvidence"];
  readonly packetSources: MemoryEvidenceResolutionV1["packetSources"];
  readonly dialogueCertificateRegistry: MemoryDialogueCertificateRegistryV1;
}

export interface MemoryEvidenceSourceLockV1 {
  readonly fusion: MemoryEvidenceCandidateFusionV2;
  readonly degradedChannels: readonly ("l0" | "l1")[];
  readonly lockedSourceIds: readonly string[];
  readonly seedHits: readonly MemoryEvidenceNotebookHitV1[];
  /** Frozen with the source set so closure cannot acquire a second aperture. */
  readonly sourceAcquisition: MemoryRequirementFairAcquisitionReportV1;
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
  readonly sourceLocalLocator?: MemorySourceLocalEvidenceLocatorV1;
  readonly sourceLocalHydrator?: MemorySourceLocalEvidenceHydratorV1;
  readonly dialoguePredecessorVerifier?: MemoryDialoguePredecessorVerifierV1;
  readonly sourceLocalBudget?: MemorySourceLocalEvidenceBudgetV1;
  /** Immutable query-owned provenance, compiled before planner normalization. */
  readonly queryAnswerOrigin: MemoryQueryAnswerOriginV1;
  /** Feature-gated: may widen a slot only inside the immutable source lock. */
  readonly evidenceGroundedRoleBinding?: boolean;
  readonly evidenceTimeUpperBound?: string;
  readonly excludedEvidenceRefs?: ReadonlySet<string>;
  /**
   * A closure repair may re-open exact evidence inside an existing source
   * aperture. When present, global discovery and source fusion are immutable.
   */
  readonly sourceLock?: MemoryEvidenceSourceLockV1;
  readonly signal: AbortSignal;
}): Promise<MemoryEvidenceResolutionPassV1> {
  // Bind every leaf to the immutable original query and trusted cutoff before
  // any retrieval channel sees it. Legacy custom planners are upgraded
  // ephemerally from their existing temporalMode field.
  const boundTemporalConstraints = input.requirements.map((requirement) =>
    bindMemoryEvidenceTemporalConstraintV1({
      query: input.query,
      queryEnvelopeMode: input.intent.temporalMode,
      leafMode: requirement.temporalMode,
      ...(requirement.temporalConstraint === undefined
        ? {}
        : { constraint: requirement.temporalConstraint }),
      ...(input.evidenceTimeUpperBound === undefined
        ? {}
        : { evidenceTimeUpperBound: input.evidenceTimeUpperBound }),
      applyQueryScope:
        requirement.temporalMode !== "any" ||
        (input.requirements.length === 1 &&
          input.intent.temporalMode === "range"),
    }),
  );
  const sourceLocalRequirements = input.requirements.map(
    (requirement, index) => {
      const bound = boundTemporalConstraints[index];
      if (!bound) throw namedError("MemoryEvidenceTemporalBindingMissing");
      const {
        evidenceTimeUpperBound: _evidenceTimeUpperBound,
        queryScopeInterval: _queryScopeInterval,
        window: _window,
        durationRequest: _durationRequest,
        bindingRevision: _bindingRevision,
        ...temporalConstraint
      } = bound;
      return Object.freeze({
        ...requirement,
        temporalConstraint: Object.freeze(temporalConstraint),
      });
    },
  );
  // The feature gate enables the mechanism, but the query-owned provenance
  // boundary decides whether a user-shaped slot is actually unresolved. An
  // explicit user fact must never become role-neutral merely because a nearby
  // assistant turn can be certified.
  const certifiedAssistantDialogueCandidate =
    memoryQueryAnswerOriginAllowsLateBindingV1(input.queryAnswerOrigin);
  const evidenceGroundedRoleBindingEligible =
    input.evidenceGroundedRoleBinding === true &&
    certifiedAssistantDialogueCandidate;
  const supplementalUnfiltered = input.sourceLock
    ? input.requirements.map(() => ({
        lists: Object.freeze([]),
        // A revised plan is a complete replacement, so requirement IDs cannot
        // safely inherit old per-requirement hit buckets. Re-evaluate every
        // requirement against the bounded evidence inside the locked aperture.
        hits: input.sourceLock?.seedHits ?? Object.freeze([]),
        degradedChannels: input.sourceLock?.degradedChannels,
      }))
    : await Promise.all(
        input.requirements.map((requirement) =>
          requirement.searchText === input.query
            ? Promise.resolve(input.primaryUnfiltered)
            : input.index.search(requirement.searchText, input.signal),
        ),
      );
  const supplemental = supplementalUnfiltered.map((result, index) =>
    filterEvidenceSearchResultForRole(
      result,
      input.requirements[index]?.roleConstraint ?? input.intent.roleConstraint,
    ),
  );
  const leafRoles = new Set(
    input.requirements.map((requirement) => requirement.roleConstraint),
  );
  const assistantLeafPresent = leafRoles.has("assistant");
  // The feature bit alone cannot open the original lane. Only the immutable
  // query-origin validator may authorize role-neutral source acquisition, and
  // that authorization stops at source locking: hits, certificates, support,
  // and notebook authority remain requirement-scoped downstream.
  const originalLaneUsesAuthorizedUnfiltered =
    evidenceGroundedRoleBindingEligible;
  const acquisition = input.sourceLock
    ? Object.freeze({
        fusion: input.sourceLock.fusion,
        report: input.sourceLock.sourceAcquisition,
      })
    : buildMemoryRequirementFairAcquisitionV1({
        queryRevision: hashCanonicalJsonV1(input.query),
        originRevision: input.queryAnswerOrigin.originRevision,
        evidenceTimeUpperBoundRevision:
          input.evidenceTimeUpperBound === undefined
            ? "unbounded"
            : hashCanonicalJsonV1(input.evidenceTimeUpperBound),
        originalRoleConstraint: input.intent.roleConstraint,
        originalLaneMode: originalLaneUsesAuthorizedUnfiltered
          ? "origin_authorized_unfiltered"
          : "role_filtered",
        original: originalLaneUsesAuthorizedUnfiltered
          ? input.primaryUnfiltered
          : input.primary,
        requirements: input.requirements.map((requirement, index) => {
          const result = supplemental[index];
          const temporalConstraint = boundTemporalConstraints[index];
          if (!result || !temporalConstraint) {
            throw namedError("MemoryEvidenceDiscoveryMissing");
          }
          return Object.freeze({
            requirementId: requirement.requirementId,
            roleConstraint: requirement.roleConstraint,
            temporalBindingRevision: temporalConstraint.bindingRevision,
            result,
          });
        }),
        maxSources: input.maxSources,
        maxEvidencePerSource: input.maxEvidencePerSource,
      });
  const fusion = acquisition.fusion;
  const sourceAcquisition = acquisition.report;
  const degradedChannels =
    input.sourceLock?.degradedChannels ??
    (Object.freeze(
      [
        ...new Set(
          [
            originalLaneUsesAuthorizedUnfiltered
              ? input.primaryUnfiltered
              : input.primary,
            ...supplemental,
          ].flatMap((result) => result.degradedChannels ?? []),
        ),
      ].sort(),
    ) as readonly ("l0" | "l1")[]);
  const sourceIds = fusion.sources.map((source) => source.sourceId);
  // Keep the legacy plan gate only for source-only dialogue discovery so this
  // change cannot widen the frozen acquisition/source set. Exact L0 lookup is
  // decided independently for each leaf below.
  const legacyDialogueDiscoveryEligible = isMemorySourceLocalEvidenceEligibleV1(
    {
      answerShape: input.intent.answerShape,
      temporalMode: input.intent.temporalMode,
      roleConstraint: input.intent.roleConstraint,
      requirements: input.requirements,
      supportSelectorConfigured: input.supportSelector !== undefined,
      certifiedAssistantDialogueCandidate: certifiedAssistantDialogueCandidate,
    },
  );
  const ordinaryRouteEligible = isMemorySourceLocalEvidenceRouteEligibleV2({
    answerShape: input.intent.answerShape,
    temporalMode: input.intent.temporalMode,
    roleConstraint: input.intent.roleConstraint,
    requirements: sourceLocalRequirements,
    supportSelectorConfigured: input.supportSelector !== undefined,
    certifiedAssistantDialogueCandidate: certifiedAssistantDialogueCandidate,
  });
  const ordinaryLeafEligibility = sourceLocalRequirements.map(
    (requirement, index) =>
      evaluateMemorySourceLocalLeafEligibilityV2({
        requirement,
        temporalBindingRevision:
          boundTemporalConstraints[index]?.bindingRevision ?? "",
        routeEligible: ordinaryRouteEligible,
        supportSelectorConfigured: input.supportSelector !== undefined,
      }),
  );
  const roleBindingRequirements = evidenceGroundedRoleBindingEligible
    ? sourceLocalRequirements.map((requirement) =>
        Object.freeze({
          ...requirement,
          roleConstraint: "any" as const,
        }),
      )
    : sourceLocalRequirements;
  const roleBindingRouteEligible =
    evidenceGroundedRoleBindingEligible &&
    isMemorySourceLocalEvidenceRouteEligibleV2({
      answerShape: input.intent.answerShape,
      temporalMode: input.intent.temporalMode,
      roleConstraint: "any",
      requirements: roleBindingRequirements,
      supportSelectorConfigured: input.supportSelector !== undefined,
    });
  const roleBindingLeafEligibility = roleBindingRequirements.map(
    (requirement, index) =>
      evaluateMemorySourceLocalLeafEligibilityV2({
        requirement,
        temporalBindingRevision:
          boundTemporalConstraints[index]?.bindingRevision ?? "",
        routeEligible: roleBindingRouteEligible,
        supportSelectorConfigured: input.supportSelector !== undefined,
      }),
  );
  const effectiveLeafEligibility: readonly MemorySourceLocalLeafEligibilityV2[] =
    evidenceGroundedRoleBindingEligible
      ? roleBindingLeafEligibility
      : ordinaryLeafEligibility;
  const sourceLocalExecutionRoute = routeMemorySourceLocalExecutionV1({
    answerShape: input.intent.answerShape,
    roleConstraint: input.intent.roleConstraint,
    requirements: input.requirements,
    certifiedAssistantDialogueCandidate,
    legacyPlanEligible: legacyDialogueDiscoveryEligible,
  });
  const planScopedLocalization =
    sourceLocalExecutionRoute.executor === "plan_scoped_v24";
  const localEligible =
    planScopedLocalization ||
    (sourceLocalExecutionRoute.executor === "per_leaf_v25" &&
      effectiveLeafEligibility.some((eligibility) => eligibility.eligible));
  // Eligible dialogue retrieval gets a bounded, source-only second view. L0
  // addresses may widen the locator lock, but neither hit text nor extra
  // sources enter primary fusion or the model-facing packet by themselves.
  const dialogueCandidateSourceIds =
    legacyDialogueDiscoveryEligible && !input.sourceLock
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
                        supplementalUnfiltered[index] ??
                          input.primaryUnfiltered,
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
  const sourceLocalLockedIds = input.sourceLock
    ? input.sourceLock.lockedSourceIds
    : localEligible
      ? Object.freeze([
          ...new Set([...sourceIds, ...dialogueCandidateSourceIds]),
        ])
      : sourceIds;
  const baselineRequirementHits = input.requirements.map((requirement, index) =>
    mergeEvidenceHits(
      input.sourceLock
        ? input.sourceLock.seedHits
        : (supplemental[index]?.hits ?? []),
      input.sourceLock
        ? []
        : filterEvidenceSearchResultForRole(
            input.primaryUnfiltered,
            requirement.roleConstraint,
          ).hits,
    ).filter((hit) => !input.excludedEvidenceRefs?.has(hit.evidenceRef)),
  );
  let requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[] =
    baselineRequirementHits;
  let localEvidenceRefs = new Set<string>();
  let certifiedAssistantDialogueRefs = new Set<string>();
  let certifiedDialoguePredecessorsByAssistant = new Map<string, string>();
  let certifiedDialogueProofsByAssistant = new Map<
    string,
    MemoryDialoguePredecessorProofV1
  >();
  let dialogueVerifierVersion: string | null = null;
  let dialogueVerificationRevision: string | null = null;
  const sourceLocalExecutionTrace = Object.freeze({
    executor: sourceLocalExecutionRoute.executor,
    executionRouteRevision: sourceLocalExecutionRoute.routeRevision,
  });
  let sourceLocalization: MemorySourceLocalizationReportV1 = Object.freeze({
    ...sourceLocalExecutionTrace,
    status: "not_needed",
    reasonCode: "route_ineligible",
    addedCandidateCount: 0,
    retainedContextCandidateCount: 0,
    selectedCandidateCount: 0,
    leaves: Object.freeze(
      effectiveLeafEligibility.map((eligibility, index) =>
        Object.freeze({
          eligibility,
          status: "not_attempted" as const,
          baselineHitCount: baselineRequirementHits[index]?.length ?? 0,
          localizedHitCount: 0,
        }),
      ),
    ),
  });
  if (localEligible && sourceLocalLockedIds.length > 0) {
    if (!input.sourceLocalLocator) {
      sourceLocalization = Object.freeze({
        ...sourceLocalExecutionTrace,
        status: "not_configured",
        reasonCode: "locator_missing",
        addedCandidateCount: 0,
        retainedContextCandidateCount: 0,
        selectedCandidateCount: 0,
        leaves: sourceLocalization.leaves,
      });
    } else if (!input.sourceLocalHydrator) {
      sourceLocalization = Object.freeze({
        ...sourceLocalExecutionTrace,
        status: "not_configured",
        reasonCode: "hydrator_missing",
        locatorVersion: input.sourceLocalLocator.locatorVersion,
        addedCandidateCount: 0,
        retainedContextCandidateCount: 0,
        selectedCandidateCount: 0,
        leaves: sourceLocalization.leaves,
      });
    } else {
      const located: Array<
        | Readonly<{
            result: MemorySourceLocalEvidenceResultV1;
            hits: readonly MemorySourceLocalEvidenceHitV1[];
          }>
        | undefined
      > = new Array(input.requirements.length);
      const leafReports: MemorySourceLocalLeafExecutionReportV2[] =
        effectiveLeafEligibility.map((eligibility, index) =>
          Object.freeze({
            eligibility,
            status: "not_attempted" as const,
            baselineHitCount: baselineRequirementHits[index]?.length ?? 0,
            localizedHitCount: 0,
          }),
        );
      const locatorExecutionRequirements = planScopedLocalization
        ? input.requirements
        : sourceLocalRequirements;
      for (const [
        requirementIndex,
        requirement,
      ] of locatorExecutionRequirements.entries()) {
        const eligibility = effectiveLeafEligibility[requirementIndex];
        if (!planScopedLocalization && !eligibility?.eligible) continue;
        if (!eligibility)
          throw namedError("MemorySourceLocalEligibilityMissing");
        try {
          const locatorRequirement =
            evidenceGroundedRoleBindingEligible &&
            roleBindingRequirements[requirementIndex]
              ? roleBindingRequirements[requirementIndex]
              : requirement;
          const materializationMode:
            | MemoryQueryAnswerOriginMaterializationModeV1
            | undefined = evidenceGroundedRoleBindingEligible
            ? "late_binding"
            : requirement.roleConstraint === "assistant"
              ? "assistant_leaf"
              : requirement.roleConstraint === "any" &&
                  input.intent.roleConstraint !== "user"
                ? "shared_envelope"
                : undefined;
          const materializationAuthorization = materializationMode
            ? authorizeMemoryQueryAnswerOriginMaterializationV1({
                origin: input.queryAnswerOrigin,
                requirement,
                effectiveRequirementRole: locatorRequirement.roleConstraint,
                mode: materializationMode,
              })
            : undefined;
          const respondingAssistantMaterializationEligible =
            materializationAuthorization !== undefined;
          const baseBudget =
            input.sourceLocalBudget ??
            DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1;
          const respondingAssistantSourceIds = sourceIds.slice(
            0,
            Math.floor(
              MAX_RESPONDING_ASSISTANT_CANDIDATES_V1 /
                RESPONDING_ASSISTANT_PROMPT_ANCHORS_PER_SOURCE_V1,
            ),
          );
          const sourceFairAnchorCount = Math.min(
            MAX_RESPONDING_ASSISTANT_CANDIDATES_V1,
            respondingAssistantSourceIds.length *
              RESPONDING_ASSISTANT_PROMPT_ANCHORS_PER_SOURCE_V1,
          );
          const locatorBudget = respondingAssistantMaterializationEligible
            ? Object.freeze({
                ...baseBudget,
                maxAnchors: Math.max(
                  baseBudget.maxAnchors,
                  sourceFairAnchorCount,
                ),
                maxChars: Math.max(
                  baseBudget.maxChars,
                  Math.min(16_384, sourceFairAnchorCount * 2_048),
                ),
              })
            : baseBudget;
          const request = Object.freeze({
            requirement: locatorRequirement,
            ...(certifiedAssistantDialogueCandidate ||
            materializationAuthorization?.mode === "late_binding" ||
            materializationAuthorization?.mode === "shared_envelope" ||
            (materializationAuthorization?.mode === "assistant_leaf" &&
              requirement.dependencyRelation !== undefined)
              ? { assistantDialogueCandidate: true }
              : {}),
            ...(respondingAssistantMaterializationEligible
              ? {
                  respondingAssistantMaterialization: Object.freeze({
                    originalQuery: input.query,
                    sourcePriorityIds: Object.freeze([
                      ...respondingAssistantSourceIds,
                    ]),
                    maxPromptAnchorsPerSource:
                      RESPONDING_ASSISTANT_PROMPT_ANCHORS_PER_SOURCE_V1,
                    authorization: materializationAuthorization,
                  }),
                }
              : {}),
            lockedSourceIds: Object.freeze([...sourceLocalLockedIds]),
            sourceAcquisitionRevision: sourceAcquisition.acquisitionRevision,
            ...(input.evidenceTimeUpperBound === undefined
              ? {}
              : { evidenceTimeUpperBound: input.evidenceTimeUpperBound }),
            budget: locatorBudget,
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
          located[requirementIndex] = Object.freeze({ result, hits });
          leafReports[requirementIndex] = Object.freeze({
            eligibility,
            status: hits.length === 0 ? "completed_empty" : "completed",
            baselineHitCount:
              baselineRequirementHits[requirementIndex]?.length ?? 0,
            localizedHitCount: hits.length,
            locatorRevision: result.locatorRevision,
          });
        } catch (error) {
          if (input.signal.aborted || isAbort(error)) throw abortError();
          const failureCode = memorySourceLocalEvidenceFailureCodeV1(error);
          if (planScopedLocalization) {
            located.fill(undefined);
            for (const [
              index,
              reportEligibility,
            ] of effectiveLeafEligibility.entries()) {
              leafReports[index] = Object.freeze({
                eligibility: reportEligibility,
                status:
                  failureCode === undefined ? "fallback" : "invalid_result",
                baselineHitCount: baselineRequirementHits[index]?.length ?? 0,
                localizedHitCount: 0,
                ...(failureCode === undefined ? {} : { failureCode }),
              });
            }
            break;
          }
          leafReports[requirementIndex] = Object.freeze({
            eligibility,
            status: failureCode === undefined ? "fallback" : "invalid_result",
            baselineHitCount:
              baselineRequirementHits[requirementIndex]?.length ?? 0,
            localizedHitCount: 0,
            ...(failureCode === undefined ? {} : { failureCode }),
          });
        }
      }
      const completed = located.filter(
        (
          item,
        ): item is Readonly<{
          result: MemorySourceLocalEvidenceResultV1;
          hits: readonly MemorySourceLocalEvidenceHitV1[];
        }> => item !== undefined,
      );
      localEvidenceRefs = new Set(
        completed.flatMap(({ hits }) => hits.map((hit) => hit.evidenceRef)),
      );
      // The locator anchor owns the bounded aperture, not the certificate.
      // Compile provenance for every exact assistant turn inside the
      // post-hydration, twice-validated L0 trace. This keeps certificate
      // identity aligned with the exact ref the selector may assess instead
      // of incorrectly attaching it to the surrounding bundle anchor.
      certifiedAssistantDialogueRefs = new Set(
        completed.flatMap(({ hits }) =>
          compileMemorySourceLocalAssistantDialogueCertificatesV1(hits),
        ),
      );
      requirementHits = Object.freeze(
        baselineRequirementHits.map((hits, index) =>
          mergeEvidenceHits(located[index]?.hits ?? [], hits),
        ),
      );
      const results = completed.map(({ result }) => result);
      const locatorRevisions = results.map((result) => result.locatorRevision);
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
      const failedLeafCount = leafReports.filter(
        (report) =>
          report.status === "fallback" || report.status === "invalid_result",
      ).length;
      const invalidLeaf = leafReports.find(
        (report) => report.status === "invalid_result",
      );
      const aggregateStatus =
        localEvidenceRefs.size > 0
          ? "completed"
          : results.length > 0
            ? "completed_empty"
            : invalidLeaf
              ? "invalid_result"
              : "fallback";
      sourceLocalization = Object.freeze({
        ...sourceLocalExecutionTrace,
        status: aggregateStatus,
        reasonCode:
          localEvidenceRefs.size > 0
            ? failedLeafCount > 0
              ? "partial_evidence_anchor_found"
              : "evidence_anchor_found"
            : results.length > 0
              ? "no_anchor"
              : invalidLeaf
                ? "result_rejected"
                : "locator_failed",
        ...(results.length === 0 && invalidLeaf?.failureCode
          ? { failureCode: invalidLeaf.failureCode }
          : {}),
        locatorVersion: input.sourceLocalLocator.locatorVersion,
        hydratorVersion: input.sourceLocalHydrator.hydratorVersion,
        locatorRevision:
          locatorRevisions.length === 0
            ? hashCanonicalJsonV1({
                schemaVersion: planScopedLocalization
                  ? "paw.memory-source-local-batch-revision.v1:plan-atomic"
                  : "paw.memory-source-local-batch-revision.v2:leaf-isolated",
                executionRouteRevision: sourceLocalExecutionRoute.routeRevision,
                eligibilityRevisions: effectiveLeafEligibility.map(
                  (item) => item.eligibilityRevision,
                ),
              })
            : locatorRevisions.length === 1
              ? locatorRevisions[0]
              : hashCanonicalJsonV1({
                  schemaVersion: planScopedLocalization
                    ? "paw.memory-source-local-batch-revision.v1:plan-atomic"
                    : "paw.memory-source-local-batch-revision.v2:leaf-isolated",
                  revisions: locatorRevisions,
                  executionRouteRevision:
                    sourceLocalExecutionRoute.routeRevision,
                  ...(planScopedLocalization
                    ? {}
                    : {
                        eligibilityRevisions: effectiveLeafEligibility.map(
                          (item) => item.eligibilityRevision,
                        ),
                      }),
                }),
        telemetry,
        addedCandidateCount: localEvidenceRefs.size,
        retainedContextCandidateCount: 0,
        selectedCandidateCount: 0,
        leaves: Object.freeze(leafReports),
      });
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
  let selectorExecutionSnapshot: MemorySelectorExecutionSnapshotV1 | undefined;
  let executionRequirements = input.requirements;
  let selectedRefsByRequirement:
    | ReadonlyMap<string, ReadonlySet<string>>
    | undefined;
  // One bound temporal authority drives retrieval ordering, notebook labels,
  // typed execution and cache identity. The interval is per leaf; a planner
  // can therefore mix bounded and unbounded operands without leaking one
  // query-wide display window across every requirement.
  requirementHits = requirementHits.map((hits, index) => {
    const interval = boundTemporalConstraints[index]?.queryScopeInterval;
    if (!interval) return hits;
    const startMs = Date.parse(interval.lower);
    const endMs = Date.parse(interval.upper);
    const inWindow = hits.filter((hit) => {
      const observed = hit.observedAt ? Date.parse(hit.observedAt) : Number.NaN;
      return (
        Number.isFinite(observed) && observed >= startMs && observed < endMs
      );
    });
    const inWindowRefs = new Set(inWindow.map((hit) => hit.evidenceRef));
    return Object.freeze([
      ...inWindow,
      ...hits.filter((hit) => !inWindowRefs.has(hit.evidenceRef)),
    ]);
  });
  if (input.requirements.length > 0 && input.supportSelector) {
    // A configured selector is an authority gate. Start closed so an empty
    // candidate set, malformed plugin result, or selector failure can never
    // make `undefined` mean "accept every hit" downstream.
    selectedRefsByRequirement = new Map(
      input.requirements.map((requirement) => [
        requirement.requirementId,
        new Set<string>(),
      ]),
    );
    let candidates = selectSupportCandidates(
      requirementHits,
      sourceLocalLockedIds,
      assistantLeafPresent ||
        input.intent.roleConstraint !== "user" ||
        evidenceGroundedRoleBindingEligible ||
        certifiedAssistantDialogueCandidate,
      32,
    );
    if (candidates.length > 0) {
      const candidateEvidenceRefs = new Set(
        candidates.map((candidate) => candidate.evidenceRef),
      );
      const candidateScopes = Object.freeze(
        input.requirements.map((requirement, index) =>
          Object.freeze({
            requirementId: requirement.requirementId,
            evidenceRefs: Object.freeze(
              (requirementHits[index] ?? [])
                .map((hit) => hit.evidenceRef)
                .filter((evidenceRef) =>
                  candidateEvidenceRefs.has(evidenceRef),
                ),
            ),
          }),
        ),
      );
      const verifierTargets =
        (assistantLeafPresent ||
          evidenceGroundedRoleBindingEligible ||
          input.intent.roleConstraint === "assistant" ||
          input.intent.roleConstraint === "any" ||
          certifiedAssistantDialogueCandidate) &&
        input.dialoguePredecessorVerifier
          ? Object.freeze(
              candidates
                .filter(
                  (candidate) =>
                    sourceLocalLockedIds.includes(candidate.sourceId) &&
                    (!evidenceGroundedRoleBindingEligible ||
                      localEvidenceRefs.has(candidate.evidenceRef)) &&
                    (candidate.authority === "context_only" ||
                      candidate.sourceKind === "assistant_output"),
                )
                .map((candidate) =>
                  Object.freeze({
                    sourceId: candidate.sourceId,
                    evidenceRef: candidate.evidenceRef,
                  }),
                ),
            )
          : Object.freeze([]);
      if (verifierTargets.length > 0 && input.dialoguePredecessorVerifier) {
        try {
          const request = Object.freeze({
            targets: verifierTargets,
            lockedSourceIds: Object.freeze([...sourceLocalLockedIds]),
            ...(input.evidenceTimeUpperBound === undefined
              ? {}
              : { evidenceTimeUpperBound: input.evidenceTimeUpperBound }),
          });
          const verificationResult =
            await input.dialoguePredecessorVerifier.verify(
              request,
              input.signal,
            );
          const verifiedProofs =
            validateMemoryDialoguePredecessorVerificationV1({
              verifier: input.dialoguePredecessorVerifier,
              request,
              result: verificationResult,
              evidenceRefBelongsToSource:
                input.index.evidenceRefBelongsToSource,
            });
          certifiedAssistantDialogueRefs = new Set([
            ...certifiedAssistantDialogueRefs,
            ...verifiedProofs.map((proof) => proof.assistant.evidenceRef),
          ]);
          certifiedDialoguePredecessorsByAssistant = new Map(
            verifiedProofs.map((proof) => [
              proof.assistant.evidenceRef,
              proof.precedingUser.evidenceRef,
            ]),
          );
          certifiedDialogueProofsByAssistant = new Map(
            verifiedProofs.map((proof) => [proof.assistant.evidenceRef, proof]),
          );
          dialogueVerifierVersion = verificationResult.verifierVersion;
          dialogueVerificationRevision =
            verificationResult.verificationRevision;
          const proofByAssistantRef = new Map(
            verifiedProofs.map((proof) => [proof.assistant.evidenceRef, proof]),
          );
          // Commit one exact answer-side binding for every verified target.
          // Source-local hits may render a user+assistant bundle whose aggregate
          // authority is user_confirmed_dialogue; that bundle cannot safely act
          // as the assistant answer. The verifier owns an immutable exact read,
          // so its target content/role/order becomes the shared hit consumed by
          // selector, notebook, packet, authority, and closure. The preceding
          // user turn remains proof-only and never becomes a candidate hit.
          candidates = Object.freeze(
            candidates.map((candidate) => {
              const proof = proofByAssistantRef.get(candidate.evidenceRef);
              return proof
                ? Object.freeze({
                    ...candidate,
                    content: proof.assistant.content,
                    authority: "context_only" as const,
                    sourceKind: "assistant_output" as const,
                    turnOrder: proof.assistant.turnOrder,
                    contextEvidenceRefs: Object.freeze([
                      proof.precedingUser.evidenceRef,
                      proof.assistant.evidenceRef,
                    ]),
                  })
                : candidate;
            }),
          );
          const exactAssistantBindingByRef = new Map(
            candidates
              .filter((candidate) =>
                proofByAssistantRef.has(candidate.evidenceRef),
              )
              .map((candidate) => [candidate.evidenceRef, candidate] as const),
          );
          requirementHits = Object.freeze(
            requirementHits.map((hits) =>
              Object.freeze(
                hits.map(
                  (hit) =>
                    exactAssistantBindingByRef.get(hit.evidenceRef) ?? hit,
                ),
              ),
            ),
          );
        } catch (error) {
          if (input.signal.aborted || isAbort(error)) throw abortError();
          // Exact-address verification is optional and fail-closed per batch.
          // Existing locator certificates remain valid and retrieval proceeds.
        }
      }
      const structurallyBoundCertifiedAssistantDialogueRefs = new Set(
        [...certifiedAssistantDialogueRefs].filter((evidenceRef) => {
          const candidate = candidates.find(
            (item) => item.evidenceRef === evidenceRef,
          );
          return (
            candidate?.authority === "context_only" &&
            candidate.sourceKind === "assistant_output" &&
            Boolean(candidate.contextEvidenceRefs?.length)
          );
        }),
      );
      const selectorCertifiedAssistantDialogueRefs =
        selectScopedCertifiedAssistantDialogueRefsV1({
          certifiedEvidenceRefs:
            structurallyBoundCertifiedAssistantDialogueRefs,
          candidateEvidenceRefs,
          candidateScopes,
        });
      if (evidenceGroundedRoleBindingEligible) {
        const certifiedSet = new Set(selectorCertifiedAssistantDialogueRefs);
        executionRequirements = Object.freeze(
          input.requirements.map((requirement) => {
            const scope = candidateScopes.find(
              (item) => item.requirementId === requirement.requirementId,
            );
            const hasCertifiedAssistantAlternative = scope?.evidenceRefs.some(
              (evidenceRef) => certifiedSet.has(evidenceRef),
            );
            if (!hasCertifiedAssistantAlternative) return requirement;
            const roleCandidates = Object.freeze([
              ...(requirement.roleConstraint === "assistant"
                ? ([] as const)
                : (["user"] as const)),
              "assistant" as const,
            ]);
            return Object.freeze({
              ...requirement,
              roleConstraint:
                requirement.roleConstraint === "assistant"
                  ? ("assistant" as const)
                  : ("any" as const),
              roleCandidates,
            });
          }),
        );
      }
      try {
        const settlement = await settleMemoryEvidenceSupportSelectionV1({
          selector: input.supportSelector,
          query: input.query,
          intent: input.intent,
          requirements: executionRequirements,
          candidates,
          candidateScopes,
          requirementHits,
          roleConstraint: input.intent.roleConstraint,
          certifiedSharedDialogueRefs:
            structurallyBoundCertifiedAssistantDialogueRefs,
          certifiedDialoguePredecessorsByAssistant,
          certifiedAssistantDialogueCandidate:
            certifiedAssistantDialogueCandidate,
          selectorCertifiedAssistantDialogueRefs:
            (assistantLeafPresent ||
              evidenceGroundedRoleBindingEligible ||
              input.intent.roleConstraint === "assistant" ||
              input.intent.roleConstraint === "any" ||
              certifiedAssistantDialogueCandidate) &&
            selectorCertifiedAssistantDialogueRefs.length > 0
              ? selectorCertifiedAssistantDialogueRefs
              : Object.freeze([]),
          temporalConstraints: boundTemporalConstraints,
          lockedSourceIds: sourceLocalLockedIds,
          originRevision: input.queryAnswerOrigin.originRevision,
          committedAttempt:
            localEvidenceRefs.size > 0 ? "augmented" : "baseline",
          attemptCount: 1,
          signal: input.signal,
        });
        supportAssessments = settlement.assessments;
        selectedRefsByRequirement = settlement.selectedRefsByRequirement;
        supportSelectionRevision = settlement.selectionRevision;
        selectorExecutionSnapshot = settlement.selectorExecutionSnapshot;
        supportSelectorStatus =
          settlement.failedGroupCount > 0 ? "partial" : "completed";
        sourceLocalization = Object.freeze({
          ...sourceLocalization,
          ...(settlement.failedGroupCount > 0
            ? {
                selectorGroupPolicy:
                  PAW_MEMORY_EVIDENCE_SELECTOR_GROUP_POLICY_V1,
                selectorGroupCount: settlement.groupCount,
                selectorCommittedGroupCount: settlement.committedGroupCount,
                selectorFailedGroupCount: settlement.failedGroupCount,
                selectorTotalAttemptCount: 1,
              }
            : {}),
          selectorAttempts: 1,
          selectorCommittedAttempt:
            localEvidenceRefs.size > 0 ? "augmented" : "baseline",
        });
      } catch (error) {
        if (input.signal.aborted || isAbort(error)) throw abortError();
        const baselineRetryEligible =
          sourceLocalExecutionRoute.reasonCode ===
            "recommendation_operand_materialization" &&
          localEvidenceRefs.size > 0 &&
          error instanceof Error &&
          error.name === "MemoryEvidenceSupportAddressInvalid" &&
          !assistantLeafPresent &&
          !evidenceGroundedRoleBindingEligible &&
          !certifiedAssistantDialogueCandidate &&
          input.intent.roleConstraint === "user";
        let baselineCommitted = false;
        let baselineAttempted = false;
        if (baselineRetryEligible) {
          const baselineCandidates = selectSupportCandidates(
            baselineRequirementHits,
            sourceLocalLockedIds,
            false,
            32,
          );
          if (baselineCandidates.length > 0) {
            const baselineCandidateEvidenceRefs = new Set(
              baselineCandidates.map((candidate) => candidate.evidenceRef),
            );
            const baselineCandidateScopes = Object.freeze(
              input.requirements.map((requirement, index) =>
                Object.freeze({
                  requirementId: requirement.requirementId,
                  evidenceRefs: Object.freeze(
                    (baselineRequirementHits[index] ?? [])
                      .map((hit) => hit.evidenceRef)
                      .filter((evidenceRef) =>
                        baselineCandidateEvidenceRefs.has(evidenceRef),
                      ),
                  ),
                }),
              ),
            );
            try {
              baselineAttempted = true;
              const fallbackSettlement =
                await settleMemoryEvidenceSupportSelectionV1({
                  selector: input.supportSelector,
                  query: input.query,
                  intent: input.intent,
                  requirements: input.requirements,
                  candidates: baselineCandidates,
                  candidateScopes: baselineCandidateScopes,
                  requirementHits: baselineRequirementHits,
                  roleConstraint: input.intent.roleConstraint,
                  certifiedSharedDialogueRefs: new Set(),
                  certifiedDialoguePredecessorsByAssistant: new Map(),
                  certifiedAssistantDialogueCandidate: false,
                  selectorCertifiedAssistantDialogueRefs: Object.freeze([]),
                  temporalConstraints: boundTemporalConstraints,
                  lockedSourceIds: sourceLocalLockedIds,
                  originRevision: input.queryAnswerOrigin.originRevision,
                  committedAttempt: "baseline",
                  attemptCount: 2,
                  signal: input.signal,
                });
              requirementHits = baselineRequirementHits;
              localEvidenceRefs = new Set();
              certifiedAssistantDialogueRefs = new Set();
              certifiedDialoguePredecessorsByAssistant = new Map();
              certifiedDialogueProofsByAssistant = new Map();
              dialogueVerifierVersion = null;
              dialogueVerificationRevision = null;
              executionRequirements = input.requirements;
              supportAssessments = fallbackSettlement.assessments;
              selectedRefsByRequirement =
                fallbackSettlement.selectedRefsByRequirement;
              supportSelectionRevision = fallbackSettlement.selectionRevision;
              selectorExecutionSnapshot =
                fallbackSettlement.selectorExecutionSnapshot;
              supportSelectorStatus = "completed";
              sourceLocalization = Object.freeze({
                ...sourceLocalization,
                status: "fallback",
                reasonCode: "selector_baseline_fallback",
                selectorAttempts: 2,
                selectorCommittedAttempt: "baseline",
                addedCandidateCount: 0,
                retainedContextCandidateCount: 0,
                selectedCandidateCount: 0,
              });
              baselineCommitted = true;
            } catch (fallbackError) {
              if (input.signal.aborted || isAbort(fallbackError)) {
                throw abortError();
              }
            }
          }
        }
        if (!baselineCommitted) {
          supportSelectorStatus = "fallback";
          executionRequirements = input.requirements;
          if (localEvidenceRefs.size > 0) {
            requirementHits = baselineRequirementHits;
            localEvidenceRefs = new Set();
            certifiedAssistantDialogueRefs = new Set();
            certifiedDialoguePredecessorsByAssistant = new Map();
            certifiedDialogueProofsByAssistant = new Map();
            dialogueVerifierVersion = null;
            dialogueVerificationRevision = null;
            sourceLocalization = Object.freeze({
              ...sourceLocalization,
              status: "fallback",
              reasonCode: "selector_failed",
              selectorAttempts: baselineAttempted ? 2 : 1,
              selectorCommittedAttempt: "none",
              addedCandidateCount: 0,
              retainedContextCandidateCount: 0,
              selectedCandidateCount: 0,
            });
          }
        }
      }
    }
  }
  if (
    input.requirements.length > 0 &&
    input.supportSelector &&
    selectorExecutionSnapshot === undefined
  ) {
    const failedCandidates = selectSupportCandidates(
      requirementHits,
      sourceLocalLockedIds,
      true,
      32,
    );
    const failedCandidateRefs = new Set(
      failedCandidates.map((candidate) => candidate.evidenceRef),
    );
    const failedCandidateScopes = Object.freeze(
      executionRequirements.map((requirement, index) =>
        Object.freeze({
          requirementId: requirement.requirementId,
          evidenceRefs: Object.freeze(
            (requirementHits[index] ?? [])
              .map((hit) => hit.evidenceRef)
              .filter((evidenceRef) => failedCandidateRefs.has(evidenceRef)),
          ),
        }),
      ),
    );
    const failedSelectionRevision = hashCanonicalJsonV1({
      schemaVersion: "paw.memory-evidence-support-selection-failed.v1",
      selectorVersion: input.supportSelector.selectorVersion,
      requirementIds: executionRequirements.map(
        (requirement) => requirement.requirementId,
      ),
      candidateScopeRevisions: failedCandidateScopes.map((scope) =>
        hashCanonicalJsonV1(scope as never),
      ),
    } as never);
    selectorExecutionSnapshot = compileMemorySelectorExecutionSnapshotV1({
      query: input.query,
      intent: input.intent,
      requirements: executionRequirements,
      temporalConstraints: boundTemporalConstraints,
      candidateScopes: failedCandidateScopes,
      lockedSourceIds: sourceLocalLockedIds,
      originRevision: input.queryAnswerOrigin.originRevision,
      selectorVersion: input.supportSelector.selectorVersion,
      selectionRevision: failedSelectionRevision,
      committedAttempt: "none",
      attemptCount: sourceLocalization.selectorAttempts === 2 ? 2 : 1,
      groups: compileMemoryEvidenceSelectorGroupsV1({
        intent: input.intent,
        requirements: executionRequirements,
      }).map((group) =>
        Object.freeze({
          groupId: group.groupId,
          requirementIds: group.requirementIds,
          status: "failed" as const,
          assessments: Object.freeze([]),
          failureCodes: Object.freeze([
            "MemoryEvidenceSupportSelectionNotCommitted",
          ]),
        }),
      ),
    });
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
  // Selected dialogue evidence opens only after the selector binds exact refs.
  // A structurally valid but semantically unknown local hit stays outside the
  // answer packet; the reader is not a second evidence verifier.
  const allowSelectedContextOnly =
    executionRequirements.some((requirement) =>
      new Set(["assistant", "any"]).has(requirement.roleConstraint),
    ) ||
    input.intent.roleConstraint === "assistant" ||
    (input.intent.roleConstraint === "any" &&
      new Set(["completed", "partial"]).has(supportSelectorStatus)) ||
    (certifiedAssistantDialogueCandidate &&
      new Set(["completed", "partial"]).has(supportSelectorStatus));
  const allowFallbackContextOnly = input.intent.roleConstraint === "assistant";
  // Deterministic support floor: selector abstention (empty binding, failed
  // group, or selector failure) must not collapse a requirement's packet to
  // zero evidence while locked-source candidates exist. Exclusion requires a
  // positive judgment; absence of one downgrades to code-owned ranking.
  let supportFloorAppliedCount = 0;
  if (selectedRefsByRequirement !== undefined) {
    const floor = applyMemoryDeterministicSupportFloorV1({
      selectedRefsByRequirement,
      requirementIds: executionRequirements.map(
        (requirement) => requirement.requirementId,
      ),
      requirementHits,
      lockedSourceIds: sourceLocalLockedIds,
      maxFloorHitsPerRequirement: 2,
      excludedEvidenceRefs: supportAssessments.map(
        (assessment) =>
          new Set([
            ...assessment.contradictingEvidenceRefs,
            ...assessment.unknownEvidenceRefs,
          ]),
      ),
    });
    selectedRefsByRequirement = floor.selectedRefsByRequirement;
    supportFloorAppliedCount = floor.flooredRequirementIds.length;
    if (supportFloorAppliedCount > 0) {
      sourceLocalization = Object.freeze({
        ...sourceLocalization,
        deterministicSupportFloor: {
          policyVersion: floor.policyVersion,
          flooredRequirementCount: supportFloorAppliedCount,
        },
      });
    }
  }
  const notebook = buildMemoryEvidenceNotebookV1({
    requirements: executionRequirements.map((requirement, index) => {
      const interval = boundTemporalConstraints[index]?.queryScopeInterval;
      const startMs = interval ? Date.parse(interval.lower) : undefined;
      const endMs = interval ? Date.parse(interval.upper) : undefined;
      const timeWindow =
        startMs !== undefined &&
        endMs !== undefined &&
        Number.isFinite(startMs) &&
        Number.isFinite(endMs)
          ? { startMs, endMs }
          : undefined;
      const timeWindowSuffix = timeWindow
        ? ` [时间窗:${new Date(timeWindow.startMs).toISOString().slice(0, 10)}~${new Date(timeWindow.endMs - 1).toISOString().slice(0, 10)}]`
        : "";
      return {
        requirementId: requirement.requirementId,
        label:
          timeWindowSuffix === ""
            ? requirement.label
            : requirement.label.slice(0, 192 - timeWindowSuffix.length) +
              timeWindowSuffix,
        searchText: requirement.searchText,
        ...(timeWindow === undefined ? {} : { timeWindow }),
        selection: requirement.temporalMode === "latest" ? "latest" : "ranked",
        relation: requirement.relation ?? "direct",
        coverageMode:
          requirement.coverageMode ??
          (requirement.temporalMode === "latest" ? "latest" : "any"),
        minimumEvidence: requirement.minimumEvidence ?? 1,
        roleConstraint: requirement.roleConstraint,
        certifiedDialogueEvidenceRefs: Object.freeze([
          ...certifiedAssistantDialogueRefs,
        ]),
        authorityBoundEvidenceRefs: Object.freeze(
          supportAssessments.find(
            (assessment) =>
              assessment.requirementId === requirement.requirementId,
          )?.supportingEvidenceRefs ?? [],
        ),
        hits: filterRequirementHits(
          requirementHits[index] ?? [],
          selectedRefsByRequirement?.get(requirement.requirementId),
        ),
      };
    }),
    allowedSourceIds: sourceLocalLockedIds,
    maxHitsPerRequirement: input.maxHitsPerRequirement,
    maxChars: input.maxNotebookChars,
    allowContextOnly: allowSelectedContextOnly,
  });
  if (sourceLocalization.status === "completed") {
    sourceLocalization = Object.freeze({
      ...sourceLocalization,
      retainedContextCandidateCount: 0,
    });
  }
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
    executionRequirements.length > 0
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
          fallbackAnswerRole: "candidate",
          maxFallbackChars: input.maxNotebookChars,
          maxFallbackHitsPerSource: 1,
          roleConstraint: input.intent.roleConstraint,
          certifiedDialogueEvidenceRefs: certifiedAssistantDialogueRefs,
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
          certifiedAssistantDialogueRefs,
        );
  const requirementEvidence = buildMemoryEvidenceRequirementLedgerV1({
    requirements: executionRequirements,
    notebook,
    assessments: supportAssessments,
    packetSources,
  });
  const dialogueCertificateRegistry =
    compileMemoryDialogueCertificateRegistryV1({
      lockedSourceIds: sourceLocalLockedIds,
      proofs: Object.freeze([...certifiedDialogueProofsByAssistant.values()]),
      verifierVersion: dialogueVerifierVersion,
      verificationRevision: dialogueVerificationRevision,
      originRevision: input.queryAnswerOrigin.originRevision,
      ...(input.evidenceTimeUpperBound === undefined
        ? {}
        : { evidenceTimeUpperBound: input.evidenceTimeUpperBound }),
    });
  return Object.freeze({
    requirements: executionRequirements,
    fusion,
    sourceAcquisition,
    degradedChannels,
    requirementHits,
    supportSelectorStatus,
    ...(supportSelectionRevision === undefined
      ? {}
      : { supportSelectionRevision }),
    supportAssessments,
    ...(selectorExecutionSnapshot === undefined
      ? {}
      : { selectorExecutionSnapshot }),
    sourceLocalization,
    lockedSourceIds: sourceLocalLockedIds,
    notebook,
    requirementEvidence,
    packetSources,
    dialogueCertificateRegistry,
  });
}

async function settleMemoryEvidenceSupportSelectionV1(input: {
  readonly selector: MemoryEvidenceSupportSelectorV1;
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly candidates: readonly MemoryEvidenceNotebookHitV1[];
  readonly candidateScopes: readonly Readonly<{
    requirementId: string;
    evidenceRefs: readonly string[];
  }>[];
  readonly requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[];
  readonly roleConstraint: MemoryEvidenceQueryIntentV3["roleConstraint"];
  readonly certifiedSharedDialogueRefs: ReadonlySet<string>;
  readonly certifiedDialoguePredecessorsByAssistant: ReadonlyMap<
    string,
    string
  >;
  readonly certifiedAssistantDialogueCandidate: boolean;
  readonly selectorCertifiedAssistantDialogueRefs: readonly string[];
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly lockedSourceIds: readonly string[];
  readonly originRevision: string;
  readonly committedAttempt: "augmented" | "baseline";
  readonly attemptCount: 1 | 2;
  readonly signal: AbortSignal;
}): Promise<
  Readonly<{
    selectionRevision: string;
    assessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
    selectedRefsByRequirement: ReadonlyMap<string, ReadonlySet<string>>;
    groupCount: number;
    committedGroupCount: number;
    failedGroupCount: number;
    selectorExecutionSnapshot: MemorySelectorExecutionSnapshotV1;
  }>
> {
  const candidateEvidenceRefsByRequirement = new Map(
    input.candidateScopes.map((scope) => [
      scope.requirementId,
      new Set(scope.evidenceRefs),
    ]),
  );
  const selectorGroups = compileMemoryEvidenceSelectorGroupsV1({
    intent: input.intent,
    requirements: input.requirements,
  });
  if (input.selector.selectGrouped && selectorGroups.length > 1) {
    const groupedSelection = await input.selector.selectGrouped(
      {
        query: input.query,
        requirements: input.requirements,
        candidates: input.candidates,
        candidateScopes: input.candidateScopes,
        ...(input.selectorCertifiedAssistantDialogueRefs.length > 0
          ? {
              certifiedAssistantDialogueEvidenceRefs:
                input.selectorCertifiedAssistantDialogueRefs,
            }
          : {}),
      },
      selectorGroups.map((group) => ({
        groupId: group.groupId,
        requirementIds: group.requirementIds,
      })),
      input.signal,
    );
    const hitsByRequirement = new Map(
      input.requirements.map((requirement, index) => [
        requirement.requirementId,
        input.requirementHits[index] ?? Object.freeze([]),
      ]),
    );
    const groupResultById = new Map(
      groupedSelection.groups.map((group) => [group.groupId, group]),
    );
    if (
      groupResultById.size !== selectorGroups.length ||
      groupedSelection.groups.length !== selectorGroups.length
    ) {
      throw namedError("MemoryEvidenceSupportGroupContractInvalid");
    }
    const assessmentsByRequirement = new Map<
      string,
      Readonly<MemoryEvidenceTriageAssessmentV1>
    >();
    const selectedRefsByRequirement = new Map<string, ReadonlySet<string>>();
    let committedGroupCount = 0;
    let failedGroupCount = 0;
    const failureCodes: string[] = [];
    const executionGroups: MemorySelectorExecutionGroupInputV1[] = [];
    for (const group of selectorGroups) {
      const result = groupResultById.get(group.groupId);
      if (!result) {
        throw namedError("MemoryEvidenceSupportGroupContractInvalid");
      }
      if (result.status === "fallback") {
        failedGroupCount += 1;
        failureCodes.push(...result.failureCodes);
        for (const requirementId of group.requirementIds) {
          selectedRefsByRequirement.set(requirementId, new Set());
        }
        executionGroups.push(
          Object.freeze({
            groupId: group.groupId,
            requirementIds: group.requirementIds,
            status: "failed" as const,
            assessments: Object.freeze([]),
            failureCodes: result.failureCodes,
          }),
        );
        continue;
      }
      const groupScopes = input.candidateScopes.filter((scope) =>
        group.requirementIds.includes(scope.requirementId),
      );
      const groupCandidateRefs = new Set(
        groupScopes.flatMap((scope) => scope.evidenceRefs),
      );
      const groupCandidates = input.candidates.filter((candidate) =>
        groupCandidateRefs.has(candidate.evidenceRef),
      );
      const groupCandidateEvidenceRefsByRequirement = new Map(
        groupScopes.map((scope) => [
          scope.requirementId,
          new Set(scope.evidenceRefs),
        ]),
      );
      const assessments = enforceSelectedEvidenceAuthority({
        assessments: result.assessments,
        requirements: group.requirements,
        candidateEvidenceRefs: new Set(
          groupCandidates.map((candidate) => candidate.evidenceRef),
        ),
        candidateEvidenceRefsByRequirement:
          groupCandidateEvidenceRefsByRequirement,
        requirementHits: group.requirementIds.map(
          (requirementId) => hitsByRequirement.get(requirementId) ?? [],
        ),
        roleConstraint: input.roleConstraint,
        certifiedSharedDialogueRefs: new Set(
          [...input.certifiedSharedDialogueRefs].filter((evidenceRef) =>
            groupCandidateRefs.has(evidenceRef),
          ),
        ),
        certifiedDialoguePredecessorsByAssistant: new Map(
          [...input.certifiedDialoguePredecessorsByAssistant].filter(
            ([assistantEvidenceRef]) =>
              groupCandidateRefs.has(assistantEvidenceRef),
          ),
        ),
        certifiedAssistantDialogueCandidate:
          input.certifiedAssistantDialogueCandidate,
      });
      committedGroupCount += 1;
      executionGroups.push(
        Object.freeze({
          groupId: group.groupId,
          requirementIds: group.requirementIds,
          status: "committed" as const,
          assessments,
          failureCodes: Object.freeze([]),
        }),
      );
      for (const assessment of assessments) {
        assessmentsByRequirement.set(assessment.requirementId, assessment);
        selectedRefsByRequirement.set(
          assessment.requirementId,
          new Set(assessment.supportingEvidenceRefs),
        );
      }
    }
    if (committedGroupCount === 0) {
      throw namedError(
        [...new Set(failureCodes)].sort()[0] ??
          "MemoryEvidenceSupportGroupSelectionEmpty",
      );
    }
    const assessments = Object.freeze(
      input.requirements.flatMap((requirement) => {
        const assessment = assessmentsByRequirement.get(
          requirement.requirementId,
        );
        return assessment ? [assessment] : [];
      }),
    );
    return Object.freeze({
      selectionRevision: groupedSelection.selectionRevision,
      assessments,
      selectedRefsByRequirement,
      groupCount: selectorGroups.length,
      committedGroupCount,
      failedGroupCount,
      selectorExecutionSnapshot: compileMemorySelectorExecutionSnapshotV1({
        query: input.query,
        intent: input.intent,
        requirements: input.requirements,
        temporalConstraints: input.temporalConstraints,
        candidateScopes: input.candidateScopes,
        lockedSourceIds: input.lockedSourceIds,
        originRevision: input.originRevision,
        selectorVersion: input.selector.selectorVersion,
        selectionRevision: groupedSelection.selectionRevision,
        committedAttempt: input.committedAttempt,
        attemptCount: input.attemptCount,
        groups: executionGroups,
      }),
    });
  }
  const selection = await input.selector.select(
    {
      query: input.query,
      requirements: input.requirements,
      candidates: input.candidates,
      candidateScopes: input.candidateScopes,
      ...(input.selectorCertifiedAssistantDialogueRefs.length > 0
        ? {
            certifiedAssistantDialogueEvidenceRefs:
              input.selectorCertifiedAssistantDialogueRefs,
          }
        : {}),
    },
    input.signal,
  );
  const assessments = enforceSelectedEvidenceAuthority({
    assessments: selection.assessments,
    requirements: input.requirements,
    candidateEvidenceRefs: new Set(
      input.candidates.map((candidate) => candidate.evidenceRef),
    ),
    candidateEvidenceRefsByRequirement,
    requirementHits: input.requirementHits,
    roleConstraint: input.roleConstraint,
    certifiedSharedDialogueRefs: input.certifiedSharedDialogueRefs,
    certifiedDialoguePredecessorsByAssistant:
      input.certifiedDialoguePredecessorsByAssistant,
    certifiedAssistantDialogueCandidate:
      input.certifiedAssistantDialogueCandidate,
  });
  return Object.freeze({
    selectionRevision: selection.selectionRevision,
    assessments,
    selectedRefsByRequirement: new Map(
      assessments.map((assessment) => [
        assessment.requirementId,
        new Set(assessment.supportingEvidenceRefs),
      ]),
    ),
    groupCount: 1,
    committedGroupCount: 1,
    failedGroupCount: 0,
    selectorExecutionSnapshot: compileMemorySelectorExecutionSnapshotV1({
      query: input.query,
      intent: input.intent,
      requirements: input.requirements,
      temporalConstraints: input.temporalConstraints,
      candidateScopes: input.candidateScopes,
      lockedSourceIds: input.lockedSourceIds,
      originRevision: input.originRevision,
      selectorVersion: input.selector.selectorVersion,
      selectionRevision: selection.selectionRevision,
      committedAttempt: input.committedAttempt,
      attemptCount: input.attemptCount,
      groups: compileMemoryEvidenceSelectorGroupsV1({
        intent: input.intent,
        requirements: input.requirements,
      }).map((group) =>
        Object.freeze({
          groupId: group.groupId,
          requirementIds: group.requirementIds,
          status: "committed" as const,
          assessments: Object.freeze(
            assessments.filter((assessment) =>
              group.requirementIds.includes(assessment.requirementId),
            ),
          ),
          failureCodes: Object.freeze([]),
        }),
      ),
    }),
  });
}

export function selectScopedCertifiedAssistantDialogueRefsV1(input: {
  readonly certifiedEvidenceRefs: ReadonlySet<string>;
  readonly candidateEvidenceRefs: ReadonlySet<string>;
  readonly candidateScopes: readonly Readonly<{
    evidenceRefs: readonly string[];
  }>[];
}): readonly string[] {
  return Object.freeze(
    [...input.certifiedEvidenceRefs].filter(
      (evidenceRef) =>
        input.candidateEvidenceRefs.has(evidenceRef) &&
        input.candidateScopes.some((scope) =>
          scope.evidenceRefs.includes(evidenceRef),
        ),
    ),
  );
}

/**
 * Projects deterministic dialogue provenance from a validated source-local
 * trace onto exact assistant turn addresses. This proves only that an
 * assistant turn immediately answered a preceding user turn; relevance,
 * truth, authority, and requirement binding remain downstream decisions.
 *
 * Callers must pass hits only after immutable L0 hydration and the second
 * `validateMemorySourceLocalEvidenceResultV1` boundary.
 */
export function compileMemorySourceLocalAssistantDialogueCertificatesV1(
  hits: readonly MemorySourceLocalEvidenceHitV1[],
): readonly string[] {
  return Object.freeze([
    ...new Set(
      hits.flatMap((hit) =>
        hit.includedTurns
          .filter(
            (turn) =>
              turn.sourceKind === "assistant_output" &&
              hasMemorySourceLocalDialogueCertificateV1(
                hit.includedTurns,
                turn.turnOrder,
              ),
          )
          .map((turn) => turn.evidenceRef),
      ),
    ),
  ]);
}
