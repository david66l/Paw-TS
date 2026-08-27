import { describe, expect, test } from "bun:test";

import type { MemoryAtomProposalV1 } from "@paw/protocol";

import {
  type MemoryAtomWriterStoreV1,
  buildMemoryAtomConflictResolutionRequestV1,
  createJsonMemoryAtomConflictResolverV1,
  reconcileMemoryAtomsV1,
} from "../src/index.js";

describe("memory atom conflict resolver", () => {
  test("separates immutable extraction content from ID-only temporal action", async () => {
    const atom = memoryAtom({
      atomId: "new-state",
      action: "store",
      statement:
        "Malia abandoned complex mind maps after they became overwhelming.",
    });
    const store: MemoryAtomWriterStoreV1 = {
      async recall() {
        return [
          {
            id: "old-profile",
            kind: "profile",
            statement: "Malia prefers mind maps for studying.",
            source: "user_statement",
            confidence: 0.95,
            validFrom: "2025-01-01T00:00:00.000Z",
          },
        ];
      },
      async apply() {
        throw new Error("not used");
      },
    };
    const resolver = createJsonMemoryAtomConflictResolverV1({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: JSON.stringify({
              decisions: [
                {
                  atomId: "new-state",
                  action: "update",
                  targetIds: ["old-profile"],
                },
              ],
            }),
          };
        },
      },
    });

    const result = await reconcileMemoryAtomsV1({
      atoms: [atom],
      seedCandidates: [],
      store,
      resolver,
      observedAt: "2025-02-01T00:00:00.000Z",
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("completed");
    expect(result.candidateCount).toBe(1);
    expect(result.revisedDecisionCount).toBe(1);
    expect(result.atoms[0]).toMatchObject({
      atomId: "new-state",
      action: "update",
      targetIds: ["old-profile"],
      validFrom: "2025-02-01T00:00:00.000Z",
      statement: atom.statement,
    });
    expect(result.atoms[0]?.contentHash).not.toBe(atom.contentHash);
  });

  test("keeps the extracted proposal when the second-stage model invents a target", async () => {
    const atom = memoryAtom({ atomId: "new-state", action: "store" });
    const store: MemoryAtomWriterStoreV1 = {
      async recall() {
        return [
          {
            id: "known",
            kind: "profile",
            statement: "Known state",
            source: "user_statement",
            confidence: 1,
          },
        ];
      },
      async apply() {
        throw new Error("not used");
      },
    };
    const resolver = createJsonMemoryAtomConflictResolverV1({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: '{"decisions":[{"atomId":"new-state","action":"update","targetIds":["invented"]}]}',
          };
        },
      },
    });

    const result = await reconcileMemoryAtomsV1({
      atoms: [atom],
      seedCandidates: [],
      store,
      resolver,
      observedAt: "2025-02-01T00:00:00.000Z",
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("fallback");
    expect(result.atoms).toEqual([atom]);
  });

  test("prompt carries chronology but forbids content rewriting", () => {
    const request = buildMemoryAtomConflictResolutionRequestV1({
      observedAt: "2025-02-01T00:00:00.000Z",
      atoms: [memoryAtom({ atomId: "new-state" })],
      pools: [{ atomId: "new-state", candidates: [] }],
    });
    expect(request.system).toContain("never rewrite the content");
    expect(request.system).toContain("preserve chronology");
    expect(request.user).toContain("2025-02-01T00:00:00.000Z");
  });
});

function memoryAtom(
  overrides: Partial<MemoryAtomProposalV1> = {},
): MemoryAtomProposalV1 {
  return Object.freeze({
    schemaVersion: "paw.memory-atom-proposal.v1",
    atomId: "atom-1",
    kind: "profile",
    action: "store",
    statement: "The user's current study preference changed.",
    keywords: Object.freeze(["study", "preference"]),
    authority: "user_asserted",
    confidence: 0.95,
    priority: 80,
    sourceSeqs: Object.freeze([1]),
    targetIds: Object.freeze([]),
    contentHash: "old-content-hash",
    ...overrides,
  });
}
