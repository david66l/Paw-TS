import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  closeSql,
  getSql,
  ping,
} from "../../packages/memory/src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../../packages/memory/src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../../packages/memory/src/longterm/store/id.js";
import type { SemanticFact } from "../../packages/memory/src/longterm/store/engine.js";

// A unique scope and exact-ID cleanup leave existing desktop memories intact.
assert(process.env.DATABASE_URL, "Configure DATABASE_URL before running");
const scope = {
  tenantId: "paw-local-smoke",
  userId: "smoke",
  workspaceId: randomUUID(),
  repositoryId: "paw-local-smoke",
};
const engine = new PostgresMemoryStoreEngine(scope);
const other = new PostgresMemoryStoreEngine({
  ...scope,
  workspaceId: randomUUID(),
});
const now = new Date().toISOString();
const entry: SemanticFact = {
  id: "",
  kind: "semantic",
  repo: scope.repositoryId,
  created: now,
  tValid: now,
  tInvalid: null,
  source: "agent_verified",
  confidence: 1,
  evidence: ["local-memory-smoke:assertions"],
  freq: 0,
  utility: 0,
  fact: "Paw local memory smoke checks durable PostgreSQL retrieval.",
  keywords: ["durable", "retrieval"],
  embeddingKey: "durable retrieval",
};
entry.id = deriveEntryId(entry, scope);
try {
  assert(await ping(), "PostgreSQL ping failed");
  await engine.put(entry);
  assert.equal((await engine.get(entry.id))?.id, entry.id);
  assert(
    (await engine.searchText("durable", 8, scope.repositoryId)).some(
      (row) => row.id === entry.id,
    ),
  );
  assert(
    (
      await engine.searchVector("durable retrieval", 8, scope.repositoryId)
    ).some((row) => row.id === entry.id),
  );
  assert.equal(await other.get(entry.id), null);
  assert.equal(
    (await other.searchText("durable", 8, scope.repositoryId)).length,
    0,
  );
  assert.equal(
    (await other.searchVector("durable retrieval", 8, scope.repositoryId))
      .length,
    0,
  );
  await closeSql();
  assert.equal(
    (await new PostgresMemoryStoreEngine(scope).get(entry.id))?.id,
    entry.id,
  );
  console.log(
    JSON.stringify({
      ping: true,
      write: true,
      read: true,
      lexical: true,
      vector: true,
      scopeIsolation: true,
      reconnectPersistence: true,
    }),
  );
} finally {
  try {
    await engine.delete(entry.id);
    assert.equal(await engine.get(entry.id), null);
    const rows =
      await getSql()`SELECT count(*)::int AS count FROM memory_embeddings WHERE memory_id = ${entry.id}`;
    assert.equal(rows[0]?.count, 0);
    console.log(JSON.stringify({ exactIdCleanup: true }));
  } finally {
    await closeSql();
  }
}
