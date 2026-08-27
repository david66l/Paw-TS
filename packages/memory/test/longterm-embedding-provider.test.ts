import { afterAll, describe, expect, test } from "bun:test";

import { closeSql, getSql, ping } from "../src/db/connection.js";
import type {
  MemoryEmbeddingService,
  SemanticFact,
} from "../src/longterm/store/engine.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { createMemoryScopeKey } from "../src/longterm/store/scope-key.js";

process.env.DATABASE_URL ??=
  "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;
const run = Date.now().toString(36);
const id = `semantic-embedding-provider-${run}`;
const scope = createMemoryScopeKey({
  tenantId: "embedding-provider-test",
  userId: "embedding-provider-test",
  workspaceId: `workspace-${run}`,
  repositoryId: `repository-${run}`,
});

function embedding(model: string, index: number): MemoryEmbeddingService {
  return Object.freeze({
    dimensions: 1_536,
    model,
    version: "1",
    async embed() {
      const vector = new Array<number>(1_536).fill(0);
      vector[index] = 1;
      return vector;
    },
  });
}

afterAll(async () => {
  if (dbOk) {
    const sql = getSql();
    await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
    await sql`DELETE FROM memory_items WHERE id = ${id}`;
  }
  await closeSql();
});

describe("long-term embedding provider identity", () => {
  test("rejects a provider that cannot satisfy the pgvector schema", () => {
    expect(
      () =>
        new PostgresMemoryStoreEngine(scope, {
          embedding: {
            dimensions: 3,
            model: "bad-dimensions",
            version: "1",
            async embed() {
              return [1, 0, 0];
            },
          },
        }),
    ).toThrow("1536 dimensions");
  });

  test("requires an exact scope before inspecting derived-index coverage", async () => {
    await expect(
      new PostgresMemoryStoreEngine().inspectDerivedIndexCoverage({
        ids: [id],
        requireEmbedding: true,
      }),
    ).rejects.toThrow("scoped store");
  });

  it("does not query vectors written by another model until reindex", async () => {
    const engineA = new PostgresMemoryStoreEngine(scope, {
      embedding: embedding("dense-a", 10),
    });
    const engineB = new PostgresMemoryStoreEngine(scope, {
      embedding: embedding("dense-b", 20),
    });
    const now = new Date().toISOString();
    const entry: SemanticFact = {
      id,
      kind: "semantic",
      repo: scope.repositoryId,
      created: now,
      tValid: now,
      tInvalid: null,
      source: "repo_docs",
      confidence: 1,
      evidence: ["repo:docs/embedding.md"],
      freq: 0,
      utility: 0,
      fact: "Embedding model identity must seal the derived vector index.",
      keywords: ["embedding", "identity"],
      embeddingKey: "embedding model identity vector index",
    };
    await engineA.put(entry);

    expect(
      await engineA.inspectDerivedIndexCoverage({
        ids: [id, id],
        requireEmbedding: true,
      }),
    ).toMatchObject({
      expectedCount: 1,
      itemCount: 1,
      embeddingCount: 1,
      missingItemIds: [],
      missingEmbeddingIds: [],
      complete: true,
    });
    expect(
      await engineB.inspectDerivedIndexCoverage({
        ids: [id, `${id}-missing`],
        requireEmbedding: true,
      }),
    ).toMatchObject({
      expectedCount: 2,
      itemCount: 1,
      embeddingCount: 0,
      missingItemIds: [`${id}-missing`],
      missingEmbeddingIds: [id, `${id}-missing`],
      complete: false,
    });
    expect(
      await engineB.inspectDerivedIndexCoverage({
        ids: [id],
        requireEmbedding: false,
      }),
    ).toMatchObject({
      itemCount: 1,
      embeddingCount: 0,
      missingEmbeddingIds: [],
      complete: true,
    });

    expect(
      (await engineA.searchVector("probe", 5)).map((hit) => hit.id),
    ).toContain(id);
    expect(
      (await engineB.searchVector("probe", 5)).map((hit) => hit.id),
    ).not.toContain(id);
    expect(await engineA.retrievalRevisionToken()).not.toBe(
      await engineB.retrievalRevisionToken(),
    );

    const report = await engineB.reindex();
    expect(report.indexed).toBeGreaterThanOrEqual(1);
    expect(
      await engineB.inspectDerivedIndexCoverage({
        ids: [id],
        requireEmbedding: true,
      }),
    ).toMatchObject({
      itemCount: 1,
      embeddingCount: 1,
      complete: true,
    });
    expect(
      (await engineB.searchVector("probe", 5)).map((hit) => hit.id),
    ).toContain(id);
    const rows = await getSql()`
      SELECT embedding_model, embedding_version
      FROM memory_embeddings
      WHERE memory_id = ${id}
    `;
    expect(rows[0]).toMatchObject({
      embedding_model: "dense-b",
      embedding_version: "1",
    });
  });
});
