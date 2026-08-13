/**
 * SWE-Exp 单臂 runner：独立 worktree + memory namespace + AgentOrchestrator
 */

import { existsSync, readFileSync } from "node:fs";

import {
  REQUIRE_MUTATION_MARKER,
  createBudgetAbort,
  createRunOrchestrator,
  resolveLifecycleBudget,
} from "@paw/agent";
import type { RunEventEnvelope } from "@paw/core";
import {
  buildConversationAwareQuery,
  createMemoryRuntime,
  extractCleanMemoryQuery,
} from "@paw/memory";
import {
  type EpisodicExperience,
  PostgresMemoryStoreEngine,
  deriveEntryId,
} from "@paw/memory/longterm";
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";

import { buildSweAcceptanceCriteria } from "./acceptance.js";
import type {
  SweBenchLiteInstance,
  SweExpArmCheckpoint,
  SweExpArmResultExtended,
} from "./agent-types.js";
import { saveArmCheckpoint } from "./checkpoint.js";
import { assertNoGoldLeak, distillHistoryLesson } from "./history-seed.js";
import {
  createCommitWorktree,
  ensureRepoClone,
  gitDiff,
  writeArmPawConfig,
} from "./repo-cache.js";

export interface RunAgentArmOptions {
  readonly suiteRunId: string;
  readonly pairId: string;
  readonly arm: "off" | "on";
  readonly probe: SweBenchLiteInstance;
  /** on 臂才用；蒸馏自 history，不含 gold */
  readonly history?: SweBenchLiteInstance;
  readonly cacheDir: string;
  readonly checkpointDir: string;
  readonly hostWorkspaceRoot: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly keep?: boolean;
  readonly skipEval?: boolean;
}

