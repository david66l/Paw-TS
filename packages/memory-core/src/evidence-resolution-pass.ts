import { hashCanonicalJsonV1, hashTextV1 } from "./canonical.js";
import {
  type MemoryDialogueCertificateRegistryV1,
  compileMemoryDialogueCertificateRegistryV1,
} from "./dialogue-certificate.js";
import type { MemoryDialogueOrdinalAdmissionReceiptV1 } from "./dialogue-ordinal-admission.js";
import {
  type MemoryDialogueOrdinalSourceSettlementV1,
  compileMemoryDialogueOrdinalSelectorBodyV1,
  reduceMemoryDialogueOrdinalSourcesV1,
  settleMemoryDialogueOrdinalSourceV1,
  validateMemoryDialogueOrdinalCohortV1,
} from "./dialogue-ordinal-transaction.js";
import {
  type MemoryDialogueOrdinalConstraintV1,
  compileMemoryDialogueOrdinalConstraintV1,
} from "./dialogue-ordinal.js";
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
import { evidenceSourceIdV1 } from "./evidence-ref.js";
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
  prioritizeEvidenceSearchResultForTemporalWindowV1,
  selectSupportCandidates,
  selectSupportCandidatesPreservingBaselineV1,
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
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceBoundTemporalWindowV2,
} from "./query-plan-contracts.js";
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
  type MemoryDialoguePredecessorVerificationRequestV1,
  type MemoryDialoguePredecessorVerifierV1,
  type MemorySourceLocalEvidenceBudgetV1,
  type MemorySourceLocalEvidenceHitV1,
  type MemorySourceLocalEvidenceHydratorV1,
  type MemorySourceLocalEvidenceLocatorV1,
  type MemorySourceLocalEvidenceResultV1,
  type MemorySourceLocalLeafEligibilityV2,
  type MemorySourceLocalLeafExecutionReportV2,
  type MemorySourceLocalizationReportV1,
  PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1,
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
const TEMPORAL_SOURCE_APERTURE_RESERVE_V1 = 2;
// The adapter now allocates one pair-level slot per locked source before any
// source receives a second slot. Keep all eight primary sources in aperture.
const RESPONDING_ASSISTANT_PROMPT_ANCHORS_PER_SOURCE_V1 = 1 as const;

/**
 * A temporal operation frequently needs evidence from more than one session.
 * Keep the semantic acquisition prefix intact and append a small, bounded
 * source aperture before source-local localization. A locked repair must not
 * widen its immutable source set.
 */
