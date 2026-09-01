import { describe, expect, test } from "bun:test";
import { compileMemoryEvidenceSelectorGroupsV1 } from "../src/evidence-selector-groups.js";

const intent = {
  answerShape: "aggregate" as const,
  temporalMode: "history" as const,
  roleConstraint: "user" as const,
  needsPlanning: true,
};

const requirement = (input: {
  id: string;
  dependency?: "independent" | "depends_on" | "responds_to";
  dependsOn?: readonly string[];
  relation?: "direct" | "comparative";
  coverageMode?: "any" | "convergent";
}) => ({
  requirementId: input.id,
  label: input.id,
  searchText: input.id,
  temporalMode: "history" as const,
  roleConstraint:
    input.dependency === "responds_to"
      ? ("assistant" as const)
      : ("user" as const),
  relation: input.relation ?? ("direct" as const),
  coverageMode: input.coverageMode ?? ("any" as const),
  minimumEvidence: 1,
  dependencyRelation: input.dependency ?? ("independent" as const),
  dependsOnRequirementIds: input.dependsOn ?? Object.freeze([]),
});

describe("evidence selector transaction groups", () => {
  test("keeps independent leaves in deterministic groups", () => {
    const groups = compileMemoryEvidenceSelectorGroupsV1({
      intent,
      requirements: [requirement({ id: "a" }), requirement({ id: "b" })],
    });
    expect(groups.map((group) => group.requirementIds)).toEqual([
      ["a"],
      ["b"],
    ]);
    expect(groups[0]?.groupId).not.toBe(groups[1]?.groupId);
  });

  test("makes dependency-connected dialogue leaves atomic", () => {
    const groups = compileMemoryEvidenceSelectorGroupsV1({
      intent: { ...intent, roleConstraint: "any" },
      requirements: [
        requirement({ id: "request" }),
        requirement({
          id: "response",
          dependency: "responds_to",
          dependsOn: ["request"],
        }),
        requirement({ id: "independent" }),
      ],
    });
    expect(groups.map((group) => group.requirementIds)).toEqual([
      ["request", "response"],
      ["independent"],
    ]);
  });

  test("keeps independent comparative and convergent leaves separable but legacy plans atomic", () => {
    const comparative = compileMemoryEvidenceSelectorGroupsV1({
      intent,
      requirements: [
        requirement({ id: "a", relation: "comparative" }),
        requirement({ id: "b" }),
      ],
    });
    const convergent = compileMemoryEvidenceSelectorGroupsV1({
      intent,
      requirements: [
        requirement({ id: "a", coverageMode: "convergent" }),
        requirement({ id: "b" }),
      ],
    });
    const legacy = compileMemoryEvidenceSelectorGroupsV1({
      intent,
      requirements: [
        { ...requirement({ id: "a" }), dependencyRelation: undefined },
        { ...requirement({ id: "b" }), dependencyRelation: undefined },
      ],
    });
    const recommendation = compileMemoryEvidenceSelectorGroupsV1({
      intent: { ...intent, answerShape: "recommend" },
      requirements: [requirement({ id: "a" }), requirement({ id: "b" })],
    });
    expect(comparative).toHaveLength(2);
    expect(convergent).toHaveLength(2);
    expect(legacy).toHaveLength(1);
    expect(recommendation).toHaveLength(1);
  });

  test("fails closed for malformed dependency references", () => {
    expect(() =>
      compileMemoryEvidenceSelectorGroupsV1({
        intent,
        requirements: [
          requirement({
            id: "a",
            dependency: "depends_on",
            dependsOn: ["missing"],
          }),
        ],
      }),
    ).toThrow("MemoryEvidenceSelectorGroupInputInvalid");
  });
});
