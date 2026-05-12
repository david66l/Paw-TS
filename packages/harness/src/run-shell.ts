import { spawn, spawnSync } from "node:child_process";

import { checkWorkspacePath } from "@paw/workspace";

import { validateShellCommand } from "./shell-guard.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface RunShellResult {
  readonly exit_code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timed_out?: boolean;
  readonly cwd?: string;
  readonly error?: string;
  /** Semantic interpretation of the exit code (e.g. "No matches found" for grep exit 1). */
  readonly interpretation?: string;
}

// ---- Shell command classification (read-only vs mutating) ----

/** Commands that only read or search — safe to run without approval. */
const READ_COMMANDS = new Set([
  "ls", "tree", "du", "pwd", "id", "whoami", "date", "env", "printenv",
  "cat", "head", "tail", "less", "more", "wc", "stat", "file", "strings",
  "jq", "awk", "cut", "sort", "uniq", "tr", "sed", "grep", "rg", "ag", "ack",
  "find", "locate", "which", "whereis", "echo", "printf", "true", "false",
]);

/** Commands that typically produce no stdout on success. */
const SILENT_COMMANDS = new Set([
  "mv", "cp", "rm", "mkdir", "rmdir", "chmod", "chown", "chgrp", "touch",
  "ln", "cd", "export", "unset", "wait",
]);

/** Semantic-neutral commands that don't change the read/write nature of a pipeline. */
const NEUTRAL_COMMANDS = new Set(["echo", "printf", "true", "false", ":"]);

/** Split a compound command into segments (by &&, ||, |, ;). */
function splitCommandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||\||;)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Extract the base command from a segment (first word, ignoring redirects). */
function extractBaseCommand(segment: string): string {
  const trimmed = segment.trim();
  // Skip leading env vars (FOO=bar cmd)
  const withoutEnv = trimmed.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
  const parts = withoutEnv.split(/\s+/);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p === ">" || p === ">>" || p === ">&" || p === "<") {
      i++; // skip redirect target
      continue;
    }
    if (p.startsWith("-") || p.startsWith("--")) {
      continue; // skip flags
    }
    return p;
  }
  return "";
}

export interface ShellCommandClassification {
  /** True if the command only reads files (ls, cat, grep, find, etc.). */
  readonly isReadOnly: boolean;
  /** True if the command is expected to produce no stdout on success (mv, cp, rm, etc.). */
  readonly isSilent: boolean;
  /** High-level category for UI / logging. */
  readonly commandType: "read" | "search" | "list" | "write" | "unknown";
}

/**
 * Classify a shell command as read-only or mutating.
 * Handles compound commands (pipelines, && chains) by checking every segment.
 */
export function classifyShellCommand(command: string): ShellCommandClassification {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) {
    return { isReadOnly: false, isSilent: false, commandType: "unknown" };
  }

  let hasNonNeutral = false;
  let hasRead = false;
  let hasSearch = false;
  let hasList = false;
  let hasWrite = false;
  let hasExplicitSilent = false;

  for (const seg of segments) {
    const base = extractBaseCommand(seg);
    if (!base) continue;
    if (NEUTRAL_COMMANDS.has(base)) continue;

    hasNonNeutral = true;

    if (READ_COMMANDS.has(base)) {
      hasRead = true;
      if (["grep", "rg", "ag", "ack", "find", "locate", "which", "whereis"].includes(base)) {
        hasSearch = true;
      }
      if (["ls", "tree", "du"].includes(base)) {
        hasList = true;
      }
    } else if (SILENT_COMMANDS.has(base)) {
      hasWrite = true;
      hasExplicitSilent = true;
    } else {
      // Any unrecognized command is treated as potentially mutating
      hasWrite = true;
    }
  }

  if (!hasNonNeutral) {
    return { isReadOnly: false, isSilent: false, commandType: "unknown" };
  }

  const isReadOnly = !hasWrite;
  // Only mark as silent when ALL non-neutral commands are in the explicit silent set
  const isSilent = hasWrite && !hasRead && !hasSearch && !hasList && hasExplicitSilent;

  let commandType: ShellCommandClassification["commandType"] = "unknown";
  if (hasWrite) commandType = "write";
  else if (hasSearch) commandType = "search";
  else if (hasList) commandType = "list";
  else if (hasRead) commandType = "read";

  return { isReadOnly, isSilent, commandType };
}

