import { createHash } from "node:crypto";
import type { AgentToolCallAction } from "@paw/core";

const REMINDER_THRESHOLDS = new Set([3, 5, 8]);
const TRANSPARENT_TOOLS = new Set([
  "workspace.todo_write",
  "workspace.acceptance_update",
]);
const ARGUMENT_PREVIEW_CHARS = 500;

export interface RepeatToolState {
  readonly key: string;
  readonly tool: string;
  readonly count: number;
}

export interface RepeatToolReminderResult {
  readonly state?: RepeatToolState;
  readonly reminders: readonly string[];
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function callKey(tool: string, canonicalArguments: string): string {
  return createHash("sha256")
    .update(tool)
    .update("\0")
    .update(canonicalArguments)
    .digest("hex");
}

function previewArguments(canonicalArguments: string): string {
  if (canonicalArguments.length <= ARGUMENT_PREVIEW_CHARS) {
    return canonicalArguments;
  }
  return `${canonicalArguments.slice(0, ARGUMENT_PREVIEW_CHARS)}…(+${canonicalArguments.length - ARGUMENT_PREVIEW_CHARS} chars)`;
}

function reminder(
  tool: string,
  count: number,
  canonicalArguments: string,
): string {
  if (count === 3) {
    return "[Loop reminder] You have made the exact same tool call with identical arguments three consecutive times. Re-read the latest result and use materially different arguments or a different approach if more evidence is needed. The call was not blocked.";
  }
  return `[Loop reminder] Exact tool call repeated ${count} consecutive times:\n- tool: ${tool}\n- arguments: ${previewArguments(canonicalArguments)}\nThe call was not blocked. Inspect the latest result, then change the action or finish if the task is complete.`;
}

/**
 * Track only consecutive, canonically identical tool calls. Different
 * arguments are evidence of a different investigation step and reset the
 * chain. Control-plane bookkeeping is transparent and neither counts nor
 * resets the chain. This mechanism is advisory: it never rejects a call.
 */
export function advanceRepeatToolReminder(
  prior: RepeatToolState | undefined,
  calls: readonly AgentToolCallAction[],
): RepeatToolReminderResult {
  let state = prior;
  const reminders: string[] = [];
  for (const call of calls) {
    if (TRANSPARENT_TOOLS.has(call.tool)) continue;
    const canonicalArguments = stableStringify(call.args);
    const key = callKey(call.tool, canonicalArguments);
    const count = state?.key === key ? state.count + 1 : 1;
    state = { key, tool: call.tool, count };
    if (REMINDER_THRESHOLDS.has(count)) {
      reminders.push(reminder(call.tool, count, canonicalArguments));
    }
  }
  return { ...(state ? { state } : {}), reminders };
}
