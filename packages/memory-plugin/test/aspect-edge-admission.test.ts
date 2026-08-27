import { describe, expect, test } from "bun:test";

import {
  type PawNextMemoryScopeV1,
  applyMemoryAspectGraphMutationV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createMemoryAspectClaimV1,
  createMemoryAspectV1,
  createMemoryClaimAspectMembershipV1,
  createMemoryEvidenceEdgeV1,
  deriveMemoryAspectLinkStatementHashV1,
  evaluateMemoryAspectEdgeAdmissionV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-admission",
  userId: "user-admission",
  workspaceId: "workspace-admission",
  repositoryId: "repo-admission",
});
const jan = "2025-01-01T00:00:00.000Z";
const feb = "2025-02-01T00:00:00.000Z";

describe("aspect edge admission policy", () => {
  test("admits role-grounded evidence but rejects generic topical supports", () => {
    const setup = setupGraph();
    const eventSupport = edge(
      setup.aspectId,
      "workshop",
      "concise-current",
      "supports",
    );
    const genericSupport = edge(
      setup.aspectId,
      "friendly-tone",
      "concise-current",
      "supports",
    );
    const result = evaluateMemoryAspectEdgeAdmissionV1({
      snapshot: setup.snapshot,
      edges: [eventSupport, genericSupport],
      catalog: setup.catalog,
    });

    expect(result.admittedEdgeIds).toEqual([eventSupport.id]);
    expect(result.rejectedEdgeIds).toEqual([genericSupport.id]);
    expect(result.decisions.map((item) => item.reasonCode).sort()).toEqual([
      "causal_cue_missing",
      "role_grounded",
    ]);
  });

  test("requires both an explicit transition cue and discriminant overlap", () => {
    const setup = setupGraph();
    const grounded = edge(
      setup.aspectId,
      "concise-current",
      "detailed-old",
      "supersedes",
    );
    const unrelated = edge(
      setup.aspectId,
      "friendly-tone",
      "detailed-old",
      "supersedes",
    );
    const result = evaluateMemoryAspectEdgeAdmissionV1({
      snapshot: setup.snapshot,
      edges: [grounded, unrelated],
      catalog: setup.catalog,
    });

    expect(result.admittedEdgeIds).toEqual([grounded.id]);
    expect(result.rejectedEdgeIds).toEqual([unrelated.id]);
  });
});

function setupGraph() {
  const aspect = createMemoryAspectV1({
    scope,
    identitySeed: "communication",
    displayName: "Communication preferences",
  });
  const claims = [
    claim("detailed-old", jan),
    claim("concise-current", feb),
    claim("friendly-tone", feb),
    createMemoryAspectClaimV1({
      id: "workshop",
      kind: "episode",
      validFrom: feb,
      ingestedAt: feb,
      evidenceRefs: ["l0:workshop"],
    }),
  ];
  const snapshot = applyMemoryAspectGraphMutationV1({
    snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
    claims,
    aspects: [aspect],
    memberships: [
      membership("detailed-old", aspect.id, "state"),
      membership("concise-current", aspect.id, "state"),
      membership("friendly-tone", aspect.id, "state"),
      membership("workshop", aspect.id, "event"),
    ],
  });
  return {
    snapshot,
    aspectId: aspect.id,
    catalog: [
      evidence("detailed-old", "Previously preferred detailed responses"),
      evidence(
        "concise-current",
        "Now switched to concise responses instead of detailed responses",
      ),
      evidence("friendly-tone", "Prefers a friendly conversational tone"),
      evidence(
        "workshop",
        "A writing workshop led to the concise response preference",
      ),
    ],
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
  role: "state" | "event",
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

function edge(
  aspectId: string,
  fromClaimId: string,
  toClaimId: string,
  edgeType: "supports" | "supersedes",
) {
  return createMemoryEvidenceEdgeV1({
    scope,
    fromClaimId,
    toClaimId,
    edgeType,
    stateScope: { aspectId },
    confidence: 0.95,
    effectiveFrom: feb,
    createdAt: feb,
  });
}

function evidence(claimId: string, statement: string) {
  return {
    claimId,
    statement,
    statementHash: deriveMemoryAspectLinkStatementHashV1(statement),
  };
}
