import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { AgentToolCallAction } from "@paw/core";
import {
  MANAGED_JOB_SCHEMA_V1,
  type ManagedJobReadV1,
  ManagedJobRegistryV1,
  type ManagedJobSnapshotV1,
  type ManagedJobWaitV1,
  type ShellSandboxConfig,
  type ToolRunResult,
  startManagedShellInWorkspaceV1,
} from "@paw/harness";

import type { ExecutionEnvironmentRegistryV1 } from "./execution-environment.js";
import type {
  ToolEffectPolicy,
  ToolExecutionPolicy,
} from "./execution-policy.js";
import type { TaskStateManager } from "./task-state.js";

export const MANAGED_JOB_CONTROLLER_SCHEMA_V1 =
  "paw.managed-job-controller.v1" as const;
export const MANAGED_JOB_PROJECTION_SCHEMA_V1 =
  "paw.managed-job-projection.v1" as const;

export interface ManagedJobProjectionEntryV1 {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly status: ManagedJobSnapshotV1["status"];
  readonly detail?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly reported: boolean;
  readonly settlementState?: "pending" | "committed";
}

export interface ManagedJobProjectionV1 {
  readonly schemaVersion: typeof MANAGED_JOB_PROJECTION_SCHEMA_V1;
  readonly runId: string;
  readonly jobs: readonly ManagedJobProjectionEntryV1[];
  readonly savedAt: number;
}

interface GitEffectSnapshotV1 {
  readonly available: boolean;
  readonly head?: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface ManagedShellSettlementV1 {
  readonly schemaVersion: typeof MANAGED_JOB_CONTROLLER_SCHEMA_V1;
  readonly jobId: string;
  readonly turn: number;
  readonly call: AgentToolCallAction;
  readonly result: ToolRunResult;
}

export interface ManagedShellStartResultV1 {
  readonly jobId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly status: "running";
}

export interface ManagedJobReadinessV1 {
  readonly managed: number;
  readonly running: number;
  readonly stopping: number;
  readonly pendingSettlements: number;
  readonly blocksCompletion: boolean;
}

function gitText(
  workspaceRoot: string,
  args: readonly string[],
): string | null {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  return new TextDecoder().decode(result.stdout).trim();
}

function hashWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
): string {
  const absolute = path.resolve(workspaceRoot, relativePath);
  if (!existsSync(absolute)) return "missing";
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return `non-file:${stat.size}:${stat.mtimeMs}`;
    if (stat.size > 8 * 1024 * 1024) {
      return `large:${stat.size}:${stat.mtimeMs}`;
    }
    return createHash("sha256").update(readFileSync(absolute)).digest("hex");
  } catch (error) {
    return `unreadable:${String(error)}`;
  }
}

function captureGitEffectV1(workspaceRoot: string): GitEffectSnapshotV1 {
  const head = gitText(workspaceRoot, ["rev-parse", "HEAD"]);
  const listed = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "-z",
      "--modified",
      "--deleted",
      "--others",
      "--exclude-standard",
    ],
    { cwd: workspaceRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (head === null || listed.exitCode !== 0) {
    return Object.freeze({ available: false, files: new Map() });
  }
  const paths = new TextDecoder()
    .decode(listed.stdout)
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
  return Object.freeze({
    available: true,
    head,
    files: new Map(
      paths.map((relativePath) => [
        relativePath,
        hashWorkspacePath(workspaceRoot, relativePath),
      ]),
    ),
  });
}

function effectDeltaV1(
  before: GitEffectSnapshotV1,
  after: GitEffectSnapshotV1,
): { readonly available: boolean; readonly paths: readonly string[] } {
  if (!before.available || !after.available) {
    return { available: false, paths: [] };
  }
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  const changed = [...paths].filter(
    (file) => before.files.get(file) !== after.files.get(file),
  );
  if (before.head !== after.head) changed.push(".git/HEAD");
  return {
    available: true,
    paths: Object.freeze([...new Set(changed)].sort()),
  };
}

const PROJECTION_STATUSES = new Set([
  "running",
  "stopping",
  "completed",
  "killed",
  "failed",
  "interrupted_orphaned",
]);

