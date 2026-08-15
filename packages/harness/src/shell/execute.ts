import { spawn, spawnSync } from "node:child_process";

import { checkWorkspacePath } from "@paw/workspace";

import type {
  ManagedJobHooksV1,
  ManagedJobOutcomeV1,
} from "../jobs/managed-job-registry.js";
import {
  type ShellSandboxConfig,
  buildDockerShellExecSpec,
  isShellSandboxEnabled,
} from "../sandbox/index.js";
import { validateShellCommand } from "../shell-guard.js";
import type { RunShellResult } from "./analysis.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface RunShellOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly shellSandbox?: ShellSandboxConfig;
  /**
   * When true, skip the shell-policy "ask" gate — the caller already obtained
   * approval via the unified tool-approval bus (AutonomyProfile / resolveToolApproval).
   * Deny rules still apply.
   */
  readonly skipApprovalGate?: boolean;
}

export interface RunShellStreamingOptions extends RunShellOptions {
  /** Called for each stdout/stderr chunk as it arrives. */
  readonly onChunk?: (chunk: string, isStderr: boolean) => void;
}

export interface StartManagedShellOptions extends RunShellOptions {
  /** Maximum unread UTF-8 output retained in memory. Oldest bytes are dropped. */
  readonly outputLimitBytes?: number;
  /** Grace between tree TERM and force kill. */
  readonly terminationGraceMs?: number;
}

export interface ManagedShellJobV1 {
  readonly hooks: ManagedJobHooksV1;
  readonly cwd: string;
  readonly pid: number;
  readonly sandbox?: RunShellResult["sandbox"];
}

interface ShellSpawnTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly sandbox?: RunShellResult["sandbox"];
  readonly cleanupSandbox?: () => void;
}

