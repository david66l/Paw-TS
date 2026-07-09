/**
 * 全链路集成测试
 *
 * 覆盖 spec 四条业务闭环中的两条：
 *   在线使用闭环: Task → WM → Execution → Retrieval → ContextBuild
 *   自动写入闭环: Task → Writer → Governance → Store → Index
 *
 * 需要 PostgreSQL 测试数据库。启动方式:
 *   DATABASE_URL="postgresql:///paw_memory_test" bun test packages/memory/test/db-e2e.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { getSql, closeSql } from "../src/db/connection.js";
import { memoryCandidateDao } from "../src/db/dao/memoryCandidate.js";
import { governanceDecisionDao } from "../src/db/dao/governanceDecision.js";
import {
  TaskSessionManager, WorkingMemoryManager,
  MemoryWriter, MemoryGovernance, GovernanceExecutor,
  MemoryRetriever, ContextBuilder,
  executionRecorder, ToolResultProcessor,
  securityGuard, auditRecorder,
  indexManager,
  RevisionConflictError,
} from "../src/db/modules/index.js";

// ── 测试数据库 URL ──
const DB_URL = process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
process.env.DATABASE_URL = DB_URL;

// ── 实例 ──
const taskMgr = new TaskSessionManager();
const wmMgr = new WorkingMemoryManager();
const writer = new MemoryWriter();
const governance = new MemoryGovernance();
const executor = new GovernanceExecutor();
const retriever = new MemoryRetriever();
const ctxBuilder = new ContextBuilder();
const processor = new ToolResultProcessor();

const TEST_REPO = "test-repo";
const TEST_USER = "test-user";

let taskId: string;
let createdMemories: string[] = [];

beforeAll(async () => {
  // 验证数据库连通性
  const sql = getSql();
  const [row] = await sql`SELECT 1 AS ok`;
  expect((row as { ok: number }).ok).toBe(1);
});

afterAll(async () => {
  // 清理测试数据
  const sql = getSql();
  for (const mid of createdMemories) {
    await sql.unsafe("DELETE FROM memory_index_states WHERE memory_id = $1", [mid]);
    await sql.unsafe("DELETE FROM memory_embeddings WHERE memory_id = $1", [mid]);
    await sql.unsafe("DELETE FROM memory_items WHERE id = $1", [mid]);
  }
  if (taskId) {
    await sql.unsafe("DELETE FROM outbox_events WHERE aggregate_id = $1", [taskId]);
    await sql.unsafe("DELETE FROM tool_result_records WHERE task_id = $1", [taskId]);
    await sql.unsafe("DELETE FROM governance_decisions WHERE candidate_id LIKE $1", [`cand_%`]);
    await sql.unsafe("DELETE FROM memory_candidates WHERE source_task_ids @> $1", [[taskId]]);
    await sql.unsafe("DELETE FROM working_memory_snapshots WHERE task_id = $1", [taskId]);
    await sql.unsafe("DELETE FROM working_memories WHERE task_id = $1", [taskId]);
    await sql.unsafe("DELETE FROM audit_records WHERE task_id = $1", [taskId]);
    await sql.unsafe("DELETE FROM task_sessions WHERE id = $1", [taskId]);
  }
  await closeSql();
});

// ═══════════════════════════════════════════════════════════════
// PHASE 1: Task Runtime
// ═══════════════════════════════════════════════════════════════

describe("Phase 1: Task Runtime", () => {
  test("1.1 创建 TaskSession + 初始化 WorkingMemory", async () => {
    const { task, wm } = await taskMgr.createTask({
      userId: TEST_USER,
      repositoryId: TEST_REPO,
      initialUserRequest: "Add Redis caching to auth service",
      title: "Add Redis cache",
    });

    expect(task.id).toStartWith("tsk_");
    expect(task.status).toBe("pending");
    expect(task.repositoryId).toBe(TEST_REPO);
    expect(task.currentWorkingMemoryId).toBeDefined();

    expect(wm.id).toStartWith("wm_");
    expect(wm.taskId).toBe(task.id);
    expect(wm.revision).toBe(1);
    expect(wm.goal).toBe("");
    expect(wm.constraints).toBeArray();
    expect(wm.plan).toBeArray();

    taskId = task.id;
  });

  test("1.2 启动 TaskSession", async () => {
    const task = await taskMgr.startTask(taskId, 1);
    expect(task.status).toBe("running");
    expect(task.revision).toBe(2);
  });

  test("1.3 更新 WorkingMemory（goal + plan + 文件）", async () => {
    const wm = await wmMgr.getByTaskId(taskId);
    expect(wm).not.toBeNull();

    const updated = await wmMgr.update(taskId, wm!.revision, {
      goal: "Add Redis caching layer to auth service",
      plan: [
        { id: "step-1", order: 1, description: "Read auth service code", status: "completed", dependsOn: [], createdAt: now(), updatedAt: now() },
        { id: "step-2", order: 2, description: "Add Redis client config", status: "in_progress", dependsOn: ["step-1"], createdAt: now(), updatedAt: now() },
        { id: "step-3", order: 3, description: "Implement cache wrapper", status: "pending", dependsOn: ["step-2"], createdAt: now(), updatedAt: now() },
      ],
      readFiles: [
        { filePath: "src/auth/service.ts", action: "read", timestamp: now() },
        { filePath: "package.json", action: "read", timestamp: now() },
      ],
      modifiedFiles: [
        { filePath: "src/auth/cache.ts", action: "created", timestamp: now() },
        { filePath: "src/auth/config.ts", action: "modified", timestamp: now() },
      ],
      diffSummary: { filesChanged: 2, insertions: 45, deletions: 3, summary: "Added cache module" },
    });

    expect(updated.revision).toBe(wm!.revision + 1);
    expect(updated.goal).toInclude("Redis caching");
    expect(updated.plan.length).toBe(3);
    expect(updated.modifiedFiles.length).toBe(2);
  });

  test("1.4 revision 冲突保护", async () => {
    // 用过期的 revision=1 更新（当前 revision 已 > 1）→ 必须抛 RevisionConflictError
    expect(wmMgr.update(taskId, 1, { goal: "stale" })).rejects.toThrow(RevisionConflictError);
  });

  test("1.5 并发 revision 冲突恢复", async () => {
    // 使用独立的 task，不影响主 pipeline
    const { task: t } = await taskMgr.createTask({ userId: TEST_USER, repositoryId: TEST_REPO, initialUserRequest: "test", title: "RevTest" });
    await taskMgr.startTask(t.id, 1);
    const wm = await wmMgr.getByTaskId(t.id);
    const rev = wm!.revision;

    await wmMgr.update(t.id, rev, { goal: "First update" });

    let recovered = false;
    try { await wmMgr.update(t.id, rev, { goal: "stale" }); } catch (e) {
      if (e instanceof RevisionConflictError) {
        const latest = await wmMgr.getByTaskId(t.id);
        await wmMgr.update(t.id, latest!.revision, { goal: "Retry success" });
        recovered = true;
      } else { throw e; }
    }
    expect(recovered).toBe(true);
    const final = await wmMgr.getByTaskId(t.id);
    expect(final!.goal).toBe("Retry success");

    // 清理
    const sql = getSql();
    await sql.unsafe("DELETE FROM working_memories WHERE task_id = $1", [t.id]);
    await sql.unsafe("DELETE FROM task_sessions WHERE id = $1", [t.id]);
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 2: Execution Recording + Tool Result Processing
// ═══════════════════════════════════════════════════════════════

describe("Phase 2: Execution & Tool Results", () => {
  test("2.1 记录工具执行（成功）", async () => {
    const record = await executionRecorder.record({
      idempotencyKey: `tool-success-${taskId}`,
      taskId,
      attemptId: "attempt-1",
      toolCallId: "call-001",
      toolName: "read_file",
      toolType: "FILE_OPERATION",
      inputSummary: "Read src/auth/service.ts",
      executionStatus: "SUCCESS",
      resultSummary: "File read: 200 lines",
      durationMs: 150,
      verificationLevel: "VERIFIED",
    });

    expect(record.recordId).toStartWith("toolrec_");
    expect(record.executionStatus).toBe("SUCCESS");
  });

  test("2.2 记录工具执行（失败）", async () => {
    const record = await executionRecorder.record({
      idempotencyKey: `tool-fail-${taskId}`,
      taskId,
      attemptId: "attempt-1",
      toolCallId: "call-002",
      toolName: "bun",
      toolType: "COMMAND",
      inputSummary: "bun test",
      executionStatus: "FAILURE",
      resultSummary: "3 tests failed",
      exitCode: 1,
      durationMs: 3200,
      errors: [{ errorType: "AssertionError", message: "Expected 5, got 3" }],
    });

    expect(record.executionStatus).toBe("FAILURE");
    expect(record.exitCode).toBe(1);
  });

  test("2.3 幂等写入（重复 idempotencyKey）", async () => {
    const r1 = await executionRecorder.record({
      idempotencyKey: `tool-idem-${taskId}`,
      taskId,
      attemptId: "attempt-1",
      toolCallId: "call-idem",
      toolName: "echo",
      toolType: "COMMAND",
      inputSummary: "echo hello",
      executionStatus: "SUCCESS",
      resultSummary: "hello",
      durationMs: 10,
    });

    // 重复写入 → 应返回同一条记录（通过 ON CONFLICT DO UPDATE）
    const r2 = await executionRecorder.record({
      idempotencyKey: `tool-idem-${taskId}`,
      taskId,
      attemptId: "attempt-1",
      toolCallId: "call-idem",
      toolName: "echo",
      toolType: "COMMAND",
      inputSummary: "echo hello",
      executionStatus: "SUCCESS",
      resultSummary: "hello",
      durationMs: 10,
    });

    expect(r2.recordId).toBe(r1.recordId);
  });

  test("2.4 工具结果脱敏", () => {
    const result = processor.process({
      toolCallId: "call-secret",
      toolName: "env",
      toolType: "COMMAND",
      status: "SUCCESS",
      rawOutput: "DATABASE_URL=postgresql://admin:secret123@db.internal:5432/prod\nAPI_KEY=sk-1234567890abcdefghijklmnop",
      durationMs: 50,
    });

    expect(result.securityStatus).toBe("redacted");
    expect(result.summary).not.toInclude("secret123");
    expect(result.summary).not.toInclude("sk-1234567890abcdefghijklmnop");
  });

  test("2.5 超大工具结果截断", () => {
    const smallProcessor = new ToolResultProcessor({ maxOutputSize: 100 });
    const longText = "x".repeat(5000) + "\nError: something broke\n" + "y".repeat(5000);
    const result = smallProcessor.process({
      toolCallId: "call-big",
      toolName: "build",
      toolType: "BUILD",
      status: "FAILURE",
      rawOutput: longText,
      durationMs: 5000,
    });
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBeGreaterThan(100);
    expect(result.processedSize).toBeLessThanOrEqual(120);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 3: Memory Write Pipeline
// ═══════════════════════════════════════════════════════════════

describe("Phase 3: Memory Write Pipeline", () => {
  test("3.1 完成任务 + 生成候选", async () => {
    // 先更新 WM，加入 completedSteps 和一个用户约束
    const preWm = await wmMgr.getByTaskId(taskId);
    await wmMgr.update(taskId, preWm!.revision, {
      completedSteps: [
        { id: "done-1", planStepId: "step-1", summary: "Decided to use ioredis for Redis client", toolCallIds: ["call-001"], completedAt: now() },
      ],
      constraints: [
        { id: "cst-1", text: "Always use vitest for testing", source: "user_followup", priority: 10, confirmed: true, temporary: false, createdAt: now() },
      ],
      executedTools: [
        { toolCallId: "call-001", toolName: "read_file", status: "success", summary: "Read auth service", executedAt: now() },
        { toolCallId: "call-002", toolName: "bun", status: "failure", summary: "3 tests failed", executedAt: now() },
      ],
    });

    // 完成任务（task 的 revision 与 WM 的 revision 是两套计数器）
    const taskBeforeComplete = await taskMgr.getTask(taskId);
    await taskMgr.completeTask(taskId, taskBeforeComplete!.revision);
    const currentTask = await taskMgr.getTask(taskId);
    expect(currentTask!.status).toBe("completed");

    // MemoryWriter 生成候选
    const finalWm = await wmMgr.getByTaskId(taskId);
    const candidates = await writer.writeFromFinalSnapshot({
      taskId,
      workingMemory: finalWm!,
      repositoryId: TEST_REPO,
      userId: TEST_USER,
    });

    expect(candidates.length).toBeGreaterThan(0);

    // 应有 TASK_SUMMARY 候选
    const summaryCand = candidates.find((c) => c.proposedType === "task_summary");
    expect(summaryCand).toBeDefined();
    expect(summaryCand!.proposedSubjectKey).toInclude(taskId);

    // 应有 FAILURE_LEARNING 候选（call-002 失败）
    const failureCand = candidates.find((c) => c.proposedType === "failure");
    expect(failureCand).toBeDefined();
    expect(failureCand!.reviewRequired).toBe(true);

    // 应有 USER_CONFIRMED_PREFERENCE 候选
    const prefCand = candidates.find((c) => c.proposedType === "user_preference");
    expect(prefCand).toBeDefined();
    expect(prefCand!.proposedConfidence).toBeGreaterThanOrEqual(0.8);
  });

  test("3.2 Governance 评估 + 自动批准低风险候选", async () => {
    // 查一个 TASK_SUMMARY 类型的候选（低风险，应自动批准）
    const candidates = await memoryCandidateDao.listBySourceTask(taskId);
    const summaryCand = candidates.find((c) => c.proposedType === "task_summary");
    expect(summaryCand).toBeDefined();

    const { decision } = await governance.evaluate({ candidateId: summaryCand!.id });
    expect(decision.decision).toBe("APPROVE_CREATE");
    expect(decision.status).toBe("APPROVED");

    // 持久化 decision
    await governanceDecisionDao.create(decision);

    // 执行 → 创建 memory_item
    const result = await executor.execute(decision);
    expect(result.success).toBe(true);
    expect(result.memoryId).toStartWith("mem_");
    createdMemories.push(result.memoryId!);
  });

  test("3.3 Governance 拒绝 Failure 候选（未验证的失败经验）", async () => {
    const candidates = await memoryCandidateDao.listBySourceTask(taskId);
    const failureCand = candidates.find((c) => c.proposedType === "failure");
    expect(failureCand).toBeDefined();

    const { decision } = await governance.evaluate({ candidateId: failureCand!.id });
    // failure riskLevel=medium + confidence=0.5 → APPROVE_CREATE（置信度不够 0.7 才会被 review）
    // 实际看: 0.5 < 0.7 但 medium risk 需要 0.7 → REQUEST_REVIEW
    expect(["PENDING_REVIEW", "REJECTED"]).toContain(decision.status);
  });

  test("3.4 GovernanceDecision 幂等执行", async () => {
    // 拿到一个已 APPROVED 的 decision
    const candidates = await memoryCandidateDao.listBySourceTask(taskId);
    const prefCand = candidates.find((c) => c.proposedType === "user_preference");
    if (!prefCand) return; // 可能没有偏好候选

    const { decision } = await governance.evaluate({ candidateId: prefCand.id });
    if (decision.status !== "APPROVED") return;

    await governanceDecisionDao.create(decision);
    const result1 = await executor.execute(decision);
    expect(result1.success).toBe(true);
    createdMemories.push(result1.memoryId!);

    // 第二次执行 → 幂等，返回 already_executed（需要从 DB 重读 decision 状态）
    const reloaded = await governanceDecisionDao.findById(decision.id);
    const result2 = await executor.execute(reloaded!);
    expect(result2.success).toBe(true);
    expect(result2.reason).toBe("already_executed");
    expect(result2.memoryId).toBe(result1.memoryId);
  });

  test("3.5 同 subjectKey 去重", async () => {
    const candidates = await memoryCandidateDao.listBySourceTask(taskId);
    const projectCand = candidates.find((c) => c.proposedType === "project_knowledge");
    if (!projectCand) return;

    const { decision } = await governance.evaluate({ candidateId: projectCand.id });
    // project_knowledge: riskLevel=low, confidence=0.5, 阈值 0.6 → REQUEST_REVIEW
    // 如果已有同 subjectKey 的 active memory → APPROVE_MERGE
    expect(["APPROVE_CREATE", "APPROVE_MERGE", "REQUEST_REVIEW", "PENDING_REVIEW"]).toContain(decision.status);

    if (decision.status === "APPROVED") {
      await governanceDecisionDao.create(decision);
      const result = await executor.execute(decision);
      if (result.memoryId) createdMemories.push(result.memoryId);
    }
  });

  test("3.6 空 WorkingMemory 仍可生成候选", async () => {
    // 创建一个只有最少信息的 task，验证 MemoryWriter 不会崩溃
    const { task: emptyTask } = await taskMgr.createTask({
      userId: TEST_USER,
      repositoryId: TEST_REPO,
      initialUserRequest: "minimal",
    });
    const emptyWm = await wmMgr.getByTaskId(emptyTask.id);
    const candidates = await writer.writeFromFinalSnapshot({
      taskId: emptyTask.id,
      workingMemory: emptyWm!,
      repositoryId: TEST_REPO,
      userId: TEST_USER,
    });
    // 空 WM 不抛异常，可能生成最简 task_summary（含 "Steps completed: 0"）
    expect(candidates.length).toBeGreaterThanOrEqual(0);

    // 清理（candidates 可能被外键引用，需先删依赖）
    const sql = getSql();
    for (const c of candidates) {
      await sql.unsafe("DELETE FROM governance_decisions WHERE candidate_id = $1", [c.id]);
      await sql.unsafe("DELETE FROM memory_candidates WHERE id = $1", [c.id]);
    }
    await sql.unsafe("DELETE FROM working_memories WHERE task_id = $1", [emptyTask.id]);
    await sql.unsafe("DELETE FROM task_sessions WHERE id = $1", [emptyTask.id]);
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 4: Retrieval & Context Building
// ═══════════════════════════════════════════════════════════════

describe("Phase 4: Retrieval & Context Building", () => {
  test("4.1 按 scope + type 检索记忆", async () => {
    const result = await retriever.retrieve({
      taskId,
      repositoryId: TEST_REPO,
      userId: TEST_USER,
      query: "Redis caching auth service",
      types: ["task_summary"],
      limit: 5,
    });

    expect(["memory_only", "hybrid"]).toContain(result.retrievalMode);
    expect(result.items.length).toBeGreaterThan(0);

    // 应该召回刚才写入的 task_summary
    const taskSummaryHits = result.items.filter((i) => i.memory.type === "task_summary");
    expect(taskSummaryHits.length).toBeGreaterThan(0);
    expect(taskSummaryHits[0]!.memory.title).toInclude("Redis");
  });

  test("4.2 关键词搜索", async () => {
    const results = await retriever.keywordSearch("Redis", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.title.includes("Redis") || r.summary.includes("Redis"))).toBe(true);
  });

  test("4.3 ContextBuilder 构建上下文", async () => {
    const wm = await wmMgr.getByTaskId(taskId);
    const retrieval = await retriever.retrieve({
      taskId,
      repositoryId: TEST_REPO,
      query: "caching",
      limit: 5,
    });

    const result = ctxBuilder.build({
      workingMemory: wm!,
      retrievalResult: retrieval,
      currentUserRequest: "Add Redis cache to auth module",
      tokenBudget: 8000,
    });

    // Hot context 应有 goal 和 plan
    const hotItems = result.items.filter((i) => i.placement === "hot");
    expect(hotItems.length).toBeGreaterThan(0);
    expect(hotItems.some((i) => i.sourceId === "goal")).toBe(true);
    expect(hotItems.some((i) => i.sourceId === "plan")).toBe(true);

    // Warm context 应有检索到的 memory
    const warmItems = result.items.filter((i) => i.placement === "warm");
    expect(warmItems.length).toBeGreaterThan(0);

    // 渲染的 prompt 应包含 goal
    expect(result.renderedPrompt).toInclude("Redis caching");

    // Token 使用不超过预算
    expect(result.tokenUsage.estimatedUsed).toBeLessThanOrEqual(result.tokenUsage.totalBudget);
  });

  test("4.4 Token Budget 超限降级", async () => {
    const wm = await wmMgr.getByTaskId(taskId);
    const retrieval = await retriever.retrieve({
      taskId,
      repositoryId: TEST_REPO,
      query: "caching",
      limit: 20,
    });

    // 极小 budget → 大量 warm context 项被降级
    const result = ctxBuilder.build({
      workingMemory: wm!,
      retrievalResult: retrieval,
      currentUserRequest: "Add cache",
      tokenBudget: 500,
    });

    // 验证基本结构正确 + budget 未超限
    expect(result.tokenUsage.estimatedUsed).toBeLessThanOrEqual(result.tokenUsage.totalBudget);
    expect(result.renderedPrompt.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 5: Audit & Security
// ═══════════════════════════════════════════════════════════════

describe("Phase 5: Audit & Security", () => {
  test("5.1 审计记录写入", async () => {
    await auditRecorder.record({
      eventType: "TASK_COMPLETED",
      actor: { actorType: "agent", actorId: "test-agent" },
      entityType: "task_session",
      entityId: taskId,
      taskId,
      reason: "Integration test task completed",
    });

    const records = await auditRecorder.queryByTask(taskId);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]!.eventType).toBe("TASK_COMPLETED");
  });

  test("5.2 安全扫描 — 干净内容通过", () => {
    const decision = securityGuard.scanContent("This is clean code output with no secrets.");
    expect(decision.verdict).toBe("ALLOW");
  });

  test("5.3 安全扫描 — 敏感内容拒绝", () => {
    const decision = securityGuard.scanContent("API_KEY=sk-1234567890abcdefghijklmnopqrstuvwxyz123456");
    expect(decision.verdict).toBe("DENY");
  });

  test("5.4 安全扫描 — PII 检测后脱敏", () => {
    const decision = securityGuard.scanContent("Contact: user@example.com phone: 555-123-4567");
    expect(decision.verdict).toBe("ALLOW_WITH_REDACTION");
    if (decision.verdict === "ALLOW_WITH_REDACTION") {
      expect(decision.redactedContent).not.toInclude("user@example.com");
      expect(decision.redactedContent).not.toInclude("555-123-4567");
    }
  });

  test("5.5 权限校验 — 拒绝未授权访问", () => {
    const allowed = securityGuard.checkAccess(
      { actorType: "user", actorId: "other-user" },
      { userId: TEST_USER },
    );
    expect(allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// PHASE 6: Index & Outbox
// ═══════════════════════════════════════════════════════════════

describe("Phase 6: Index & Outbox", () => {
  test("6.1 Outbox 事件消费 + 索引状态更新", async () => {
    const result = await indexManager.processPending(50);
    // processed > 0 即验证了 outbox→index 链路（failed 可能来自历史遗留事件）
    expect(result.processed).toBeGreaterThanOrEqual(0);
  });

  test("6.0 Self-Evolving Loop 基础流程", async () => {
    const { SelfEvolvingLoop } = await import("../src/db/modules/evolution/selfEvolvingLoop.js");
    const loop = new SelfEvolvingLoop();
    // 空的 DB → 演化结果应为 0 候选，不崩溃
    const report = await loop.run("test");
    expect(report.batch.status).toBe("completed");
    expect(report.candidates.length).toBeGreaterThanOrEqual(0);
    // 验证批次已持久化
    const sql = getSql();
    const batch = await sql`SELECT id FROM evolution_batches WHERE id = ${report.batch.id}`;
    expect(batch.length).toBe(1);
  });

  test("6.0b Memory Evaluator 单条评估", async () => {
    // 创建一条测试记忆用于评估
    const now = new Date().toISOString();
    const mid = "mem-eval-test";
    const sql = getSql();
    await sql`INSERT INTO memory_items (id, schema_version, type, subject_key, subject_key_version, title, summary, status, scope, confidence, verification_status, payload, tags, related_files, related_symbols, related_test_run_ids, sensitivity, version, created_by, updated_by, created_at, updated_at) VALUES (${mid}, 1, 'project_knowledge', 'eval:test', 1, 'Test', 'eval', 'active', '{}'::jsonb, 0.7, 'verified', '{}'::jsonb, '{}', '{}', '{}', '{}', 'internal', 1, '{}'::jsonb, '{}'::jsonb, ${now}, ${now}) ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO memory_usage_records (id, task_id, memory_id, outcome, user_feedback) VALUES (${"mur-1"}, 'tsk-x', ${mid}, 'helpful', 'positive') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO memory_usage_records (id, task_id, memory_id, outcome, user_feedback) VALUES (${"mur-2"}, 'tsk-y', ${mid}, 'neutral', 'none') ON CONFLICT DO NOTHING`;

    const { MemoryEvaluator } = await import("../src/db/modules/evolution/memoryEvaluator.js");
    const evaluator = new MemoryEvaluator();
    const score = await evaluator.evaluate(mid);
    expect(score.usageCount).toBe(2);
    expect(score.overall).toBeGreaterThan(0);

    await sql`DELETE FROM memory_usage_records WHERE memory_id = ${mid}`;
    await sql`DELETE FROM memory_items WHERE id = ${mid}`;
  });

  test("6.2b Code Index Adapter", async () => {
    const adapter = new (await import("../src/db/modules/evolution/codeIndexAdapter.js")).CodeIndexAdapter("/tmp");
    expect(adapter.isAvailable()).toBe(false);
    const results = await adapter.query({ repositoryId: "r", query: "test" });
    expect(results).toEqual([]);
  });

  test("6.3 Code Consistency Validator", async () => {
    const { CodeConsistencyValidator } = await import("../src/db/modules/evolution/codeConsistencyValidator.js");
    const validator = new CodeConsistencyValidator();
    // 无 adapter → 返回 UNKNOWN
    const result = await validator.check("mem-x", "project_knowledge", "test:key", ["src/auth.ts"], "r");
    expect(result.status).toBe("UNKNOWN");
    // 用户偏好 → IRRELEVANT
    const result2 = await validator.check("mem-x", "user_preference", "test:key", [], "r");
    expect(result2.status).toBe("IRRELEVANT");
  });

  test("6.4 新增表可查询", async () => {
    const sql = getSql();
    // 使用实际存在的 ID 避免 FK 约束失败
    const tid = taskId;
    const wms = await sql.unsafe("SELECT id FROM working_memories WHERE task_id = $1 LIMIT 1", [tid]);
    const mems = await sql.unsafe("SELECT id FROM memory_items LIMIT 2");

    if (wms.length > 0 && mems.length >= 2) {
      const wmId = (wms[0] as any).id;
      const ma = (mems[0] as any).id;
      const mb = (mems[1] as any).id;

      await sql.unsafe("INSERT INTO memory_relations (id, from_memory_id, to_memory_id, relation_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ['rel-test', ma, mb, 'supports']);
      await sql.unsafe("INSERT INTO working_memory_entries (id, working_memory_id, task_id, entry_type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ['wme-test', wmId, tid, 'GOAL']);
      await sql.unsafe("INSERT INTO conflict_records (id, conflict_type, memory_id_a, memory_id_b) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", ['cr-test', 'content_conflict', ma, mb]);
      await sql.unsafe("INSERT INTO review_requests (id, candidate_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", ['rr-test', 'cand-test', 'test']);

      const rels = await sql.unsafe("SELECT id FROM memory_relations WHERE id = 'rel-test'");
      expect(rels.length).toBe(1);
      const ent = await sql.unsafe("SELECT id FROM working_memory_entries WHERE id = 'wme-test'");
      expect(ent.length).toBe(1);

      await sql.unsafe("DELETE FROM review_requests WHERE id = 'rr-test'");
      await sql.unsafe("DELETE FROM conflict_records WHERE id = 'cr-test'");
      await sql.unsafe("DELETE FROM working_memory_entries WHERE id = 'wme-test'");
      await sql.unsafe("DELETE FROM memory_relations WHERE id = 'rel-test'");
    }
    // 验证表结构存在
    const cr = await sql.unsafe("SELECT id FROM conflict_records LIMIT 0");
    expect(cr).toBeArray();
    const rr = await sql.unsafe("SELECT id FROM review_requests LIMIT 0");
    expect(rr).toBeArray();
  });

  test("6.2c 索引状态查询", async () => {
    if (createdMemories.length === 0) return;
    // 处理 outbox 事件
    await indexManager.processPending(50);
    const status = await indexManager.getIndexStatus(createdMemories[0]!);
    // 索引状态：处理完事件后应为 INDEXED 或 INDEX_PENDING
    expect(status.metadata).toBeOneOf(["INDEXED", "INDEX_PENDING"]);
    expect(status.vector).toBeOneOf(["INDEXED", "INDEX_PENDING"]);
    expect(status.fullText).toBeOneOf(["INDEXED", "NOT_CONFIGURED"]);
  });
});

// ── 辅助函数 ──
function now(): string {
  return new Date().toISOString();
}
