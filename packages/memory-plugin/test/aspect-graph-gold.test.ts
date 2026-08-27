import { describe, expect, test } from "bun:test";

import {
  type MemoryAspectGraphSnapshotV1,
  type PawNextMemoryScopeV1,
  applyMemoryAspectGraphMutationV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createMemoryAspectClaimV1,
  createMemoryAspectGraphGoldV1,
  createMemoryAspectV1,
  createMemoryClaimAspectMembershipV1,
  createMemoryEvidenceEdgeV1,
  evaluateMemoryAspectGraphGoldV1,
  parseMemoryAspectGraphGoldV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-gold",
  userId: "user-gold",
  workspaceId: "workspace-gold",
  repositoryId: "repo-gold",
});
const jan = "2025-01-01T00:00:00.000Z";
const feb = "2025-02-01T00:00:00.000Z";
const mar = "2025-03-01T00:00:00.000Z";

describe("aspect graph sparse gold gate", () => {
  test("scores pair, edge, and current-state annotations independently", () => {
    const goldSnapshot = graph(false, true);
    const gold = createMemoryAspectGraphGoldV1({
      snapshot: goldSnapshot,
      annotationSetId: "fixture-v1",
      pairs: [
        { leftClaimId: "old", rightClaimId: "current", sameAspect: true },
        { leftClaimId: "current", rightClaimId: "other", sameAspect: false },
      ],
      edges: [
        {
          fromClaimId: "current",
          toClaimId: "old",
          edgeType: "supersedes",
          present: true,
        },
        {
          fromClaimId: "other",
          toClaimId: "old",
          edgeType: "supports",
          present: false,
        },
      ],
      currentStates: [
        { anchorClaimIds: ["old"], asOf: mar, currentClaimIds: ["current"] },
      ],
    });

    const perfect = evaluateMemoryAspectGraphGoldV1(goldSnapshot, gold);
    expect(perfect.pairwise.accuracy).toBe(1);
    expect(perfect.evidenceEdges.accuracy).toBe(1);
    expect(perfect.currentStateExactMatch).toBe(1);

    const wrong = evaluateMemoryAspectGraphGoldV1(graph(true, false), gold);
    expect(wrong.pairwise).toEqual(
      expect.objectContaining({
        total: 2,
        correct: 1,
        falsePositive: 1,
      }),
    );
    expect(wrong.evidenceEdges).toEqual(
      expect.objectContaining({ total: 2, correct: 1, falseNegative: 1 }),
    );
    expect(wrong.currentStateExactMatch).toBe(0);
  });

  test("requires anchors to identify one state instead of unioning topics", () => {
    const base = graph(false, true);
    const unrelated = base.aspects.find(
      (item) => item.displayName === "Unrelated",
    );
    if (unrelated === undefined) throw new Error("missing fixture aspect");
    const ambiguous = applyMemoryAspectGraphMutationV1({
      snapshot: base,
      memberships: [member("old", unrelated.id)],
    });
    const ambiguousGold = createMemoryAspectGraphGoldV1({
      snapshot: ambiguous,
      annotationSetId: "ambiguous-anchor-v1",
      currentStates: [
        { anchorClaimIds: ["old"], asOf: mar, currentClaimIds: ["current"] },
      ],
    });
    expect(() =>
      evaluateMemoryAspectGraphGoldV1(ambiguous, ambiguousGold),
    ).toThrow("MemoryAspectGoldCurrentStateAnchorAmbiguous");

    const disambiguatedGold = createMemoryAspectGraphGoldV1({
      snapshot: ambiguous,
      annotationSetId: "disambiguated-anchor-v1",
      currentStates: [
        {
          anchorClaimIds: ["old", "current"],
          asOf: mar,
          currentClaimIds: ["current"],
        },
      ],
    });
    expect(
      evaluateMemoryAspectGraphGoldV1(ambiguous, disambiguatedGold)
        .currentStateExactMatch,
    ).toBe(1);
  });

  test("parses only exact fields and binds annotations to the claim corpus", () => {
    const snapshot = graph(false, true);
    const gold = createMemoryAspectGraphGoldV1({
      snapshot,
      annotationSetId: "strict-v1",
      pairs: [
        { leftClaimId: "old", rightClaimId: "current", sameAspect: true },
      ],
    });

    expect(
      parseMemoryAspectGraphGoldV1(JSON.parse(JSON.stringify(gold)), snapshot),
    ).toEqual(gold);
    expect(() =>
      parseMemoryAspectGraphGoldV1(
        { ...gold, corpusRevision: "wrong" },
        snapshot,
      ),
    ).toThrow("MemoryAspectGoldCorpusRevisionMismatch");
    expect(() =>
      parseMemoryAspectGraphGoldV1(
        { ...gold, benchmarkAnswer: "must-not-enter-structure-gold" },
        snapshot,
      ),
    ).toThrow("MemoryAspectGoldRecordFieldsInvalid");
  });
});

function graph(
  putOtherInSameAspect: boolean,
  includeSupersedes: boolean,
): MemoryAspectGraphSnapshotV1 {
  const preference = createMemoryAspectV1({
    scope,
    identitySeed: "preference",
    displayName: "Preference",
  });
  const unrelated = createMemoryAspectV1({
    scope,
    identitySeed: "unrelated",
    displayName: "Unrelated",
  });
  const claims = [
    state("old", jan),
    state("current", feb),
    state("other", jan),
  ];
  return applyMemoryAspectGraphMutationV1({
    snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
    claims,
    aspects: [preference, unrelated],
    memberships: [
      member("old", preference.id),
      member("current", preference.id),
      member("other", putOtherInSameAspect ? preference.id : unrelated.id),
    ],
    edges: includeSupersedes
      ? [
          createMemoryEvidenceEdgeV1({
            scope,
            fromClaimId: "current",
            toClaimId: "old",
            edgeType: "supersedes",
            stateScope: { aspectId: preference.id },
            confidence: 1,
            createdAt: mar,
          }),
        ]
      : [],
  });
}

function state(id: string, validFrom: string) {
  return createMemoryAspectClaimV1({
    id,
    kind: "assertion",
    validFrom,
    ingestedAt: validFrom,
    evidenceRefs: [`l0:${id}`],
  });
}

function member(claimId: string, aspectId: string) {
  return createMemoryClaimAspectMembershipV1({
    scope,
    claimId,
    aspectId,
    role: "state",
    confidence: 1,
    createdAt: mar,
  });
}
