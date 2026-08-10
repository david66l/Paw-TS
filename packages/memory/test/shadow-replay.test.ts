/**
 * shadow 模式 + 轨迹回放评测测试（spec v2 §11，M8）
 *
 * 纯函数部分（JSONL 解析/judge 校验/报告渲染）不需要 DB；
 * db 部分需要 PostgreSQL，judge 全 mock，ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/shadow-replay.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { RunEvent } from "@paw/core";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import { queryOpLog } from "../src/longterm/observability/op-log.js";
import { TriggeredRetriever } from "../src/longterm/retrieval/triggered.js";
import {
  parseReplayJsonl,
  buildJudgePrompt,
  parseJudgeOutput,
  runReplay,
  renderReplayReport,
  type JudgeLlm,
} from "../src/longterm/eval/replay.js";
import type { EpisodicExperience, SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

// ═══════════════════════════════════════════════════════════════
// 纯函数（不需要 DB）
// ═══════════════════════════════════════════════════════════════

describe("parseReplayJsonl / parseJudgeOutput", () => {
  test("JSONL 解析 + 坏行报行号", () => {
    const good = '{"taskId":"t1","description":"d"}\n\n{"taskId":"t2","description":"e","events":[]}';
    expect(parseReplayJsonl(good)).toHaveLength(2);
    expect(() => parseReplayJsonl('{"taskId":"t1","description":"d"}\nnot-json')).toThrow("第 2 行");
    expect(() => parseReplayJsonl('{"description":"缺 taskId"}')).toThrow("第 1 行");
  });

  test("judge 输出校验", () => {
    expect(parseJudgeOutput('{"verdict":"helpful","reason":"直击根因"}')).toEqual({ verdict: "helpful", reason: "直击根因" });
    expect(parseJudgeOutput('{"verdict":"maybe"}')).toBeNull();
    expect(parseJudgeOutput("不是 JSON")).toBeNull();
  });

  test("judge prompt 含三档定义与轨迹信息", () => {
    const p = buildJudgePrompt(
      { taskId: "t", description: "deploy fix", events: [{ type: "action_failed", errorOutput: "DeployError: x" }], outcome: "failed" },
      "经验正文",
    );
    expect(p).toContain("helpful");
    expect(p).toContain("harmful");
    expect(p).toContain("DeployError");
    expect(p).toContain("经验正文");
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成
// ═══════════════════════════════════════════════════════════════

const RUN = `run_m8_${Date.now().toString(36)}`;
const REPO = `m8-shadow-${Date.now().toString(36)}`;
const createdIds: string[] = [];
const FIXTURE = fileURLToPath(new URL("./fixtures/replay-sample.jsonl", import.meta.url));

function makeEpisodic(whenToUse: string, perspective: string): EpisodicExperience {
  const now = new Date().toISOString();
  return {
    id: "", kind: "episodic", repo: REPO, created: now, tValid: now, tInvalid: null,
    source: "agent_verified", confidence: 0.9, evidence: [], freq: 0, utility: 0,
    whenToUse, perspective, modification: ["Check rotation windows first"],
    issueType: "DeployError", taskId: "tsk_m8",
  };
}

function makeSemantic(fact: string): SemanticFact {
  const now = new Date().toISOString();
  return {
    id: "", kind: "semantic", repo: REPO, created: now, tValid: now, tInvalid: null,
    source: "agent_verified", confidence: 0.9, evidence: [], freq: 0, utility: 0,
    fact, keywords: [], embeddingKey: fact,
  };
}

describe("shadow 模式 + 轨迹回放 db 集成", () => {
  const engine = new PostgresMemoryStoreEngine();

  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
      }
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${REPO}`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE 'replay-%'`;
    }
    await closeSql();
  });

  it("shadow：假设注入包完整记录但不注入（freq 不涨、无 read.inject、无 memory.inject 事件）", async () => {
    const e = makeEpisodic("When zephyr deploys fail with token mismatch", "Zephyr token mismatches come from stale rotation windows");
    await engine.put(e);
    const id = deriveEntryId(e);
    createdIds.push(id);

    const emitted: RunEvent[] = [];
    const shadow = new TriggeredRetriever({
      engine, shadow: true,
      countTokens: (t) => Math.ceil(t.length / 4),
      emit: (ev) => emitted.push(ev),
    });
    const runId = `${RUN}_shadow`;
    const pkg = await shadow.retrieve({
      type: "task_start",
      taskDescription: "zephyr deploys fail with token mismatch",
      repo: REPO,
      runId,
    });

    // 假设注入包正常产出
    expect(pkg.items).toHaveLength(1);
    expect(pkg.items[0]!.id).toBe(id);

    // 不注入的三条证据
    expect((await engine.ledger(id))!.freq).toBe(0);                    // freq 不涨
    expect(await queryOpLog({ runId, op: "read.inject" })).toHaveLength(0); // 无真实 inject
    expect(emitted.some((ev) => ev.type === "memory.inject")).toBe(false); // 无 inject 事件

    // read.shadow 含完整假设包（含渲染文本）
    const shadows = await queryOpLog({ runId, op: "read.shadow" });
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.detail.itemIds).toEqual([id]);
    expect(String(shadows[0]!.detail.rendered)).toContain("<agent-memory");
    expect(typeof shadows[0]!.detail.totalTokens).toBe("number");

    // 对照：非 shadow 同查询 freq+1 且有 read.inject
    const real = new TriggeredRetriever({ engine, countTokens: (t) => Math.ceil(t.length / 4) });
    const pkg2 = await real.retrieve({
      type: "task_start",
      taskDescription: "zephyr deploys fail with token mismatch",
      repo: REPO,
      runId: `${RUN}_real`,
    });
    expect(pkg2.items).toHaveLength(1);
    expect((await engine.ledger(id))!.freq).toBe(1);
    expect(await queryOpLog({ runId: `${RUN}_real`, op: "read.inject" })).toHaveLength(1);
  });

  it("轨迹回放：3 条样例轨迹 + mock judge → Δ 报告（helpful/neutral/harmful 各一）", async () => {
    // 库中埋一条与 t1 失败相关的经验、一条会误导的（harmful 判定由 mock judge 按内容给）
    const helpfulEntry = makeEpisodic(
      "When zephyr deployment fails with token mismatch after rotation",
      "Zephyr deployment token mismatches usually come from stale rotation windows",
    );
    await engine.put(helpfulEntry);
    createdIds.push(deriveEntryId(helpfulEntry));
    const harmfulEntry = makeSemantic("Always rotate zephyr tokens during deployment windows");
    await engine.put(harmfulEntry);
    createdIds.push(deriveEntryId(harmfulEntry));

    // mock judge：按注入文本内容分档
    const judge: JudgeLlm = {
      complete: async (prompt) => {
        if (prompt.includes("stale rotation windows")) return JSON.stringify({ verdict: "helpful", reason: "直击根因" });
        if (prompt.includes("rotate zephyr tokens during deployment")) return JSON.stringify({ verdict: "harmful", reason: "会误导在错误窗口轮换" });
        return JSON.stringify({ verdict: "neutral", reason: "无关" });
      },
    };

    const trajectories = parseReplayJsonl(await readFile(FIXTURE, "utf-8"));
    expect(trajectories).toHaveLength(3);

    const report = await runReplay(trajectories, {
      engine,
      judge,
      repo: REPO,
      retrieverOptions: { countTokens: (t) => Math.ceil(t.length / 4) },
    });

    expect(report.trajectories).toBe(3);
    expect(report.trajectoriesWithHits).toBeGreaterThanOrEqual(1);
    // mock judge 至少给出 helpful 与 harmful 各一（t1/t3 任务描述含 zephyr 相关词）
    expect(report.judgments.helpful).toBeGreaterThanOrEqual(1);
    expect(report.judgments.harmful).toBeGreaterThanOrEqual(1);
    expect(report.harmfulRate).not.toBeNull();
    expect(report.harmfulRate!).toBeGreaterThan(0);
    // 样本量提示
    expect(report.sampleWarning).toContain("n=3");
    // 表格渲染
    const table = renderReplayReport(report);
    expect(table).toContain("轨迹回放 Δ 代理报告");
    expect(table).toContain("harmful 占比");
    expect(table).toContain("sample-t1");

    // shadow 回放不涨 freq
    expect((await engine.ledger(deriveEntryId(helpfulEntry)))!.freq).toBe(0);
  });

  it("无 judge 时判定记 unjudged；CLI replay 走通", async () => {
    const { runMemoryCommand } = await import("../src/longterm/cli.js");
    const r = await runMemoryCommand(["replay", FIXTURE, "--repo", REPO]);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("轨迹回放 Δ 代理报告");
    expect(r.text).toContain("unjudged");

    const rj = await runMemoryCommand(["replay", FIXTURE, "--repo", REPO, "--json"]);
    expect(rj.ok).toBe(true);
    const parsed = JSON.parse(rj.text) as { trajectories: number };
    expect(parsed.trajectories).toBe(3);
  });
});
