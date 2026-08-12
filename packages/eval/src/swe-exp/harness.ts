/**
 * SWE-Exp memory on/off 配对 harness（spec §11.3.1）
 *
 * 协议（最小闭环）：
 * 1. 历史经验 → seed episodic（模拟 Stage1/2 蒸馏结果）
 * 2. 同一 probe workspace 上跑 memory off / on
 * 3. 核心指标：测试是否通过（resolved）
 *
 * 模式：
 * - fake：用夹具预设结局（纯协议/报告冒烟）
 * - deterministic：on 臂若 seed 可检索则打补丁再测；off 不打补丁
 * - agent：预留（真实 AgentOrchestrator，后续接线）
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildConversationAwareQuery,
  createMemoryRuntime,
  extractCleanMemoryQuery,
} from "@paw/memory";
import { closeSql, getSql } from "@paw/memory/db";
import {
  PostgresMemoryStoreEngine,
  deriveEntryId,
  type EpisodicExperience,
} from "@paw/memory/longterm";

import {
  SWE_EXP_BUILTIN_PAIRS,
  type SweExpBuiltinPair,
} from "./fixtures.js";
import { armOutcome, buildSweExpReport } from "./report.js";
import type {
  SweExpArmResult,
  SweExpPairResult,
  SweExpReport,
} from "./types.js";

export type SweExpMode = "fake" | "deterministic" | "agent";

export interface SweExpRunOptions {
  readonly mode?: SweExpMode;
  readonly maxPairs?: number;
  readonly keep?: boolean;
  readonly pairs?: readonly SweExpBuiltinPair[];
  readonly now?: () => Date;
  /** agent 模式 */
  readonly repoRoot?: string;
  readonly suiteRunId?: string;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly modelProvider?: string;
  readonly skipHarness?: boolean;
  readonly minSimilarity?: number;
  readonly repos?: readonly string[];
}

function writeTree(
  root: string,
  files: readonly { path: string; content: string }[],
): void {
  for (const f of files) {
    const p = path.join(root, f.path);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, f.content, "utf8");
  }
}

function setupWorkspace(
  pair: SweExpBuiltinPair,
  memoryOn: boolean,
  repositoryId: string,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "paw-swe-exp-"));
  writeTree(dir, pair.workspaceFiles);
  mkdirSync(path.join(dir, ".paw"), { recursive: true });
  writeFileSync(
    path.join(dir, ".paw", "settings.local.json"),
    JSON.stringify({
      memory_backend: "db",
      repository_id: repositoryId,
      user_id: "swe-exp",
    }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, ".paw", "memory-config.json"),
    `${JSON.stringify({ enable: memoryOn, readonly: false, shadow: false }, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

function runNodeTest(workspace: string, script: string): boolean {
  const r = spawnSync(process.execPath, [path.join(workspace, script)], {
    cwd: workspace,
    encoding: "utf8",
  });
  return r.status === 0;
}

function retrievalQuery(goal: string): string {
  return (
    buildConversationAwareQuery(goal) || extractCleanMemoryQuery(goal) || goal
  );
}

/** 对齐 M10：saveMemory + episodic 直写（T1 只注入 episodic/profile） */
async function seedAndCheckRecall(
  workspaceRoot: string,
  pair: SweExpBuiltinPair,
): Promise<{ seedId: string; recalled: boolean }> {
  const runtime = await createMemoryRuntime({ workspaceRoot });
  const ok = await runtime.ping();
  if (!ok) throw new Error("memory runtime ping failed (need DATABASE_URL)");

  await runtime.saveMemory({
    title: pair.lesson.title,
    summary: pair.lesson.summary,
    content: pair.lesson.modification,
    type: "lesson",
  });

  const nowIso = new Date().toISOString();
  const seedEntry: EpisodicExperience = {
    id: "",
    kind: "episodic",
    repo: runtime.scope.repositoryId,
    created: nowIso,
    tValid: nowIso,
    tInvalid: null,
    source: "user_statement",
    confidence: 1.0,
    evidence: [`history:${pair.historyId}`],
    freq: 0,
    utility: 0,
    // whenToUse 回显 goal，保证 BM25 / keyword 与 probe 重叠
    whenToUse: `${pair.goal}. ${pair.lesson.whenToUse}`,
    perspective: pair.lesson.perspective,
    modification: [pair.lesson.modification],
    issueType: "swe-exp-history",
    taskId: pair.historyId,
  };
  await new PostgresMemoryStoreEngine().put(seedEntry);
  const seedId = deriveEntryId(seedEntry);

  const begun = await runtime.beginTask({
    runId: `swe-exp-preflight-${Date.now().toString(36)}`,
    goal: pair.goal,
    title: pair.goal.slice(0, 120),
  });
  const section = await runtime.buildContextSection({
    taskId: begun.taskId,
    query: retrievalQuery(pair.goal),
    tokenBudget: 1500,
    currentUserRequest: pair.goal,
    limit: 8,
  });
  const recalled = section.items.some((i) => i.id === seedId);
  // orchestrator 风格：不在此 shutdown（共享 pool）；由外层 closeSql
  return { seedId, recalled };
}

async function cleanupRepo(repositoryId: string): Promise<void> {
  const sql = getSql();
  await sql`
    DELETE FROM governance_decisions
    WHERE candidate_id IN (
      SELECT id FROM memory_candidates WHERE proposed_scope->>'repositoryId' = ${repositoryId}
    )
    OR resulting_memory_id IN (
      SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${repositoryId}
    )
    OR target_memory_id IN (
      SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${repositoryId}
    )
  `.catch(() => undefined);
  await sql`DELETE FROM memory_candidates WHERE proposed_scope->>'repositoryId' = ${repositoryId}`.catch(
    () => undefined,
  );
  await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${repositoryId}`.catch(
    () => undefined,
  );
  await sql`DELETE FROM task_sessions WHERE repository_id = ${repositoryId}`.catch(
    () => undefined,
  );
}

