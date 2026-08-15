import { spawnSync } from "node:child_process";
import path from "node:path";

import type { AgentToolCallAction } from "@paw/core";
import type { ShellSandboxConfig, ToolRunResult } from "@paw/harness";

export const EXECUTION_ENVIRONMENT_SCHEMA_V1 =
  "paw.execution-environment.v1" as const;

export interface ExecutionRuntimeV1 {
  readonly platform: string;
  readonly arch: string;
  readonly shell: string;
  readonly node: string;
  readonly bun: string;
  readonly python: string;
}

export interface ExecutionSandboxV1 {
  readonly mode: "off" | "workspace" | "strict";
  readonly network: "deny" | "full";
  readonly runtime?: string;
  readonly image?: string;
  readonly commandShell?: string;
}

export interface ShellExecutionObservedV1 {
  readonly seq: number;
  readonly type: "shell.completed";
  readonly turn: number;
  readonly command: string;
  readonly cwd: string;
  readonly timeoutSec: number | null;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly failureKind: "none" | "command" | "infrastructure" | "policy";
}

export interface ExecutionEnvironmentSnapshotV1 {
  readonly schemaVersion: typeof EXECUTION_ENVIRONMENT_SCHEMA_V1;
  readonly runId: string;
  readonly workspaceRoot: string;
  /** Paw run_shell starts a new child process for every call. */
  readonly shellPersistence: "fresh_process_per_call";
  readonly runtime: ExecutionRuntimeV1;
  readonly sandbox: ExecutionSandboxV1;
  readonly recovery: {
    readonly compatible: boolean;
    readonly issues: readonly string[];
  };
  readonly backgroundJobs: {
    readonly capability: "not_available" | "managed";
    readonly managed: number;
    readonly running: number;
    readonly stopping?: number;
    readonly pendingSettlements?: number;
  };
  readonly events: readonly ShellExecutionObservedV1[];
}

export interface ExecutionEnvironmentRegistryOptionsV1 {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly shellSandbox: ShellSandboxConfig;
  readonly resumeSnapshot?: unknown;
  readonly runtime?: ExecutionRuntimeV1;
  readonly backgroundJobs?: () => {
    readonly managed: number;
    readonly running: number;
    readonly stopping: number;
    readonly pendingSettlements: number;
  };
  readonly additionalRecoveryIssues?: readonly string[];
}

let cachedPythonVersion: string | undefined;

function probePythonVersion(): string {
  if (cachedPythonVersion !== undefined) return cachedPythonVersion;
  const candidates: readonly (readonly [string, readonly string[]])[] =
    process.platform === "win32"
      ? [
          ["python", ["--version"]],
          ["py", ["-3", "--version"]],
        ]
      : [
          ["python3", ["--version"]],
          ["python", ["--version"]],
        ];
  for (const [command, args] of candidates) {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      timeout: 1_000,
      windowsHide: true,
    });
    if (result.status === 0) {
      const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      if (version) {
        cachedPythonVersion = version.split(/\r?\n/, 1)[0] ?? "available";
        return cachedPythonVersion;
      }
    }
  }
  cachedPythonVersion = "unavailable";
  return cachedPythonVersion;
}

export function currentExecutionRuntimeV1(): ExecutionRuntimeV1 {
  return Object.freeze({
    platform: process.platform,
    arch: process.arch,
    shell: process.env.ComSpec ?? process.env.SHELL ?? "unknown",
    node: process.version,
    bun:
      typeof Bun !== "undefined" && typeof Bun.version === "string"
        ? Bun.version
        : "unavailable",
    python: probePythonVersion(),
  });
}

