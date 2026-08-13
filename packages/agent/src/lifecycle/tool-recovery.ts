/**
 * ToolFailureRecovery — structured next-step hints from tool error codes / summaries.
 */

import type { ToolRunResult } from "@paw/harness";
import { isControlPlaneToolResult } from "./control-plane.js";

export type RecoveryAction =
  | "retry"
  | "reread"
  | "use_apply_patch"
  | "request_approval"
  | "escalate"
  | "change_strategy";

export interface RecoveryHint {
  readonly action: RecoveryAction;
  readonly message: string;
}

function payloadError(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const rec = payload as Record<string, unknown>;
  if (typeof rec.error === "string") return rec.error;
  if (typeof rec.code === "string") return rec.code;
  return "";
}

function errorCode(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const rec = payload as Record<string, unknown>;
  return typeof rec.code === "string" ? rec.code : "";
}

/** Build a recovery hint for a failed tool result, or null if none. */
export function recoveryHintForToolResult(
  tool: string,
  result: ToolRunResult,
): RecoveryHint | null {
  if (result.ok || isControlPlaneToolResult(result)) return null;

  const summary = result.summary.toLowerCase();
  const err = payloadError(result.payload).toLowerCase();
  const code = errorCode(result.payload);
  const blob = `${summary}\n${err}\n${code}`;

  if (
    code === "E_POLICY_DENIED" ||
    blob.includes("requires approval") ||
    blob.includes("e_policy")
  ) {
    return {
      action: "request_approval",
      message: `[Recovery] ${tool} was blocked by policy. Use a safer workspace command, or ensure AutonomyProfile allows it. Do not treat this as a fatal crash.`,
    };
  }

  if (
    tool.includes("edit_file") &&
    (blob.includes("old_string") ||
      blob.includes("not found") ||
      blob.includes("no match"))
  ) {
    return {
      action: "use_apply_patch",
      message:
        "[Recovery] edit_file failed to match old_string. Re-read the file for exact current text, add more surrounding context for uniqueness, set replace_all=true if every match should change, or use workspace.apply_patch with a unified diff.",
    };
  }

  if (
    code === "E_RETRY" ||
    blob.includes("timeout") ||
    blob.includes("timed")
  ) {
    return {
      action: "retry",
      message: `[Recovery] ${tool} timed out or is retryable. Retry with a tighter scope or longer timeout_sec; avoid repeating the identical failing command blindly.`,
    };
  }

  if (blob.includes("denied by user") || blob.includes("blocked")) {
    return {
      action: "change_strategy",
      message: `[Recovery] ${tool} was denied/blocked. Choose a different approach (read-only probe, smaller edit, apply_patch).`,
    };
  }

  if (!result.ok) {
    return {
      action: "reread",
      message: `[Recovery] ${tool} failed (${result.summary.slice(0, 120)}). Inspect the error, re-read relevant files, then try a different tool or smaller change.`,
    };
  }

  return null;
}

/** Format recovery hints as a single user message injection. */
export function formatRecoveryHints(
  hints: readonly RecoveryHint[],
): string | null {
  if (hints.length === 0) return null;
  const unique = new Map<string, RecoveryHint>();
  for (const h of hints) {
    if (!unique.has(h.action)) unique.set(h.action, h);
  }
  return [...unique.values()].map((h) => h.message).join("\n");
}

/**
 * Idle fuse: identical failure signatures repeated N times → escalate.
 */
export function failureSignature(tool: string, result: ToolRunResult): string {
  const code = errorCode(result.payload) || (result.ok ? "ok" : "fail");
  return `${tool}|${code}|${result.summary.slice(0, 80)}`;
}

export function updateFailureSignatures(
  prev: readonly string[] | undefined,
  calls: readonly { tool: string }[],
  results: readonly ToolRunResult[],
  limit = 8,
): readonly string[] {
  // A successful action is concrete progress and breaks the consecutive
  // failure streak. Without this reset, a fuse that once tripped remains
  // tripped on every later successful tool round and can falsely hard-stop a
  // recovered run.
  if (results.some((result) => result.ok)) return [];

  const productFailures = results
    .map((result, index) => ({ result, call: calls[index] }))
    .filter(
      (
        entry,
      ): entry is {
        result: ToolRunResult;
        call: { tool: string };
      } => Boolean(entry.call) && !isControlPlaneToolResult(entry.result),
    );
  if (productFailures.length === 0) return prev ?? [];

  const next = [...(prev ?? [])];
  for (const { call, result } of productFailures) {
    if (result.ok) continue;
    next.push(failureSignature(call.tool, result));
  }
  return next.slice(-limit);
}

export function idleFuseTripped(
  signatures: readonly string[],
  threshold = 3,
): boolean {
  if (signatures.length < threshold) return false;
  const last = signatures[signatures.length - 1]!;
  let count = 0;
  for (let i = signatures.length - 1; i >= 0; i--) {
    if (signatures[i] === last) count++;
    else break;
  }
  return count >= threshold;
}

export const IDLE_FUSE_ESCALATION =
  "[Recovery:idle_fuse] The same tool failure repeated. Stop retrying identically — change strategy (re-read, apply_patch, different test command) or output final_answer / abort with an honest status.";
