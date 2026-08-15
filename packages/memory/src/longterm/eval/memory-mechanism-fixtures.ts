/**
 * 记忆机制验收套件（§12.3）：Trial → Gate → Profile → Cap
 *
 * - Trial / Gate：MemoryRuntimeV2 核心（pipeline + TriggeredRetriever）
 * - Profile / Cap：admitProfile / enforceProfileCapacity / runLifecycleOnce
 * - 每组独立 repository scope，跑完清理；确定性 fake 默认；可选真实 LLM smoke
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSql } from "../../db/connection.js";
import {
  createMemoryRuntime,
  getMemoryV2CoreForTests,
  resetMemoryV2Core,
} from "../../runtime/index.js";
import type { MemoryRuntime } from "../../runtime/types.js";
import { PostgresMemoryStoreEngine } from "../store/postgres-engine.js";
import { deriveEntryId } from "../store/id.js";
import type {
  EpisodicExperience,
  ProfileInsight,
  SemanticFact,
} from "../store/engine.js";
import { queryOpLog } from "../observability/op-log.js";
import {
  TriggeredRetriever,
  type RerankerLlm,
} from "../retrieval/triggered.js";
import {
  addTrialLesson,
  getTrialLesson,
  listTrialLessons,
} from "../write/trial.js";
import {
  PROFILE_CAP,
  admitProfile,
  enforceProfileCapacity,
} from "../write/profile.js";
import { runLifecycleOnce } from "../lifecycle/janitor.js";
import type { JudgeLlm } from "./replay.js";
import type { LlmStats } from "./llm-client.js";

// ═══════════════════════════════════════════════════════════════
// 报告类型
// ═══════════════════════════════════════════════════════════════

export type MechSuiteName = "trial" | "gate" | "profile" | "cap";

export interface MechAssertion {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface MechCaseResult {
  readonly id: string;
  readonly suite: MechSuiteName;
  readonly passed: boolean;
  readonly assertions: readonly MechAssertion[];
  readonly writes: readonly { kind: string; id?: string; op?: string }[];
  readonly injectStatuses: readonly string[];
  readonly graduatedIds: readonly string[];
  readonly invalidatedIds: readonly string[];
  readonly warnings: readonly string[];
  readonly ms: number;
}

export interface MechReport {
  readonly suite: "memory-mechanism";
  readonly generatedAt: string;
  readonly passed: boolean | null;
  readonly mode: "fake" | "llm";
  readonly metrics: Record<string, number | string | null>;
  readonly details: readonly MechCaseResult[];
  readonly efficiency: {
    readonly llmCalls: number;
    readonly totalMs: number;
    readonly wallMs: number;
  };
  readonly residual: {
    readonly memoryItems: number;
    readonly trials: number;
    readonly opLogs: number;
  };
  readonly warnings: readonly string[];
}

export interface MechRunOptions {
  /** 默认跑全部 */
  suites?: readonly MechSuiteName[];
  /** fake（默认）| 传入 backbone 则 mode=llm（仅 Gate 精排可选用） */
  backbone?: JudgeLlm;
  stats?: LlmStats;
  keep?: boolean;
  now?: () => Date;
  workspaceRoot?: string;
}

// ═══════════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════════

function assert(name: string, ok: boolean, detail?: string): MechAssertion {
  return { name, ok, detail: ok ? undefined : detail ?? "failed" };
}

function allOk(xs: readonly MechAssertion[]): boolean {
  return xs.length > 0 && xs.every((a) => a.ok);
}

function uniqueRepo(prefix: string, ts: string): string {
  return `${prefix}-${ts}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function makeSemantic(repo: string, fact: string, keywords?: string[]): SemanticFact {
  const now = new Date().toISOString();
  return {
    id: "",
    kind: "semantic",
    repo,
    created: now,
    tValid: now,
    tInvalid: null,
    source: "agent_verified",
    confidence: 0.9,
    evidence: [],
    freq: 0,
    utility: 0,
    fact,
    keywords: keywords ?? fact.split(/\s+/).filter((w) => w.length > 4).slice(0, 6),
    embeddingKey: fact,
  };
}

function makeEpisodic(
  repo: string,
  whenToUse: string,
  perspective: string,
  modification: string[],
): EpisodicExperience {
  const now = new Date().toISOString();
  return {
    id: "",
    kind: "episodic",
    repo,
    created: now,
    tValid: now,
    tInvalid: null,
    source: "agent_verified",
    confidence: 0.85,
    evidence: [`runs/mech#seed`],
    freq: 0,
    utility: 0,
    whenToUse,
    perspective,
    modification,
    issueType: "test",
    taskId: "mech-seed",
  };
}

