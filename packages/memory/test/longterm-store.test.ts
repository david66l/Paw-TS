/**
 * 长期记忆存储引擎契约测试（spec v2 §9.1 / 12 M1）
 *
 * 需要 PostgreSQL 测试数据库（含 V026 迁移）：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/longterm-store.test.ts
 *
 * DB 不可用（ping 失败）时整组测试 skip，不 fail。
 */

import { describe, test, expect, afterAll } from "bun:test";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId, deriveMemoryId, normalizeBody } from "../src/longterm/store/id.js";
import type {
  EpisodicExperience,
  ProfileInsight,
  SemanticFact,
} from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

const engine = new PostgresMemoryStoreEngine();
const TEST_REPO = "longterm-store-test-repo";
const createdIds: string[] = [];

function makeFact(fact: string, keywords: string[] = ["bun", "test"]): SemanticFact {
  const now = new Date().toISOString();
  return {
    id: "",
    kind: "semantic",
    repo: TEST_REPO,
    created: now,
    tValid: now,
    tInvalid: null,
    source: "agent_verified",
    confidence: 0.9,
    evidence: ["runs/run-1/trajectory#step-3"],
    freq: 0,
    utility: 0,
    fact,
    keywords,
    embeddingKey: `${fact} ${keywords.join(" ")}`,
  };
}

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

// ═══════════════════════════════════════════════════════════════
// 纯函数：内容哈希 id（不需要 DB）
// ═══════════════════════════════════════════════════════════════

describe("id 派生（纯函数）", () => {
  test("格式为 <kind>-<16 位 hex>", () => {
    const id = deriveMemoryId("semantic", "hello world", "repo-a");
    expect(id).toMatch(/^semantic-[0-9a-f]{16}$/);
  });

  test("同内容幂等；空白/大小写差异被规范化", () => {
    const a = deriveMemoryId("semantic", "Hello   World", "repo-a");
    const b = deriveMemoryId("semantic", "hello world", "repo-a");
    expect(a).toBe(b);
    expect(normalizeBody("  A  b\tC ")).toBe("a b c");
  });

  test("kind/repo/正文任一不同则 id 不同", () => {
    const base = deriveMemoryId("semantic", "fact", "repo-a");
    expect(deriveMemoryId("profile", "fact", "repo-a")).not.toBe(base);
    expect(deriveMemoryId("semantic", "fact", "repo-b")).not.toBe(base);
    expect(deriveMemoryId("semantic", "fact2", "repo-a")).not.toBe(base);
  });
});

// ═══════════════════════════════════════════════════════════════
// 引擎契约（需要 DB）
// ═══════════════════════════════════════════════════════════════

