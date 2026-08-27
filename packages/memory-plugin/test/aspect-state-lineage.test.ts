import { describe, expect, test } from "bun:test";

import {
  type PawNextMemoryScopeV1,
  applyMemoryAspectGraphMutationV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createMemoryAspectClaimV1,
  createMemoryAspectV1,
  createMemoryClaimAspectMembershipV1,
  createMemoryEvidenceEdgeV1,
  projectMemoryAspectStateLineageV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-lineage",
  userId: "user-lineage",
  workspaceId: "workspace-lineage",
  repositoryId: "repo-lineage",
});
const jan = "2025-01-01T00:00:00.000Z";
const feb = "2025-02-01T00:00:00.000Z";
const mar = "2025-03-01T00:00:00.000Z";

describe("anchor-aware aspect state lineage", () => {
  test("keeps two unrelated state lineages apart inside one broad Aspect", () => {
    const setup = broadAspectSetup();
    const projection = projectMemoryAspectStateLineageV1({
      snapshot: setup.snapshot,
      aspectId: setup.aspectId,
      anchorClaimIds: ["detail-current"],
      asOf: mar,
    });

    expect(projection.lineageClaimIds).toEqual([
      "detail-current",
      "detail-old",
    ]);
    expect(projection.currentClaimIds).toEqual(["detail-current"]);
    expect(projection.historicalClaimIds).toEqual(["detail-old"]);
    expect(projection.currentClaimIds).not.toContain("tone-current");
  });

  test("treats same_state as symmetric and keeps qualified variants current", () => {
    const setup = broadAspectSetup();
    const same = createMemoryEvidenceEdgeV1({
      scope,
      fromClaimId: "detail-current",
      toClaimId: "detail-alias",
      edgeType: "same_state",
      stateScope: { aspectId: setup.aspectId },
      confidence: 1,
      effectiveFrom: mar,
      createdAt: mar,
    });
    const qualifies = createMemoryEvidenceEdgeV1({
      scope,
      fromClaimId: "detail-travel",
      toClaimId: "detail-current",
      edgeType: "qualifies",
      stateScope: { aspectId: setup.aspectId },
      confidence: 1,
      effectiveFrom: mar,
      createdAt: mar,
    });
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: setup.snapshot,
      claims: [claim("detail-alias", mar), claim("detail-travel", mar)],
      memberships: [
        membership("detail-alias", setup.aspectId, "state"),
        membership("detail-travel", setup.aspectId, "state"),
      ],
      edges: [same, qualifies],
    });

    const projection = projectMemoryAspectStateLineageV1({
      snapshot,
      anchorClaimIds: ["detail-alias"],
      asOf: mar,
    });
    expect(projection.currentClaimIds).toEqual([
      "detail-current",
      "detail-alias",
      "detail-travel",
    ]);
  });

  test("uses an explicitly supporting event to locate one lineage without merging another", () => {
    const setup = broadAspectSetup();
    const workshop = createMemoryAspectClaimV1({
      id: "writing-workshop",
      kind: "episode",
      validFrom: mar,
      ingestedAt: mar,
      evidenceRefs: ["l0:writing-workshop"],
    });
    const support = createMemoryEvidenceEdgeV1({
      scope,
      fromClaimId: workshop.id,
      toClaimId: "detail-current",
      edgeType: "supports",
      stateScope: { aspectId: setup.aspectId },
      confidence: 1,
      effectiveFrom: mar,
      createdAt: mar,
    });
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: setup.snapshot,
      claims: [workshop],
      memberships: [membership(workshop.id, setup.aspectId, "event")],
      edges: [support],
    });

    const projection = projectMemoryAspectStateLineageV1({
      snapshot,
      anchorClaimIds: [workshop.id],
      asOf: mar,
    });
    expect(projection.currentClaimIds).toEqual(["detail-current"]);
    expect(projection.eventClaimIds).toEqual([workshop.id]);
    expect(projection.lineageClaimIds).not.toContain("tone-current");
  });

  test("fails closed when anchors select different disconnected lineages", () => {
    const setup = broadAspectSetup();
    expect(() =>
      projectMemoryAspectStateLineageV1({
        snapshot: setup.snapshot,
        anchorClaimIds: ["detail-current", "tone-current"],
        asOf: mar,
      }),
    ).toThrow("MemoryAspectStateLineageAmbiguous");
  });
});

function broadAspectSetup() {
  const aspect = createMemoryAspectV1({
    scope,
    identitySeed: "communication",
    displayName: "Communication preferences",
  });
  const detailOld = claim("detail-old", jan);
  const detailCurrent = claim("detail-current", feb);
  const toneCurrent = claim("tone-current", jan);
  const snapshot = applyMemoryAspectGraphMutationV1({
    snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
    claims: [detailOld, detailCurrent, toneCurrent],
    aspects: [aspect],
    memberships: [
      membership(detailOld.id, aspect.id, "state"),
      membership(detailCurrent.id, aspect.id, "state"),
      membership(toneCurrent.id, aspect.id, "state"),
    ],
    edges: [
      createMemoryEvidenceEdgeV1({
        scope,
        fromClaimId: detailCurrent.id,
        toClaimId: detailOld.id,
        edgeType: "supersedes",
        stateScope: { aspectId: aspect.id },
        confidence: 1,
        effectiveFrom: feb,
        createdAt: feb,
      }),
    ],
  });
  return { snapshot, aspectId: aspect.id };
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
