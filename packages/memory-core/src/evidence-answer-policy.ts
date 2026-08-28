import type {
  MemoryEvidenceAnswerShapeV3,
  MemoryEvidenceRoleConstraintV3,
  MemoryEvidenceTemporalModeV3,
} from "./evidence-query-planner.js";

export const PAW_MEMORY_EVIDENCE_ANSWER_POLICY_VERSION_V1 =
  "paw.memory-evidence-answer-policy.v2:reported-assistant-assertion" as const;

export type MemoryEvidenceAnswerOperationV1 =
  | "bind_requirements"
  | "enforce_role"
  | "order_events"
  | "resolve_latest"
  | "deduplicate_entities"
  | "compare_sides"
  | "infer_preferences"
  | "frame_reported_assistant_assertion";

export interface MemoryEvidenceAnswerPolicyV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_ANSWER_POLICY_VERSION_V1;
  readonly mode: "direct" | "synthesize";
  readonly operations: readonly MemoryEvidenceAnswerOperationV1[];
}

/**
 * Convert retrieval intent into a small, model-independent answer program.
 * The policy contains no memory facts, so hosts can cache it safely and apply
 * it with any answer model without coupling the memory core to an LLM SDK.
 */
export function createMemoryEvidenceAnswerPolicyV1(input: {
  readonly answerShape: MemoryEvidenceAnswerShapeV3;
  readonly temporalMode: MemoryEvidenceTemporalModeV3;
  readonly roleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly requirementCount: number;
  readonly evidenceStatus: "sufficient" | "partial" | "missing";
  readonly reportedAssistantAssertionCount?: number;
}): MemoryEvidenceAnswerPolicyV1 {
  const operations: MemoryEvidenceAnswerOperationV1[] = ["bind_requirements"];
  operations.push("enforce_role");
  if ((input.reportedAssistantAssertionCount ?? 0) > 0) {
    operations.push("frame_reported_assistant_assertion");
  }
  if (input.temporalMode !== "any") operations.push("order_events");
  if (input.temporalMode === "latest" || input.temporalMode === "as_of") {
    operations.push("resolve_latest");
  }
  if (input.answerShape === "aggregate") {
    operations.push("deduplicate_entities");
  } else if (input.answerShape === "compare") {
    operations.push("compare_sides");
  } else if (input.answerShape === "recommend") {
    operations.push("infer_preferences");
  }
  const requiresSynthesis =
    input.requirementCount > 1 ||
    input.evidenceStatus !== "sufficient" ||
    operations.some(
      (operation) =>
        operation !== "bind_requirements" && operation !== "enforce_role",
    );
  return Object.freeze({
    policyVersion: PAW_MEMORY_EVIDENCE_ANSWER_POLICY_VERSION_V1,
    mode: requiresSynthesis ? "synthesize" : "direct",
    operations: Object.freeze(operations),
  });
}