function loadHostSettings(
  hostRoot: string,
): Record<string, unknown> | undefined {
  try {
    const p = defaultSettingsPath(hostRoot);
    if (!existsSync(p)) return undefined;
    return loadPawSettingsLocal(p) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function retrievalQuery(goal: string): string {
  return (
    buildConversationAwareQuery(goal) || extractCleanMemoryQuery(goal) || goal
  );
}

/**
 * Build the coding goal from public issue/test metadata only. Gold patch and
 * test patch are deliberately outside this function's data flow.
 */
export function buildSweAgentGoal(probe: SweBenchLiteInstance): string {
  const failToPass = probe.FAIL_TO_PASS?.filter(Boolean) ?? [];
  const passToPass = probe.PASS_TO_PASS?.filter(Boolean) ?? [];
  return [
    "Fix the bug described below so that the relevant tests pass.",
    REQUIRE_MUTATION_MARKER,
    "You are the coding agent: edit existing tracked source files with workspace.edit_file or workspace.apply_patch.",
    "Do not create helper scripts, patches-as-files, or new top-level fix_*.py files — change the project source in place.",
    "Do not only describe the fix or schedule other agents.",
    "Make a minimal change. Do not modify unrelated files or any test files.",
    "After editing, run the narrowest relevant tests before final_answer.",
    "Do not call final_answer until at least one existing source file has been modified.",
    failToPass.length > 0
      ? `External FAIL_TO_PASS acceptance tests (read-only; run these when feasible):\n${failToPass.map((test) => `- ${test}`).join("\n")}`
      : "No explicit FAIL_TO_PASS identifiers are available; locate the narrowest relevant existing test.",
    passToPass.length > 0
      ? `Regression tests that must remain passing (read-only):\n${passToPass
          .slice(0, 20)
          .map((test) => `- ${test}`)
          .join("\n")}`
      : "",
    "",
    probe.problem_statement,
  ]
    .filter(Boolean)
    .join("\n");
}

async function seedHistoryMemory(
  workspaceRoot: string,
  history: SweBenchLiteInstance,
  probeGoldPatch?: string,
): Promise<{ seedId: string; recalled: boolean }> {
  const lesson = distillHistoryLesson({
    historyId: history.instance_id,
    repo: history.repo,
    problemStatement: history.problem_statement,
    hintsText: history.hints_text,
  });
  assertNoGoldLeak(lesson, probeGoldPatch);
  assertNoGoldLeak(lesson, history.patch);

  const runtime = await createMemoryRuntime({ workspaceRoot });
  const ok = await runtime.ping();
  if (!ok) throw new Error("memory runtime ping failed (DATABASE_URL?)");

  await runtime.saveMemory({
    title: lesson.title,
    summary: lesson.summary,
    content: lesson.modification.join("\n"),
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
    confidence: 0.85,
    evidence: [`history:${history.instance_id}`, "no_gold"],
    freq: 0,
    utility: 0,
    whenToUse: `${history.problem_statement.slice(0, 200)}. ${lesson.whenToUse}`,
    perspective: lesson.perspective,
    modification: lesson.modification,
    issueType: "swe-exp-history",
    taskId: history.instance_id,
  };
  await new PostgresMemoryStoreEngine().put(seedEntry);
  const seedId = deriveEntryId(seedEntry);

  const goal = history.problem_statement; // preflight with probe goal done by caller
  void goal;
  return { seedId, recalled: false };
}

async function preflightRecall(
  workspaceRoot: string,
  goal: string,
  seedId: string,
): Promise<boolean> {
  const runtime = await createMemoryRuntime({ workspaceRoot });
  try {
    if (!(await runtime.ping())) return false;
    const begun = await runtime.beginTask({
      runId: `swe-exp-preflight-${Date.now().toString(36)}`,
      goal,
      title: goal.slice(0, 120),
    });
    const section = await runtime.buildContextSection({
      taskId: begun.taskId,
      query: retrievalQuery(goal),
      tokenBudget: 1500,
      currentUserRequest: goal,
      limit: 8,
    });
    return section.items.some((i) => i.id === seedId);
  } finally {
    /* keep pool for orchestrator */
  }
}

const EDIT_TOOLS = new Set([
  "workspace.edit_file",
  "workspace.write_file",
  "workspace.apply_patch",
]);

function collectMetrics(events: RunEventEnvelope[]): {
  modelCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  steps: number;
  durationMs: number;
  recalled: boolean;
  shellPolicyErrors: number;
  codingPhaseErrors: number;
  editToolCalls: number;
  toolHistogram: Record<string, number>;
} {
  let modelCalls = 0;
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let steps = 0;
  let durationMs = 0;
  let recalled = false;
  let shellPolicyErrors = 0;
  let codingPhaseErrors = 0;
  let editToolCalls = 0;
  const toolHistogram: Record<string, number> = {};

  for (const env of events) {
    const e = env.event;
    if (e.type === "model.done") {
      modelCalls += 1;
      const u = e.usage;
      if (u) {
        totalTokens += (u.totalTokens ?? 0) || 0;
        promptTokens += (u.promptTokens ?? 0) || 0;
        completionTokens += (u.completionTokens ?? 0) || 0;
      }
    } else if (e.type === "run.metrics") {
      modelCalls = e.modelCalls || modelCalls;
      totalTokens = e.totalTokens || totalTokens;
      steps = e.steps || steps;
      durationMs = e.durationMs || durationMs;
    } else if (e.type === "tool.call") {
      const name = String(e.tool ?? "");
      if (name) {
        toolHistogram[name] = (toolHistogram[name] ?? 0) + 1;
        if (EDIT_TOOLS.has(name)) editToolCalls += 1;
      }
    } else if (e.type === "tool.result") {
      const blob = `${e.summary ?? ""} ${e.detail ?? ""}`.toLowerCase();
      if (
        blob.includes("e_policy") ||
        blob.includes("requires approval") ||
        blob.includes("policy_denied")
      ) {
        shellPolicyErrors += 1;
      }
      if (blob.includes("e_coding_phase")) codingPhaseErrors += 1;
    } else if (e.type === "memory.retrieve.done") {
      if ((e.selectedCount ?? 0) > 0) {
        recalled = true;
      }
    }
  }
  return {
    modelCalls,
    totalTokens,
    promptTokens,
    completionTokens,
    steps,
    durationMs,
    recalled,
    shellPolicyErrors,
    codingPhaseErrors,
    editToolCalls,
    toolHistogram,
  };
}

/**
 * 跑单臂：clone/worktree → 配 .paw →（on）seed → orchestrator → git diff
 * 不在此做官方 harness（由外层批量评测）；resolved 默认 false 直至外层写入。
 */
export async function runAgentArm(
  opts: RunAgentArmOptions,
): Promise<SweExpArmCheckpoint> {
  const memoryOn = opts.arm === "on";
  const repositoryId =
    `swe-exp-${opts.pairId}-${opts.arm}-${opts.suiteRunId}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
  const armRunId = `${opts.suiteRunId}-${opts.pairId}-${opts.arm}`;
  const startedAt = new Date().toISOString();

  let running: SweExpArmCheckpoint = {
    pairId: opts.pairId,
    arm: opts.arm,
    status: "running",
    runId: armRunId,
    repositoryId,
    startedAt,
  };
  saveArmCheckpoint(opts.checkpointDir, opts.suiteRunId, running);

  let cleanup: (() => void) | undefined;
  try {
    if (!opts.probe.base_commit) {
      throw new Error(`probe ${opts.probe.instance_id} missing base_commit`);
    }
    const gitRoot = ensureRepoClone(opts.probe.repo, opts.cacheDir);
    const wt = createCommitWorktree(
      gitRoot,
      opts.probe.base_commit,
      `${opts.arm}-${opts.pairId.slice(0, 24)}`,
    );
    cleanup = wt.cleanup;
    running = { ...running, workspaceRoot: wt.root };
    saveArmCheckpoint(opts.checkpointDir, opts.suiteRunId, running);

    const hostSettings = loadHostSettings(opts.hostWorkspaceRoot);
    writeArmPawConfig({
      workspaceRoot: wt.root,
      repositoryId,
      memoryEnable: memoryOn,
      hostSettings,
    });

    let recalled = false;
    if (memoryOn) {
      if (!opts.history) {
        throw new Error("on arm requires history instance for seed");
      }
      const seeded = await seedHistoryMemory(
        wt.root,
        opts.history,
        opts.probe.patch,
      );
      recalled = await preflightRecall(
        wt.root,
        opts.probe.problem_statement,
        seeded.seedId,
      );
    }

    const events: RunEventEnvelope[] = [];
    const budget = resolveLifecycleBudget({
      maxSteps: opts.maxSteps,
      timeoutMs: opts.timeoutMs,
    });
    const budgetAbort = createBudgetAbort(budget.timeoutMs);
    // Coding eval: single long-run agent (edit→test→fix), not 狸花调度
    const { orch, rootMaxSteps } = createRunOrchestrator({
      workspaceRoot: wt.root,
      autonomy: "headless",
      budget,
      // The evaluator only needs terminal/model/tool events for metrics.
      // Retaining cumulative streaming snapshots makes long runs consume
      // memory quadratically without changing any score.
      onEvent: (e) => {
        if (
          e.event.type !== "model.chunk" &&
          e.event.type !== "model.thinking"
        ) {
          events.push(e);
        }
      },
      memoryExtraction: "off",
      collaborationMode: "coding",
    });

    const t0 = Date.now();
    let runStatus = "unknown";
    let failureReason: string | null = null;
    let runOutcome: string | undefined;
    let completionReason: string | undefined;
    let evidenceFiles = 0;
    let evidenceTestsPassed = 0;
    try {
      const result = await orch.run({
        runId: armRunId,
        goal: buildSweAgentGoal(opts.probe),
        initialAcceptanceCriteria: buildSweAcceptanceCriteria(opts.probe),
        workspaceRoot: wt.root,
        maxSteps: budget.maxSteps || rootMaxSteps || 32,
        abortSignal: budgetAbort.signal,
        conversationId: `${repositoryId}-session`,
      });
      runStatus = result.status;
      runOutcome = result.outcome;
      completionReason = result.completionReason;
      evidenceFiles = result.evidence?.filesChanged.length ?? 0;
      evidenceTestsPassed =
        result.evidence?.testResults.filter((t) => t.passed).length ?? 0;
      if (
        result.status === "failed" ||
        result.status === "aborted" ||
        result.status === "incomplete"
      ) {
        failureReason = result.message ?? result.status;
      }
    } catch (e) {
      runStatus = "error";
      failureReason = e instanceof Error ? e.message : String(e);
    } finally {
      budgetAbort.clear();
    }

    const metrics = collectMetrics(events);
    if (memoryOn && recalled) metrics.recalled = true;
    const patch = gitDiff(wt.root);
    const durationMs = metrics.durationMs || Date.now() - t0;

    const result: SweExpArmResultExtended = {
      memoryOn,
      resolved: false, // filled by harness eval later
      resolvedSource: opts.skipEval ? "none" : "none",
      patch,
      patchChars: patch.length,
      steps: metrics.steps,
      durationMs,
      modelCalls: metrics.modelCalls,
      totalTokens: metrics.totalTokens,
      promptTokens: metrics.promptTokens,
      completionTokens: metrics.completionTokens,
      recalled: memoryOn ? metrics.recalled || recalled : false,
      failureReason,
      runStatus,
      memoryNamespace: repositoryId,
      warnings: [
        ...(memoryOn && !recalled ? ["seed_not_recalled_preflight"] : []),
        ...(patch.trim() ? [] : ["empty_patch"]),
        ...(runStatus === "completed" && !patch.trim()
          ? ["fake_completed_empty_patch"]
          : []),
        ...(runStatus === "incomplete" ? ["incomplete_run"] : []),
        ...(runOutcome === "budget_exhausted" ? ["budget_exhausted"] : []),
        ...(evidenceFiles > 0 && evidenceTestsPassed === 0
          ? ["mutation_without_passing_tests"]
          : []),
        ...(metrics.shellPolicyErrors > 0
          ? [`shell_policy_errors:${metrics.shellPolicyErrors}`]
          : []),
        ...(metrics.codingPhaseErrors > 0
          ? [`coding_phase_errors:${metrics.codingPhaseErrors}`]
          : []),
        ...(metrics.editToolCalls === 0 ? ["no_edit_tool_calls"] : []),
        ...(completionReason ? [`completion:${completionReason}`] : []),
        ...(Object.keys(metrics.toolHistogram).length > 0
          ? [
              `tools:${Object.entries(metrics.toolHistogram)
                .map(([k, v]) => `${k}=${v}`)
                .sort()
                .join(",")}`,
            ]
          : []),
      ],
    };

    const armFailed =
      !!failureReason &&
      (runStatus === "error" ||
        runStatus === "failed" ||
        runStatus === "aborted" ||
        runStatus === "incomplete");
    const done: SweExpArmCheckpoint = {
      ...running,
      status: armFailed ? "failed" : "completed",
      finishedAt: new Date().toISOString(),
      result,
      ...(armFailed ? { error: failureReason ?? runStatus } : {}),
    };
    saveArmCheckpoint(opts.checkpointDir, opts.suiteRunId, done);
    return done;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const failed: SweExpArmCheckpoint = {
      ...running,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: msg,
      result: {
        memoryOn,
        resolved: false,
        resolvedSource: "error",
        failureReason: msg,
        warnings: [msg],
        memoryNamespace: repositoryId,
      },
    };
    saveArmCheckpoint(opts.checkpointDir, opts.suiteRunId, failed);
    return failed;
  } finally {
    if (!opts.keep && cleanup) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
  }
}

/** 从宿主 settings 路径探测（测试用） */
export function readHostSettingsPath(hostRoot: string): string | null {
  const p = defaultSettingsPath(hostRoot);
  return existsSync(p) ? p : null;
}

export function readJsonIfExists<T>(p: string): T | null {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as T;
}
