import type {
  AgentAction,
  AgentAskUserAction,
  AgentPlanUpdateAction,
  AgentToolCallAction,
} from "@paw/core";

/**
 * Parse the last actionable JSON line from model output (incremental parity with Python parser).
 * Returns `null` when no recognized structured action — caller treats full text as free-form answer.
 */
export function parseAgentActionFromModelText(
  text: string,
): AgentAction | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]?.trim();
    if (!t?.startsWith("{")) {
      continue;
    }
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const action = parseActionFromJsonObject(obj);
      if (action) {
        return action;
      }
    } catch {
      /* try previous line */
    }
  }
  return null;
}

/**
 * Scan ALL lines and collect every valid `tool_call` JSON object.
 * Returns the collected tool calls plus the remaining prose text.
 */
export function parseAgentActionsFromModelText(
  text: string,
): { actions: AgentToolCallAction[]; text: string } {
  const lines = text.split(/\r?\n/);
  const actions: AgentToolCallAction[] = [];
  const seen = new Set<string>();
  const nonToolLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        const action = parseActionFromJsonObject(obj);
        if (action?.type === "tool_call") {
          const key = `${action.tool}:${JSON.stringify(action.args)}`;
          if (!seen.has(key)) {
            seen.add(key);
            actions.push(action);
          }
          continue;
        }
      } catch {
        /* not valid JSON */
      }
    }
    nonToolLines.push(line);
  }
  return { actions, text: nonToolLines.join("\n").trim() };
}

function parseActionFromJsonObject(
  obj: Record<string, unknown>,
): AgentAction | null {
  const toolId =
    typeof obj.tool === "string" && obj.tool
      ? obj.tool
      : typeof obj.name === "string" && obj.name
        ? obj.name
        : null;
  if (toolId) {
    return {
      type: "tool_call",
      tool: toolId,
      args: asRecord(obj.args) ?? {},
    };
  }

  const rawKind =
    (typeof obj.action === "string" && obj.action) ||
    (typeof obj.type === "string" && obj.type) ||
    "";
  const kind = rawKind.toLowerCase().replace(/-/g, "_");

  if (kind === "final_answer" || kind === "finalanswer") {
    if (typeof obj.summary !== "string") {
      return null;
    }
    return { type: "final_answer", summary: obj.summary };
  }

  if (kind === "ask_user" || kind === "askuser") {
    if (typeof obj.question !== "string") {
      return null;
    }
    const ctx = asRecord(obj.context) ?? {};
    let timeoutSec: number | null = null;
    if (typeof obj.timeout_sec === "number") {
      timeoutSec = obj.timeout_sec;
    } else if (typeof obj.timeoutSec === "number") {
      timeoutSec = obj.timeoutSec;
    }
    const out: AgentAskUserAction = {
      type: "ask_user",
      question: obj.question,
      context: ctx,
      timeoutSec,
    };
    return out;
  }

  if (kind === "plan_update" || kind === "planupdate") {
    const newItems = Array.isArray(obj.new_items)
      ? obj.new_items
      : Array.isArray(obj.newItems)
        ? obj.newItems
        : [];
    const deprecatedRaw = obj.deprecated_items ?? obj.deprecatedItems;
    const deprecatedItems = Array.isArray(deprecatedRaw)
      ? deprecatedRaw.filter((x): x is string => typeof x === "string")
      : [];
    const reason = typeof obj.reason === "string" ? obj.reason : "";
    const out: AgentPlanUpdateAction = {
      type: "plan_update",
      newItems,
      deprecatedItems,
      reason,
    };
    return out;
  }

  if (kind === "abort") {
    if (typeof obj.reason !== "string") {
      return null;
    }
    return {
      type: "abort",
      reason: obj.reason,
      canResume:
        typeof obj.can_resume === "boolean"
          ? obj.can_resume
          : typeof obj.canResume === "boolean"
            ? obj.canResume
            : false,
    };
  }

  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}
