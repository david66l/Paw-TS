import type {
  AgentAction,
  AgentAskUserAction,
  AgentPlanUpdateAction,
  AgentToolCallAction,
} from "@paw/core";

/** Max distance (chars) from end of text to scan for JSON tool calls.
 *  Tool-call JSON naturally appears near the end; earlier positions are
 *  more likely to be code blocks, logs, or file contents that happen to
 *  parse as JSON.  A 0 or negative value disables the proximity gate. */
const DEFAULT_JSON_SCAN_WINDOW = 8_000;

export interface ParseToolCallOptions {
  /** Only accept tool names in this set.  Omit to accept any name. */
  readonly knownTools?: ReadonlySet<string>;
  /** Max chars from end of text to scan (default 8_000). ≤ 0 = entire text. */
  readonly scanWindow?: number;
}

/**
 * Extract every valid JSON object from text, including multi-line objects.
 * Returns each object with its raw substring, character offsets, and a
 * confidence hint (higher for JSON inside fenced code blocks).
 */
function extractJsonObjects(
  text: string,
  scanWindow: number,
): Array<{
  obj: Record<string, unknown>;
  raw: string;
  start: number;
  end: number;
  confidence: number;
}> {
  const results: Array<{
    obj: Record<string, unknown>;
    raw: string;
    start: number;
    end: number;
    confidence: number;
  }> = [];

  const fencedRanges = findFencedCodeBlockRanges(text);
  const windowStart =
    scanWindow > 0 ? Math.max(0, text.length - scanWindow) : 0;

  let i = windowStart;
  while (i < text.length) {
    const idx = text.indexOf("{", i);
    if (idx === -1) break;

    let found = false;
    for (let j = idx + 1; j <= text.length; j++) {
      const slice = text.slice(idx, j);
      try {
        const obj = JSON.parse(slice) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const inFence = fencedRanges.some(
            (r) => idx >= r.start && j <= r.end,
          );
          results.push({
            obj: obj as Record<string, unknown>,
            raw: slice,
            start: idx,
            end: j,
            confidence: inFence
              ? 1 /* CODE_BLOCK_CONFIDENCE */
              : 0 /* BARE_JSON_CONFIDENCE */,
          });
          i = j;
          found = true;
          break;
        }
      } catch {
        /* continue extending */
      }
    }
    if (!found) {
      i = idx + 1;
    }
  }
  return results;
}

/** Return [start, end) ranges for every ```json … ``` fenced block. */
function findFencedCodeBlockRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const bodyStart = m.index + m[0].indexOf("\n") + 1;
    const bodyEnd = bodyStart + (m[1]?.length ?? 0);
    ranges.push({ start: bodyStart, end: bodyEnd });
  }
  return ranges;
}

/**
 * Parse the last actionable JSON object from model output.
 * Returns `null` when no recognized structured action — caller treats full text as free-form answer.
 */
export function parseAgentActionFromModelText(
  text: string,
  opts?: ParseToolCallOptions,
): AgentAction | null {
  const scanWindow = opts?.scanWindow ?? DEFAULT_JSON_SCAN_WINDOW;
  const objects = extractJsonObjects(text, scanWindow);
  for (let i = objects.length - 1; i >= 0; i--) {
    const action = parseActionFromJsonObject(objects[i]!.obj, opts?.knownTools);
    if (action) {
      return action;
    }
  }
  return null;
}

/**
 * 为一次工具调用生成去重 key。
 *
 * 同一工具 + 相同参数被视为重复调用，避免模型在同一轮里重复输出。
 *
 * @param tool 工具名
 * @param args 工具参数
 */
export function toolCallDedupKey(
  tool: string,
  args: Record<string, unknown>,
): string {
  return `${tool}:${JSON.stringify(args)}`;
}

/**
 * Scan ALL text and collect every valid `tool_call` JSON object.
 * Returns the collected tool calls plus the remaining prose text.
 *
 * When `knownTools` is supplied, tool calls whose tool name is NOT in the
 * set are silently discarded — they are almost certainly false positives
 * from code blocks, logs, or file contents.
 */
export function parseAgentActionsFromModelText(
  text: string,
  opts?: ParseToolCallOptions,
): {
  actions: AgentToolCallAction[];
  text: string;
} {
  const scanWindow = opts?.scanWindow ?? DEFAULT_JSON_SCAN_WINDOW;
  const objects = extractJsonObjects(text, scanWindow);
  const actions: AgentToolCallAction[] = [];
  const seen = new Set<string>();
  const toolRanges: Array<{ start: number; end: number }> = [];

  for (const { obj, start, end } of objects) {
    const action = parseActionFromJsonObject(obj, opts?.knownTools);
    if (action?.type === "tool_call") {
      const key = toolCallDedupKey(action.tool, action.args);
      if (!seen.has(key)) {
        seen.add(key);
        actions.push(action);
      }
      toolRanges.push({ start, end });
    }
  }

  // Rebuild text with tool-call JSON objects removed
  let prose = "";
  let lastEnd = 0;
  for (const { start, end } of toolRanges) {
    prose += text.slice(lastEnd, start);
    lastEnd = end;
  }
  prose += text.slice(lastEnd);

  return { actions, text: prose.trim() };
}

function parseArguments(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* ignore invalid JSON string */
    }
  }
  return null;
}

function parseActionFromJsonObject(
  obj: Record<string, unknown>,
  knownTools?: ReadonlySet<string>,
): AgentAction | null {
  const toolId =
    typeof obj.tool === "string" && obj.tool
      ? obj.tool
      : typeof obj.name === "string" && obj.name
        ? obj.name
        : null;
  if (toolId) {
    // Reject tool calls whose name isn't in the known registry (if supplied).
    // This eliminates false positives from code blocks and file contents.
    if (knownTools && !knownTools.has(toolId)) {
      return null;
    }
    // Prefer Paw format (args), fall back to OpenAI format (arguments)
    const args = asRecord(obj.args) ?? parseArguments(obj.arguments) ?? {};
    return {
      type: "tool_call",
      tool: toolId,
      args,
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
