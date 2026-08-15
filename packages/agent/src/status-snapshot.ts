import type { AgentToolCallAction } from "@paw/core";
import type { ToolRunResult } from "@paw/harness";
import { toolCallDedupKey } from "./parse-agent-action.js";
import {
  type TaskState,
  latestSubstantiveVerification,
  verificationOutcome,
} from "./task-state.js";

export const STATUS_SNAPSHOT_SCHEMA_V1 = "paw.status-snapshot.v1" as const;
export const STATUS_SNAPSHOT_PREFIX = "[Status Snapshot v1]" as const;

export type StatusPaceV1 =
  | "investigate"
  | "implement"
  | "verify"
  | "repair"
  | "stabilize_environment"
  | "inspect_diff"
  | "finish"
  | "change_hypothesis";

export interface StatusEnvironmentV1 {
  readonly cwd: string;
  readonly platform: string;
  readonly arch: string;
  readonly shell: string;
  readonly node: string;
  readonly bun: string;
  /** Python is intentionally not guessed. ExecutionEnvironmentRegistry owns probing. */
  readonly python: "unprobed";
}

export interface StatusSnapshotV1 {
  readonly schemaVersion: typeof STATUS_SNAPSHOT_SCHEMA_V1;
  readonly authority: "advisory_only";
  readonly completionAuthority: "CompletionPolicy";
  readonly runId: string;
  readonly turn: number;
  readonly maxSteps: number;
  readonly elapsedMs: number;
  readonly pace: StatusPaceV1;
  readonly advice: string;
  readonly tools: {
    readonly calls: number;
    readonly failures: number;
    readonly consecutiveFailures: number;
    readonly consecutiveExactRepeats: number;
  };
  readonly lastTool?: {
    readonly tool: string;
    readonly ok: boolean;
    readonly durationMs: number;
    readonly timedOut: boolean;
  };
  readonly environment: StatusEnvironmentV1;
  /** A later registry will replace this honest unknown with durable job state. */
  readonly backgroundJobs: "untracked";
}

export interface RunStatusTelemetryOptionsV1 {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly startedAt?: number;
  readonly environment?: StatusEnvironmentV1;
}

const PACE_ADVICE: Readonly<Record<StatusPaceV1, string>> = Object.freeze({
  investigate:
    "Gather the minimum missing evidence, then choose a concrete change.",
  implement:
    "Make the smallest coherent implementation that advances the task.",
  verify: "Run verification against the current source revision.",
  repair: "Use the latest failing evidence to repair the implementation.",
  stabilize_environment:
    "Repair the test harness or environment before changing product code.",
  inspect_diff:
    "Inspect the current diff and confirm scope before proposing completion.",
  finish:
    "Evidence is current; summarize only facts supported by the host state.",
  change_hypothesis:
    "Stop repeating the same action; form and test a different hypothesis.",
});

function runtimeEnvironment(workspaceRoot: string): StatusEnvironmentV1 {
  const bunVersion =
    typeof Bun !== "undefined" && typeof Bun.version === "string"
      ? Bun.version
      : "unavailable";
  return Object.freeze({
    cwd: workspaceRoot,
    platform: process.platform,
    arch: process.arch,
    shell: process.env.ComSpec ?? process.env.SHELL ?? "unknown",
    node: process.version,
    bun: bunVersion,
    python: "unprobed" as const,
  });
}

function resultTimedOut(result: ToolRunResult): boolean {
  const payload =
    result.payload && typeof result.payload === "object"
      ? (result.payload as Record<string, unknown>)
      : undefined;
  const code = typeof payload?.code === "string" ? payload.code : "";
  const message = typeof payload?.message === "string" ? payload.message : "";
  return (
    /(?:TIMEOUT|TIMED_OUT)/i.test(code) ||
    /(?:timed? out|timeout)/i.test(`${result.summary}\n${message}`)
  );
}

export function statusPaceV1(
  state: TaskState,
  consecutiveFailures: number,
  consecutiveExactRepeats: number,
): StatusPaceV1 {
  if (consecutiveFailures >= 3 || consecutiveExactRepeats >= 3) {
    return "change_hypothesis";
  }
  const mutationRevision = state.mutationRevision ?? 0;
  if (mutationRevision === 0) {
    return state.filesRead.length === 0 && state.commandsRun.length === 0
      ? "investigate"
      : "implement";
  }
  const latestCurrentTest = [...state.testResults]
    .reverse()
    .find((result) => (result.mutationRevision ?? 0) === mutationRevision);
  const substantive = latestSubstantiveVerification(state);
  if (substantive && verificationOutcome(substantive) === "code_failed") {
    return "repair";
  }
  if (!substantive && latestCurrentTest?.outcome === "harness_failed") {
    return "stabilize_environment";
  }
  if (!substantive?.passed) return "verify";
  if ((state.diffInspectedRevision ?? 0) < mutationRevision) {
    return "inspect_diff";
  }
  return "finish";
}