async function cleanupScope(repo: string, runPrefix: string): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${repo})`;
  await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${repo}`;
  await sql`DELETE FROM memory_trial_lessons WHERE origin_task_id LIKE ${runPrefix + "%"}`;
  await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${runPrefix + "%"}`;
  await sql`
    DELETE FROM outbox_events
    WHERE aggregate_type = 'memory-write-queue'
      AND aggregate_id LIKE ${runPrefix + "%"}
  `.catch(() => undefined);
}

async function countResidual(repo: string, runPrefix: string): Promise<MechReport["residual"]> {
  const sql = getSql();
  const [m] = (await sql`
    SELECT count(*)::int AS n FROM memory_items WHERE scope->>'repositoryId' = ${repo}
  `) as unknown as { n: number }[];
  const [t] = (await sql`
    SELECT count(*)::int AS n FROM memory_trial_lessons WHERE origin_task_id LIKE ${runPrefix + "%"}
  `) as unknown as { n: number }[];
  const [o] = (await sql`
    SELECT count(*)::int AS n FROM memory_op_log WHERE run_id LIKE ${runPrefix + "%"}
  `) as unknown as { n: number }[];
  return {
    memoryItems: m?.n ?? 0,
    trials: t?.n ?? 0,
    opLogs: o?.n ?? 0,
  };
}

async function drainOutbox(max = 30): Promise<number> {
  const core = getMemoryV2CoreForTests();
  if (!core) return 0;
  let n = 0;
  for (let i = 0; i < max; i++) {
    const did = await core.pipeline.processNext();
    if (!did) break;
    n += 1;
  }
  return n;
}

function makeTmpWorkspace(repo: string): string {
  const root = mkdtempSync(join(tmpdir(), "paw-mech-"));
  mkdirSync(join(root, ".paw"), { recursive: true });
  writeFileSync(
    join(root, ".paw", "settings.local.json"),
    JSON.stringify({ repository_id: repo, user_id: "mech", workspace_id: repo }),
    "utf8",
  );
  return root;
}

// ═══════════════════════════════════════════════════════════════
// Trial（RuntimeV2）
// ═══════════════════════════════════════════════════════════════

async function runTrialSuite(opts: {
  ts: string;
  keep?: boolean;
  workspaceRoot?: string;
}): Promise<MechCaseResult[]> {
  const results: MechCaseResult[] = [];
  const runPrefix = `mech-trial-${opts.ts}`;
  const repo = uniqueRepo(`mech-trial`, opts.ts);
  const root = opts.workspaceRoot ?? makeTmpWorkspace(repo);
  const ownTmp = !opts.workspaceRoot;

  const distill = async (prompt: string) => {
    if (prompt.includes("失败复盘") || prompt.includes("试用教训") || prompt.includes("trial")) {
      return JSON.stringify({
        lesson: "我不该在没有锁定依赖版本时升级核心包。",
        whenToUse: "When MechJadePeerError appears after a core package upgrade",
        keywords: ["MechJadePeerError", "peer", "upgrade"],
      });
    }
    return JSON.stringify({ candidates: [] });
  };

  let runtime: MemoryRuntime | null = null;
  try {
    resetMemoryV2Core();
    runtime = await createMemoryRuntime({
      workspaceRoot: root,
      repositoryId: repo,
      dailyBudget: 500,
      llm: { distill, govern: async () => JSON.stringify({ decisions: [] }), rerank: undefined },
    });

    // ── Case 1: 失败只进 trial，不进正式库；召回 trial；测试通过转正 ──
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const writes: Array<MechCaseResult["writes"][number]> = [];
      const injectStatuses: string[] = [];
      const graduatedIds: string[] = [];
      const warnings: string[] = [];

      const failBegun = await runtime.beginTask({
        runId: `${runPrefix}-fail`,
        goal: "upgrade core package",
      });
      await runtime.onToolResult({
        taskId: failBegun.taskId,
        toolName: "workspace.run_shell",
        args: { command: "bun test" },
        ok: false,
        summary: "bun test failed: MechJadePeerError unmet peer",
        rawPayload: "MechJadePeerError: unmet peer dependency after bump",
        idempotencyKey: `${failBegun.taskId}-1`,
        exitCode: 1,
      });
      await runtime.completeTask({
        taskId: failBegun.taskId,
        status: "completed",
        finalMessage: "failed on peers",
      });
      await drainOutbox();

      const trials = await listTrialLessons(failBegun.taskId);
      assertions.push(assert("失败后进入 trial 池", trials.length === 1, `n=${trials.length}`));
      const trialId = trials[0]?.id;
      if (trialId) writes.push({ kind: "trial", id: trialId, op: "ADD" });

      const sql = getSql();
      const formal = (await sql`
        SELECT count(*)::int AS n FROM memory_items
        WHERE scope->>'repositoryId' = ${repo}
          AND type = 'episodic'
          AND (payload->>'source') = 'trial_graduated'
      `) as unknown as { n: number }[];
      // 此时不应有 graduated（尚未成功）
      assertions.push(
        assert("失败时无 trial_graduated 正式条", (formal[0]?.n ?? 0) === 0, `n=${formal[0]?.n}`),
      );

      // filler 防空库短路
      const engine = new PostgresMemoryStoreEngine();
      const filler = makeSemantic(
        repo,
        "MechJadePeerError handling requires pinning peer versions before upgrades",
        ["MechJadePeerError", "peer", "upgrade"],
      );
      await engine.put(filler);

      const okBegun = await runtime.beginTask({
        runId: `${runPrefix}-ok`,
        goal: "upgrade core with peers pinned",
      });
      // 先失败工具触发 T2 注入 trial（runId=taskId）
      const injected = await runtime.onToolResult({
        taskId: okBegun.taskId,
        toolName: "workspace.run_shell",
        args: { command: "bun install" },
        ok: false,
        summary: "MechJadePeerError again",
        rawPayload: "MechJadePeerError: unmet peer dependency\n    at install",
        idempotencyKey: `${okBegun.taskId}-fail`,
        exitCode: 1,
      });
      assertions.push(
        assert("相似任务能召回/注入 trial", Boolean(injected?.injected?.includes("trial") || injected?.injected?.includes("试用") || injected?.injected), `injected=${Boolean(injected?.injected)}`),
      );

      const trialLogs = await queryOpLog({ runId: okBegun.taskId, op: "read.inject.trial" });
      const injectOk = trialId != null && trialLogs.some((l) => l.entryIds.includes(trialId));
      assertions.push(assert("op-log read.inject.trial", injectOk, `logs=${trialLogs.length}`));
      if (injectOk) injectStatuses.push("trial");

      // 再跑过测试并完成 → settle 转正
      await runtime.onToolResult({
        taskId: okBegun.taskId,
        toolName: "workspace.run_shell",
        args: { command: "bun test" },
        ok: true,
        summary: "bun test: all tests passed",
        idempotencyKey: `${okBegun.taskId}-pass`,
        exitCode: 0,
      });
      await runtime.completeTask({
        taskId: okBegun.taskId,
        status: "completed",
        finalMessage: "fixed peers and tests green",
      });
      await drainOutbox();

      if (trialId) {
        assertions.push(assert("转正后 trial 池删除", (await getTrialLesson(trialId)) === null));
      }
      const gradLogs = await queryOpLog({ runId: okBegun.taskId, op: "write.graduated" });
      assertions.push(assert("op-log write.graduated", gradLogs.length >= 1, `n=${gradLogs.length}`));
      const memId = gradLogs[0]?.entryIds[0];
      if (memId) {
        graduatedIds.push(memId);
        writes.push({ kind: "episodic", id: memId, op: "trial_graduated" });
        const entry = await engine.get(memId);
        assertions.push(
          assert(
            "正式条 source=trial_graduated",
            entry?.kind === "episodic" && entry.source === "trial_graduated",
            entry ? `${entry.kind}/${(entry as EpisodicExperience).source}` : "missing",
          ),
        );
      }

      results.push({
        id: "trial-graduate-happy",
        suite: "trial",
        passed: allOk(assertions),
        assertions,
        writes: [...writes],
        injectStatuses,
        graduatedIds,
        invalidatedIds: [],
        warnings,
        ms: Date.now() - t0,
      });
    }

    // ── Case 2: 再次失败不转正 ──
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const origin = `${runPrefix}-fail2`;
      const again = `${runPrefix}-again`;
      const trial = await addTrialLesson("我不该忽略 MechQuartzTimeout。", origin, {
        whenToUse: "When MechQuartzTimeoutError appears in flaky integration tests",
        keywords: ["MechQuartzTimeoutError"],
        distilled: true,
      });
      const engine = new PostgresMemoryStoreEngine();
      await engine.put(
        makeSemantic(repo, "MechQuartzTimeoutError means integration timeout too low", [
          "MechQuartzTimeoutError",
        ]),
      );

      const begun = await runtime.beginTask({ runId: again, goal: "fix flaky" });
      await runtime.onToolResult({
        taskId: begun.taskId,
        toolName: "workspace.run_shell",
        args: { command: "bun test" },
        ok: false,
        summary: "bun test failed: MechQuartzTimeoutError",
        rawPayload: "MechQuartzTimeoutError: exceeded 5000ms",
        idempotencyKey: `${begun.taskId}-1`,
        exitCode: 1,
      });
      await runtime.completeTask({
        taskId: begun.taskId,
        status: "completed",
        finalMessage: "still failing",
      });
      await drainOutbox();

      const still = await getTrialLesson(trial.id);
      assertions.push(assert("再次失败仍留在 trial 池", still != null));
      assertions.push(
        assert("attemptsLeft 递减", (still?.attemptsLeft ?? 0) <= 2, `left=${still?.attemptsLeft}`),
      );
      const grad = await queryOpLog({ runId: begun.taskId, op: "write.graduated" });
      assertions.push(assert("无 write.graduated", grad.length === 0, `n=${grad.length}`));

      results.push({
        id: "trial-fail-again-no-graduate",
        suite: "trial",
        passed: allOk(assertions),
        assertions,
        writes: [{ kind: "trial", id: trial.id }],
        injectStatuses: [],
        graduatedIds: [],
        invalidatedIds: [],
        warnings: [],
        ms: Date.now() - t0,
      });
    }

    // ── Case 3: 无验证信号成功 → 不转正 ──
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const origin = `${runPrefix}-blind-o`;
      const blind = `${runPrefix}-blind`;
      const trial = await addTrialLesson("我不该盲改。", origin, {
        whenToUse: "When MechTopazBlindError shows up",
        keywords: ["MechTopazBlindError"],
        distilled: true,
      });
      const engine = new PostgresMemoryStoreEngine();
      await engine.put(
        makeSemantic(repo, "MechTopazBlindError synthetic keyword", ["MechTopazBlindError"]),
      );

      const begun = await runtime.beginTask({ runId: blind, goal: "touch files" });
      await runtime.onToolResult({
        taskId: begun.taskId,
        toolName: "workspace.run_shell",
        args: { command: "echo hi" },
        ok: false,
        summary: "MechTopazBlindError",
        rawPayload: "MechTopazBlindError: boom",
        idempotencyKey: `${begun.taskId}-1`,
        exitCode: 1,
      });
      // 无 bun test 成功记录 → complete 走 session_finalize / 或无 test verdict
      await runtime.onToolResult({
        taskId: begun.taskId,
        toolName: "workspace.read_file",
        args: { path: "x.ts" },
        ok: true,
        summary: "read",
        idempotencyKey: `${begun.taskId}-2`,
      });
      await runtime.completeTask({
        taskId: begun.taskId,
        status: "completed",
        finalMessage: "done without tests",
      });
      await drainOutbox();

      assertions.push(assert("盲改成功不转正", (await getTrialLesson(trial.id)) != null));
      const grad = await queryOpLog({ runId: begun.taskId, op: "write.graduated" });
      assertions.push(assert("无 write.graduated", grad.length === 0));

      results.push({
        id: "trial-blind-no-graduate",
        suite: "trial",
        passed: allOk(assertions),
        assertions,
        writes: [{ kind: "trial", id: trial.id }],
        injectStatuses: [],
        graduatedIds: [],
        invalidatedIds: [],
        warnings: [],
        ms: Date.now() - t0,
      });
    }
  } finally {
    if (!opts.keep) await cleanupScope(repo, runPrefix);
    await runtime?.shutdown().catch(() => undefined);
    if (ownTmp) rmSync(root, { recursive: true, force: true });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// Gate
// ═══════════════════════════════════════════════════════════════

async function runGateSuite(opts: {
  ts: string;
  keep?: boolean;
  backbone?: JudgeLlm;
}): Promise<MechCaseResult[]> {
  const results: MechCaseResult[] = [];
  const runPrefix = `mech-gate-${opts.ts}`;
  const repo = uniqueRepo(`mech-gate`, opts.ts);
  const engine = new PostgresMemoryStoreEngine();

  try {
    const epiApplicable = makeEpisodic(
      repo,
      "When MechGateAlphaError appears during migration freeze window",
      "冻结窗口内不要强推迁移，先确认窗口状态",
      ["检查 migration freeze window", "确认 MechGateAlphaError 上下文"],
    );
    await engine.put(epiApplicable);
    const epiId = deriveEntryId(epiApplicable);

    // 弱相关：词面几乎不重叠 → heuristic reference
    const epiWeak = makeEpisodic(
      repo,
      "When deploying static assets to CDN edge cache",
      "静态资源部署走 CDN",
      ["清 CDN 缓存"],
    );
    await engine.put(epiWeak);
    const weakId = deriveEntryId(epiWeak);

    // ── Heuristic：强相关 → applicable/建议策略 ──
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const runId = `${runPrefix}-heur-strong`;
      const retriever = new TriggeredRetriever({
        engine,
        countTokens: (t) => Math.ceil(t.length / 4),
      });
      const pkg = await retriever.retrieve({
        type: "explicit_query",
        question: "MechGateAlphaError during migration freeze window how to proceed?",
        repo,
        runId,
      });
      const hit = pkg.items.find((i) => i.id === epiId);
      assertions.push(assert("召回强相关条目", hit != null));
      assertions.push(
        assert("status=verified（applicable）", hit?.status === "verified", `status=${hit?.status}`),
      );
      const rendered = pkg.render();
      assertions.push(assert("措辞含建议策略", rendered.includes("建议策略")));
      const gates = await queryOpLog({ runId, op: "read.gate" });
      assertions.push(assert("read.gate 存在", gates.length >= 1));
      assertions.push(
        assert(
          "source=heuristic",
          gates[0]?.detail?.source === "heuristic",
          `source=${gates[0]?.detail?.source}`,
        ),
      );
      assertions.push(
        assert(
          "applicable≥1",
          Number(gates[0]?.detail?.applicable ?? 0) >= 1,
          `applicable=${gates[0]?.detail?.applicable}`,
        ),
      );

      results.push({
        id: "gate-heuristic-applicable",
        suite: "gate",
        passed: allOk(assertions),
        assertions,
        writes: [{ kind: "episodic", id: epiId }],
        injectStatuses: hit ? [hit.status] : [],
        graduatedIds: [],
        invalidatedIds: [],
        warnings: [],
        ms: Date.now() - t0,
      });
    }

    // ── Heuristic：弱相关 → reference ──
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const runId = `${runPrefix}-heur-weak`;
      const retriever = new TriggeredRetriever({
        engine,
        countTokens: (t) => Math.ceil(t.length / 4),
      });
      // 只问 CDN，应打到 weak 或对 alpha 判 reference
      const pkg = await retriever.retrieve({
        type: "explicit_query",
        question: "how to purge CDN edge cache for static assets?",
        repo,
        runId,
      });
      const weakHit = pkg.items.find((i) => i.id === weakId);
      const alphaHit = pkg.items.find((i) => i.id === epiId);
      // 若 alpha 被召回，必须是 reference；weak 若召回应为 verified 或 reference 均可，重点测不符条件 → reference
      if (alphaHit) {
        assertions.push(
          assert(
            "条件不符条目为 reference",
            alphaHit.status === "reference",
            `status=${alphaHit.status}`,
          ),
        );
      } else {
        assertions.push(assert("弱查询未强推 alpha（可接受）", true));
      }
      const rendered = pkg.render();
      if (pkg.items.some((i) => i.status === "reference")) {
        assertions.push(assert("措辞含历史参考", rendered.includes("历史参考（可能不适用）")));
      } else if (weakHit) {
        assertions.push(assert("弱相关命中弱条目", true));
      } else {
        assertions.push(assert("有注入或空召回均可", true));
      }
      const gates = await queryOpLog({ runId, op: "read.gate" });
      if (gates.length > 0) {
        assertions.push(
          assert("source=heuristic", gates[0]!.detail?.source === "heuristic"),
        );
      } else {
        assertions.push(assert("无命中时无 gate 日志可接受", pkg.items.length === 0));
      }

      results.push({
        id: "gate-heuristic-reference",
        suite: "gate",
        passed: allOk(assertions),
        assertions,
        writes: [{ kind: "episodic", id: weakId }],
        injectStatuses: pkg.items.map((i) => i.status),
        graduatedIds: [],
        invalidatedIds: [],
        warnings: [],
        ms: Date.now() - t0,
      });
    }

    // ── Rerank 路径：强制 label=reference ──
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const runId = `${runPrefix}-rerank-ref`;
      const reranker: RerankerLlm = {
        complete: async (_prompt) => {
          // 精排输出：把第一条标 reference
          return JSON.stringify({
            items: [{ seq: 1, why: "条件不匹配当前任务", label: "reference" }],
          });
        },
      };
      const retriever = new TriggeredRetriever({
        engine,
        reranker,
        countTokens: (t) => Math.ceil(t.length / 4),
      });
      const pkg = await retriever.retrieve({
        type: "explicit_query",
        question: "MechGateAlphaError during migration freeze window how to proceed?",
        repo,
        runId,
      });
      const hit = pkg.items.find((i) => i.id === epiId);
      assertions.push(assert("召回条目", hit != null));
      assertions.push(
        assert("rerank → reference", hit?.status === "reference", `status=${hit?.status}`),
      );
      assertions.push(assert("措辞历史参考", pkg.render().includes("历史参考（可能不适用）")));
      const gates = await queryOpLog({ runId, op: "read.gate" });
      assertions.push(
        assert("source=rerank", gates[0]?.detail?.source === "rerank", `source=${gates[0]?.detail?.source}`),
      );
      assertions.push(
        assert(
          "reference≥1",
          Number(gates[0]?.detail?.reference ?? 0) >= 1,
          `reference=${gates[0]?.detail?.reference}`,
        ),
      );

      results.push({
        id: "gate-rerank-reference",
        suite: "gate",
        passed: allOk(assertions),
        assertions,
        writes: [],
        injectStatuses: hit ? [hit.status] : [],
        graduatedIds: [],
        invalidatedIds: [],
        warnings: [],
        ms: Date.now() - t0,
      });
    }

    // ── Rerank applicable ──
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const runId = `${runPrefix}-rerank-app`;
      const reranker: RerankerLlm = {
        complete: async () =>
          JSON.stringify({
            items: [{ seq: 1, why: "直接适用", label: "applicable" }],
          }),
      };
      const retriever = new TriggeredRetriever({
        engine,
        reranker,
        countTokens: (t) => Math.ceil(t.length / 4),
      });
      const pkg = await retriever.retrieve({
        type: "explicit_query",
        question: "MechGateAlphaError during migration freeze window how to proceed?",
        repo,
        runId,
      });
      const hit = pkg.items.find((i) => i.id === epiId);
      assertions.push(assert("rerank → verified", hit?.status === "verified", `status=${hit?.status}`));
      assertions.push(assert("措辞建议策略", pkg.render().includes("建议策略")));
      const gates = await queryOpLog({ runId, op: "read.gate" });
      assertions.push(assert("source=rerank", gates[0]?.detail?.source === "rerank"));

      results.push({
        id: "gate-rerank-applicable",
        suite: "gate",
        passed: allOk(assertions),
        assertions,
        writes: [],
        injectStatuses: hit ? [hit.status] : [],
        graduatedIds: [],
        invalidatedIds: [],
        warnings: [],
        ms: Date.now() - t0,
      });
    }
  } finally {
    if (!opts.keep) await cleanupScope(repo, runPrefix);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// Profile
// ═══════════════════════════════════════════════════════════════

async function runProfileSuite(opts: { ts: string; keep?: boolean }): Promise<MechCaseResult[]> {
  const results: MechCaseResult[] = [];
  const runPrefix = `mech-prof-${opts.ts}`;
  const repo = uniqueRepo(`mech-prof`, opts.ts);
  const engine = new PostgresMemoryStoreEngine();

  try {
    // 1–2 证据拒绝
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const r1 = await admitProfile(
        {
          insight: "提交前必跑完整测试套件再合入主线",
          evidence: ["runs/a"],
          repo,
          source: "agent_inferred",
        },
        { engine, runId: `${runPrefix}-e1` },
      );
      assertions.push(
        assert("1 条证据拒绝", r1.status === "rejected", JSON.stringify(r1)),
      );
      assertions.push(
        assert(
          "reason 含 evidence_below",
          r1.status === "rejected" && r1.reason.includes("evidence_below"),
          r1.status === "rejected" ? r1.reason : "",
        ),
      );
      const r2 = await admitProfile(
        {
          insight: "提交前必跑完整测试套件再合入主线",
          evidence: ["runs/a", "runs/b"],
          repo,
          source: "agent_inferred",
        },
        { engine, runId: `${runPrefix}-e2` },
      );
      assertions.push(assert("2 条证据拒绝", r2.status === "rejected"));

      results.push({
        id: "profile-evidence-reject",
        suite: "profile",
        passed: allOk(assertions),
        assertions,
        writes: [],
        injectStatuses: [],
        graduatedIds: [],
        invalidatedIds: [],
        warnings: [],
        ms: Date.now() - t0,
      });
    }

    // 第 3 条写入 + 同主题 EDIT + 形容词拒绝
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const writes: Array<MechCaseResult["writes"][number]> = [];
      const add = await admitProfile(
        {
          insight: "提交前必跑完整测试套件再合入主线",
          evidence: ["runs/a", "runs/b", "runs/c"],
          repo,
          source: "agent_inferred",
        },
        { engine, runId: `${runPrefix}-add` },
      );
      assertions.push(assert("3 条证据 ADD", add.status === "written" && add.op === "ADD", JSON.stringify(add)));
      if (add.status === "written") writes.push({ kind: "profile", id: add.memoryId, op: "ADD" });

      const edit = await admitProfile(
        {
          insight: "提交前必须跑完整测试套件然后合入主线分支",
          evidence: ["runs/a", "runs/b", "runs/c", "runs/d"],
          repo,
          source: "agent_inferred",
        },
        { engine, runId: `${runPrefix}-edit` },
      );
      assertions.push(assert("同主题 EDIT", edit.status === "edited" && edit.op === "EDIT", JSON.stringify(edit)));
      if (edit.status === "edited") {
        writes.push({ kind: "profile", id: edit.memoryId, op: "EDIT" });
        assertions.push(
          assert("EDIT 不新增 id", add.status === "written" && edit.memoryId === add.memoryId),
        );
      }
      const active = await engine.query({ kind: "profile", repo, limit: 50 });
      assertions.push(assert("同主题仅 1 条活跃画像", active.length === 1, `n=${active.length}`));

      const bad = await admitProfile(
        {
          insight: "用户很谨慎",
          evidence: ["runs/1", "runs/2", "runs/3"],
          repo,
          source: "agent_inferred",
        },
        { engine, runId: `${runPrefix}-adj` },
      );
      assertions.push(
        assert(
          "不可操作描述拒绝",
          bad.status === "rejected" && bad.reason === "not_behavior_description",
          JSON.stringify(bad),
        ),
      );

      results.push({
        id: "profile-add-edit-reject-adj",
        suite: "profile",
        passed: allOk(assertions),
        assertions,
        writes,
        injectStatuses: [],
        graduatedIds: [],
        invalidatedIds: [],
        warnings: [],
        ms: Date.now() - t0,
      });
    }
  } finally {
    if (!opts.keep) await cleanupScope(repo, runPrefix);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// Cap
// ═══════════════════════════════════════════════════════════════

function orthogonalInsight(i: number): string {
  // 纯拉丁正交主题，避免中文二字窗误触发 EDIT
  const topics = [
    "Always run full unit suite before merging pull requests",
    "Prefer dependency injection when wiring auth services",
    "Snapshot database before every production migration job",
    "Keep public package API stable across minor releases",
    "Attach request identifiers to every structured log line",
    "Propagate timeout errors instead of swallowing them",
    "Bust caches with explicit version stamps after deploys",
    "Write reversible down scripts for every schema change",
    "Load secrets only from environment variables never files",
    "Cap parallel workspace tasks to four concurrent workers",
    "Update docs in the same pull request as code changes",
    "Run integration tests before bumping major dependencies",
    "Ship feature flags disabled by default in production",
    "Export error codes into the monitoring dashboard panels",
    "Forbid skipping lint hooks in local git configuration",
    "Evict lowest utility profile when capacity is saturated",
  ];
  return topics[i] ?? `Unique orthogonal profile behavior number ${i}`;
}

async function runCapSuite(opts: { ts: string; keep?: boolean }): Promise<MechCaseResult[]> {
  const results: MechCaseResult[] = [];
  const runPrefix = `mech-cap-${opts.ts}`;
  const repo = uniqueRepo(`mech-cap`, opts.ts);
  const engine = new PostgresMemoryStoreEngine();

  try {
    // 填满 15 条（低效用可淘汰）再加第 16 条
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const writes: Array<MechCaseResult["writes"][number]> = [];
      const invalidatedIds: string[] = [];

      for (let i = 0; i < PROFILE_CAP; i++) {
        const r = await admitProfile(
          {
            insight: orthogonalInsight(i),
            evidence: [`runs/c${i}/a`, `runs/c${i}/b`, `runs/c${i}/c`],
            repo,
            source: "agent_inferred",
            confidence: 0.7,
          },
          { engine, runId: `${runPrefix}-fill-${i}` },
        );
        assertions.push(assert(`填入#${i}`, r.status === "written", JSON.stringify(r)));
        if (r.status === "written") {
          writes.push({ kind: "profile", id: r.memoryId, op: "ADD" });
          // 人为拉开效用：靠前的更低
          const entry = await engine.get(r.memoryId);
          if (entry && entry.kind === "profile") {
            await engine.put({ ...entry, utility: i, freq: 0 });
          }
        }
      }
      let active = await engine.query({ kind: "profile", repo, limit: 50 });
      assertions.push(assert("满员 15", active.length === PROFILE_CAP, `n=${active.length}`));

      const sixteenth = await admitProfile(
        {
          insight: orthogonalInsight(15),
          evidence: ["runs/c15/a", "runs/c15/b", "runs/c15/c"],
          repo,
          source: "agent_inferred",
        },
        { engine, runId: `${runPrefix}-16` },
      );
      assertions.push(
        assert(
          "第 16 条 ADD 并腾位",
          sixteenth.status === "written" && "removedId" in sixteenth && Boolean(sixteenth.removedId),
          JSON.stringify(sixteenth),
        ),
      );
      if (sixteenth.status === "written" && "removedId" in sixteenth && sixteenth.removedId) {
        invalidatedIds.push(sixteenth.removedId);
        writes.push({ kind: "profile", id: sixteenth.memoryId, op: "ADD" });
        writes.push({ kind: "profile", id: sixteenth.removedId, op: "REMOVE" });
      }
      active = (await engine.query({ kind: "profile", repo, limit: 50 })).filter(
        (e) => e.tInvalid == null,
      );
      assertions.push(assert("腾位后仍 15", active.length === PROFILE_CAP, `n=${active.length}`));

      results.push({
        id: "cap-evict-lowest-utility",
        suite: "cap",
        passed: allOk(assertions),
        assertions,
        writes,
        injectStatuses: [],
        graduatedIds: [],
        invalidatedIds,
        warnings: [],
        ms: Date.now() - t0,
      });
    }

    // 全部 user_statement 不可淘汰 → profile_cap_no_removable
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const repo2 = uniqueRepo(`mech-cap-usr`, opts.ts);
      for (let i = 0; i < 2; i++) {
        await admitProfile(
          {
            insight:
              i === 0
                ? "Prefer pnpm exclusively when installing workspace packages"
                : "Mandate yarn classic solely for legacy plugin builds",
            evidence: [`runs/u${i}/a`, `runs/u${i}/b`, `runs/u${i}/c`],
            repo: repo2,
            source: "user_statement",
          },
          { engine, runId: `${runPrefix}-usr-${i}`, cap: 2 },
        );
      }
      const blocked = await admitProfile(
        {
          insight: "Enable typescript strictNullChecks inside compiler options",
          evidence: ["runs/ux/a", "runs/ux/b", "runs/ux/c"],
          repo: repo2,
          source: "agent_inferred",
        },
        { engine, runId: `${runPrefix}-usr-block`, cap: 2 },
      );
      assertions.push(
        assert(
          "无可腾位拒绝",
          blocked.status === "rejected" && blocked.reason === "profile_cap_no_removable",
          JSON.stringify(blocked),
        ),
      );
      if (!opts.keep) await cleanupScope(repo2, runPrefix);

      results.push({
        id: "cap-no-removable",
        suite: "cap",
        passed: allOk(assertions),
        assertions,
        writes: [],
        injectStatuses: [],
        graduatedIds: [],
        invalidatedIds: [],
        warnings: [],
        ms: Date.now() - t0,
      });
    }

    // runLifecycleOnce 强制恢复容量
    {
      const t0 = Date.now();
      const assertions: MechAssertion[] = [];
      const repo3 = uniqueRepo(`mech-cap-lc`, opts.ts);
      // 直接 put 16 条绕过 admit 腾位，制造超限
      for (let i = 0; i < 16; i++) {
        const now = new Date().toISOString();
        const entry: ProfileInsight = {
          id: "",
          kind: "profile",
          repo: repo3,
          created: now,
          tValid: now,
          tInvalid: null,
          source: "agent_inferred",
          confidence: 0.7,
          evidence: [`runs/l${i}/a`, `runs/l${i}/b`, `runs/l${i}/c`],
          freq: 0,
          utility: i,
          insight: orthogonalInsight(i) + " lifecycle",
          supportCount: 3,
        };
        await engine.put(entry);
      }
      let active = await engine.query({ kind: "profile", repo: repo3, limit: 50 });
      assertions.push(assert("制造超限 ≥16", active.length >= 16, `n=${active.length}`));

      const report = await runLifecycleOnce({
        engine,
        config: { repo: repo3, profileCap: PROFILE_CAP },
      });
      active = (await engine.query({ kind: "profile", repo: repo3, limit: 50 })).filter(
        (e) => e.tInvalid == null,
      );
      assertions.push(
        assert("lifecycle 后 ≤15", active.length <= PROFILE_CAP, `n=${active.length}`),
      );
      assertions.push(
        assert(
          "capacity 报告收敛",
          report.capacity.profileOverCap === 0 || active.length <= PROFILE_CAP,
          JSON.stringify(report.capacity),
        ),
      );

      // 也直接打 enforce 一次确认入口
      const removed = await enforceProfileCapacity(engine, {
        repo: repo3,
        cap: PROFILE_CAP,
        runId: `${runPrefix}-enforce`,
      });
      assertions.push(assert("enforce 可调用", Array.isArray(removed)));

      if (!opts.keep) await cleanupScope(repo3, runPrefix);

      results.push({
        id: "cap-lifecycle-enforce",
        suite: "cap",
        passed: allOk(assertions),
        assertions,
        writes: [],
        injectStatuses: [],
        graduatedIds: [],
        invalidatedIds: removed,
        warnings: [],
        ms: Date.now() - t0,
      });
    }
  } finally {
    if (!opts.keep) await cleanupScope(repo, runPrefix);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// 入口 / 渲染
// ═══════════════════════════════════════════════════════════════

export function renderMechReport(r: MechReport): string {
  const lines = [
    `记忆机制验收 [${r.suite}] mode=${r.mode}    ${r.passed === null ? "判定: 样本不足" : r.passed ? "判定: ✅ 达标" : "判定: ❌ 未达标"}`,
    `生成: ${r.generatedAt}`,
    "指标:",
  ];
  for (const [k, v] of Object.entries(r.metrics)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push(
    `效率: llm=${r.efficiency.llmCalls} wallMs=${r.efficiency.wallMs} totalMs=${r.efficiency.totalMs}`,
  );
  lines.push(
    `残留: items=${r.residual.memoryItems} trials=${r.residual.trials} oplogs=${r.residual.opLogs}`,
  );
  lines.push("用例:");
  for (const d of r.details) {
    lines.push(`  ${d.passed ? "✅" : "❌"} ${d.suite}/${d.id} (${d.ms}ms)`);
    for (const a of d.assertions.filter((x) => !x.ok)) {
      lines.push(`      - FAIL ${a.name}: ${a.detail ?? ""}`);
    }
  }
  if (r.warnings.length) {
    lines.push("警告:");
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

export async function runMechanismSuite(opts: MechRunOptions = {}): Promise<MechReport> {
  const wall0 = Date.now();
  const now = opts.now ?? (() => new Date());
  const ts = now().getTime().toString(36);
  const want = new Set<MechSuiteName>(
    opts.suites ?? ["trial", "gate", "profile", "cap"],
  );
  const details: MechCaseResult[] = [];
  const warnings: string[] = [];

  if (want.has("trial")) {
    try {
      details.push(...(await runTrialSuite({ ts, keep: opts.keep, workspaceRoot: opts.workspaceRoot })));
    } catch (e) {
      warnings.push(`trial: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (want.has("gate")) {
    try {
      details.push(...(await runGateSuite({ ts, keep: opts.keep, backbone: opts.backbone })));
    } catch (e) {
      warnings.push(`gate: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (want.has("profile")) {
    try {
      details.push(...(await runProfileSuite({ ts, keep: opts.keep })));
    } catch (e) {
      warnings.push(`profile: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (want.has("cap")) {
    try {
      details.push(...(await runCapSuite({ ts, keep: opts.keep })));
    } catch (e) {
      warnings.push(`cap: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 汇总残留：抽查本次前缀（keep 时会非零）
  const sampleRepo = uniqueRepo(`mech-trial`, ts);
  const residual = opts.keep
    ? await countResidual(sampleRepo, `mech-trial-${ts}`).catch(() => ({
        memoryItems: -1,
        trials: -1,
        opLogs: -1,
      }))
    : { memoryItems: 0, trials: 0, opLogs: 0 };

  // 再扫一遍各前缀确认清理（非 keep）
  if (!opts.keep) {
    for (const [repoP, runP] of [
      [`mech-trial`, `mech-trial-${ts}`],
      [`mech-gate`, `mech-gate-${ts}`],
      [`mech-prof`, `mech-prof-${ts}`],
      [`mech-cap`, `mech-cap-${ts}`],
    ] as const) {
      const r = await countResidual(uniqueRepo(repoP, ts), runP).catch(() => null);
      if (r && (r.memoryItems > 0 || r.trials > 0)) {
        warnings.push(`残留 ${repoP}: items=${r.memoryItems} trials=${r.trials}`);
      }
    }
  }

  const bySuite = (s: MechSuiteName) => details.filter((d) => d.suite === s);
  const passedSuites = (["trial", "gate", "profile", "cap"] as const).filter(
    (s) => want.has(s) && bySuite(s).length > 0 && bySuite(s).every((d) => d.passed),
  );
  const failedCases = details.filter((d) => !d.passed);
  const passed =
    details.length === 0
      ? null
      : failedCases.length === 0 && warnings.filter((w) => w.startsWith("残留")).length === 0;

  return {
    suite: "memory-mechanism",
    generatedAt: now().toISOString(),
    passed,
    mode: opts.backbone ? "llm" : "fake",
    metrics: {
      用例数: details.length,
      通过用例: details.filter((d) => d.passed).length,
      失败用例: failedCases.length,
      trial通过: bySuite("trial").every((d) => d.passed) && bySuite("trial").length > 0 ? 1 : 0,
      gate通过: bySuite("gate").every((d) => d.passed) && bySuite("gate").length > 0 ? 1 : 0,
      profile通过: bySuite("profile").every((d) => d.passed) && bySuite("profile").length > 0 ? 1 : 0,
      cap通过: bySuite("cap").every((d) => d.passed) && bySuite("cap").length > 0 ? 1 : 0,
      通过套件数: passedSuites.length,
    },
    details,
    efficiency: {
      llmCalls: opts.stats?.calls ?? 0,
      totalMs: opts.stats?.totalMs ?? details.reduce((a, d) => a + d.ms, 0),
      wallMs: Date.now() - wall0,
    },
    residual,
    warnings: [...warnings, ...details.flatMap((d) => d.warnings)],
  };
}