function sandboxSnapshot(config: ShellSandboxConfig): ExecutionSandboxV1 {
  return Object.freeze({
    mode: config.mode,
    network: config.network,
    ...(config.runtime ? { runtime: config.runtime } : {}),
    ...(config.image ? { image: config.image } : {}),
    ...(config.commandShell ? { commandShell: config.commandShell } : {}),
  });
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid execution environment ${label}`);
  }
}

function parseRuntime(value: unknown): ExecutionRuntimeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid execution environment runtime");
  }
  const runtime = value as Record<string, unknown>;
  const { platform, arch, shell, node, bun, python } = runtime;
  assertString(platform, "runtime.platform");
  assertString(arch, "runtime.arch");
  assertString(shell, "runtime.shell");
  assertString(node, "runtime.node");
  assertString(bun, "runtime.bun");
  assertString(python, "runtime.python");
  return Object.freeze({
    platform,
    arch,
    shell,
    node,
    bun,
    python,
  });
}

function parseSandbox(value: unknown): ExecutionSandboxV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid execution environment sandbox");
  }
  const sandbox = value as Record<string, unknown>;
  if (
    !["off", "workspace", "strict"].includes(String(sandbox.mode)) ||
    !["deny", "full"].includes(String(sandbox.network))
  ) {
    throw new Error("Invalid execution environment sandbox policy");
  }
  for (const key of ["runtime", "image", "commandShell"] as const) {
    if (sandbox[key] !== undefined && typeof sandbox[key] !== "string") {
      throw new Error(`Invalid execution environment sandbox.${key}`);
    }
  }
  return Object.freeze({
    mode: sandbox.mode as ExecutionSandboxV1["mode"],
    network: sandbox.network as ExecutionSandboxV1["network"],
    ...(typeof sandbox.runtime === "string"
      ? { runtime: sandbox.runtime }
      : {}),
    ...(typeof sandbox.image === "string" ? { image: sandbox.image } : {}),
    ...(typeof sandbox.commandShell === "string"
      ? { commandShell: sandbox.commandShell }
      : {}),
  });
}

function parseEvent(value: unknown, index: number): ShellExecutionObservedV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid execution environment event ${index + 1}`);
  }
  const event = value as Record<string, unknown>;
  if (
    event.seq !== index + 1 ||
    event.type !== "shell.completed" ||
    !Number.isSafeInteger(event.turn) ||
    (event.turn as number) < 0 ||
    typeof event.command !== "string" ||
    typeof event.cwd !== "string" ||
    (event.timeoutSec !== null && typeof event.timeoutSec !== "number") ||
    typeof event.ok !== "boolean" ||
    (event.exitCode !== null && typeof event.exitCode !== "number") ||
    typeof event.timedOut !== "boolean" ||
    !["none", "command", "infrastructure", "policy"].includes(
      String(event.failureKind),
    )
  ) {
    throw new Error(`Invalid execution environment event ${index + 1}`);
  }
  return Object.freeze({
    seq: event.seq as number,
    type: "shell.completed",
    turn: event.turn as number,
    command: event.command,
    cwd: event.cwd,
    timeoutSec: event.timeoutSec as number | null,
    ok: event.ok,
    exitCode: event.exitCode as number | null,
    timedOut: event.timedOut,
    failureKind: event.failureKind as ShellExecutionObservedV1["failureKind"],
  });
}

export function parseExecutionEnvironmentSnapshotV1(
  value: unknown,
): ExecutionEnvironmentSnapshotV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid execution environment snapshot");
  }
  const snapshot = value as Record<string, unknown>;
  assertString(snapshot.runId, "runId");
  assertString(snapshot.workspaceRoot, "workspaceRoot");
  if (
    snapshot.schemaVersion !== EXECUTION_ENVIRONMENT_SCHEMA_V1 ||
    snapshot.shellPersistence !== "fresh_process_per_call" ||
    !Array.isArray(snapshot.events)
  ) {
    throw new Error("Invalid execution environment snapshot schema");
  }
  const recovery = snapshot.recovery as Record<string, unknown> | undefined;
  const jobs = snapshot.backgroundJobs as Record<string, unknown> | undefined;
  if (
    !recovery ||
    typeof recovery.compatible !== "boolean" ||
    !Array.isArray(recovery.issues) ||
    !recovery.issues.every((item) => typeof item === "string") ||
    !jobs ||
    !["not_available", "managed"].includes(String(jobs.capability)) ||
    !Number.isSafeInteger(jobs.managed) ||
    (jobs.managed as number) < 0 ||
    !Number.isSafeInteger(jobs.running) ||
    (jobs.running as number) < 0 ||
    (jobs.stopping !== undefined &&
      (!Number.isSafeInteger(jobs.stopping) ||
        (jobs.stopping as number) < 0)) ||
    (jobs.pendingSettlements !== undefined &&
      (!Number.isSafeInteger(jobs.pendingSettlements) ||
        (jobs.pendingSettlements as number) < 0))
  ) {
    throw new Error("Invalid execution environment recovery/job state");
  }
  return Object.freeze({
    schemaVersion: EXECUTION_ENVIRONMENT_SCHEMA_V1,
    runId: snapshot.runId,
    workspaceRoot: snapshot.workspaceRoot,
    shellPersistence: "fresh_process_per_call",
    runtime: parseRuntime(snapshot.runtime),
    sandbox: parseSandbox(snapshot.sandbox),
    recovery: Object.freeze({
      compatible: recovery.compatible,
      issues: Object.freeze([...(recovery.issues as string[])]),
    }),
    backgroundJobs: Object.freeze({
      capability: jobs.capability as "not_available" | "managed",
      managed: jobs.managed as number,
      running: jobs.running as number,
      ...(typeof jobs.stopping === "number" ? { stopping: jobs.stopping } : {}),
      ...(typeof jobs.pendingSettlements === "number"
        ? { pendingSettlements: jobs.pendingSettlements }
        : {}),
    }),
    events: Object.freeze(
      snapshot.events.map((event, index) => parseEvent(event, index)),
    ),
  });
}

