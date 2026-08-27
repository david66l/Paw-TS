import { describe, expect, test } from "bun:test";

import {
  type MemoryAspectGraphEventV1,
  type MemoryAspectGraphSnapshotV1,
  type PawNextMemoryScopeV1,
  applyMemoryAspectGraphMutationV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createMemoryAspectClaimV1,
  createMemoryAspectLifecycleEventV1,
  createMemoryAspectTransitionV1,
  createMemoryAspectV1,
  createMemoryClaimAspectMembershipV1,
  createMemoryEvidenceEdgeV1,
  measureMemoryAspectGraphV1,
  projectMemoryAspectStateV1,
  resolveMemoryAspectIdsV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});
const jan = "2025-01-01T00:00:00.000Z";
const feb = "2025-02-01T00:00:00.000Z";
const mar = "2025-03-01T00:00:00.000Z";
const apr = "2025-04-01T00:00:00.000Z";

describe("aspect graph v1", () => {
  test("allows one claim to support multiple aspects", () => {
    const film = aspect("film", "Film activities");
    const social = aspect("social", "Social activities");
    const episode = claim("film-club", "event", feb);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [episode],
      aspects: [film, social],
      memberships: [
        membership(episode.id, film.id, "event"),
        membership(episode.id, social.id, "cause"),
      ],
    });

    expect(
      projectMemoryAspectStateV1({ snapshot, aspectId: film.id, asOf: mar })
        .eventClaimIds,
    ).toEqual([episode.id]);
    expect(
      projectMemoryAspectStateV1({ snapshot, aspectId: social.id, asOf: mar })
        .causeClaimIds,
    ).toEqual([episode.id]);
    expect(measureMemoryAspectGraphV1(snapshot)).toEqual(
      expect.objectContaining({
        multiAspectClaimCount: 1,
        averageAspectsPerClaim: 2,
        largestAspectClaimShare: 1,
      }),
    );
  });

  test("keeps identity stable when labels and aliases evolve", () => {
    const original = aspect("stable-film-id", "Film interest", ["cinema"]);
    const renamed = aspect("stable-film-id", "Cinema preferences", [
      "film interest",
      "movies",
    ]);
    expect(renamed.id).toBe(original.id);

    const first = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      aspects: [original],
    });
    const second = applyMemoryAspectGraphMutationV1({
      snapshot: first,
      aspects: [renamed],
    });

    expect(second.aspects[0]).toEqual(renamed);
    expect(second.revision).not.toBe(first.revision);
  });

  test("merges aspects through redirects and inherits source memberships", () => {
    const filmPreference = aspect("film-preference", "Film preference");
    const cinemaInterest = aspect("cinema-interest", "Cinema interest");
    const prefersFilm = claim("prefers-film", "state", jan);
    const enjoysCinema = claim("enjoys-cinema", "state", feb);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [prefersFilm, enjoysCinema],
      aspects: [filmPreference, cinemaInterest],
      memberships: [
        membership(prefersFilm.id, filmPreference.id),
        membership(enjoysCinema.id, cinemaInterest.id),
      ],
      transitions: [
        createMemoryAspectTransitionV1({
          scope,
          kind: "merge",
          fromAspectId: filmPreference.id,
          toAspectIds: [cinemaInterest.id],
          reasonCode: "semantic_equivalence",
          createdAt: mar,
        }),
      ],
    });

    expect(resolveMemoryAspectIdsV1(snapshot, filmPreference.id)).toEqual([
      cinemaInterest.id,
    ]);
    expect(
      projectMemoryAspectStateV1({
        snapshot,
        aspectId: cinemaInterest.id,
        asOf: mar,
      }).currentClaimIds,
    ).toEqual([prefersFilm.id, enjoysCinema.id]);
    expect(
      snapshot.aspects.find((item) => item.id === filmPreference.id),
    ).toEqual(
      expect.objectContaining({
        status: "redirected",
        redirectToAspectIds: [cinemaInterest.id],
      }),
    );
  });

  test("splits navigation without copying ambiguous source evidence", () => {
    const broad = aspect("activity", "Activities");
    const film = aspect("activity-film", "Film activities");
    const sport = aspect("activity-sport", "Sport activities");
    const ambiguous = claim("ambiguous-activity", "event", jan);
    const filmEvent = claim("film-event", "event", feb);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [ambiguous, filmEvent],
      aspects: [broad, film, sport],
      memberships: [
        membership(ambiguous.id, broad.id, "event"),
        membership(filmEvent.id, film.id, "event"),
      ],
      transitions: [
        createMemoryAspectTransitionV1({
          scope,
          kind: "split",
          fromAspectId: broad.id,
          toAspectIds: [film.id, sport.id],
          reasonCode: "over_broad",
          createdAt: mar,
        }),
      ],
    });

    expect(resolveMemoryAspectIdsV1(snapshot, broad.id)).toEqual(
      [film.id, sport.id].sort(),
    );
    expect(
      projectMemoryAspectStateV1({ snapshot, aspectId: broad.id, asOf: mar })
        .eventClaimIds,
    ).toEqual([]);
    expect(
      projectMemoryAspectStateV1({ snapshot, aspectId: broad.id, asOf: mar })
        .unresolvedClaimIds,
    ).toEqual([ambiguous.id]);
    expect(
      projectMemoryAspectStateV1({ snapshot, aspectId: film.id, asOf: mar })
        .eventClaimIds,
    ).toEqual([filmEvent.id]);
  });

  test("preserves typed adjacency and materializes temporal state deterministically", () => {
    const participation = aspect("participation", "Community participation");
    const avoided = claim("avoided", "state", jan);
    const joined = claim("joined", "state", feb);
    const welcoming = claim("welcoming", "cause", feb);
    const supersedes = edge(
      joined.id,
      avoided.id,
      "supersedes",
      mar,
      participation.id,
    );
    const causedBy = edge(joined.id, welcoming.id, "caused_by", mar);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [avoided, joined, welcoming],
      aspects: [participation],
      memberships: [
        membership(avoided.id, participation.id),
        membership(joined.id, participation.id),
      ],
      edges: [supersedes, causedBy],
    });
    const projection = projectMemoryAspectStateV1({
      snapshot,
      aspectId: participation.id,
      asOf: mar,
    });

    expect(projection.currentClaimIds).toEqual([joined.id]);
    expect(projection.historicalClaimIds).toEqual([avoided.id]);
    expect(projection.neighborClaimIds).toEqual([welcoming.id]);
    expect(projection.edges.map((item) => item.edgeType).sort()).toEqual([
      "caused_by",
      "supersedes",
    ]);
  });

  test("rejects reverse-time supersedes and supersedes cycles", () => {
    const preference = aspect("preference", "Preference");
    const old = claim("old", "state", jan);
    const current = claim("current", "state", feb);
    const base = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [old, current],
      aspects: [preference],
      memberships: [
        membership(old.id, preference.id),
        membership(current.id, preference.id),
      ],
    });

    expect(() =>
      applyMemoryAspectGraphMutationV1({
        snapshot: base,
        edges: [edge(old.id, current.id, "supersedes", mar, preference.id)],
      }),
    ).toThrow("MemoryEvidenceSupersedesTimeOrderInvalid");

    const left = claim("left", "state", jan);
    const right = claim("right", "state", jan);
    const equalTime = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [left, right],
      aspects: [preference],
      memberships: [
        membership(left.id, preference.id),
        membership(right.id, preference.id),
      ],
    });
    expect(() =>
      applyMemoryAspectGraphMutationV1({
        snapshot: equalTime,
        edges: [
          edge(left.id, right.id, "supersedes", mar, preference.id),
          edge(right.id, left.id, "supersedes", mar, preference.id),
        ],
      }),
    ).toThrow("MemoryEvidenceSupersedesCycleDetected");
  });

  test("keeps claims append-only while allowing explicit relation retractions", () => {
    const preference = aspect("append-only", "Append-only preference");
    const old = claim("append-old", "state", jan);
    const current = claim("append-current", "state", feb);
    const activeEdge = edge(
      current.id,
      old.id,
      "supersedes",
      mar,
      preference.id,
    );
    const oldMembership = membership(old.id, preference.id);
    const currentMembership = membership(current.id, preference.id);
    const base = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [old, current],
      aspects: [preference],
      memberships: [oldMembership, currentMembership],
      edges: [activeEdge],
    });
    const mutatedClaim = createMemoryAspectClaimV1({
      id: old.id,
      kind: "assertion",
      validFrom: feb,
      ingestedAt: feb,
      evidenceRefs: ["l0:append-old"],
    });

    expect(() =>
      applyMemoryAspectGraphMutationV1({
        snapshot: base,
        claims: [mutatedClaim],
      }),
    ).toThrow("MemoryAspectClaimImmutableConflict");

    const retracted = createMemoryAspectLifecycleEventV1({
      scope,
      targetKind: "edge",
      targetId: activeEdge.id,
      reasonCode: "relation_disproved",
      evidenceRefs: [`l0:${current.id}`],
      occurredAt: apr,
    });
    const afterRetraction = applyMemoryAspectGraphMutationV1({
      snapshot: base,
      lifecycleEvents: [retracted],
    });
    expect(afterRetraction.edges).toEqual([activeEdge]);
    expect(afterRetraction.lifecycleEvents).toEqual([retracted]);
    expect(
      projectMemoryAspectStateV1({
        snapshot: afterRetraction,
        aspectId: preference.id,
        asOf: mar,
      }),
    ).toEqual(
      expect.objectContaining({
        currentClaimIds: [current.id],
        historicalClaimIds: [old.id],
      }),
    );
    expect(
      projectMemoryAspectStateV1({
        snapshot: afterRetraction,
        aspectId: preference.id,
        asOf: apr,
      }).currentClaimIds,
    ).toEqual([old.id, current.id]);

    const retractedMembership = createMemoryAspectLifecycleEventV1({
      scope,
      targetKind: "membership",
      targetId: oldMembership.id,
      reasonCode: "membership_disproved",
      occurredAt: apr,
    });
    const afterMembershipRetraction = applyMemoryAspectGraphMutationV1({
      snapshot: afterRetraction,
      lifecycleEvents: [retractedMembership],
    });
    expect(
      projectMemoryAspectStateV1({
        snapshot: afterMembershipRetraction,
        aspectId: preference.id,
        asOf: apr,
      }).currentClaimIds,
    ).toEqual([current.id]);
    expect(measureMemoryAspectGraphV1(afterMembershipRetraction)).toEqual(
      expect.objectContaining({
        membershipCount: 2,
        activeMembershipCount: 1,
      }),
    );
  });

  test("scopes temporal replacement to one subject context", () => {
    const preference = aspect("scoped-preference", "Scoped preference");
    const old = claim("scoped-old", "state", jan);
    const current = claim("scoped-current", "state", feb);
    const subjectKey = "person:alice";
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [old, current],
      aspects: [preference],
      memberships: [
        membership(old.id, preference.id, "state", {
          subjectKey,
          contextKey: "work",
        }),
        membership(current.id, preference.id, "state", {
          subjectKey,
          contextKey: "work",
        }),
        membership(old.id, preference.id, "state", {
          subjectKey,
          contextKey: "personal",
        }),
        membership(current.id, preference.id, "state", {
          subjectKey,
          contextKey: "personal",
        }),
      ],
      edges: [
        edge(current.id, old.id, "supersedes", mar, preference.id, {
          subjectKey,
          contextKey: "work",
        }),
      ],
    });

    expect(
      projectMemoryAspectStateV1({
        snapshot,
        aspectId: preference.id,
        subjectKey,
        contextKey: "work",
        asOf: apr,
      }),
    ).toEqual(
      expect.objectContaining({
        currentClaimIds: [current.id],
        historicalClaimIds: [old.id],
      }),
    );
    expect(
      projectMemoryAspectStateV1({
        snapshot,
        aspectId: preference.id,
        subjectKey,
        contextKey: "personal",
        asOf: apr,
      }),
    ).toEqual(
      expect.objectContaining({
        currentClaimIds: [old.id, current.id],
        historicalClaimIds: [],
      }),
    );
    expect(() =>
      projectMemoryAspectStateV1({
        snapshot,
        aspectId: preference.id,
        asOf: apr,
      }),
    ).toThrow("MemoryAspectProjectionStateScopeAmbiguous");
  });

  test("requires state edges to connect claims in their exact state key", () => {
    const preference = aspect("membership-guard", "Membership guard");
    const old = claim("membership-old", "state", jan);
    const current = claim("membership-current", "state", feb);
    const base = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [old, current],
      aspects: [preference],
      memberships: [
        membership(old.id, preference.id),
        membership(current.id, preference.id),
      ],
    });

    expect(() =>
      applyMemoryAspectGraphMutationV1({
        snapshot: base,
        edges: [
          edge(current.id, old.id, "supersedes", mar, preference.id, {
            contextKey: "work",
          }),
        ],
      }),
    ).toThrow("MemoryEvidenceEdgeStateMembershipMissing");
  });

  test("keeps lifecycle retractions monotonic and supports revision guards", () => {
    const preference = aspect("lifecycle-guard", "Lifecycle guard");
    const state = claim("lifecycle-state", "state", jan);
    const stateMembership = membership(state.id, preference.id);
    const base = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [state],
      aspects: [preference],
      memberships: [stateMembership],
    });

    expect(() =>
      applyMemoryAspectGraphMutationV1({
        snapshot: base,
        expectedRevision: "stale-revision",
      }),
    ).toThrow("MemoryAspectGraphRevisionConflict");
    expect(() =>
      applyMemoryAspectGraphMutationV1({
        snapshot: base,
        lifecycleEvents: [
          createMemoryAspectLifecycleEventV1({
            scope,
            targetKind: "membership",
            targetId: stateMembership.id,
            reasonCode: "impossible_early_retraction",
            occurredAt: feb,
          }),
        ],
      }),
    ).toThrow("MemoryAspectLifecycleTimeOrderInvalid");

    const retraction = createMemoryAspectLifecycleEventV1({
      scope,
      targetKind: "membership",
      targetId: stateMembership.id,
      reasonCode: "first_retraction",
      occurredAt: apr,
    });
    const retracted = applyMemoryAspectGraphMutationV1({
      snapshot: base,
      expectedRevision: base.revision,
      lifecycleEvents: [retraction],
    });
    expect(() =>
      applyMemoryAspectGraphMutationV1({
        snapshot: retracted,
        lifecycleEvents: [
          createMemoryAspectLifecycleEventV1({
            scope,
            targetKind: "membership",
            targetId: stateMembership.id,
            reasonCode: "rewritten_retraction",
            occurredAt: apr,
          }),
        ],
      }),
    ).toThrow("MemoryAspectLifecycleImmutableConflict");
  });

  test("deep-freezes published snapshots and rejects revision tampering", () => {
    const film = aspect("frozen", "Frozen aspect");
    const state = claim("frozen-claim", "state", jan);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [state],
      aspects: [film],
      memberships: [membership(state.id, film.id)],
    });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.claims[0])).toBe(true);
    expect(Object.isFrozen(snapshot.claims[0]?.evidenceRefs)).toBe(true);
    expect(() =>
      measureMemoryAspectGraphV1({ ...snapshot, revision: "tampered" }),
    ).toThrow("MemoryAspectGraphRevisionMismatch");
  });

  test("is input-order invariant and emits content-free diagnostics", () => {
    const film = aspect("film", "Secret film label");
    const firstClaim = claim("secret-claim-a", "state", jan);
    const secondClaim = claim("secret-claim-b", "state", feb);
    const events: MemoryAspectGraphEventV1[] = [];
    const first = applyMemoryAspectGraphMutationV1(
      {
        snapshot: empty(),
        claims: [firstClaim, secondClaim],
        aspects: [film],
        memberships: [
          membership(firstClaim.id, film.id),
          membership(secondClaim.id, film.id),
        ],
      },
      { onEvent: (event) => events.push(event), now: () => 10 },
    );
    const second = applyMemoryAspectGraphMutationV1({
      snapshot: empty(),
      claims: [secondClaim, firstClaim],
      aspects: [film],
      memberships: [
        membership(secondClaim.id, film.id),
        membership(firstClaim.id, film.id),
      ],
    });

    expect(first.revision).toBe(second.revision);
    expect(events).toEqual([
      expect.objectContaining({
        type: "applied",
        claimCount: 2,
        aspectCount: 1,
        membershipCount: 2,
        edgeCount: 0,
        durationMs: 0,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("Secret film label");
    expect(JSON.stringify(events)).not.toContain("secret-claim");
  });
});

function empty(): MemoryAspectGraphSnapshotV1 {
  return createEmptyMemoryAspectGraphSnapshotV1(scope);
}

function aspect(
  identitySeed: string,
  displayName: string,
  aliases: string[] = [],
) {
  return createMemoryAspectV1({ scope, identitySeed, displayName, aliases });
}

function claim(
  id: string,
  role: "state" | "fact" | "event" | "cause" | "condition",
  validFrom: string,
) {
  return createMemoryAspectClaimV1({
    id,
    kind: role === "event" ? "episode" : "assertion",
    validFrom,
    ingestedAt: validFrom,
    evidenceRefs: [`l0:${id}`],
  });
}

function membership(
  claimId: string,
  aspectId: string,
  role: "state" | "fact" | "event" | "cause" | "condition" = "state",
  dimensions: Readonly<{ subjectKey?: string; contextKey?: string }> = {},
) {
  return createMemoryClaimAspectMembershipV1({
    scope,
    claimId,
    aspectId,
    ...dimensions,
    role,
    confidence: 0.9,
    createdAt: mar,
  });
}

function edge(
  fromClaimId: string,
  toClaimId: string,
  edgeType:
    | "same_state"
    | "supersedes"
    | "contradicts"
    | "supports"
    | "qualifies"
    | "caused_by"
    | "derived_from",
  createdAt: string,
  aspectId?: string,
  dimensions: Readonly<{ subjectKey?: string; contextKey?: string }> = {},
) {
  const stateScoped = [
    "same_state",
    "supersedes",
    "contradicts",
    "qualifies",
  ].includes(edgeType);
  if (stateScoped && aspectId === undefined) {
    throw new Error("state-scoped test edge requires aspectId");
  }
  return createMemoryEvidenceEdgeV1({
    scope,
    fromClaimId,
    toClaimId,
    edgeType,
    ...(aspectId === undefined
      ? {}
      : { stateScope: { aspectId, ...dimensions } }),
    confidence: 0.9,
    evidenceRefs: [`l0:${fromClaimId}`],
    createdAt,
  });
}
