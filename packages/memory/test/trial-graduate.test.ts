/**
 * 试用转正（spec §4.2 / §12.3）：失败 → trial 池 → 随行注入 → 任务验证成功 → episodic(source=trial_graduated)
 *
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/trial-graduate.test.ts
 */

import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { TriggeredRetriever } from "../src/longterm/retrieval/triggered.js";
import { queryOpLog } from "../src/longterm/observability/op-log.js";
import { MemoryDistiller } from "../src/longterm/write/distiller.js";
import {
  addTrialLesson,
  getTrialLesson,
  graduateTrialLesson,
  listTrialLessons,
} from "../src/longterm/write/trial.js";
import { MemoryWritePipeline } from "../src/longterm/write/pipeline.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import type { EpisodicExperience, SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

const RUN = `tg_${Date.now().toString(36)}`;
const REPO = `repo-${RUN}`;
const engine = new PostgresMemoryStoreEngine();
const createdIds: string[] = [];

function makeSemantic(fact: string): SemanticFact {
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
    keywords: fact.split(/\s+/).filter((w) => w.length > 4).slice(0, 4),
    embeddingKey: fact,
  };
}

beforeAll(async () => {
  if (!dbOk) return;
  const sql = getSql();
  await sql`
    DELETE FROM outbox_events
    WHERE aggregate_type = 'memory-write-queue'
      AND status = 'pending'
      AND created_at < now() - interval '5 minutes'
  `.catch(() => undefined);
});

afterAll(async () => {
  if (!dbOk) return;
  const sql = getSql();
  for (const id of createdIds) {
    await sql`DELETE FROM memory_items WHERE id = ${id}`;
  }
  await sql`DELETE FROM memory_trial_lessons WHERE origin_task_id LIKE ${RUN + "%"}`;
  await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
  await closeSql().catch(() => undefined);
});

describe("graduateTrialLesson（纯转正）", () => {
  it("转正 → episodic(source=trial_graduated) + 删除 trial 行 + op-log", async () => {
    const trial = await addTrialLesson(
      "我不该跳过预检直接改配置，应该先跑 smoke。",
      `${RUN}_origin`,
      {
        whenToUse: "When BerylConfigError appears after skipping prechecks",
        keywords: ["BerylConfigError", "precheck"],
        distilled: true,
      },
    );
    expect(await getTrialLesson(trial.id)).not.toBeNull();

    const result = await graduateTrialLesson(trial.id, {
      engine,
      repo: REPO,
      graduatingRunId: `${RUN}_grad`,
    });
    expect(result).not.toBeNull();
    createdIds.push(result!.memoryId);

    const entry = await engine.get(result!.memoryId);
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe("episodic");
    if (entry!.kind !== "episodic") return;
    expect(entry!.source).toBe("trial_graduated");
    expect(entry!.confidence).toBe(0.75);
    expect(entry!.utility).toBe(1);
    expect(entry!.whenToUse).toContain("BerylConfigError");
    expect(entry!.perspective).toContain("预检");
    expect(entry!.evidence.some((e) => e.includes(trial.id))).toBe(true);

    expect(await getTrialLesson(trial.id)).toBeNull();
    const logs = await queryOpLog({ runId: `${RUN}_grad`, op: "write.graduated" });
    expect(logs.length).toBe(1);
    expect(logs[0]!.entryIds).toContain(result!.memoryId);
    expect(logs[0]!.detail.trialId).toBe(trial.id);
  });

  it("trial 已不存在 → 幂等返回 null", async () => {
    const r = await graduateTrialLesson("trial-does-not-exist", {
      engine,
      repo: REPO,
      graduatingRunId: `${RUN}_missing`,
    });
    expect(r).toBeNull();
  });
});

