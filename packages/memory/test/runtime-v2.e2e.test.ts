/**
 * MemoryRuntime v2 e2e — v2 长记忆管线接入门面后的闭环验收。
 *
 * 覆盖：
 * 1. beginTask（opaque taskId）→ onToolResult（含测试工具结果 → verdict 跟踪）
 * 2. completeTask：有测试结果 → task_succeeded(test verdict) → 蒸馏/裁决/固化
 * 3. 无测试信号 → session_finalize 兜底（conf ≤0.6）
 * 4. cancelled → 不产生写入事件
 * 5. 二次 run T1 task_start 检索命中（episodic 注入）
 * 6. T2 action_failed 检索返回注入段
 * 7. saveMemory 用户直写 + list/read
 *
 * 需要 PostgreSQL（V026+）：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/runtime-v2.e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSql, getSql } from "../src/db/connection.js";
import {
  createMemoryRuntime,
  getMemoryV2CoreForTests,
  resetMemoryV2Core,
  type MemoryRuntime,
} from "../src/runtime/index.js";
import {
  makeDistillerLlm,
  makeEpisodicCandidate,
  makeGovernorLlm,
  makeSemanticCandidate,
} from "./fakes.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
process.env.DATABASE_URL = DB_URL;

const REPO = `runtime-v2-e2e-${Date.now().toString(36)}`;
const USER = "runtime-v2-test-user";
const WORKSPACE = `/tmp/paw-runtime-v2-e2e-${Date.now()}`;

let runtime: MemoryRuntime;
const createdIds: string[] = [];
let taskId = "";
let taskIdNoTest = "";
let taskIdCancel = "";
let taskIdTrial = "";

const distillCalls = { n: 0 };
const governorCalls = { n: 0 };
/** 蒸馏候选池（测试间可切换内容） */
const distillState: { current: readonly unknown[] } = {
  current: [],
};

beforeAll(async () => {
  const sql = getSql();
  const [row] = await sql`SELECT 1 AS ok`;
  expect((row as { ok: number }).ok).toBe(1);

  // 清理被杀测试进程遗留的陈旧 pending 事件（>5 分钟，V030 回收阈值同口径）：
  // 否则本进程 worker/drainOutbox 会用本测试的 mock 蒸馏它们，把条目写进别人的仓库
  await sql.unsafe(
    "DELETE FROM outbox_events WHERE aggregate_type = 'memory_write' AND status IN ('pending','processing') AND created_at < now() - interval '5 minutes'",
  );

  // 测试 4 的蒸馏产物：semantic + episodic（whenToUse 含 ECONNREFUSED，供 T2 匹配；
  // 轨迹含失败→成功转折，episodic 必须带 failureFixPair）
  distillState.current = [
    makeSemanticCandidate({ fact: "Always prefer vitest over jest in this monorepo.", keywords: ["vitest", "jest"] }),
    makeEpisodicCandidate({
      whenToUse: "When a test fails with ECONNREFUSED, check the mock server port first.",
      perspective: "Connection errors in tests usually mean the mock server is not listening.",
      modification: ["Verify the mock server port", "Check the test config"],
      issueType: "ECONNREFUSED",
      failureFixPair: {
        failed: "test connection refused",
        feedback: "ECONNREFUSED 127.0.0.1:1234",
        fixed: "started the mock server on the right port",
      },
    }),
  ];

  runtime = await createMemoryRuntime({
    workspaceRoot: WORKSPACE,
    userId: USER,
    repositoryId: REPO,
    workspaceId: REPO,
    // 共享测试库当日蒸馏计数跨 repo 累积，抬高预算避免误熔断（spec §5.2 全库口径）
    dailyBudget: 500,
    llm: {
      distill: makeDistillerLlm({
        candidates: () => distillState.current,
        onCall: () => {
          distillCalls.n += 1;
        },
      }).complete,
      govern: makeGovernorLlm({
        op: "ADD",
        count: 2,
        onCall: () => {
          governorCalls.n += 1;
        },
      }).complete,
    },
  });
  expect(await runtime.ping()).toBe(true);
});

