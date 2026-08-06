/**
 * M3 可观测性测试（spec v2 §10 / §9.2）
 *
 * 纯函数部分（parseMemoryArgs / renderMemoryStats / renderMemoryDiff）不需要 DB；
 * db 部分需要 PostgreSQL（含 V028），ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/observability.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import { appendOpLog, queryOpLog } from "../src/longterm/observability/op-log.js";
import {
  recordRetrievalHits,
  recordTaskSuccess,
  recordAdoption,
} from "../src/longterm/observability/ledger.js";
import {
  collectMemoryStats,
  renderMemoryStats,
  UNVERIFIED_WARN_RATIO,
  type MemoryStats,
} from "../src/longterm/observability/stats.js";
import {
  collectMemoryDiff,
  renderMemoryDiff,
} from "../src/longterm/observability/diff.js";
import { collectWhy, renderWhy } from "../src/longterm/observability/why.js";
import { parseMemoryArgs, runMemoryCommand } from "../src/longterm/cli.js";
import type { SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

// ═══════════════════════════════════════════════════════════════
// 纯函数：CLI 参数解析（不需要 DB）
// ═══════════════════════════════════════════════════════════════

describe("parseMemoryArgs", () => {
  test("list 默认值", () => {
    expect(parseMemoryArgs(["list"])).toEqual({ subcommand: "list" });
  });

  test("list --kind/--all/--repo/--limit", () => {
    expect(parseMemoryArgs(["list", "--kind", "episodic", "--all", "--repo", "r1", "--limit", "5"]))
      .toEqual({ subcommand: "list", kind: "episodic", all: true, repo: "r1", limit: 5 });
  });

  test("非法 kind 报错", () => {
    const r = parseMemoryArgs(["list", "--kind", "bogus"]);
    expect("error" in r && r.error).toContain("--kind");
  });

  test("why/forget 缺 id 报错", () => {
    expect("error" in parseMemoryArgs(["why"])).toBe(true);
    expect("error" in parseMemoryArgs(["forget"])).toBe(true);
    expect(parseMemoryArgs(["why", "semantic-abc"])).toEqual({ subcommand: "why", id: "semantic-abc" });
  });

  test("diff --since 校验时间格式", () => {
    expect("error" in parseMemoryArgs(["diff", "--since", "不是时间"])).toBe(true);
    expect(parseMemoryArgs(["diff", "--since", "2026-08-01T00:00:00Z"]))
      .toEqual({ subcommand: "diff", since: "2026-08-01T00:00:00Z" });
  });

  test("未知子命令/参数报错", () => {
    expect("error" in parseMemoryArgs(["frobnicate"])).toBe(true);
    expect("error" in parseMemoryArgs(["list", "--bogus"])).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// 纯函数：stats 渲染与告警阈值（spec §10.4-3）
// ═══════════════════════════════════════════════════════════════

function makeStats(overrides: Partial<MemoryStats>): MemoryStats {
  return {
    active: 100,
    invalidated: 0,
    byKind: { semantic: 100 },
    unverified: 0,
    unverifiedRatio: 0,
    deleteCandidates: 0,
    writeOpsThisMonth: 0,
    adoptionRate30d: null,
    injected30d: 0,
    adopted30d: 0,
    ...overrides,
  };
}

describe("renderMemoryStats 告警", () => {
  test("unverified 占比 >10% 输出告警", () => {
    const text = renderMemoryStats(makeStats({ unverified: 11, unverifiedRatio: 0.11 }));
    expect(text).toContain("告警");
    expect(text).toContain("11.0%");
  });

  test("占比恰为阈值不告警", () => {
    const text = renderMemoryStats(makeStats({ unverified: 10, unverifiedRatio: UNVERIFIED_WARN_RATIO }));
    expect(text).not.toContain("告警");
  });

  test("无注入数据时采纳率显示占位", () => {
    const text = renderMemoryStats(makeStats({}));
    expect(text).toContain("暂无注入数据");
  });

  test("有数据时采纳率按 adopted/injected 展示", () => {
    const text = renderMemoryStats(makeStats({ adoptionRate30d: 0.5, injected30d: 8, adopted30d: 4 }));
    expect(text).toContain("50.0%");
    expect(text).toContain("4/8");
  });
});

describe("renderMemoryDiff", () => {
  test("聚合格式", () => {
    const text = renderMemoryDiff({
      since: "2026-08-01T00:00:00Z",
      until: "2026-08-02T00:00:00Z",
      opCounts: { "read.inject": 3, governed: 1 },
      added: [{ id: "semantic-x", kind: "semantic", title: "t", tValid: "2026-08-01T01:00:00Z" }],
      invalidated: [],
      purgedIds: [],
    });
    expect(text).toContain("新增: 1");
    expect(text).toContain("read.inject×3");
    expect(text).toContain("+ [semantic] semantic-x");
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成（需要 V028）
// ═══════════════════════════════════════════════════════════════

describe("可观测性 db 集成", () => {
  const engine = new PostgresMemoryStoreEngine();
  const REPO = "m3-observability-test-repo";
  const RUN = `run_m3_${Date.now().toString(36)}`;
  const createdIds: string[] = [];

  function makeFact(fact: string): SemanticFact {
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
      evidence: ["runs/run-x/trajectory#step-1"],
      freq: 0,
      utility: 0,
      fact,
      keywords: ["m3test"],
      embeddingKey: fact,
    };
  }

  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
        await sql`DELETE FROM memory_op_log WHERE entry_ids @> ARRAY[${id}]::text[]`;
      }
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
    }
    await closeSql();
  });

  it("op-log 追加与按 runId/条目/时间查询", async () => {
    const entryId = "semantic-oplog-probe";
    const ok = await appendOpLog("read.inject", {
      runId: RUN,
      entryIds: [entryId],
      detail: { trigger: "task_start", totalTokens: 123 },
    });
    expect(ok).toBe(true);

    const byRun = await queryOpLog({ runId: RUN });
    expect(byRun.length).toBe(1);
    expect(byRun[0]!.op).toBe("read.inject");
    expect(byRun[0]!.entryIds).toEqual([entryId]);
    expect(byRun[0]!.detail.totalTokens).toBe(123);

    const byEntry = await queryOpLog({ entryId });
    expect(byEntry.some((o) => o.runId === RUN)).toBe(true);

    const future = await queryOpLog({ runId: RUN, since: new Date(Date.now() + 3600_000).toISOString() });
    expect(future.length).toBe(0);
  });

  it("ledger 批量记账：注入→freq、任务成功→utility、采纳→op-log", async () => {
    const fact = makeFact("Ledger batch accounting records freq utility adoption");
    const id = deriveEntryId(fact);
    createdIds.push(id);
    await engine.put(fact);

    await recordRetrievalHits(engine, [id], { runId: RUN });
    await recordRetrievalHits(engine, [id], { runId: RUN });
    await recordTaskSuccess(engine, [id]);
    expect(await engine.ledger(id)).toEqual({ freq: 2, utility: 1 });

    await recordAdoption(RUN, [id]);
    const adopted = await queryOpLog({ runId: RUN, op: "read.adopted" });
    expect(adopted.length).toBe(1);
    expect(adopted[0]!.entryIds).toContain(id);
  });

  it("stats 反映库规模与采纳率", async () => {
    const stats = await collectMemoryStats();
    expect(stats.active).toBeGreaterThanOrEqual(1);
    // 上一个用例记了 2 次 read.inject（各 1 条目）+ 1 次 read.adopted
    expect(stats.injected30d).toBeGreaterThanOrEqual(2);
    expect(stats.adopted30d).toBeGreaterThanOrEqual(1);
    expect(stats.adoptionRate30d).not.toBeNull();
    expect(stats.adoptionRate30d!).toBeGreaterThan(0);
    expect(stats.adoptionRate30d!).toBeLessThanOrEqual(1);
  });

  it("forget 软失效 + why 溯源 + diff 聚合", async () => {
    const fact = makeFact("Forget invalidates and why traces provenance");
    const id = deriveEntryId(fact);
    createdIds.push(id);
    await engine.put(fact);

    // forget：软失效 + governed op-log
    const forgot = await runMemoryCommand(["forget", id]);
    expect(forgot.ok).toBe(true);
    const after = await engine.get(id);
    expect(after!.tInvalid).not.toBeNull();

    // list 默认不含已失效，--all 含
    const listActive = await runMemoryCommand(["list", "--repo", REPO]);
    expect(listActive.text).not.toContain(id);
    const listAll = await runMemoryCommand(["list", "--repo", REPO, "--all"]);
    expect(listAll.text).toContain(id);
    expect(listAll.text).toContain("[已失效]");

    // why：条目信息 + governed 操作记录
    const why = await collectWhy(engine, id);
    expect(why.entry!.id).toBe(id);
    expect(why.opCounts.governed).toBeGreaterThanOrEqual(1);
    const whyText = renderWhy(why);
    expect(whyText).toContain(id);
    expect(whyText).toContain("freq=0");

    // diff：窗口内应看到这条新增 + 失效
    const diff = await collectMemoryDiff(new Date(Date.now() - 3600_000).toISOString());
    expect(diff.added.map((e) => e.id)).toContain(id);
    expect(diff.invalidated.map((e) => e.id)).toContain(id);
    expect(diff.opCounts.governed).toBeGreaterThanOrEqual(1);
    expect(renderMemoryDiff(diff)).toContain("失效");
  });

  it("runMemoryCommand stats/why 输出可用", async () => {
    const stats = await runMemoryCommand(["stats"]);
    expect(stats.ok).toBe(true);
    expect(stats.text).toContain("记忆库统计");

    const missing = await runMemoryCommand(["why", "semantic-does-not-exist"]);
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("不存在");
  });
});
