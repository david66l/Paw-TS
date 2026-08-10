/**
 * MemoryRuntime v2 降级路径测试。
 *
 * 覆盖：
 * 1. 无 LLM（llm: null，off 模式）→ 蒸馏降级 append-only（conf 0.3 + degraded 标记，
 *    不进检索池但 query/list 可见）；Governor 缺省直 ADD
 * 2. degraded 条目 query 可见但检索不到
 * 3. 空库检索零开销短路
 * 4. 失败任务 → trial 通道（不进正式库）
 * 5. off 模式下用户显式 save 仍直写（无 LLM 依赖）
 *
 * 需要 PostgreSQL（V026+）。
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSql, getSql } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import {
  createMemoryRuntime,
  getMemoryV2CoreForTests,
  resetMemoryV2Core,
  type MemoryRuntime,
} from "../src/runtime/index.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
process.env.DATABASE_URL = DB_URL;

const REPO = `v2-degrade-${Date.now().toString(36)}`;
const WORKSPACE = `/tmp/paw-v2-degrade-${Date.now()}`;

let runtime: MemoryRuntime;
const createdIds: string[] = [];
const taskIds: string[] = [];

beforeAll(async () => {
  const sql = getSql();
  const [row] = await sql`SELECT 1 AS ok`;
  expect((row as { ok: number }).ok).toBe(1);

  // 清理被杀测试进程遗留的陈旧 pending 事件（>5 分钟，V030 回收阈值同口径）：
  // 否则本进程 worker/drainOutbox 会用本测试的 mock 蒸馏它们，把条目写进别人的仓库
  await sql.unsafe(
    "DELETE FROM outbox_events WHERE aggregate_type = 'memory_write' AND status IN ('pending','processing') AND created_at < now() - interval '5 minutes'",
  );

  // off 模式：llm: null → 禁用全部 LLM（含 settings 解析）
  runtime = await createMemoryRuntime({
    workspaceRoot: WORKSPACE,
    userId: "degrade-user",
    repositoryId: REPO,
    workspaceId: REPO,
    // 共享测试库当日蒸馏计数跨 repo 累积，抬高预算避免误熔断（spec §5.2 全库口径）
    dailyBudget: 500,
    llm: null,
  });
  expect(await runtime.ping()).toBe(true);
});

afterAll(async () => {
  try {
    const sql = getSql();
    for (const id of createdIds) {
      await sql.unsafe("DELETE FROM memory_embeddings WHERE memory_id = $1", [id]);
      await sql.unsafe("DELETE FROM memory_items WHERE id = $1", [id]);
    }
    await sql.unsafe("DELETE FROM memory_op_log WHERE run_id LIKE $1", ["v2d-%"]);
    for (const tid of taskIds) {
      await sql.unsafe("DELETE FROM memory_trial_lessons WHERE origin_task_id = $1", [tid]);
      await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id = $1", [tid]);
    }
    await runtime.shutdown();
    resetMemoryV2Core();
    await closeSql();
  } catch {
    /* best-effort */
  }
});

/**
 * 确定性排空 outbox（worker 可能已抢先领取 → 按 taskId 等待 pending/processing 清零）
 */
