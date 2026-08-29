export const PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3 =
  "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate" as const;

export type MemoryEvidenceAnswerShapeV3 =
  | "lookup"
  | "compare"
  | "aggregate"
  | "recommend";

export type MemoryEvidenceTemporalModeV3 =
  | "any"
  | "latest"
  | "as_of"
  | "history"
  | "range";

export type MemoryEvidenceRoleConstraintV3 = "user" | "assistant" | "any";
export type MemoryEvidenceRelationV3 =
  | "direct"
  | "temporal"
  | "comparative"
  | "inferred";
export type MemoryEvidenceCoverageModeV3 =
  | "any"
  | "all"
  | "latest"
  | "convergent";

/**
 * Query intent is deliberately factored into independent axes. A question can
 * ask for an aggregate answer and the latest state at the same time; encoding
 * those as one mutually exclusive operation silently discards chronology.
 */
export interface MemoryEvidenceQueryIntentV3 {
  readonly answerShape: MemoryEvidenceAnswerShapeV3;
  readonly temporalMode: MemoryEvidenceTemporalModeV3;
  readonly roleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly needsPlanning: boolean;
}

export interface MemoryEvidenceRequirementV3 {
  readonly requirementId: string;
  readonly label: string;
  readonly searchText: string;
  readonly temporalMode: MemoryEvidenceTemporalModeV3;
  readonly roleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly relation?: MemoryEvidenceRelationV3;
  readonly coverageMode?: MemoryEvidenceCoverageModeV3;
  readonly minimumEvidence?: number;
}

export interface MemoryEvidenceQueryPlanV3 extends MemoryEvidenceQueryIntentV3 {
  readonly plannerVersion: typeof PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
}

export interface MemoryEvidenceQueryPlannerV3 {
  readonly plannerVersion: typeof PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3;
  plan(
    query: string,
    signal: AbortSignal,
    options?: Readonly<{ force?: boolean }>,
  ): Promise<MemoryEvidenceQueryPlanV3>;
}

/** Cheap deterministic gate; the model only expands complex or temporal requests. */
