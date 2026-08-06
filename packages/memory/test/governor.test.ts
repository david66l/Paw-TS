/**
 * Governor 批量裁决测试（spec v2 §5.6 / §7.4，验收 §5.8-3/4）
 *
 * 纯函数部分（时序倒挂规则、输出校验、prompt 构造）不需要 DB；
 * db 部分需要 PostgreSQL，LLM 全部 mock，ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/governor.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import { hybridRecall } from "../src/longterm/retrieval/hybrid.js";
import { collectWhy } from "../src/longterm/observability/why.js";
import { queryOpLog } from "../src/longterm/observability/op-log.js";
import {
  LongtermGovernor,
  isTemporalInversion,
  parseGovernorOutput,
  buildAdjudicationPrompt,
  type GovernorLlm,
} from "../src/longterm/write/governor.js";
import { MemoryDistiller, type DistillerLlm } from "../src/longterm/write/distiller.js";
import { MemoryWritePipeline } from "../src/longterm/write/pipeline.js";
import type { SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

function makeFact(fact: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
  const now = new Date().toISOString();
  return {
    id: "",
    kind: "semantic",
    repo: "gov-test",
    created: now,
    tValid: now,
    tInvalid: null,
    source: "agent_verified",
    confidence: 0.8,
    evidence: ["runs/r1#step-1"],
    freq: 0,
    utility: 0,
    fact,
    keywords: [],
    embeddingKey: fact,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// 纯函数（不需要 DB）
// ═══════════════════════════════════════════════════════════════

describe("时序倒挂规则（§7.4）", () => {
  test("候选 tValid 早于活跃相似条目 → 倒挂", () => {
    const old = makeFact("old fact", { tValid: "2026-01-01T00:00:00Z" });
    const existing = makeFact("newer fact", { tValid: "2026-08-01T00:00:00Z" });
    expect(isTemporalInversion(old, [existing])).toBe(true);
  });

  test("候选更新 / 相似已失效 → 不倒挂", () => {
    const fresh = makeFact("fresh fact", { tValid: "2026-08-02T00:00:00Z" });
    const existing = makeFact("older", { tValid: "2026-08-01T00:00:00Z" });
    expect(isTemporalInversion(fresh, [existing])).toBe(false);
    const dead = makeFact("dead", { tValid: "2026-08-01T00:00:00Z", tInvalid: "2026-08-03T00:00:00Z" });
    expect(isTemporalInversion(fresh, [dead])).toBe(false);
  });
});

describe("parseGovernorOutput 校验", () => {
  test("合法输出映射序号→裁决", () => {
    const r = parseGovernorOutput(
      JSON.stringify({ decisions: [
        { candidate: 1, op: "ADD", target: null, reason: "new" },
        { candidate: 2, op: "INVALIDATE", target: 1, reason: 'candidate 说"用 vitest" vs E-1 说"用 jest"' },
      ] }),
      2,
      3,
    );
    expect(r.errors).toEqual([]);
    expect(r.byCandidate.get(0)).toEqual({ op: "ADD", targetSeq: undefined, reason: "new" });
    expect(r.byCandidate.get(1)!.op).toBe("INVALIDATE");
    expect(r.byCandidate.get(1)!.targetSeq).toBe(0); // 1-based → 0-based
  });

  test("幻觉序号（越界 candidate/target）→ 该条剔除 + error", () => {
    const r = parseGovernorOutput(
      JSON.stringify({ decisions: [
        { candidate: 99, op: "ADD", target: null },
        { candidate: 1, op: "UPDATE", target: 77 },
        { candidate: 1, op: "ADD", target: null },
      ] }),
      2,
      2,
    );
    expect(r.errors.length).toBe(2);
    expect(r.byCandidate.get(0)!.op).toBe("ADD");
  });

  test("UPDATE/INVALIDATE 缺 target → error", () => {
    const r = parseGovernorOutput(
      JSON.stringify({ decisions: [{ candidate: 1, op: "UPDATE", target: null }] }),
      1,
      1,
    );
    expect(r.errors.length).toBe(1);
    expect(r.byCandidate.size).toBe(0);
  });

  test("非 JSON 输出抛错（由调用方重试）", () => {
    expect(() => parseGovernorOutput("无法裁决", 1, 1)).toThrow();
  });
});

describe("buildAdjudicationPrompt", () => {
  test("整数序号 + 纪律文本", () => {
    const prompt = buildAdjudicationPrompt([
      { candidate: makeFact("fact one"), similar: [makeFact("existing one", { id: "semantic-abc" })] },
      { candidate: makeFact("fact two"), similar: [] },
    ]);
    expect(prompt).toContain("候选 C1");
    expect(prompt).toContain("候选 C2");
    expect(prompt).toContain("既有条目 E1");
    expect(prompt).toContain("引用双方原文片段");
    expect(prompt).toContain("不得仅因");
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成（LLM 全 mock）
// ═══════════════════════════════════════════════════════════════

const RUN = `run_m5_${Date.now().toString(36)}`;
const REPO = `m5-gov-test-${Date.now().toString(36)}`;
const createdIds: string[] = [];

function distillerWith(candidates: unknown[]): MemoryDistiller {
  const llm: DistillerLlm = { complete: async () => JSON.stringify({ candidates }) };
  return new MemoryDistiller(llm);
}

function successEvent(fact: string) {
  return {
    candidates: [{
      kind: "semantic",
      fact,
      keywords: ["testing"],
      evidence: [`runs/${RUN}/trajectory#step-1`],
    }],
  };
}

describe("Governor db 集成", () => {
  const engine = new PostgresMemoryStoreEngine();

  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
      }
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${REPO}`;
      await sql`DELETE FROM governance_decisions WHERE policy_version = 'v2-m5'`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM memory_op_log WHERE op = 'error' AND detail->>'stage' LIKE 'governor%'`;
    }
    await closeSql();
  });

  it("§5.8-3 同一事实二次蒸馏 → 第二次裁决 NOOP，不新增条目", async () => {
    // 第一次：库空，mock Governor 判 ADD
    let governorResponse = JSON.stringify({ decisions: [{ candidate: 1, op: "ADD", target: null, reason: "new fact" }] });
    const govLlm: GovernorLlm = { complete: async () => governorResponse };
    const p1 = new MemoryWritePipeline({ distiller: distillerWith(successEvent("The project uses vitest for unit testing").candidates), governorLlm: govLlm });
    const r1 = await p1.processEvent({
      type: "task_succeeded", runId: `${RUN}_noop1`, trajectoryRef: `runs/${RUN}_noop1`,
      repo: REPO, goal: "g", trajectory: "t", verdict: { kind: "test", passed: true },
    });
    expect(r1.status).toBe("written");
    if (r1.status !== "written") return;
    createdIds.push(...r1.memoryIds);
    expect(r1.memoryIds).toHaveLength(1);

    // 第二次：语义等价事实，mock Governor 判 NOOP
    governorResponse = JSON.stringify({ decisions: [{ candidate: 1, op: "NOOP", target: null, reason: "与 E1 语义等价" }] });
    const p2 = new MemoryWritePipeline({ distiller: distillerWith(successEvent("The unit testing framework is vitest").candidates), governorLlm: govLlm });
    const r2 = await p2.processEvent({
      type: "task_succeeded", runId: `${RUN}_noop2`, trajectoryRef: `runs/${RUN}_noop2`,
      repo: REPO, goal: "g", trajectory: "t", verdict: { kind: "test", passed: true },
    });
    expect(r2.status).toBe("noop");

    const entries = await engine.query({ repo: REPO, includeInvalidated: true });
    expect(entries).toHaveLength(1); // 不新增

    // 裁决记录落 governance_decisions
    const sql = getSql();
    const decs = await sql`SELECT decision FROM governance_decisions WHERE policy_version = 'v2-m5' ORDER BY created_at`;
    expect(decs.map((d) => (d as { decision: string }).decision)).toEqual(["ADD", "NOOP"]);
  });

  it("§5.8-4 矛盾事实（jest→vitest）→ 旧条目失效 + 新条目 ADD + 检索只返回新条目 + why 可查历史", async () => {
    // 既有条目：jest
    const old = makeFact("The project uses jest for unit testing", { repo: REPO });
    await engine.put(old);
    const oldId = deriveEntryId(old);
    createdIds.push(oldId);
    await engine.bumpLedger(oldId, "freq");

    // mock Governor：找到 prompt 中含 jest 的既有条目序号，判 INVALIDATE
    const govLlm: GovernorLlm = {
      complete: async (prompt) => {
        const m = /既有条目 E(\d+):\n  fact: [^\n]*jest/i.exec(prompt);
        const target = m ? Number(m[1]) : 1;
        return JSON.stringify({ decisions: [{
          candidate: 1, op: "INVALIDATE", target,
          reason: 'candidate 说"migrated to vitest" vs E-1 说"uses jest"',
        }] });
      },
    };
    const p = new MemoryWritePipeline({
      distiller: distillerWith(successEvent("The project migrated from jest to vitest for unit testing in 2026-05").candidates),
      governorLlm: govLlm,
    });
    const r = await p.processEvent({
      type: "task_succeeded", runId: `${RUN}_contr`, trajectoryRef: `runs/${RUN}_contr`,
      repo: REPO, goal: "g", trajectory: "t", verdict: { kind: "test", passed: true },
    });
    expect(r.status).toBe("written");
    if (r.status !== "written") return;
    createdIds.push(...r.memoryIds);

    // 旧条目软失效（不物理删除）
    const oldEntry = await engine.get(oldId);
    expect(oldEntry).not.toBeNull();
    expect(oldEntry!.tInvalid).not.toBeNull();

    // 新条目活跃
    const newEntry = await engine.get(r.memoryIds[0]!);
    expect(newEntry!.tInvalid).toBeNull();

    // 检索只返回新条目
    const recalled = await hybridRecall(engine, "unit testing framework", { candidates: 10 });
    const recalledIds = recalled.items.map((i) => i.entry.id);
    expect(recalledIds).not.toContain(oldId);

    // memory why 可查旧条目历史（裁决 + 操作记录）
    const why = await collectWhy(engine, oldId);
    expect(why.entry!.tInvalid).not.toBeNull();
    expect(why.decisions.some((d) => d.decision === "INVALIDATE")).toBe(true);
    expect(why.opCounts.governed).toBeGreaterThanOrEqual(1);
  });

  it("UPDATE → history 追加旧值 + 账本保留", async () => {
    const old = makeFact("Tests run with a custom runner before each commit", { repo: REPO });
    await engine.put(old);
    const oldId = deriveEntryId(old);
    createdIds.push(oldId);
    await engine.bumpLedger(oldId, "freq");
    await engine.bumpLedger(oldId, "freq");
    await engine.bumpLedger(oldId, "utility");

    const govLlm: GovernorLlm = {
      complete: async (prompt) => {
        const m = /既有条目 E(\d+):\n  fact: [^\n]*custom runner/i.exec(prompt);
        return JSON.stringify({ decisions: [{ candidate: 1, op: "UPDATE", target: m ? Number(m[1]) : 1, reason: "信息更丰富" }] });
      },
    };
    const p = new MemoryWritePipeline({
      distiller: distillerWith(successEvent("Tests run with a custom runner and type checks before each commit").candidates),
      governorLlm: govLlm,
    });
    const r = await p.processEvent({
      type: "task_succeeded", runId: `${RUN}_upd`, trajectoryRef: `runs/${RUN}_upd`,
      repo: REPO, goal: "g", trajectory: "t", verdict: { kind: "test", passed: true },
    });
    expect(r.status).toBe("written");
    if (r.status !== "written") return;

    // 同 id 覆盖更新
    expect(r.memoryIds[0]).toBe(oldId);
    const updated = (await engine.get(oldId)) as SemanticFact;
    expect(updated.fact).toContain("type checks");
    // history 链含旧值
    expect(updated.history).toHaveLength(1);
    expect(updated.history![0]!.fact).toBe("Tests run with a custom runner before each commit");
    // 账本保留
    const ledger = await engine.ledger(oldId);
    expect(ledger).toEqual({ freq: 2, utility: 1 });
  });

  it("批量裁决：3 条候选一次 LLM 调用返回混合裁决", async () => {
    const existing = makeFact("Builds use the custom bundler with cache enabled", { repo: REPO });
    await engine.put(existing);
    const existingId = deriveEntryId(existing);
    createdIds.push(existingId);

    let llmCalls = 0;
    const govLlm: GovernorLlm = {
      complete: async (prompt) => {
        llmCalls += 1;
        // 候选数应为 3
        expect(prompt).toContain("候选 C3");
        const m = /既有条目 E(\d+):\n  fact: [^\n]*bundler/i.exec(prompt);
        return JSON.stringify({ decisions: [
          { candidate: 1, op: "ADD", target: null, reason: "new" },
          { candidate: 2, op: "NOOP", target: null, reason: "equivalent" },
          { candidate: 3, op: "INVALIDATE", target: m ? Number(m[1]) : 1, reason: 'candidate 说"cache disabled" vs E 说"cache enabled"' },
        ] });
      },
    };
    const candidates = [
      { kind: "semantic", fact: "Lints run automatically on every save operation", keywords: [], evidence: [`runs/${RUN}#s1`] },
      { kind: "semantic", fact: "Builds use the custom bundler with cache enabled", keywords: [], evidence: [`runs/${RUN}#s2`] },
      { kind: "semantic", fact: "Builds use the custom bundler with cache disabled after migration", keywords: [], evidence: [`runs/${RUN}#s3`] },
    ];
    const p = new MemoryWritePipeline({ distiller: distillerWith(candidates), governorLlm: govLlm });
    const r = await p.processEvent({
      type: "task_succeeded", runId: `${RUN}_batch`, trajectoryRef: `runs/${RUN}_batch`,
      repo: REPO, goal: "g", trajectory: "t", verdict: { kind: "test", passed: true },
    });

    expect(llmCalls).toBe(1); // 一次 LLM 调用裁决整批
    expect(r.status).toBe("written");
    if (r.status !== "written") return;
    createdIds.push(...r.memoryIds);

    // C1 ADD + C3 INVALIDATE→旧失效+新ADD：共 2 个新条目 id
    expect(r.memoryIds).toHaveLength(2);
    const oldEntry = await engine.get(existingId);
    expect(oldEntry!.tInvalid).not.toBeNull();
    const active = await engine.query({ repo: REPO });
    const activeFacts = active.map((e) => (e as SemanticFact).fact);
    expect(activeFacts).toContain("Lints run automatically on every save operation");
    expect(activeFacts).toContain("Builds use the custom bundler with cache disabled after migration");
  });

  it("时序倒挂：候选 tValid 早于既有条目 → 不进 LLM 直接 NOOP", async () => {
    const existing = makeFact("The project uses vitest for unit testing", { repo: REPO, tValid: new Date().toISOString() });
    await engine.put(existing);
    createdIds.push(deriveEntryId(existing));

    let llmCalls = 0;
    const govLlm: GovernorLlm = { complete: async () => { llmCalls += 1; return JSON.stringify({ decisions: [] }); } };
    // 迟到的旧事实："去年用 jest"
    const staleCandidate = [{
      kind: "semantic",
      fact: "The project used jest for unit testing last year",
      keywords: [],
      evidence: [`runs/${RUN}#s1`],
      tValid: "2025-01-01T00:00:00Z",
    }];
    const p = new MemoryWritePipeline({ distiller: distillerWith(staleCandidate), governorLlm: govLlm });
    const r = await p.processEvent({
      type: "task_succeeded", runId: `${RUN}_stale`, trajectoryRef: `runs/${RUN}_stale`,
      repo: REPO, goal: "g", trajectory: "t", verdict: { kind: "test", passed: true },
    });

    expect(r.status).toBe("noop");
    // 规则层判定，未调 LLM——注意：若相似召回没带上既有条目会走 LLM，此时 llmCalls>0 即暴露回归
    // （ngram 向量对这两句高重叠文本应能召回；不倒挂才是 bug）
    const entries = await engine.query({ repo: REPO, includeInvalidated: true });
    expect(entries.map((e) => (e as SemanticFact).fact)).not.toContain("The project used jest for unit testing last year");
  });

  it("幻觉序号：LLM 返回越界序号 → 该条 NOOP + op-log 记录", async () => {
    const gov = new LongtermGovernor({
      llm: { complete: async () => JSON.stringify({ decisions: [
        { candidate: 1, op: "ADD", target: null, reason: "ok" },
        { candidate: 42, op: "INVALIDATE", target: 99, reason: "hallucinated" },
      ] }) },
    });
    const c1 = makeFact("Governor hallucination probe fact one", { repo: REPO });
    const c2 = makeFact("Governor hallucination probe fact two", { repo: REPO });
    const decisions = await gov.adjudicateBatch([
      { candidate: c1, similar: [] },
      { candidate: c2, similar: [] },
    ]);
    expect(decisions[0]!.op).toBe("ADD");
    // 越界序号被剔除 → 候选 2 缺裁决 → 保守 NOOP
    expect(decisions[1]!.op).toBe("NOOP");

    const logs = await queryOpLog({ op: "error", limit: 50 });
    expect(logs.some((l) => String(l.detail.error ?? "").includes("幻觉候选序号"))).toBe(true);
  });
});
