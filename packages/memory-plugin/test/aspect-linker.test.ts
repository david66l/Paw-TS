import { describe, expect, test } from "bun:test";

import {
  type MemoryAspectLinkerEventV1,
  type MemoryAspectLinkingInputV1,
  type PawNextMemoryScopeV1,
  applyMemoryAspectGraphMutationV1,
  applyMemoryAspectLinkingV1,
  buildMemoryAspectLinkerRequestV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createJsonMemoryAspectLinkerV1,
  createMemoryAspectClaimV1,
  createMemoryAspectV1,
  createMemoryClaimAspectMembershipV1,
  deriveMemoryAspectLinkStatementHashV1,
  deriveMemoryAspectLinkingInputRevisionV1,
  parseMemoryAspectLinkingV1,
  projectMemoryAspectStateV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-linker",
  userId: "user-linker",
  workspaceId: "workspace-linker",
  repositoryId: "repo-linker",
});
const jan = "2025-01-01T00:00:00.000Z";
const feb = "2025-02-01T00:00:00.000Z";
const mar = "2025-03-01T00:00:00.000Z";

describe("bounded aspect linker v1", () => {
  test("materializes multi-aspect memberships and typed adjacency", () => {
    const setup = multiAspectSetup();
    const result = parseMemoryAspectLinkingV1(
      JSON.stringify({
        decisions: [
          {
            claimId: "garden-cooking-club",
            disposition: "link",
            memberships: [
              existingMembership(setup.cookingId, "event"),
              existingMembership(setup.gardeningId, "event"),
            ],
            edges: [
              existingEdge("cooking-preference", "supports", setup.cookingId),
            ],
          },
        ],
      }),
      setup.input,
    );

    expect(result.settlement).toBe("linked");
    expect(result.memberships).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    const snapshot = applyMemoryAspectLinkingV1(setup.input.snapshot, result);
    expect(
      projectMemoryAspectStateV1({
        snapshot,
        aspectId: setup.cookingId,
        asOf: mar,
      }).eventClaimIds,
    ).toEqual(["garden-cooking-club"]);
    expect(
      projectMemoryAspectStateV1({
        snapshot,
        aspectId: setup.gardeningId,
        asOf: mar,
      }).eventClaimIds,
    ).toEqual(["garden-cooking-club"]);
  });

  test("lets code validate and commit a scoped supersedes proposal", () => {
    const preference = createMemoryAspectV1({
      scope,
      identitySeed: "response-detail",
      displayName: "Response detail preference",
    });
    const old = claim("old-detail", jan);
    const current = claim("current-detail", feb);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: [old, current],
      aspects: [preference],
      memberships: [membership(old.id, preference.id)],
    });
    const input = linkerInput({
      snapshot,
      claims: [linkClaim(current.id, "Now prefers concise responses")],
      aspectCandidates: [
        {
          aspectId: preference.id,
          representatives: [
            linkRepresentative(old.id, "Previously preferred detail"),
          ],
        },
      ],
      relationCandidates: [{ claimId: current.id, targetClaimIds: [old.id] }],
    });
    const result = parseMemoryAspectLinkingV1(
      JSON.stringify({
        decisions: [
          {
            claimId: current.id,
            disposition: "link",
            memberships: [existingMembership(preference.id, "state")],
            edges: [existingEdge(old.id, "supersedes", preference.id)],
          },
        ],
      }),
      input,
    );
    const applied = applyMemoryAspectLinkingV1(snapshot, result);

    expect(
      projectMemoryAspectStateV1({
        snapshot: applied,
        aspectId: preference.id,
        asOf: mar,
      }),
    ).toEqual(
      expect.objectContaining({
        currentClaimIds: [current.id],
        historicalClaimIds: [old.id],
      }),
    );
    expect(() => applyMemoryAspectLinkingV1(applied, result)).toThrow(
      "MemoryAspectLinkerRevisionConflict",
    );
    expect(() =>
      applyMemoryAspectLinkingV1(snapshot, {
        ...result,
        deferredClaimIds: [current.id],
      }),
    ).toThrow("MemoryAspectLinkerResultInvalid");
  });

  test("derives new aspect identity from a deterministic proposal receipt", () => {
    const first = emptyCandidateSetup("Uses a paper budget ledger");
    const second = emptyCandidateSetup("Prefers a digital budget tracker");
    expect(buildMemoryAspectLinkerRequestV1(first).system).toBe(
      buildMemoryAspectLinkerRequestV1(second).system,
    );
    const response = JSON.stringify({
      decisions: [
        {
          claimId: "unlinked-claim",
          disposition: "link",
          memberships: [newMembership("new-1", "Budget tracking method")],
          edges: [],
        },
      ],
    });
    const firstResult = parseMemoryAspectLinkingV1(response, first);
    const replay = parseMemoryAspectLinkingV1(response, first);

    expect(firstResult.aspects).toHaveLength(1);
    expect(firstResult.aspects[0]?.id).toBe(replay.aspects[0]?.id);
    expect(firstResult.linkingRevision).toBe(replay.linkingRevision);
    const packet = JSON.parse(buildMemoryAspectLinkerRequestV1(first).user);
    expect(firstResult.linkingInputRevision).toBe(
      deriveMemoryAspectLinkingInputRevisionV1(first),
    );
    expect(packet).toEqual(
      expect.objectContaining({
        maxNewAspects: 1,
        linkingInputRevision: firstResult.linkingInputRevision,
      }),
    );
    expect(packet.evidence).toHaveLength(1);
  });

  test("rejects a duplicate new aspect even when retrieval did not return it", () => {
    const existing = createMemoryAspectV1({
      scope,
      identitySeed: "existing-budget-method",
      displayName: "Budget tracking method",
    });
    const unlinked = claim("unlinked-budget-method", feb);
    const input = linkerInput({
      snapshot: applyMemoryAspectGraphMutationV1({
        snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
        claims: [unlinked],
        aspects: [existing],
      }),
      claims: [linkClaim(unlinked.id, "Uses a paper budget ledger")],
      aspectCandidates: [],
      relationCandidates: [],
      maxNewAspects: 1,
    });

    expect(() =>
      parseMemoryAspectLinkingV1(
        JSON.stringify({
          decisions: [
            {
              claimId: unlinked.id,
              disposition: "link",
              memberships: [
                newMembership("duplicate-budget", "Budget tracking method"),
              ],
              edges: [],
            },
          ],
        }),
        input,
      ),
    ).toThrow("MemoryAspectLinkerMustReuseExisting");
  });

  test("binds statement content and deduplicates relation evidence in the prompt", () => {
    const setup = multiAspectSetup();
    const request = buildMemoryAspectLinkerRequestV1(setup.input);
    const packet = JSON.parse(request.user);
    expect(packet.evidence).toHaveLength(3);
    expect(packet.relationCandidates).toEqual([
      {
        claimId: "garden-cooking-club",
        targetClaimIds: ["cooking-preference", "gardening-preference"],
      },
    ]);
    expect(JSON.stringify(packet.relationCandidates)).not.toContain(
      "Enjoys cooking",
    );

    const changed = {
      ...setup.input,
      claims: [
        linkClaim(
          "garden-cooking-club",
          "Joined a different activity with cooking workshops",
        ),
      ],
    };
    expect(deriveMemoryAspectLinkingInputRevisionV1(changed)).not.toBe(
      deriveMemoryAspectLinkingInputRevisionV1(setup.input),
    );
    const originalClaim = setup.input.claims[0];
    if (originalClaim === undefined) throw new Error("missing input claim");
    expect(() =>
      buildMemoryAspectLinkerRequestV1({
        ...setup.input,
        claims: [
          {
            ...originalClaim,
            statement: "Tampered statement",
          },
        ],
      }),
    ).toThrow("MemoryAspectLinkerClaimInvalid");
  });

  test("allows relation evidence to be broader than aspect display examples", () => {
    const preference = createMemoryAspectV1({
      scope,
      identitySeed: "broader-relation-evidence",
      displayName: "Response detail preference",
    });
    const representative = claim("relation-representative", jan);
    const relationTarget = claim("relation-only-target", jan);
    const current = claim("relation-current", feb);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: [representative, relationTarget, current],
      aspects: [preference],
      memberships: [
        membership(representative.id, preference.id),
        membership(relationTarget.id, preference.id),
      ],
    });
    const input: MemoryAspectLinkingInputV1 = {
      ...linkerInput({
        snapshot,
        claims: [linkClaim(current.id, "Now prefers concise responses")],
        aspectCandidates: [
          {
            aspectId: preference.id,
            representatives: [
              linkRepresentative(
                representative.id,
                "Previously preferred detailed responses",
              ),
            ],
          },
        ],
        relationCandidates: [
          { claimId: current.id, targetClaimIds: [relationTarget.id] },
        ],
      }),
      relationEvidence: [
        linkRepresentative(
          relationTarget.id,
          "Detailed responses were useful for complex work",
        ),
      ],
    };
    const packet = JSON.parse(buildMemoryAspectLinkerRequestV1(input).user);
    expect(packet.evidence).toHaveLength(3);
    expect(packet.aspectCandidates[0].representatives).not.toContain(
      relationTarget.id,
    );
    const result = parseMemoryAspectLinkingV1(
      JSON.stringify({
        decisions: [
          {
            claimId: current.id,
            disposition: "link",
            memberships: [existingMembership(preference.id, "state")],
            edges: [existingEdge(relationTarget.id, "supports", preference.id)],
          },
        ],
      }),
      input,
    );
    expect(result.edges[0]?.toClaimId).toBe(relationTarget.id);
  });

  test("allows a partially linked claim to add one missing aspect", () => {
    const setup = multiAspectSetup();
    const combined = setup.input.snapshot.claims.find(
      (item) => item.id === "garden-cooking-club",
    );
    if (combined === undefined) throw new Error("missing combined claim");
    const partiallyLinked = applyMemoryAspectGraphMutationV1({
      snapshot: setup.input.snapshot,
      memberships: [membership(combined.id, setup.cookingId, "event")],
    });
    const input = linkerInput({
      snapshot: partiallyLinked,
      claims: [
        linkClaim(
          combined.id,
          "Joined a garden club that also holds cooking workshops",
        ),
      ],
      aspectCandidates: [
        {
          aspectId: setup.gardeningId,
          representatives:
            setup.input.aspectCandidates[1]?.representatives ?? [],
        },
      ],
      relationCandidates: [],
    });
    const packet = JSON.parse(buildMemoryAspectLinkerRequestV1(input).user);
    expect(packet.claims[0].existingMemberships).toEqual([
      { aspectId: setup.cookingId, role: "event" },
    ]);
    const result = parseMemoryAspectLinkingV1(
      JSON.stringify({
        decisions: [
          {
            claimId: combined.id,
            disposition: "link",
            memberships: [existingMembership(setup.gardeningId, "event")],
            edges: [],
          },
        ],
      }),
      input,
    );
    const applied = applyMemoryAspectLinkingV1(partiallyLinked, result);
    expect(
      applied.memberships.filter((item) => item.claimId === combined.id),
    ).toHaveLength(2);
  });

  test("holds future supersedes until the new state becomes effective", () => {
    const jun = "2025-06-01T00:00:00.000Z";
    const jul = "2025-07-01T00:00:00.000Z";
    const preference = createMemoryAspectV1({
      scope,
      identitySeed: "future-preference",
      displayName: "Future preference",
    });
    const old = claim("future-old", jan);
    const future = claim("future-new", jun);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: [old, future],
      aspects: [preference],
      memberships: [membership(old.id, preference.id)],
    });
    const input = linkerInput({
      snapshot,
      claims: [linkClaim(future.id, "Will prefer concise answers from June")],
      aspectCandidates: [
        {
          aspectId: preference.id,
          representatives: [
            linkRepresentative(old.id, "Currently prefers detailed answers"),
          ],
        },
      ],
      relationCandidates: [{ claimId: future.id, targetClaimIds: [old.id] }],
    });
    const linking = parseMemoryAspectLinkingV1(
      JSON.stringify({
        decisions: [
          {
            claimId: future.id,
            disposition: "link",
            memberships: [existingMembership(preference.id, "state")],
            edges: [existingEdge(old.id, "supersedes", preference.id)],
          },
        ],
      }),
      input,
    );
    expect(linking.edges[0]?.effectiveFrom).toBe(jun);
    const applied = applyMemoryAspectLinkingV1(snapshot, linking);
    expect(
      projectMemoryAspectStateV1({
        snapshot: applied,
        aspectId: preference.id,
        asOf: mar,
      }),
    ).toEqual(
      expect.objectContaining({
        currentClaimIds: [old.id],
        historicalClaimIds: [],
        futureClaimIds: [future.id],
      }),
    );
    expect(
      projectMemoryAspectStateV1({
        snapshot: applied,
        aspectId: preference.id,
        asOf: jul,
      }),
    ).toEqual(
      expect.objectContaining({
        currentClaimIds: [future.id],
        historicalClaimIds: [old.id],
      }),
    );
  });

  test("enforces confidence floors before graph materialization", () => {
    const setup = emptyCandidateSetup("Uses a paper budget ledger");
    expect(() =>
      parseMemoryAspectLinkingV1(
        JSON.stringify({
          decisions: [
            {
              claimId: "unlinked-claim",
              disposition: "link",
              memberships: [
                {
                  ...newMembership("new-low", "Budget tracking method"),
                  confidence: 0.79,
                },
              ],
              edges: [],
            },
          ],
        }),
        setup,
      ),
    ).toThrow("MemoryAspectLinkerMembershipConfidenceTooLow");
  });

  test("rejects invented targets and state edges without exact membership", () => {
    const setup = multiAspectSetup();
    expect(() =>
      parseMemoryAspectLinkingV1(
        JSON.stringify({
          decisions: [
            {
              claimId: "garden-cooking-club",
              disposition: "link",
              memberships: [existingMembership(setup.cookingId, "event")],
              edges: [
                existingEdge("invented-claim", "supports", setup.cookingId),
              ],
            },
          ],
        }),
        setup.input,
      ),
    ).toThrow("MemoryAspectLinkerEdgeTargetUnknown");

    expect(() =>
      parseMemoryAspectLinkingV1(
        JSON.stringify({
          decisions: [
            {
              claimId: "garden-cooking-club",
              disposition: "link",
              memberships: [existingMembership(setup.cookingId, "event")],
              edges: [
                existingEdge(
                  "cooking-preference",
                  "supersedes",
                  setup.cookingId,
                ),
              ],
            },
          ],
        }),
        setup.input,
      ),
    ).toThrow("MemoryAspectLinkerStateEdgeRoleInvalid");
  });

  test("rejects representatives from a non-global state context", () => {
    const aspect = createMemoryAspectV1({
      scope,
      identitySeed: "work-only",
      displayName: "Work preference",
    });
    const representative = claim("work-representative", jan);
    const unlinked = claim("work-unlinked", feb);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: [representative, unlinked],
      aspects: [aspect],
      memberships: [
        createMemoryClaimAspectMembershipV1({
          scope,
          claimId: representative.id,
          aspectId: aspect.id,
          contextKey: "work",
          role: "state",
          confidence: 1,
          createdAt: jan,
        }),
      ],
    });
    expect(() =>
      buildMemoryAspectLinkerRequestV1(
        linkerInput({
          snapshot,
          claims: [linkClaim(unlinked.id, "Prefers concise reports")],
          aspectCandidates: [
            {
              aspectId: aspect.id,
              representatives: [
                linkRepresentative(
                  representative.id,
                  "Prefers detailed work reports",
                ),
              ],
            },
          ],
          relationCandidates: [],
        }),
      ),
    ).toThrow("MemoryAspectLinkerRepresentativeInvalid");
  });

  test("uses one model call and defers the whole batch on invalid output", async () => {
    const setup = multiAspectSetup();
    const calls: Array<Readonly<{ system: string; user: string }>> = [];
    const events: MemoryAspectLinkerEventV1[] = [];
    const linker = createJsonMemoryAspectLinkerV1({
      model: {
        async complete(request) {
          calls.push(request);
          return {
            status: "completed" as const,
            text: JSON.stringify({
              decisions: [
                {
                  claimId: "garden-cooking-club",
                  disposition: "link",
                  memberships: [existingMembership("invented-aspect", "event")],
                  edges: [],
                },
              ],
            }),
          };
        },
      },
      onEvent: (event) => events.push(event),
      now: () => 10,
    });
    const result = await linker.link(setup.input, new AbortController().signal);

    expect(calls).toHaveLength(1);
    expect(result).toEqual(
      expect.objectContaining({
        settlement: "deferred_invalid_proposal",
        memberships: [],
        edges: [],
        deferredClaimIds: ["garden-cooking-club"],
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "completed",
        settlement: "deferred_invalid_proposal",
        modelCallCount: 1,
        membershipCount: 0,
        deferredCount: 1,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("garden-cooking-club");
  });

  test("defers model failures but preserves cancellation semantics", async () => {
    const setup = emptyCandidateSetup("Uses a paper budget ledger");
    const events: MemoryAspectLinkerEventV1[] = [];
    const linker = createJsonMemoryAspectLinkerV1({
      model: {
        async complete() {
          return { status: "truncated" as const, errorCode: "limit" };
        },
      },
      onEvent: (event) => events.push(event),
      now: () => 20,
    });
    const result = await linker.link(setup, new AbortController().signal);
    expect(result.settlement).toBe("deferred_model_failure");
    expect(result.deferredClaimIds).toEqual(["unlinked-claim"]);
    expect(events[0]).toEqual(
      expect.objectContaining({ reasonCode: "Model_limit" }),
    );

    const aborted = new AbortController();
    aborted.abort();
    expect(linker.link(setup, aborted.signal)).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
  });
});

function multiAspectSetup() {
  const cooking = createMemoryAspectV1({
    scope,
    identitySeed: "cooking",
    displayName: "Cooking activities",
  });
  const gardening = createMemoryAspectV1({
    scope,
    identitySeed: "gardening",
    displayName: "Gardening activities",
  });
  const cookingPreference = claim("cooking-preference", jan);
  const gardeningPreference = claim("gardening-preference", jan);
  const combined = createMemoryAspectClaimV1({
    id: "garden-cooking-club",
    kind: "episode",
    validFrom: feb,
    ingestedAt: feb,
    evidenceRefs: ["l0:garden-cooking-club"],
  });
  const snapshot = applyMemoryAspectGraphMutationV1({
    snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
    claims: [cookingPreference, gardeningPreference, combined],
    aspects: [cooking, gardening],
    memberships: [
      membership(cookingPreference.id, cooking.id),
      membership(gardeningPreference.id, gardening.id),
    ],
  });
  return {
    cookingId: cooking.id,
    gardeningId: gardening.id,
    input: linkerInput({
      snapshot,
      claims: [
        linkClaim(
          combined.id,
          "Joined a garden club that also holds cooking workshops",
        ),
      ],
      aspectCandidates: [
        {
          aspectId: cooking.id,
          representatives: [
            linkRepresentative(cookingPreference.id, "Enjoys cooking"),
          ],
        },
        {
          aspectId: gardening.id,
          representatives: [
            linkRepresentative(gardeningPreference.id, "Enjoys gardening"),
          ],
        },
      ],
      relationCandidates: [
        {
          claimId: combined.id,
          targetClaimIds: [cookingPreference.id, gardeningPreference.id],
        },
      ],
    }),
  };
}

function emptyCandidateSetup(statement: string): MemoryAspectLinkingInputV1 {
  const snapshot = applyMemoryAspectGraphMutationV1({
    snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
    claims: [claim("unlinked-claim", feb)],
  });
  return linkerInput({
    snapshot,
    claims: [linkClaim("unlinked-claim", statement)],
    aspectCandidates: [],
    relationCandidates: [],
    maxNewAspects: 1,
  });
}

function linkerInput(
  input: Pick<
    MemoryAspectLinkingInputV1,
    "snapshot" | "claims" | "aspectCandidates" | "relationCandidates"
  > &
    Partial<Pick<MemoryAspectLinkingInputV1, "maxNewAspects">>,
): MemoryAspectLinkingInputV1 {
  return {
    scope,
    observedAt: mar,
    maxNewAspects: input.maxNewAspects ?? 2,
    ...input,
  };
}

function linkClaim(claimId: string, statement: string) {
  return {
    claimId,
    statement,
    statementHash: deriveMemoryAspectLinkStatementHashV1(statement),
  };
}

function linkRepresentative(claimId: string, statement: string) {
  return {
    claimId,
    statement,
    statementHash: deriveMemoryAspectLinkStatementHashV1(statement),
  };
}

function claim(id: string, validFrom: string) {
  return createMemoryAspectClaimV1({
    id,
    kind: "assertion",
    validFrom,
    ingestedAt: validFrom,
    evidenceRefs: [`l0:${id}`],
  });
}

function membership(
  claimId: string,
  aspectId: string,
  role: "state" | "event" = "state",
) {
  return createMemoryClaimAspectMembershipV1({
    scope,
    claimId,
    aspectId,
    role,
    confidence: 1,
    createdAt: jan,
  });
}

function existingMembership(
  aspectId: string,
  role: "state" | "fact" | "event" | "cause" | "condition",
) {
  return {
    aspectId,
    newAspectKey: null,
    displayName: null,
    aliases: [],
    role,
    confidence: 0.95,
  };
}

function newMembership(newAspectKey: string, displayName: string) {
  return {
    aspectId: null,
    newAspectKey,
    displayName,
    aliases: [],
    role: "state",
    confidence: 0.95,
  };
}

function existingEdge(
  toClaimId: string,
  edgeType: "same_state" | "supersedes" | "qualifies" | "supports",
  aspectId: string,
) {
  return {
    toClaimId,
    edgeType,
    aspectId,
    newAspectKey: null,
    confidence: 0.9,
  };
}
