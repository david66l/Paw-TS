import { describe, expect, test } from "bun:test";

import type { MemoryEntry } from "@paw/memory/longterm";

import {
  type MemoryFacetStateProjectorEventV2,
  type PawNextMemoryScopeV1,
  createMemoryFacetMembershipV2,
  createMemoryFacetV2,
  deriveMemoryFacetIdV2,
  isMemoryFacetSourceEntryV2,
  projectMemoryFacetStateV2,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("facet v2 state projection", () => {
  test("admits atomic profile bridges but rejects derived rollups", () => {
    expect(
      isMemoryFacetSourceEntryV2(
        profile(
          "atomic-profile",
          "2025-01-01T00:00:00.000Z",
          "User prefers concise film discussions.",
        ),
      ),
    ).toBe(true);
    expect(
      isMemoryFacetSourceEntryV2(
        profile(
          "rollup-profile",
          "2025-01-01T00:00:00.000Z",
          `User has many unrelated activities: ${"film, law, health, gardening, and finance; ".repeat(10)}`,
        ),
      ),
    ).toBe(false);
  });

  test("keeps immutable events while projecting a newer current state", () => {
    const facet = createMemoryFacetV2({
      scope,
      canonicalKey: "investment.community_participation",
      displayName: "Investment community participation",
      aliases: ["online investment forums", "Investment communities"],
    });
    const oldAvoidance = profile(
      "old-avoidance",
      "2025-01-01T00:00:00.000Z",
      "Malia avoided stressful investment communities.",
    );
    const rejectedForum = episode(
      "rejected-forum",
      "2025-01-02T00:00:00.000Z",
      "Malia skipped a competitive forum with tense discussion and heavy jargon.",
    );
    const joinedCommunity = episode(
      "joined-community",
      "2025-02-01T00:00:00.000Z",
      "Malia joined a welcoming online investment community and participated actively.",
    );
    const currentParticipation = profile(
      "current-participation",
      "2025-02-02T00:00:00.000Z",
      "Malia now participates in supportive investment communities.",
    );
    const supportiveCondition = semantic(
      "supportive-condition",
      "2025-02-02T00:00:00.000Z",
      "Participation works when discussion is welcoming and understandable.",
    );
    const memberships = [
      member(facet.id, oldAvoidance.id, "state", "initial"),
      member(facet.id, rejectedForum.id, "event", "initial"),
      member(facet.id, joinedCommunity.id, "event", "initial"),
      member(facet.id, currentParticipation.id, "state", "state_change", [
        oldAvoidance.id,
      ]),
      member(facet.id, supportiveCondition.id, "condition", "supports", [
        currentParticipation.id,
      ]),
    ];

    const projection = projectMemoryFacetStateV2({
      facet,
      memberships,
      entries: [
        supportiveCondition,
        joinedCommunity,
        currentParticipation,
        rejectedForum,
        oldAvoidance,
      ],
    });

    expect(projection.currentStates.map((item) => item.memoryId)).toEqual([
      "current-participation",
    ]);
    expect(projection.historicalStates.map((item) => item.memoryId)).toEqual([
      "old-avoidance",
    ]);
    expect(projection.events.map((item) => item.memoryId)).toEqual([
      "joined-community",
      "rejected-forum",
    ]);
    expect(projection.conditions[0]?.statement).toBe(
      "Participation works when discussion is welcoming and understandable.",
    );
    expect(projection.currentStates[0]?.statement).toBe(
      "Malia now participates in supportive investment communities.",
    );
  });

  test("keeps conditional variants separate instead of invalidating a global state", () => {
    const facet = createMemoryFacetV2({
      scope,
      canonicalKey: "response.detail_preference",
      displayName: "Response detail preference",
    });
    const concise = profile(
      "concise",
      "2025-01-01T00:00:00.000Z",
      "The user generally prefers concise answers.",
    );
    const detailed = profile(
      "detailed-technical",
      "2025-02-01T00:00:00.000Z",
      "For unfamiliar technical work, the user prefers detailed explanations.",
    );
    const projection = projectMemoryFacetStateV2({
      facet,
      memberships: [
        member(facet.id, concise.id, "state", "initial"),
        member(facet.id, detailed.id, "state", "context_variant", [concise.id]),
      ],
      entries: [detailed, concise],
    });

    expect(projection.currentStates.map((item) => item.memoryId)).toEqual([
      "concise",
    ]);
    expect(projection.contextualStates.map((item) => item.memoryId)).toEqual([
      "detailed-technical",
    ]);
    expect(projection.historicalStates).toHaveLength(0);
  });

  test("is input-order invariant and emits content-free telemetry", () => {
    const facet = createMemoryFacetV2({
      scope,
      canonicalKey: "Learning.Film-History",
      displayName: "Film history learning",
      aliases: ["cinema history", "film-history"],
    });
    const oldState = profile(
      "old",
      "2025-01-01T00:00:00.000Z",
      "Jordan found formal film-history study tedious.",
    );
    const currentState = profile(
      "new",
      "2025-03-01T00:00:00.000Z",
      "Jordan now enjoys film history through interviews and podcasts.",
    );
    const memberships = [
      member(facet.id, oldState.id, "state", "initial"),
      member(facet.id, currentState.id, "state", "state_change", [oldState.id]),
    ];
    const events: MemoryFacetStateProjectorEventV2[] = [];
    const first = projectMemoryFacetStateV2(
      { facet, memberships, entries: [oldState, currentState] },
      { onEvent: (event) => events.push(event), now: () => 10 },
    );
    const second = projectMemoryFacetStateV2({
      facet,
      memberships: [...memberships].reverse(),
      entries: [currentState, oldState],
    });

    expect(first.projectionRevision).toBe(second.projectionRevision);
    expect(first.membershipRevision).toBe(second.membershipRevision);
    expect(JSON.stringify(events)).not.toContain("Jordan");
    expect(events).toEqual([
      expect.objectContaining({
        type: "projected",
        facetId: facet.id,
        membershipCount: 2,
        currentStateCount: 1,
        historicalStateCount: 1,
        durationMs: 0,
      }),
    ]);
    expect(facet.canonicalKey).toBe("learning.film.history");
    expect(
      deriveMemoryFacetIdV2({ scope, canonicalKey: "learning film history" }),
    ).toBe(facet.id);
  });

  test("fails closed on dangling cross-facet links and logs only the reason", () => {
    const facet = createMemoryFacetV2({
      scope,
      canonicalKey: "investment.community_participation",
      displayName: "Investment community participation",
    });
    const current = profile(
      "current",
      "2025-02-01T00:00:00.000Z",
      "Current state content must not enter telemetry.",
    );
    const events: MemoryFacetStateProjectorEventV2[] = [];
    expect(() =>
      projectMemoryFacetStateV2(
        {
          facet,
          memberships: [
            member(facet.id, current.id, "state", "state_change", ["missing"]),
          ],
          entries: [current],
        },
        { onEvent: (event) => events.push(event), now: () => 10 },
      ),
    ).toThrow("MemoryFacetMembershipTargetMissing");
    expect(events[0]).toMatchObject({
      type: "failed",
      facetId: facet.id,
      membershipCount: 1,
      reasonCode: "MemoryFacetProjector_MemoryFacetMembershipTargetMissing",
    });
    expect(JSON.stringify(events)).not.toContain("Current state content");
  });
});

function member(
  facetId: string,
  memoryId: string,
  role: "state" | "event" | "cause" | "condition",
  linkKind:
    | "initial"
    | "same_state"
    | "state_change"
    | "context_variant"
    | "supports"
    | "unresolved",
  targetMemoryIds: readonly string[] = [],
) {
  return createMemoryFacetMembershipV2({
    facetId,
    memoryId,
    role,
    linkKind,
    targetMemoryIds,
    confidence: 0.95,
  });
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

function episode(id: string, tValid: string, perspective: string): MemoryEntry {
  return Object.freeze({
    ...common(id, tValid),
    kind: "episodic",
    whenToUse: "When recalling investment community participation",
    perspective,
    modification: [],
    issueType: "memory_atom",
    taskId: "run-1",
  });
}