function forceRemoveContainer(runtime: string, containerName: string): void {
  spawnSync(runtime, ["rm", "-f", containerName], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
}

function resolveShellSpawnTarget(
  workspaceRoot: string,
  cwdPath: string,
  command: string,
  shellSandbox: ShellSandboxConfig | undefined,
  win: boolean,
): ShellSpawnTarget | { readonly error: string } {
  if (isShellSandboxEnabled(shellSandbox)) {
    const spec = buildDockerShellExecSpec(shellSandbox, {
      workspaceRoot,
      cwdPath,
      command,
    });
    if ("error" in spec) {
      return spec;
    }
    return {
      command: spec.runtime,
      args: spec.args,
      sandbox: {
        mode: spec.mode,
        runtime: spec.runtime,
        image: spec.image,
        network: spec.network,
        containerWorkspaceRoot: spec.containerWorkspaceRoot,
        commandShell: spec.commandShell,
        containerName: spec.containerName,
        pullPolicy: spec.pullPolicy,
      },
      cleanupSandbox: () =>
        forceRemoveContainer(spec.runtime, spec.containerName),
    };
  }

  return win
    ? {
        command: process.env.ComSpec ?? "cmd.exe",
        // cmd /s strips the outer quotes around its /c string. Keep those
        // transport quotes separate from any quotes owned by the command
        // itself (for example a leading executable path with spaces).
        args: ["/d", "/s", "/c", `"${command}"`],
      }
    : {
        command: "/bin/sh",
        args: ["-c", command],
      };
}

function clampTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(ms), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function resolveCwd(
  workspaceRoot: string,
  optionsCwd?: string,
): { cwdPath: string; error?: string } {
  const relCwd = optionsCwd?.trim() ? optionsCwd : ".";
  const d = checkWorkspacePath(workspaceRoot, relCwd);
  if (!d.allowed) {
    return { cwdPath: "", error: d.reason ?? "cwd escapes workspace" };
  }
  return { cwdPath: d.resolvedPath };
}

/**
 * Runs a shell command with {@link validateShellCommand}; `cwd` is resolved under workspace root.
 * Synchronous — blocks until the command completes. Prefer {@link runShellInWorkspaceStreaming}
 * when you need real-time output.
 */
export function runShellInWorkspace(
  workspaceRoot: string,
  command: string,
  options: RunShellOptions = {},
): RunShellResult {
  const guard = validateShellCommand(command);
  if (!guard.allowed) {
    return { error: guard.reason ?? "command rejected by shell guard" };
  }
  if (guard.requiresApproval && !options.skipApprovalGate) {
    return {
      error: guard.reason ?? "command requires approval",
      requiresApproval: true,
      approvalReason: guard.reason,
    };
  }

  const cwdResult = resolveCwd(workspaceRoot, options.cwd);
  if (cwdResult.error) {
    return { error: cwdResult.error };
  }
  const cwdPath = cwdResult.cwdPath;

  const timeoutMs = clampTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const win = process.platform === "win32";
  const spawnTarget = resolveShellSpawnTarget(
    workspaceRoot,
    cwdPath,
    command,
    options.shellSandbox,
    win,
  );
  if ("error" in spawnTarget) {
    return { error: spawnTarget.error, cwd: cwdPath };
  }

  const proc = spawnSync(spawnTarget.command, [...spawnTarget.args], {
    cwd: isShellSandboxEnabled(options.shellSandbox) ? undefined : cwdPath,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    ...(win && !spawnTarget.sandbox
      ? {
          windowsHide: true,
          // We spawn cmd.exe explicitly rather than using `shell: true`, so
          // Node will not enable this automatically. The final argv element
          // is already a complete cmd command string and must not be quoted a
          // second time, especially when it begins with a quoted executable.
          windowsVerbatimArguments: true,
        }
      : {}),
  });

  if (proc.error) {
    const e = proc.error as NodeJS.ErrnoException & { killed?: boolean };
    spawnTarget.cleanupSandbox?.();
    if (e.code === "ETIMEDOUT" || proc.signal === "SIGTERM") {
      return {
        error: `timeout after ${timeoutMs}ms`,
        timed_out: true,
        cwd: cwdPath,
        ...(spawnTarget.sandbox ? { sandbox: spawnTarget.sandbox } : {}),
      };
    }
    return {
      error: e.message ?? String(proc.error),
      cwd: cwdPath,
      ...(spawnTarget.sandbox ? { sandbox: spawnTarget.sandbox } : {}),
    };
  }

  const stdout =
    typeof proc.stdout === "string" ? proc.stdout : String(proc.stdout ?? "");
  const stderr =
    typeof proc.stderr === "string" ? proc.stderr : String(proc.stderr ?? "");
  const code = proc.status;

  return {
    exit_code: code ?? undefined,
    stdout,
    stderr,
    cwd: cwdPath,
    ...(spawnTarget.sandbox ? { sandbox: spawnTarget.sandbox } : {}),
  };
}

/**
 * Async streaming shell execution. Yields stdout/stderr chunks via `onChunk`
 * while collecting the final {@link RunShellResult}.
 */
export function runShellInWorkspaceStreaming(
  workspaceRoot: string,
  command: string,
  options: RunShellStreamingOptions = {},
): Promise<RunShellResult> {
  return new Promise((resolve) => {
    const guard = validateShellCommand(command);
    if (!guard.allowed) {
      resolve({ error: guard.reason ?? "command rejected by shell guard" });
      return;
    }
    if (guard.requiresApproval && !options.skipApprovalGate) {
      resolve({
        error: guard.reason ?? "command requires approval",
        requiresApproval: true,
        approvalReason: guard.reason,
      });
      return;
    }

    const cwdResult = resolveCwd(workspaceRoot, options.cwd);
    if (cwdResult.error) {
      resolve({ error: cwdResult.error });
      return;
    }
    const cwdPath = cwdResult.cwdPath;

    const timeoutMs = clampTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const win = process.platform === "win32";
    const spawnTarget = resolveShellSpawnTarget(
      workspaceRoot,
      cwdPath,
      command,
      options.shellSandbox,
      win,
    );
    if ("error" in spawnTarget) {
      resolve({ error: spawnTarget.error, cwd: cwdPath });
      return;
    }

    const chunks: string[] = [];
    const errChunks: string[] = [];
    let killedByTimeout = false;
    let totalBytes = 0;
    let killedByOutputLimit = false;
    let sandboxCleanupStarted = false;
    const cleanupSandbox = (): void => {
      if (sandboxCleanupStarted) return;
      sandboxCleanupStarted = true;
      spawnTarget.cleanupSandbox?.();
    };

    const proc = spawn(spawnTarget.command, [...spawnTarget.args], {
      cwd: isShellSandboxEnabled(options.shellSandbox) ? undefined : cwdPath,
      ...(win && !spawnTarget.sandbox
        ? { windowsHide: true, windowsVerbatimArguments: true }
        : {}),
    });

    const timeoutId = setTimeout(() => {
      killedByTimeout = true;
      cleanupSandbox();
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout?.on("data", (data: Buffer) => {
      totalBytes += data.length;
      if (totalBytes > MAX_OUTPUT_BYTES && !killedByOutputLimit) {
        killedByOutputLimit = true;
        cleanupSandbox();
        proc.kill("SIGTERM");
        return;
      }
      const text = String(data);
      chunks.push(text);
      options.onChunk?.(text, false);
    });

    proc.stderr?.on("data", (data: Buffer) => {
      totalBytes += data.length;
      if (totalBytes > MAX_OUTPUT_BYTES && !killedByOutputLimit) {
        killedByOutputLimit = true;
        cleanupSandbox();
        proc.kill("SIGTERM");
        return;
      }
      const text = String(data);
      errChunks.push(text);
      options.onChunk?.(text, true);
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      cleanupSandbox();
      resolve({
        error: err.message,
        timed_out: killedByTimeout,
        cwd: cwdPath,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);
      const result: RunShellResult = {
        exit_code: code ?? undefined,
        stdout: chunks.join(""),
        stderr: errChunks.join(""),
        timed_out: killedByTimeout,
        cwd: cwdPath,
        error: killedByOutputLimit
          ? `output exceeded ${MAX_OUTPUT_BYTES} bytes limit`
          : undefined,
        ...(spawnTarget.sandbox ? { sandbox: spawnTarget.sandbox } : {}),
      };
      resolve(result);
    });
  });
}

class BoundedOutputCursorV1 {
  private unread = Buffer.alloc(0);
  private droppedBytes = 0;

  constructor(private readonly limitBytes: number) {}

  append(data: Buffer, isStderr: boolean): void {
    const tagged = isStderr
      ? Buffer.concat([Buffer.from("[stderr] "), data])
      : data;
    this.unread = Buffer.concat([this.unread, tagged]);
    if (this.unread.length > this.limitBytes) {
      const drop = this.unread.length - this.limitBytes;
      this.unread = this.unread.subarray(drop);
      this.droppedBytes += drop;
    }
  }

  read(): string {
    const notice =
      this.droppedBytes > 0
        ? `[managed output truncated: ${this.droppedBytes} oldest bytes dropped]\n`
        : "";
    const text = notice + this.unread.toString("utf8");
    this.unread = Buffer.alloc(0);
    this.droppedBytes = 0;
    return text;
  }
}

function terminateProcessTreeV1(pid: number, signal: "TERM" | "KILL"): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    // Windows has no reliable process-group TERM equivalent. A non-forced
    // taskkill can let cmd.exe exit before descendants, losing the only tree
    // handle. Always force the complete tree while the root pid is live.
    spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `taskkill /PID ${pid} /T /F`],
      { windowsHide: true, stdio: "ignore", timeout: 3_000 },
    );
    return;
  }
  try {
    process.kill(-pid, signal === "KILL" ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      process.kill(pid, signal === "KILL" ? "SIGKILL" : "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

/**
 * Starts an explicitly managed shell producer. It reuses the same guard,
 * workspace cwd resolution, sandbox target, and approval semantics as the
 * foreground shell, but exposes lifecycle hooks to ManagedJobRegistryV1.
 */
export function startManagedShellInWorkspaceV1(
  workspaceRoot: string,
  command: string,
  options: StartManagedShellOptions = {},
): ManagedShellJobV1 {
  const guard = validateShellCommand(command);
  if (!guard.allowed) {
    throw new Error(guard.reason ?? "command rejected by shell guard");
  }
  if (guard.requiresApproval && !options.skipApprovalGate) {
    throw new Error(guard.reason ?? "command requires approval");
  }
  const cwdResult = resolveCwd(workspaceRoot, options.cwd);
  if (cwdResult.error) throw new Error(cwdResult.error);
  const cwdPath = cwdResult.cwdPath;
  const win = process.platform === "win32";
  const spawnTarget = resolveShellSpawnTarget(
    workspaceRoot,
    cwdPath,
    command,
    options.shellSandbox,
    win,
  );
  if ("error" in spawnTarget) throw new Error(spawnTarget.error);

  const outputLimitBytes = options.outputLimitBytes ?? MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes <= 0) {
    throw new Error("outputLimitBytes must be a positive integer");
  }
  const terminationGraceMs = options.terminationGraceMs ?? 1_000;
  if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 0) {
    throw new Error("terminationGraceMs must be a non-negative number");
  }
  const output = new BoundedOutputCursorV1(outputLimitBytes);
  const proc = spawn(spawnTarget.command, [...spawnTarget.args], {
    cwd: isShellSandboxEnabled(options.shellSandbox) ? undefined : cwdPath,
    detached: !win && !spawnTarget.sandbox,
    ...(win && !spawnTarget.sandbox
      ? { windowsHide: true, windowsVerbatimArguments: true }
      : {}),
  });
  if (!proc.pid) {
    spawnTarget.cleanupSandbox?.();
    throw new Error("managed shell failed to obtain a process id");
  }

  let cancelRequested = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let outcomeSettled = false;
  let settleOutcome!: (outcome: ManagedJobOutcomeV1) => void;
  const done = new Promise<ManagedJobOutcomeV1>((resolve) => {
    settleOutcome = resolve;
  });
  const settle = (outcome: ManagedJobOutcomeV1): void => {
    if (outcomeSettled) return;
    outcomeSettled = true;
    if (forceTimer) clearTimeout(forceTimer);
    settleOutcome(outcome);
  };

  proc.stdout?.on("data", (data: Buffer) => output.append(data, false));
  proc.stderr?.on("data", (data: Buffer) => output.append(data, true));
  proc.once("error", (error) => {
    spawnTarget.cleanupSandbox?.();
    settle({ status: "failed", detail: error.message });
  });
  proc.once("close", (code, signal) => {
    settle(
      cancelRequested
        ? {
            status: "killed",
            detail: `terminated${signal ? ` by ${signal}` : ""}`,
          }
        : code === 0
          ? { status: "completed", detail: "exit code: 0" }
          : {
              status: "failed",
              detail: `exit code: ${code ?? "unknown"}${signal ? `, signal: ${signal}` : ""}`,
            },
    );
  });

  const pid = proc.pid;
  const cancel = (): void => {
    if (cancelRequested || outcomeSettled) return;
    cancelRequested = true;
    spawnTarget.cleanupSandbox?.();
    terminateProcessTreeV1(pid, "TERM");
    if (terminationGraceMs === 0) {
      terminateProcessTreeV1(pid, "KILL");
      return;
    }
    forceTimer = setTimeout(
      () => terminateProcessTreeV1(pid, "KILL"),
      terminationGraceMs,
    );
  };

  return {
    hooks: { cancel, done, readOutput: () => output.read() },
    cwd: cwdPath,
    pid,
    ...(spawnTarget.sandbox ? { sandbox: spawnTarget.sandbox } : {}),
  };
}
