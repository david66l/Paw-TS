import { describe, expect, test } from "bun:test";

import type { MemoryEntry } from "@paw/memory/longterm";

import {
  type MemoryFacetQueryPlannerEventV2,
  type MemoryFacetQueryPlanningInputV2,
  type PawNextMemoryScopeV1,
  buildMemoryFacetQueryRequestV2,
  createJsonMemoryFacetQueryPlannerV2,
  createMemoryFacetMembershipV2,
  createMemoryFacetV2,
  parseMemoryFacetQueryPlanV2,
  projectMemoryFacetStateV2,
  selectMemoryFacetQueryEvidenceV2,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("facet v2 ask-time query path", () => {
  test("keeps routing instructions stable and selects exact facet identity", () => {
    const setup = querySetup();
    const first = buildMemoryFacetQueryRequestV2(setup.input);
    const second = buildMemoryFacetQueryRequestV2({
      ...setup.input,
      query: "How did this change?",
    });
    expect(first.system).toBe(second.system);
    expect(first.system).toContain(
      "For a recommendation or decision, select the smallest set",
    );
    expect(first.system).toContain(
      "decision for a recommendation, plan, or choice",
    );
    expect(first.system).toContain("Do not select an umbrella facet");
    const plan = parseMemoryFacetQueryPlanV2(
      JSON.stringify({
        view: "current",
        facetIds: [setup.projection.facet.id],
        confidence: 0.95,
      }),
      setup.input,
    );
    expect(plan).toMatchObject({
      view: "current",
      facetIds: [setup.projection.facet.id],
    });
  });

  test("keeps historical contradiction out of a current-state read", () => {
    const setup = querySetup();
    const currentPlan = parseMemoryFacetQueryPlanV2(
      JSON.stringify({
        view: "current",
        facetIds: [setup.projection.facet.id],
        confidence: 0.95,
      }),
      setup.input,
    );
    const current = selectMemoryFacetQueryEvidenceV2({
      query: setup.input.query,
      plan: currentPlan,
      projections: [setup.projection],
      maxEvidence: 8,
      maxChars: 4_000,
    });
    expect(current.evidence.map((item) => item.state.memoryId)).toEqual([
      "current-participation",
    ]);

    const timelinePlan = parseMemoryFacetQueryPlanV2(
      JSON.stringify({
        view: "timeline",
        facetIds: [setup.projection.facet.id],
        confidence: 0.95,
      }),
      setup.input,
    );
    const timeline = selectMemoryFacetQueryEvidenceV2({
      query: setup.input.query,
      plan: timelinePlan,
      projections: [setup.projection],
      maxEvidence: 8,
      maxChars: 4_000,
    });
    expect(timeline.evidence.map((item) => item.state.memoryId)).toEqual([
      "current-participation",
      "old-avoidance",
    ]);
  });

  test("ranks concrete episodes ahead of broad states for recollection", () => {
    const setup = recollectionSetup();
    const plan = parseMemoryFacetQueryPlanV2(
      JSON.stringify({
        view: "recollection",
        facetIds: [setup.projection.facet.id],
        confidence: 0.9,
      }),
      setup.input,
    );
    const selection = selectMemoryFacetQueryEvidenceV2({
      query: setup.input.query,
      plan,
      projections: [setup.projection],
      maxEvidence: 2,
      maxChars: 4_000,
    });
    expect(selection.evidence.map((item) => item.state.memoryId)).toEqual([
      "surface-level-club",
      "general-film-preference",
    ]);
    expect(selection.view).toBe("recollection");
  });

  test("includes relevant experiences when planning a decision", () => {
    const setup = recollectionSetup();
    const plan = parseMemoryFacetQueryPlanV2(
      JSON.stringify({
        view: "decision",
        facetIds: [setup.projection.facet.id],
        confidence: 0.9,
      }),
      setup.input,
    );
    const selection = selectMemoryFacetQueryEvidenceV2({
      query: "How should I engage with a film discussion club?",
      plan,
      projections: [setup.projection],
      maxEvidence: 2,
      maxChars: 4_000,
    });
    expect(selection.evidence.map((item) => item.state.memoryId)).toEqual([
      "surface-level-club",
      "general-film-preference",
    ]);
    expect(selection.evidence[0]?.bucket).toBe("event");
  });

  test("repairs an invented facet ID and emits content-free telemetry", async () => {
    const setup = querySetup();
    const events: MemoryFacetQueryPlannerEventV2[] = [];
    const responses = [
      JSON.stringify({
        view: "current",
        facetIds: ["invented-facet"],
        confidence: 0.9,
      }),
      JSON.stringify({
        view: "current",
        facetIds: [setup.projection.facet.id],
        confidence: 0.9,
      }),
    ];
    const planner = createJsonMemoryFacetQueryPlannerV2({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: required(responses.shift()),
          };
        },
      },
      onEvent: (event) => events.push(event),
      now: () => 10,
    });
    const plan = await planner.plan(setup.input, new AbortController().signal);
    expect(plan.facetIds).toEqual([setup.projection.facet.id]);
    expect(events).toEqual([
      expect.objectContaining({ type: "completed", repaired: true }),
    ]);
    expect(JSON.stringify(events)).not.toContain("investment");
  });
});

