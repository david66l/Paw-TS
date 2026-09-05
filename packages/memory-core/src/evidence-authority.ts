import { hashCanonicalJsonV1 } from "./canonical.js";
import type { MemoryEvidenceNotebookHitV1 } from "./evidence-contracts.js";
import {
  type MemoryEvidenceDispositionBindingV1,
  type MemoryEvidenceDispositionV1,
  classifyMemoryEvidenceUseV1,
} from "./evidence-origin.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./evidence-query-planner.js";
import { evidenceSourceIdV1 } from "./evidence-ref.js";
import type {
  MemoryEvidenceIndexSearchResultV1,
  MemoryEvidenceIndexV1,
} from "./evidence-resolution-contracts.js";
import { namedError } from "./evidence-resolution-validation.js";
import type { MemoryEvidenceTriageAssessmentV1 } from "./evidence-support-selector.js";
import type { MemoryEvidenceTemporalIntervalV2 } from "./query-plan-contracts.js";

export function filterEvidenceSearchResultForRole(
  result: MemoryEvidenceIndexSearchResultV1,
  roleConstraint: MemoryEvidenceQueryIntentV3["roleConstraint"],
): MemoryEvidenceIndexSearchResultV1 {
  if (roleConstraint !== "user") return result;
  return Object.freeze({
    ...result,
    lists: Object.freeze(
      result.lists.map((list) =>
        Object.freeze({
          ...list,
          candidates: Object.freeze(
            list.candidates.filter(
              (candidate) => candidate.authority !== "context_only",
            ),
          ),
        }),
      ),
    ),
    hits: Object.freeze(
      result.hits.filter((hit) => hit.authority !== "context_only"),
    ),
  });
}

/**
 * Moves evidence observed inside a host-bound temporal window ahead of other
 * candidates without discarding the latter. This is deliberately a stable
 * priority, not a temporal filter: a later discussion can be the only record
 * of an event inside the requested window. The caller owns compilation of the
 * window from the original query and trusted cutoff.
 */
export function prioritizeEvidenceSearchResultForTemporalWindowV1(
  result: MemoryEvidenceIndexSearchResultV1,
  window: MemoryEvidenceTemporalIntervalV2 | undefined,
): MemoryEvidenceIndexSearchResultV1 {
  if (!window) return result;
  const lower = Date.parse(window.lower);
  const upper = Date.parse(window.upper);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) {
    return result;
  }
  const inside = (observedAt: string | undefined): boolean => {
    const value =
      observedAt === undefined ? Number.NaN : Date.parse(observedAt);
    return Number.isFinite(value) && value >= lower && value < upper;
  };
  const stablePrioritize = <T extends { readonly observedAt?: string }>(
    values: readonly T[],
  ): readonly T[] => {
    if (!values.some((value) => inside(value.observedAt))) return values;
    return Object.freeze([
      ...values.filter((value) => inside(value.observedAt)),
      ...values.filter((value) => !inside(value.observedAt)),
    ]);
  };
  const lists = result.lists.map((list) => {
    const candidates = stablePrioritize(list.candidates);
    return candidates === list.candidates
      ? list
      : Object.freeze({ ...list, candidates });
  });
  const hits = stablePrioritize(result.hits);
  if (
    lists.every((list, index) => list === result.lists[index]) &&
    hits === result.hits
  ) {
    return result;
  }
  return Object.freeze({
    ...result,
    lists: Object.freeze(lists),
    hits,
  });
}

/**
 * Builds a source-only discovery view for a dialogue-evidence route.
 * Either side of a conversation may identify the right source, but no hit text
 * crosses this boundary. Exact assistant evidence is still admitted only by
 * the source-local locator, immutable hydrator, and semantic selector.
 */
export function buildDialogueSourceDiscoveryV1(
  result: MemoryEvidenceIndexSearchResultV1,
  primarySourceIds: readonly string[],
  addressBelongsToSource: MemoryEvidenceIndexV1["evidenceRefBelongsToSource"],
): MemoryEvidenceIndexSearchResultV1 {
  const primarySources = new Set(primarySourceIds);
  const ownsAddress =
    addressBelongsToSource ?? defaultEvidenceRefBelongsToSource;
  return Object.freeze({
    ...result,
    lists: Object.freeze(
      result.lists.flatMap((list) =>
        list.channel !== "l0"
          ? []
          : [
              Object.freeze({
                ...list,
                candidates: Object.freeze(
                  list.candidates.filter(
                    (candidate) =>
                      !primarySources.has(candidate.sourceId) &&
                      evidenceRefBelongsToSource(
                        ownsAddress,
                        candidate.sourceId,
                        candidate.evidenceRef,
                      ),
                  ),
                ),
              }),
            ],
      ),
    ),
    hits: Object.freeze([]),
  });
}

