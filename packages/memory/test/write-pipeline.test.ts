/**
 * 写入管线测试（spec v2 §5，验收标准 §5.8）
 *
 * 纯函数部分（secrets/correction/distiller 校验）不需要 DB，LLM 全部 mock；
 * db 部分需要 PostgreSQL（V026+），ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/write-pipeline.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import type { RunEvent } from "@paw/core";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { hybridRecall } from "../src/longterm/retrieval/hybrid.js";
import { queryOpLog } from "../src/longterm/observability/op-log.js";
import { scanForSecrets, shannonEntropy } from "../src/longterm/write/secrets.js";
import { detectUserCorrection } from "../src/longterm/write/correction.js";
import {
  MemoryDistiller,
  validateCandidate,
  extractJson,
  type DistillerLlm,
} from "../src/longterm/write/distiller.js";
import { listTrialLessons } from "../src/longterm/write/trial.js";
import {
  MemoryWritePipeline,
  estimateTokens,
} from "../src/longterm/write/pipeline.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

// ═══════════════════════════════════════════════════════════════
// 纯函数：密钥拦截（§5.5）
// ═══════════════════════════════════════════════════════════════

describe("scanForSecrets", () => {
  test("已知模式命中 → reject", () => {
    expect(scanForSecrets("调用时用 sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4 即可").action).toBe("reject");
    expect(scanForSecrets("token 是 ghp_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7").action).toBe("reject");
    expect(scanForSecrets("-----BEGIN PRIVATE KEY----- 之后换行").action).toBe("reject");
    expect(scanForSecrets("aws key AKIAIOSFODNN7EXAMPLE 失效了").action).toBe("reject");
    expect(scanForSecrets("AIzaSyD4iE5fG7hI8jK9lM0nO1pQ2rS3tU4vW5x 报错").action).toBe("reject");
  });

  test("仅高熵无已知模式 → redact 打码", () => {
    const token = "x9Qv2mZ8kLp4Wn7Bz3Ya6TqR"; // 24 字符全唯一，熵≈4.58，无已知前缀
    expect(shannonEntropy(token)).toBeGreaterThan(4.5);
    const r = scanForSecrets(`commit hash 类似 ${token} 的串`);
    expect(r.action).toBe("redact");
    if (r.action === "redact") {
      expect(r.text).toContain("[REDACTED]");
      expect(r.text).not.toContain(token);
    }
  });

  test("普通文本/短 token → pass", () => {
    expect(scanForSecrets("本项目测试框架为 vitest").action).toBe("pass");
    expect(scanForSecrets("port 3000 timeout 30s").action).toBe("pass");
  });
});

// ═══════════════════════════════════════════════════════════════
// 纯函数：用户纠正检测（§5.1）
// ═══════════════════════════════════════════════════════════════

describe("detectUserCorrection", () => {
  test("规则命中", () => {
    expect(detectUserCorrection("记住：以后都用 bun test").isCorrection).toBe(true);
    expect(detectUserCorrection("不要用 jest 了").isCorrection).toBe(true);
    expect(detectUserCorrection("以后都先跑类型检查").isCorrection).toBe(true);
    expect(detectUserCorrection("I prefer pnpm over npm").isCorrection).toBe(true);
    expect(detectUserCorrection("don't use axios here").isCorrection).toBe(true);
  });

  test("普通请求不误报", () => {
    expect(detectUserCorrection("请帮我修复这个测试").isCorrection).toBe(false);
    expect(detectUserCorrection("run the test suite").isCorrection).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 纯函数：蒸馏契约校验（§5.4 / §5.7）
// ═══════════════════════════════════════════════════════════════

describe("validateCandidate", () => {
  const validSemantic = {
    kind: "semantic",
    fact: "The project uses a custom SQL migration runner ordered by version prefix",
    keywords: ["migration"],
    evidence: ["runs/r1/trajectory#step-2"],
  };

  test("合法 semantic 通过", () => {
    expect(validateCandidate(validSemantic).ok).toBe(true);
  });

  test("缺 evidence 拒绝（纪律 4）", () => {
    expect(validateCandidate({ ...validSemantic, evidence: [] }).ok).toBe(false);
  });

  test("文件路径/camelCase 标识符拒绝（纪律 1）", () => {
    expect(validateCandidate({ ...validSemantic, fact: "Edit src/db/migrate.ts first" }).ok).toBe(false);
    expect(validateCandidate({ ...validSemantic, fact: "call runMigrations before tests" }).ok).toBe(false);
  });

  test("episodic whenToUse 必须以 当/When 开头（纪律 2）", () => {
    const base = {
      kind: "episodic",
      perspective: "Module resolution failures usually come from config fields",
      modification: ["Check the config field"],
      evidence: ["runs/r1#step-1"],
    };
    expect(validateCandidate({ ...base, whenToUse: "模块解析失败时" }).ok).toBe(false);
    expect(validateCandidate({ ...base, whenToUse: "When module resolution fails after migration" }).ok).toBe(true);
    expect(validateCandidate({ ...base, whenToUse: "当模块解析失败时" }).ok).toBe(true);
  });

  test("modification 超 3 条 / perspective 超 2 句拒绝（纪律 5）", () => {
    const base = {
      kind: "episodic",
      whenToUse: "When builds fail",
      perspective: "One. Two. Three.",
      modification: ["a", "b", "c", "d"],
      evidence: ["runs/r1#s1"],
    };
    const r = validateCandidate(base);
    expect(r.ok).toBe(false);
  });

  test("failureFixPair 缺字段拒绝（纪律 3）", () => {
    const r = validateCandidate({
      kind: "episodic",
      whenToUse: "When tests fail",
      perspective: "Some perspective",
      modification: ["do x"],
      failureFixPair: { failed: "x" },
      evidence: ["runs/r1#s1"],
    });
    expect(r.ok).toBe(false);
  });

  test("extractJson 容忍前后废话", () => {
    expect(extractJson('好的，以下是结果：\n{"candidates": []}\n希望有帮助')).toEqual({ candidates: [] });
  });

  test("estimateTokens 粗略 chars/4", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成：写入管线（§5.8 验收）
// ═══════════════════════════════════════════════════════════════

const RUN = `run_m4_${Date.now().toString(36)}`;
const REPO = `m4-write-test-${Date.now().toString(36)}`;
const createdIds: string[] = [];
const emitted: RunEvent[] = [];

const VALID_LLM: DistillerLlm = {
  complete: async () => JSON.stringify({
    candidates: [{
      kind: "semantic",
      fact: "The project uses a custom SQL migration runner ordered by version prefix",
      keywords: ["migration", "sql"],
      evidence: [`runs/${RUN}/trajectory#step-2`],
    }],
  }),
};

const GARBAGE_LLM: DistillerLlm = { complete: async () => "这不是 JSON，格式完全错误" };

function makePipeline(opts: Partial<ConstructorParameters<typeof MemoryWritePipeline>[0]> = {}) {
  return new MemoryWritePipeline({
    distiller: new MemoryDistiller(VALID_LLM),
    emit: (e) => emitted.push(e),
    ...opts,
  });
}

describe("写入管线 db 集成", () => {
  const engine = new PostgresMemoryStoreEngine();

  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
      }
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${REPO}`;
      await sql`DELETE FROM outbox_events WHERE aggregate_type = 'memory_write'`;
      await sql`DELETE FROM memory_trial_lessons WHERE origin_task_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
    }
    await closeSql();
  });

  it("§5.8-1 含密钥轨迹 → 全部拒写 + op-log 记录 + RunEvent", async () => {
    const p = makePipeline();
    const runId = `${RUN}_secret`;
    await p.enqueue({
      type: "task_succeeded",
      runId,
      trajectoryRef: `runs/${runId}`,
      repo: REPO,
      goal: "fix auth",
      trajectory: `used api key sk-a1b2c3d4e5f6g7h8i9j0k1l2m3n4 to call the service`,
      verdict: { kind: "test", passed: true },
    });
    expect(emitted.some((e) => e.type === "memory.write.enqueued")).toBe(true);

    expect(await p.processNext()).toBe(true);
    const entries = await engine.query({ repo: REPO, includeInvalidated: true });
    expect(entries).toHaveLength(0);

    const logs = await queryOpLog({ runId, op: "write.rejected" });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]!.detail.reason).toBe("secret");
    expect(emitted.some((e) => e.type === "memory.write.rejected" && e.reason === "secret")).toBe(true);
  });

  it("§5.8-2 失败轨迹 → 无正式条目 + trial 池有新教训", async () => {
    const p = makePipeline();
    const runId = `${RUN}_failed`;
    const r = await p.processEvent({
      type: "task_failed",
      runId,
      trajectoryRef: `runs/${runId}`,
      repo: REPO,
      goal: "migrate module system",
      trajectory: "tried changing imports, tests still failing with resolution error",
    });
    expect(r.status).toBe("trialed");

    const entries = await engine.query({ repo: REPO, includeInvalidated: true });
    expect(entries).toHaveLength(0);

    const trials = await listTrialLessons(runId);
    expect(trials).toHaveLength(1);
    expect(trials[0]!.attemptsLeft).toBe(3);
  });

  it("用户纠正免门控直写 + 可撤销确认", async () => {
    const p = makePipeline();
    const r = await p.processEvent({
      type: "user_correction",
      text: "记住：提交前必跑完整测试套件",
      messageRef: "msg-1",
      runId: `${RUN}_corr`,
      repo: REPO,
    });
    expect(r.status).toBe("corrected");
    if (r.status !== "corrected") return;
    createdIds.push(r.memoryId);
    expect(r.undoHint).toContain("memory forget");
    expect(r.undoHint).toContain(r.memoryId);

    const entry = await engine.get(r.memoryId);
    expect(entry!.source).toBe("user_statement");
    expect(entry!.confidence).toBe(1.0);
    expect(emitted.some((e) => e.type === "memory.governed" && e.entryId === r.memoryId)).toBe(true);
  });

  it("禁止盲改条款：无反馈信号的 task_succeeded 不固化", async () => {
    const p = makePipeline();
    const runId = `${RUN}_blind`;
    const r = await p.processEvent({
      type: "task_succeeded",
      runId,
      trajectoryRef: `runs/${runId}`,
      repo: REPO,
      goal: "refactor something",
      trajectory: "did some refactoring, agent believes it succeeded",
      verdict: { kind: "none" },
    });
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") expect(r.reason).toBe("unverified");
    const logs = await queryOpLog({ runId, op: "write.rejected" });
    expect(logs[0]!.detail.reason).toBe("unverified");
  });

  it("验证门控：测试通过的轨迹走固化通道（蒸馏→入库）", async () => {
    const p = makePipeline();
    const r = await p.processEvent({
      type: "task_succeeded",
      runId: `${RUN}_ok`,
      trajectoryRef: `runs/${RUN}_ok`,
      repo: REPO,
      goal: "add migration",
      trajectory: "added migration file, all tests passed",
      verdict: { kind: "test", passed: true },
    });
    expect(r.status).toBe("written");
    if (r.status !== "written") return;
    createdIds.push(...r.memoryIds);
    const entry = await engine.get(r.memoryIds[0]!);
    expect(entry!.kind).toBe("semantic");
    expect(entry!.source).toBe("agent_verified");
    expect(entry!.confidence).toBe(0.8);
    expect(entry!.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it("测试失败 outcome 转试用通道（不固化）", async () => {
    const p = makePipeline();
    const runId = `${RUN}_failgate`;
    const r = await p.processEvent({
      type: "task_succeeded",
      runId,
      trajectoryRef: `runs/${runId}`,
      repo: REPO,
      goal: "change config",
      trajectory: "changed config but compile failed",
      verdict: { kind: "compile", passed: false },
    });
    expect(r.status).toBe("trialed");
    expect((await listTrialLessons(runId)).length).toBe(1);
  });

  it("session_finalize 兜底蒸馏 confidence ≤0.6", async () => {
    const p = makePipeline();
    const r = await p.processEvent({
      type: "session_finalize",
      conversationId: `${RUN}_conv`,
      runId: `${RUN}_fin`,
      repo: REPO,
      goal: "discuss design",
      trajectory: "long discussion about design decisions",
    });
    expect(r.status).toBe("written");
    if (r.status !== "written") return;
    createdIds.push(...r.memoryIds);
    const entry = await engine.get(r.memoryIds[0]!);
    expect(entry!.confidence).toBeLessThanOrEqual(0.6);
  });

  it("§5.8-5 弱模型格式错误 → 降级条目 unverified 且不参与注入", async () => {
    const p = makePipeline({ distiller: new MemoryDistiller(GARBAGE_LLM) });
    const runId = `${RUN}_weak`;
    const r = await p.processEvent({
      type: "task_succeeded",
      runId,
      trajectoryRef: `runs/${runId}`,
      repo: REPO,
      goal: "xyzzy weak model probe",
      trajectory: "xyzzy weak model trajectory content for degraded storage",
      verdict: { kind: "test", passed: true },
    });
    expect(r.status).toBe("degraded");
    if (r.status !== "degraded") return;
    createdIds.push(r.memoryId);

    // 条目存在、可读（memory list 可见），但 unverified + 低置信
    const entry = await engine.get(r.memoryId);
    expect(entry).not.toBeNull();
    expect(entry!.confidence).toBe(0.3);
    expect(entry!.source).toBe("agent_inferred");
    const sql = getSql();
    const rows = await sql`SELECT verification_status FROM memory_items WHERE id = ${r.memoryId}`;
    expect((rows[0] as { verification_status: string }).verification_status).toBe("unverified");

    // 不参与自动注入：query/searchText/searchVector/hybridRecall 全部排除
    const q = await engine.query({ repo: REPO });
    expect(q.map((e) => e.id)).not.toContain(r.memoryId);
    const recalled = await hybridRecall(engine, "xyzzy weak model", { candidates: 10 });
    expect(recalled.items.map((i) => i.entry.id)).not.toContain(r.memoryId);
  });

  it("成本熔断：超预算降级为原文摘要（不调 LLM）", async () => {
    let llmCalled = false;
    const countingLlm: DistillerLlm = { complete: async () => { llmCalled = true; return "{}"; } };
    const p = makePipeline({ distiller: new MemoryDistiller(countingLlm), dailyBudget: 0 });
    const r = await p.processEvent({
      type: "task_succeeded",
      runId: `${RUN}_budget`,
      trajectoryRef: `runs/${RUN}_budget`,
      repo: REPO,
      goal: "budget probe plugh",
      trajectory: "plugh budget circuit breaker trajectory content",
      verdict: { kind: "test", passed: true },
    });
    expect(llmCalled).toBe(false);
    expect(r.status).toBe("degraded");
    if (r.status === "degraded") createdIds.push(r.memoryId);
  });

  it("outbox 失败重试 3 次进死信", async () => {
    const brokenEngine = {
      put: async () => { throw new Error("db exploded"); },
    } as unknown as InstanceType<typeof PostgresMemoryStoreEngine>;
    const p = makePipeline({ engine: brokenEngine });
    const runId = `${RUN}_retry`;
    await p.enqueue({
      type: "user_correction",
      text: "记住：这条会触发重试",
      messageRef: "msg-retry",
      runId,
      repo: REPO,
    });

    const sql = getSql();
    for (let attempt = 0; attempt < 4; attempt++) {
      // 清掉退避等待，立即允许重试
      await sql`UPDATE outbox_events SET next_retry_at = NULL WHERE aggregate_type = 'memory_write' AND status = 'pending'`;
      expect(await p.processNext()).toBe(true);
    }
    const rows = await sql`
      SELECT status, retry_count FROM outbox_events
      WHERE aggregate_type = 'memory_write' AND payload->>'runId' = ${runId}
    `;
    expect((rows[0] as { status: string }).status).toBe("dead_letter");
    expect((rows[0] as { retry_count: number }).retry_count).toBe(4);
  });

  it("worker 崩溃不丢：enqueue 后新实例可接手处理", async () => {
    // 第一个实例只入队不处理（模拟崩溃）
    const p1 = makePipeline();
    const runId = `${RUN}_crash`;
    await p1.enqueue({
      type: "user_correction",
      text: "记住：崩溃恢复语义验证",
      messageRef: "msg-crash",
      runId,
      repo: REPO,
    });
    // 第二个实例（新 pipeline）从 db 队列接手
    const p2 = makePipeline();
    expect(await p2.processNext()).toBe(true);
    const entries = await engine.query({ repo: REPO, includeInvalidated: true });
    const found = entries.find((e) => e.kind === "semantic" && e.fact.includes("崩溃恢复"));
    expect(found).toBeDefined();
    createdIds.push(found!.id);
  });
});