export function parseManagedJobProjectionV1(
  value: unknown,
): ManagedJobProjectionV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid managed job projection");
  }
  const raw = value as Record<string, unknown>;
  if (
    raw.schemaVersion !== MANAGED_JOB_PROJECTION_SCHEMA_V1 ||
    typeof raw.runId !== "string" ||
    !raw.runId.trim() ||
    !Array.isArray(raw.jobs) ||
    typeof raw.savedAt !== "number" ||
    !Number.isFinite(raw.savedAt) ||
    raw.savedAt < 0
  ) {
    throw new Error("Invalid managed job projection schema");
  }
  const ids = new Set<string>();
  const jobs = raw.jobs.map((item, index): ManagedJobProjectionEntryV1 => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Invalid managed job projection entry ${index + 1}`);
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.kind !== "string" ||
      !row.kind ||
      typeof row.label !== "string" ||
      !row.label ||
      !PROJECTION_STATUSES.has(String(row.status)) ||
      typeof row.startedAt !== "number" ||
      !Number.isFinite(row.startedAt) ||
      row.startedAt < 0 ||
      typeof row.reported !== "boolean" ||
      (row.detail !== undefined && typeof row.detail !== "string") ||
      (row.finishedAt !== undefined &&
        (typeof row.finishedAt !== "number" ||
          !Number.isFinite(row.finishedAt) ||
          row.finishedAt < row.startedAt)) ||
      (row.settlementState !== undefined &&
        row.settlementState !== "pending" &&
        row.settlementState !== "committed") ||
      ((row.status === "running" || row.status === "stopping") &&
        row.settlementState !== undefined) ||
      (row.status !== "running" &&
        row.status !== "stopping" &&
        row.settlementState === undefined)
    ) {
      throw new Error(`Invalid managed job projection entry ${index + 1}`);
    }
    ids.add(row.id);
    return Object.freeze({
      id: row.id,
      kind: row.kind,
      label: row.label,
      status: row.status as ManagedJobSnapshotV1["status"],
      ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
      startedAt: row.startedAt,
      ...(typeof row.finishedAt === "number"
        ? { finishedAt: row.finishedAt }
        : {}),
      reported: row.reported,
      ...(row.settlementState === "pending" ||
      row.settlementState === "committed"
        ? { settlementState: row.settlementState }
        : {}),
    });
  });
  return Object.freeze({
    schemaVersion: MANAGED_JOB_PROJECTION_SCHEMA_V1,
    runId: raw.runId,
    jobs: Object.freeze(jobs),
    savedAt: raw.savedAt,
  });
}

function kindCounters(
  jobs: readonly ManagedJobProjectionEntryV1[],
): Readonly<Record<string, number>> {
  const counters: Record<string, number> = {};
  for (const job of jobs) {
    const match = job.id.match(/^(.+)-(\d+)$/);
    if (!match?.[2]) continue;
    const count = Number(match[2]);
    if (Number.isSafeInteger(count)) {
      counters[job.kind] = Math.max(counters[job.kind] ?? 0, count);
    }
  }
  return counters;
}

export class ManagedJobControllerV1 {
  readonly registry: ManagedJobRegistryV1;
  private readonly detachController: () => void;
  private readonly settlements: ManagedShellSettlementV1[] = [];
  private readonly recoveredJobs = new Map<string, ManagedJobSnapshotV1>();
  private readonly settlementStates = new Map<
    string,
    "pending" | "committed"
  >();
  private readonly recoveryNotices: string[] = [];

  constructor(
    private readonly options: {
      readonly ownerId: string;
      readonly workspaceRoot: string;
      readonly shellSandbox?: ShellSandboxConfig;
      readonly toolExecutionPolicy?: ToolExecutionPolicy;
      readonly toolEffectPolicy?: ToolEffectPolicy;
      readonly maxConcurrentJobs?: number;
      readonly resumeProjection?: unknown;
    },
  ) {
    const prior = parseManagedJobProjectionV1(options.resumeProjection);
    if (prior && prior.runId !== options.ownerId) {
      throw new Error("Managed job projection runId does not match ownerId");
    }
    this.registry = new ManagedJobRegistryV1({
      maxConcurrentJobsPerOwner: options.maxConcurrentJobs ?? 4,
      ...(prior ? { initialKindCounters: kindCounters(prior.jobs) } : {}),
    });
    this.detachController = this.registry.attachController(options.ownerId);
    for (const job of prior?.jobs ?? []) {
      const effectUnknown =
        job.status === "running" ||
        job.status === "stopping" ||
        job.settlementState === "pending";
      const status = effectUnknown ? "interrupted_orphaned" : job.status;
      const detail = effectUnknown
        ? "Paw stopped before this job's terminal effect was durably committed; the old PID was not reattached and its outcome is unknown."
        : job.detail;
      const snapshot: ManagedJobSnapshotV1 = Object.freeze({
        schemaVersion: MANAGED_JOB_SCHEMA_V1,
        id: job.id,
        ownerId: options.ownerId,
        kind: job.kind,
        label: job.label,
        status,
        ...(detail ? { detail } : {}),
        startedAt: job.startedAt,
        ...(status === "interrupted_orphaned"
          ? { finishedAt: Date.now() }
          : job.finishedAt !== undefined
            ? { finishedAt: job.finishedAt }
            : {}),
        reported: effectUnknown ? false : job.reported,
      });
      this.recoveredJobs.set(job.id, snapshot);
      if (effectUnknown) {
        this.settlementStates.set(job.id, "pending");
      } else if (job.settlementState) {
        this.settlementStates.set(job.id, job.settlementState);
      }
      if (effectUnknown) {
        this.recoveryNotices.push(
          `${job.id} (${job.label}) became interrupted_orphaned; no exit status, output, or workspace-effect conclusion was recovered.`,
        );
      }
    }
  }

  async startShell(input: {
    readonly turn: number;
    readonly command: string;
    readonly cwd?: string;
    readonly outputLimitBytes?: number;
    readonly terminationGraceMs?: number;
  }): Promise<ManagedShellStartResultV1> {
    const args = {
      command: input.command,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    };
    const call: AgentToolCallAction = {
      type: "tool_call",
      tool: "workspace.run_shell",
      args,
    };
    const policyInput = {
      tool: call.tool,
      args: call.args,
      workspaceRoot: this.options.workspaceRoot,
    };
    const executionDecision =
      await this.options.toolExecutionPolicy?.(policyInput);
    if (executionDecision && !executionDecision.allowed) {
      throw new Error(
        `[ToolExecutionPolicy:${executionDecision.reason}] ${executionDecision.message}`,
      );
    }
    const effectApplies = this.options.toolEffectPolicy
      ? (this.options.toolEffectPolicy.appliesTo?.(policyInput) ?? true)
      : false;
    const prepared = effectApplies
      ? await this.options.toolEffectPolicy?.prepare(policyInput)
      : undefined;
    const before = captureGitEffectV1(this.options.workspaceRoot);
    let producer: ReturnType<typeof startManagedShellInWorkspaceV1> | undefined;
    let jobId = "pending";
    jobId = this.registry.start({
      ownerId: this.options.ownerId,
      kind: "shell",
      label: input.command.slice(0, 200),
      ...(input.outputLimitBytes !== undefined
        ? { outputLimitBytes: input.outputLimitBytes }
        : {}),
      run: () => {
        producer = startManagedShellInWorkspaceV1(
          this.options.workspaceRoot,
          input.command,
          {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(this.options.shellSandbox
              ? { shellSandbox: this.options.shellSandbox }
              : {}),
            skipApprovalGate: true,
            ...(input.outputLimitBytes !== undefined
              ? { outputLimitBytes: input.outputLimitBytes }
              : {}),
            ...(input.terminationGraceMs !== undefined
              ? { terminationGraceMs: input.terminationGraceMs }
              : {}),
          },
        );
        const rawDone = producer.hooks.done;
        return {
          ...producer.hooks,
          done: rawDone.then(async (outcome) => {
            const after = captureGitEffectV1(this.options.workspaceRoot);
            const delta = effectDeltaV1(before, after);
            let result: ToolRunResult = {
              ok: outcome.status === "completed",
              summary: `managed shell ${jobId}: ${outcome.detail ?? outcome.status}`,
              payload: {
                managed_job_id: jobId,
                cwd: producer?.cwd,
                exit_code: outcome.status === "completed" ? 0 : undefined,
                effect_audit: delta.available ? "complete" : "unavailable",
                ...(delta.available
                  ? {
                      workspaceEffect: {
                        changed: delta.paths.length > 0,
                        paths: delta.paths,
                      },
                    }
                  : {}),
              },
            };
            if (effectApplies && this.options.toolEffectPolicy) {
              try {
                const decision = await this.options.toolEffectPolicy.settle(
                  { ...policyInput, result },
                  prepared,
                );
                if (!decision.allowed) {
                  result = {
                    ok: false,
                    summary: `[ToolEffectPolicy:${decision.reason}] ${decision.message}`,
                    payload: {
                      managed_job_id: jobId,
                      recovered: decision.recovered,
                    },
                  };
                } else if (decision.result) {
                  result = decision.result;
                }
              } catch (error) {
                result = {
                  ok: false,
                  summary: `[ToolEffectPolicy:settle_failed] ${String(error)}`,
                  payload: { managed_job_id: jobId },
                };
              }
            }
            this.settlements.push(
              Object.freeze({
                schemaVersion: MANAGED_JOB_CONTROLLER_SCHEMA_V1,
                jobId,
                turn: input.turn,
                call,
                result,
              }),
            );
            return result.ok
              ? outcome
              : {
                  status: "failed" as const,
                  detail: result.summary,
                };
          }),
        };
      },
    });
    if (!producer) throw new Error("managed shell producer did not start");
    return Object.freeze({
      jobId,
      pid: producer.pid,
      cwd: producer.cwd,
      status: "running",
    });
  }

  list(): readonly ManagedJobSnapshotV1[] {
    return Object.freeze([
      ...this.recoveredJobs.values(),
      ...this.registry.list(this.options.ownerId),
    ]);
  }

  read(id: string): ManagedJobReadV1 {
    const recovered = this.recoveredJobs.get(id);
    if (recovered) {
      const reported = Object.freeze({ ...recovered, reported: true });
      this.recoveredJobs.set(id, reported);
      return Object.freeze({
        text:
          reported.detail ??
          "Recovered terminal job metadata; process output is unavailable.",
        snapshot: reported,
      });
    }
    return this.registry.read(this.options.ownerId, id);
  }

  wait(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ManagedJobWaitV1> {
    const recovered = this.recoveredJobs.get(id);
    if (recovered) {
      const reported = Object.freeze({ ...recovered, reported: true });
      this.recoveredJobs.set(id, reported);
      return Promise.resolve(
        Object.freeze({ timedOut: false, snapshot: reported }),
      );
    }
    return this.registry.wait(this.options.ownerId, id, timeoutMs, signal);
  }

  kill(id: string, reason?: string): "requested" | "already_finished" {
    if (this.recoveredJobs.has(id)) return "already_finished";
    return this.registry.kill(this.options.ownerId, id, reason);
  }

  recoveryIssues(): readonly string[] {
    return this.recoveryNotices.length > 0
      ? Object.freeze(["managed_job_interrupted_orphaned"])
      : Object.freeze([]);
  }

  takeRecoveryNotices(): readonly string[] {
    return Object.freeze(
      this.recoveryNotices.splice(0, this.recoveryNotices.length),
    );
  }

  readiness(): ManagedJobReadinessV1 {
    const jobs = this.list();
    const running = jobs.filter((job) => job.status === "running").length;
    const stopping = jobs.filter((job) => job.status === "stopping").length;
    const pendingSettlements = this.settlements.length;
    return Object.freeze({
      managed: jobs.length,
      running,
      stopping,
      pendingSettlements,
      blocksCompletion: running + stopping + pendingSettlements > 0,
    });
  }

  takeSettlements(): readonly ManagedShellSettlementV1[] {
    const drained = this.settlements.splice(0, this.settlements.length);
    for (const item of drained)
      this.settlementStates.set(item.jobId, "pending");
    return Object.freeze(drained);
  }

  acknowledgeSettlements(jobIds: readonly string[]): void {
    for (const jobId of jobIds) this.settlementStates.set(jobId, "committed");
  }

  projection(): ManagedJobProjectionV1 {
    const pending = new Set(this.settlements.map((item) => item.jobId));
    return Object.freeze({
      schemaVersion: MANAGED_JOB_PROJECTION_SCHEMA_V1,
      runId: this.options.ownerId,
      jobs: Object.freeze(
        this.list().map((job) => {
          const terminal =
            job.status !== "running" && job.status !== "stopping";
          const settlementState = terminal
            ? pending.has(job.id)
              ? "pending"
              : this.settlementStates.get(job.id)
            : undefined;
          return Object.freeze({
            id: job.id,
            kind: job.kind,
            label: job.label,
            status: job.status,
            ...(job.detail ? { detail: job.detail } : {}),
            startedAt: job.startedAt,
            ...(job.finishedAt !== undefined
              ? { finishedAt: job.finishedAt }
              : {}),
            reported: job.reported,
            ...(settlementState ? { settlementState } : {}),
          });
        }),
      ),
      savedAt: Date.now(),
    });
  }

  drainSettlements(input: {
    readonly taskState: TaskStateManager;
    readonly executionEnvironment: ExecutionEnvironmentRegistryV1;
  }): readonly ManagedShellSettlementV1[] {
    const drained = this.takeSettlements();
    for (const settlement of drained) {
      input.taskState.recordToolResult(settlement.call, settlement.result);
      input.executionEnvironment.observeToolResult(
        settlement.turn,
        settlement.call,
        settlement.result,
      );
    }
    this.acknowledgeSettlements(drained.map((item) => item.jobId));
    return Object.freeze(drained);
  }

  async close(timeoutMs = 5_000): Promise<void> {
    this.detachController();
    await this.registry.close(timeoutMs);
  }
}
