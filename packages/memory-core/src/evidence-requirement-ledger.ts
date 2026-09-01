import type { MemoryEvidenceNotebookV1 } from "./evidence-contracts.js";
import type { MemoryEvidenceRequirementV3 } from "./evidence-query-planner.js";
import type { MemoryEvidenceResolutionV1 } from "./evidence-resolution-contracts.js";
import type { MemoryEvidenceTriageAssessmentV1 } from "./evidence-support-selector.js";

/**
 * Preserves the resolver's exact requirement bindings at the answer boundary.
 * The packet is the visibility boundary: the ledger may never point at hidden
 * evidence, and only notebook-selected refs are allowed into verified support.
 */
export function buildMemoryEvidenceRequirementLedgerV1(input: {
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly assessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  readonly packetSources: MemoryEvidenceResolutionV1["packetSources"];
}): MemoryEvidenceResolutionV1["requirementEvidence"] {
  const visible = new Set(
    input.packetSources.flatMap((source) => source.evidenceRefs),
  );
  const coverageByRequirement = new Map(
    input.notebook.coverage.map((coverage) => [
      coverage.requirementId,
      coverage,
    ]),
  );
  const assessmentByRequirement = new Map(
    input.assessments.map((assessment) => [
      assessment.requirementId,
      assessment,
    ]),
  );
  return Object.freeze(
    input.requirements.map((requirement) => {
      const coverage = coverageByRequirement.get(requirement.requirementId);
      if (!coverage) {
        throw namedError("MemoryEvidenceRequirementLedgerShapeInvalid");
      }
      const assessment = assessmentByRequirement.get(requirement.requirementId);
      const supportingEvidenceRefs = visibleUniqueEvidenceRefs(
        coverage.selectedEvidenceRefs,
        visible,
      );
      const supporting = new Set(supportingEvidenceRefs);
      const contradictingEvidenceRefs = visibleUniqueEvidenceRefs(
        assessment?.contradictingEvidenceRefs ?? [],
        visible,
      ).filter((evidenceRef) => !supporting.has(evidenceRef));
      const contradicting = new Set(contradictingEvidenceRefs);
      const candidateEvidenceRefs = visibleUniqueEvidenceRefs(
        [
          ...coverage.unresolvedEvidenceRefs,
          ...(assessment?.unknownEvidenceRefs ?? []),
        ],
        visible,
      ).filter(
        (evidenceRef) =>
          !supporting.has(evidenceRef) && !contradicting.has(evidenceRef),
      );
      return Object.freeze({
        requirementId: requirement.requirementId,
        supportingEvidenceRefs: Object.freeze(supportingEvidenceRefs),
        candidateEvidenceRefs: Object.freeze(candidateEvidenceRefs),
        contradictingEvidenceRefs: Object.freeze(contradictingEvidenceRefs),
      });
    }),
  );
}

function visibleUniqueEvidenceRefs(
  evidenceRefs: readonly string[],
  visible: ReadonlySet<string>,
): string[] {
  return [...new Set(evidenceRefs)].filter((evidenceRef) =>
    visible.has(evidenceRef),
  );
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
