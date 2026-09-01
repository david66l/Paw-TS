import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./query-plan-contracts.js";

export const PAW_MEMORY_EVIDENCE_OBLIGATION_VERSION_V1 =
  "paw.memory-evidence-obligation.v1:structural-closure" as const;

export type MemoryEvidenceObligationReasonV1 =
  | "comparison_operands"
  | "calculation_operands"
  | "coordinated_slots"
  | "temporal_endpoints"
  | "longitudinal_evidence";

export interface MemoryEvidenceObligationShapeV1 {
  readonly obligationVersion: typeof PAW_MEMORY_EVIDENCE_OBLIGATION_VERSION_V1;
  /** Host-owned semantic scope; model leaves cannot grant contextual status. */
  readonly obligationKind: "answer_operands" | "personalization_context";
  /** Independent facts that must be bound separately by a valid model plan. */
  readonly minimumRequirementCount: number;
  /** Total distinct evidence items needed before structural closure is possible. */
  readonly minimumEvidenceCount: number;
  readonly reasonCodes: readonly MemoryEvidenceObligationReasonV1[];
}

/**
 * Compile only the structure of the proof demanded by the question. The
 * compiler never extracts entities, values, dates, or candidate answers; those
 * remain the planner's job. This makes the deterministic layer a validator of
 * model decomposition rather than a second semantic planner.
 */
export function compileMemoryEvidenceObligationShapeV1(
  query: string,
  intent: MemoryEvidenceQueryIntentV3,
): MemoryEvidenceObligationShapeV1 {
  const value = boundedQuery(query);
  const reasons: MemoryEvidenceObligationReasonV1[] = [];
  let minimumRequirementCount = intent.needsPlanning ? 1 : 0;
  let minimumEvidenceCount = minimumRequirementCount;

  if (intent.answerShape === "compare") {
    reasons.push("comparison_operands");
    minimumRequirementCount = Math.max(minimumRequirementCount, 2);
    minimumEvidenceCount = Math.max(minimumEvidenceCount, 2);
  }
  if (hasCalculationOperands(value)) {
    reasons.push("calculation_operands");
    minimumRequirementCount = Math.max(minimumRequirementCount, 2);
    minimumEvidenceCount = Math.max(minimumEvidenceCount, 2);
  }
  if (hasCoordinatedQuestionSlots(value)) {
    reasons.push("coordinated_slots");
    minimumRequirementCount = Math.max(minimumRequirementCount, 2);
    minimumEvidenceCount = Math.max(minimumEvidenceCount, 2);
  }
  if (hasExplicitTemporalEndpoints(value)) {
    reasons.push("temporal_endpoints");
    minimumRequirementCount = Math.max(minimumRequirementCount, 2);
    minimumEvidenceCount = Math.max(minimumEvidenceCount, 2);
  }
  if (hasLongitudinalDemand(value)) {
    reasons.push("longitudinal_evidence");
    minimumRequirementCount = Math.max(minimumRequirementCount, 1);
    minimumEvidenceCount = Math.max(minimumEvidenceCount, 2);
  }

  return Object.freeze({
    obligationVersion: PAW_MEMORY_EVIDENCE_OBLIGATION_VERSION_V1,
    obligationKind:
      intent.answerShape === "recommend"
        ? ("personalization_context" as const)
        : ("answer_operands" as const),
    minimumRequirementCount,
    minimumEvidenceCount,
    reasonCodes: Object.freeze(reasons),
  });
}

export function memoryEvidenceQueryHasMultipleObligationsV1(
  query: string,
): boolean {
  const value = boundedQuery(query);
  return (
    hasCalculationOperands(value) ||
    hasCoordinatedQuestionSlots(value) ||
    hasExplicitTemporalEndpoints(value) ||
    hasLongitudinalDemand(value)
  );
}

/** Validate that a model plan can satisfy the code-owned proof shape. */
export function validateMemoryEvidenceObligationsV1(
  shape: MemoryEvidenceObligationShapeV1,
  requirements: readonly MemoryEvidenceRequirementV3[],
): void {
  if (requirements.length < shape.minimumRequirementCount) {
    throw namedError("MemoryEvidenceQueryPlanUnderDecomposed");
  }
  const distinctSearches = new Set(
    requirements.map((requirement) => normalize(requirement.searchText)),
  );
  if (distinctSearches.size < shape.minimumRequirementCount) {
    throw namedError("MemoryEvidenceQueryPlanUnderDecomposed");
  }

  const collectiveEvidenceCount = requirements.reduce(
    (total, requirement) => total + (requirement.minimumEvidence ?? 1),
    0,
  );
  if (collectiveEvidenceCount < shape.minimumEvidenceCount) {
    throw namedError("MemoryEvidenceQueryPlanEvidenceFloorInvalid");
  }

  const reasonCodes = new Set(shape.reasonCodes);
  if (
    (reasonCodes.has("comparison_operands") ||
      reasonCodes.has("calculation_operands")) &&
    requirements.filter((requirement) => requirement.relation === "comparative")
      .length < shape.minimumRequirementCount
  ) {
    throw namedError("MemoryEvidenceQueryPlanOperandBindingInvalid");
  }
  if (
    reasonCodes.has("temporal_endpoints") &&
    requirements.filter(
      (requirement) =>
        requirement.relation === "temporal" ||
        requirement.relation === "comparative",
    ).length < 2
  ) {
    throw namedError("MemoryEvidenceQueryPlanTemporalBindingInvalid");
  }
  if (reasonCodes.has("longitudinal_evidence") && requirements.length === 1) {
    const [requirement] = requirements;
    if (
      requirement?.coverageMode !== "all" &&
      requirement?.coverageMode !== "convergent"
    ) {
      throw namedError("MemoryEvidenceQueryPlanLongitudinalCoverageInvalid");
    }
  }
}

function hasCalculationOperands(query: string): boolean {
  return /\b(?:what\s+percentage|percent(?:age)?\s+of|ratio\s+(?:of|between))\b|(?:百分之|百分比|比例|占.{0,24}(?:多少|比例|百分比))/iu.test(
    query,
  );
}

function hasCoordinatedQuestionSlots(query: string): boolean {
  return (
    /\b(?:what|which|where|when|who|how)\b.{0,96}\b(?:and|as\s+well\s+as)\s+(?:what|which|where|when|who|how)\b/iu.test(
      query,
    ) ||
    /\b(?:when\s+and\s+where|where\s+and\s+when|who\s+and\s+when|when\s+and\s+who)\b/iu.test(
      query,
    ) ||
    /(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁).{0,64}(?:以及|还有|并且|、).{0,16}(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁)/u.test(
      query,
    )
  );
}

function hasExplicitTemporalEndpoints(query: string): boolean {
  return (
    /\bbetween\b.{1,80}\band\b|\bfrom\b.{1,80}\bto\b/iu.test(query) ||
    /从.{1,48}到.{1,48}(?:多久|多长|差|变化)|(?:之间|前后).{0,32}(?:多久|多长|差多少)/u.test(
      query,
    )
  );
}

function hasLongitudinalDemand(query: string): boolean {
  return /\b(?:over\s+time|change(?:d|s)?\s+over|history\s+of|evolution\s+of|used\s+to.{0,64}(?:but|now))\b|(?:随时间|这些年|历年来|变化过程|演变过程|从前.{0,48}现在)/iu.test(
    query,
  );
}

function boundedQuery(query: string): string {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryEvidenceObligationQueryInvalid");
  }
  return value;
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
