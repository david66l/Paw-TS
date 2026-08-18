/**
 * ToolFailureRecovery — structured next-step hints from tool error codes / summaries.
 */

import type { ToolRunResult } from "@paw/harness";
import { isControlPlaneToolResult } from "./control-plane.js";

export type RecoveryAction =
  | "retry"
  | "reread"
  | "refine_edit"
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

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableValue(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function actionIdentity(call: {
  readonly tool: string;
  readonly args?: unknown;
}): string {
  const args =
    call.tool === "workspace.run_shell" &&
    call.args &&
    typeof call.args === "object" &&
    typeof (call.args as Record<string, unknown>).command === "string"
      ? {
          ...(call.args as Record<string, unknown>),
          command: ((call.args as Record<string, unknown>).command as string)
            .replace(/\r\n/g, "\n")
            .trim(),
        }
      : call.args;
  return fingerprint(`${call.tool}\n${stableValue(args ?? {})}`);
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
      action: "refine_edit",
      message:
        "[Recovery] edit_file failed to match old_string. Re-read the file for exact current text, add more surrounding context for uniqueness, or set replace_all=true if every match should change.",
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
      message: `[Recovery] ${tool} was denied/blocked. Choose an available read-only probe or a smaller exact edit.`,
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
export function failureSignature(
  call: { readonly tool: string; readonly args?: unknown },
  result: ToolRunResult,
): string {
  const code = errorCode(result.payload) || (result.ok ? "ok" : "fail");
  return `${call.tool}|${actionIdentity(call)}|${code}|${fingerprint(
    result.summary.slice(0, 240),
  )}`;
}

export function updateFailureSignatures(
  prev: readonly string[] | undefined,
  calls: readonly { readonly tool: string; readonly args?: unknown }[],
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
        call: { readonly tool: string; readonly args?: unknown };
      } => Boolean(entry.call) && !isControlPlaneToolResult(entry.result),
    );
  if (productFailures.length === 0) return prev ?? [];

  const next = [...(prev ?? [])];
  for (const { call, result } of productFailures) {
    if (result.ok) continue;
    next.push(failureSignature(call, result));
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
  "[Recovery:idle_fuse] The same tool failure repeated. Stop retrying identically — re-read current state, make a smaller exact edit, try a different test command, or output final_answer / abort with an honest status.";
