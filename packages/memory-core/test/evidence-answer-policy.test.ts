import { describe, expect, test } from "bun:test";

import { createMemoryEvidenceAnswerPolicyV1 } from "../src/evidence-answer-policy.js";

describe("evidence answer policy", () => {
  test("keeps a covered lookup direct", () => {
    expect(
      createMemoryEvidenceAnswerPolicyV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "user",
        requirementCount: 1,
        evidenceStatus: "sufficient",
      }),
    ).toMatchObject({
      mode: "direct",
      operations: ["bind_requirements", "enforce_role"],
    });
  });

  test("keeps provenance enforcement for ambiguous shared dialogue", () => {
    expect(
      createMemoryEvidenceAnswerPolicyV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "any",
        requirementCount: 1,
        evidenceStatus: "sufficient",
      }),
    ).toMatchObject({
      mode: "direct",
      operations: ["bind_requirements", "enforce_role"],
    });
  });

  test("frames a reported assistant assertion instead of promoting it to fact", () => {
    expect(
      createMemoryEvidenceAnswerPolicyV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "user",
        requirementCount: 1,
        evidenceStatus: "sufficient",
        reportedAssistantAssertionCount: 1,
      }),
    ).toMatchObject({
      mode: "synthesize",
      operations: [
        "bind_requirements",
        "enforce_role",
        "frame_reported_assistant_assertion",
      ],
    });
  });

  test("turns aggregate history into an explicit synthesis program", () => {
    expect(
      createMemoryEvidenceAnswerPolicyV1({
        answerShape: "aggregate",
        temporalMode: "history",
        roleConstraint: "user",
        requirementCount: 2,
        evidenceStatus: "partial",
      }).operations,
    ).toEqual([
      "bind_requirements",
      "enforce_role",
      "order_events",
      "deduplicate_entities",
    ]);
  });

  test("separates latest-state and preference operations", () => {
    expect(
      createMemoryEvidenceAnswerPolicyV1({
        answerShape: "recommend",
        temporalMode: "latest",
        roleConstraint: "user",
        requirementCount: 1,
        evidenceStatus: "sufficient",
      }),
    ).toMatchObject({
      mode: "synthesize",
      operations: [
        "bind_requirements",
        "enforce_role",
        "order_events",
        "resolve_latest",
        "infer_preferences",
      ],
    });
  });
});