describe("MemoryStoreEngine 契约（db 后端）", () => {
  it("put/get 往返：字段完整还原", async () => {
    const fact = makeFact("This project uses bun test as the test runner");
    const id = deriveEntryId(fact);
    createdIds.push(id);

    await engine.put(fact);
    const got = await engine.get(id);

    expect(got).not.toBeNull();
    expect(got!.id).toBe(id);
    expect(got!.kind).toBe("semantic");
    expect(got!.repo).toBe(TEST_REPO);
    expect((got as SemanticFact).fact).toBe(fact.fact);
    expect((got as SemanticFact).keywords).toEqual(fact.keywords);
    expect(got!.source).toBe("agent_verified");
    expect(got!.confidence).toBe(0.9);
    expect(got!.tInvalid).toBeNull();
    expect(got!.freq).toBe(0);
    expect(got!.utility).toBe(0);
  });

  it("内容哈希幂等：同内容 put 两次不产生重复条目", async () => {
    const fact = makeFact("Migrations are hand-written SQL files");
    const id = deriveEntryId(fact);
    createdIds.push(id);

    await engine.put(fact);
    await engine.put({ ...fact }); // 同内容、不同对象

    const rows = await engine.query({ repo: TEST_REPO, kind: "semantic" });
    const matches = rows.filter((r) => r.id === id);
    expect(matches).toHaveLength(1);

    const sql = getSql();
    const dup = await sql`SELECT count(*)::int AS n FROM memory_items WHERE id = ${id}`;
    expect((dup[0] as { n: number }).n).toBe(1);
  });

  it("episodic 条目的 whenToUse 落入 when_to_use 列", async () => {
    const now = new Date().toISOString();
    const exp: EpisodicExperience = {
      id: "",
      kind: "episodic",
      repo: TEST_REPO,
      created: now,
      tValid: now,
      tInvalid: null,
      source: "agent_verified",
      confidence: 0.8,
      evidence: [],
      freq: 0,
      utility: 0,
      whenToUse: "When module resolution fails after an ESM migration",
      perspective: "ESM migration module resolution failures usually come from the exports field",
      modification: ["Check the exports field in package.json"],
      issueType: "ModuleResolutionError",
      taskId: "tsk_test_1",
    };
    const id = deriveEntryId(exp);
    createdIds.push(id);

    await engine.put(exp);
    const sql = getSql();
    const rows = await sql`SELECT when_to_use FROM memory_items WHERE id = ${id}`;
    expect((rows[0] as { when_to_use: string }).when_to_use).toBe(exp.whenToUse);

    const got = (await engine.get(id)) as EpisodicExperience;
    expect(got.whenToUse).toBe(exp.whenToUse);
    expect(got.issueType).toBe("ModuleResolutionError");
  });

  it("invalidate 后 query 默认过滤，includeInvalidated 可查", async () => {
    const fact = makeFact("Soft invalidation hides entries from default queries");
    const id = deriveEntryId(fact);
    createdIds.push(id);

    await engine.put(fact);
    const tInvalid = new Date().toISOString();
    await engine.invalidate(id, tInvalid);

    const active = await engine.query({ repo: TEST_REPO });
    expect(active.find((r) => r.id === id)).toBeUndefined();

    const all = await engine.query({ repo: TEST_REPO, includeInvalidated: true });
    const invalidated = all.find((r) => r.id === id);
    expect(invalidated).toBeDefined();
    expect(invalidated!.tInvalid).not.toBeNull();

    // get 仍可读（软失效 ≠ 删除）
    const got = await engine.get(id);
    expect(got).not.toBeNull();
  });

  it("ledger/bumpLedger 计数读写", async () => {
    const fact = makeFact("Utility ledger tracks retrieval hits and task successes");
    const id = deriveEntryId(fact);
    createdIds.push(id);

    await engine.put(fact);
    expect(await engine.ledger(id)).toEqual({ freq: 0, utility: 0 });

    await engine.bumpLedger(id, "freq");
    await engine.bumpLedger(id, "freq");
    await engine.bumpLedger(id, "utility");
    expect(await engine.ledger(id)).toEqual({ freq: 2, utility: 1 });

    // 同内容重写（upsert）不重置账本
    await engine.put({ ...fact });
    expect(await engine.ledger(id)).toEqual({ freq: 2, utility: 1 });

    expect(await engine.ledger("semantic-0000000000000000")).toBeNull();
  });

  it("searchText 命中关键词", async () => {
    const fact = makeFact("The zebracorn deploy pipeline runs nightly", ["zebracorn"]);
    const id = deriveEntryId(fact);
    createdIds.push(id);

    await engine.put(fact);
    const hits = await engine.searchText("zebracorn", 5);
    expect(hits.map((h) => h.id)).toContain(id);
  });

  it("searchVector 返回语义相近条目", async () => {
    const fact = makeFact("Vector search over memory embeddings with pgvector");
    const id = deriveEntryId(fact);
    createdIds.push(id);

    await engine.put(fact);
    const hits = await engine.searchVector("memory embeddings pgvector search", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.id)).toContain(id);
  });

  it("reindex 不报错且重建索引", async () => {
    const fact = makeFact("Reindex rebuilds derived embedding indexes");
    const id = deriveEntryId(fact);
    createdIds.push(id);

    await engine.put(fact);
    const report = await engine.reindex();
    expect(report.failed).toBe(0);
    expect(report.indexed).toBeGreaterThanOrEqual(1);

    // reindex 后向量检索仍可用
    const hits = await engine.searchVector("derived embedding indexes", 5);
    expect(hits.map((h) => h.id)).toContain(id);
  });

  it("delete 物理删除条目", async () => {
    const fact = makeFact("Physical delete removes the entry for gc");
    const id = deriveEntryId(fact);

    await engine.put(fact);
    expect(await engine.get(id)).not.toBeNull();

    await engine.delete(id);
    expect(await engine.get(id)).toBeNull();
  });

  it("profile/vault_ref 条目往返", async () => {
    const now = new Date().toISOString();
    const profile: ProfileInsight = {
      id: "",
      kind: "profile",
      repo: TEST_REPO,
      created: now,
      tValid: now,
      tInvalid: null,
      source: "agent_inferred",
      confidence: 0.7,
      evidence: [],
      freq: 0,
      utility: 0,
      insight: "Always runs bun test before committing",
      supportCount: 3,
    };
    const pid = deriveEntryId(profile);
    createdIds.push(pid);
    await engine.put(profile);

    const got = (await engine.get(pid)) as ProfileInsight;
    expect(got.kind).toBe("profile");
    expect(got.insight).toBe(profile.insight);
    expect(got.supportCount).toBe(3);

    const byKind = await engine.query({ repo: TEST_REPO, kind: "profile" });
    expect(byKind.map((r) => r.id)).toContain(pid);
  });
});
