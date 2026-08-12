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
  readonly patchSource?: "workspace" | "claude_trace_git_diff" | "none";
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
    // --tools accepts a variadic list. Keep another flag after the value so
    // the final positional goal cannot be consumed as an additional tool.
    "--tools",
    "Read,Edit,Write,Bash,Glob,Grep",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
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

export interface ClaudeJsonResult {
  readonly type?: string;
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

function sanitizeClaudeTraceEvent(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const event = value as Record<string, unknown>;
  if (event.type === "system" && event.subtype === "thinking_tokens")
    return null;
  if (event.type !== "assistant") return event;
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return event;
  }
  const record = message as Record<string, unknown>;
  const content = Array.isArray(record.content)
    ? record.content.filter(
        (block) =>
          !block ||
          typeof block !== "object" ||
          Array.isArray(block) ||
          (block as Record<string, unknown>).type !== "thinking",
      )
    : record.content;
  if (Array.isArray(content) && content.length === 0) return null;
  return { ...event, message: { ...record, content } };
}

export function parseClaudeStream(stdout: string): {
  readonly result: ClaudeJsonResult;
  readonly trace: readonly unknown[];
} {
  const parsed: unknown[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    parsed.push(JSON.parse(line) as unknown);
  }
  const result = [...parsed]
    .reverse()
    .find(
      (item): item is ClaudeJsonResult =>
        !!item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as ClaudeJsonResult).type === "result",
    );
  if (!result)
    throw new Error("Claude Code stream has no terminal result event");
  return {
    result,
    trace: parsed
      .map(sanitizeClaudeTraceEvent)
      .filter((item): item is unknown => item !== null),
  };
}

export function extractClaudePatchFromTrace(
  trace: readonly unknown[],
): string | undefined {
  const diffToolIds = new Set<string>();
  let patch: string | undefined;
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const event = item as Record<string, unknown>;
    const message = event.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      if (
        !rawBlock ||
        typeof rawBlock !== "object" ||
        Array.isArray(rawBlock)
      ) {
        continue;
      }
      const block = rawBlock as Record<string, unknown>;
      if (block.type === "tool_use" && block.name === "Bash") {
        const input = block.input;
        const command =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>).command
            : undefined;
        if (
          typeof block.id === "string" &&
          typeof command === "string" &&
          /^\s*git\s+diff(?:\s|$)/i.test(command)
        ) {
          diffToolIds.add(block.id);
        }
      }
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        diffToolIds.has(block.tool_use_id) &&
        typeof block.content === "string" &&
        block.content.trimStart().startsWith("diff --git ")
      ) {
        patch = block.content.trim();
      }
    }
  }
  return patch;
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
  recoveredPatch?: string;
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
  let trace: readonly unknown[] = [];
  try {
    const stream = parseClaudeStream(stdout);
    parsed = stream.result;
    trace = stream.trace;
  } catch {
    return {
      status: "failed",
      error: `Claude Code returned invalid JSON (exit ${exitCode}): ${stderr.slice(0, 1000)}`,
      // stdout may contain reasoning blocks before a malformed line. Never
      // persist it on parser failure; stderr is sufficient for infra triage.
      trace: { stderr: stderr.slice(0, 10_000) },
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
    ...(extractClaudePatchFromTrace(trace)
      ? { recoveredPatch: extractClaudePatchFromTrace(trace) }
      : {}),
    trace,
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
    const workspacePatch = gitDiff(workspace.root);
    const recoveredPatch =
      "recoveredPatch" in execution ? (execution.recoveredPatch ?? "") : "";
    const patch = workspacePatch || recoveredPatch;
    const patchSource = workspacePatch
      ? "workspace"
      : recoveredPatch
        ? "claude_trace_git_diff"
        : "none";
    const tracePath = path.join(
      "benchmarks",
      "swe-compare",
      "runs",
      runId,
      "trace.json",
    );
    writeJsonAtomic(path.join(opts.repoRoot, tracePath), execution.trace);
    const {
      trace: _trace,
      recoveredPatch: _recoveredPatch,
      ...executionSummary
    } = execution;
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
      patchSource,
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

/** Recover an empty Claude result from its persisted, paired `git diff` tool event. */
export function recoverClaudeResultPatch(opts: {
  readonly repoRoot: string;
  readonly resultPath: string;
}): SweCompareRunResult {
  const previous = JSON.parse(
    readFileSync(opts.resultPath, "utf8"),
  ) as SweCompareRunResult;
  if (previous.runner !== "claude") {
    throw new Error(
      `patch recovery only supports Claude results: ${previous.runId}`,
    );
  }
  if (previous.patch.trim()) {
    throw new Error(`result already contains a patch: ${previous.runId}`);
  }
  const tracePath = path.join(opts.repoRoot, previous.tracePath);
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as unknown[];
  const patch = extractClaudePatchFromTrace(trace);
  if (!patch) {
    throw new Error(`no paired git diff result in trace: ${previous.runId}`);
  }
  const updated: SweCompareRunResult = {
    ...previous,
    patch,
    patchChars: patch.length,
    patchSource: "claude_trace_git_diff",
  };
  writeJsonAtomic(opts.resultPath, updated);
  return updated;
}

/** Run the official verifier against an already persisted patch, without resampling. */
export function verifySweCompareResult(opts: {
  readonly repoRoot: string;
  readonly resultPath: string;
  readonly timeoutSec?: number;
}): SweCompareRunResult {
  const previous = JSON.parse(
    readFileSync(opts.resultPath, "utf8"),
  ) as SweCompareRunResult;
  if (!previous.patch.trim()) {
    throw new Error(`cannot verify empty patch: ${previous.runId}`);
  }
  const predictionPath = path.join(
    path.dirname(opts.resultPath),
    "prediction.jsonl",
  );
  writePredictionsJsonl(predictionPath, [
    {
      instance_id: previous.instanceId,
      model_name_or_path: `swe-compare-${previous.runner}`,
      model_patch: previous.patch,
    },
  ]);
  const checked = runSwebenchHarness({
    predictionsPath: predictionPath,
    instanceIds: [previous.instanceId],
    runId: previous.runId,
    maxWorkers: 1,
    timeoutSec: opts.timeoutSec ?? 1800,
    cwd: opts.repoRoot,
  });
  const updated: SweCompareRunResult = {
    ...previous,
    resolved: checked.resolved,
    resolvedSource: checked.source,
    verifier: {
      ...(checked.reportPath ? { reportPath: checked.reportPath } : {}),
      ...(checked.detail ? { detail: checked.detail } : {}),
      ...(checked.error ? { error: checked.error } : {}),
    },
  };
  writeJsonAtomic(opts.resultPath, updated);
  return updated;
}
