import { describe, expect, test } from "bun:test";

import {
  type MemoryAspectEdgeLinkerEventV1,
  type MemoryAspectEdgeLinkingInputV1,
  type PawNextMemoryScopeV1,
  applyMemoryAspectEdgeLinkingV1,
  applyMemoryAspectGraphMutationV1,
  buildMemoryAspectEdgeCandidatesV1,
  buildMemoryAspectEdgeLinkerRequestV1,
  buildMemoryAspectEdgeRecoveryCandidatesV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createJsonMemoryAspectEdgeLinkerV1,
  createMemoryAspectClaimV1,
  createMemoryAspectV1,
  createMemoryClaimAspectMembershipV1,
  deriveMemoryAspectEdgeInputRevisionV1,
  deriveMemoryAspectLinkStatementHashV1,
  parseMemoryAspectEdgeLinkingV1,
  projectMemoryAspectStateV1,
  reconcileMemoryAspectEdgeLinkingsV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-edge",
  userId: "user-edge",
  workspaceId: "workspace-edge",
  repositoryId: "repo-edge",
});
const jan = "2025-01-01T00:00:00.000Z";
const feb = "2025-02-01T00:00:00.000Z";
const mar = "2025-03-01T00:00:00.000Z";

describe("independent aspect edge linker v1", () => {
  test("builds candidates only inside an exact committed state scope", () => {
    const setup = graphSetup();
    const build = buildMemoryAspectEdgeCandidatesV1({
      scope,
      snapshot: setup.snapshot,
      observedAt: mar,
      catalog: setup.catalog,
    });

    expect(build.metrics.sourceScopeCount).toBe(2);
    expect(build.packets).toHaveLength(2);
    const currentPacket = build.packets.find(
      (packet) => packet.source.claimId === "current-detail",
    );
    expect(currentPacket?.aspectId).toBe(setup.detailAspectId);
    expect(currentPacket?.targets.map((target) => target.claimId)).toEqual([
      "old-detail",
    ]);
    expect(currentPacket?.targets[0]?.allowedProposals).toEqual([
      {
        fromClaimId: "current-detail",
        toClaimId: "old-detail",
        edgeType: "same_state",
      },
      {
        fromClaimId: "current-detail",
        toClaimId: "old-detail",
        edgeType: "supersedes",
      },
      {
        fromClaimId: "current-detail",
        toClaimId: "old-detail",
        edgeType: "qualifies",
      },
      {
        fromClaimId: "old-detail",
        toClaimId: "current-detail",
        edgeType: "qualifies",
      },
      {
        fromClaimId: "current-detail",
        toClaimId: "old-detail",
        edgeType: "supports",
      },
      {
        fromClaimId: "old-detail",
        toClaimId: "current-detail",
        edgeType: "supports",
      },
    ]);
    expect(
      currentPacket?.targets.some((target) => target.claimId === "cooking"),
    ).toBe(false);
  });

  test("keeps event pairs supports-only", () => {
    const setup = graphSetup();
    const build = buildMemoryAspectEdgeCandidatesV1({
      scope,
      snapshot: setup.snapshot,
      observedAt: mar,
      catalog: setup.catalog,
    });
    const packet = build.packets.find(
      (item) => item.source.claimId === "detail-workshop",
    );
    expect(packet?.targets[0]?.allowedProposals).toEqual([
      {
        fromClaimId: "detail-workshop",
        toClaimId: "current-detail",
        edgeType: "supports",
      },
      {
        fromClaimId: "current-detail",
        toClaimId: "detail-workshop",
        edgeType: "supports",
      },
    ]);
  });

  test("materializes only edges and lets graph projection consume supersedes", () => {
    const input = currentDetailInput();
    const result = parseMemoryAspectEdgeLinkingV1(
      JSON.stringify({
        decisions: [
          {
            targetClaimId: "old-detail",
            disposition: "edge",
            edge: {
              fromClaimId: "current-detail",
              toClaimId: "old-detail",
              edgeType: "supersedes",
              confidence: 0.93,
            },
          },
        ],
      }),
      input,
    );

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.evidenceRefs).toEqual([
      "l0:current-detail",
      "l0:old-detail",
    ]);
    expect(result.edges[0]?.effectiveFrom).toBe(mar);
    const applied = applyMemoryAspectEdgeLinkingV1(input.snapshot, result);
    expect(applied.aspects).toEqual(input.snapshot.aspects);
    expect(applied.memberships).toEqual(input.snapshot.memberships);
    const projection = projectMemoryAspectStateV1({
      snapshot: applied,
      aspectId: input.aspectId,
      asOf: mar,
    });
    expect(projection.currentClaimIds).toEqual(["current-detail"]);
    expect(projection.historicalClaimIds).toEqual(["old-detail"]);
  });

  test("rejects invented targets, weak confidence, and forbidden event state edges", () => {
    const input = currentDetailInput();
    expect(() =>
      parseMemoryAspectEdgeLinkingV1(
        JSON.stringify({
          decisions: [
            {
              targetClaimId: "old-detail",
              disposition: "edge",
              edge: {
                fromClaimId: "current-detail",
                toClaimId: "invented",
                edgeType: "supports",
                confidence: 0.9,
              },
            },
          ],
        }),
        input,
      ),
    ).toThrow("MemoryAspectEdgeLinkerTargetUnknown");
    expect(() =>
      parseMemoryAspectEdgeLinkingV1(
        JSON.stringify({
          decisions: [
            {
              targetClaimId: "old-detail",
              disposition: "edge",
              edge: {
                fromClaimId: "current-detail",
                toClaimId: "old-detail",
                edgeType: "supersedes",
                confidence: 0.7,
              },
            },
          ],
        }),
        input,
      ),
    ).toThrow("MemoryAspectEdgeLinkerConfidenceTooLow");

    const eventInput = eventPacket();
    expect(() =>
      parseMemoryAspectEdgeLinkingV1(
        JSON.stringify({
          decisions: eventInput.targets.map((target) => ({
            targetClaimId: target.claimId,
            disposition: target.claimId === "old-detail" ? "edge" : "no_edge",
            edge:
              target.claimId === "old-detail"
                ? {
                    fromClaimId: "detail-workshop",
                    toClaimId: "old-detail",
                    edgeType: "supersedes",
                    confidence: 0.9,
                  }
                : null,
          })),
        }),
        eventInput,
      ),
    ).toThrow("MemoryAspectEdgeLinkerEdgeTypeNotAllowed");
  });

  test("has content-addressed input receipts and a stable cache prefix", () => {
    const input = currentDetailInput();
    const request = buildMemoryAspectEdgeLinkerRequestV1(input);
    const adjudication = buildMemoryAspectEdgeLinkerRequestV1(input, {
      mode: "relation_adjudication",
    });
    const packet = JSON.parse(request.user);

    expect(deriveMemoryAspectEdgeInputRevisionV1(input)).toHaveLength(64);
    expect(packet.edgeInputRevision).toBeUndefined();
    expect(packet.graphRevision).toBeUndefined();
    expect(request.system).not.toContain("old-detail");
    expect(request.system).not.toContain("current-detail");
    expect(adjudication.system).toContain("relation-type adjudication");
    expect(adjudication.user).toBe(request.user);
    expect(packet.stateScope).toBeUndefined();
    expect(packet.targets).toEqual([
      {
        claimId: "old-detail",
        allowedProposals: [
          {
            fromClaimId: "current-detail",
            toClaimId: "old-detail",
            edgeType: "same_state",
          },
          {
            fromClaimId: "current-detail",
            toClaimId: "old-detail",
            edgeType: "supersedes",
          },
          {
            fromClaimId: "current-detail",
            toClaimId: "old-detail",
            edgeType: "qualifies",
          },
          {
            fromClaimId: "old-detail",
            toClaimId: "current-detail",
            edgeType: "qualifies",
          },
          {
            fromClaimId: "current-detail",
            toClaimId: "old-detail",
            edgeType: "supports",
          },
          {
            fromClaimId: "old-detail",
            toClaimId: "current-detail",
            edgeType: "supports",
          },
        ],
      },
    ]);
  });

  test("fails invalid model output closed and records content-free events", async () => {
    const input = currentDetailInput();
    const events: MemoryAspectEdgeLinkerEventV1[] = [];
    const linker = createJsonMemoryAspectEdgeLinkerV1({
      model: {
        async complete() {
          return { status: "completed", text: "not-json" };
        },
      },
      onEvent: (event) => events.push(event),
      now: () => 10,
    });
    const result = await linker.link(input, new AbortController().signal);

    expect(result.settlement).toBe("deferred_invalid_proposal");
    expect(result.edges).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "completed",
        settlement: "deferred_invalid_proposal",
        stateScopeHash: expect.any(String),
        sourceReceiptHash: expect.any(String),
        edgeCount: 0,
        reasonCode: "MemoryAspectEdgeLinkerJsonInvalid",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("Now prefers");
    expect(JSON.stringify(events)).not.toContain("current-detail");
  });

  test("uses graph revision as a compare-and-swap boundary", () => {
    const input = currentDetailInput();
    const result = parseMemoryAspectEdgeLinkingV1(
      JSON.stringify({
        decisions: [
          {
            targetClaimId: "old-detail",
            disposition: "no_edge",
            edge: null,
          },
        ],
      }),
      input,
    );
    expect(result.settlement).toBe("settled");
    expect(() =>
      applyMemoryAspectEdgeLinkingV1(
        applyMemoryAspectGraphMutationV1({
          snapshot: input.snapshot,
          claims: [
            createMemoryAspectClaimV1({
              id: "concurrent",
              kind: "assertion",
              validFrom: mar,
              ingestedAt: mar,
              evidenceRefs: ["l0:concurrent"],
            }),
          ],
        }),
        result,
      ),
    ).toThrow("MemoryAspectEdgeLinkerRevisionConflict");
  });

  test("rejects an already active semantic pair before another model call", () => {
    const input = currentDetailInput();
    const linking = parseMemoryAspectEdgeLinkingV1(
      JSON.stringify({
        decisions: [
          {
            targetClaimId: "old-detail",
            disposition: "edge",
            edge: {
              fromClaimId: "current-detail",
              toClaimId: "old-detail",
              edgeType: "supersedes",
              confidence: 0.95,
            },
          },
        ],
      }),
      input,
    );
    const applied = applyMemoryAspectEdgeLinkingV1(input.snapshot, linking);
    expect(() =>
      buildMemoryAspectEdgeLinkerRequestV1({ ...input, snapshot: applied }),
    ).toThrow("MemoryAspectEdgeLinkerTargetInvalid");
  });

  test("reconciles multiple base-revision packets with one graph commit", () => {
    const stateInput = currentDetailInput();
    const eventInput = eventPacket();
    expect(eventInput.snapshot.revision).toBe(stateInput.snapshot.revision);
    const stateLinking = parseMemoryAspectEdgeLinkingV1(
      JSON.stringify({
        decisions: [
          {
            targetClaimId: "old-detail",
            disposition: "edge",
            edge: {
              fromClaimId: "current-detail",
              toClaimId: "old-detail",
              edgeType: "supersedes",
              confidence: 0.95,
            },
          },
        ],
      }),
      stateInput,
    );
    const eventLinking = parseMemoryAspectEdgeLinkingV1(
      JSON.stringify({
        decisions: eventInput.targets.map((target) => ({
          targetClaimId: target.claimId,
          disposition: target.claimId === "current-detail" ? "edge" : "no_edge",
          edge:
            target.claimId === "current-detail"
              ? {
                  fromClaimId: "detail-workshop",
                  toClaimId: "current-detail",
                  edgeType: "supports",
                  confidence: 0.91,
                }
              : null,
        })),
      }),
      eventInput,
    );

    const reconciled = reconcileMemoryAspectEdgeLinkingsV1(
      stateInput.snapshot,
      [stateLinking, eventLinking],
    );
    expect(reconciled.acceptedLinkingRevisions).toHaveLength(2);
    expect(reconciled.rejected).toEqual([]);
    expect(reconciled.snapshot.edges).toHaveLength(2);
    expect(reconciled.snapshot.aspects).toEqual(stateInput.snapshot.aspects);
    expect(reconciled.snapshot.memberships).toEqual(
      stateInput.snapshot.memberships,
    );
  });

  test("isolates only high-signal unresolved pairs for recovery", () => {
    const setup = graphSetup();
    const build = buildMemoryAspectEdgeCandidatesV1({
      scope,
      snapshot: setup.snapshot,
      observedAt: mar,
      catalog: setup.catalog,
    });
    const linkings = build.packets.map((packet) =>
      parseMemoryAspectEdgeLinkingV1(
        JSON.stringify({
          decisions: packet.targets.map((target) => ({
            targetClaimId: target.claimId,
            disposition: "no_edge",
            edge: null,
          })),
        }),
        packet,
      ),
    );
    const recovery = buildMemoryAspectEdgeRecoveryCandidatesV1({
      packets: build.packets,
      linkings,
      maxPackets: 8,
    });

    expect(recovery.metrics.unresolvedPairCount).toBe(3);
    expect(recovery.metrics.selectedPairCount).toBeGreaterThan(0);
    expect(
      recovery.packets.every((packet) => packet.targets.length === 1),
    ).toBe(true);
  });

  test("rechecks generic supports when a specific state relation is allowed", () => {
    const setup = graphSetup();
    const build = buildMemoryAspectEdgeCandidatesV1({
      scope,
      snapshot: setup.snapshot,
      observedAt: mar,
      catalog: setup.catalog,
    });
    const linkings = build.packets.map((packet) =>
      parseMemoryAspectEdgeLinkingV1(
        JSON.stringify({
          decisions: packet.targets.map((target) => {
            const adjudicate =
              packet.source.claimId === "current-detail" &&
              target.claimId === "old-detail";
            return {
              targetClaimId: target.claimId,
              disposition: adjudicate ? "edge" : "no_edge",
              edge: adjudicate
                ? {
                    fromClaimId: "current-detail",
                    toClaimId: "old-detail",
                    edgeType: "supports",
                    confidence: 0.9,
                  }
                : null,
            };
          }),
        }),
        packet,
      ),
    );
    const recovery = buildMemoryAspectEdgeRecoveryCandidatesV1({
      packets: build.packets,
      linkings,
      maxPackets: 8,
    });

    expect(
      recovery.packets.some(
        (packet) =>
          packet.source.claimId === "current-detail" &&
          packet.targets[0]?.claimId === "old-detail",
      ),
    ).toBe(true);
  });
});

