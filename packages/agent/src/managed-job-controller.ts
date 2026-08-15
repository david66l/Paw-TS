import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { AgentToolCallAction } from "@paw/core";
import {
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

export class ManagedJobControllerV1 {
  readonly registry: ManagedJobRegistryV1;
  private readonly detachController: () => void;
  private readonly settlements: ManagedShellSettlementV1[] = [];

  constructor(
    private readonly options: {
      readonly ownerId: string;
      readonly workspaceRoot: string;
      readonly shellSandbox?: ShellSandboxConfig;
      readonly toolExecutionPolicy?: ToolExecutionPolicy;
      readonly toolEffectPolicy?: ToolEffectPolicy;
      readonly maxConcurrentJobs?: number;
    },
  ) {
    this.registry = new ManagedJobRegistryV1({
      maxConcurrentJobsPerOwner: options.maxConcurrentJobs ?? 4,
    });
    this.detachController = this.registry.attachController(options.ownerId);
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
    return this.registry.list(this.options.ownerId);
  }

  read(id: string): ManagedJobReadV1 {
    return this.registry.read(this.options.ownerId, id);
  }

  wait(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ManagedJobWaitV1> {
    return this.registry.wait(this.options.ownerId, id, timeoutMs, signal);
  }

  kill(id: string, reason?: string): "requested" | "already_finished" {
    return this.registry.kill(this.options.ownerId, id, reason);
  }

  drainSettlements(input: {
    readonly taskState: TaskStateManager;
    readonly executionEnvironment: ExecutionEnvironmentRegistryV1;
  }): readonly ManagedShellSettlementV1[] {
    const drained = this.settlements.splice(0, this.settlements.length);
    for (const settlement of drained) {
      input.taskState.recordToolResult(settlement.call, settlement.result);
      input.executionEnvironment.observeToolResult(
        settlement.turn,
        settlement.call,
        settlement.result,
      );
    }
    return Object.freeze(drained);
  }

  async close(timeoutMs = 5_000): Promise<void> {
    this.detachController();
    await this.registry.close(timeoutMs);
  }
}
