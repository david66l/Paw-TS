import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  createBudgetAbort,
  createRunOrchestrator,
  resolveLifecycleBudget,
} from "@paw/agent";
import type { RunEventEnvelope } from "@paw/core";
import { createDefaultLanguageModel } from "@paw/models";

import { writeJsonAtomic } from "../swe-exp/checkpoint.js";
import { loadLiteInstances } from "../swe-exp/dataset.js";
import {
  runSwebenchHarness,
  writePredictionsJsonl,
} from "../swe-exp/evaluate.js";
import {
  createCommitWorktree,
  ensureRepoClone,
  gitDiff,
  writeArmPawConfig,
} from "../swe-exp/repo-cache.js";
import { buildSweCompareGoal } from "./goal.js";
import type { SweCompareManifest } from "./types.js";

export type SweCompareRunnerName = "paw" | "claude";

export interface SweCompareRunResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly runner: SweCompareRunnerName;
  readonly instanceId: string;
  readonly sourceCommit: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: "completed" | "failed" | "timeout";
  readonly patch: string;
  readonly patchChars: number;
  readonly resolved: boolean;
  readonly resolvedSource: "swebench_harness" | "none" | "error";
  readonly modelCalls?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly turns?: number;
  readonly terminalReason?: string;
  readonly error?: string;
  readonly tracePath: string;
  readonly verifier?: {
    readonly reportPath?: string;
    readonly detail?: string;
    readonly error?: string;
  };
}

export function claudeCodeArgs(goal: string): string[] {
  return [
    "-p",
    "--bare",
    "--model",
    "deepseek-v4-flash[1m]",
    "--effort",
    "max",
    "--autocompact",
    "1m",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
    "--tools",
    "Read,Edit,Write,Bash,Glob,Grep",
    goal,
  ];
}

