/**
 * 修复批次 A 专项测试（对抗性审查 #1/#3/#5；#2/#4 的双向断言在 write-pipeline.test.ts）
 *
 * detectAdoption 为纯函数；其余需要 PostgreSQL（V030），ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/fix-batch-a.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import { queryOpLog } from "../src/longterm/observability/op-log.js";
import { recordRetrievalHits, recordAdoption, detectAdoption } from "../src/longterm/observability/ledger.js";
import { scanDeletionCandidates } from "../src/longterm/lifecycle/janitor.js";
import { TriggeredRetriever } from "../src/longterm/retrieval/triggered.js";
import { MemoryWritePipeline } from "../src/longterm/write/pipeline.js";
import { MemoryDistiller, type DistillerLlm } from "../src/longterm/write/distiller.js";
import type { SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

// ═══════════════════════════════════════════════════════════════
// #1b detectAdoption 纯函数
// ═══════════════════════════════════════════════════════════════

describe("#1b detectAdoption（§10.3 规则初筛）", () => {
  test("关键词命中 → 采纳", () => {
    const ids = detectAdoption(
      [{ id: "a", keywords: ["rotation windows"] }],
      "the deploy failed because of stale Rotation Windows again",
    );
    expect(ids).toEqual(["a"]);
  });

  test("modification 操作序列 ≥60% 词面命中 → 采纳", () => {
    const ids = detectAdoption(
      [{ id: "b", modifications: ["check the exports field in package configuration first"] }],
      "we decided to check the exports field in package configuration before anything else",
    );
    expect(ids).toEqual(["b"]);
  });

  test("无命中 → 不采纳；短关键词不参与", () => {
    expect(detectAdoption([{ id: "c", keywords: ["use"] }], "the user story")).toEqual([]);
    expect(detectAdoption([{ id: "d", keywords: ["kubernetes"] }], "plain sqlite storage")).toEqual([]);
    expect(detectAdoption([{ id: "e", keywords: ["anything"] }], "")).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成
// ═══════════════════════════════════════════════════════════════

const RUN = `run_fixa_${Date.now().toString(36)}`;
const REPO = `fixa-test-${Date.now().toString(36)}`;
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

const EMPTY_LLM: DistillerLlm = { complete: async () => JSON.stringify({ candidates: [] }) };

describe("修复批次 A db 集成", () => {
  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
      }
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${REPO}`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM outbox_events WHERE aggregate_type = 'memory_write' AND payload->>'runId' LIKE ${RUN + "%"}`;
    }
    await closeSql();
  });

  it("#1a/#1b 任务成功结算：注入条目 utility+1，轨迹引用的记采纳", async () => {
    const entry = makeSemantic("Zephyr deploys need rotation window checks", ["zephyr"]);
    await engine.put(entry);
    const id = deriveEntryId(entry);
    createdIds.push(id);

    // 模拟该 run 的注入记录
    const runId = `${RUN}_settle`;
    await recordRetrievalHits(engine, [id], { runId });
    expect((await engine.ledger(id))!.freq).toBe(1);

    // 任务成功（verifier pass），轨迹中引用了 zephyr
    const p = new MemoryWritePipeline({ distiller: new MemoryDistiller(EMPTY_LLM) });
    await p.processEvent({
      type: "task_succeeded", runId, trajectoryRef: `runs/${runId}`, repo: REPO,
      goal: "fix zephyr deploy",
      trajectory: "checked the zephyr rotation window and the deploy succeeded",
      verdict: { kind: "test", passed: true },
    });

    const ledger = await engine.ledger(id);
    expect(ledger!.utility).toBe(1); // utility 结算
    const adopted = await queryOpLog({ runId, op: "read.adopted" });
    expect(adopted).toHaveLength(1);
    expect(adopted[0]!.entryIds).toContain(id);
  });

  it("#1b 轨迹未引用 → 不记采纳（utility 仍结算）", async () => {
    const entry = makeSemantic("Topaz caches need warmup", ["topaz"]);
    await engine.put(entry);
    const id = deriveEntryId(entry);
    createdIds.push(id);

    const runId = `${RUN}_noadopt`;
    await recordRetrievalHits(engine, [id], { runId });
    const p = new MemoryWritePipeline({ distiller: new MemoryDistiller(EMPTY_LLM) });
    await p.processEvent({
      type: "task_succeeded", runId, trajectoryRef: `runs/${runId}`, repo: REPO,
      goal: "unrelated task", trajectory: "did something completely different and it worked",
      verdict: { kind: "test", passed: true },
    });

    expect((await engine.ledger(id))!.utility).toBe(1);
    expect(await queryOpLog({ runId, op: "read.adopted" })).toHaveLength(0);
  });

  it("#1c 无采纳埋点数据 → freq≥8 全败条目不进删除候选；有埋点且采纳率 0 → 进", async () => {
    const sql = getSql();
    // 构造无采纳环境：清空全库 read.adopted（各测试文件自带数据，互不影响）
    await sql`DELETE FROM memory_op_log WHERE op = 'read.adopted'`;

    const entry = makeSemantic("Marble entry with eight injections and zero adoptions");
    await engine.put(entry);
    const id = deriveEntryId(entry);
    createdIds.push(id);
    for (let i = 0; i < 8; i++) await recordRetrievalHits(engine, [id], { runId: `${RUN}_jc_${i}` });

    // 全库无 read.adopted → 信号不足，不定罪
    let candidates = await scanDeletionCandidates({ repo: REPO });
    expect(candidates.map((c) => c.id)).not.toContain(id);

    // 存在采纳埋点（别的条目被采纳过）→ 该条目采纳率 0 <0.2 → 进候选
    const other = makeSemantic("Nacre entry that got adopted once");
    await engine.put(other);
    const otherId = deriveEntryId(other);
    createdIds.push(otherId);
    await recordAdoption(`${RUN}_jc_other`, [otherId]);

    candidates = await scanDeletionCandidates({ repo: REPO });
    expect(candidates.map((c) => c.id)).toContain(id);
    expect(candidates.find((c) => c.id === id)!.adoptionRate).toBe(0);
  });

  it("#3 并发 worker：同一事件只被处理一次（SKIP LOCKED）", async () => {
    const runId = `${RUN}_conc`;
    const p1 = new MemoryWritePipeline();
    const p2 = new MemoryWritePipeline();
    await p1.enqueue({
      type: "user_correction", text: "记住：并发处理一次性探针", messageRef: "m-conc", runId, repo: REPO,
    });

    // 两个实例并发抢 10 次
    const results = await Promise.all([
      p1.processNext(), p2.processNext(), p1.processNext(), p2.processNext(),
      p1.processNext(), p2.processNext(), p1.processNext(), p2.processNext(),
      p1.processNext(), p2.processNext(),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const sql = getSql();
    const rows = await sql`
      SELECT id, status FROM memory_items
      WHERE scope->>'repositoryId' = ${REPO} AND title LIKE '%并发处理一次性探针%'
    `;
    expect(rows).toHaveLength(1); // 只写入一次
    createdIds.push((rows[0] as { id: string }).id);

    const [ob] = await sql`
      SELECT status FROM outbox_events WHERE aggregate_type = 'memory_write' AND payload->>'runId' = ${runId}
    `;
    expect((ob as { status: string }).status).toBe("published");
  });

  it("#3 崩溃遗留 processing 行超 5 分钟被回收处理", async () => {
    const runId = `${RUN}_stale`;
    const p = new MemoryWritePipeline();
    await p.enqueue({
      type: "user_correction", text: "记住：崩溃回收探针", messageRef: "m-stale", runId, repo: REPO,
    });
    const sql = getSql();
    // 模拟崩溃：行卡在 processing 且 10 分钟前
    await sql`
      UPDATE outbox_events SET status = 'processing', processing_at = now() - interval '10 minutes'
      WHERE aggregate_type = 'memory_write' AND payload->>'runId' = ${runId}
    `;
    expect(await p.processNext()).toBe(true); // 回收并处理
    const rows = await sql`
      SELECT id FROM memory_items
      WHERE scope->>'repositoryId' = ${REPO} AND title LIKE '%崩溃回收探针%'
    `;
    expect(rows).toHaveLength(1);
    createdIds.push((rows[0] as { id: string }).id);
  });

  it("#3 并发 enqueue：sequence 唯一约束兜底不丢事件", async () => {
    const p1 = new MemoryWritePipeline();
    const p2 = new MemoryWritePipeline();
    const mk = (i: number) => ({
      type: "user_correction" as const, text: `记住：并发入队探针 ${i}`, messageRef: `m-enq-${i}`,
      runId: `${RUN}_enq_${i}`, repo: REPO,
    });
    // 20 个并发入队
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? p1 : p2).enqueue(mk(i))));

    const sql = getSql();
    const [cnt] = await sql`
      SELECT count(*)::int AS n FROM outbox_events
      WHERE aggregate_type = 'memory_write' AND payload->>'runId' LIKE ${RUN + "_enq_%"}
    `;
    expect((cnt as { n: number }).n).toBe(20); // 无一丢失
    // 清理这 20 条（不处理）
    await sql`DELETE FROM outbox_events WHERE aggregate_type = 'memory_write' AND payload->>'runId' LIKE ${RUN + "_enq_%"}`;
  });

  it("#5 单条超预算条目被截断到预算硬顶内 + 记 read.truncated", async () => {
    const big = makeSemantic("Obsidian oversized entry: " + "detailed step by step explanation. ".repeat(150), ["obsidian"]);
    await engine.put(big);
    const id = deriveEntryId(big);
    createdIds.push(id);

    const runId = `${RUN}_big`;
    const r = new TriggeredRetriever({ engine, countTokens: (t) => Math.ceil(t.length / 4), maxInjectTokens: 500 });
    const pkg = await r.retrieve({
      type: "explicit_query", question: "obsidian oversized", repo: REPO, runId,
    });

    expect(pkg.items).toHaveLength(1);
    expect(pkg.items[0]!.truncated).toBe(true);
    expect(pkg.items[0]!.text).toContain("[已截断]");
    expect(pkg.totalTokens).toBeLessThanOrEqual(500); // 硬顶无例外
    expect(pkg.totalTokens).toBeGreaterThan(0);

    const trunc = await queryOpLog({ runId, op: "read.truncated" });
    expect(trunc).toHaveLength(1);
    expect(trunc[0]!.detail.singleItem).toBe(true);
  });
});
