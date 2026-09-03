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

function compileProgramFixture(input: {
  query: string;
  intent: MemoryEvidenceQueryIntentV3;
  requirements: readonly MemoryEvidenceRequirementV3[];
}) {
  const temporal = input.requirements.map((requirement) =>
    bindMemoryEvidenceTemporalConstraintV1({
      query: input.query,
      queryEnvelopeMode: input.intent.temporalMode,
      leafMode: requirement.temporalMode,
      evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
    }),
  );
  const groups = compileMemoryEvidenceSelectorGroupsV1({
    intent: input.intent,
    requirements: input.requirements,
  });
  const selectorSnapshot = compileMemorySelectorExecutionSnapshotV1({
    query: input.query,
    intent: input.intent,
    requirements: input.requirements,
    temporalConstraints: temporal,
    candidateScopes: input.requirements.map((requirement) => ({
      requirementId: requirement.requirementId,
      evidenceRefs: [`ref-${requirement.requirementId}`],
    })),
    lockedSourceIds: input.requirements.map(
      (requirement) => `source-${requirement.requirementId}`,
    ),
    originRevision: "origin-temporal-fixture",
    selectorVersion: "selector-temporal-fixture",
    selectionRevision: "selection-temporal-fixture",
    committedAttempt: "baseline",
    attemptCount: 1,
    groups: groups.map((group) => ({
      groupId: group.groupId,
      requirementIds: group.requirementIds,
      status: "committed" as const,
      assessments: group.requirementIds.map((requirementId) =>
        assessment(requirementId, `ref-${requirementId}`),
      ),
    })),
  });
  return compileMemoryEvidenceExecutionProgramV1({
    query: input.query,
    intent: input.intent,
    requirements: input.requirements,
    temporalConstraints: temporal,
    selectorSnapshot,
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

  test("separates bounded lookup from exhaustive range history", () => {
    const rangeQuery = "Who joined me last Saturday?";
    const rangeIntent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "range",
      roleConstraint: "user",
      needsPlanning: true,
    };
    const compile = (coverageMode: "any" | "all") => {
      const rangeRequirements: readonly MemoryEvidenceRequirementV3[] = [
        {
          requirementId: "companion",
          label: "companion",
          searchText: "joined companion",
          temporalMode: "range",
          roleConstraint: "user",
          coverageMode,
          minimumEvidence: 1,
          dependencyRelation: "independent",
          dependsOnRequirementIds: [],
        },
      ];
      const rangeTemporal = rangeRequirements.map((requirement) =>
        bindMemoryEvidenceTemporalConstraintV1({
          query: rangeQuery,
          queryEnvelopeMode: rangeIntent.temporalMode,
          leafMode: requirement.temporalMode,
          evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
        }),
      );
      const rangeGroup = compileMemoryEvidenceSelectorGroupsV1({
        intent: rangeIntent,
        requirements: rangeRequirements,
      })[0];
      if (!rangeGroup) throw new Error("range fixture invalid");
      const rangeSnapshot = compileMemorySelectorExecutionSnapshotV1({
        query: rangeQuery,
        intent: rangeIntent,
        requirements: rangeRequirements,
        temporalConstraints: rangeTemporal,
        candidateScopes: [
          { requirementId: "companion", evidenceRefs: ["ref-companion"] },
        ],
        lockedSourceIds: ["source-companion"],
        originRevision: "origin-range",
        selectorVersion: "selector-range",
        selectionRevision: "selection-range",
        committedAttempt: "baseline",
        attemptCount: 1,
        groups: [
          {
            groupId: rangeGroup.groupId,
            requirementIds: rangeGroup.requirementIds,
            status: "committed",
            assessments: [assessment("companion", "ref-companion")],
          },
        ],
      });
      return compileMemoryEvidenceExecutionProgramV1({
        query: rangeQuery,
        intent: rangeIntent,
        requirements: rangeRequirements,
        temporalConstraints: rangeTemporal,
        selectorSnapshot: rangeSnapshot,
      });
    };

    expect(compile("any").nodes.map((node) => node.operation)).toEqual([
      "read_requirement",
      "restrict_range",
      "collect_operands",
      "render_answer",
    ]);
    expect(compile("all").nodes.map((node) => node.operation)).toEqual([
      "read_requirement",
      "restrict_range",
      "preserve_history",
      "collect_operands",
      "render_answer",
    ]);
  });

  test("composes temporal scope with latest and history operations", () => {
    const baseRequirement = {
      roleConstraint: "user" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
      dependencyRelation: "independent" as const,
      dependsOnRequirementIds: [] as const,
    };
    const latest = compileProgramFixture({
      query: "What was my most recent update last week?",
      intent: {
        answerShape: "lookup",
        temporalMode: "latest",
        roleConstraint: "user",
        needsPlanning: true,
      },
      requirements: [
        {
          ...baseRequirement,
          requirementId: "update",
          label: "update",
          searchText: "most recent update",
          temporalMode: "latest",
        },
      ],
    });
    expect(latest.nodes.map((node) => node.operation)).toEqual([
      "read_requirement",
      "restrict_range",
      "resolve_latest",
      "collect_operands",
      "render_answer",
    ]);

    const history = compileProgramFixture({
      query: "List my visits in chronological order last month.",
      intent: {
        answerShape: "lookup",
        temporalMode: "history",
        roleConstraint: "user",
        needsPlanning: true,
      },
      requirements: [
        {
          ...baseRequirement,
          requirementId: "visits",
          label: "visits",
          searchText: "visits",
          temporalMode: "history",
        },
      ],
    });
    expect(history.nodes.map((node) => node.operation)).toEqual([
      "read_requirement",
      "restrict_range",
      "preserve_history",
      "collect_operands",
      "render_answer",
    ]);
  });

  test("does not project one bounded answer scope onto an any dependency leaf", () => {
    const program = compileProgramFixture({
      query: "Who joined me last Saturday and what invitation led to it?",
      intent: {
        answerShape: "lookup",
        temporalMode: "range",
        roleConstraint: "user",
        needsPlanning: true,
      },
      requirements: [
        {
          requirementId: "companion",
          label: "companion",
          searchText: "joined companion",
          temporalMode: "range",
          roleConstraint: "user",
          coverageMode: "any",
          minimumEvidence: 1,
          dependencyRelation: "independent",
          dependsOnRequirementIds: [],
        },
        {
          requirementId: "invitation",
          label: "invitation",
          searchText: "invitation",
          temporalMode: "any",
          roleConstraint: "user",
          coverageMode: "any",
          minimumEvidence: 1,
          dependencyRelation: "depends_on",
          dependsOnRequirementIds: ["companion"],
        },
      ],
    });
    expect(
      program.nodes.filter((node) => node.operation === "restrict_range"),
    ).toHaveLength(1);
  });
});