/** Host-owned facts and pace advice; never a policy or completion authority. */
export class RunStatusTelemetryV1 {
  private readonly startedAt: number;
  private readonly environment: StatusEnvironmentV1;
  private calls = 0;
  private failures = 0;
  private consecutiveFailures = 0;
  private consecutiveExactRepeats = 0;
  private lastCallKey: string | undefined;
  private lastTool: StatusSnapshotV1["lastTool"];

  constructor(private readonly options: RunStatusTelemetryOptionsV1) {
    this.startedAt = options.startedAt ?? Date.now();
    this.environment = Object.freeze(
      options.environment ?? runtimeEnvironment(options.workspaceRoot),
    );
  }

  observeToolBatch(
    calls: readonly AgentToolCallAction[],
    results: readonly ToolRunResult[],
    batchDurationMs: number,
  ): void {
    const perCallDuration =
      calls.length > 0
        ? Math.max(0, Math.round(batchDurationMs / calls.length))
        : 0;
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index];
      const result = results[index];
      if (!call || !result) continue;
      const callKey = toolCallDedupKey(call.tool, call.args);
      this.consecutiveExactRepeats =
        callKey === this.lastCallKey ? this.consecutiveExactRepeats + 1 : 1;
      this.lastCallKey = callKey;
      this.calls += 1;
      if (result.ok) {
        this.consecutiveFailures = 0;
      } else {
        this.failures += 1;
        this.consecutiveFailures += 1;
      }
      this.lastTool = Object.freeze({
        tool: call.tool,
        ok: result.ok,
        durationMs: perCallDuration,
        timedOut: resultTimedOut(result),
      });
    }
  }

  snapshot(
    turn: number,
    maxSteps: number,
    taskState: TaskState,
    now = Date.now(),
  ): StatusSnapshotV1 {
    const pace = statusPaceV1(
      taskState,
      this.consecutiveFailures,
      this.consecutiveExactRepeats,
    );
    return Object.freeze({
      schemaVersion: STATUS_SNAPSHOT_SCHEMA_V1,
      authority: "advisory_only" as const,
      completionAuthority: "CompletionPolicy" as const,
      runId: this.options.runId,
      turn,
      maxSteps,
      elapsedMs: Math.max(0, now - this.startedAt),
      pace,
      advice: PACE_ADVICE[pace],
      tools: Object.freeze({
        calls: this.calls,
        failures: this.failures,
        consecutiveFailures: this.consecutiveFailures,
        consecutiveExactRepeats: this.consecutiveExactRepeats,
      }),
      ...(this.lastTool ? { lastTool: this.lastTool } : {}),
      environment: this.environment,
      backgroundJobs: "untracked" as const,
    });
  }
}

export function formatStatusSnapshotV1(snapshot: StatusSnapshotV1): string {
  const lastTool = snapshot.lastTool
    ? `${snapshot.lastTool.tool} ok=${snapshot.lastTool.ok} duration_ms=${snapshot.lastTool.durationMs} timed_out=${snapshot.lastTool.timedOut}`
    : "none";
  return [
    STATUS_SNAPSHOT_PREFIX,
    `schema=${snapshot.schemaVersion} authority=${snapshot.authority} completion_authority=${snapshot.completionAuthority}`,
    `run=${snapshot.runId} turn=${snapshot.turn + 1}/${snapshot.maxSteps} elapsed_ms=${snapshot.elapsedMs}`,
    `pace=${snapshot.pace} advice=${snapshot.advice}`,
    `tools calls=${snapshot.tools.calls} failures=${snapshot.tools.failures} consecutive_failures=${snapshot.tools.consecutiveFailures} consecutive_exact_repeats=${snapshot.tools.consecutiveExactRepeats}`,
    `last_tool=${lastTool}`,
    `environment cwd=${snapshot.environment.cwd} platform=${snapshot.environment.platform}/${snapshot.environment.arch} shell=${snapshot.environment.shell} node=${snapshot.environment.node} bun=${snapshot.environment.bun} python=${snapshot.environment.python}`,
    `background_jobs=${snapshot.backgroundJobs}`,
  ].join("\n");
}
