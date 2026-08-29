import type { MemoryEvidenceNotebookHitV1 } from "./evidence-contracts.js";
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
  readonly requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[];
  readonly roleConstraint: MemoryEvidenceQueryIntentV3["roleConstraint"];
  readonly certifiedSharedDialogueRefs: ReadonlySet<string>;
  readonly certifiedAssistantDialogueCandidate: boolean;
}): readonly Readonly<MemoryEvidenceTriageAssessmentV1>[] {
  const requiredIds = new Set(
    input.requirements.map((requirement) => requirement.requirementId),
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
        !Array.isArray(assessment.unknownEvidenceRefs)
      ) {
        throw namedError("MemoryEvidenceSupportSelectionBoundaryInvalid");
      }
      assessedIds.add(assessment.requirementId);
      const partition = [
        ...assessment.supportingEvidenceRefs,
        ...assessment.contradictingEvidenceRefs,
        ...assessment.unknownEvidenceRefs,
      ];
      if (
        new Set(partition).size !== partition.length ||
        partition.some(
          (evidenceRef) =>
            typeof evidenceRef !== "string" ||
            !input.candidateEvidenceRefs.has(evidenceRef),
        )
      ) {
        throw namedError("MemoryEvidenceSupportSelectionBoundaryInvalid");
      }
      const rejected: string[] = [];
      const supporting = assessment.supportingEvidenceRefs.filter(
        (evidenceRef) => {
          const hit = hitByRef.get(evidenceRef);
          const allowed =
            hit !== undefined &&
            (hit.authority !== "context_only" ||
              input.roleConstraint === "assistant" ||
              (input.roleConstraint === "any" &&
                input.certifiedSharedDialogueRefs.has(evidenceRef)) ||
              (input.certifiedAssistantDialogueCandidate &&
                input.certifiedSharedDialogueRefs.has(evidenceRef)));
          if (!allowed) rejected.push(evidenceRef);
          return allowed;
        },
      );
      return Object.freeze({
        requirementId: assessment.requirementId,
        supportingEvidenceRefs: Object.freeze(supporting),
        contradictingEvidenceRefs: Object.freeze([
          ...assessment.contradictingEvidenceRefs,
        ]),
        unknownEvidenceRefs: Object.freeze([
          ...new Set([...assessment.unknownEvidenceRefs, ...rejected]),
        ]),
      });
    }),
  );
}