function reconciliationIssues(
  prior: ExecutionEnvironmentSnapshotV1 | undefined,
  workspaceRoot: string,
  runtime: ExecutionRuntimeV1,
  sandbox: ExecutionSandboxV1,
): readonly string[] {
  if (!prior) return Object.freeze([]);
  const issues: string[] = [];
  if (path.resolve(prior.workspaceRoot) !== path.resolve(workspaceRoot)) {
    issues.push("workspace_root_changed");
  }
  for (const key of ["platform", "arch", "shell"] as const) {
    if (prior.runtime[key] !== runtime[key])
      issues.push(`runtime_${key}_changed`);
  }
  if (prior.sandbox.mode !== sandbox.mode) issues.push("sandbox_mode_changed");
  if (prior.sandbox.network !== sandbox.network) {
    issues.push("sandbox_network_changed");
  }
  if (prior.sandbox.image !== sandbox.image)
    issues.push("sandbox_image_changed");
  return Object.freeze(issues);
}

function resultFacts(result: ToolRunResult): {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly failureKind: ShellExecutionObservedV1["failureKind"];
  readonly cwd?: string;
} {
  const payload =
    result.payload && typeof result.payload === "object"
      ? (result.payload as Record<string, unknown>)
      : {};
  const exitCode =
    typeof payload.exit_code === "number" ? payload.exit_code : null;
  const timedOut =
    payload.timed_out === true || /(?:timeout|timed out)/i.test(result.summary);
  const code = typeof payload.code === "string" ? payload.code : "";
  const failureKind = result.ok
    ? "none"
    : code === "E_POLICY_DENIED"
      ? "policy"
      : exitCode !== null
        ? "command"
        : "infrastructure";
  return {
    exitCode,
    timedOut,
    failureKind,
    ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
  };
}

export class ExecutionEnvironmentRegistryV1 {
  private readonly runtime: ExecutionRuntimeV1;
  private readonly sandbox: ExecutionSandboxV1;
  private readonly issues: readonly string[];
  private readonly events: ShellExecutionObservedV1[];

  constructor(private readonly options: ExecutionEnvironmentRegistryOptionsV1) {
    const prior = parseExecutionEnvironmentSnapshotV1(options.resumeSnapshot);
    if (prior && prior.runId !== options.runId) {
      throw new Error("Execution environment runId does not match resumed run");
    }
    this.runtime = Object.freeze(
      options.runtime ?? currentExecutionRuntimeV1(),
    );
    this.sandbox = sandboxSnapshot(options.shellSandbox);
    this.issues = Object.freeze([
      ...new Set([
        ...reconciliationIssues(
          prior,
          options.workspaceRoot,
          this.runtime,
          this.sandbox,
        ),
        ...(options.additionalRecoveryIssues ?? []),
      ]),
    ]);
    this.events = prior ? [...prior.events] : [];
  }

  observeToolResult(
    turn: number,
    call: AgentToolCallAction,
    result: ToolRunResult,
  ): void {
    if (call.tool !== "workspace.run_shell") return;
    const args =
      call.args && typeof call.args === "object"
        ? (call.args as Record<string, unknown>)
        : {};
    const command = typeof args.command === "string" ? args.command : "";
    const facts = resultFacts(result);
    const requestedCwd =
      typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : ".";
    const timeout =
      typeof args.timeout_sec === "number"
        ? args.timeout_sec
        : typeof args.timeoutSec === "number"
          ? args.timeoutSec
          : null;
    this.events.push(
      Object.freeze({
        seq: this.events.length + 1,
        type: "shell.completed" as const,
        turn,
        command,
        cwd:
          facts.cwd ?? path.resolve(this.options.workspaceRoot, requestedCwd),
        timeoutSec: timeout,
        ok: result.ok,
        exitCode: facts.exitCode,
        timedOut: facts.timedOut,
        failureKind: facts.failureKind,
      }),
    );
  }

  snapshot(): ExecutionEnvironmentSnapshotV1 {
    const background = this.options.backgroundJobs?.();
    return Object.freeze({
      schemaVersion: EXECUTION_ENVIRONMENT_SCHEMA_V1,
      runId: this.options.runId,
      workspaceRoot: this.options.workspaceRoot,
      shellPersistence: "fresh_process_per_call" as const,
      runtime: this.runtime,
      sandbox: this.sandbox,
      recovery: Object.freeze({
        compatible: this.issues.length === 0,
        issues: this.issues,
      }),
      backgroundJobs: background
        ? Object.freeze({
            capability: "managed" as const,
            managed: background.managed,
            running: background.running,
            stopping: background.stopping,
            pendingSettlements: background.pendingSettlements,
          })
        : Object.freeze({
            capability: "not_available" as const,
            managed: 0,
            running: 0,
          }),
      events: Object.freeze([...this.events]),
    });
  }
}
