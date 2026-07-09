/**
 * Legacy MD → Postgres migration tests.
 * Requires: DATABASE_URL=postgresql:///paw_memory_test
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AutoMemoryStore } from "../src/compat/auto-memory.js";
import { closeSql, getSql } from "../src/db/connection.js";
import { memoryItemDao } from "../src/db/dao/memoryItem.js";
import { migrateLegacyMemories } from "../src/runtime/migrate-legacy.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
process.env.DATABASE_URL = DB_URL;

const writtenIds: string[] = [];
const repoId = `legacy-mig-${Date.now().toString(36)}`;

afterAll(async () => {
  try {
    const sql = getSql();
    for (const mid of writtenIds) {
      await sql.unsafe("DELETE FROM memory_embeddings WHERE memory_id = $1", [
        mid,
      ]);
      await sql.unsafe("DELETE FROM memory_versions WHERE memory_id = $1", [
        mid,
      ]);
      await sql.unsafe("DELETE FROM memory_items WHERE id = $1", [mid]);
    }
    await sql.unsafe(
      `DELETE FROM memory_candidates WHERE proposed_subject_key LIKE $1`,
      [`legacy:file:%`],
    );
    await closeSql();
  } catch {
    /* ignore */
  }
});

describe("migrateLegacyMemories", () => {
  test("imports AutoMemory MD and is idempotent", async () => {
    const [row] = await getSql()`SELECT 1 AS ok`;
    expect((row as { ok: number }).ok).toBe(1);

    const dir = mkdtempSync(path.join(tmpdir(), "paw-mig-legacy-"));
    const store = new AutoMemoryStore({ workspaceRoot: dir });
    store.upsert({
      name: "prefer-bun",
      description: "Prefer Bun for package scripts in this monorepo",
      type: "project",
      kind: "project_rule",
      confidence: 0.9,
      content:
        "Always use Bun for install/test scripts. Do not introduce npm-only tooling.",
      priority: "high",
      tags: ["tooling", "bun"],
    });
    store.upsert({
      name: "user-chinese",
      description: "User prefers Chinese for explanations",
      type: "user",
      kind: "user_preference",
      confidence: 0.9,
      content: "Respond in Chinese unless code identifiers require English.",
      priority: "high",
    });
    store.buildIndex();

    const r1 = await migrateLegacyMemories({
      workspaceRoot: dir,
      repositoryId: repoId,
      userId: "mig-user",
    });

    expect(r1.scanned).toBeGreaterThanOrEqual(2);
    expect(r1.errors.length).toBe(0);
    expect(r1.written + r1.pendingReview).toBeGreaterThan(0);
    writtenIds.push(...r1.writtenIds);

    // 至少一条 active
    const byKey = await memoryItemDao.findBySubjectKey(
      "legacy:file:prefer-bun",
      "active",
    );
    if (byKey[0]) {
      writtenIds.push(byKey[0].id);
      expect(byKey[0].title).toBe("prefer-bun");
      expect(byKey[0].summary).toInclude("Bun");
    } else {
      // 若被 review，至少 candidate 路径跑通
      expect(r1.candidatesCreated).toBeGreaterThan(0);
    }

    // 幂等：第二次不新增 written
    const r2 = await migrateLegacyMemories({
      workspaceRoot: dir,
      repositoryId: repoId,
      userId: "mig-user",
    });
    expect(r2.skippedExisting).toBeGreaterThanOrEqual(r1.written);
    expect(r2.written).toBe(0);
  });

  test("dry-run does not write", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-mig-dry-"));
    const store = new AutoMemoryStore({ workspaceRoot: dir });
    store.upsert({
      name: "dry-only",
      description: "Dry run entry",
      type: "project",
      content: "Should not be written in dry mode.",
    });

    const r = await migrateLegacyMemories({
      workspaceRoot: dir,
      repositoryId: `${repoId}-dry`,
      dryRun: true,
    });
    expect(r.scanned).toBe(1);
    expect(r.candidatesCreated).toBe(1);
    expect(r.written).toBe(0);

    const items = await memoryItemDao.findBySubjectKey(
      "legacy:file:dry-only",
      "active",
    );
    expect(items.length).toBe(0);
  });
});