async function drainOutbox(taskIds: string[]): Promise<void> {
  const core = getMemoryV2CoreForTests();
  expect(core).not.toBeNull();
  const sql = getSql();
  for (let round = 0; round < 100; round++) {
    let processed = true;
    while (processed) {
      processed = await core!.pipeline.processNext();
    }
    if (taskIds.length === 0) return;
    const [row] = (await sql.unsafe(
      "SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_type = 'memory_write' AND status IN ('pending','processing') AND payload::text LIKE ANY($1::text[])",
      [taskIds.map((t) => `%${t}%`)],
    )) as unknown as { n: number }[];
    if (row!.n === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("drainOutbox: outbox 未在 10s 内排空");
}

describe("v2 降级路径", () => {
  test("1. 无 LLM 完成测试任务 → append-only 降级（conf 0.3 + degraded）", async () => {
    const begun = await runtime.beginTask({ runId: "v2d-1", goal: "add feature x" });
    taskIds.push(begun.taskId);
    await runtime.onToolResult({
      taskId: begun.taskId,
      toolName: "workspace.run_shell",
      args: { command: "bun test" },
      ok: true,
      summary: "tests passed",
      idempotencyKey: `t-${begun.taskId}-1`,
    });
    const result = await runtime.completeTask({
      taskId: begun.taskId,
      status: "completed",
      finalMessage: "done",
    });
    expect(result.candidates).toBe(1);
    await drainOutbox([begun.taskId]);

    const sql = getSql();
    const rows = (await sql.unsafe(
      "SELECT id, confidence, verification_status, payload->>'degraded' AS degraded FROM memory_items WHERE scope->>'repositoryId' = $1",
      [REPO],
    )) as unknown as { id: string; confidence: number; verification_status: string; degraded: string | null }[];
    expect(rows.length).toBeGreaterThan(0);

    // 无蒸馏器 → storeDegraded：conf=0.3、unverified、degraded=true
    const degraded = rows.filter((r) => r.degraded === "true");
    expect(degraded.length).toBeGreaterThan(0);
    expect(degraded.every((r) => r.confidence === 0.3)).toBe(true);
    expect(degraded.every((r) => r.verification_status === "unverified")).toBe(true);
    for (const r of rows) createdIds.push(r.id);
  });

  test("2. degraded 条目 query/list 可见，但 searchText 检索不到", async () => {
    const engine = new PostgresMemoryStoreEngine();
    const all = await engine.query({ repo: REPO, limit: 10 });
    expect(all.length).toBeGreaterThan(0); // query 可见（给人看）

    const hits = await engine.searchText("feature x", 10);
    expect(hits.length).toBe(0); // 自动注入路径硬过滤 degraded
  });

  test("3. 空库 T1 检索短路：零命中、零开销、degraded=false", async () => {
    // 进程共享 core：用独立空 repo 验证空库 probe 短路（engine.query 命中 0 行 → 直接空包）
    const emptyRepo = `v2-empty-${Date.now().toString(36)}`;
    const runtime2 = await createMemoryRuntime({
      workspaceRoot: `/tmp/paw-v2-empty-${Date.now()}`,
      repositoryId: emptyRepo,
    });
    const begun = await runtime2.beginTask({ runId: "v2d-2", goal: "nothing here" });
    const section = await runtime2.buildContextSection({
      taskId: begun.taskId,
      query: "nothing matches this",
      tokenBudget: 500,
      currentUserRequest: "nothing here",
    });
    expect(section.promptSection).toBe("");
    expect(section.items).toHaveLength(0);
    expect(section.tokens).toBe(0);
    expect(section.degraded).toBe(false);
  });

  test("4. 失败任务 → trial 通道（不进正式库）", async () => {
    const begun = await runtime.beginTask({ runId: "v2d-3", goal: "broken task" });
    taskIds.push(begun.taskId);
    await runtime.onToolResult({
      taskId: begun.taskId,
      toolName: "workspace.run_shell",
      args: { command: "bun test" },
      ok: false,
      summary: "failed",
      idempotencyKey: `t-${begun.taskId}-1`,
      exitCode: 1,
    });
    const result = await runtime.completeTask({
      taskId: begun.taskId,
      status: "failed",
    });
    expect(result.candidates).toBe(1);
    await drainOutbox([begun.taskId]);

    const sql = getSql();
    const trial = (await sql.unsafe(
      "SELECT id, attempts_left FROM memory_trial_lessons WHERE origin_task_id = $1",
      [begun.taskId],
    )) as unknown as { id: string; attempts_left: number }[];
    expect(trial.length).toBe(1);
    expect(trial[0]!.attempts_left).toBe(3);
    // 失败任务不产生正式条目（除已统计的降级行）
    const items = (await sql.unsafe(
      "SELECT count(*)::int AS n FROM memory_items WHERE scope->>'repositoryId' = $1 AND id NOT IN (SELECT unnest($2::text[]))",
      [REPO, createdIds],
    )) as unknown as { n: number }[];
    expect(items[0]!.n).toBe(0);
  });

  test("5. 用户显式 save 在 off 模式下仍直写（无 LLM 依赖）", async () => {
    const saved = await runtime.saveMemory({
      title: "Pin constraint: use pnpm",
      summary: "This workspace must use pnpm, not npm.",
    });
    expect(saved.decision).toBe("APPROVE_CREATE");
    createdIds.push(saved.memoryId!);
  });
});
