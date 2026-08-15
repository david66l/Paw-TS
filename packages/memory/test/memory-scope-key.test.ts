import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getSql } from "../src/db/connection.js";
import {
  type MemoryScopeKey,
  MemoryWritePipeline,
  PostgresMemoryStoreEngine,
  type SemanticFact,
  createMemoryScopeKey,
  deriveEntryId,
  memoryScopeFingerprint,
  sameMemoryScope,
} from "../src/longterm/index.js";
import {
  addTrialLesson,
  getTrialLesson,
  listTrialLessons,
  removeTrialLesson,
} from "../src/longterm/write/trial.js";
import {
  MemoryRuntimeV2,
  getMemoryV2CoreForTests,
  resetMemoryV2Core,
} from "../src/runtime/memory-runtime-v2.js";
import { resolveScope } from "../src/runtime/scope.js";

process.env.DATABASE_URL ??=
  "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const scopeA = createMemoryScopeKey({
  tenantId: "tenant-a",
  userId: "user-a",
  workspaceId: "workspace-a",
  repositoryId: "shared-repository",
});
const scopeB = createMemoryScopeKey({
  ...scopeA,
  tenantId: "tenant-b",
});

function fact(): SemanticFact {
  const now = new Date(0).toISOString();
  return {
    id: "",
    kind: "semantic",
    repo: "shared-repository",
    created: now,
    tValid: now,
    tInvalid: null,
    source: "agent_verified",
    confidence: 0.9,
    evidence: [],
    freq: 0,
    utility: 0,
    fact: "The repository uses a tenant-aware cache key.",
    keywords: ["tenant", "cache"],
    embeddingKey: "tenant cache",
  };
}