export function temporalSourceApertureMaxSourcesV1(input: {
  readonly maxSources: number;
  readonly temporalWindows: readonly MemoryEvidenceBoundTemporalWindowV2[];
  readonly sourceLockActive: boolean;
}): number {
  if (
    input.sourceLockActive ||
    !input.temporalWindows.some((window) => window.kind !== "unbounded")
  ) {
    return input.maxSources;
  }
  return Math.min(16, input.maxSources + TEMPORAL_SOURCE_APERTURE_RESERVE_V1);
}

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
  /** Feature-gated exact round proposals, only inside a frozen repair lock. */
  readonly temporalRoundFrontier?: boolean;
  readonly evidenceTimeUpperBound?: string;
  readonly excludedEvidenceRefs?: ReadonlySet<string>;
  /**
   * A closure repair may re-open exact evidence inside an existing source
   * aperture. When present, global discovery and source fusion are immutable.
   */
  readonly sourceLock?: MemoryEvidenceSourceLockV1;
  readonly signal: AbortSignal;
}): Promise<MemoryEvidenceResolutionPassV1> {
  // This compiler is deliberately query-only. Planner text, retrieval text,
  // and model output can never manufacture an ordinal host settlement.
  const compiledDialogueOrdinal = compileMemoryDialogueOrdinalConstraintV1(
    input.query,
  );
  const ordinalAssistantLeaves = input.requirements.filter(
    (requirement) => requirement.roleConstraint === "assistant",
  );
  const plannedSelectorGroups =
    input.requirements.length > 0
      ? compileMemoryEvidenceSelectorGroupsV1({
          intent: input.intent,
          requirements: input.requirements,
        })
      : Object.freeze([]);
  const ordinalTargetLeaf =
    ordinalAssistantLeaves.length === 1 ? ordinalAssistantLeaves[0] : undefined;
  const ordinalTargetGroup = ordinalTargetLeaf
    ? plannedSelectorGroups.find((group) =>
        group.requirementIds.includes(ordinalTargetLeaf.requirementId),
      )
    : undefined;
  // This only makes a query-only semantic veto eligible. Ordinal retrieval is
  // still unavailable until the independent typed admission port approves.
  const ordinalStructuralEligible =
    compiledDialogueOrdinal !== undefined &&
    input.queryAnswerOrigin.originKind === "explicit_assistant" &&
    input.supportSelector?.dialogueOrdinalSelector !== undefined &&
    input.supportSelector?.dialogueOrdinalAdmission !== undefined &&
    input.sourceLocalLocator !== undefined &&
    input.sourceLocalHydrator !== undefined &&
    input.dialoguePredecessorVerifier !== undefined &&
    // v2 intentionally has one self-contained transaction. Mixed plans keep
    // the established selector path byte-for-byte until their independent
    // merge contract is separately proven.
    input.requirements.length === 1 &&
    ordinalTargetLeaf !== undefined &&
    // A host settlement owns one obligation only. A dependent/mixed selector
    // group would otherwise make the ordinal branch silently settle unrelated
    // leaves, so it remains on the ordinary transaction path.
    ordinalTargetGroup?.requirementIds.length === 1;
  let dialogueOrdinalAdmission:
    | MemoryDialogueOrdinalAdmissionReceiptV1
    | undefined;
  if (ordinalStructuralEligible && compiledDialogueOrdinal !== undefined) {
    try {
      const admission =
        await input.supportSelector?.dialogueOrdinalAdmission?.admit(
          Object.freeze({
            query: input.query.replace(/\s+/gu, " ").trim(),
            constraint: compiledDialogueOrdinal,
          }),
          input.signal,
        );
      if (admission !== undefined) {
        // A typed port remains external. Validate only its fixed receipt;
        // model output cannot supply an ordinal, artifact, source, or proof.
        if (
          admission.admissionVersion !==
            input.supportSelector?.dialogueOrdinalAdmission?.admissionVersion ||
          !/^[a-f0-9]{64}$/u.test(admission.admissionRevision) ||
          (admission.classification !== "artifact_itself" &&
            admission.classification !== "artifact_internal_content")
        ) {
          throw namedError("MemoryDialogueOrdinalAdmissionReceiptInvalid");
        }
        dialogueOrdinalAdmission = admission;
      }
    } catch (error) {
      if (input.signal.aborted || isAbort(error)) throw abortError();
      // Failed/rejected admission is deliberately a byte-compatible old path.
      dialogueOrdinalAdmission = undefined;
    }
  }
  const dialogueOrdinal =
    dialogueOrdinalAdmission === undefined
      ? undefined
      : compiledDialogueOrdinal;
  const ordinalTargetRequirementId = dialogueOrdinal
    ? ordinalTargetLeaf?.requirementId
    : undefined;
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
  // Root-lane fusion previously saw temporal scope only during a locked
  // closure repair. Apply the same host-bound scope before initial fusion as
  // a stable priority (never a filter), so a narrow date request does not
  // lose its relevant source to an otherwise stronger lexical distractor.
  const rootTemporalConstraint = bindMemoryEvidenceTemporalConstraintV1({
    query: input.query,
    queryEnvelopeMode: input.intent.temporalMode,
    leafMode: input.intent.temporalMode,
    ...(input.evidenceTimeUpperBound === undefined
      ? {}
      : { evidenceTimeUpperBound: input.evidenceTimeUpperBound }),
    applyQueryScope: input.intent.temporalMode === "range",
  });
  const sourceApertureMaxSources = temporalSourceApertureMaxSourcesV1({
    maxSources: input.maxSources,
    temporalWindows: boundTemporalConstraints.map((binding) => binding.window),
    sourceLockActive: input.sourceLock !== undefined,
  });
  const temporalWindow = (binding: MemoryEvidenceBoundTemporalConstraintV1) =>
    binding.window.kind === "range"
      ? (binding.window.interval ?? undefined)
      : undefined;
  const prioritizedPrimaryUnfiltered = input.sourceLock
    ? input.primaryUnfiltered
    : prioritizeEvidenceSearchResultForTemporalWindowV1(
        input.primaryUnfiltered,
        temporalWindow(rootTemporalConstraint),
      );
  const prioritizedPrimary = filterEvidenceSearchResultForRole(
    prioritizedPrimaryUnfiltered,
    input.intent.roleConstraint,
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
  const supplementalUnfilteredRaw = input.sourceLock
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
            ? Promise.resolve(prioritizedPrimaryUnfiltered)
            : input.index.search(requirement.searchText, input.signal),
        ),
      );
  const supplementalUnfiltered = supplementalUnfilteredRaw.map(
    (result, index) => {
      const binding = boundTemporalConstraints[index];
      if (!binding) throw namedError("MemoryEvidenceTemporalBindingMissing");
      return input.sourceLock
        ? result
        : prioritizeEvidenceSearchResultForTemporalWindowV1(
            result,
            temporalWindow(binding),
          );
    },
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
          ? prioritizedPrimaryUnfiltered
          : prioritizedPrimary,
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
        maxSources: sourceApertureMaxSources,
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
              ? prioritizedPrimaryUnfiltered
              : prioritizedPrimary,
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
  const temporalFrontierRepairActive =
    input.temporalRoundFrontier === true && input.sourceLock !== undefined;
  const localEligible =
    dialogueOrdinal !== undefined ||
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
                prioritizedPrimaryUnfiltered,
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
                          prioritizedPrimaryUnfiltered,
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
  const unlockedSourceLocalIds = input.sourceLock
    ? input.sourceLock.lockedSourceIds
    : localEligible
      ? Object.freeze([
          ...new Set([...sourceIds, ...dialogueCandidateSourceIds]),
        ])
      : sourceIds;
  // A complete ordinal population has a hard proof cap. Slicing a wider lock
  // would silently change N, so it remains unavailable instead.
  const sourceLocalLockedIds = unlockedSourceLocalIds;
  // Do not suppress ordinary leaves merely because the ordinal proof cap is
  // exceeded. The ordinal leaf becomes unknown below, while the untouched
  // leaves retain their normal source-local execution.
  const ordinalPopulationLockedSourceIds =
    dialogueOrdinal !== undefined && sourceLocalLockedIds.length <= 8
      ? sourceLocalLockedIds
      : Object.freeze([]);
  const baselineRequirementHits = input.requirements.map((requirement, index) =>
    mergeEvidenceHits(
      input.sourceLock
        ? input.sourceLock.seedHits
        : (supplemental[index]?.hits ?? []),
      input.sourceLock
        ? []
        : filterEvidenceSearchResultForRole(
            prioritizedPrimaryUnfiltered,
            requirement.roleConstraint,
          ).hits,
    ).filter((hit) => !input.excludedEvidenceRefs?.has(hit.evidenceRef)),
  );
  let requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[] =
    baselineRequirementHits;
  let localEvidenceRefs = new Set<string>();
  const temporalFrontierRefsByRequirement = input.requirements.map(
    () => new Set<string>(),
  );
  const temporalFrontierSucceededByRequirement = input.requirements.map(
    () => false,
  );
  let certifiedAssistantDialogueRefs = new Set<string>();
  let certifiedDialoguePredecessorsByAssistant = new Map<string, string>();
  let certifiedDialogueProofsByAssistant = new Map<
    string,
    MemoryDialoguePredecessorProofV1
  >();
  let dialogueVerifierVersion: string | null = null;
  let dialogueVerificationRevision: string | null = null;
  const dialogueOrdinalCohortsByRequirement = new Map<
    string,
    readonly Readonly<{
      result: MemorySourceLocalEvidenceResultV1;
      hits: readonly MemorySourceLocalEvidenceHitV1[];
    }>[]
  >();
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
        const isOrdinalTarget =
          dialogueOrdinal !== undefined &&
          requirement.requirementId === ordinalTargetRequirementId;
        if (
          !planScopedLocalization &&
          !eligibility?.eligible &&
          !isOrdinalTarget
        )
          continue;
        if (!eligibility)
          throw namedError("MemorySourceLocalEligibilityMissing");
        let temporalFrontierAttempted = false;
        try {
          const temporalBinding = boundTemporalConstraints[requirementIndex];
          if (!temporalBinding) {
            throw namedError("MemoryEvidenceTemporalBindingMissing");
          }
          temporalFrontierAttempted =
            temporalFrontierRepairActive &&
            (temporalBinding.window.kind !== "unbounded" ||
              temporalBinding.queryScopeInterval !== null);
          const locatorRequirement =
            evidenceGroundedRoleBindingEligible &&
            roleBindingRequirements[requirementIndex]
              ? roleBindingRequirements[requirementIndex]
              : temporalFrontierAttempted
                ? (sourceLocalRequirements[requirementIndex] ?? requirement)
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
          const materializationBudget =
            respondingAssistantMaterializationEligible
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
          // Frontier widens only the repair proposal aperture. Notebook and
          // selector caps remain unchanged, while baseline candidates keep
          // priority in the global merge below.
          const locatorBudget = temporalFrontierAttempted
            ? Object.freeze({
                ...materializationBudget,
                maxAnchors: 8,
                maxAnchorsPerSource: 8,
                maxCandidatesPerChannel: Math.max(
                  8,
                  materializationBudget.maxCandidatesPerChannel,
                ),
              })
            : materializationBudget;
          const ordinalPopulationBudget = isOrdinalTarget
            ? Object.freeze({
                ...locatorBudget,
                // The adapter must return the entire bounded population, or
                // reject it. This is a capacity for proof, not a ranked cap.
                maxAnchors: 8,
                maxAnchorsPerSource: 8,
                maxCandidatesPerChannel: Math.max(
                  8,
                  locatorBudget.maxCandidatesPerChannel,
                ),
                // Ordinal populations are proof-bounded. A larger render cap
                // is not a best-effort improvement: it invalidates the v2
                // cohort contract and must never reach the bridge.
                maxChars: 16_384,
              })
            : locatorBudget;
          const baselineEvidenceRefs = temporalFrontierAttempted
            ? Object.freeze([
                ...new Set(
                  (baselineRequirementHits[requirementIndex] ?? [])
                    // Frontier snapshots operate in the source-local address
                    // domain. Global indexes may expose an immutable physical
                    // alias for the same turn; keep that candidate in the
                    // normal baseline-first merge, but never pass the foreign
                    // alias into the source-local request boundary.
                    .filter(
                      (hit) =>
                        sourceLocalLockedIds.includes(hit.sourceId) &&
                        evidenceSourceIdV1(hit.evidenceRef) === hit.sourceId,
                    )
                    .map((hit) => hit.evidenceRef),
                ),
              ])
            : Object.freeze([]);
          const request = Object.freeze({
            requirement: locatorRequirement,
            ...(temporalFrontierAttempted
              ? {
                  temporalFrontier: Object.freeze({
                    frontierVersion:
                      PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1,
                    originalQuery: input.query,
                    temporalBinding,
                    lanePolicy: "original_and_requirement" as const,
                    baselineEvidenceRefs,
                  }),
                }
              : {}),
            ...(isOrdinalTarget ||
            certifiedAssistantDialogueCandidate ||
            materializationAuthorization?.mode === "late_binding" ||
            materializationAuthorization?.mode === "shared_envelope" ||
            (materializationAuthorization?.mode === "assistant_leaf" &&
              requirement.dependencyRelation !== undefined)
              ? { assistantDialogueCandidate: true }
              : {}),
            ...(isOrdinalTarget ? { dialogueOrdinal } : {}),
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
            budget: ordinalPopulationBudget,
          });
          // A typed ordinal is never one mixed source aperture. Fan out the
          // immutable full lock into independent active-source cohorts.
          const {
            respondingAssistantMaterialization: _ordinalMaterialization,
            ...ordinalRequest
          } = request;
          const cohortRequests = isOrdinalTarget
            ? ordinalPopulationLockedSourceIds.map((activeSourceId) =>
                Object.freeze({
                  ...ordinalRequest,
                  lockedSourceIds: Object.freeze([activeSourceId]),
                  dialogueOrdinalFullLockedSourceIds: Object.freeze([
                    ...ordinalPopulationLockedSourceIds,
                  ]),
                }),
              )
            : [request];
          const materialized = [] as Array<
            Readonly<{
              request: typeof request;
              result: MemorySourceLocalEvidenceResultV1;
              hits: readonly MemorySourceLocalEvidenceHitV1[];
            }>
          >;
          for (const cohortRequest of cohortRequests) {
            try {
              const locatedResult = await input.sourceLocalLocator.locate(
                cohortRequest,
                input.signal,
              );
              validateMemorySourceLocalEvidenceResultV1({
                locator: input.sourceLocalLocator,
                request: cohortRequest,
                result: locatedResult,
              });
              const hydrated = await hydrateMemorySourceLocalEvidenceResultV1({
                hydrator: input.sourceLocalHydrator,
                request: cohortRequest,
                result: locatedResult,
                signal: input.signal,
              });
              const cohortHits = validateMemorySourceLocalEvidenceResultV1({
                locator: input.sourceLocalLocator,
                request: cohortRequest,
                result: hydrated,
              });
              materialized.push(
                Object.freeze({
                  request: cohortRequest as typeof request,
                  result: hydrated,
                  hits: cohortHits,
                }),
              );
            } catch (cohortError) {
              if (input.signal.aborted || isAbort(cohortError))
                throw abortError();
              // An ordinal source that cannot form an atomic cohort remains
              // unknown for the later global reducer; it never falls back to
              // a mixed ranked candidate set.
              if (!isOrdinalTarget) throw cohortError;
            }
          }
          if (materialized.length === 0 && !isOrdinalTarget) {
            throw namedError("MemoryDialogueOrdinalCohortUnavailable");
          }
          if (materialized.length === 0) continue;
          const firstMaterialized = materialized[0];
          if (!firstMaterialized) {
            throw namedError("MemoryDialogueOrdinalCohortUnavailable");
          }
          const result =
            materialized.length === 1
              ? firstMaterialized.result
              : Object.freeze({
                  ...firstMaterialized.result,
                  locatorRevision: hashCanonicalJsonV1({
                    schemaVersion:
                      "paw.memory-dialogue-ordinal-cohort-fanout.v1",
                    revisions: materialized.map(
                      (item) => item.result.locatorRevision,
                    ),
                  } as never),
                  hits: Object.freeze(
                    materialized.flatMap((item) => item.result.hits),
                  ),
                  dialogueOrdinalCohort: undefined,
                  telemetry: Object.freeze({
                    ...firstMaterialized.result.telemetry,
                    anchorCount: materialized.reduce(
                      (total, item) => total + item.hits.length,
                      0,
                    ),
                    includedTurnCount: materialized.reduce(
                      (total, item) =>
                        total + item.result.telemetry.includedTurnCount,
                      0,
                    ),
                    renderedChars: materialized.reduce(
                      (total, item) =>
                        total + item.result.telemetry.renderedChars,
                      0,
                    ),
                  }),
                });
          const hits = Object.freeze(materialized.flatMap((item) => item.hits));
          located[requirementIndex] = Object.freeze({ result, hits });
          if (isOrdinalTarget) {
            dialogueOrdinalCohortsByRequirement.set(
              requirement.requirementId,
              Object.freeze(
                materialized.map((item) =>
                  Object.freeze({ result: item.result, hits: item.hits }),
                ),
              ),
            );
          }
          temporalFrontierSucceededByRequirement[requirementIndex] =
            result.temporalFrontier !== undefined;
          for (const evidenceRef of result.temporalFrontier
            ?.introducedEvidenceRefs ?? []) {
            temporalFrontierRefsByRequirement[requirementIndex]?.add(
              evidenceRef,
            );
          }
          leafReports[requirementIndex] = Object.freeze({
            eligibility,
            status: hits.length === 0 ? "completed_empty" : "completed",
            baselineHitCount:
              baselineRequirementHits[requirementIndex]?.length ?? 0,
            localizedHitCount: hits.length,
            locatorRevision: result.locatorRevision,
            ...(result.temporalFrontier === undefined
              ? {}
              : {
                  temporalFrontierStatus: result.temporalFrontier.status,
                  temporalFrontierConsideredCount:
                    result.temporalFrontier.postings.length,
                  temporalFrontierReturnedCount:
                    result.temporalFrontier.returnedEvidenceRefs.length,
                  temporalFrontierBudgetOmittedCount:
                    result.temporalFrontier.omitted.filter(
                      (item) => item.reason === "rank_budget",
                    ).length,
                }),
          });
        } catch (error) {
          if (input.signal.aborted || isAbort(error)) throw abortError();
          const failureCode = memorySourceLocalEvidenceFailureCodeV1(error);
          if (planScopedLocalization && !temporalFrontierAttempted) {
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
          temporalFrontierSucceededByRequirement[index]
            ? mergeEvidenceHits(hits, located[index]?.hits ?? [])
            : mergeEvidenceHits(located[index]?.hits ?? [], hits),
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
  const orderHitsForTemporalWindow = (
    hits: readonly MemoryEvidenceNotebookHitV1[],
    index: number,
  ): readonly MemoryEvidenceNotebookHitV1[] => {
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
  };
  requirementHits = requirementHits.map(orderHitsForTemporalWindow);
  const baselineSupportHits = baselineRequirementHits.map(
    orderHitsForTemporalWindow,
  );
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
    const allowContextOnlyCandidates =
      dialogueOrdinal !== undefined ||
      assistantLeafPresent ||
      input.intent.roleConstraint !== "user" ||
      evidenceGroundedRoleBindingEligible ||
      certifiedAssistantDialogueCandidate;
    const frontierIntroduced = temporalFrontierRefsByRequirement.some(
      (refs) => refs.size > 0,
    );
    const ordinaryCandidates = frontierIntroduced
      ? selectSupportCandidatesPreservingBaselineV1({
          baselineRequirementHits: baselineSupportHits,
          augmentedRequirementHits: requirementHits,
          selectedSourceIds: sourceLocalLockedIds,
          allowContextOnly: allowContextOnlyCandidates,
          maximum: 32,
        })
      : selectSupportCandidates(
          requirementHits,
          sourceLocalLockedIds,
          allowContextOnlyCandidates,
          32,
        );
    // A host settlement sees an exact cohort, never a top-k approximation.
    // Ordinary leaves retain the pre-existing ranked candidate path.
    const ordinalCohortCandidates = dialogueOrdinal
      ? Object.freeze(
          [...dialogueOrdinalCohortsByRequirement.values()]
            .flat()
            .flatMap((cohort) => cohort.hits)
            .filter((hit) => hit.sourceKind === "assistant_output"),
        )
      : Object.freeze([]);
    let candidates = Object.freeze([
      ...new Map(
        [...ordinaryCandidates, ...ordinalCohortCandidates].map(
          (hit) => [hit.evidenceRef, hit] as const,
        ),
      ).values(),
    ]);
    if (candidates.length > 0 || dialogueOrdinal !== undefined) {
      const candidateEvidenceRefs = new Set(
        candidates.map((candidate) => candidate.evidenceRef),
      );
      const candidateScopes = Object.freeze(
        input.requirements.map((requirement, index) =>
          Object.freeze({
            requirementId: requirement.requirementId,
            evidenceRefs: Object.freeze(
              requirement.requirementId === ordinalTargetRequirementId
                ? ordinalCohortCandidates.map((hit) => hit.evidenceRef)
                : (requirementHits[index] ?? [])
                    .map((hit) => hit.evidenceRef)
                    .filter((evidenceRef) =>
                      candidateEvidenceRefs.has(evidenceRef),
                    ),
            ),
          }),
        ),
      );
      const verifierTargets =
        (dialogueOrdinal !== undefined ||
          assistantLeafPresent ||
          evidenceGroundedRoleBindingEligible ||
          input.intent.roleConstraint === "assistant" ||
          input.intent.roleConstraint === "any" ||
          certifiedAssistantDialogueCandidate) &&
        input.dialoguePredecessorVerifier
          ? Object.freeze(
              candidates
                .filter(
                  (candidate) =>
                    (dialogueOrdinal === undefined ||
                      ordinalCohortCandidates.some(
                        (ordinalCandidate) =>
                          ordinalCandidate.evidenceRef ===
                          candidate.evidenceRef,
                      )) &&
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
          // The ordinary verifier remains a single, capped (32) request. A
          // typed ordinal population may cover up to eight outputs from each
          // of eight sources, so it is verified as deterministic, source
          // boundary-preserving batches instead of widening the generic port.
          const targetBatches = dialogueOrdinal
            ? partitionOrdinalPredecessorTargetsV1(verifierTargets)
            : verifierTargets.length <= 32
              ? Object.freeze([verifierTargets])
              : (() => {
                  throw namedError(
                    "MemoryDialoguePredecessorVerificationCapped",
                  );
                })();
          const verificationBatches: Array<{
            readonly request: MemoryDialoguePredecessorVerificationRequestV1;
            readonly result: Awaited<
              ReturnType<MemoryDialoguePredecessorVerifierV1["verify"]>
            >;
            readonly proofs: readonly MemoryDialoguePredecessorProofV1[];
          }> = [];
          for (const targets of targetBatches) {
            const request = Object.freeze({
              targets,
              lockedSourceIds: Object.freeze(
                dialogueOrdinal
                  ? [...new Set(targets.map((target) => target.sourceId))]
                  : [...sourceLocalLockedIds],
              ),
              ...(input.evidenceTimeUpperBound === undefined
                ? {}
                : { evidenceTimeUpperBound: input.evidenceTimeUpperBound }),
            });
            const result = await input.dialoguePredecessorVerifier.verify(
              request,
              input.signal,
            );
            const proofs = validateMemoryDialoguePredecessorVerificationV1({
              verifier: input.dialoguePredecessorVerifier,
              request,
              result,
              evidenceRefBelongsToSource:
                input.index.evidenceRefBelongsToSource,
            });
            verificationBatches.push(
              Object.freeze({ request, result, proofs }),
            );
          }
          const verifiedProofs = Object.freeze(
            verificationBatches.flatMap((batch) => batch.proofs),
          );
          if (
            new Set(verifiedProofs.map((proof) => proof.assistant.evidenceRef))
              .size !== verifiedProofs.length
          ) {
            throw namedError("MemoryDialoguePredecessorBatchInvalid");
          }
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
          dialogueVerifierVersion =
            input.dialoguePredecessorVerifier.verifierVersion;
          dialogueVerificationRevision = hashCanonicalJsonV1({
            verifierVersion: dialogueVerifierVersion,
            batches: verificationBatches.map((batch) => ({
              targetRefs: batch.request.targets.map(
                (target) => target.evidenceRef,
              ),
              verificationRevision: batch.result.verificationRevision,
            })),
          } as never);
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
        const ordinaryRequirements = dialogueOrdinal
          ? executionRequirements.filter(
              (requirement) =>
                requirement.requirementId !== ordinalTargetRequirementId,
            )
          : executionRequirements;
        const ordinaryRequirementIds = new Set(
          ordinaryRequirements.map((requirement) => requirement.requirementId),
        );
        const ordinaryCandidateScopes = Object.freeze(
          candidateScopes.filter((scope) =>
            ordinaryRequirementIds.has(scope.requirementId),
          ),
        );
        const ordinaryCandidateRefs = new Set(
          ordinaryCandidateScopes.flatMap((scope) => scope.evidenceRefs),
        );
        const ordinaryCandidates = Object.freeze(
          candidates.filter((candidate) =>
            ordinaryCandidateRefs.has(candidate.evidenceRef),
          ),
        );
        const ordinaryRequirementHits = Object.freeze(
          input.requirements.flatMap((requirement, index) =>
            ordinaryRequirementIds.has(requirement.requirementId)
              ? [requirementHits[index] ?? Object.freeze([])]
              : [],
          ),
        );
        const ordinaryTemporalConstraints = Object.freeze(
          input.requirements.flatMap((requirement, index) =>
            ordinaryRequirementIds.has(requirement.requirementId)
              ? [
                  boundTemporalConstraints[
                    index
                  ] as MemoryEvidenceBoundTemporalConstraintV1,
                ]
              : [],
          ),
        );
        const ordinarySettlement =
          dialogueOrdinal !== undefined && ordinaryRequirements.length > 0
            ? await settleMemoryEvidenceSupportSelectionV1({
                selector: input.supportSelector,
                query: input.query,
                intent: input.intent,
                requirements: ordinaryRequirements,
                candidates: ordinaryCandidates,
                candidateScopes: ordinaryCandidateScopes,
                requirementHits: ordinaryRequirementHits,
                roleConstraint: input.intent.roleConstraint,
                certifiedSharedDialogueRefs:
                  structurallyBoundCertifiedAssistantDialogueRefs,
                certifiedDialoguePredecessorsByAssistant,
                certifiedAssistantDialogueCandidate,
                selectorCertifiedAssistantDialogueRefs,
                temporalConstraints: ordinaryTemporalConstraints,
                lockedSourceIds: sourceLocalLockedIds,
                originRevision: input.queryAnswerOrigin.originRevision,
                committedAttempt:
                  localEvidenceRefs.size > 0 ? "augmented" : "baseline",
                attemptCount: 1,
                signal: input.signal,
              })
            : undefined;
        const ordinalSettlement = dialogueOrdinal
          ? await settleMemoryDialogueOrdinalTransactionV1({
              selector: input.supportSelector,
              query: input.query,
              intent: input.intent,
              requirements: executionRequirements.filter(
                (requirement) =>
                  requirement.requirementId === ordinalTargetRequirementId,
              ),
              candidates,
              candidateScopes: candidateScopes.filter(
                (scope) => scope.requirementId === ordinalTargetRequirementId,
              ),
              temporalConstraints:
                ordinaryTemporalConstraints.length ===
                boundTemporalConstraints.length
                  ? boundTemporalConstraints
                  : Object.freeze(
                      input.requirements.flatMap((requirement, index) =>
                        requirement.requirementId === ordinalTargetRequirementId
                          ? [
                              boundTemporalConstraints[
                                index
                              ] as MemoryEvidenceBoundTemporalConstraintV1,
                            ]
                          : [],
                      ),
                    ),
              lockedSourceIds: ordinalPopulationLockedSourceIds,
              originRevision: input.queryAnswerOrigin.originRevision,
              cohortsByRequirement: dialogueOrdinalCohortsByRequirement,
              constraint: dialogueOrdinal,
              admission:
                dialogueOrdinalAdmission as MemoryDialogueOrdinalAdmissionReceiptV1,
              proofsByAssistant: certifiedDialogueProofsByAssistant,
              committedAttempt:
                localEvidenceRefs.size > 0 ? "augmented" : "baseline",
              signal: input.signal,
            })
          : undefined;
        const settlement =
          dialogueOrdinal && ordinalSettlement
            ? ordinarySettlement
              ? mergeMemoryDialogueOrdinalSelectionV1({
                  query: input.query,
                  intent: input.intent,
                  requirements: executionRequirements,
                  temporalConstraints: boundTemporalConstraints,
                  candidateScopes,
                  lockedSourceIds: sourceLocalLockedIds,
                  originRevision: input.queryAnswerOrigin.originRevision,
                  ordinal: ordinalSettlement,
                  ordinary: ordinarySettlement,
                  committedAttempt:
                    localEvidenceRefs.size > 0 ? "augmented" : "baseline",
                })
              : ordinalSettlement
            : await settleMemoryEvidenceSupportSelectionV1({
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
        if (dialogueOrdinal) {
          const winner = supportAssessments.find(
            (assessment) =>
              assessment.requirementId === ordinalTargetRequirementId,
          )?.supportingEvidenceRefs[0];
          const winnerPredecessor = winner
            ? certifiedDialoguePredecessorsByAssistant.get(winner)
            : undefined;
          const winnerProof = winner
            ? certifiedDialogueProofsByAssistant.get(winner)
            : undefined;
          certifiedAssistantDialogueRefs = new Set(winner ? [winner] : []);
          certifiedDialoguePredecessorsByAssistant = new Map(
            winner && winnerPredecessor ? [[winner, winnerPredecessor]] : [],
          );
          certifiedDialogueProofsByAssistant = new Map(
            winner && winnerProof ? [[winner, winnerProof]] : [],
          );
        }
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
          dialogueOrdinal === undefined &&
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
  const allowFallbackContextOnly =
    dialogueOrdinal === undefined &&
    input.intent.roleConstraint === "assistant";
  // Deterministic support floor: selector abstention (empty binding, failed
  // group, or selector failure) must not collapse a requirement's packet to
  // zero evidence while locked-source candidates exist. Exclusion requires a
  // positive judgment; absence of one downgrades to code-owned ranking.
  let supportFloorAppliedCount = 0;
  const floorRequirementIndexes = executionRequirements
    .map((requirement, index) =>
      requirement.requirementId === ordinalTargetRequirementId ? -1 : index,
    )
    .filter((index) => index >= 0);
  if (
    selectedRefsByRequirement !== undefined &&
    floorRequirementIndexes.length > 0
  ) {
    const floor = applyMemoryDeterministicSupportFloorV1({
      selectedRefsByRequirement,
      requirementIds: floorRequirementIndexes.map(
        (index) => executionRequirements[index]?.requirementId ?? "",
      ),
      requirementHits: floorRequirementIndexes.map(
        (index) => requirementHits[index] ?? Object.freeze([]),
      ),
      lockedSourceIds: sourceLocalLockedIds,
      maxFloorHitsPerRequirement: 2,
      excludedEvidenceRefs: floorRequirementIndexes.map((index) => {
        const requirement = executionRequirements[index];
        if (!requirement) return new Set<string>();
        const assessment = supportAssessments.find(
          (item) => item.requirementId === requirement.requirementId,
        );
        const supporting = new Set(assessment?.supportingEvidenceRefs ?? []);
        return new Set([
          ...(assessment?.contradictingEvidenceRefs ?? []),
          ...(assessment?.unknownEvidenceRefs ?? []),
          ...[...(temporalFrontierRefsByRequirement[index] ?? [])].filter(
            (evidenceRef) => !supporting.has(evidenceRef),
          ),
        ]);
      }),
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
  const packetFallbackHits = dialogueOrdinal
    ? Object.freeze([])
    : mergeEvidenceHits(
        requirementHits
          .flat()
          .filter(
            (hit) =>
              nonSupportingRefs.has(hit.evidenceRef) &&
              !localEvidenceRefs.has(hit.evidenceRef),
          ),
        prioritizedPrimary.hits,
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
            dialogueOrdinal === undefined &&
            (input.intent.temporalMode !== "latest" ||
              notebook.coverage.some((item) => item.status !== "covered") ||
              nonSupportingRefs.size > 0),
          fallbackAnswerRole: "candidate",
          maxFallbackChars: input.maxNotebookChars,
          maxFallbackHitsPerSource: 1,
          roleConstraint: input.intent.roleConstraint,
          certifiedDialogueEvidenceRefs: certifiedAssistantDialogueRefs,
        })
      : buildPrimaryEvidencePacketSources(
          prioritizedPrimary.hits,
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
      ...(dialogueOrdinalAdmission === undefined
        ? {}
        : {
            ordinalAdmissionRevision:
              dialogueOrdinalAdmission.admissionRevision,
          }),
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

/**
 * Ordinal dialogue settlement is deliberately separate from semantic triage.
 * It consumes one immutable, complete cohort per source and gives authority
 * to exactly one verifier-backed output only after the global reduction.
 */
async function settleMemoryDialogueOrdinalTransactionV1(input: {
  readonly selector: MemoryEvidenceSupportSelectorV1;
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly candidates: readonly MemoryEvidenceNotebookHitV1[];
  readonly candidateScopes: readonly Readonly<{
    requirementId: string;
    evidenceRefs: readonly string[];
  }>[];
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly lockedSourceIds: readonly string[];
  readonly originRevision: string;
  readonly cohortsByRequirement: ReadonlyMap<
    string,
    readonly Readonly<{
      result: MemorySourceLocalEvidenceResultV1;
      hits: readonly MemorySourceLocalEvidenceHitV1[];
    }>[]
  >;
  readonly constraint: MemoryDialogueOrdinalConstraintV1;
  readonly admission: MemoryDialogueOrdinalAdmissionReceiptV1;
  readonly proofsByAssistant: ReadonlyMap<
    string,
    MemoryDialoguePredecessorProofV1
  >;
  readonly committedAttempt: "augmented" | "baseline";
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
  const eligible = input.requirements.filter(
    (requirement) =>
      requirement.roleConstraint === "assistant" ||
      requirement.roleCandidates?.includes("assistant") === true,
  );
  // The compiler binds an assistant-answer leaf. If planning produces zero or
  // many possible leaves, declining is safer than broadcasting a winner.
  const leaf = eligible.length === 1 ? eligible[0] : undefined;
  const empty = (requirementId: string): MemoryEvidenceTriageAssessmentV1 =>
    Object.freeze({
      requirementId,
      supportingEvidenceRefs: Object.freeze([]),
      contradictingEvidenceRefs: Object.freeze([]),
      unknownEvidenceRefs: Object.freeze([]),
    });
  const candidateByRef = new Map(
    input.candidates.map((candidate) => [candidate.evidenceRef, candidate]),
  );
  const cohorts = leaf
    ? (input.cohortsByRequirement.get(leaf.requirementId) ?? Object.freeze([]))
    : Object.freeze([]);
  const bySource = new Map<string, (typeof cohorts)[number]>();
  for (const item of cohorts) {
    const cohort = item.result.dialogueOrdinalCohort;
    if (!cohort || bySource.has(cohort.activeSourceId)) continue;
    bySource.set(cohort.activeSourceId, item);
  }
  const settlements = await mapWithConcurrencyV1(
    input.lockedSourceIds,
    2,
    async (sourceId): Promise<MemoryDialogueOrdinalSourceSettlementV1> => {
      const materialized = bySource.get(sourceId);
      const cohort = materialized?.result.dialogueOrdinalCohort;
      if (
        !leaf ||
        !cohort ||
        cohort.activeSourceId !== sourceId ||
        cohort.fullLockedSourceIds.length !== input.lockedSourceIds.length ||
        cohort.fullLockedSourceIds.some(
          (id, index) => id !== input.lockedSourceIds[index],
        )
      ) {
        return Object.freeze({ status: "unknown", sourceId, knownCount: 0 });
      }
      try {
        validateMemoryDialogueOrdinalCohortV1({
          constraint: input.constraint,
          cohort,
        });
        const outputs = cohort.items.map((item) => {
          const proof = input.proofsByAssistant.get(item.evidenceRef);
          const candidate = candidateByRef.get(item.evidenceRef);
          if (
            !proof ||
            !candidate ||
            candidate.sourceId !== sourceId ||
            candidate.sourceKind !== "assistant_output" ||
            proof.assistant.evidenceRef !== item.evidenceRef ||
            proof.assistant.turnOrder !== item.turnOrder ||
            proof.precedingUser.evidenceRef !== item.predecessorEvidenceRef ||
            proof.precedingUser.turnOrder !== item.predecessorTurnOrder ||
            proof.assistant.contentHash !== item.contentHash ||
            proof.precedingUser.contentHash !== item.predecessorContentHash ||
            hashTextV1(proof.assistant.content) !== item.contentHash ||
            hashTextV1(proof.precedingUser.content) !==
              item.predecessorContentHash
          ) {
            throw namedError("MemoryDialogueOrdinalCohortProofInvalid");
          }
          return Object.freeze({
            evidenceRef: item.evidenceRef,
            assistantOutput: proof.assistant.content,
            predecessorUserPrompt: proof.precedingUser.content,
          });
        });
        // Admission happens in the host before calling a potentially remote
        // selector. An oversized raw pair population is one unknown source,
        // never a shortened or split model prompt.
        compileMemoryDialogueOrdinalSelectorBodyV1({
          constraint: input.constraint,
          cohort,
          query: input.query,
          outputs,
        });
        const occurrences = input.selector.dialogueOrdinalSelector
          ? await input.selector.dialogueOrdinalSelector.selectCohort(
              {
                constraint: input.constraint,
                cohort,
                query: input.query,
                outputs,
              },
              input.signal,
            )
          : (() => {
              throw namedError("MemoryDialogueOrdinalSelectorMissing");
            })();
        return settleMemoryDialogueOrdinalSourceV1({
          constraint: input.constraint,
          cohort,
          occurrences,
        });
      } catch (error) {
        if (input.signal.aborted || isAbort(error)) throw abortError();
        return Object.freeze({
          status: "unknown",
          sourceId,
          knownCount: 0,
          ...(error instanceof Error &&
          error.name === "MemoryDialogueOrdinalSelectorBodyTooLarge"
            ? { failureCode: "raw_pair_body_too_large" as const }
            : {}),
        });
      }
    },
  );
  const global = reduceMemoryDialogueOrdinalSourcesV1(settlements);
  const selected =
    global.status === "winner" && leaf ? global.evidenceRef : undefined;
  const rawAssessments = leaf
    ? Object.freeze([
        selected
          ? Object.freeze({
              requirementId: leaf.requirementId,
              supportingEvidenceRefs: Object.freeze([selected]),
              contradictingEvidenceRefs: Object.freeze([]),
              unknownEvidenceRefs: Object.freeze([]),
            })
          : empty(leaf.requirementId),
      ])
    : Object.freeze([]);
  const authorityAssessments =
    selected && leaf
      ? enforceSelectedEvidenceAuthority({
          assessments: rawAssessments,
          requirements: Object.freeze([leaf]),
          candidateEvidenceRefs: new Set([selected]),
          candidateEvidenceRefsByRequirement: new Map([
            [leaf.requirementId, new Set([selected])],
          ]),
          requirementHits: Object.freeze([
            Object.freeze(
              [candidateByRef.get(selected)].filter(
                (candidate): candidate is MemoryEvidenceNotebookHitV1 =>
                  candidate !== undefined,
              ),
            ),
          ]),
          roleConstraint: "assistant",
          certifiedSharedDialogueRefs: new Set([selected]),
          certifiedDialoguePredecessorsByAssistant: new Map(
            [
              [
                selected,
                input.proofsByAssistant.get(selected)?.precedingUser
                  .evidenceRef,
              ],
            ].filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          certifiedAssistantDialogueCandidate: true,
        })
      : rawAssessments;
  const committed = selected !== undefined && global.status === "winner";
  const assessments = committed
    ? Object.freeze(
        authorityAssessments.map((assessment) =>
          Object.freeze({
            ...assessment,
            dialogueOrdinalSelection: Object.freeze({
              constraintRevision: input.constraint.constraintRevision,
              withinOutputOrdinal: global.withinOutputOrdinal,
            }),
          }),
        ),
      )
    : Object.freeze([]);
  const selectedRefsByRequirement = new Map<string, ReadonlySet<string>>(
    input.requirements.map((requirement) => [
      requirement.requirementId,
      new Set(
        selected && leaf?.requirementId === requirement.requirementId
          ? [selected]
          : [],
      ),
    ]),
  );
  const cohortRevisions = input.lockedSourceIds.map(
    (sourceId) =>
      bySource.get(sourceId)?.result.dialogueOrdinalCohort
        ?.populationRevision ??
      hashCanonicalJsonV1({
        schemaVersion: "missing-ordinal-cohort.v1",
        sourceId,
      } as never),
  );
  const proofIdentity = {
    proofVersion: "paw.memory-ordinal-settlement-proof.v1" as const,
    constraintRevision: input.constraint.constraintRevision,
    admissionRevision: input.admission.admissionRevision,
    cohortRevisions: Object.freeze(cohortRevisions),
    sourceSettlements: Object.freeze(
      settlements.map((settlement) =>
        Object.freeze({
          sourceId: settlement.sourceId,
          status: settlement.status,
          knownCount: "knownCount" in settlement ? settlement.knownCount : 0,
          ...(settlement.status === "unknown" &&
          settlement.failureCode !== undefined
            ? { failureCode: settlement.failureCode }
            : {}),
          ...(settlement.status === "winner"
            ? {
                winnerEvidenceRef: settlement.evidenceRef,
                withinOutputOrdinal: settlement.withinOutputOrdinal,
              }
            : {}),
        }),
      ),
    ),
    globalStatus: global.status,
    ...(global.status === "winner"
      ? {
          winnerEvidenceRef: global.evidenceRef,
          withinOutputOrdinal: global.withinOutputOrdinal,
        }
      : {}),
    authorityScope: "post_settlement_winner_only" as const,
  };
  const ordinalSettlementProof = Object.freeze({
    ...proofIdentity,
    proofRevision: hashCanonicalJsonV1(proofIdentity as never),
  });
  const selectionRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-dialogue-ordinal-settlement.v2:winner-only",
    selectorVersion:
      input.selector.dialogueOrdinalSelector?.selectorVersion ?? "missing",
    constraintRevision: input.constraint.constraintRevision,
    admissionRevision: input.admission.admissionRevision,
    lockedSourceIds: input.lockedSourceIds,
    cohortRevisions,
    settlements,
    global,
  } as never);
  const selectorGroups = compileMemoryEvidenceSelectorGroupsV1({
    intent: input.intent,
    requirements: input.requirements,
  });
  const selectorGroup = leaf
    ? selectorGroups.find((group) =>
        group.requirementIds.includes(leaf.requirementId),
      )
    : undefined;
  const snapshotScopes = input.candidateScopes.map((scope) =>
    Object.freeze({
      requirementId: scope.requirementId,
      evidenceRefs:
        selected && leaf?.requirementId === scope.requirementId
          ? Object.freeze([selected])
          : Object.freeze([]),
    }),
  );
  return Object.freeze({
    selectionRevision,
    assessments,
    selectedRefsByRequirement,
    groupCount: 1,
    committedGroupCount: committed ? 1 : 0,
    failedGroupCount: committed ? 0 : 1,
    selectorExecutionSnapshot: compileMemorySelectorExecutionSnapshotV1({
      query: input.query,
      intent: input.intent,
      requirements: input.requirements,
      temporalConstraints: input.temporalConstraints,
      candidateScopes: snapshotScopes,
      lockedSourceIds: input.lockedSourceIds,
      originRevision: input.originRevision,
      selectorVersion:
        input.selector.dialogueOrdinalSelector?.selectorVersion ?? "missing",
      selectionRevision,
      committedAttempt: input.committedAttempt,
      attemptCount: 1,
      ordinalSettlementProof,
      groups: Object.freeze([
        Object.freeze({
          groupId: selectorGroup?.groupId ?? "ordinal-unbound",
          requirementIds: selectorGroup?.requirementIds ?? Object.freeze([]),
          status: committed ? ("committed" as const) : ("failed" as const),
          assessments,
          failureCodes: committed
            ? Object.freeze([])
            : Object.freeze([
                "MemoryDialogueOrdinalSettlementUnavailable",
                ...(settlements.some(
                  (settlement) =>
                    settlement.status === "unknown" &&
                    settlement.failureCode === "raw_pair_body_too_large",
                )
                  ? ["MemoryDialogueOrdinalRawPairBodyTooLarge"]
                  : []),
              ]),
        }),
      ]),
    }),
  });
}

/** Preserves source order while limiting independent cohort model calls. */
async function mapWithConcurrencyV1<T, R>(
  values: readonly T[],
  concurrency: 1 | 2,
  work: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const output: R[] = new Array(values.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const value = values[index];
      if (value === undefined) return;
      output[index] = await work(value);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  );
  return Object.freeze(output);
}

/**
 * Ordinal populations are full per-source cohorts. Preserve those boundaries
 * while fitting the unchanged generic predecessor-verifier cap of 32.
 */
function partitionOrdinalPredecessorTargetsV1<
  T extends Readonly<{ sourceId: string }>,
>(targets: readonly T[]): readonly (readonly T[])[] {
  const bySource = new Map<string, T[]>();
  for (const target of targets) {
    const group = bySource.get(target.sourceId) ?? [];
    group.push(target);
    bySource.set(target.sourceId, group);
  }
  const batches: T[][] = [];
  let current: T[] = [];
  for (const group of bySource.values()) {
    if (group.length > 32) {
      throw namedError("MemoryDialogueOrdinalPredecessorBatchInvalid");
    }
    if (current.length > 0 && current.length + group.length > 32) {
      batches.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) batches.push(current);
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

/**
 * Reconstitutes the planner's formal groups after the ordinal target has been
 * settled outside the model selector. The ordinal cohort is deliberately
 * narrowed to its winner before snapshotting; its full population remains a
 * transaction proof, never an authority candidate partition.
 */
function mergeMemoryDialogueOrdinalSelectionV1(input: {
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly candidateScopes: readonly Readonly<{
    requirementId: string;
    evidenceRefs: readonly string[];
  }>[];
  readonly lockedSourceIds: readonly string[];
  readonly originRevision: string;
  readonly ordinal: Awaited<
    ReturnType<typeof settleMemoryDialogueOrdinalTransactionV1>
  >;
  readonly ordinary?: Awaited<
    ReturnType<typeof settleMemoryEvidenceSupportSelectionV1>
  >;
  readonly committedAttempt: "augmented" | "baseline";
}): Readonly<{
  selectionRevision: string;
  assessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  selectedRefsByRequirement: ReadonlyMap<string, ReadonlySet<string>>;
  groupCount: number;
  committedGroupCount: number;
  failedGroupCount: number;
  selectorExecutionSnapshot: MemorySelectorExecutionSnapshotV1;
}> {
  const groups = compileMemoryEvidenceSelectorGroupsV1({
    intent: input.intent,
    requirements: input.requirements,
  });
  const ordinalGroupById = new Map(
    input.ordinal.selectorExecutionSnapshot.groups.map((group) => [
      group.groupId,
      group,
    ]),
  );
  const ordinaryGroupById = new Map(
    input.ordinary?.selectorExecutionSnapshot.groups.map((group) => [
      group.groupId,
      group,
    ]) ?? [],
  );
  const assessmentsByRequirement = new Map<
    string,
    MemoryEvidenceTriageAssessmentV1
  >();
  for (const assessment of input.ordinal.assessments) {
    assessmentsByRequirement.set(assessment.requirementId, assessment);
  }
  for (const assessment of input.ordinary?.assessments ?? []) {
    assessmentsByRequirement.set(assessment.requirementId, assessment);
  }
  const selectedRefsByRequirement = new Map<string, ReadonlySet<string>>();
  for (const requirement of input.requirements) {
    selectedRefsByRequirement.set(
      requirement.requirementId,
      input.ordinal.selectedRefsByRequirement.get(requirement.requirementId) ??
        input.ordinary?.selectedRefsByRequirement.get(
          requirement.requirementId,
        ) ??
        new Set(),
    );
  }
  const snapshotScopes = Object.freeze(
    input.candidateScopes.map((scope) =>
      Object.freeze({
        requirementId: scope.requirementId,
        // Only the winner is a post-settlement ordinal candidate. This keeps
        // the final snapshot's assessment partition exact and prevents a
        // non-winner population proof from becoming reader authority.
        evidenceRefs: input.ordinal.selectedRefsByRequirement.has(
          scope.requirementId,
        )
          ? Object.freeze([
              ...(input.ordinal.selectedRefsByRequirement.get(
                scope.requirementId,
              ) ?? new Set()),
            ])
          : scope.evidenceRefs,
      }),
    ),
  );
  const executionGroups: MemorySelectorExecutionGroupInputV1[] = [];
  for (const group of groups) {
    const source =
      ordinalGroupById.get(group.groupId) ??
      ordinaryGroupById.get(group.groupId);
    if (!source) {
      throw namedError("MemoryDialogueOrdinalGroupMergeInvalid");
    }
    executionGroups.push(
      Object.freeze({
        groupId: group.groupId,
        requirementIds: group.requirementIds,
        status: source.status,
        assessments: Object.freeze(
          group.requirementIds.flatMap((requirementId) => {
            const assessment = assessmentsByRequirement.get(requirementId);
            return assessment ? [assessment] : [];
          }),
        ),
        failureCodes: source.failureCodes,
      }),
    );
  }
  const selectionRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-dialogue-ordinal-selection-merge.v2",
    ordinal: input.ordinal.selectionRevision,
    ordinary: input.ordinary?.selectionRevision ?? "none",
    groups: executionGroups.map((group) => ({
      groupId: group.groupId,
      status: group.status,
      failureCodes: group.failureCodes ?? [],
    })),
  } as never);
  const assessments = Object.freeze(
    input.requirements.flatMap((requirement) => {
      const assessment = assessmentsByRequirement.get(
        requirement.requirementId,
      );
      return assessment ? [assessment] : [];
    }),
  );
  const failedGroupCount = executionGroups.filter(
    (group) => group.status === "failed",
  ).length;
  return Object.freeze({
    selectionRevision,
    assessments,
    selectedRefsByRequirement,
    groupCount: executionGroups.length,
    committedGroupCount: executionGroups.filter(
      (group) => group.status === "committed",
    ).length,
    failedGroupCount,
    selectorExecutionSnapshot: compileMemorySelectorExecutionSnapshotV1({
      query: input.query,
      intent: input.intent,
      requirements: input.requirements,
      temporalConstraints: input.temporalConstraints,
      candidateScopes: snapshotScopes,
      lockedSourceIds: input.lockedSourceIds,
      originRevision: input.originRevision,
      selectorVersion: "paw.memory-dialogue-ordinal-selector-merge.v2",
      selectionRevision,
      committedAttempt: input.committedAttempt,
      attemptCount: 1,
      groups: executionGroups,
    }),
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