afterAll(async () => {
  try {
    const sql = getSql();
    for (const id of createdIds) {
      await sql.unsafe("DELETE FROM memory_embeddings WHERE memory_id = $1", [id]);
      await sql.unsafe("DELETE FROM memory_items WHERE id = $1", [id]);
      // Governor 裁决记录（candidate_id = 内容哈希 = 条目 id）；不清理会污染 governor 测试的 v2-m5 断言
      await sql.unsafe("DELETE FROM governance_decisions WHERE candidate_id = $1", [id]);
    }
    for (const tid of [taskId, taskIdNoTest, taskIdCancel, taskIdTrial].filter(Boolean)) {
      await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id = $1", [tid]);
      await sql.unsafe("DELETE FROM memory_op_log WHERE run_id = $1", [tid]);
      await sql.unsafe("DELETE FROM memory_trial_lessons WHERE origin_task_id = $1", [tid]);
      await sql.unsafe("DELETE FROM governance_decisions WHERE candidate_id = $1", [tid]);
    }
    await sql.unsafe("DELETE FROM memory_items WHERE scope->>'repositoryId' = $1", [REPO]);
    await sql.unsafe("DELETE FROM memory_embeddings WHERE memory_id NOT IN (SELECT id FROM memory_items)");
    await sql.unsafe("DELETE FROM memory_op_log WHERE run_id LIKE $1", [`%${REPO}%`]);
    await runtime.shutdown();
    resetMemoryV2Core();
    await closeSql();
  } catch {
    /* cleanup best-effort */
  }
});

