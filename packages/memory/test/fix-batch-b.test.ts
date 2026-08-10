/**
 * 修复批次 B 专项测试（对抗性审查 #6–#13）
 *
 * 纯函数部分（trial 教训校验/query 改写校验）不需要 DB；
 * db 部分需要 PostgreSQL（V032），LLM 全 mock，ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/fix-batch-b.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import { queryOpLog } from "../src/longterm/observability/op-log.js";
import { collectMemoryDiff } from "../src/longterm/observability/diff.js";
import { TriggeredRetriever, parseQueryRewrite } from "../src/longterm/retrieval/triggered.js";
import { MemoryWritePipeline } from "../src/longterm/write/pipeline.js";
import { MemoryDistiller, type DistillerLlm } from "../src/longterm/write/distiller.js";
import { parseTrialLessonOutput, listTrialLessons } from "../src/longterm/write/trial.js";
import { runLifecycleOnce } from "../src/longterm/lifecycle/janitor.js";
import { collectGarbage } from "../src/longterm/lifecycle/gc.js";
import type { GovernorLlm } from "../src/longterm/write/governor.js";
import type { EpisodicExperience, SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

// ═══════════════════════════════════════════════════════════════
// 纯函数
// ═══════════════════════════════════════════════════════════════

describe("parseTrialLessonOutput（#7）", () => {
  test("合法教训通过", () => {
    const r = parseTrialLessonOutput(JSON.stringify({
      lesson: "我不该直接改配置，应该先跑最小复现。",
      whenToUse: "When config changes break the build",
      keywords: ["config", "build"],
    }));
    expect(r).not.toBeNull();
    expect(r!.whenToUse).toContain("When");
  });

  test("超 3 句 / 缺 whenToUse 前缀 / 非 JSON → null", () => {
    expect(parseTrialLessonOutput('{"lesson":"一。二。三。四。","whenToUse":"When x","keywords":[]}')).toBeNull();
    expect(parseTrialLessonOutput('{"lesson":"ok","whenToUse":"任何时候","keywords":[]}')).toBeNull();
    expect(parseTrialLessonOutput("garbage")).toBeNull();
  });
});

describe("parseQueryRewrite（#9）", () => {
  test("提炼词通过；JSON 残骸/超长/空 → null", () => {
    expect(parseQueryRewrite("quartz deadlock shutdown hooks")).toBe("quartz deadlock shutdown hooks");
    expect(parseQueryRewrite('"quoted terms"')).toBe("quoted terms");
    expect(parseQueryRewrite('{"terms": ["x"]}')).toBeNull();
    expect(parseQueryRewrite("")).toBeNull();
    expect(parseQueryRewrite("x".repeat(400))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成
// ═══════════════════════════════════════════════════════════════

const RUN = `run_fixb_${Date.now().toString(36)}`;
const REPO = `fixb-test-${Date.now().toString(36)}`;
const FILE_START = new Date().toISOString();
const createdIds: string[] = [];
const engine = new PostgresMemoryStoreEngine();

const CONFIRM = { confirm: async () => true };

function makeSemantic(fact: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
  const now = new Date().toISOString();
  return {
    id: "", kind: "semantic", repo: REPO, created: now, tValid: now, tInvalid: null,
    source: "agent_verified", confidence: 0.9, evidence: [], freq: 0, utility: 0,
    fact, keywords: [], embeddingKey: fact,
    ...overrides,
  };
}

describe("修复批次 B db 集成", () => {
  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
      }
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${REPO}`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM memory_trial_lessons WHERE origin_task_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM outbox_events WHERE aggregate_type = 'memory_write' AND payload->>'runId' LIKE ${RUN + "%"}`;
      await sql`DELETE FROM memory_gc_archive WHERE entry_id LIKE 'episodic-%'`;
      // 本文件产生的 Governor 裁决记录（避免污染 governor.test.ts 的全表断言）
      await sql`DELETE FROM governance_decisions WHERE policy_version = 'v2-m5' AND created_at >= ${FILE_START}::timestamptz`;
    }
    await closeSql();
  });

  it("#6 episodic 蒸馏候选正常落库走 Governor；不支持 kind 记 op-log", async () => {
    const govLlm: GovernorLlm = {
      complete: async () => JSON.stringify({ decisions: [{ candidate: 1, op: "ADD", target: null, reason: "new" }] }),
    };
    const distiller = new MemoryDistiller({
      complete: async () => JSON.stringify({ candidates: [{
        kind: "episodic",
        whenToUse: "When peridot deploys fail with credential mismatch",
        perspective: "Peridot credential mismatches usually come from stale rotation windows",
        modification: ["Check the rotation window first"],
        failureFixPair: { failed: "deploy", feedback: "CredentialMismatchError", fixed: "rotate window" },
        issueType: "CredentialMismatchError",
        evidence: [`runs/${RUN}#s1`],
      }] }),
    });
    const p = new MemoryWritePipeline({ distiller, governorLlm: govLlm });
    const r = await p.processEvent({
      type: "task_succeeded", runId: `${RUN}_epi`, trajectoryRef: `runs/${RUN}_epi`,
      repo: REPO, goal: "g", trajectory: "t", verdict: { kind: "test", passed: true },
    });
    expect(r.status).toBe("written");
    if (r.status !== "written") return;
    createdIds.push(...r.memoryIds);

    const entry = (await engine.get(r.memoryIds[0]!)) as EpisodicExperience;
    expect(entry.kind).toBe("episodic");
    expect(entry.whenToUse).toContain("peridot");
    expect(entry.issueType).toBe("CredentialMismatchError");
    expect(entry.failureFixPair!.fixed).toBe("rotate window");
    // when_to_use 列落库
    const sql = getSql();
    const rows = await sql`SELECT when_to_use FROM memory_items WHERE id = ${r.memoryIds[0]!}`;
    expect((rows[0] as { when_to_use: string }).when_to_use).toContain("peridot");
  });

  it("#7 trial 教训由 LLM 蒸馏（含检索键）；超预算降级原文切片标注", async () => {
    const trialLlm: DistillerLlm = {
      complete: async () => JSON.stringify({
        lesson: "我不该直接轮换令牌，应该先检查轮换窗口。",
        whenToUse: "When garnet token rotation fails with mismatch",
        keywords: ["garnet", "rotation"],
      }),
    };
    const p = new MemoryWritePipeline({ distiller: new MemoryDistiller(trialLlm) });
    const r = await p.processEvent({
      type: "task_failed", runId: `${RUN}_trial`, trajectoryRef: `runs/${RUN}_trial`,
      repo: REPO, goal: "rotate garnet token", trajectory: "rotated token directly, deploy failed",
    });
    expect(r.status).toBe("trialed");
    if (r.status !== "trialed") return;

    const lessons = await listTrialLessons(`${RUN}_trial`);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.distilled).toBe(true);
    expect(lessons[0]!.whenToUse).toContain("garnet");
    expect(lessons[0]!.keywords).toContain("rotation");

    // 超预算降级：原文切片 + distilled=false
    const p2 = new MemoryWritePipeline({ distiller: new MemoryDistiller(trialLlm), dailyBudget: 0 });
    const r2 = await p2.processEvent({
      type: "task_failed", runId: `${RUN}_trial2`, trajectoryRef: `runs/${RUN}_trial2`,
      repo: REPO, goal: "g2", trajectory: "raw failure slice content",
    });
    expect(r2.status).toBe("trialed");
    const lessons2 = await listTrialLessons(`${RUN}_trial2`);
    expect(lessons2[0]!.distilled).toBe(false);
    expect(lessons2[0]!.lesson).toContain("raw failure slice");
  });

  it("#8 trial 随行注入 attemptsLeft 递减，3 次后被 janitor 丢弃", async () => {
    // 蒸馏一条带长特征词检索键的教训
    const p = new MemoryWritePipeline({
      distiller: new MemoryDistiller({
        complete: async () => JSON.stringify({
          lesson: "我不该跳过预检，应该先跑 smoke 检查。",
          whenToUse: "When OlivineModuleResolutionError appears after config changes",
          keywords: ["OlivineModuleResolutionError"],
        }),
      }),
    });
    await p.processEvent({
      type: "task_failed", runId: `${RUN}_dec`, trajectoryRef: `runs/${RUN}_dec`,
      repo: REPO, goal: "g", trajectory: "t",
    });
    const lessons = await listTrialLessons(`${RUN}_dec`);
    const trialId = lessons[0]!.id;
    expect(lessons[0]!.attemptsLeft).toBe(3);

    // 随行注入 3 次（query 含长特征词）
    const retriever = new TriggeredRetriever({ engine, countTokens: (t) => Math.ceil(t.length / 4) });
    // 随行语义（§4.3）：正式库命中后顺带查 trial 池——正式条目须词面命中
    const filler = makeSemantic("OlivineModuleResolutionError handling requires a config reload first");
    await engine.put(filler);
    createdIds.push(deriveEntryId(filler));

    for (let i = 0; i < 3; i++) {
      const pkg = await retriever.retrieve({
        type: "action_failed",
        errorOutput: "OlivineModuleResolutionError: boom\n    at load (x.ts:1:1)",
        lastActionSummary: "run build (exit 1)",
        repo: REPO,
        runId: `${RUN}_dec_${i}`,
      });
      expect(pkg.items.some((it) => it.kind === "trial")).toBe(true);
    }
    const after = await listTrialLessons(`${RUN}_dec`);
    expect(after[0]!.attemptsLeft).toBe(0);

    // janitor 物理丢弃耗尽教训
    const report = await runLifecycleOnce({ config: { repo: REPO } });
    expect(report.capacity.trialDropped).toContain(trialId);
    expect(await listTrialLessons(`${RUN}_dec`)).toHaveLength(0);
  });

  it("#9 T1 query 改写：提炼词与原文双路召回都被使用", async () => {
    // 该条目只命中"提炼词"（原文描述与其词面不相交）
    const e: EpisodicExperience = {
      id: "", kind: "episodic", repo: REPO, created: new Date().toISOString(), tValid: new Date().toISOString(),
      tInvalid: null, source: "agent_verified", confidence: 0.9, evidence: [], freq: 0, utility: 0,
      whenToUse: "When sphene liveness probes flap during rolling updates",
      perspective: "Sphene probe flapping usually comes from misaligned grace periods",
      modification: ["Align the grace period with startup time"],
      issueType: "ProbeFlapError", taskId: "tsk_fixb",
    };
    await engine.put(e);
    createdIds.push(deriveEntryId(e));

    const rewriter = { complete: async () => "sphene liveness probes flap rolling updates" };
    const r = new TriggeredRetriever({
      engine, queryRewriter: rewriter, countTokens: (t) => Math.ceil(t.length / 4),
    });
    const runId = `${RUN}_qr`;
    const pkg = await r.retrieve({
      type: "task_start",
      taskDescription: "部署时健康检查一直抖动，滚动更新老是失败", // 与条目词面不相交
      repo: REPO, runId,
    });
    expect(pkg.items.map((i) => i.id)).toContain(deriveEntryId(e)); // 仅提炼词路可召回

    // read.trigger 记录了两路 query
    const triggers = await queryOpLog({ runId, op: "read.trigger" });
    const queries = triggers[0]!.detail.queries as string[];
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("sphene");
    expect(queries[1]).toContain("部署时健康检查");
  });

  it("#9 query 改写失败 → 降级原文单路 + degraded", async () => {
    const filler2 = makeSemantic("Sphene rewrite fallback probe entry");
    await engine.put(filler2);
    createdIds.push(deriveEntryId(filler2));

    const badRewriter = { complete: async () => { throw new Error("llm down"); } };
    const r = new TriggeredRetriever({ engine, queryRewriter: badRewriter, countTokens: (t) => Math.ceil(t.length / 4) });
    const runId = `${RUN}_qr_fail`;
    const pkg = await r.retrieve({
      type: "task_start", taskDescription: "sphene rewrite fallback probe", repo: REPO, runId,
    });
    expect(pkg.degraded).toBe(true);
    const logs = await queryOpLog({ runId, op: "read.degraded" });
    expect(logs.some((l) => l.detail.stage === "query_rewrite")).toBe(true);
  });

  it("#10 用户纠正三路径：确认直写 / 否认走蒸馏 / 无确认器保守蒸馏", async () => {
    const runId = `${RUN}_corr`;
    // 路径 1：确认 → 直写
    const pYes = new MemoryWritePipeline({ correctionConfirmer: CONFIRM });
    const r1 = await pYes.processEvent({
      type: "user_correction", text: "记住：不要在周五部署", messageRef: "m1", runId: `${runId}_yes`, repo: REPO,
    });
    expect(r1.status).toBe("corrected");
    if (r1.status === "corrected") createdIds.push(r1.memoryId);

    // 路径 2：否认 → 蒸馏通道（走 distiller，非直写）
    const distiller = new MemoryDistiller({
      complete: async () => JSON.stringify({ candidates: [{
        kind: "semantic", fact: "Deployment timing preferences were discussed", keywords: ["deploy"], evidence: [`runs/${RUN}#s9`],
      }] }),
    });
    const pNo = new MemoryWritePipeline({ correctionConfirmer: { confirm: async () => false }, distiller });
    const r2 = await pNo.processEvent({
      type: "user_correction", text: "记住：不要在周五部署", messageRef: "m2", runId: `${runId}_no`, repo: REPO,
    });
    expect(r2.status).toBe("written"); // 走了蒸馏通道
    if (r2.status === "written") {
      createdIds.push(...r2.memoryIds);
      const e2 = (await engine.get(r2.memoryIds[0]!)) as SemanticFact;
      expect(e2.fact).toContain("Deployment timing"); // 是蒸馏产物而非原文直写
      expect(e2.confidence).toBeLessThanOrEqual(0.6); // 降档
    }

    // 路径 3：无确认器 → 保守蒸馏，不直写
    const pNone = new MemoryWritePipeline({ distiller });
    const r3 = await pNone.processEvent({
      type: "user_correction", text: "记住：不要在周五部署", messageRef: "m3", runId: `${runId}_none`, repo: REPO,
    });
    expect(r3.status).not.toBe("corrected");
    // 不存在 source=user_statement 的直写条目
    const directEntries = (await engine.query({ repo: REPO, kind: "semantic", limit: 50 }))
      .filter((e) => e.source === "user_statement" && (e as SemanticFact).fact.includes("周五"));
    expect(directEntries).toHaveLength(1); // 只有路径 1 那一条
  });

  it("#11 Governor 持续故障 → 事件重试后进死信、候选未被静默消费", async () => {
    const badGovLlm: GovernorLlm = { complete: async () => { throw new Error("governor down"); } };
    const distiller = new MemoryDistiller({
      complete: async () => JSON.stringify({ candidates: [{
        kind: "semantic", fact: "Sunstone fact that must not be silently dropped", keywords: [], evidence: [`runs/${RUN}#s7`],
      }] }),
    });
    const p = new MemoryWritePipeline({ distiller, governorLlm: badGovLlm });
    const runId = `${RUN}_govfail`;
    await p.enqueue({
      type: "task_succeeded", runId, trajectoryRef: `runs/${runId}`, repo: REPO,
      goal: "g", trajectory: "t", verdict: { kind: "test", passed: true },
    });

    const sql = getSql();
    for (let i = 0; i < 4; i++) {
      await sql`UPDATE outbox_events SET next_retry_at = NULL WHERE aggregate_type = 'memory_write' AND status = 'pending'`;
      expect(await p.processNext()).toBe(true);
    }
    const rows = await sql`
      SELECT status, retry_count, payload FROM outbox_events
      WHERE aggregate_type = 'memory_write' AND payload->>'runId' = ${runId}
    `;
    expect((rows[0] as { status: string }).status).toBe("dead_letter");
    // 候选未静默消费：库里没有这条事实
    const entries = await engine.query({ repo: REPO, includeInvalidated: true });
    expect(entries.map((e) => (e as SemanticFact).fact)).not.toContain("Sunstone fact that must not be silently dropped");
    // 死信可查（payload 保留完整事件）
    expect((rows[0] as { payload: { trajectoryRef: string } }).payload.trajectoryRef).toBe(`runs/${runId}`);
  });

  it("#12 纯中文事实可被 searchText 命中（simple 兜底列）", async () => {
    const zh = makeSemantic("提交前 必须跑完整测试套件 再合并");
    await engine.put(zh);
    const id = deriveEntryId(zh);
    createdIds.push(id);

    const hits = await engine.searchText("提交前", 5);
    expect(hits.map((h) => h.id)).toContain(id);
  });

  it("#13 gc 写 op-log；diff 三口径（新增/更新/失效/物理删除）", async () => {
    const since = new Date(Date.now() - 3600_000).toISOString();

    // 新增 + 失效 + 物理删除（gc）
    const dead = makeSemantic("Talc entry gc-collected with op-log trail");
    await engine.put(dead);
    const deadId = deriveEntryId(dead);
    createdIds.push(deadId);
    await engine.invalidate(deadId, new Date().toISOString());
    await collectGarbage({ repo: REPO });

    const gcLogs = await queryOpLog({ entryId: deadId, op: "lifecycle.gc" });
    expect(gcLogs).toHaveLength(1);
    expect(gcLogs[0]!.detail.archive).toBe("memory_gc_archive");

    // 更新：put 同 id 带 history（模拟 UPDATE 后的状态）——旧 tValid 早于窗口
    const old = new Date(Date.now() - 7200_000).toISOString();
    const updated = makeSemantic("Ulexite entry with history chain", { tValid: old, created: old });
    await engine.put(updated);
    const updId = deriveEntryId(updated);
    createdIds.push(updId);
    await engine.put({ ...updated, history: [{ fact: "old version", tInvalid: new Date().toISOString() }] });

    const diff = await collectMemoryDiff(since);
    expect(diff.purgedIds).toContain(deadId);            // 物理删除读 lifecycle.gc
    expect(diff.invalidated.map((e) => e.id)).not.toContain(deadId); // 已物理删除的行不再出现在 invalidated
    expect(diff.updated.map((e) => e.id)).toContain(updId); // history 非空 + tValid 未变
    expect(diff.added.map((e) => e.id)).not.toContain(updId); // tValid 早于窗口不算新增
  });
});
