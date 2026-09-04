import { describe, expect, test } from "bun:test";
import {
  authorizeMemoryQueryAnswerOriginMaterializationV1,
  compileMemoryQueryAnswerOriginV1,
  projectMemoryEvidenceQueryPlanForAnswerOriginV1,
  validateMemoryEvidenceQueryPlanOriginV1,
  validateMemoryQueryAnswerOriginAuthorizationV1,
} from "../src/query-answer-origin.js";

describe("typed immutable query answer origin v1", () => {
  test("classifies explicit and ordinary origins without using semantic as permission", () => {
    const ordinary = compileMemoryQueryAnswerOriginV1(
      "What color is the bicycle?",
    );
    expect(ordinary).toMatchObject({
      originKind: "ordinary_semantic",
      roleBoundary: "semantic",
    });
    expect(Object.isFrozen(ordinary)).toBe(true);
    expect(Object.isFrozen(ordinary.features)).toBe(true);

    expect(
      compileMemoryQueryAnswerOriginV1("Which city did I visit?").originKind,
    ).toBe("explicit_user");
    expect(
      compileMemoryQueryAnswerOriginV1("What did you recommend last time?")
        .originKind,
    ).toBe("explicit_assistant");
    expect(
      compileMemoryQueryAnswerOriginV1("What did we decide on?").originKind,
    ).toBe("explicit_shared");
  });

  test("opens an unowned dialogue artifact from joint structural cues", () => {
    const origin = compileMemoryQueryAnswerOriginV1(
      "Can you remember the earlier label for me?",
    );
    expect(origin).toMatchObject({
      originKind: "dialogue_artifact_unowned",
      features: {
        secondPersonCue: true,
        priorDialogueCue: true,
        recallActionCue: true,
        explicitUserAnswerAuthor: false,
        explicitAssistantAnswerAuthor: false,
        explicitSharedAnswerAuthor: false,
      },
    });
  });

  test("answer-clause authors override coarse participant mentions", () => {
    expect(
      compileMemoryQueryAnswerOriginV1("Can you remember what I said earlier?")
        .originKind,
    ).toBe("explicit_user");
    expect(
      compileMemoryQueryAnswerOriginV1(
        "Can you remember what you recommended earlier?",
      ).originKind,
    ).toBe("explicit_assistant");
    expect(
      compileMemoryQueryAnswerOriginV1(
        "Looking back at our previous game, what was the move you made after my last move?",
      ).originKind,
    ).toBe("explicit_assistant");
  });

  test("treats a plan as a proposal and rejects unauthorized role widening", () => {
    const assistantPlan = {
      plannerVersion: "test-planner.v1",
      answerShape: "lookup" as const,
      temporalMode: "any" as const,
      roleConstraint: "assistant" as const,
      needsPlanning: true,
      requirements: [
        {
          requirementId: "answer",
          label: "Prior answer",
          searchText: "prior answer",
          temporalMode: "any" as const,
          roleConstraint: "assistant" as const,
        },
      ],
    };
    expect(() =>
      validateMemoryEvidenceQueryPlanOriginV1({
        origin: compileMemoryQueryAnswerOriginV1("What color is the bicycle?"),
        plan: assistantPlan,
      }),
    ).toThrow("MemoryEvidenceQueryPlanOriginInvalid");
    expect(() =>
      validateMemoryEvidenceQueryPlanOriginV1({
        origin: compileMemoryQueryAnswerOriginV1(
          "Can you remember the earlier label for me?",
        ),
        plan: assistantPlan,
      }),
    ).not.toThrow();
  });

  test("aligns a confused explicit-assistant plan to concrete assistant capability leaves", () => {
    const plan = {
      plannerVersion: "test-planner.v1",
      answerShape: "lookup" as const,
      temporalMode: "any" as const,
      roleConstraint: "any" as const,
      needsPlanning: true,
      requirements: [
        {
          requirementId: "claimed-answer",
          label: "claimed answer",
          searchText: "what you said",
          temporalMode: "any" as const,
          roleConstraint: "any" as const,
          roleCandidates: ["user", "assistant"] as const,
        },
        {
          requirementId: "user-context",
          label: "user context",
          searchText: "my earlier request",
          temporalMode: "any" as const,
          roleConstraint: "user" as const,
          roleCandidates: ["user", "assistant"] as const,
        },
      ],
    };
    const projected = projectMemoryEvidenceQueryPlanForAnswerOriginV1({
      origin: compileMemoryQueryAnswerOriginV1(
        "What did you say in our earlier conversation?",
      ),
      plan,
    });
    expect(projected).not.toBe(plan);
    expect(projected).toMatchObject({ roleConstraint: "any" });
    expect(projected.requirements).toEqual([
      expect.objectContaining({
        requirementId: "claimed-answer",
        roleConstraint: "assistant",
        roleCandidates: ["assistant"],
      }),
      expect.objectContaining({
        requirementId: "user-context",
        roleConstraint: "user",
        roleCandidates: ["user"],
      }),
    ]);
    expect(plan.requirements[0]?.roleCandidates).toEqual(["user", "assistant"]);
    expect(Object.isFrozen(projected.requirements)).toBe(true);
    expect(Object.isFrozen(projected.requirements[0] ?? {})).toBe(true);
  });

  test("does not project shared or unowned dialogue origins", () => {
    const plan = {
      plannerVersion: "test-planner.v1",
      answerShape: "lookup" as const,
      temporalMode: "any" as const,
      roleConstraint: "any" as const,
      needsPlanning: true,
      requirements: [
        {
          requirementId: "mixed",
          label: "mixed",
          searchText: "earlier dialogue",
          temporalMode: "any" as const,
          roleConstraint: "any" as const,
          roleCandidates: ["user", "assistant"] as const,
        },
      ],
    };
    for (const query of [
      "What did we decide on?",
      "Can you remember the earlier label for me?",
    ]) {
      expect(
        projectMemoryEvidenceQueryPlanForAnswerOriginV1({
          origin: compileMemoryQueryAnswerOriginV1(query),
          plan,
        }),
      ).toBe(plan);
    }
  });

  test("adds an assistant capability leaf without rewriting a user dependency", () => {
    const plan = {
      plannerVersion: "test-planner.v1",
      answerShape: "lookup" as const,
      temporalMode: "any" as const,
      roleConstraint: "user" as const,
      needsPlanning: true,
      requirements: [
        {
          requirementId: "user-context",
          label: "user context",
          searchText: "earlier request",
          temporalMode: "any" as const,
          roleConstraint: "user" as const,
        },
      ],
    };
    const projected = projectMemoryEvidenceQueryPlanForAnswerOriginV1({
      origin: compileMemoryQueryAnswerOriginV1(
        "What did you say in our earlier conversation?",
      ),
      plan,
    });
    expect(projected).toMatchObject({ roleConstraint: "any" });
    expect(projected.requirements).toEqual([
      expect.objectContaining({
        requirementId: "user-context",
        roleConstraint: "user",
        roleCandidates: ["user"],
      }),
      expect.objectContaining({
        requirementId: "origin_assistant_answer",
        roleConstraint: "assistant",
        roleCandidates: ["assistant"],
      }),
    ]);
  });

  test("binds and revalidates a source-local capability", () => {
    const query = "Can you remember the earlier label for me?";
    const origin = compileMemoryQueryAnswerOriginV1(query);
    const originalRequirement = {
      requirementId: "label",
      label: "Earlier label",
      searchText: "earlier label",
      temporalMode: "any" as const,
      roleConstraint: "user" as const,
    };
    const authorization = authorizeMemoryQueryAnswerOriginMaterializationV1({
      origin,
      requirement: originalRequirement,
      effectiveRequirementRole: "any",
      mode: "late_binding",
    });
    expect(authorization).toBeDefined();
    if (!authorization) {
      throw new Error("expected late-binding authorization");
    }
    expect(() =>
      validateMemoryQueryAnswerOriginAuthorizationV1({
        query,
        authorization,
        requirement: {
          ...originalRequirement,
          roleConstraint: "any" as const,
        },
        assistantDialogueCandidate: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateMemoryQueryAnswerOriginAuthorizationV1({
        query: "What color is the bicycle?",
        authorization,
        requirement: {
          ...originalRequirement,
          roleConstraint: "any" as const,
        },
        assistantDialogueCandidate: true,
      }),
    ).toThrow("MemorySourceLocalEvidenceAnswerOriginInvalid");
    expect(() =>
      validateMemoryQueryAnswerOriginAuthorizationV1({
        query,
        authorization,
        requirement: {
          ...originalRequirement,
          searchText: "different answer slot",
          roleConstraint: "any" as const,
        },
        assistantDialogueCandidate: true,
      }),
    ).toThrow("MemorySourceLocalEvidenceAnswerOriginInvalid");
  });
});
