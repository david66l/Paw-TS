/**
 * MemoryRuntime e2e — cutover Phase 1 验收。
 *
 * 证明：begin → 工具轨迹 → complete（Writer→Governance→Execute）→ 二次 retrieve 命中。
 *
 * 需要 PostgreSQL：
 *   DATABASE_URL="postgresql:///paw_memory_test" bun test packages/memory/test/runtime.e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSql, getSql } from "../src/db/connection.js";
import {
  createMemoryRuntime,
  type MemoryRuntime,
} from "../src/runtime/index.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
process.env.DATABASE_URL = DB_URL;

const WORKSPACE = `/tmp/paw-runtime-e2e-${Date.now()}`;
const REPO = `runtime-e2e-${Date.now().toString(36)}`;
const USER = "runtime-test-user";

let runtime: MemoryRuntime;
const writtenIds: string[] = [];
let taskId = "";

beforeAll(async () => {
  const sql = getSql();
  const [row] = await sql`SELECT 1 AS ok`;
  expect((row as { ok: number }).ok).toBe(1);

  runtime = await createMemoryRuntime({
    workspaceRoot: WORKSPACE,
    userId: USER,
    repositoryId: REPO,
    workspaceId: REPO,
  });
  expect(await runtime.ping()).toBe(true);
});

afterAll(async () => {
  const sql = getSql();
  for (const mid of writtenIds) {
    await sql.unsafe("DELETE FROM memory_embeddings WHERE memory_id = $1", [
      mid,
    ]);
    await sql.unsafe("DELETE FROM memory_index_states WHERE memory_id = $1", [
      mid,
    ]);
    await sql.unsafe("DELETE FROM memory_versions WHERE memory_id = $1", [mid]);
    await sql.unsafe("DELETE FROM memory_items WHERE id = $1", [mid]);
  }
  if (taskId) {
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id = $1", [
      taskId,
    ]);
    await sql.unsafe(
      "DELETE FROM tool_result_records WHERE task_id = $1",
      [taskId],
    );
    await sql.unsafe(
      "DELETE FROM governance_decisions WHERE candidate_id LIKE $1",
      ["cand_%"],
    );
    await sql.unsafe(
      "DELETE FROM memory_candidates WHERE source_task_ids @> $1",
      [[taskId]],
    );
    await sql.unsafe(
      "DELETE FROM working_memory_snapshots WHERE task_id = $1",
      [taskId],
    );
    await sql.unsafe("DELETE FROM working_memories WHERE task_id = $1", [
      taskId,
    ]);
    await sql.unsafe("DELETE FROM task_sessions WHERE id = $1", [taskId]);
  }
  await runtime.shutdown();
  await closeSql();
});

describe("MemoryRuntime Phase 1 closed loop", () => {
  test("1. ping + beginTask 创建 TaskSession", async () => {
    const begun = await runtime.beginTask({
      runId: "run-e2e-1",
      goal: "Add Redis caching to the auth service and always use vitest",
      title: "Redis cache for auth",
    });
    expect(begun.taskId).toStartWith("tsk_");
    expect(begun.resumed).toBe(false);
    taskId = begun.taskId;
  });

  test("2. patchWorkingMemory + onToolResult 更新 WM", async () => {
    await runtime.patchWorkingMemory({
      taskId,
      patch: {
        goal: "Add Redis caching to the auth service",
        plan: ["Read auth module", "Add redis client", "Write tests"],
        constraints: ["Always use vitest for testing"],
        nextStep: "Read auth service source",
      },
    });

    await runtime.onToolResult({
      taskId,
      toolName: "workspace.read_file",
      args: { path: "src/auth/service.ts" },
      ok: true,
      summary: "Read auth service",
      rawPayload: "export function login() { return true }",
      idempotencyKey: `tool-${taskId}-1`,
      durationMs: 12,
    });

    await runtime.onToolResult({
      taskId,
      toolName: "workspace.write_file",
      args: { path: "src/auth/cache.ts" },
      ok: true,
      summary: "Wrote redis cache wrapper",
      rawPayload: "export const cache = {}",
      idempotencyKey: `tool-${taskId}-2`,
      durationMs: 20,
    });

    await runtime.onToolResult({
      taskId,
      toolName: "workspace.run_shell",
      args: { command: "bun test" },
      ok: false,
      summary: "3 tests failed",
      rawPayload: "FAIL auth.cache.test.ts\nError: connection refused",
      idempotencyKey: `tool-${taskId}-3`,
      durationMs: 800,
      exitCode: 1,
    });
  });

  test("3. buildContextSection 产出 prompt（含 WM hot）", async () => {
    const section = await runtime.buildContextSection({
      taskId,
      query: "Redis caching auth service vitest",
      tokenBudget: 4000,
      currentUserRequest: "Add Redis caching to the auth service",
    });
    expect(section.promptSection.length).toBeGreaterThan(0);
    expect(section.promptSection).toContain("CURRENT GOAL");
    expect(section.tokens).toBeGreaterThan(0);
  });

  test("4. completeTask → 治理写入至少一条 active 记忆", async () => {
    const result = await runtime.completeTask({
      taskId,
      status: "completed",
      finalMessage:
        "Decided to use ioredis for Redis client; prefer vitest for unit tests",
    });

    expect(result.candidates).toBeGreaterThan(0);
    // 至少 task_summary / decision / preference 中应有可自动批准的
    expect(result.approved + result.pendingReview + result.rejected).toBe(
      result.candidates,
    );
    expect(result.writtenMemoryIds.length).toBeGreaterThan(0);
    writtenIds.push(...result.writtenMemoryIds);
  });

  test("5. 二次 run：retrieve 命中已写入记忆", async () => {
    const run2 = await runtime.beginTask({
      runId: "run-e2e-2",
      goal: "Continue improving Redis caching for auth",
    });
    expect(run2.taskId).not.toBe(taskId);

    const section = await runtime.buildContextSection({
      taskId: run2.taskId,
      query: "Redis caching auth ioredis vitest",
      tokenBudget: 4000,
      currentUserRequest: "Continue improving Redis caching for auth",
    });

    // 召回列表或 prompt 中应出现先前写入的内容
    const hitById = section.items.some((i) => writtenIds.includes(i.id));
    const hitByText =
      /redis|ioredis|vitest|auth/i.test(section.promptSection) &&
      section.items.length > 0;

    expect(hitById || hitByText).toBe(true);

    // cleanup second task
    const sql = getSql();
    await sql.unsafe("DELETE FROM working_memories WHERE task_id = $1", [
      run2.taskId,
    ]);
    await sql.unsafe("DELETE FROM task_sessions WHERE id = $1", [run2.taskId]);
  });

  test("6. memory.save 显式写入走治理", async () => {
    const saved = await runtime.saveMemory({
      title: "Prefer ioredis over node-redis",
      summary:
        "In this monorepo, always use ioredis for Redis clients in auth services.",
      type: "project_knowledge",
    });
    expect(saved.candidateId).toStartWith("cand_");
    if (saved.memoryId) {
      writtenIds.push(saved.memoryId);
      const read = await runtime.readMemory(saved.memoryId);
      expect(read?.title).toInclude("ioredis");
    }
    const listed = await runtime.listMemories({ limit: 10 });
    expect(listed.length).toBeGreaterThan(0);
  });
});