function currentCommit(repoRoot: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function currentDirty(repoRoot: string): boolean {
  const result = Bun.spawnSync(["git", "status", "--porcelain"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).trim().length > 0;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateCompareRun(
  repoRoot: string,
  manifest: SweCompareManifest,
  instanceId: string,
): void {
  if (manifest.sourceTree.gitDirty) {
    throw new Error("compare manifest was created from a dirty source tree");
  }
  if (currentDirty(repoRoot)) {
    throw new Error("current source tree is dirty; commit before comparison");
  }
  const commit = currentCommit(repoRoot);
  if (manifest.sourceTree.gitCommit !== commit) {
    throw new Error(
      `compare manifest commit mismatch: manifest=${manifest.sourceTree.gitCommit} current=${commit}`,
    );
  }
  const instance = manifest.instances.find(
    (item) => item.instanceId === instanceId,
  );
  if (!instance)
    throw new Error(`instance not frozen in manifest: ${instanceId}`);
  if (
    instance.qualification !== "eligible" ||
    instance.preflight?.completed !== true
  ) {
    throw new Error(`instance is not preflight eligible: ${instanceId}`);
  }
  const datasetPath = path.join(repoRoot, manifest.dataset.localPath);
  const dataset = readFileSync(datasetPath);
  if (sha256(dataset) !== manifest.dataset.sha256) {
    throw new Error("compare dataset SHA-256 mismatch");
  }
  const probe = loadLiteInstances(datasetPath).find(
    (item) => item.instance_id === instanceId,
  );
  if (!probe) throw new Error(`dataset instance missing: ${instanceId}`);
  if (sha256(probe.problem_statement) !== instance.problemStatementSha256) {
    throw new Error(`problem statement hash mismatch: ${instanceId}`);
  }
  if (sha256(buildSweCompareGoal(probe)) !== instance.goalSha256) {
    throw new Error(`goal hash mismatch: ${instanceId}`);
  }
  const runtimeProfile = createDefaultLanguageModel(repoRoot).runtimeProfile;
  if (
    JSON.stringify(runtimeProfile) !==
    JSON.stringify(manifest.runners.paw.runtimeProfile)
  ) {
    throw new Error(
      `Paw runtime profile drift: manifest=${JSON.stringify(manifest.runners.paw.runtimeProfile)} current=${JSON.stringify(runtimeProfile)}`,
    );
  }
}

function collectPawMetrics(events: readonly RunEventEnvelope[]): {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
} {
  let modelCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let turns = 0;
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "model.done") {
      modelCalls += 1;
      promptTokens += event.usage?.promptTokens ?? 0;
      completionTokens += event.usage?.completionTokens ?? 0;
      totalTokens += event.usage?.totalTokens ?? 0;
    } else if (event.type === "loop.tick") {
      turns = Math.max(turns, event.turn);
    }
  }
  return { modelCalls, promptTokens, completionTokens, totalTokens, turns };
}

async function runPaw(opts: {
  readonly repoRoot: string;
  readonly workspaceRoot: string;
  readonly goal: string;
  readonly runId: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
}): Promise<{
  status: "completed" | "failed" | "timeout";
  terminalReason?: string;
  error?: string;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
  trace: readonly RunEventEnvelope[];
}> {
  writeArmPawConfig({
    workspaceRoot: opts.workspaceRoot,
    repositoryId: `swe-compare-${opts.runId}`,
    memoryEnable: false,
    hostSettings: JSON.parse(
      readFileSync(
        path.join(opts.repoRoot, ".paw", "settings.local.json"),
        "utf8",
      ),
    ) as Record<string, unknown>,
  });
  const events: RunEventEnvelope[] = [];
  const budget = resolveLifecycleBudget({
    maxSteps: opts.maxSteps,
    timeoutMs: opts.timeoutMs,
  });
  const abort = createBudgetAbort(opts.timeoutMs);
  const { orch } = createRunOrchestrator({
    workspaceRoot: opts.workspaceRoot,
    autonomy: "headless",
    budget,
    memoryExtraction: "off",
    collaborationMode: "coding",
    onEvent: (event) => {
      if (
        event.event.type !== "model.chunk" &&
        event.event.type !== "model.thinking"
      ) {
        events.push(event);
      }
    },
  });
  try {
    const result = await orch.run({
      runId: opts.runId,
      goal: opts.goal,
      workspaceRoot: opts.workspaceRoot,
      maxSteps: opts.maxSteps,
      abortSignal: abort.signal,
      conversationId: `${opts.runId}-session`,
    });
    const metrics = collectPawMetrics(events);
    const timeout = abort.signal.aborted;
    return {
      status: timeout
        ? "timeout"
        : result.status === "completed"
          ? "completed"
          : "failed",
      terminalReason: result.completionReason ?? result.outcome,
      ...(result.status === "completed" ? {} : { error: result.message }),
      ...metrics,
      trace: events,
    };
  } catch (error) {
    return {
      status: abort.signal.aborted ? "timeout" : "failed",
      error: error instanceof Error ? error.message : String(error),
      ...collectPawMetrics(events),
      trace: events,
    };
  } finally {
    abort.clear();
  }
}

interface ClaudeJsonResult {
  readonly is_error?: boolean;
  readonly num_turns?: number;
  readonly terminal_reason?: string;
  readonly result?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
}

async function runClaude(opts: {
  readonly workspaceRoot: string;
  readonly goal: string;
  readonly timeoutMs: number;
}): Promise<{
  status: "completed" | "failed" | "timeout";
  terminalReason?: string;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  turns?: number;
  trace: unknown;
}> {
  const executable = process.platform === "win32" ? "claude.cmd" : "claude";
  const child = Bun.spawn([executable, ...claudeCodeArgs(opts.goal)], {
    cwd: opts.workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, opts.timeoutMs);
  timer.unref?.();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (timedOut)
    return {
      status: "timeout",
      error: "Claude Code timed out",
      trace: { stderr: stderr.slice(0, 10_000) },
    };
  let parsed: ClaudeJsonResult | undefined;
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonResult;
  } catch {
    return {
      status: "failed",
      error: `Claude Code returned invalid JSON (exit ${exitCode}): ${stderr.slice(0, 1000)}`,
      trace: { stdout, stderr: stderr.slice(0, 10_000) },
    };
  }
  const input = parsed.usage?.input_tokens ?? 0;
  const output = parsed.usage?.output_tokens ?? 0;
  const cache =
    (parsed.usage?.cache_read_input_tokens ?? 0) +
    (parsed.usage?.cache_creation_input_tokens ?? 0);
  return {
    status: exitCode === 0 && parsed.is_error !== true ? "completed" : "failed",
    terminalReason: parsed.terminal_reason,
    ...(exitCode === 0 && parsed.is_error !== true
      ? {}
      : { error: parsed.result ?? stderr.slice(0, 1000) }),
    promptTokens: input + cache,
    completionTokens: output,
    totalTokens: input + cache + output,
    turns: parsed.num_turns,
    trace: parsed,
  };
}

export async function runSweCompareArm(opts: {
  readonly repoRoot: string;
  readonly manifestPath: string;
  readonly instanceId: string;
  readonly runner: SweCompareRunnerName;
  readonly keep?: boolean;
  readonly skipVerifier?: boolean;
}): Promise<SweCompareRunResult> {
  const manifest = JSON.parse(
    readFileSync(opts.manifestPath, "utf8"),
  ) as SweCompareManifest;
  validateCompareRun(opts.repoRoot, manifest, opts.instanceId);
  const datasetPath = path.join(opts.repoRoot, manifest.dataset.localPath);
  const probe = loadLiteInstances(datasetPath).find(
    (item) => item.instance_id === opts.instanceId,
  );
  if (!probe) throw new Error(`dataset instance missing: ${opts.instanceId}`);
  const goal = buildSweCompareGoal(probe);
  const runId = `${opts.runner}-${opts.instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now().toString(36)}`;
  const gitRoot = ensureRepoClone(
    probe.repo,
    path.join(opts.repoRoot, "benchmarks", "swe-exp"),
  );
  const workspace = createCommitWorktree(
    gitRoot,
    probe.base_commit,
    runId.slice(0, 60),
  );
  const started = new Date();
  try {
    const execution =
      opts.runner === "paw"
        ? await runPaw({
            repoRoot: opts.repoRoot,
            workspaceRoot: workspace.root,
            goal,
            runId,
            maxSteps: manifest.budget.pawMaxSteps,
            timeoutMs: manifest.budget.sharedTimeoutMs,
          })
        : await runClaude({
            workspaceRoot: workspace.root,
            goal,
            timeoutMs: manifest.budget.sharedTimeoutMs,
          });
    const patch = gitDiff(workspace.root);
    const tracePath = path.join(
      "benchmarks",
      "swe-compare",
      "runs",
      runId,
      "trace.json",
    );
    writeJsonAtomic(path.join(opts.repoRoot, tracePath), execution.trace);
    const { trace: _trace, ...executionSummary } = execution;
    let resolved = false;
    let resolvedSource: "swebench_harness" | "none" | "error" = "none";
    let verifier: SweCompareRunResult["verifier"];
    if (!opts.skipVerifier && patch.trim()) {
      const predictionPath = path.join(
        opts.repoRoot,
        "benchmarks",
        "swe-compare",
        "runs",
        runId,
        "prediction.jsonl",
      );
      writePredictionsJsonl(predictionPath, [
        {
          instance_id: opts.instanceId,
          model_name_or_path: `swe-compare-${opts.runner}`,
          model_patch: patch,
        },
      ]);
      const checked = runSwebenchHarness({
        predictionsPath: predictionPath,
        instanceIds: [opts.instanceId],
        runId,
        maxWorkers: 1,
        timeoutSec: Math.max(
          600,
          Math.floor(manifest.budget.sharedTimeoutMs / 1000),
        ),
        cwd: opts.repoRoot,
      });
      resolved = checked.resolved;
      resolvedSource = checked.source;
      verifier = {
        ...(checked.reportPath ? { reportPath: checked.reportPath } : {}),
        ...(checked.detail ? { detail: checked.detail } : {}),
        ...(checked.error ? { error: checked.error } : {}),
      };
    }
    const finished = new Date();
    const result: SweCompareRunResult = {
      schemaVersion: 1,
      runId,
      runner: opts.runner,
      instanceId: opts.instanceId,
      sourceCommit: manifest.sourceTree.gitCommit,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      ...executionSummary,
      patch,
      patchChars: patch.length,
      resolved,
      resolvedSource,
      tracePath: tracePath.replace(/\\/g, "/"),
      ...(verifier ? { verifier } : {}),
    };
    writeJsonAtomic(
      path.join(
        opts.repoRoot,
        "benchmarks",
        "swe-compare",
        "runs",
        runId,
        "result.json",
      ),
      result,
    );
    return result;
  } finally {
    if (!opts.keep) workspace.cleanup();
  }
}
