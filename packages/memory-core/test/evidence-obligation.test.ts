import { describe, expect, test } from "bun:test";
import {
  classifyMemoryEvidenceQueryV3,
  compileMemoryEvidenceObligationShapeV1,
  parseMemoryEvidenceQueryPlanV3,
  validateMemoryEvidenceObligationsV1,
} from "../src/legacy.js";

describe("structural evidence obligations v1", () => {
  test("requires independently bound operands for comparisons", () => {
    const query = "What is the difference between my old and current commute?";
    const intent = classifyMemoryEvidenceQueryV3(query);
    const shape = compileMemoryEvidenceObligationShapeV1(query, intent);

    expect(shape).toMatchObject({
      obligationKind: "answer_operands",
      minimumRequirementCount: 2,
      minimumEvidenceCount: 2,
    });
    expect(shape.reasonCodes).toContain("comparison_operands");

    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          answerShape: "compare",
          temporalMode: intent.temporalMode,
          roleConstraint: intent.roleConstraint,
          requirements: [
            {
              label: "commute",
              searchText: "old current commute",
              relation: "comparative",
              coverageMode: "any",
              minimumEvidence: 1,
            },
          ],
        }),
        query,
        intent,
      ),
    ).toThrow("MemoryEvidenceQueryPlanUnderDecomposed");
  });

  test("marks only new recommendation evidence as contextual discovery", () => {
    const query = "What should I cook based on what I already have?";
    const intent = classifyMemoryEvidenceQueryV3(query);
    expect(compileMemoryEvidenceObligationShapeV1(query, intent)).toMatchObject(
      {
        obligationKind: "personalization_context",
        minimumRequirementCount: 1,
      },
    );
    const recall = "What did you recommend last time?";
    expect(
      compileMemoryEvidenceObligationShapeV1(
        recall,
        classifyMemoryEvidenceQueryV3(recall),
      ).obligationKind,
    ).toBe("answer_operands");
  });

  test("accepts two distinct comparison operands", () => {
    const query = "What is the difference between my old and current commute?";
    const intent = classifyMemoryEvidenceQueryV3(query);
    const plan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "compare",
        temporalMode: intent.temporalMode,
        roleConstraint: intent.roleConstraint,
        requirements: [
          {
            label: "old commute",
            searchText: "old commute",
            relation: "comparative",
            coverageMode: "any",
            minimumEvidence: 1,
          },
          {
            label: "current commute",
            searchText: "current commute",
            relation: "comparative",
            coverageMode: "any",
            minimumEvidence: 1,
          },
        ],
      }),
      query,
      intent,
    );

    expect(() =>
      validateMemoryEvidenceObligationsV1(
        compileMemoryEvidenceObligationShapeV1(query, intent),
        plan.requirements,
      ),
    ).not.toThrow();
  });

  test("requires collective evidence for an evolution question", () => {
    const query = "How have my travel preferences changed over time?";
    const intent = classifyMemoryEvidenceQueryV3(query);
    const shape = compileMemoryEvidenceObligationShapeV1(query, intent);
    const requirement = {
      requirementId: "preference-history",
      label: "preference history",
      searchText: "travel preference changes",
      temporalMode: intent.temporalMode,
      roleConstraint: intent.roleConstraint,
      relation: "temporal" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    };

    expect(shape.reasonCodes).toContain("longitudinal_evidence");
    expect(() =>
      validateMemoryEvidenceObligationsV1(shape, [requirement]),
    ).toThrow("MemoryEvidenceQueryPlanEvidenceFloorInvalid");
    expect(() =>
      validateMemoryEvidenceObligationsV1(shape, [
        { ...requirement, coverageMode: "all", minimumEvidence: 2 },
      ]),
    ).not.toThrow();
  });

  test("opens planning for two explicitly coordinated answer slots", () => {
    const intent = classifyMemoryEvidenceQueryV3(
      "When and where did I meet the designer?",
    );
    expect(intent.needsPlanning).toBe(true);
    expect(
      compileMemoryEvidenceObligationShapeV1(
        "When and where did I meet the designer?",
        intent,
      ),
    ).toMatchObject({
      minimumRequirementCount: 2,
      minimumEvidenceCount: 2,
      reasonCodes: ["coordinated_slots"],
    });
  });
});
