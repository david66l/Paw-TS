import type {
  MemoryEvidenceRoleConstraintV3,
  MemoryEvidenceUseV1,
} from "./evidence-query-planner.js";

export type MemoryEvidencePresentationAnswerRoleV1 =
  | "current"
  | "ambiguous"
  | "supporting"
  | "candidate"
  | "mixed";

export function classifyMemoryEvidenceRefsUseV1(input: {
  readonly requirements: readonly Readonly<{
    requirementId: string;
    evidenceUse?: MemoryEvidenceUseV1;
  }>[];
  readonly coverage: readonly Readonly<{
    requirementId: string;
    selectedEvidenceRefs: readonly string[];
  }>[];
  readonly evidenceRefs: readonly string[];
}): MemoryEvidenceUseV1 {
  const refs = new Set(input.evidenceRefs);
  const reportedRequirementIds = new Set(
    input.requirements
      .filter(
        (requirement) =>
          requirement.evidenceUse === "reported_assistant_assertion",
      )
      .map((requirement) => requirement.requirementId),
  );
  const reported = input.coverage.some(
    (item) =>
      reportedRequirementIds.has(item.requirementId) &&
      item.selectedEvidenceRefs.some((evidenceRef) => refs.has(evidenceRef)),
  );
  return reported ? "reported_assistant_assertion" : "fact";
}

/**
 * Render the authority boundary attached to model-visible evidence. Evidence
 * use takes precedence over conversational role so a reported assistant
 * statement can never be presented as a user-grounded fact.
 */
export function renderMemoryEvidenceAuthorityHeaderV1(input: {
  readonly evidenceUse: MemoryEvidenceUseV1;
  readonly roleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly answerRole: MemoryEvidencePresentationAnswerRoleV1;
}): string {
  if (input.evidenceUse === "reported_assistant_assertion") {
    return "[Reported assistant assertion]\nAuthority rule: this proves only what the assistant previously stated; do not present the underlying claim as an independently verified user, shared, third-party, or world fact.";
  }
  if (input.roleConstraint === "assistant") {
    return "[Assistant-output evidence]\nAuthority rule: use only to recall the assistant's prior output or action; never as a user fact.";
  }
  if (input.roleConstraint === "any") {
    return "[Shared-dialogue evidence]\nAuthority rule: assistant output may answer only a directly requested shared artifact or prior answer whose neighboring user request establishes its provenance; never treat it as a user fact.";
  }
  if (input.answerRole === "current") {
    return "[Current user-grounded evidence]";
  }
  if (input.answerRole === "ambiguous") {
    return "[Ambiguous user-grounded evidence]";
  }
  if (input.answerRole === "candidate") {
    return "[Unverified candidate L0 evidence]\nUse only if it directly answers a missing requirement; relevance alone is not support.";
  }
  if (input.answerRole === "mixed") {
    return "[Mixed verified and candidate L0 evidence]\nRequirement-bound evidence is followed by bounded candidates; verify candidate text before use.";
  }
  return "[Supporting user-grounded evidence]";
}
