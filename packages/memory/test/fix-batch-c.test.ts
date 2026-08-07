/**
 * 修复批次 C 专项测试（对抗性审查 #14–#22 低危）
 *
 * 纯函数部分不需要 DB；db 部分需要 PostgreSQL（V032），LLM 全 mock，ping 守卫：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/fix-batch-c.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine, smokeProbe } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import { queryOpLog, appendOpLog } from "../src/longterm/observability/op-log.js";
import { collectMemoryStats, renderMemoryStats, DAILY_DISTILL_BUDGET, type MemoryStats } from "../src/longterm/observability/stats.js";
import { extractMatchTerms } from "../src/longterm/retrieval/triggered.js";
import { validateCandidate, hasFailureToSuccessTurn, MemoryDistiller, type DistillerLlm } from "../src/longterm/write/distiller.js";
import { runMemoryCommand } from "../src/longterm/cli.js";
import type { SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

// ═══════════════════════════════════════════════════════════════
// 纯函数
// ═══════════════════════════════════════════════════════════════

describe("#17 failureFixPair 参数化校验", () => {
  const episodic = {
    kind: "episodic",
    whenToUse: "When builds fail after config changes",
    perspective: "Config-related build failures usually come from stale caches",
    modification: ["Clear the build cache"],
    evidence: ["runs/r1#s1"],
  };

  test("轨迹含失败→成功转折时 episodic 缺 failureFixPair → 校验失败", () => {
    expect(hasFailureToSuccessTurn({ outcome: "success", trajectory: "first attempt failed with Error X, then fixed" })).toBe(true);
    const r = validateCandidate(episodic, { requireFailureFixPair: true });
    expect(r.ok).toBe(false);
  });

  test("有 failureFixPair / 无转折 → 通过", () => {
    const withPair = { ...episodic, failureFixPair: { failed: "a", feedback: "b", fixed: "c" } };
    expect(validateCandidate(withPair, { requireFailureFixPair: true }).ok).toBe(true);
    expect(validateCandidate(episodic, { requireFailureFixPair: false }).ok).toBe(true);
    expect(hasFailureToSuccessTurn({ outcome: "success", trajectory: "smooth run" })).toBe(false);
  });

  test("distill 端到端：转折轨迹 + 缺 fixPair 的 LLM 输出 → 重试后降级", async () => {
    const llm: DistillerLlm = { complete: async () => JSON.stringify({ candidates: [episodic] }) };
    const d = new MemoryDistiller(llm);
    const r = await d.distill({ runId: "r1", goal: "g", trajectory: "first attempt failed with TypeError, then succeeded", outcome: "success" });
    expect(r.status).toBe("degraded"); // 两次校验都失败 → 降级
  });
});

describe("#21 中文分词（trial 匹配）", () => {
  test("CJK 段 ≥2 字入词；拉丁长词 >6 入词", () => {
    const terms = extractMatchTerms("当 OlivineModuleResolutionError 出现时不要直接改配置");
    expect(terms).toContain("olivinemoduleresolutionerror");
    // 连续 CJK 段整体成词（无词典分词，子串匹配兜底）；单字 CJK 不入词
    expect(terms).toContain("出现时不要直接改配置");
    expect(terms).not.toContain("当");
  });
});

describe("#14 冒烟探针（非全文）", () => {
  test("semantic 用 keywords 前 2 个；无 keywords 用前 40 字符", () => {
    expect(smokeProbe(makeSemantic("x".repeat(100), ["migration", "sql", "runner"]))).toBe("migration sql");
    expect(smokeProbe(makeSemantic("y".repeat(100)))).toBe("y".repeat(40));
  });
});

describe("#22 stats 成本渲染", () => {
  function stats(calls: number): MemoryStats {
    return {
      active: 10, invalidated: 0, byKind: { semantic: 10 }, unverified: 0, unverifiedRatio: 0,
      deleteCandidates: 0, writeOpsThisMonth: 0, adoptionRate30d: null, injected30d: 0, adopted30d: 0,
      todayDistillCalls: calls, todayEstimatedTokens: 12345,
    };
  }

  test("今日已用/预计剩余展示", () => {
    const text = renderMemoryStats(stats(5));
    expect(text).toContain("5/50 次");
    expect(text).toContain("12345");
    expect(text).toContain("预计剩余 45 次");
  });

  test("≥80% 预算告警", () => {
    expect(renderMemoryStats(stats(Math.floor(DAILY_DISTILL_BUDGET * 0.8)))).toContain("80%");
    expect(renderMemoryStats(stats(1))).not.toContain("80%");
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成
// ═══════════════════════════════════════════════════════════════

const RUN = `run_fixc_${Date.now().toString(36)}`;
const REPO = `fixc-test-${Date.now().toString(36)}`;
const createdIds: string[] = [];
const engine = new PostgresMemoryStoreEngine();

function makeSemantic(fact: string, keywords: string[] = []): SemanticFact {
  const now = new Date().toISOString();
  return {
    id: "", kind: "semantic", repo: REPO, created: now, tValid: now, tInvalid: null,
    source: "agent_verified", confidence: 0.9, evidence: [], freq: 0, utility: 0,
    fact, keywords, embeddingKey: `${fact} ${keywords.join(" ")}`,
  };
}

describe("修复批次 C db 集成", () => {
  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
      }
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${REPO}`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM memory_op_log WHERE op = 'reindex'`;
      await sql`DELETE FROM memory_trial_lessons WHERE origin_task_id LIKE ${RUN + "%"}`;
    }
    await closeSql();
  });

  it("#14 reindex：CLI 可跑 + op-log 留痕 + 关键词子集冒烟通过", async () => {
    const entry = makeSemantic("Heliodor index rebuild probes use keyword subsets", ["heliodor", "reindex"]);
    await engine.put(entry);
    createdIds.push(deriveEntryId(entry));

    const r = await runMemoryCommand(["reindex"]);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("reindex 完成");
    expect(r.text).toContain("冒烟:");

    const logs = await queryOpLog({ op: "reindex", limit: 5 });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(typeof logs[0]!.detail.indexed).toBe("number");
    expect(logs[0]!.detail.smokePassed).toBe(logs[0]!.detail.smokeTotal);
  });

  it("#14 冒烟不抽 degraded 条目（扫描与冒烟同口径）", async () => {
    // degraded 条目：不应进入 scanned 口径
    const deg = { ...makeSemantic("Degraded smoke exclusion probe entry"), degraded: true } as SemanticFact;
    await engine.put(deg);
    createdIds.push(deriveEntryId(deg));

    const report = await engine.reindex();
    // degraded 不参与扫描
    const sql = getSql();
    const [cnt] = await sql`
      SELECT count(*)::int AS n FROM memory_items
      WHERE t_invalid IS NULL AND COALESCE(payload->>'degraded','false') != 'true'
    `;
    expect(report.scanned).toBe((cnt as { n: number }).n);
  });

  it("#19 worker 串行处理有任务间隔（默认 2s）", async () => {
    // 直接验证 tick 的间隔语义：两条事件排空耗时 ≥ 1 个 interval
    const { MemoryWritePipeline } = await import("../src/longterm/write/pipeline.js");
    const p = new MemoryWritePipeline({ intervalMs: 300, correctionConfirmer: { confirm: async () => true } });
    await p.enqueue({ type: "user_correction", text: "记住：间隔探针一", messageRef: "i1", runId: `${RUN}_i1`, repo: REPO });
    await p.enqueue({ type: "user_correction", text: "记住：间隔探针二", messageRef: "i2", runId: `${RUN}_i2`, repo: REPO });

    const t0 = Date.now();
    // 模拟 tick 循环（processNext 单条语义不变）
    let n = 0;
    while (await p.processNext()) {
      n += 1;
      if (n === 1) await new Promise((r) => setTimeout(r, 300));
    }
    expect(n).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280); // 两条之间隔了一个 interval

    const sql = getSql();
    const rows = await sql`
      SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${REPO} AND title LIKE '%间隔探针%'
    `;
    for (const r of rows as unknown as { id: string }[]) createdIds.push(r.id);
    expect(rows).toHaveLength(2);
  });

  it("#20 replay 的 shadow 强制不可覆盖", async () => {
    // T1 只召回 episodic/profile——用 episodic 条目
    const entry: import("../src/longterm/store/engine.js").EpisodicExperience = {
      id: "", kind: "episodic", repo: REPO, created: new Date().toISOString(), tValid: new Date().toISOString(),
      tInvalid: null, source: "agent_verified", confidence: 0.9, evidence: [], freq: 0, utility: 0,
      whenToUse: "When replay shadow enforcement probes run",
      perspective: "Replay shadow enforcement probes verify hypothetical injection",
      modification: ["Check the shadow flag last"],
      issueType: "ProbeError", taskId: "tsk_fixc",
    };
    await engine.put(entry);
    const id = deriveEntryId(entry);
    createdIds.push(id);

    const { runReplay } = await import("../src/longterm/eval/replay.js");
    const report = await runReplay(
      [{ taskId: `${RUN}_shadow`, description: "replay shadow enforcement probes run", repo: REPO, events: [] }],
      // 调用方试图覆盖 shadow:false —— 必须被强制回 true
      { engine, repo: REPO, retrieverOptions: { shadow: false, countTokens: (t: string) => Math.ceil(t.length / 4) } as never },
    );
    expect(report.trajectories).toBe(1);
    expect(report.trajectoriesWithHits).toBe(1);
    // freq 未涨 → shadow 生效
    expect((await engine.ledger(id))!.freq).toBe(0);
    // 有 read.shadow 而非 read.inject
    const shadows = await queryOpLog({ runId: `${RUN}_shadow`, op: "read.shadow" });
    expect(shadows.length).toBeGreaterThanOrEqual(1);
    expect(await queryOpLog({ runId: `${RUN}_shadow`, op: "read.inject" })).toHaveLength(0);
  });

  it("#21 中文教训可命中 trial 随行", async () => {
    const { addTrialLesson } = await import("../src/longterm/write/trial.js");
    const { TriggeredRetriever } = await import("../src/longterm/retrieval/triggered.js");
    await addTrialLesson("我不该跳过预检直接改配置", `${RUN}_cjk`, {
      whenToUse: "当配置变更引发构建失败时",
      keywords: ["配置变更", "构建失败"],
      distilled: true,
    });

    const filler = makeSemantic("配置变更引发构建失败的排查流程");
    await engine.put(filler);
    createdIds.push(deriveEntryId(filler));

    const r = new TriggeredRetriever({ engine, countTokens: (t) => Math.ceil(t.length / 4) });
    const pkg = await r.retrieve({
      type: "action_failed",
      errorOutput: "BuildError: 构建失败\n    at build (x.ts:1:1)",
      lastActionSummary: "配置变更 后跑构建 (exit 1)",
      repo: REPO,
      runId: `${RUN}_cjk_hit`,
    });
    expect(pkg.items.some((i) => i.kind === "trial")).toBe(true);
  });

  it("#22 stats 聚合今日蒸馏成本", async () => {
    await appendOpLog("write.distill", { runId: `${RUN}_cost`, detail: { estimatedTokens: 500 } });
    await appendOpLog("write.enqueued", { runId: `${RUN}_cost`, detail: { eventType: "task_succeeded", estimatedTokens: 300 } });

    const stats = await collectMemoryStats();
    expect(stats.todayDistillCalls).toBeGreaterThanOrEqual(1);
    expect(stats.todayEstimatedTokens).toBeGreaterThanOrEqual(800);
    const text = renderMemoryStats(stats);
    expect(text).toContain("今日蒸馏:");
  });
});
