/**
 * 混合召回融合层测试（spec v2 §6.3 / 12 M2）
 *
 * - fuseRecall 纯函数单测：α 权重、normalize、过滤、附加分（不需要 DB）
 * - hybridRecall db 集成测试：真实库两路召回正确性 + when_to_use 全文命中（V027）
 *
 * db 部分需要 PostgreSQL（含 V027），ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/hybrid-recall.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import {
  fuseRecall,
  hybridRecall,
  RECALL_ALPHA,
  BONUS_SAME_BRANCH,
  BONUS_USER_STATEMENT,
  BONUS_RECENT,
  type ScoredEntry,
} from "../src/longterm/retrieval/hybrid.js";
import type {
  EpisodicExperience,
  MemoryEntry,
  MemoryStoreEngine,
  SemanticFact,
} from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

// ── 测试数据构造 ──

const NOW = new Date("2026-08-06T00:00:00Z");
const OLD = new Date("2026-01-01T00:00:00Z"); // 超出 30 天窗口

function baseEntry(id: string, overrides: Partial<MemoryEntry> = {}): SemanticFact {
  return {
    id,
    kind: "semantic",
    repo: "repo-x",
    // 默认创建于 30 天窗口之外，避免无意命中 recent 附加分；需要时显式覆盖
    created: OLD.toISOString(),
    tValid: OLD.toISOString(),
    tInvalid: null,
    source: "agent_verified",
    confidence: 0.8,
    evidence: [],
    freq: 0,
    utility: 0,
    fact: `fact-${id}`,
    keywords: [],
    embeddingKey: `fact-${id}`,
    ...overrides,
  } as SemanticFact;
}

function scoreOf(items: ScoredEntry[], id: string): ScoredEntry {
  const found = items.find((i) => i.entry.id === id);
  if (!found) throw new Error(`entry ${id} not in results`);
  return found;
}

// ═══════════════════════════════════════════════════════════════
// fuseRecall 纯函数单测（不需要 DB）
// ═══════════════════════════════════════════════════════════════

describe("fuseRecall 融合打分（纯函数）", () => {
  test("α 权重：BM25 与向量按 α 加权", () => {
    const entries = new Map([["a", baseEntry("a")]]);
    const text = [{ id: "a", score: 2 }];
    const vector = [{ id: "a", score: 0.5 }];

    const t1 = fuseRecall(text, vector, entries, { alpha: RECALL_ALPHA.taskStart });
    // bm25 归一化 = 2/2 = 1 → 0.5*1 + 0.5*0.5 = 0.75
    expect(scoreOf(t1, "a").score).toBeCloseTo(0.75, 5);

    const t2 = fuseRecall(text, vector, entries, { alpha: RECALL_ALPHA.actionFailed });
    // 0.7*1 + 0.3*0.5 = 0.85
    expect(scoreOf(t2, "a").score).toBeCloseTo(0.85, 5);
  });

  test("BM25 按候选集最大值归一化", () => {
    const entries = new Map([
      ["top", baseEntry("top")],
      ["half", baseEntry("half")],
    ]);
    const text = [
      { id: "top", score: 4 },
      { id: "half", score: 2 },
    ];
    const items = fuseRecall(text, [], entries, { alpha: 1, context: { now: OLD } });
    expect(scoreOf(items, "top").bm25Score).toBeCloseTo(1, 5);
    expect(scoreOf(items, "half").bm25Score).toBeCloseTo(0.5, 5);
  });

  test("软失效条目被硬过滤（二次兜底）", () => {
    const entries = new Map([
      ["alive", baseEntry("alive")],
      ["dead", baseEntry("dead", { tInvalid: NOW.toISOString() })],
    ]);
    const text = [
      { id: "alive", score: 1 },
      { id: "dead", score: 1 },
    ];
    const items = fuseRecall(text, [], entries, { context: { now: OLD } });
    expect(items.map((i) => i.entry.id)).toEqual(["alive"]);
  });

  test("kind 过滤", () => {
    const entries = new Map([
      ["sem", baseEntry("sem")],
      ["epi", baseEntry("epi", { kind: "episodic" } as Partial<MemoryEntry>)],
    ]);
    const text = [
      { id: "sem", score: 1 },
      { id: "epi", score: 1 },
    ];
    const items = fuseRecall(text, [], entries, { kind: "episodic", context: { now: OLD } });
    expect(items.map((i) => i.entry.id)).toEqual(["epi"]);
  });

  test("排序附加分：同 branch / user_statement / 近 30 天", () => {
    const now = NOW;
    const plain = baseEntry("plain", { created: OLD.toISOString() });
    const branched = baseEntry("branched", {
      kind: "episodic",
      branch: "feat/x",
      created: OLD.toISOString(),
    } as Partial<MemoryEntry>);
    const userSaid = baseEntry("userSaid", { source: "user_statement" });
    const recent = baseEntry("recent", { created: NOW.toISOString() }); // 30 天窗口内

    const entries = new Map([
      ["plain", plain],
      ["branched", branched],
      ["userSaid", userSaid],
      ["recent", recent],
    ]);
    // 四条基础分相同（纯向量 0.4，α=0 → 0.4）
    const vector = [
      { id: "plain", score: 0.4 },
      { id: "branched", score: 0.4 },
      { id: "userSaid", score: 0.4 },
      { id: "recent", score: 0.4 },
    ];
    const items = fuseRecall([], vector, entries, {
      alpha: 0,
      context: { branch: "feat/x", now },
    });

    expect(scoreOf(items, "plain").score).toBeCloseTo(0.4, 5);
    expect(scoreOf(items, "branched").score).toBeCloseTo(0.4 + BONUS_SAME_BRANCH, 5);
    expect(scoreOf(items, "userSaid").score).toBeCloseTo(0.4 + BONUS_USER_STATEMENT, 5);
    expect(scoreOf(items, "recent").score).toBeCloseTo(0.4 + BONUS_RECENT, 5);
    expect(scoreOf(items, "branched").bonuses).toEqual(["same_branch"]);
  });

  test("同 branch 附加分只作用于 episodic", () => {
    const sem = baseEntry("sem");
    // semantic 条目没有 branch 字段；构造一个带 branch 的 semantic 验证不加分
    (sem as unknown as { branch: string }).branch = "feat/x";
    const entries = new Map([["sem", sem]]);
    const items = fuseRecall([], [{ id: "sem", score: 0.4 }], entries, {
      alpha: 0,
      context: { branch: "feat/x", now: NOW },
    });
    expect(scoreOf(items, "sem").score).toBeCloseTo(0.4, 5);
  });

  test("空输入 → 空结果（冷启动零开销）", () => {
    expect(fuseRecall([], [], new Map())).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// hybridRecall 降级行为（stub 引擎，不需要 DB）
// ═══════════════════════════════════════════════════════════════

describe("hybridRecall 降级（stub 引擎）", () => {
  const stubEntry = baseEntry("s1");
  const stubEngine = (overrides: Partial<MemoryStoreEngine>): MemoryStoreEngine => ({
    put: async () => {},
    get: async () => stubEntry,
    invalidate: async () => {},
    delete: async () => {},
    query: async () => [],
    searchText: async () => [{ id: "s1", score: 1 }],
    searchVector: async () => [{ id: "s1", score: 0.9 }],
    ledger: async () => null,
    bumpLedger: async () => {},
    reindex: async () => ({ scanned: 0, indexed: 0, failed: 0, smoke: { total: 0, passed: 0, failedIds: [] } }),
    ...overrides,
  });

  test("向量路失败 → BM25-only 且 degraded=true", async () => {
    const engine = stubEngine({
      searchVector: async () => { throw new Error("embedding down"); },
    });
    const result = await hybridRecall(engine, "query");
    expect(result.degraded).toBe(true);
    expect(result.items.map((i) => i.entry.id)).toEqual(["s1"]);
    expect(result.items[0]!.vectorScore).toBe(0);
  });

  test("空查询 → 空结果零开销", async () => {
    const engine = stubEngine({});
    const result = await hybridRecall(engine, "   ");
    expect(result).toEqual({ items: [], degraded: false });
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成测试（真实库两路召回）
// ═══════════════════════════════════════════════════════════════

describe("hybridRecall db 集成", () => {
  const engine = new PostgresMemoryStoreEngine();
  const REPO = "hybrid-recall-test-repo";
  const createdIds: string[] = [];

  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
      }
    }
    await closeSql();
  });

  function makeFact(fact: string, keywords: string[]): SemanticFact {
    const now = new Date().toISOString();
    return {
      id: "",
      kind: "semantic",
      repo: REPO,
      created: now,
      tValid: now,
      tInvalid: null,
      source: "agent_verified",
      confidence: 0.9,
      evidence: [],
      freq: 0,
      utility: 0,
      fact,
      keywords,
      embeddingKey: `${fact} ${keywords.join(" ")}`,
    };
  }

  it("两路召回融合：语义相近条目进入候选池", async () => {
    const fact = makeFact("Postgres migrations run in lexical order by version prefix", ["migration", "ordering"]);
    const id = deriveEntryId(fact);
    createdIds.push(id);
    await engine.put(fact);

    const result = await hybridRecall(engine, "migration version ordering", { candidates: 10 });
    expect(result.degraded).toBe(false);
    expect(result.items.map((i) => i.entry.id)).toContain(id);
  });

  it("V027：when_to_use 检索键可被全文命中（不经 title/summary）", async () => {
    const now = new Date().toISOString();
    const exp: EpisodicExperience = {
      id: "",
      kind: "episodic",
      repo: REPO,
      created: now,
      tValid: now,
      tInvalid: null,
      source: "agent_verified",
      confidence: 0.8,
      evidence: [],
      freq: 0,
      utility: 0,
      // zorkmid 只出现在 whenToUse，不在 perspective/modification（title/summary 镜像）里
      whenToUse: "当构建报 zorkmid 未定义错误时使用此经验",
      perspective: "构建期未定义符号通常来自条件编译分支",
      modification: ["检查条件编译开关"],
      issueType: "BuildError",
      taskId: "tsk_hybrid_1",
    };
    const id = deriveEntryId(exp);
    createdIds.push(id);
    await engine.put(exp);

    const textHits = await engine.searchText("zorkmid", 5);
    expect(textHits.map((h) => h.id)).toContain(id);

    const result = await hybridRecall(engine, "zorkmid", { candidates: 10 });
    expect(result.items.map((i) => i.entry.id)).toContain(id);
  });

  it("召回默认排除软失效条目", async () => {
    const fact = makeFact("Quixotic cache invalidation strategy for session tokens", ["quixotic"]);
    const id = deriveEntryId(fact);
    createdIds.push(id);
    await engine.put(fact);
    await engine.invalidate(id, new Date().toISOString());

    const result = await hybridRecall(engine, "quixotic", { candidates: 10 });
    expect(result.items.map((i) => i.entry.id)).not.toContain(id);
  });

  it("reindex 冒烟回归全部通过", async () => {
    const fact = makeFact("Smoke queries verify rebuilt indexes recall their entries", ["smoke"]);
    const id = deriveEntryId(fact);
    createdIds.push(id);
    await engine.put(fact);

    const report = await engine.reindex();
    expect(report.failed).toBe(0);
    expect(report.smoke.total).toBeGreaterThan(0);
    expect(report.smoke.passed).toBe(report.smoke.total);
    expect(report.smoke.failedIds).toEqual([]);
  });
});
