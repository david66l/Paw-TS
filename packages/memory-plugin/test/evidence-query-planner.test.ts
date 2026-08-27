import { describe, expect, test } from "bun:test";

import {
  PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
  classifyMemoryEvidenceQueryV3,
  createJsonMemoryEvidenceQueryPlannerV3,
  parseMemoryEvidenceQueryPlanV3,
} from "../src/index.js";

describe("typed evidence query planner v3", () => {
  test("plans explicit prior-assistant recall instead of sending raw candidates", () => {
    expect(
      classifyMemoryEvidenceQueryV3(
        "What move did you make after 27. Kg2 Bd5+ in our previous game?",
      ),
    ).toEqual({
      answerShape: "lookup",
      temporalMode: "range",
      roleConstraint: "assistant",
      needsPlanning: true,
    });
  });
  test("opens recommendation planning for concrete personal evidence", () => {
    expect(
      classifyMemoryEvidenceQueryV3(
        "What should I serve for dinner this weekend with my homegrown ingredients?",
      ),
    ).toEqual({
      answerShape: "recommend",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: true,
    });
    expect(
      classifyMemoryEvidenceQueryV3("What did you recommend last time?"),
    ).toEqual({
      answerShape: "recommend",
      temporalMode: "any",
      roleConstraint: "assistant",
      needsPlanning: true,
    });
  });

  test("keeps simple lookup deterministic and model-free", async () => {
    let calls = 0;
    const planner = createJsonMemoryEvidenceQueryPlannerV3({
      model: {
        async complete() {
          calls += 1;
          return { status: "failed", errorCode: "unexpected" };
        },
      },
    });

    const plan = await planner.plan(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(plan).toEqual({
      plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: false,
      requirements: [],
    });
    expect(calls).toBe(0);
  });

  test("fails closed when a required model plan returns no requirements", async () => {
    const planner = createJsonMemoryEvidenceQueryPlannerV3({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: JSON.stringify({
              answerShape: "aggregate",
              temporalMode: "latest",
              roleConstraint: "user",
              requirements: [],
            }),
          };
        },
      },
    });

    await expect(
      planner.plan(
        "How many Instagram followers do I currently have?",
        new AbortController().signal,
      ),
    ).rejects.toThrow("MemoryEvidenceQueryPlanRequirementsEmpty");
  });

  test("accepts only bounded requirements for the classified operation", () => {
    const query = "Can you suggest some evening activities?";
    const plan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "recommend",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          {
            label: "sleep goals and evening constraints",
            searchText: "bedtime sleep screen time evening routine",
            relation: "inferred",
            coverageMode: "convergent",
            minimumEvidence: 2,
          },
        ],
      }),
      query,
    );
    expect(plan.requirements).toEqual([
      {
        requirementId: "requirement-1",
        label: "sleep goals and evening constraints",
        searchText: "bedtime sleep screen time evening routine",
        temporalMode: "any",
        roleConstraint: "user",
        relation: "inferred",
        coverageMode: "convergent",
        minimumEvidence: 2,
      },
    ]);
    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          answerShape: "lookup",
          temporalMode: "any",
          roleConstraint: "user",
          requirements: [],
        }),
        query,
      ),
    ).toThrow("MemoryEvidenceQueryPlanShapeInvalid");
    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          answerShape: "recommend",
          temporalMode: "any",
          roleConstraint: "user",
          requirements: [
            {
              label: "inferred preference",
              searchText: "repeated choices and reactions",
              relation: "inferred",
              coverageMode: "any",
              minimumEvidence: 1,
            },
          ],
        }),
        query,
      ),
    ).toThrow("MemoryEvidenceQueryPlanRequirementsInvalid");
  });

  test("keeps answer shape and recency as independent intent axes", () => {
    expect(
      classifyMemoryEvidenceQueryV3(
        "How many Instagram followers do I currently have?",
      ),
    ).toEqual({
      answerShape: "aggregate",
      temporalMode: "latest",
      roleConstraint: "user",
      needsPlanning: true,
    });
    expect(
      classifyMemoryEvidenceQueryV3(
        "What percentage of that property's price is the renovation cost on my current house?",
      ),
    ).toEqual({
      answerShape: "aggregate",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: true,
    });
  });

  test("classifies the same independent intent axes in Chinese", () => {
    expect(classifyMemoryEvidenceQueryV3("我目前一共有多少粉丝？")).toEqual({
      answerShape: "aggregate",
      temporalMode: "latest",
      roleConstraint: "user",
      needsPlanning: true,
    });
    expect(classifyMemoryEvidenceQueryV3("你上次推荐了什么？")).toEqual({
      answerShape: "recommend",
      temporalMode: "any",
      roleConstraint: "assistant",
      needsPlanning: true,
    });
    expect(
      classifyMemoryEvidenceQueryV3("我的旅行偏好这些年怎么变化的？"),
    ).toEqual({
      answerShape: "lookup",
      temporalMode: "history",
      roleConstraint: "user",
      needsPlanning: true,
    });
  });
});
