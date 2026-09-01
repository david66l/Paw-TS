import { describe, expect, test } from "bun:test";
import {
  compileMemoryEvidenceAggregateRequestV1,
  compileMemoryEvidenceExecutionProgramV1,
  compileMemoryEvidencePersonalizationRequestV1,
} from "../src/evidence-execution-program-v1.js";
import { compileMemoryEvidenceSelectorGroupsV1 } from "../src/evidence-selector-groups.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "../src/query-plan-contracts.js";
import { compileMemorySelectorExecutionSnapshotV1 } from "../src/selector-execution-snapshot-v1.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "../src/temporal-constraint.js";

const query = "Compare the latest values.";
const intent: MemoryEvidenceQueryIntentV3 = {
  answerShape: "compare",
  temporalMode: "latest",
  roleConstraint: "user",
  needsPlanning: true,
};
const requirements: readonly MemoryEvidenceRequirementV3[] = [
  {
    requirementId: "left",
    label: "left value",
    searchText: "left value",
    temporalMode: "latest",
    roleConstraint: "user",
    dependencyRelation: "independent",
    dependsOnRequirementIds: [],
  },
  {
    requirementId: "right",
    label: "right value",
    searchText: "right value",
    temporalMode: "latest",
    roleConstraint: "user",
    dependencyRelation: "independent",
    dependsOnRequirementIds: [],
  },
];
const temporalConstraints = requirements.map((requirement) =>
  bindMemoryEvidenceTemporalConstraintV1({
    query,
    queryEnvelopeMode: intent.temporalMode,
    leafMode: requirement.temporalMode,
  }),
);
const selectorGroups = compileMemoryEvidenceSelectorGroupsV1({
  intent,
  requirements,
});
const leftGroup = selectorGroups[0];
const rightGroup = selectorGroups[1];
if (!leftGroup || !rightGroup) throw new Error("fixture invalid");
const leftGroupId = leftGroup.groupId;
const leftRequirementIds = leftGroup.requirementIds;
const rightGroupId = rightGroup.groupId;
const rightRequirementIds = rightGroup.requirementIds;

function assessment(requirementId: string, evidenceRef: string) {
  return {
    requirementId,
    supportingEvidenceRefs: [evidenceRef],
    contradictingEvidenceRefs: [],
    unknownEvidenceRefs: [],
    evidenceDispositions: [
      {
        requirementId,
        evidenceRef,
        disposition: "supporting" as const,
        resolvedRole: "user" as const,
        evidenceUse: "user_fact" as const,
        contextEvidenceRefs: [],
      },
    ],
  };
}

function snapshot(rightStatus: "committed" | "failed") {
  return compileMemorySelectorExecutionSnapshotV1({
    query,
    intent,
    requirements,
    temporalConstraints,
    candidateScopes: [
      { requirementId: "left", evidenceRefs: ["ref-left"] },
      { requirementId: "right", evidenceRefs: ["ref-right"] },
    ],
    lockedSourceIds: ["source-left", "source-right"],
    originRevision: "origin-revision",
    selectorVersion: "selector-version",
    selectionRevision: "selection-revision",
    committedAttempt: "baseline",
    attemptCount: 1,
    groups: [
      {
        groupId: leftGroupId,
        requirementIds: leftRequirementIds,
        status: "committed",
        assessments: [assessment("left", "ref-left")],
      },
      {
        groupId: rightGroupId,
        requirementIds: rightRequirementIds,
        status: rightStatus,
        assessments:
          rightStatus === "committed" ? [assessment("right", "ref-right")] : [],
        ...(rightStatus === "failed"
          ? { failureCodes: ["SelectorGroupFailed"] }
          : {}),
      },
    ],
  });
}

describe("typed evidence execution program v1", () => {
  test("binds aggregate operation and unit to the original query", () => {
    expect(
      compileMemoryEvidenceAggregateRequestV1(
        "How many different museums did I visit?",
      ),
    ).toMatchObject({
      operator: "count",
      aggregationUnit: "semantic_value",
      countBasis: "enumerated_members",
    });
    expect(
      compileMemoryEvidenceAggregateRequestV1(
        "How many times did I attend an event?",
      ),
    ).toMatchObject({
      operator: "count",
      aggregationUnit: "event",
      countBasis: "enumerated_members",
    });
    expect(
      compileMemoryEvidenceAggregateRequestV1(
        "What was the total amount I spent?",
      ),
    ).toMatchObject({
      operator: "sum",
      aggregationUnit: "numeric_quantity",
      countBasis: null,
    });
    expect(
      compileMemoryEvidenceAggregateRequestV1("How many fish do I have?"),
    ).toMatchObject({
      operator: "count",
      aggregationUnit: "entity",
      countBasis: "stated_cardinality",
    });
    expect(
      compileMemoryEvidenceAggregateRequestV1(
        "What percentage of the total was mine?",
      ),
    ).toMatchObject({
      operator: "ratio_percent",
      aggregationUnit: "numeric_quantity",
    });
  });

  test("binds recommendation completion to one answer-scoped context bundle", () => {
    expect(
      compileMemoryEvidencePersonalizationRequestV1(
        "What would be a good option for me?",
      ),
    ).toMatchObject({
      scope: "answer_personalization",
      completionBasis: "bounded_context",
      minimumContextObservations: 1,
    });
  });

  test("compiles temporal leaves, comparison, and renderer as an ordered DAG", () => {
    const program = compileMemoryEvidenceExecutionProgramV1({
      query,
      intent,
      requirements,
      temporalConstraints,
      selectorSnapshot: snapshot("committed"),
    });

    expect(program.status).toBe("ready");
    expect(program.readyRequirementCount).toBe(2);
    expect(program.nodes.map((node) => node.operation)).toEqual([
      "read_requirement",
      "resolve_latest",
      "read_requirement",
      "resolve_latest",
      "compare_operands",
      "render_answer",
    ]);
    expect(program.nodes.every((node) => node.status === "ready")).toBe(true);
  });

  test("blocks all-operand synthesis when one selector group was unassessed", () => {
    const program = compileMemoryEvidenceExecutionProgramV1({
      query,
      intent,
      requirements,
      temporalConstraints,
      selectorSnapshot: snapshot("failed"),
    });

    expect(program.status).toBe("partial");
    expect(program.readyRequirementCount).toBe(1);
    expect(program.blockedRequirementCount).toBe(1);
    expect(
      program.nodes.find(
        (node) =>
          node.operation === "read_requirement" &&
          node.requirementId === "right",
      ),
    ).toMatchObject({
      status: "blocked",
      blockedReason: "unassessed_requirement",
      supportingEvidenceRefs: [],
    });
    expect(program.nodes.at(-1)).toMatchObject({
      operation: "render_answer",
      status: "blocked",
      blockedReason: "operand_blocked",
    });
  });
});