/**
 * 确定性排空 outbox（免等 worker 2s 间隔；worker 可能已抢先领取 → 按 taskId 等待
 * pending/processing 全部清零，避免与 worker 并发处理竞态）
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

describe("MemoryRuntime v2 closed loop", () => {
  test("1. beginTask 返回 opaque v2 taskId", async () => {
    const begun = await runtime.beginTask({
      runId: "v2-run-1",
      goal: "Add Redis caching to auth and always use vitest",
      title: "Redis cache for auth",
      branch: "main",
    });
    expect(begun.taskId).toStartWith("v2-");
    expect(begun.resumed).toBe(false);
    taskId = begun.taskId;
  });

  test("2. onToolResult 跟踪轨迹与测试结果（测试全过 + 一次非测试失败）", async () => {
    const r1 = await runtime.onToolResult({
      taskId,
      toolName: "workspace.read_file",
      args: { path: "src/auth/service.ts" },
      ok: true,
      summary: "Read auth service",
      rawPayload: "export function login() { return true }",
      idempotencyKey: `t-${taskId}-1`,
    });
    expect(r1).toBeUndefined(); // 成功不触发 T2

    const r2 = await runtime.onToolResult({
      taskId,
      toolName: "workspace.run_shell",
      args: { command: "bun test" },
      ok: true,
      summary: "all tests passed",
      rawPayload: "2 passed",
      idempotencyKey: `t-${taskId}-2`,
      exitCode: 0,
    });
    expect(r2).toBeUndefined();

    // 非测试工具失败（build）：不进测试 verdict 跟踪（测试工具全过 → passed:true），
    // 但会触发 T2 action_failed 检索（空库 → 无注入）
    const r3 = await runtime.onToolResult({
      taskId,
      toolName: "workspace.run_shell",
      args: { command: "bun run build" },
      ok: false,
      summary: "build failed: module not found",
      rawPayload: "ERROR in src/main.ts: Module not found",
      idempotencyKey: `t-${taskId}-3`,
      exitCode: 1,
    });
    expect(r3).toBeUndefined(); // 库为空：无注入，但轨迹已记失败
  });

  test("3. buildContextSection：T1 空库零开销，无 prompt 段", async () => {
    const section = await runtime.buildContextSection({
      taskId,
      query: "Redis caching auth service vitest",
      tokenBudget: 1500,
      currentUserRequest: "Add Redis caching to the auth service",
    });
    expect(section.promptSection).toBe("");
    expect(section.items).toHaveLength(0);
  });

  test("4. completeTask（测试全过 verdict → task_succeeded）→ 蒸馏/裁决/固化", async () => {
    const result = await runtime.completeTask({
      taskId,
      status: "completed",
      finalMessage: "Added redis cache; tests pass",
    });
    // v2 语义：已入队
    expect(result.candidates).toBe(1);
    expect(result.writtenMemoryIds).toHaveLength(0);

    await drainOutbox([taskId]);

    const sql = getSql();
    const rows = (await sql.unsafe(
      "SELECT id, type, confidence, verification_status, payload->>'degraded' AS degraded FROM memory_items WHERE scope->>'repositoryId' = $1 AND t_invalid IS NULL",
      [REPO],
    )) as unknown as {
      id: string;
      type: string;
      confidence: number;
      verification_status: string;
      degraded: string | null;
    }[];
    expect(rows.length).toBeGreaterThan(0);

    const semantic = rows.find((r) => r.type === "semantic");
    expect(semantic).toBeDefined();
    expect(semantic!.confidence).toBeGreaterThan(0.5);
    expect(semantic!.verification_status).toBe("verified"); // task_succeeded 验证门控通过
    createdIds.push(semantic!.id);

    const episodic = rows.find((r) => r.type === "episodic");
    expect(episodic).toBeDefined();
    expect(episodic!.verification_status).toBe("verified");
    createdIds.push(episodic!.id);

    // 蒸馏/裁决确实被调用（五道关走了 LLM 路径）
    expect(distillCalls.n).toBeGreaterThan(0);
    expect(governorCalls.n).toBeGreaterThan(0);
  });

  test("5. 二次 run：T1 task_start 检索命中 episodic（k=1 纪律）", async () => {
    const run2 = await runtime.beginTask({
      runId: "v2-run-2",
      goal: "fix the test connection refused issue",
    });
    const section = await runtime.buildContextSection({
      taskId: run2.taskId,
      query: "unit test connection refused check mock server port",
      tokenBudget: 1500,
      currentUserRequest: "fix the test connection refused issue",
    });
    // task_start 只注入 episodic/profile；语义条目不在此触发点
    expect(section.items.length).toBeGreaterThan(0);
    expect(section.items[0]!.type).toBe("episodic");
    expect(section.promptSection).toContain("<agent-memory");
    expect(section.tokens).toBeGreaterThan(0);

    // 注入记账：freq +1
    const sql = getSql();
    const [row] = (await sql.unsafe(
      "SELECT freq FROM memory_items WHERE id = $1",
      [section.items[0]!.id],
    )) as unknown as { freq: number }[];
    expect(row!.freq).toBeGreaterThan(0);
  });

  test("6. T2 action_failed：失败工具触发检索并返回注入段", async () => {
    // 先 seed 一条 semantic（T2 检索 episodic+semantic；纯 trial 库会因 store 探针短路）。
    // 注意：searchVector 跨 repo 无过滤（v2 已知边界），seed 需与查询词面强重叠
    // （workspace/run/shell/command/bun/test/exit）才能在共享测试库中压过噪声排名
    const seeded = await runtime.saveMemory({
      title: "bun test ECONNREFUSED mock server",
      summary: "Run bun test in a workspace shell command; when it exits with ECONNREFUSED the mock server is not listening on the expected port.",
      type: "project_knowledge",
    });
    createdIds.push(seeded.memoryId!);

    const run3 = await runtime.beginTask({
      runId: "v2-run-3",
      goal: "debug test failure",
    });
    const injected = await runtime.onToolResult({
      taskId: run3.taskId,
      toolName: "workspace.run_shell",
      args: { command: "bun test" },
      ok: false,
      summary: "connection refused again",
      rawPayload: "Error: ECONNREFUSED 127.0.0.1:1234",
      idempotencyKey: `t-${run3.taskId}-1`,
      exitCode: 1,
    });
    expect(injected?.injected).toBeDefined();
    expect(injected!.injected!).toContain("mock server");
    expect(injected!.injected!).toContain("<agent-memory");
  });

  test("7. 无测试信号 → session_finalize 兜底（conf ≤0.6）", async () => {
    // 切换蒸馏内容（避免与测试 4 的内容哈希撞 id）
    distillState.current = [
      makeSemanticCandidate({ fact: "Use dependency injection for the auth service layer.", keywords: ["auth", "dependency"] }),
    ];

    const begun = await runtime.beginTask({
      runId: "v2-run-4",
      goal: "refactor auth service",
    });
    taskIdNoTest = begun.taskId;
    await runtime.onToolResult({
      taskId: taskIdNoTest,
      toolName: "workspace.read_file",
      args: { path: "src/auth.ts" },
      ok: true,
      summary: "Read auth",
      idempotencyKey: `t-${taskIdNoTest}-1`,
    });
    const result = await runtime.completeTask({
      taskId: taskIdNoTest,
      status: "completed",
      finalMessage: "Refactored auth service",
    });
    expect(result.candidates).toBe(1);
    await drainOutbox([taskIdNoTest]);

    // session_finalize 走蒸馏但 confidenceCap=0.6
    const sql = getSql();
    const rows = (await sql.unsafe(
      "SELECT id, confidence, verification_status FROM memory_items WHERE scope->>'repositoryId' = $1 AND id NOT IN (SELECT unnest($2::text[]))",
      [REPO, createdIds],
    )) as unknown as { id: string; confidence: number; verification_status: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.confidence).toBeLessThanOrEqual(0.6);
      createdIds.push(r.id);
    }
  });

  test("8. cancelled → 不产生写入事件", async () => {
    const begun = await runtime.beginTask({
      runId: "v2-run-5",
      goal: "do nothing",
    });
    taskIdCancel = begun.taskId;
    const result = await runtime.completeTask({
      taskId: taskIdCancel,
      status: "cancelled",
    });
    expect(result.candidates).toBe(0);
    await drainOutbox([taskIdCancel]);
    const sql = getSql();
    const [row] = (await sql.unsafe(
      "SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1",
      [taskIdCancel],
    )) as unknown as { n: number }[];
    expect(row!.n).toBe(0);
  });

  test("10. 有失败测试 → verdict passed:false → 试用通道（不写正式库）", async () => {
    const begun = await runtime.beginTask({
      runId: "v2-run-6",
      goal: "fix flaky test",
    });
    taskIdTrial = begun.taskId;
    await runtime.onToolResult({
      taskId: begun.taskId,
      toolName: "workspace.run_shell",
      args: { command: "bun test" },
      ok: false,
      summary: "1 test failed: connection refused",
      rawPayload: "FAIL auth.test.ts\nError: ECONNREFUSED",
      idempotencyKey: `t-${begun.taskId}-1`,
      exitCode: 1,
    });
    const result = await runtime.completeTask({
      taskId: begun.taskId,
      status: "completed",
      finalMessage: "tried to fix",
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
  });

  test("9. saveMemory 用户直写（免门控）+ list/read", async () => {
    const saved = await runtime.saveMemory({
      title: "Prefer ioredis in this repo",
      summary: "Always use ioredis for Redis clients in auth services.",
      type: "project_knowledge",
      taskId,
    });
    expect(saved.decision).toBe("APPROVE_CREATE");
    expect(saved.memoryId).toBeDefined();
    createdIds.push(saved.memoryId!);

    const read = await runtime.readMemory(saved.memoryId!);
    expect(read?.title).toContain("ioredis");
    expect(read?.type).toBe("semantic");
    expect(read?.confidence).toBe(1.0);

    const listed = await runtime.listMemories({ limit: 10 });
    expect(listed.length).toBeGreaterThan(0);

    // 幂等：同内容二次保存 → 内容哈希派生同 id（upsert）
    const saved2 = await runtime.saveMemory({
      title: "Prefer ioredis in this repo",
      summary: "Always use ioredis for Redis clients in auth services.",
    });
    expect(saved2.memoryId).toBe(saved.memoryId);
  });
});
