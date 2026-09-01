export const PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3 =
  "paw.memory-evidence-query-planner.v14:leaf-temporal-envelope" as const;
export const PAW_MEMORY_EVIDENCE_MAX_DEFICIENCIES_V1 = 4;
export const PAW_MEMORY_EVIDENCE_TEMPORAL_CONSTRAINT_VERSION_V1 =
  "paw.memory-evidence-temporal-constraint.v1:query-bound" as const;
export const PAW_MEMORY_EVIDENCE_TEMPORAL_COMPATIBILITY_VERSION_V1 =
  "paw.memory-evidence-temporal-compatibility.v1:leaf-retrieval" as const;

export type MemoryEvidenceAnswerShapeV3 =
  "lookup" | "compare" | "aggregate" | "recommend";

export type MemoryEvidenceTemporalModeV3 =
  "any" | "latest" | "as_of" | "history" | "range";

export type MemoryEvidenceTemporalAnchorPolicyV1 =
  "none" | "query_cutoff" | "query_derived_anchor";
export type MemoryEvidenceTemporalIntervalPolicyV1 =
  | "unbounded"
  | "latest_at_or_before_cutoff"
  | "state_at_query_derived_anchor"
  | "history_through_cutoff"
  | "query_derived_range";

/**
 * Immutable, content-free temporal authority for one retrieval leaf. The
 * planner proposes only `mode`; it never supplies an absolute timestamp or
 * interval. Those values are bound later from the original query and the
 * trusted question cutoff.
 */
export interface MemoryEvidenceTemporalConstraintV1 {
  readonly constraintVersion: typeof PAW_MEMORY_EVIDENCE_TEMPORAL_CONSTRAINT_VERSION_V1;
  readonly compatibilityVersion: typeof PAW_MEMORY_EVIDENCE_TEMPORAL_COMPATIBILITY_VERSION_V1;
  readonly mode: MemoryEvidenceTemporalModeV3;
  readonly queryEnvelopeMode: MemoryEvidenceTemporalModeV3;
  readonly anchorPolicy: MemoryEvidenceTemporalAnchorPolicyV1;
  readonly intervalPolicy: MemoryEvidenceTemporalIntervalPolicyV1;
  readonly queryRevision: string;
  readonly constraintRevision: string;
}

export interface MemoryEvidenceTemporalIntervalV2 {
  /** Inclusive UTC lower bound. */
  readonly lower: string;
  /** Exclusive UTC upper bound. */
  readonly upper: string;
  readonly precision: "day" | "year";
}

export type MemoryEvidenceTemporalClockPolicyV2 =
  "event_required" | "event_then_observed_if_uniform";

export type MemoryEvidenceBoundTemporalWindowV2 =
  | Readonly<{
      kind: "unbounded";
      evidenceCutoff: string | null;
    }>
  | Readonly<{
      kind: "latest_before";
      cutoff: string | null;
      clockPolicy: MemoryEvidenceTemporalClockPolicyV2;
    }>
  | Readonly<{
      kind: "history_through";
      cutoff: string | null;
      clockPolicy: MemoryEvidenceTemporalClockPolicyV2;
    }>
  | Readonly<{
      kind: "as_of";
      anchor: MemoryEvidenceTemporalIntervalV2 | null;
      cutoff: string | null;
      inclusion: "through_end";
      clockPolicy: MemoryEvidenceTemporalClockPolicyV2;
    }>
  | Readonly<{
      kind: "range";
      interval: MemoryEvidenceTemporalIntervalV2 | null;
      cutoff: string | null;
      inclusion: "overlaps";
      clockPolicy: MemoryEvidenceTemporalClockPolicyV2;
    }>;

export interface MemoryEvidenceDurationRequestV1 {
  readonly basis: "calendar";
  readonly unit: "day" | "week" | "month" | "year" | "auto";
  /**
   * `between_evidence` requires two independently bound event endpoints.
   * `evidence_to_query_anchor` uses one event endpoint and the trusted query
   * cutoff bound by the host; the planner never authors that anchor.
   */
  readonly endpointPolicy: "between_evidence" | "evidence_to_query_anchor";
  /** Requirement grouping is retrieval-only; this contract closes the exact
   * endpoint set over the union of all bound operand claims. */
  readonly endpointContract:
    | Readonly<{
        kind: "distinct_evidence_pair";
        evidenceEndpointCount: 2;
        groupPolicy: "union_bound_operands";
        distinctness: "distinct_event_identity";
        ordering: "chronological" | "semantic_start_end_unbound";
      }>
    | Readonly<{
        kind: "evidence_to_host_anchor";
        evidenceEndpointCount: 1;
        groupPolicy: "union_bound_operands";
        anchorRevision: string;
      }>;
  readonly queryAnchor: string | null;
  readonly calendarTimeZone: "UTC";
  readonly requestRevision: string;
}

