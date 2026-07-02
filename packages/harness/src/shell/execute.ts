import { spawn, spawnSync } from "node:child_process";

import { checkWorkspacePath } from "@paw/workspace";

import {
  buildDockerShellExecSpec,
  isShellSandboxEnabled,
  type ShellSandboxConfig,
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
}

export interface RunShellStreamingOptions extends RunShellOptions {
  /** Called for each stdout/stderr chunk as it arrives. */
  readonly onChunk?: (chunk: string, isStderr: boolean) => void;
}

interface ShellSpawnTarget {
  readonly command: string;
  readonly args: readonly string[];
  readonly sandbox?: RunShellResult["sandbox"];
}

function resolveShellSpawnTarget(
  workspaceRoot: string,
  cwdPath: string,
  command: string,
  shellSandbox: ShellSandboxConfig | undefined,
  win: boolean,
): ShellSpawnTarget | { readonly error: string } {
  if (isShellSandboxEnabled(shellSandbox)) {
    if (win) {
      return {
        error:
          "shell sandbox requires docker/podman and is not supported on native Windows cmd; use WSL or set sandbox.mode to off",
      };
    }
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
      },
    };
  }

  return win
    ? {
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", command],
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
  if (guard.requiresApproval) {
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
    ...(win && !spawnTarget.sandbox ? { windowsHide: true } : {}),
  });

  if (proc.error) {
    const e = proc.error as NodeJS.ErrnoException & { killed?: boolean };
    if (e.code === "ETIMEDOUT" || proc.signal === "SIGTERM") {
      return {
        error: `timeout after ${timeoutMs}ms`,
        timed_out: true,
        cwd: cwdPath,
      };
    }
    return {
      error: e.message ?? String(proc.error),
      cwd: cwdPath,
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
    if (guard.requiresApproval) {
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

    const proc = spawn(spawnTarget.command, [...spawnTarget.args], {
      cwd: isShellSandboxEnabled(options.shellSandbox) ? undefined : cwdPath,
      ...(win && !spawnTarget.sandbox ? { windowsHide: true } : {}),
    });

    const timeoutId = setTimeout(() => {
      killedByTimeout = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout?.on("data", (data: Buffer) => {
      totalBytes += data.length;
      if (totalBytes > MAX_OUTPUT_BYTES && !killedByOutputLimit) {
        killedByOutputLimit = true;
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
        proc.kill("SIGTERM");
        return;
      }
      const text = String(data);
      errChunks.push(text);
      options.onChunk?.(text, true);
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeoutId);
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
