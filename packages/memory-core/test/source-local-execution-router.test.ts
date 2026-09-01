import { describe, expect, test } from "bun:test";

import { routeMemorySourceLocalExecutionV1 } from "../src/source-local-execution-router.js";

const userRequirement = Object.freeze({
  requirementId: "user-fact",
  label: "user fact",
  searchText: "user fact",
  temporalMode: "history" as const,
  roleConstraint: "user" as const,
  relation: "temporal" as const,
  coverageMode: "all" as const,
  minimumEvidence: 2,
});

describe("source-local execution router v1", () => {
  test("routes dialogue and recommendation capabilities to typed per-leaf execution", () => {
    expect(
      routeMemorySourceLocalExecutionV1({
        answerShape: "lookup",
        roleConstraint: "user",
        requirements: [userRequirement],
        certifiedAssistantDialogueCandidate: true,
        legacyPlanEligible: true,
      }),
    ).toMatchObject({
      executor: "per_leaf_v25",
      reasonCode: "dialogue_or_origin_authorized",
      requestProjection: "bound_leaf",
      transactionPolicy: "leaf_isolated",
    });
    expect(
      routeMemorySourceLocalExecutionV1({
        answerShape: "lookup",
        roleConstraint: "any",
        requirements: [
          {
            ...userRequirement,
            requirementId: "assistant-answer",
            roleConstraint: "assistant",
          },
        ],
        certifiedAssistantDialogueCandidate: false,
        legacyPlanEligible: true,
      }).executor,
    ).toBe("per_leaf_v25");
    expect(
      routeMemorySourceLocalExecutionV1({
        answerShape: "recommend",
        roleConstraint: "user",
        requirements: [
          {
            ...userRequirement,
            temporalMode: "any",
            relation: "direct",
            coverageMode: "any",
            minimumEvidence: 1,
          },
        ],
        certifiedAssistantDialogueCandidate: false,
        legacyPlanEligible: true,
      }),
    ).toMatchObject({
      executor: "per_leaf_v25",
      reasonCode: "recommendation_operand_materialization",
    });
  });

  test("keeps ordinary user history on the compatible plan-scoped transaction", () => {
    const route = routeMemorySourceLocalExecutionV1({
      answerShape: "aggregate",
      roleConstraint: "user",
      requirements: [userRequirement],
      certifiedAssistantDialogueCandidate: false,
      legacyPlanEligible: true,
    });
    expect(route).toMatchObject({
      executor: "plan_scoped_v24",
      reasonCode: "ordinary_user_plan_compatible",
      requestProjection: "original_plan",
      transactionPolicy: "plan_atomic",
    });
  });

  test("fails closed instead of widening an incompatible ordinary plan", () => {
    const route = routeMemorySourceLocalExecutionV1({
      answerShape: "aggregate",
      roleConstraint: "user",
      requirements: [
        userRequirement,
        { ...userRequirement, requirementId: "incompatible-sibling" },
      ],
      certifiedAssistantDialogueCandidate: false,
      legacyPlanEligible: false,
    });
    expect(route).toMatchObject({
      executor: "none",
      reasonCode: "capability_unavailable",
      requestProjection: "none",
      transactionPolicy: "baseline_only",
    });
  });
});
