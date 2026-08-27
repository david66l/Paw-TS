import { describe, expect, test } from "bun:test";

import {
  type MemoryAspectGraphSnapshotV1,
  type PawNextMemoryScopeV1,
  applyMemoryAspectGraphMutationV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createMemoryAspectClaimV1,
  createMemoryAspectV1,
  createMemoryClaimAspectMembershipV1,
  createMemoryEvidenceEdgeV1,
  evaluateMemoryAspectGraphStructureV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-eval",
  userId: "user-eval",
  workspaceId: "workspace-eval",
  repositoryId: "repo-eval",
});
const jan = "2025-01-01T00:00:00.000Z";
const feb = "2025-02-01T00:00:00.000Z";
const mar = "2025-03-01T00:00:00.000Z";

describe("aspect graph structural evaluation", () => {
  test("compares semantic grouping without depending on aspect labels or IDs", () => {
    const gold = graph("gold-film", ["a", "b"], ["c"]);
    const predicted = graph("predicted-cinema", ["a", "b"], ["c"]);

    expect(evaluateMemoryAspectGraphStructureV1({ predicted, gold })).toEqual(
      expect.objectContaining({
        aspectPairwise: expect.objectContaining({ f1: 1 }),
        evidenceEdges: expect.objectContaining({ f1: 1 }),
      }),
    );
  });

  test("separates grouping, edge, and current-state failures", () => {
    const goldAspect = createMemoryAspectV1({
      scope,
      identitySeed: "gold",
      displayName: "Gold",
    });
    const predictedAspect = createMemoryAspectV1({
      scope,
      identitySeed: "predicted",
      displayName: "Predicted",
    });
    const old = state("old", jan);
    const current = state("current", feb);
    const extra = state("extra", mar);
    const gold = applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: [old, current, extra],
      aspects: [goldAspect],
      memberships: [
        member(old.id, goldAspect.id),
        member(current.id, goldAspect.id),
      ],
      edges: [supersedes(current.id, old.id, goldAspect.id)],
    });
    const predicted = applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: [old, current, extra],
      aspects: [predictedAspect],
      memberships: [
        member(old.id, predictedAspect.id),
        member(current.id, predictedAspect.id),
        member(extra.id, predictedAspect.id),
      ],
      edges: [supersedes(extra.id, old.id, predictedAspect.id)],
    });
    const result = evaluateMemoryAspectGraphStructureV1({
      predicted,
      gold,
      currentStateCases: [
        {
          predictedAspectId: predictedAspect.id,
          goldAspectId: goldAspect.id,
          asOf: mar,
        },
      ],
    });

    expect(result.aspectPairwise).toEqual(
      expect.objectContaining({ truePositive: 1, falsePositive: 2, f1: 0.5 }),
    );
    expect(result.evidenceEdges).toEqual(
      expect.objectContaining({
        truePositive: 0,
        falsePositive: 1,
        falseNegative: 1,
      }),
    );
    expect(result.currentStateExactMatch).toBe(0);
    expect(result.currentState).toEqual(
      expect.objectContaining({
        truePositive: 1,
        falsePositive: 1,
        falseNegative: 0,
      }),
    );
  });
});

function graph(
  identitySeed: string,
  grouped: readonly string[],
  separate: readonly string[],
): MemoryAspectGraphSnapshotV1 {
  const group = createMemoryAspectV1({
    scope,
    identitySeed,
    displayName: identitySeed,
  });
  const other = createMemoryAspectV1({
    scope,
    identitySeed: `${identitySeed}-other`,
    displayName: `${identitySeed} other`,
  });
  const claims = [...grouped, ...separate].map((id) => state(id, jan));
  return applyMemoryAspectGraphMutationV1({
    snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
    claims,
    aspects: [group, other],
    memberships: [
      ...grouped.map((id) => member(id, group.id)),
      ...separate.map((id) => member(id, other.id)),
    ],
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

function supersedes(fromClaimId: string, toClaimId: string, aspectId: string) {
  return createMemoryEvidenceEdgeV1({
    scope,
    fromClaimId,
    toClaimId,
    edgeType: "supersedes",
    stateScope: { aspectId },
    confidence: 1,
    createdAt: mar,
  });
}
