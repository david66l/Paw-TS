import { describe, expect, test } from "bun:test";

import { parseMemoryEvidenceQueryPlanV3 } from "../src/json-query-planner.js";
import { memorySourceLocalEvidenceCacheKeyV1 } from "../src/source-local-evidence-locator.js";
import {
  bindMemoryEvidenceTemporalConstraintV1,
  compileMemoryEvidenceDurationRequestV1,
  compileMemoryEvidenceTemporalConstraintV1,
  memoryEvidenceLeafTemporalModeAllowedV1,
  validateMemoryEvidenceTemporalConstraintV1,
} from "../src/temporal-constraint.js";

describe("typed leaf temporal constraints v1", () => {
  test("accepts the sealed envelope-to-leaf retrieval operations", () => {
    const accepted = [
      ["any", "range"],
      ["any", "latest"],
      ["range", "any"],
      ["range", "as_of"],
      ["range", "latest"],
      ["latest", "range"],
      ["latest", "history"],
      ["latest", "as_of"],
    ] as const;
    for (const [envelope, leaf] of accepted) {
      expect(memoryEvidenceLeafTemporalModeAllowedV1(envelope, leaf)).toBe(
        true,
      );
    }
    expect(memoryEvidenceLeafTemporalModeAllowedV1("range", "history")).toBe(
      false,
    );
    expect(memoryEvidenceLeafTemporalModeAllowedV1("as_of", "latest")).toBe(
      false,
    );
  });

  test("binds a frozen leaf capability only to query text and trusted cutoff", () => {
    const query = "What was the latest status during that period?";
    const constraint = compileMemoryEvidenceTemporalConstraintV1({
      query,
      queryEnvelopeMode: "latest",
      leafMode: "as_of",
    });
    expect(Object.isFrozen(constraint)).toBe(true);
    expect(constraint.anchorPolicy).toBe("query_derived_anchor");
    expect(constraint).not.toHaveProperty("timestamp");
    const bound = bindMemoryEvidenceTemporalConstraintV1({
      query,
      queryEnvelopeMode: "latest",
      leafMode: "as_of",
      constraint,
      evidenceTimeUpperBound: "2025-04-03T12:30:00Z",
    });
    expect(bound.evidenceTimeUpperBound).toBe("2025-04-03T12:30:00.000Z");
    expect(bound.window).toMatchObject({
      kind: "as_of",
      anchor: null,
      cutoff: "2025-04-03T12:30:00.000Z",
    });
    expect(Object.isFrozen(bound)).toBe(true);
    expect(() =>
      validateMemoryEvidenceTemporalConstraintV1({
        query: "A different query",
        queryEnvelopeMode: "latest",
        leafMode: "as_of",
        constraint,
      }),
    ).toThrow("MemoryEvidenceTemporalConstraintInvalid");
  });

  test("host-binds explicit and relative windows without planner timestamps", () => {
    const explicit = bindMemoryEvidenceTemporalConstraintV1({
      query: "What was true as of March 4, 2024?",
      queryEnvelopeMode: "as_of",
      leafMode: "as_of",
      evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
    });
    expect(explicit.window).toMatchObject({
      kind: "as_of",
      anchor: {
        lower: "2024-03-04T00:00:00.000Z",
        upper: "2024-03-05T00:00:00.000Z",
      },
    });
    const relative = bindMemoryEvidenceTemporalConstraintV1({
      query: "What happened last week?",
      queryEnvelopeMode: "range",
      leafMode: "range",
      evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
    });
    expect(relative.window).toMatchObject({
      kind: "range",
      interval: {
        lower: "2024-12-25T00:00:00.000Z",
        upper: "2025-01-01T00:00:00.000Z",
      },
    });
    if (relative.window.kind !== "range") {
      throw new Error("relative range fixture invalid");
    }
    expect(relative.queryScopeInterval).toEqual(relative.window.interval);

    const plannerFallbackLeaf = bindMemoryEvidenceTemporalConstraintV1({
      query: "Who joined me last Saturday?",
      queryEnvelopeMode: "range",
      leafMode: "any",
      applyQueryScope: true,
      evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
    });
    expect(plannerFallbackLeaf.window.kind).toBe("unbounded");
    expect(plannerFallbackLeaf.queryScopeInterval).toMatchObject({
      lower: "2024-12-28T00:00:00.000Z",
      upper: "2024-12-29T00:00:00.000Z",
    });
    expect(plannerFallbackLeaf.bindingRevision).not.toBe(
      bindMemoryEvidenceTemporalConstraintV1({
        query: "Who joined me last Saturday?",
        queryEnvelopeMode: "range",
        leafMode: "any",
        applyQueryScope: true,
      }).bindingRevision,
    );

    const unscopedDependency = bindMemoryEvidenceTemporalConstraintV1({
      query: "Who joined me last Saturday?",
      queryEnvelopeMode: "range",
      leafMode: "any",
      evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
    });
    expect(unscopedDependency.queryScopeInterval).toBeNull();
  });

  test("fails closed on incompatible temporal clauses", () => {
    const relativeConflict = bindMemoryEvidenceTemporalConstraintV1({
      query: "Compare what happened last Friday and last Saturday.",
      queryEnvelopeMode: "range",
      leafMode: "range",
      evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
    });
    expect(relativeConflict.window).toMatchObject({
      kind: "range",
      interval: null,
    });

    const mixedConflict = bindMemoryEvidenceTemporalConstraintV1({
      query: "What happened last Saturday, March 4, 2024?",
      queryEnvelopeMode: "range",
      leafMode: "range",
      evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
    });
    expect(mixedConflict.window).toMatchObject({
      kind: "range",
      interval: null,
    });
  });

  test("separates duration intent from temporal range filtering", () => {
    expect(
      compileMemoryEvidenceDurationRequestV1(
        "How many days elapsed between the two events?",
      ),
    ).toMatchObject({
      basis: "calendar",
      unit: "day",
      endpointPolicy: "between_evidence",
      endpointContract: {
        kind: "distinct_evidence_pair",
        evidenceEndpointCount: 2,
        groupPolicy: "union_bound_operands",
        distinctness: "distinct_event_identity",
        ordering: "chronological",
      },
      queryAnchor: null,
      calendarTimeZone: "UTC",
    });
    expect(
      compileMemoryEvidenceDurationRequestV1(
        "How many days ago did the event happen?",
        "2025-01-01T00:00:00Z",
      ),
    ).toMatchObject({
      basis: "calendar",
      unit: "day",
      endpointPolicy: "evidence_to_query_anchor",
      endpointContract: {
        kind: "evidence_to_host_anchor",
        evidenceEndpointCount: 1,
        groupPolicy: "union_bound_operands",
      },
      queryAnchor: "2025-01-01T00:00:00.000Z",
      calendarTimeZone: "UTC",
    });
    expect(
      compileMemoryEvidenceDurationRequestV1("What happened last week?"),
    ).toBeNull();
    expect(
      compileMemoryEvidenceDurationRequestV1(
        "How many days did I spend camping across all trips?",
      ),
    ).toBeNull();
    expect(
      compileMemoryEvidenceDurationRequestV1(
        "How long did I take to finish both books combined?",
      ),
    ).toBeNull();
    expect(
      compileMemoryEvidenceDurationRequestV1(
        "How many weeks had I been taking classes when I bought the tools?",
      ),
    ).toMatchObject({ endpointPolicy: "between_evidence", unit: "week" });
    expect(
      compileMemoryEvidenceDurationRequestV1(
        "How many days elapsed from the later event to the earlier event?",
      ),
    ).toMatchObject({
      endpointContract: { ordering: "semantic_start_end_unbound" },
    });
  });

  test("compiles mixed temporal leaves under the query envelope", () => {
    const query = "What changed from the earlier point to the later point?";
    const plan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "lookup",
        temporalMode: "range",
        roleConstraint: "user",
        requirements: [
          requirement("first_snapshot", "as_of", "First snapshot"),
          requirement("later_state", "latest", "Later state"),
        ],
      }),
      query,
      {
        answerShape: "lookup",
        temporalMode: "range",
        roleConstraint: "user",
        needsPlanning: true,
      },
    );
    expect(plan.requirements.map((item) => item.requirementId)).toEqual([
      "first-snapshot",
      "later-state",
    ]);
    expect(
      plan.requirements.map((item) => item.temporalConstraint?.mode),
    ).toEqual(["as_of", "latest"]);
  });

  test("partitions source-local cache identity by leaf constraint revision", () => {
    const query = "What is the latest stored status?";
    const temporalConstraint = compileMemoryEvidenceTemporalConstraintV1({
      query,
      queryEnvelopeMode: "latest",
      leafMode: "latest",
    });
    const base = {
      locatorVersion: "locator-v1",
      scopeFingerprint: "scope-v1",
      turnIndexRevision: "turns-v1",
      adjacencyPolicyVersion: "adjacency-v1",
      rankerVersion: "ranker-v1",
    };
    const request = {
      requirement: {
        requirementId: "status",
        label: "Status",
        searchText: "latest stored status",
        temporalMode: "latest" as const,
        roleConstraint: "user" as const,
      },
      lockedSourceIds: ["source-1"],
      budget: {
        maxAnchors: 1,
        maxAnchorsPerSource: 1,
        neighborRadius: 0,
        maxCandidatesPerChannel: 1,
        maxChars: 512,
      },
    };
    const legacyKey = memorySourceLocalEvidenceCacheKeyV1({
      ...base,
      request,
    });
    const constrainedKey = memorySourceLocalEvidenceCacheKeyV1({
      ...base,
      request: {
        ...request,
        requirement: {
          ...request.requirement,
          temporalConstraint,
        },
      },
    });
    expect(constrainedKey).not.toBe(legacyKey);
  });

  test("canonicalizes model keys without merging semantic leaves", () => {
    const plan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          requirement("first_fact", "any", "Same evidence"),
          requirement("second_fact", "any", "Same evidence"),
        ],
      }),
      "Summarize the stored details.",
      {
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "user",
        needsPlanning: true,
      },
    );
    expect(plan.requirements.map((item) => item.requirementId)).toEqual([
      "first-fact",
      "second-fact",
    ]);
    expect(plan.requirements).toHaveLength(2);
  });

  test("resolves canonical dependencies and rejects collisions or dangling keys", () => {
    const intent = {
      answerShape: "lookup" as const,
      temporalMode: "any" as const,
      roleConstraint: "any" as const,
      needsPlanning: true,
    };
    const query = "Recall the earlier exchange.";
    const valid = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "any",
        requirements: [
          requirement("user_request", "any", "User request"),
          {
            ...requirement("assistant_answer", "any", "Assistant answer"),
            roleConstraint: "assistant",
            dependencyRelation: "responds_to",
            dependsOn: ["user_request"],
          },
        ],
      }),
      query,
      intent,
    );
    expect(valid.requirements[1]?.dependsOnRequirementIds).toEqual([
      "user-request",
    ]);

    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          answerShape: "lookup",
          temporalMode: "any",
          roleConstraint: "any",
          requirements: [
            requirement("same_key", "any", "First"),
            requirement("same-key", "any", "Second"),
          ],
        }),
        query,
        intent,
      ),
    ).toThrow("MemoryEvidenceQueryPlanRequirementKeyCollision");

    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          answerShape: "lookup",
          temporalMode: "any",
          roleConstraint: "any",
          requirements: [
            {
              ...requirement("assistant_answer", "any", "Assistant answer"),
              roleConstraint: "assistant",
              dependencyRelation: "responds_to",
              dependsOn: ["missing_key"],
            },
          ],
        }),
        query,
        intent,
      ),
    ).toThrow("MemoryEvidenceQueryPlanRequirementDependencyInvalid");
  });
});

function requirement(key: string, temporalMode: string, searchText: string) {
  return {
    key,
    label: searchText,
    searchText,
    temporalMode,
    roleConstraint: "user",
    relation: "temporal",
    coverageMode: "any",
    minimumEvidence: 1,
    dependencyRelation: "independent",
    dependsOn: [],
  };
}