/** @deprecated Use the role-neutral source-only discovery primitive. */
export const buildCertifiedAssistantDialogueSourceDiscoveryV1 =
  buildDialogueSourceDiscoveryV1;

function evidenceRefBelongsToSource(
  ownsAddress: (sourceId: string, evidenceRef: string) => boolean,
  sourceId: string,
  evidenceRef: string,
): boolean {
  try {
    return ownsAddress(sourceId, evidenceRef) === true;
  } catch {
    return false;
  }
}

function defaultEvidenceRefBelongsToSource(
  sourceId: string,
  evidenceRef: string,
): boolean {
  return evidenceSourceIdV1(evidenceRef) === sourceId;
}

export function enforceSelectedEvidenceAuthority(input: {
  readonly assessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly candidateEvidenceRefs: ReadonlySet<string>;
  readonly candidateEvidenceRefsByRequirement: ReadonlyMap<
    string,
    ReadonlySet<string>
  >;
  readonly requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[];
  readonly roleConstraint: MemoryEvidenceQueryIntentV3["roleConstraint"];
  readonly certifiedSharedDialogueRefs: ReadonlySet<string>;
  readonly certifiedDialoguePredecessorsByAssistant: ReadonlyMap<
    string,
    string
  >;
  readonly certifiedAssistantDialogueCandidate: boolean;
}): readonly Readonly<MemoryEvidenceTriageAssessmentV1>[] {
  const requiredIds = new Set(
    input.requirements.map((requirement) => requirement.requirementId),
  );
  const requirementById = new Map(
    input.requirements.map((requirement) => [
      requirement.requirementId,
      requirement,
    ]),
  );
  if (
    requiredIds.size !== input.requirements.length ||
    input.assessments.length !== input.requirements.length
  ) {
    throw namedError("MemoryEvidenceSupportSelectionBoundaryInvalid");
  }
  const assessedIds = new Set<string>();
  const hitByRef = new Map(
    input.requirementHits.flat().map((hit) => [hit.evidenceRef, hit] as const),
  );
  return Object.freeze(
    input.assessments.map((assessment) => {
      if (
        !requiredIds.has(assessment.requirementId) ||
        assessedIds.has(assessment.requirementId) ||
        !Array.isArray(assessment.supportingEvidenceRefs) ||
        !Array.isArray(assessment.contradictingEvidenceRefs) ||
        !Array.isArray(assessment.unknownEvidenceRefs) ||
        // This field is host-only. A generic selector must not smuggle an
        // ordinal reader instruction through its otherwise model-owned DTO.
        assessment.dialogueOrdinalSelection !== undefined
      ) {
        throw namedError("MemoryEvidenceSupportSelectionBoundaryInvalid");
      }
      assessedIds.add(assessment.requirementId);
      const requirementRole = requirementById.get(
        assessment.requirementId,
      )?.roleConstraint;
      if (requirementRole === undefined) {
        throw namedError("MemoryEvidenceSupportSelectionBoundaryInvalid");
      }
      const partition = [
        ...assessment.supportingEvidenceRefs,
        ...assessment.contradictingEvidenceRefs,
        ...assessment.unknownEvidenceRefs,
      ];
      const scopedCandidateEvidenceRefs =
        input.candidateEvidenceRefsByRequirement.get(assessment.requirementId);
      if (
        scopedCandidateEvidenceRefs === undefined ||
        new Set(partition).size !== partition.length ||
        partition.some(
          (evidenceRef) =>
            typeof evidenceRef !== "string" ||
            !input.candidateEvidenceRefs.has(evidenceRef) ||
            !scopedCandidateEvidenceRefs.has(evidenceRef),
        )
      ) {
        throw namedError("MemoryEvidenceSupportSelectionBoundaryInvalid");
      }
      const selectedCertifiedAssistantRefs =
        assessment.supportingEvidenceRefs.filter((evidenceRef) =>
          input.certifiedSharedDialogueRefs.has(evidenceRef),
        );
      // A mixed-role `any` requirement may retrieve both the request and the
      // assistant's certified answer. Once answer-side evidence is selected,
      // user-authority turns in that same requirement are causal context, not
      // interchangeable answer evidence. Keep them in the assessed partition
      // as unknown so obligation coverage is computed from the answer side.
      const certifiedAssistantDominatesUserAuthority =
        requirementRole === "any" && selectedCertifiedAssistantRefs.length > 0;
      const proofOnlyPredecessorRefs = new Set(
        selectedCertifiedAssistantRefs.flatMap((evidenceRef) => {
          const predecessor =
            input.certifiedDialoguePredecessorsByAssistant.get(evidenceRef);
          return predecessor === undefined ? [] : [predecessor];
        }),
      );
      const rejected: Array<{
        evidenceRef: string;
        disposition: MemoryEvidenceDispositionV1;
      }> = [];
      const supporting = assessment.supportingEvidenceRefs.filter(
        (evidenceRef) => {
          const hit = hitByRef.get(evidenceRef);
          const allowed =
            hit !== undefined &&
            !proofOnlyPredecessorRefs.has(evidenceRef) &&
            (requirementRole === "assistant"
              ? hit.authority === "context_only" &&
                hit.sourceKind === "assistant_output"
              : (hit.authority !== "context_only" &&
                  !(
                    certifiedAssistantDominatesUserAuthority &&
                    (hit.authority === "user_asserted" ||
                      hit.authority === "user_confirmed_dialogue")
                  )) ||
                (requirementRole === "any" &&
                  input.certifiedSharedDialogueRefs.has(evidenceRef)) ||
                (input.certifiedAssistantDialogueCandidate &&
                  input.certifiedSharedDialogueRefs.has(evidenceRef)));
          if (!allowed) {
            rejected.push({
              evidenceRef,
              disposition: proofOnlyPredecessorRefs.has(evidenceRef)
                ? "causal_context"
                : certifiedAssistantDominatesUserAuthority &&
                    (hit?.authority === "user_asserted" ||
                      hit?.authority === "user_confirmed_dialogue")
                  ? "dominated_alternate"
                  : "role_ineligible",
            });
          }
          return allowed;
        },
      );
      const createDisposition = (
        evidenceRef: string,
        disposition: MemoryEvidenceDispositionV1,
      ): Readonly<MemoryEvidenceDispositionBindingV1> => {
        const hit = hitByRef.get(evidenceRef);
        const certified = input.certifiedSharedDialogueRefs.has(evidenceRef);
        const predecessor =
          input.certifiedDialoguePredecessorsByAssistant.get(evidenceRef);
        const evidenceUse = hit
          ? classifyMemoryEvidenceUseV1({
              roleConstraint: requirementRole,
              sourceKind: hit.sourceKind,
              authority: hit.authority,
              dialogueCertified: certified,
            })
          : undefined;
        return Object.freeze({
          requirementId: assessment.requirementId,
          evidenceRef,
          disposition,
          resolvedRole:
            hit?.sourceKind === "user_input"
              ? ("user" as const)
              : hit?.sourceKind === "assistant_output"
                ? ("assistant" as const)
                : ("unknown" as const),
          ...(evidenceUse === undefined ? {} : { evidenceUse }),
          ...(certified
            ? {
                certificateId: hashCanonicalJsonV1({
                  schemaVersion: "paw.memory-dialogue-certificate-id.v1",
                  assistantEvidenceRef: evidenceRef,
                  precedingUserEvidenceRef: predecessor ?? "unbound",
                }),
              }
            : {}),
          contextEvidenceRefs: Object.freeze([
            ...(hit?.contextEvidenceRefs ?? []),
          ]),
        });
      };
      return Object.freeze({
        requirementId: assessment.requirementId,
        supportingEvidenceRefs: Object.freeze(supporting),
        contradictingEvidenceRefs: Object.freeze([
          ...assessment.contradictingEvidenceRefs,
        ]),
        unknownEvidenceRefs: Object.freeze([...assessment.unknownEvidenceRefs]),
        evidenceDispositions: Object.freeze([
          ...supporting.map((evidenceRef) =>
            createDisposition(evidenceRef, "supporting"),
          ),
          ...assessment.contradictingEvidenceRefs.map((evidenceRef) =>
            createDisposition(evidenceRef, "contradicting"),
          ),
          ...assessment.unknownEvidenceRefs.map((evidenceRef) =>
            createDisposition(evidenceRef, "unknown_relevant"),
          ),
          ...rejected.map(({ evidenceRef, disposition }) =>
            createDisposition(evidenceRef, disposition),
          ),
        ]),
      });
    }),
  );
}