describe("闭环：失败试用 → 注入 → 验证成功转正", () => {
  it("失败入 trial → T2 随行 → 测试通过 → 正式库有 trial_graduated，trial 池清空", async () => {
    const originRun = `${RUN}_fail`;
    const successRun = `${RUN}_ok`;

    const pipeline = new MemoryWritePipeline({
      engine,
      distiller: new MemoryDistiller({
        complete: async (prompt) => {
          if (prompt.includes("失败复盘") || prompt.includes("试用教训")) {
            return JSON.stringify({
              lesson: "我不该在没有锁定依赖版本时升级核心包。",
              whenToUse: "When JadePeerDependencyError appears after a core package upgrade",
              keywords: ["JadePeerDependencyError", "peer", "upgrade"],
            });
          }
          // 固化通道蒸馏：空候选，转正不依赖 consolidate 产物
          return JSON.stringify({ candidates: [] });
        },
      }),
      dailyBudget: 500,
    });

    const failed = await pipeline.processEvent({
      type: "task_failed",
      runId: originRun,
      trajectoryRef: `runs/${originRun}`,
      repo: REPO,
      goal: "upgrade core package",
      trajectory: "JadePeerDependencyError: unmet peer after bumping core",
    });
    expect(failed.status).toBe("trialed");
    const trials = await listTrialLessons(originRun);
    expect(trials).toHaveLength(1);
    const trialId = trials[0]!.id;

    const filler = makeSemantic(
      "JadePeerDependencyError handling requires pinning peer versions before upgrades",
    );
    await engine.put(filler);
    createdIds.push(deriveEntryId(filler));

    const retriever = new TriggeredRetriever({
      engine,
      countTokens: (t) => Math.ceil(t.length / 4),
    });
    const pkg = await retriever.retrieve({
      type: "action_failed",
      errorOutput: "JadePeerDependencyError: unmet peer dependency\n    at install (pkg.ts:12:3)",
      lastActionSummary: "bun install (exit 1)",
      repo: REPO,
      runId: successRun,
    });
    expect(pkg.items.some((i) => i.kind === "trial" && i.id === trialId)).toBe(true);
    const trialLogs = await queryOpLog({ runId: successRun, op: "read.inject.trial" });
    expect(trialLogs[0]!.entryIds).toContain(trialId);

    const ok = await pipeline.processEvent({
      type: "task_succeeded",
      runId: successRun,
      trajectoryRef: `runs/${successRun}`,
      repo: REPO,
      goal: "upgrade core package with peers pinned",
      trajectory: "pinned peers then upgrade succeeded, all tests passed",
      verdict: { kind: "test", passed: true },
    });
    expect(["written", "noop", "degraded"].includes(ok.status)).toBe(true);

    expect(await getTrialLesson(trialId)).toBeNull();
    expect(await listTrialLessons(originRun)).toHaveLength(0);

    const graduatedLogs = await queryOpLog({ runId: successRun, op: "write.graduated" });
    expect(graduatedLogs.length).toBe(1);
    const memoryId = graduatedLogs[0]!.entryIds[0]!;
    createdIds.push(memoryId);

    const entry = (await engine.get(memoryId)) as EpisodicExperience | null;
    expect(entry).not.toBeNull();
    expect(entry!.kind).toBe("episodic");
    expect(entry!.source).toBe("trial_graduated");
    expect(entry!.whenToUse).toContain("JadePeerDependencyError");

    const recall = await retriever.retrieve({
      type: "action_failed",
      errorOutput: "JadePeerDependencyError: unmet peer\n    at install",
      lastActionSummary: "bun install (exit 1)",
      repo: REPO,
      runId: `${RUN}_recall`,
    });
    const hit = recall.items.find((i) => i.id === memoryId);
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("episodic");
    expect(hit!.status).not.toBe("trial");
  });

  it("注入过 trial 但任务再次失败 → 不转正，仍留在 trial 池", async () => {
    const originRun = `${RUN}_fail2`;
    const againRun = `${RUN}_fail_again`;

    const trial = await addTrialLesson(
      "我不该忽略 timeout 配置。",
      originRun,
      {
        whenToUse: "When QuartzTimeoutError appears in flaky integration tests",
        keywords: ["QuartzTimeoutError"],
        distilled: true,
      },
    );

    const filler = makeSemantic(
      "QuartzTimeoutError usually means the integration test timeout is too low",
    );
    await engine.put(filler);
    createdIds.push(deriveEntryId(filler));

    const retriever = new TriggeredRetriever({
      engine,
      countTokens: (t) => Math.ceil(t.length / 4),
    });
    await retriever.retrieve({
      type: "action_failed",
      errorOutput: "QuartzTimeoutError: exceeded 5000ms\n    at wait (test.ts:4:1)",
      lastActionSummary: "bun test (exit 1)",
      repo: REPO,
      runId: againRun,
    });

    const pipeline = new MemoryWritePipeline({ engine, dailyBudget: 500 });
    const r = await pipeline.processEvent({
      type: "task_failed",
      runId: againRun,
      trajectoryRef: `runs/${againRun}`,
      repo: REPO,
      goal: "fix flaky test",
      trajectory: "still timing out",
    });
    expect(r.status).toBe("trialed");

    const still = await getTrialLesson(trial.id);
    expect(still).not.toBeNull();
    expect(still!.attemptsLeft).toBe(2);
    expect(await queryOpLog({ runId: againRun, op: "write.graduated" })).toHaveLength(0);
  });

  it("无反馈信号的成功不转正（禁止盲改）", async () => {
    const originRun = `${RUN}_blind_origin`;
    const blindRun = `${RUN}_blind`;

    const trial = await addTrialLesson("我不该盲改。", originRun, {
      whenToUse: "When TopazBlindError shows up",
      keywords: ["TopazBlindError"],
      distilled: true,
    });

    const filler = makeSemantic("TopazBlindError is a synthetic keyword for graduation gating");
    await engine.put(filler);
    createdIds.push(deriveEntryId(filler));

    const retriever = new TriggeredRetriever({
      engine,
      countTokens: (t) => Math.ceil(t.length / 4),
    });
    await retriever.retrieve({
      type: "action_failed",
      errorOutput: "TopazBlindError: synthetic\n    at x",
      lastActionSummary: "run (exit 1)",
      repo: REPO,
      runId: blindRun,
    });

    const pipeline = new MemoryWritePipeline({ engine });
    const r = await pipeline.processEvent({
      type: "task_succeeded",
      runId: blindRun,
      trajectoryRef: `runs/${blindRun}`,
      repo: REPO,
      goal: "something",
      trajectory: "agent believes success",
      verdict: { kind: "none" },
    });
    expect(r.status).toBe("rejected");
    expect(await getTrialLesson(trial.id)).not.toBeNull();
    expect(await queryOpLog({ runId: blindRun, op: "write.graduated" })).toHaveLength(0);
  });
});
