import { describe, expect, test } from "bun:test";

import {
  createInMemoryEvidenceStoreV1,
  createProductMemoryEvidenceIndexV1,
} from "../src/legacy.js";

const scope = Object.freeze({
  tenantId: "tenant",
  userId: "user",
  workspaceId: "workspace",
  repositoryId: "repository",
});

describe("in-memory reference store", () => {
  test("hydrates L1 navigation back to immutable L0 evidence", async () => {
    const store = createInMemoryEvidenceStoreV1({ scope });
    store.putEvidence([
      {
        evidenceRef: "conversation-1#turn-2",
        sourceKind: "user_input",
        sourceSeq: 2,
        authority: "user_asserted",
        hitContent: "I stayed in Kyoto for seven days.",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    store.putCards([
      {
        id: "trip-duration",
        statement: "Kyoto trip lasted seven days",
        sources: [{ ref: "conversation-1#turn-2" }],
      },
    ]);
    const index = createProductMemoryEvidenceIndexV1({
      profile: { scope, maxCards: 8, maxInjectedTokens: 2_048 },
      provider: store,
      archive: store,
    });

    const result = await index.search(
      "How long was my Kyoto trip?",
      new AbortController().signal,
    );

    expect(result.lists.map((list) => list.channel)).toEqual(["l0", "l1"]);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.content).toContain("seven days");
  });

  test("rejects conflicting writes to one immutable evidence address", () => {
    const store = createInMemoryEvidenceStoreV1({ scope });
    const original = {
      evidenceRef: "conversation-1#turn-2",
      sourceKind: "user_input" as const,
      sourceSeq: 2,
      authority: "user_asserted" as const,
      hitContent: "Original evidence",
      createdAt: "2026-08-01T00:00:00.000Z",
    };
    store.putEvidence([original]);
    expect(() =>
      store.putEvidence([{ ...original, hitContent: "Rewritten evidence" }]),
    ).toThrow("MemoryReferenceEvidenceConflict");
  });
});
