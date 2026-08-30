import { hashCanonicalJsonV1 } from "./canonical.js";
import type { MemoryEvidenceNotebookHitV1 } from "./evidence-first.js";
import type { MemoryEvidenceQueryIntentV3 } from "./evidence-query-planner.js";
import type { MemoryEvidenceRequirementV3 } from "./evidence-query-planner.js";
import type { MemoryEvidenceResolutionV1 } from "./evidence-resolution-contracts.js";
import {
  enforceSelectedEvidenceAuthority,
  selectSupportCandidates,
} from "./evidence-resolver-helpers.js";
import type {
  MemoryEvidenceSupportSelectorV1,
  MemoryEvidenceTriageAssessmentV1,
} from "./evidence-support-selector.js";

export interface SupportSelectionStateV1 {
  readonly status: MemoryEvidenceResolutionV1["supportSelectorStatus"];
  readonly revision?: string;
  readonly assessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  readonly selectedRefsByRequirement: ReadonlyMap<string, ReadonlySet<string>>;
}

export async function selectEvidenceSupportV1(input: {
  readonly selector: MemoryEvidenceSupportSelectorV1;
  readonly query: string;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[];
  readonly selectedSourceIds: readonly string[];
  readonly roleConstraint: MemoryEvidenceQueryIntentV3["roleConstraint"];
  readonly certifiedAssistantDialogueCandidate: boolean;
  readonly localEvidenceRefs: ReadonlySet<string>;
  readonly signal: AbortSignal;
}): Promise<SupportSelectionStateV1> {
  const emptySelection = new Map(
    input.requirements.map((requirement) => [
      requirement.requirementId,
      new Set<string>(),
    ]),
  );
  const candidates = selectSupportCandidates(
    input.requirementHits,
    input.selectedSourceIds,
    input.roleConstraint !== "user" ||
      input.certifiedAssistantDialogueCandidate,
    32,
  );
  if (candidates.length === 0) {
    return Object.freeze({
      status: "fallback",
      assessments: Object.freeze([]),
      selectedRefsByRequirement: emptySelection,
    });
  }
  const selection = await input.selector.select(
    {
      query: input.query,
      requirements: input.requirements,
      candidates,
      ...(input.certifiedAssistantDialogueCandidate &&
      input.localEvidenceRefs.size > 0
        ? {
            certifiedAssistantDialogueEvidenceRefs: Object.freeze([
              ...input.localEvidenceRefs,
            ]),
          }
        : {}),
    },
    input.signal,
  );
  const assessments = enforceSelectedEvidenceAuthority({
    assessments: selection.assessments,
    requirements: input.requirements,
    candidateEvidenceRefs: new Set(
      candidates.map((candidate) => candidate.evidenceRef),
    ),
    requirementHits: input.requirementHits,
    roleConstraint: input.roleConstraint,
    certifiedSharedDialogueRefs: input.localEvidenceRefs,
    certifiedAssistantDialogueCandidate:
      input.certifiedAssistantDialogueCandidate,
  });
  return Object.freeze({
    status: "completed",
    revision: selection.selectionRevision,
    assessments,
    selectedRefsByRequirement: new Map(
      assessments.map((assessment) => [
        assessment.requirementId,
        new Set(assessment.supportingEvidenceRefs),
      ]),
    ),
  });
}

/** A repair may append support, but can never remove baseline evidence. */
export function mergeSupportSelectionsV1(
  baseline: SupportSelectionStateV1,
  repair: SupportSelectionStateV1,
): SupportSelectionStateV1 {
  const byRequirement = new Map(
    baseline.assessments.map((assessment) => [
      assessment.requirementId,
      assessment,
    ]),
  );
  for (const assessment of repair.assessments) {
    const existing = byRequirement.get(assessment.requirementId);
    byRequirement.set(
      assessment.requirementId,
      Object.freeze({
        requirementId: assessment.requirementId,
        supportingEvidenceRefs: Object.freeze([
          ...new Set([
            ...(existing?.supportingEvidenceRefs ?? []),
            ...assessment.supportingEvidenceRefs,
          ]),
        ]),
        contradictingEvidenceRefs: Object.freeze([
          ...new Set([
            ...(existing?.contradictingEvidenceRefs ?? []),
            ...assessment.contradictingEvidenceRefs,
          ]),
        ]),
        unknownEvidenceRefs: Object.freeze([
          ...new Set([
            ...(existing?.unknownEvidenceRefs ?? []),
            ...assessment.unknownEvidenceRefs,
          ]),
        ]),
      }),
    );
  }
  const selectedRefsByRequirement = new Map(baseline.selectedRefsByRequirement);
  for (const [requirementId, refs] of repair.selectedRefsByRequirement) {
    selectedRefsByRequirement.set(
      requirementId,
      new Set([
        ...(selectedRefsByRequirement.get(requirementId) ?? []),
        ...refs,
      ]),
    );
  }
  return Object.freeze({
    status: baseline.status,
    revision: hashCanonicalJsonV1({
      schemaVersion: "paw.memory-gap-fill-selection-revision.v1",
      baseline: baseline.revision ?? "fallback",
      repair: repair.revision ?? "fallback",
    }),
    assessments: Object.freeze([...byRequirement.values()]),
    selectedRefsByRequirement,
  });
}