function querySetup() {
  const facet = createMemoryFacetV2({
    scope,
    canonicalKey: "investment.community_participation",
    displayName: "Investment community participation",
    aliases: ["investment forum", "investment community"],
  });
  const entries = [
    profile(
      "old-avoidance",
      "2025-01-01T00:00:00.000Z",
      "Malia avoided stressful investment communities.",
    ),
    semantic(
      "current-participation",
      "2025-02-01T00:00:00.000Z",
      "Malia participates in a supportive investment community.",
    ),
  ];
  const projection = projectMemoryFacetStateV2({
    facet,
    memberships: [
      createMemoryFacetMembershipV2({
        facetId: facet.id,
        memoryId: "old-avoidance",
        role: "state",
        linkKind: "initial",
        confidence: 0.95,
      }),
      createMemoryFacetMembershipV2({
        facetId: facet.id,
        memoryId: "current-participation",
        role: "state",
        linkKind: "state_change",
        targetMemoryIds: ["old-avoidance"],
        confidence: 0.95,
      }),
    ],
    entries,
  });
  const input: MemoryFacetQueryPlanningInputV2 = {
    query: "Does Malia currently participate in an investment community?",
    snapshotRevision: "snapshot-revision-1",
    facets: [projection],
    maxSelectedFacets: 2,
  };
  return { projection, input };
}

function recollectionSetup() {
  const facet = createMemoryFacetV2({
    scope,
    canonicalKey: "film.discussion",
    displayName: "Film discussion",
    aliases: ["movie club"],
  });
  const entries = [
    profile(
      "general-film-preference",
      "2025-02-01T00:00:00.000Z",
      "User likes films and thoughtful cultural activities.",
    ),
    episodic(
      "surface-level-club",
      "2025-01-01T00:00:00.000Z",
      "User attended a film discussion club but found the conversation surface-level.",
    ),
  ];
  const projection = projectMemoryFacetStateV2({
    facet,
    memberships: [
      createMemoryFacetMembershipV2({
        facetId: facet.id,
        memoryId: "general-film-preference",
        role: "state",
        linkKind: "initial",
        confidence: 0.9,
      }),
      createMemoryFacetMembershipV2({
        facetId: facet.id,
        memoryId: "surface-level-club",
        role: "event",
        linkKind: "supports",
        targetMemoryIds: ["general-film-preference"],
        confidence: 0.9,
      }),
    ],
    entries,
  });
  const input: MemoryFacetQueryPlanningInputV2 = {
    query: "I spent time at a film discussion club the other day.",
    snapshotRevision: "snapshot-recollection-1",
    facets: [projection],
    maxSelectedFacets: 2,
  };
  return { projection, input };
}

function common(id: string, tValid: string) {
  return {
    id,
    repo: scope.repositoryId,
    created: tValid,
    tValid,
    tInvalid: null,
    source: "user_statement" as const,
    confidence: 0.95,
    evidence: [`journal:run-1#${id}`],
    freq: 0,
    utility: 0,
  };
}

function profile(id: string, tValid: string, insight: string): MemoryEntry {
  return Object.freeze({
    ...common(id, tValid),
    kind: "profile",
    insight,
    supportCount: 1,
  });
}

function semantic(id: string, tValid: string, fact: string): MemoryEntry {
  return Object.freeze({
    ...common(id, tValid),
    kind: "semantic",
    fact,
    keywords: [],
    embeddingKey: fact,
  });
}

function episodic(
  id: string,
  tValid: string,
  perspective: string,
): MemoryEntry {
  return Object.freeze({
    ...common(id, tValid),
    kind: "episodic",
    perspective,
    whenToUse: "When recalling a specific experience.",
    modification: [],
    issueType: "memory_atom",
    taskId: "run-1",
  });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value missing");
  return value;
}
