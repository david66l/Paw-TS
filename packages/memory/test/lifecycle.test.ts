/**
 * 生命周期批处理测试（spec v2 §7，验收 §7.9）
 *
 * isAutoMode 为纯函数；其余需要 PostgreSQL（V029），ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/lifecycle.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@paw/core";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import { queryOpLog } from "../src/longterm/observability/op-log.js";
import { recordRetrievalHits, recordAdoption } from "../src/longterm/observability/ledger.js";
import { collectMemoryStats } from "../src/longterm/observability/stats.js";
import {
  runLifecycleOnce,
  scanDeletionCandidates,
  isAutoMode,
  listReviewQueue,
  approveReview,
  rejectReview,
  DEFAULT_LIFECYCLE_CONFIG,
} from "../src/longterm/lifecycle/janitor.js";
import { collectGarbage, queryArchive } from "../src/longterm/lifecycle/gc.js";
import { runMemoryCommand, parseMemoryArgs } from "../src/longterm/cli.js";
import type { ProfileInsight, SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

// ═══════════════════════════════════════════════════════════════
// 纯函数：灰度转全自动判定
// ═══════════════════════════════════════════════════════════════

describe("isAutoMode（灰度判定）", () => {
  const cfg = DEFAULT_LIFECYCLE_CONFIG;
  test("前 200 条一律人工复核", () => {
    expect(isAutoMode({ total: 0, resolved: 0, rejected: 0 }, cfg)).toBe(false);
    expect(isAutoMode({ total: 199, resolved: 199, rejected: 0 }, cfg)).toBe(false);
  });
  test("≥200 条且误删率 <5% → 全自动", () => {
    expect(isAutoMode({ total: 200, resolved: 200, rejected: 5 }, cfg)).toBe(true);
    expect(isAutoMode({ total: 300, resolved: 250, rejected: 12 }, cfg)).toBe(true); // 4.8%
  });
  test("误删率 ≥5% → 继续人工", () => {
    expect(isAutoMode({ total: 200, resolved: 200, rejected: 10 }, cfg)).toBe(false);
  });
  test("CLI 解析 gc 参数", () => {
    expect(parseMemoryArgs(["gc", "--dry-run"])).toEqual({ subcommand: "gc", dryRun: true });
    expect(parseMemoryArgs(["gc", "--review"])).toEqual({ subcommand: "gc", review: true });
    expect(parseMemoryArgs(["gc", "--approve", "semantic-x"])).toEqual({ subcommand: "gc", approve: "semantic-x" });
    expect(parseMemoryArgs(["gc", "--sweep"])).toEqual({ subcommand: "gc", sweep: true });
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成（§7.9）
// ═══════════════════════════════════════════════════════════════

const RUN = `run_m7_${Date.now().toString(36)}`;
const REPO = `m7-lifecycle-${Date.now().toString(36)}`;
const createdIds: string[] = [];
const emitted: RunEvent[] = [];
const engine = new PostgresMemoryStoreEngine();
const emit = (e: RunEvent) => emitted.push(e);
/** 灰度复核流测试里被 reject 的条目（供全自动模式测试断言复核结论优先） */
let rejectedEntryId = "";

function makeSemantic(fact: string, overrides: Partial<SemanticFact> = {}): SemanticFact {
  const now = new Date().toISOString();
  return {
    id: "", kind: "semantic", repo: REPO, created: now, tValid: now, tInvalid: null,
    source: "agent_verified", confidence: 0.8, evidence: [], freq: 0, utility: 0,
    fact, keywords: [], embeddingKey: fact,
    ...overrides,
  };
}

async function putTracked<T extends SemanticFact | ProfileInsight>(entry: T): Promise<string> {
  await engine.put(entry);
  const id = deriveEntryId(entry);
  createdIds.push(id);
  return id;
}

