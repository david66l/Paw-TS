export interface RunShellResult {
  readonly exit_code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly timed_out?: boolean;
  readonly cwd?: string;
  readonly error?: string;
  /** Semantic interpretation of the exit code (e.g. "No matches found" for grep exit 1). */
  readonly interpretation?: string;
  /** If true, the command requires user approval before execution. */
  readonly requiresApproval?: boolean;
  readonly approvalReason?: string;
  readonly sandbox?: {
    readonly mode: "workspace" | "strict";
    readonly runtime: string;
    readonly image: string;
    readonly network: "deny" | "full";
  };
}

// ---- Shell command classification (read-only vs mutating) ----

/** Commands that only read or search — safe to run without approval. */
const READ_COMMANDS = new Set([
  "ls",
  "tree",
  "du",
  "pwd",
  "id",
  "whoami",
  "date",
  "env",
  "printenv",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "stat",
  "file",
  "strings",
  "jq",
  "awk",
  "cut",
  "sort",
  "uniq",
  "tr",
  "sed",
  "grep",
  "rg",
  "ag",
  "ack",
  "find",
  "locate",
  "which",
  "whereis",
  "echo",
  "printf",
  "true",
  "false",
]);

/** Commands that typically produce no stdout on success. */
const SILENT_COMMANDS = new Set([
  "mv",
  "cp",
  "rm",
  "mkdir",
  "rmdir",
  "chmod",
  "chown",
  "chgrp",
  "touch",
  "ln",
  "cd",
  "export",
  "unset",
  "wait",
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
export function classifyShellCommand(
  command: string,
): ShellCommandClassification {
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
      if (
        [
          "grep",
          "rg",
          "ag",
          "ack",
          "find",
          "locate",
          "which",
          "whereis",
        ].includes(base)
      ) {
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
  const isSilent =
    hasWrite && !hasRead && !hasSearch && !hasList && hasExplicitSilent;

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
  return {
    isError: true,
    message: `Command failed with exit code ${exitCode}`,
  };
}