// ---- Exit code semantic interpretation ----

export interface ExitCodeInterpretation {
  /** Whether this exit code represents an error condition. */
  readonly isError: boolean;
  /** Human-readable description (e.g. "No matches found"). */
  readonly message?: string;
}

/** Per-command semantic rules for non-zero exit codes. */
const COMMAND_SEMANTICS = new Map<
  string,
  (exitCode: number) => ExitCodeInterpretation
>([
  [
    "grep",
    (code) => ({
      isError: code >= 2,
      message: code === 1 ? "No matches found" : undefined,
    }),
  ],
  [
    "rg",
    (code) => ({
      isError: code >= 2,
      message: code === 1 ? "No matches found" : undefined,
    }),
  ],
  [
    "find",
    (code) => ({
      isError: code >= 2,
      message: code === 1 ? "Some directories were inaccessible" : undefined,
    }),
  ],
  [
    "diff",
    (code) => ({
      isError: code >= 2,
      message: code === 1 ? "Files differ" : undefined,
    }),
  ],
  [
    "test",
    (code) => ({
      isError: code >= 2,
      message: code === 1 ? "Condition is false" : undefined,
    }),
  ],
  [
    "[",
    (code) => ({
      isError: code >= 2,
      message: code === 1 ? "Condition is false" : undefined,
    }),
  ],
]);

/** Heuristically extract the primary command name for semantic lookup. */
function extractSemanticBaseCommand(command: string): string {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return "";
  // Use the last segment since that's what determines the exit code in pipelines
  const last = segments[segments.length - 1];
  if (!last) return "";
  return extractBaseCommand(last);
}

/**
 * Provide semantic interpretation for a shell command's exit code.
 * Many commands use non-zero exit codes to convey information (grep 1 = no matches).
 */
export function interpretShellExitCode(
  command: string,
  exitCode: number | null | undefined,
): ExitCodeInterpretation {
  if (exitCode === null || exitCode === undefined) {
    return { isError: true, message: "Command did not produce an exit code" };
  }
  if (exitCode === 0) {
    return { isError: false };
  }
  const base = extractSemanticBaseCommand(command);
  const semantic = COMMAND_SEMANTICS.get(base);
  if (semantic) {
    return semantic(exitCode);
  }
  return { isError: true, message: `Command failed with exit code ${exitCode}` };
}

export interface RunShellStreamingOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Called for each stdout/stderr chunk as it arrives. */
  readonly onChunk?: (chunk: string, isStderr: boolean) => void;
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
  options: { cwd?: string; timeoutMs?: number } = {},
): RunShellResult {
  const guard = validateShellCommand(command);
  if (!guard.allowed) {
    return { error: guard.reason ?? "command rejected by shell guard" };
  }

  const cwdResult = resolveCwd(workspaceRoot, options.cwd);
  if (cwdResult.error) {
    return { error: cwdResult.error };
  }
  const cwdPath = cwdResult.cwdPath;

  const timeoutMs = clampTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const win = process.platform === "win32";
  const proc = win
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
        cwd: cwdPath,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      })
    : spawnSync("/bin/sh", ["-c", command], {
        cwd: cwdPath,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
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

    const cwdResult = resolveCwd(workspaceRoot, options.cwd);
    if (cwdResult.error) {
      resolve({ error: cwdResult.error });
      return;
    }
    const cwdPath = cwdResult.cwdPath;

    const timeoutMs = clampTimeoutMs(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const win = process.platform === "win32";

    const chunks: string[] = [];
    const errChunks: string[] = [];
    let killedByTimeout = false;
    let totalBytes = 0;
    let killedByOutputLimit = false;

    const proc = win
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command], {
          cwd: cwdPath,
          windowsHide: true,
        })
      : spawn("/bin/sh", ["-c", command], { cwd: cwdPath });

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
        error: killedByOutputLimit ? `output exceeded ${MAX_OUTPUT_BYTES} bytes limit` : undefined,
      };
      resolve(result);
    });
  });
}