describe("MemoryScopeKey", () => {
  test("same repository content receives distinct physical IDs by tenant", () => {
    expect(sameMemoryScope(scopeA, scopeB)).toBe(false);
    expect(memoryScopeFingerprint(scopeA)).not.toBe(
      memoryScopeFingerprint(scopeB),
    );
    expect(deriveEntryId(fact(), scopeA)).not.toBe(
      deriveEntryId(fact(), scopeB),
    );
  });

  test("rejects empty or control-character identity parts", () => {
    expect(() => createMemoryScopeKey({ ...scopeA, tenantId: "  " })).toThrow(
      "Invalid memory scope tenantId",
    );
    expect(() =>
      createMemoryScopeKey({ ...scopeA, userId: "bad\nuser" }),
    ).toThrow("Invalid memory scope userId");
  });

  test("runtime resolves tenant/user/workspace/repository as one key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-scope-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        tenant_id: "tenant-settings",
        user_id: "user-settings",
        workspace_id: "workspace-settings",
        repository_id: "repository-settings",
      }),
    );
    expect(resolveScope({ workspaceRoot: dir })).toMatchObject({
      tenantId: "tenant-settings",
      userId: "user-settings",
      workspaceId: "workspace-settings",
      repositoryId: "repository-settings",
    });
  });

  test("pipeline refuses an engine or event from another scope before DB I/O", async () => {
    expect(
      () =>
        new MemoryWritePipeline({
          scope: scopeA,
          engine: new PostgresMemoryStoreEngine(scopeB),
        }),
    ).toThrow("does not match");

    const pipeline = new MemoryWritePipeline({
      scope: scopeA,
      engine: new PostgresMemoryStoreEngine(scopeA),
    });
    await expect(
      pipeline.processEvent({
        type: "session_finalize",
        conversationId: "conversation",
        scope: scopeB,
      }),
    ).rejects.toThrow("outside the pipeline scope");
  });

  test("scoped engine exposes an immutable normalized boundary", () => {
    const input: MemoryScopeKey = { ...scopeA };
    const engine = new PostgresMemoryStoreEngine(input);
    expect(engine.scope).toEqual(scopeA);
    expect(Object.isFrozen(engine.scope)).toBe(true);
  });

  test("runtime cores and workers are partitioned by the full scope key", async () => {
    resetMemoryV2Core();
    const runtimeA = new MemoryRuntimeV2({
      workspaceRoot: ".",
      ...scopeA,
      llm: null,
    });
    const runtimeB = new MemoryRuntimeV2({
      workspaceRoot: ".",
      ...scopeB,
      llm: null,
    });
    expect(getMemoryV2CoreForTests(scopeA)).not.toBeNull();
    expect(getMemoryV2CoreForTests(scopeB)).not.toBeNull();
    expect(getMemoryV2CoreForTests(scopeA)).not.toBe(
      getMemoryV2CoreForTests(scopeB),
    );
    await runtimeA.shutdown();
    await runtimeB.shutdown();
    expect(getMemoryV2CoreForTests(scopeA)).toBeNull();
    expect(getMemoryV2CoreForTests(scopeB)).toBeNull();
    resetMemoryV2Core();
  });

  test("DB red team: same repo tenants cannot read, mutate, claim, or trial each other's state", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const repositoryId = `scope-red-team-${suffix}`;
    const a = createMemoryScopeKey({
      ...scopeA,
      tenantId: `tenant-a-${suffix}`,
      repositoryId,
    });
    const b = createMemoryScopeKey({
      ...scopeB,
      tenantId: `tenant-b-${suffix}`,
      repositoryId,
    });
    const engineA = new PostgresMemoryStoreEngine(a);
    const engineB = new PostgresMemoryStoreEngine(b);
    const entryA = { ...fact(), repo: repositoryId };
    const entryB = { ...fact(), repo: repositoryId };
    const sql = getSql();
    const runA = `scope-run-a-${suffix}`;
    const runB = `scope-run-b-${suffix}`;

    try {
      await engineA.put(entryA);
      await engineB.put(entryB);
      const idA = deriveEntryId(entryA, a);
      const idB = deriveEntryId(entryB, b);
      expect(idA).not.toBe(idB);
      expect(await engineA.get(idA)).not.toBeNull();
      expect(await engineA.get(idB)).toBeNull();
      expect(
        (await engineA.query({ limit: 20 })).map((entry) => entry.id),
      ).toContain(idA);
      expect(
        (await engineA.query({ limit: 20 })).map((entry) => entry.id),
      ).not.toContain(idB);

      await engineB.invalidate(idA, new Date().toISOString());
      await engineB.bumpLedger(idA, "freq");
      await engineB.delete(idA);
      expect((await engineA.get(idA))?.tInvalid).toBeNull();
      expect(await engineA.ledger(idA)).toEqual({ freq: 0, utility: 0 });

      const stored = await sql`
        SELECT scope FROM memory_items WHERE id = ${idA}
      `;
      expect(stored[0]?.scope).toEqual(a);

      const trialA = await addTrialLesson(
        "I should isolate tenant state.",
        runA,
        {
          scope: a,
        },
      );
      const trialB = await addTrialLesson(
        "I should isolate tenant state.",
        runA,
        {
          scope: b,
        },
      );
      expect(trialA.id).not.toBe(trialB.id);
      expect(await getTrialLesson(trialA.id, b)).toBeNull();
      expect(
        (await listTrialLessons(undefined, a)).map((trial) => trial.id),
      ).toEqual([trialA.id]);

      const pipelineA = new MemoryWritePipeline({ scope: a, engine: engineA });
      const pipelineB = new MemoryWritePipeline({ scope: b, engine: engineB });
      await pipelineA.enqueue({
        type: "session_finalize",
        conversationId: runA,
        runId: runA,
        goal: "tenant A finalization",
      });
      await pipelineB.enqueue({
        type: "session_finalize",
        conversationId: runB,
        runId: runB,
        goal: "tenant B finalization",
      });
      expect(await pipelineB.processNext()).toBe(true);
      const statuses = await sql`
        SELECT payload->>'runId' AS run_id, status
        FROM outbox_events
        WHERE payload->>'runId' IN (${runA}, ${runB})
        ORDER BY payload->>'runId'
      `;
      expect(
        Array.from(statuses, (row) => ({
          run_id: row.run_id as string,
          status: row.status as string,
        })),
      ).toEqual([
        { run_id: runA, status: "pending" },
        { run_id: runB, status: "published" },
      ]);
    } finally {
      await sql`DELETE FROM outbox_events WHERE payload->>'runId' IN (${runA}, ${runB})`;
      await sql`DELETE FROM memory_trial_lessons WHERE scope->>'repositoryId' = ${repositoryId}`;
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${repositoryId}`;
      await sql`DELETE FROM memory_op_log WHERE run_id IN (${runA}, ${runB})`;
      await removeTrialLesson(`missing-${suffix}`, a);
    }
  }, 20_000);
});
