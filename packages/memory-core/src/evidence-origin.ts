import type {
  MemoryConversationTurnKindV1,
  MemoryEvidenceAuthorityV2,
} from "./evidence-contracts.js";

/**
 * The semantic use permitted for one model-facing evidence item.
 *
 * This is deliberately distinct from authority. `assistant_report` describes
 * what the evidence may answer; it never upgrades assistant text into a user
 * assertion. Keeping the two axes separate lets dialogue recall remain useful
 * without weakening the user-fact boundary.
 */
export type MemoryEvidenceUseV1 =
  | "user_fact"
  | "assistant_report"
  | "shared_dialogue_artifact";

export type MemoryEvidenceOriginRoleV1 = "user" | "assistant" | "any";

export interface MemoryEvidenceBindingV1 {
  readonly evidenceRef: string;
  readonly evidenceUse: MemoryEvidenceUseV1;
}

export function classifyMemoryEvidenceUseV1(input: {
  readonly roleConstraint: MemoryEvidenceOriginRoleV1;
  readonly sourceKind?: MemoryConversationTurnKindV1;
  readonly authority: MemoryEvidenceAuthorityV2;
  /** Item-level proof that this exact ref passed the dialogue certificate. */
  readonly dialogueCertified?: boolean;
}): MemoryEvidenceUseV1 | undefined {
  if (input.sourceKind === "assistant_output") {
    if (input.roleConstraint === "assistant") return "assistant_report";
    if (
      (input.roleConstraint === "any" || input.roleConstraint === "user") &&
      input.dialogueCertified
    ) {
      return "shared_dialogue_artifact";
    }
    return undefined;
  }

  if (input.roleConstraint === "assistant") return undefined;
  if (input.roleConstraint === "any") return "shared_dialogue_artifact";
  if (
    input.authority === "user_asserted" ||
    input.authority === "user_confirmed_dialogue" ||
    input.authority === "mixed"
  ) {
    return "user_fact";
  }
  return undefined;
}

export function renderMemoryEvidencePacketContractV1(): string {
  return [
    "[Primary exact memory evidence]",
    "Trust each item's evidence_use and authority; assistant/shared evidence is never a user fact.",
  ].join("\n");
}