async function runDeterministicArm(
  pair: SweExpBuiltinPair,
  memoryOn: boolean,
  repositoryId: string,
  keep: boolean,
): Promise<SweExpArmResult> {
  const t0 = Date.now();
  const warnings: string[] = [];
  const dir = setupWorkspace(pair, memoryOn, repositoryId);
  try {
    let recalled = false;
    if (memoryOn) {
      const r = await seedAndCheckRecall(dir, pair);
      recalled = r.recalled;
      if (!recalled) warnings.push("seed_not_recalled");
      else writeTree(dir, pair.fixFiles);
    }
    const resolved = runNodeTest(dir, pair.testScript);
    return {
      memoryOn,
      resolved,
      recalled: memoryOn ? recalled : false,
      durationMs: Date.now() - t0,
      warnings,
    };
  } finally {
    if (!keep) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      try {
        await cleanupRepo(repositoryId);
      } catch {
        /* ignore */
      }
    }
  }
}

function runFakeArm(
  pair: SweExpBuiltinPair,
  memoryOn: boolean,
): SweExpArmResult {
  return {
    memoryOn,
    resolved: memoryOn ? pair.fakeOnResolved : pair.fakeOffResolved,
    recalled: memoryOn,
    durationMs: 0,
    warnings: [],
  };
}

export async function runSweExpBuiltin(
  opts: SweExpRunOptions = {},
): Promise<SweExpReport> {
  const mode = opts.mode ?? "deterministic";
  const now = opts.now ?? (() => new Date());
  const ts = now().getTime().toString(36);
  const pairs = (opts.pairs ?? SWE_EXP_BUILTIN_PAIRS).slice(
    0,
    opts.maxPairs ?? SWE_EXP_BUILTIN_PAIRS.length,
  );
  const warnings: string[] = [];
  const details: SweExpPairResult[] = [];

  if (mode === "agent") {
    const { runSweExpAgent } = await import("./agent-harness.js");
    return runSweExpAgent({
      repoRoot: opts.repoRoot ?? process.cwd(),
      suiteRunId: opts.suiteRunId,
      maxPairs: opts.maxPairs,
      maxSteps: opts.maxSteps,
      timeoutMs: opts.timeoutMs,
      keep: opts.keep,
      modelProvider: opts.modelProvider,
      skipHarness: opts.skipHarness,
      minSimilarity: opts.minSimilarity,
      repos: opts.repos,
      now: opts.now,
    });
  }

  try {
    for (const pair of pairs) {
      // off / on 分 scope，避免 off 臂看到 on 的 seed
      const repoOff = `swe-exp-${pair.id}-off-${ts}`;
      const repoOn = `swe-exp-${pair.id}-on-${ts}`;
      let off: SweExpArmResult;
      let on: SweExpArmResult;
      if (mode === "fake") {
        off = runFakeArm(pair, false);
        on = runFakeArm(pair, true);
      } else {
        off = await runDeterministicArm(
          pair,
          false,
          repoOff,
          opts.keep === true,
        );
        on = await runDeterministicArm(pair, true, repoOn, opts.keep === true);
      }
      details.push({
        pairId: pair.id,
        repo: pair.repo,
        historyId: pair.historyId,
        probeId: pair.probeId,
        off,
        on,
        outcome: armOutcome(off, on),
      });
    }
  } finally {
    if (mode === "deterministic") {
      try {
        await closeSql();
      } catch {
        /* ignore */
      }
    }
  }

  return buildSweExpReport({
    mode,
    details,
    warnings,
    generatedAt: now().toISOString(),
  });
}

/** 从外部官方 harness 评估结果合并为配对报告 */
export function mergeExternalResolveResults(
  rows: readonly {
    pairId: string;
    repo: string;
    historyId: string;
    probeId: string;
    offResolved: boolean;
    onResolved: boolean;
  }[],
): SweExpReport {
  const details: SweExpPairResult[] = rows.map((r) => {
    const off: SweExpArmResult = { memoryOn: false, resolved: r.offResolved };
    const on: SweExpArmResult = { memoryOn: true, resolved: r.onResolved };
    return {
      pairId: r.pairId,
      repo: r.repo,
      historyId: r.historyId,
      probeId: r.probeId,
      off,
      on,
      outcome: armOutcome(off, on),
    };
  });
  return buildSweExpReport({ mode: "external", details });
}
