import { describe, expect, test } from "bun:test";

import type { MemoryEntry, MemoryStoreEngine } from "@paw/memory/longterm";
import type { MemoryAtomProposalV1 } from "@paw/protocol";

import {
  type MemoryTemporalGraphStoreV1,
  type MemoryTemporalRelationV1,
  type PawNextMemoryScopeV1,
  createMemoryAtomWriterStoreV1,
  createMemoryTemporalRelationV1,
  projectMemoryTrajectoriesV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("memory temporal graph", () => {
  test("recalls conflict candidates from both lexical and vector neighborhoods", async () => {
    const lexical = semantic({
      id: "lexical-memory",
      fact: "The user prefers visual study maps.",
      source: "user_statement",
      tValid: "2025-01-01T00:00:00.000Z",
      tInvalid: null,
    });
    const vector = semantic({
      id: "vector-memory",
      fact: "The user abandoned complicated mind maps.",
      source: "user_statement",
      tValid: "2025-02-01T00:00:00.000Z",
      tInvalid: null,
    });
    const entries = new Map<string, MemoryEntry>([
      [lexical.id, lexical],
      [vector.id, vector],
    ]);
    const base = memoryEngine(entries, () => {});
    const engine: MemoryStoreEngine = {
      ...base,
      async searchText() {
        return [{ id: lexical.id, score: 0.8 }];
      },
      async searchVector() {
        return [
          { id: vector.id, score: 0.9 },
          { id: lexical.id, score: 0.7 },
        ];
      },
    };
    const store = createMemoryAtomWriterStoreV1({ engine, scope });

    const recalled = await store.recall(
      "mind map preference changed",
      8,
      new AbortController().signal,
    );

    expect(recalled.map((item) => item.id)).toEqual([
      "lexical-memory",
      "vector-memory",
    ]);
  });

  test("repairs a failed relation write by replay without duplicating versions", async () => {
    const old = semantic({
      id: "old-memory",
      fact: "Old preference",
      source: "user_statement",
      tValid: "2025-01-01T00:00:00.000Z",
      tInvalid: null,
    });
    const entries = new Map<string, MemoryEntry>([[old.id, old]]);
    let puts = 0;
    const engine = memoryEngine(entries, () => {
      puts += 1;
    });
    const relations = new Map<string, MemoryTemporalRelationV1>();
    let graphAttempts = 0;
    const temporalGraph: MemoryTemporalGraphStoreV1 = {
      scope,
      async put(input) {
        graphAttempts += 1;
        if (graphAttempts === 1) throw new Error("temporary graph failure");
        for (const relation of input) relations.set(relation.id, relation);
      },
      async list() {
        return [...relations.values()];
      },
      async revisionToken() {
        return String(relations.size);
      },
    };
    const store = createMemoryAtomWriterStoreV1({
      engine,
      scope,
      temporalGraph,
    });
    const atom: MemoryAtomProposalV1 = Object.freeze({
      schemaVersion: "paw.memory-atom-proposal.v1",
      atomId: "atom-1",
      kind: "profile",
      action: "update",
      statement: "New preference",
      keywords: Object.freeze(["preference"]),
      authority: "user_asserted",
      confidence: 0.98,
      priority: 90,
      sourceSeqs: Object.freeze([2]),
      targetIds: Object.freeze([old.id]),
      validFrom: "2025-02-01T00:00:00.000Z",
      contentHash: "atom-content-hash",
    });
    const applyInput = Object.freeze({
      writeId: "write-1",
      runId: "run-1",
      repositoryId: scope.repositoryId,
      claimedAt: Date.parse("2025-02-01T00:00:00.000Z"),
      atoms: Object.freeze([atom]),
    });

    await expect(
      store.apply(applyInput, new AbortController().signal),
    ).rejects.toThrow("temporary graph failure");
    expect(entries.get(old.id)?.tInvalid).toBe("2025-02-01T00:00:00.000Z");

    const replay = await store.apply(applyInput, new AbortController().signal);
    expect(replay.storedIds).toHaveLength(1);
    expect(puts).toBe(1);
    expect(graphAttempts).toBe(2);
    expect(relations.size).toBe(1);
    expect([...relations.values()][0]).toMatchObject({
      fromMemoryId: replay.storedIds[0],
      toMemoryId: old.id,
      relationType: "supersedes",
      sourceRefs: ["atom:atom-1", "run:run-1", "write:write-1"],
    });
  });

  test("projects an explicit cross-source chain from oldest to newest", () => {
    const old = semantic({
      id: "old",
      fact: "Old",
      source: "user_statement",
      tValid: "2025-01-01T00:00:00.000Z",
      tInvalid: "2025-02-01T00:00:00.000Z",
    });
    const middle = semantic({
      id: "middle",
      fact: "Middle",
      source: "agent_verified",
      tValid: "2025-02-01T00:00:00.000Z",
      tInvalid: "2025-03-01T00:00:00.000Z",
    });
    const current = semantic({
      id: "current",
      fact: "Current",
      source: "repo_docs",
      tValid: "2025-03-01T00:00:00.000Z",
      tInvalid: null,
    });
    const relations = [
      createMemoryTemporalRelationV1({
        scope,
        fromMemoryId: middle.id,
        toMemoryId: old.id,
        relationType: "supersedes",
        createdAt: middle.tValid,
      }),
      createMemoryTemporalRelationV1({
        scope,
        fromMemoryId: current.id,
        toMemoryId: middle.id,
        relationType: "supersedes",
        createdAt: current.tValid,
      }),
    ];

    const trajectories = projectMemoryTrajectoriesV1({
      entries: [current, old, middle],
      relations,
    });
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0]).toMatchObject({
      stateCount: 3,
      sourceCount: 3,
      truncated: false,
    });
    expect(trajectories[0]?.states.map((state) => state.memoryId)).toEqual([
      "old",
      "middle",
      "current",
    ]);
    expect(trajectories[0]?.states.map((state) => state.status)).toEqual([
      "historical",
      "historical",
      "current",
    ]);
  });

  test("rejects cycles instead of inventing a temporal order", () => {
    const first = semantic({
      id: "first",
      fact: "First",
      source: "user_statement",
      tValid: "2025-01-01T00:00:00.000Z",
      tInvalid: null,
    });
    const second = semantic({
      id: "second",
      fact: "Second",
      source: "agent_verified",
      tValid: "2025-02-01T00:00:00.000Z",
      tInvalid: null,
    });
    const relations = [
      createMemoryTemporalRelationV1({
        scope,
        fromMemoryId: first.id,
        toMemoryId: second.id,
        relationType: "supersedes",
        createdAt: first.tValid,
      }),
      createMemoryTemporalRelationV1({
        scope,
        fromMemoryId: second.id,
        toMemoryId: first.id,
        relationType: "supersedes",
        createdAt: second.tValid,
      }),
    ];

    expect(() =>
      projectMemoryTrajectoriesV1({ entries: [first, second], relations }),
    ).toThrow("MemoryTrajectoryCycleDetected");
  });
});