function graphSetup() {
  const detail = createMemoryAspectV1({
    scope,
    identitySeed: "response-detail",
    displayName: "Response detail preference",
  });
  const food = createMemoryAspectV1({
    scope,
    identitySeed: "food",
    displayName: "Cooking preference",
  });
  const oldDetail = claim("old-detail", jan);
  const currentDetail = claim("current-detail", feb);
  const workshop = createMemoryAspectClaimV1({
    id: "detail-workshop",
    kind: "episode",
    validFrom: mar,
    ingestedAt: mar,
    evidenceRefs: ["l0:detail-workshop"],
  });
  const cooking = claim("cooking", jan);
  const snapshot = applyMemoryAspectGraphMutationV1({
    snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
    claims: [oldDetail, currentDetail, workshop, cooking],
    aspects: [detail, food],
    memberships: [
      membership(oldDetail.id, detail.id, "state"),
      membership(currentDetail.id, detail.id, "state"),
      membership(workshop.id, detail.id, "event"),
      membership(cooking.id, food.id, "state"),
    ],
  });
  return {
    snapshot,
    detailAspectId: detail.id,
    catalog: [
      evidence(oldDetail.id, "Previously preferred detailed responses"),
      evidence(currentDetail.id, "Now prefers concise responses"),
      evidence(workshop.id, "Attended a concise writing workshop"),
      evidence(cooking.id, "Enjoys cooking"),
    ],
  };
}

function currentDetailInput(): MemoryAspectEdgeLinkingInputV1 {
  return packetFor("current-detail");
}

function eventPacket(): MemoryAspectEdgeLinkingInputV1 {
  return packetFor("detail-workshop");
}

function packetFor(sourceClaimId: string): MemoryAspectEdgeLinkingInputV1 {
  const setup = graphSetup();
  const build = buildMemoryAspectEdgeCandidatesV1({
    scope,
    snapshot: setup.snapshot,
    observedAt: mar,
    catalog: setup.catalog,
  });
  const packet = build.packets.find(
    (item) => item.source.claimId === sourceClaimId,
  );
  if (packet === undefined) throw new Error("test packet missing");
  return packet;
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

function evidence(claimId: string, statement: string) {
  return {
    claimId,
    statement,
    statementHash: deriveMemoryAspectLinkStatementHashV1(statement),
  };
}
