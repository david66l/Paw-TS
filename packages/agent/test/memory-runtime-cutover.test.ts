/**
 * Phase 2 cutover：memory_backend=db 时 AgentOrchestrator 走 MemoryRuntime。
 *
 * 需要 PostgreSQL：
 *   DATABASE_URL=postgresql:///paw_memory_test bun test packages/agent/test/memory-runtime-cutover.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEventEnvelope } from "@paw/core";
import { closeSql, getSql } from "@paw/memory/db";
import { FakeLanguageModel } from "@paw/models";

import { AgentOrchestrator } from "../src/orchestrator.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
process.env.DATABASE_URL = DB_URL;

const taskIds: string[] = [];
const memoryIds: string[] = [];

afterAll(async () => {
  try {
    const sql = getSql();
    for (const mid of memoryIds) {
      await sql.unsafe("DELETE FROM memory_embeddings WHERE memory_id = $1", [
        mid,
      ]);
      await sql.unsafe("DELETE FROM memory_versions WHERE memory_id = $1", [
        mid,
      ]);
      await sql.unsafe("DELETE FROM memory_items WHERE id = $1", [mid]);
    }
    for (const tid of taskIds) {
      await sql.unsafe(
        "DELETE FROM tool_result_records WHERE task_id = $1",
        [tid],
      );
      await sql.unsafe(
        "DELETE FROM memory_candidates WHERE source_task_ids @> $1",
        [[tid]],
      );
      await sql.unsafe("DELETE FROM working_memories WHERE task_id = $1", [
        tid,
      ]);
      await sql.unsafe("DELETE FROM task_sessions WHERE id = $1", [tid]);
    }
    await closeSql();
  } catch {
    /* ignore cleanup errors */
  }
});

describe("AgentOrchestrator memory_backend=db", () => {
  test("complete run writes governed memory and second run can retrieve", async () => {
    let dbOk = false;
    try {
      const [row] = await getSql()`SELECT 1 AS ok`;
      dbOk = (row as { ok: number }).ok === 1;
    } catch {
      dbOk = false;
    }
    if (!dbOk) {
      console.warn(
        "skip memory-runtime-cutover: Postgres not available (set DATABASE_URL)",
      );
      return;
    }

    const dir = mkdtempSync(path.join(tmpdir(), "paw-mem-db-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        memory_backend: "db",
        repository_id: `agent-cutover-${Date.now().toString(36)}`,
        user_id: "agent-test",
      }),
      "utf8",
    );
    writeFileSync(path.join(dir, "hello.txt"), "hello from cutover\n", "utf8");

    const events1: RunEventEnvelope[] = [];
    const o1 = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => events1.push(e),
      memoryExtraction: "off",
    });

    const r1 = await o1.run({
      runId: `db-run-1-${Date.now()}`,
      goal: "read file hello.txt then write done.txt with ok",
      workspaceRoot: dir,
      maxSteps: 10,
    });
    expect(r1.status).toBe("completed");

    const retrieve1 = events1.find(
      (e) => e.event.type === "memory.retrieve.done",
    );
    expect(retrieve1).toBeDefined();

    const extracted = events1.find((e) => e.event.type === "memory.extracted");
    // completeTask 可能产生 0 条（候选全被拒）或 >=1；至少应有 extract 事件
    expect(extracted?.event.type).toBe("memory.extracted");
    if (extracted?.event.type === "memory.extracted") {
      // 记录用于清理：从 DB 查本 repo 的 items
      const sql = getSql();
      const items = (await sql.unsafe(
        `SELECT id FROM memory_items WHERE scope->>'repositoryId' LIKE $1`,
        [`agent-cutover-%`],
      )) as unknown as { id: string }[];
      for (const it of items) {
        memoryIds.push(it.id);
      }
      const tasks = (await sql.unsafe(
        `SELECT id FROM task_sessions WHERE repository_id LIKE $1`,
        [`agent-cutover-%`],
      )) as unknown as { id: string }[];
      for (const t of tasks) {
        taskIds.push(t.id);
      }
    }

    // 第二次 run：应能 retrieve（若第一次写成功）
    const events2: RunEventEnvelope[] = [];
    const o2 = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => events2.push(e),
      memoryExtraction: "off",
    });
    const r2 = await o2.run({
      runId: `db-run-2-${Date.now()}`,
      goal: "final answer about previous redis and hello work",
      workspaceRoot: dir,
      maxSteps: 4,
    });
    expect(r2.status).toBe("completed");
    const retrieve2 = events2.find(
      (e) => e.event.type === "memory.retrieve.done",
    );
    expect(retrieve2?.event.type).toBe("memory.retrieve.done");
  });
});