function semantic(
  input: Readonly<{
    id: string;
    fact: string;
    source: MemoryEntry["source"];
    tValid: string;
    tInvalid: string | null;
  }>,
): MemoryEntry {
  return Object.freeze({
    id: input.id,
    kind: "semantic",
    repo: scope.repositoryId,
    created: input.tValid,
    tValid: input.tValid,
    tInvalid: input.tInvalid,
    source: input.source,
    confidence: 0.9,
    evidence: [`evidence:${input.id}`],
    freq: 0,
    utility: 0,
    fact: input.fact,
    keywords: [input.id],
    embeddingKey: `${input.fact} ${input.id}`,
  });
}

function memoryEngine(
  entries: Map<string, MemoryEntry>,
  onPut: () => void,
): MemoryStoreEngine {
  return {
    scope,
    async put(entry) {
      onPut();
      entries.set(entry.id, entry);
    },
    async get(id) {
      return entries.get(id) ?? null;
    },
    async invalidate(id, tInvalid) {
      const entry = entries.get(id);
      if (entry) entries.set(id, { ...entry, tInvalid } as MemoryEntry);
    },
    async delete(id) {
      entries.delete(id);
    },
    async query() {
      return [...entries.values()];
    },
    async searchText() {
      return [];
    },
    async searchVector() {
      return [];
    },
    async ledger() {
      return null;
    },
    async bumpLedger() {},
    async reindex() {
      return {
        scanned: 0,
        indexed: 0,
        failed: 0,
        smoke: { total: 0, passed: 0, failedIds: [] },
      };
    },
  };
}
