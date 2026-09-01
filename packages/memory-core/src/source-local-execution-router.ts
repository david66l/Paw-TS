import { hashCanonicalJsonV1, type JsonValue } from "./canonical.js";
import type {
  MemoryEvidenceAnswerShapeV3,
  MemoryEvidenceRequirementV3,
  MemoryEvidenceRoleConstraintV3,
} from "./query-plan-contracts.js";

export const PAW_MEMORY_SOURCE_LOCAL_EXECUTION_ROUTER_VERSION_V1 =
  "paw.memory-source-local-execution-router.v1:mutually-exclusive-dual-executor" as const;

export type MemorySourceLocalExecutorV1 =
  | "per_leaf_v25"
  | "plan_scoped_v24"
  | "none";

export type MemorySourceLocalExecutionRouteReasonV1 =
  | "dialogue_or_origin_authorized"
  | "recommendation_operand_materialization"
  | "ordinary_user_plan_compatible"
  | "capability_unavailable";

export interface MemorySourceLocalExecutionRouteV1 {
  readonly routerVersion: typeof PAW_MEMORY_SOURCE_LOCAL_EXECUTION_ROUTER_VERSION_V1;
  readonly executor: MemorySourceLocalExecutorV1;
  readonly reasonCode: MemorySourceLocalExecutionRouteReasonV1;
  readonly requestProjection: "bound_leaf" | "original_plan" | "none";
  readonly transactionPolicy: "leaf_isolated" | "plan_atomic" | "baseline_only";
  readonly routeRevision: string;
}

/**
 * Chooses one source-local execution contract for the whole query. The two
 * locator coordinators are intentionally mutually exclusive: mixing their
 * request projections or transaction boundaries would change the selector's
 * address space inside one settlement.
 */
export function routeMemorySourceLocalExecutionV1(input: {
  readonly answerShape: MemoryEvidenceAnswerShapeV3;
  readonly roleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly certifiedAssistantDialogueCandidate: boolean;
  readonly legacyPlanEligible: boolean;
}): MemorySourceLocalExecutionRouteV1 {
  const dialogueOrOriginAuthorized =
    input.certifiedAssistantDialogueCandidate ||
    input.requirements.some((requirement) =>
      new Set(["assistant", "any"]).has(requirement.roleConstraint),
    );
  const recommendationOperandMaterialization =
    input.answerShape === "recommend" && input.roleConstraint === "user";
  const ordinaryUserPlan =
    input.roleConstraint === "user" &&
    input.requirements.every(
      (requirement) => requirement.roleConstraint === "user",
    );

  const decision = dialogueOrOriginAuthorized
    ? {
        executor: "per_leaf_v25" as const,
        reasonCode: "dialogue_or_origin_authorized" as const,
        requestProjection: "bound_leaf" as const,
        transactionPolicy: "leaf_isolated" as const,
      }
    : recommendationOperandMaterialization
      ? {
          executor: "per_leaf_v25" as const,
          reasonCode: "recommendation_operand_materialization" as const,
          requestProjection: "bound_leaf" as const,
          transactionPolicy: "leaf_isolated" as const,
        }
      : ordinaryUserPlan && input.legacyPlanEligible
        ? {
            executor: "plan_scoped_v24" as const,
            reasonCode: "ordinary_user_plan_compatible" as const,
            requestProjection: "original_plan" as const,
            transactionPolicy: "plan_atomic" as const,
          }
        : {
            executor: "none" as const,
            reasonCode: "capability_unavailable" as const,
            requestProjection: "none" as const,
            transactionPolicy: "baseline_only" as const,
          };
  const identity = {
    routerVersion: PAW_MEMORY_SOURCE_LOCAL_EXECUTION_ROUTER_VERSION_V1,
    answerShape: input.answerShape,
    roleConstraint: input.roleConstraint,
    certifiedAssistantDialogueCandidate:
      input.certifiedAssistantDialogueCandidate,
    legacyPlanEligible: input.legacyPlanEligible,
    requirements: input.requirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      temporalMode: requirement.temporalMode,
      roleConstraint: requirement.roleConstraint,
      relation: requirement.relation ?? "direct",
      coverageMode:
        requirement.coverageMode ??
        (requirement.temporalMode === "latest" ? "latest" : "any"),
      minimumEvidence: requirement.minimumEvidence ?? 1,
    })),
    ...decision,
  } as const;
  return Object.freeze({
    routerVersion: PAW_MEMORY_SOURCE_LOCAL_EXECUTION_ROUTER_VERSION_V1,
    ...decision,
    routeRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
}