export interface MemoryEvidenceBoundTemporalConstraintV1 extends MemoryEvidenceTemporalConstraintV1 {
  readonly evidenceTimeUpperBound: string | null;
  readonly window: MemoryEvidenceBoundTemporalWindowV2;
  readonly durationRequest: MemoryEvidenceDurationRequestV1 | null;
  readonly bindingRevision: string;
}

export type MemoryEvidenceRoleConstraintV3 = "user" | "assistant" | "any";
export type MemoryEvidenceRequirementRoleV4 = Exclude<
  MemoryEvidenceRoleConstraintV3,
  "any"
>;
export type MemoryEvidenceRequirementDependencyV4 =
  "independent" | "depends_on" | "responds_to" | "supersedes";
export type MemoryEvidenceIntentAxisV1 =
  "answerShape" | "temporalMode" | "roleConstraint";
export type MemoryEvidenceIntentAxisAuthorityV1 = "fixed" | "semantic";

/** Code locks explicit cues; a planner may normalize only semantic fallbacks. */
export interface MemoryEvidenceIntentBoundaryV1 {
  readonly answerShape: MemoryEvidenceIntentAxisAuthorityV1;
  readonly temporalMode: MemoryEvidenceIntentAxisAuthorityV1;
  readonly roleConstraint: MemoryEvidenceIntentAxisAuthorityV1;
}
export type MemoryEvidenceRelationV3 =
  "direct" | "temporal" | "comparative" | "inferred";
export type MemoryEvidenceCoverageModeV3 =
  "any" | "all" | "latest" | "convergent";

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
  /** Optional for custom V3 planners; Paw's JSON planner always compiles it. */
  readonly temporalConstraint?: MemoryEvidenceTemporalConstraintV1;
  readonly roleConstraint: MemoryEvidenceRoleConstraintV3;
  /**
   * Evidence-grounded role alternatives for one semantic answer slot. This is
   * resolver-owned late-binding state, not permission to merge authorities.
   * The selector and exact dialogue certificate must commit one supporting
   * role before the slot can close.
   */
  readonly roleCandidates?: readonly MemoryEvidenceRequirementRoleV4[];
  readonly relation?: MemoryEvidenceRelationV3;
  readonly coverageMode?: MemoryEvidenceCoverageModeV3;
  readonly minimumEvidence?: number;
  /**
   * Optional V4 obligation-DAG metadata. Legacy/custom planners may omit it.
   * JSON planner output always emits the complete trio and concrete leaf roles.
   */
  readonly dependencyRelation?: MemoryEvidenceRequirementDependencyV4;
  readonly dependsOnRequirementIds?: readonly string[];
}

export interface MemoryEvidenceQueryPlanV3 extends MemoryEvidenceQueryIntentV3 {
  readonly plannerVersion: string;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
}

export type MemoryEvidencePlanningDeficiencyReasonV1 =
  | "missing_operand"
  | "missing_constraint"
  | "wrong_role"
  | "wrong_time"
  | "weak_support";

/**
 * A verifier reports only a reason code and, when applicable, the existing
 * requirement whose evidence is deficient. It cannot smuggle a new retrieval
 * query through free-form prose. The planner owns the complete replacement
 * plan and re-reads the original query to recover omitted answer slots.
 */
export interface MemoryEvidencePlanningDeficiencyV1 {
  readonly reason: MemoryEvidencePlanningDeficiencyReasonV1;
  readonly targetRequirementId: string | null;
}

export interface MemoryEvidenceQueryPlanRevisionV1 {
  readonly currentRequirements: readonly MemoryEvidenceRequirementV3[];
  readonly deficiencies: readonly MemoryEvidencePlanningDeficiencyV1[];
}

export interface MemoryEvidenceQueryPlanOptionsV3 {
  readonly force?: boolean;
  readonly revision?: MemoryEvidenceQueryPlanRevisionV1;
}

export interface MemoryEvidenceQueryPlannerV3 {
  /** Stable adapter-owned version; custom planners need not impersonate Paw's JSON planner. */
  readonly plannerVersion: string;
  plan(
    query: string,
    signal: AbortSignal,
    options?: MemoryEvidenceQueryPlanOptionsV3,
  ): Promise<MemoryEvidenceQueryPlanV3>;
}

/** Cheap deterministic gate; the model only expands complex or temporal requests. */