describe("生命周期 db 集成（§7.9）", () => {
  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
        await sql`DELETE FROM memory_lifecycle_review WHERE entry_id = ${id}`;
        await sql`DELETE FROM memory_gc_archive WHERE entry_id = ${id}`;
      }
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${REPO}`;
      await sql`DELETE FROM memory_lifecycle_review WHERE entry_id LIKE 'm7fake-%'`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM memory_op_log WHERE op = 'lifecycle.purge' AND detail->>'reason' IN ('utility_decay', 'capacity')`;
      await sql`DELETE FROM memory_trial_lessons WHERE origin_task_id LIKE ${RUN + "%"}`;
    }
    await closeSql();
  });

  it("§7.9-1/2 效用删除候选判定：8 任务全失败进候选，5 任务/freq=2 受保护", async () => {
    // 8 次注入、1 次采纳（0.125<0.2）、utility=0（outcome 全失败）
    const eight = await putTracked(makeSemantic("Amber entry with eight failed task participations"));
    for (let i = 0; i < 8; i++) await recordRetrievalHits(engine, [eight], { runId: `${RUN}_8_${i}` });
    await recordAdoption(`${RUN}_8_0`, [eight]);

    // 5 次注入（freq<8 试用期保护）
    const five = await putTracked(makeSemantic("Beryl entry with five failed task participations"));
    for (let i = 0; i < 5; i++) await recordRetrievalHits(engine, [five], { runId: `${RUN}_5_${i}` });

    // freq=2 utility=0 新条目
    const two = await putTracked(makeSemantic("Coral entry barely injected twice"));
    await recordRetrievalHits(engine, [two], { runId: `${RUN}_2` });
    await recordRetrievalHits(engine, [two], { runId: `${RUN}_2b` });

    const candidates = await scanDeletionCandidates({ repo: REPO });
    const ids = candidates.map((c) => c.id);
    expect(ids).toContain(eight);
    expect(ids).not.toContain(five);
    expect(ids).not.toContain(two);

    const c8 = candidates.find((c) => c.id === eight)!;
    expect(c8.freq).toBe(8);
    expect(c8.adoptionRate).toBeCloseTo(0.125, 3);

    // stats 的删除候选与 janitor 同一判定（全库口径 ≥1）
    const stats = await collectMemoryStats();
    expect(stats.deleteCandidates).toBeGreaterThanOrEqual(1);
  });

  it("§7.9-3 user_statement 永不进候选；profile supportCount≥3 豁免", async () => {
    const user = await putTracked(makeSemantic("用户说永远先跑类型检查", { source: "user_statement", confidence: 1.0 }));
    for (let i = 0; i < 10; i++) await recordRetrievalHits(engine, [user], { runId: `${RUN}_u_${i}` });

    const now = new Date().toISOString();
    const profileStrong: ProfileInsight = {
      id: "", kind: "profile", repo: REPO, created: now, tValid: now, tInvalid: null,
      source: "agent_inferred", confidence: 0.7, evidence: [], freq: 0, utility: 0,
      insight: "Runs full test suite before every commit", supportCount: 3,
    };
    const strongId = await putTracked(profileStrong);
    for (let i = 0; i < 10; i++) await recordRetrievalHits(engine, [strongId], { runId: `${RUN}_p_${i}` });

    const profileWeak: ProfileInsight = { ...profileStrong, insight: "Sometimes checks the changelog", supportCount: 2 };
    const weakId = await putTracked(profileWeak);
    for (let i = 0; i < 10; i++) await recordRetrievalHits(engine, [weakId], { runId: `${RUN}_w_${i}` });

    const ids = (await scanDeletionCandidates({ repo: REPO })).map((c) => c.id);
    expect(ids).not.toContain(user);      // user_statement 豁免
    expect(ids).not.toContain(strongId);  // profile supportCount≥3 豁免
    expect(ids).toContain(weakId);        // supportCount<2 的 profile 不豁免
  });

  it("灰度复核流：候选进队列 → 不重复进 → approve 软失效 / reject 保护", async () => {
    const target = await putTracked(makeSemantic("Dune entry reviewed by human before deletion"));
    for (let i = 0; i < 8; i++) await recordRetrievalHits(engine, [target], { runId: `${RUN}_r_${i}` });

    const r1 = await runLifecycleOnce({ config: { repo: REPO }, emit });
    expect(r1.autoMode).toBe(false);
    expect(r1.enqueuedForReview).toContain(target);
    expect((await engine.get(target))!.tInvalid).toBeNull(); // 灰度期不自动删

    // 重复 sweep 不重复入队
    const r2 = await runLifecycleOnce({ config: { repo: REPO }, emit });
    expect(r2.enqueuedForReview).not.toContain(target);
    expect(r2.alreadyInQueue).toContain(target);

    const queue = await listReviewQueue();
    expect(queue.some((q) => q.entryId === target && q.status === "pending")).toBe(true);

    // approve → 软失效 + op-log + RunEvent
    expect(await approveReview(target, { engine, emit })).toBe(true);
    expect((await engine.get(target))!.tInvalid).not.toBeNull();
    const purges = await queryOpLog({ entryId: target, op: "lifecycle.purge" });
    expect(purges.length).toBe(1);
    expect(emitted.some((e) => e.type === "memory.lifecycle.purge" && e.entryIds.includes(target))).toBe(true);

    // reject 路径：另一个候选
    const kept = await putTracked(makeSemantic("Ebb entry rejected from deletion review"));
    rejectedEntryId = kept;
    for (let i = 0; i < 8; i++) await recordRetrievalHits(engine, [kept], { runId: `${RUN}_k_${i}` });
    await runLifecycleOnce({ config: { repo: REPO } });
    expect(await rejectReview(kept)).toBe(true);
    expect((await engine.get(kept))!.tInvalid).toBeNull();
    // 再次 sweep 不再进队列
    const r3 = await runLifecycleOnce({ config: { repo: REPO } });
    expect(r3.enqueuedForReview).not.toContain(kept);
    expect((await engine.get(kept))!.tInvalid).toBeNull();
  });

  it("CLI gc --review / --approve 可走通", async () => {
    const viaCli = await putTracked(makeSemantic("Flint entry approved through the CLI review path"));
    for (let i = 0; i < 8; i++) await recordRetrievalHits(engine, [viaCli], { runId: `${RUN}_c_${i}` });
    await runLifecycleOnce({ config: { repo: REPO } });

    const review = await runMemoryCommand(["gc", "--review"]);
    expect(review.ok).toBe(true);
    expect(review.text).toContain(viaCli);

    const approve = await runMemoryCommand(["gc", "--approve", viaCli]);
    expect(approve.ok).toBe(true);
    expect((await engine.get(viaCli))!.tInvalid).not.toBeNull();
  });

  it("gc --dry-run 不动数据；真实 gc 先归档再物理删除，归档可查", async () => {
    const dead = await putTracked(makeSemantic("Gale entry invalidated then garbage collected"));
    await engine.invalidate(dead, new Date().toISOString());

    const dry = await collectGarbage({ repo: REPO, dryRun: true });
    expect(dry.eligible).toBeGreaterThanOrEqual(1);
    expect(dry.deleted).toBe(0);
    expect(await engine.get(dead)).not.toBeNull(); // dry-run 不删

    const exportDir = await mkdtemp(join(tmpdir(), "m7-gc-"));
    try {
      const real = await collectGarbage({ repo: REPO, exportDir });
      expect(real.archivedIds).toContain(dead);
      expect(real.exportPath).not.toBeNull();
      expect(await engine.get(dead)).toBeNull(); // 物理删除

      const archived = await queryArchive(dead);
      expect(archived).not.toBeNull();
      expect(archived!.id).toBe(dead);

      const jsonl = await readFile(real.exportPath!, "utf-8");
      expect(jsonl).toContain(dead);
    } finally {
      await rm(exportDir, { recursive: true, force: true });
    }
  });

  it("容量管理：805 条 episodic 软失效至 500，效用最低者优先", async () => {
    const sql = getSql();
    // 批量造数：freq=10，utility=g%10 → utility/freq 0.0–0.9
    await sql`
      INSERT INTO memory_items (
        id, schema_version, type, subject_key, subject_key_version,
        title, summary, status, scope, confidence, payload,
        version, created_at, updated_at, t_valid, freq, utility
      )
      SELECT ${"m7cap-"} || g, 2, 'episodic', ${"m7cap-"} || g, 1,
             'cap probe ' || g, 's', 'active',
             ${sql.json({ repositoryId: REPO } as any)}, 0.5,
             ${sql.json({ source: "agent_verified" } as any)},
             1, now(), now(), now(), 10, g % 10
      FROM generate_series(1, 805) g
    `;
    createdIds.push("m7cap-1", "m7cap-809"); // 占位，实际按 repo 清理

    const report = await runLifecycleOnce({ config: { repo: REPO } });
    expect(report.capacity.episodicInvalidated).toHaveLength(305);

    const [cnt] = await sql`
      SELECT count(*)::int AS n FROM memory_items
      WHERE scope->>'repositoryId' = ${REPO} AND type = 'episodic' AND t_invalid IS NULL
    `;
    expect((cnt as { n: number }).n).toBe(500);

    // 效用为 0（ratio 0）的先删；utility=9（ratio 0.9）的全保留
    const [low] = await sql`SELECT t_invalid FROM memory_items WHERE id = 'm7cap-10'`; // g=10 → utility 0
    expect((low as { t_invalid: unknown }).t_invalid).not.toBeNull();
    const [high] = await sql`SELECT t_invalid FROM memory_items WHERE id = 'm7cap-9'`; // g=9 → utility 9
    expect((high as { t_invalid: unknown }).t_invalid).toBeNull();
  });

  it("trial 容量：超 50 FIFO 丢弃 + attemptsLeft 耗尽物理删", async () => {
    const sql = getSql();
    await sql`
      INSERT INTO memory_trial_lessons (id, lesson, origin_task_id, created, attempts_left)
      SELECT ${RUN + "_trial_"} || g, 'lesson ' || g, ${RUN + "_origin"}, now() + (g || ' seconds')::interval, 3
      FROM generate_series(1, 55) g
    `;
    await sql`
      INSERT INTO memory_trial_lessons (id, lesson, origin_task_id, attempts_left)
      VALUES (${RUN + "_exhausted"}, 'spent lesson', ${RUN + "_origin"}, 0)
    `;

    const report = await runLifecycleOnce({ config: { repo: REPO } });
    expect(report.capacity.trialDropped.length).toBe(5 + 1); // 5 个 FIFO + 1 个耗尽

    const [cnt] = await sql`SELECT count(*)::int AS n FROM memory_trial_lessons WHERE origin_task_id = ${RUN + "_origin"}`;
    expect((cnt as { n: number }).n).toBe(50);
  });

  it("全自动模式：200 条复核记录且误删率 <5% → 候选直接软失效", async () => {
    const sql = getSql();
    // 200 条历史复核：199 approved + 1 rejected（0.5%）
    await sql`
      INSERT INTO memory_lifecycle_review (id, entry_id, reason, status, created_at, resolved_at)
      SELECT 'm7fake-' || g, 'm7fake-entry-' || g, 'seed', CASE WHEN g = 1 THEN 'rejected' ELSE 'approved' END, now(), now()
      FROM generate_series(1, 200) g
    `;

    const target = await putTracked(makeSemantic("Hail entry auto purged after gray period"));
    for (let i = 0; i < 8; i++) await recordRetrievalHits(engine, [target], { runId: `${RUN}_a_${i}` });

    const report = await runLifecycleOnce({ config: { repo: REPO }, emit });
    expect(report.autoMode).toBe(true);
    expect(report.autoInvalidated).toContain(target);
    expect((await engine.get(target))!.tInvalid).not.toBeNull();

    // 人工 reject 过的条目在全自动模式下也不删（复核结论优先）
    expect(rejectedEntryId).not.toBe("");
    expect(report.autoInvalidated).not.toContain(rejectedEntryId);
    expect((await engine.get(rejectedEntryId))!.tInvalid).toBeNull();
  });
});
