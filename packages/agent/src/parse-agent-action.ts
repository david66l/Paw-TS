/**
 * 从模型输出文本中解析结构化动作（Agent Action）。
 * =================================================
 *
 * 这是 ReAct 循环中 "Parse" 环节的核心。模型输出的是自然语言文本，
 * 这个模块负责从中提取结构化的动作指令。
 *
 * 解析策略：
 * ----------
 * 1. **JSON 扫描窗口**：默认只扫描文本末尾 8000 字符。
 *    工具调用 JSON 自然出现在末尾；前面的位置更可能是代码块、日志或文件内容
 *    碰巧被 JSON.parse 接受。窗口限制大大减少了误匹配。
 *
 * 2. **代码块置信度**：fenced code block（```json ... ```）内的 JSON 置信度更高，
 *    因为是模型有意为之。裸 JSON（不在代码块中）置信度较低。
 *
 * 3. **已知工具名过滤**：如果传入了 knownTools 集合，工具调用中不在集合内的
 *    工具名会被静默丢弃——这些几乎肯定是代码块或文件内容的误匹配。
 *
 * 4. **多格式兼容**：支持两种 JSON 格式：
 *    - Paw 格式：{ "tool": "Bash", "args": {...} }
 *    - OpenAI 格式：{ "name": "Bash", "arguments": "..." }
 *
 * 5. **动作类型识别**：从 JSON 对象的 action/type 字段识别：
 *    - tool_call：工具调用（tool + args）
 *    - final_answer：最终答案（summary）
 *    - ask_user：向用户提问（question + timeout_sec）
 *    - plan_update：更新计划（new_items + deprecated_items + reason）
 *    - abort：中止任务（reason）
 *
 * 导出的核心函数：
 * - parseAgentActionFromModelText()：提取最后一个有效 action
 * - parseAgentActionsFromModelText()：提取所有 tool_call 并返回纯文本
 * - toolCallDedupKey()：为工具调用生成去重 key
 */

import type {
  AgentAction,
  AgentAskUserAction,
  AgentPlanUpdateAction,
  AgentToolCallAction,
} from "@paw/core";

/**
 * JSON 扫描窗口默认值（字符数）。
 * 工具调用 JSON 自然出现在模型输出的末尾；
 * 更早的位置更可能是代码块/日志等误匹配。
 * 设为 ≤ 0 可扫描全文。
 */
const DEFAULT_JSON_SCAN_WINDOW = 8_000;

/** 代码块内 JSON 的置信度加分 */
const CODE_BLOCK_CONFIDENCE = 1;

/** 裸 JSON（不在代码块中）的基础置信度 */
const BARE_JSON_CONFIDENCE = 0;

export interface ParseToolCallOptions {
  /** 仅接受此集合中的工具名。不传则接受任何名称。 */
  readonly knownTools?: ReadonlySet<string>;
  /** 从文本末尾扫描的最大字符数（默认 8000）。≤ 0 = 全文扫描。 */
  readonly scanWindow?: number;
}

interface ExtractedObject {
  readonly obj: Record<string, unknown>;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
}

interface ScannedAction {
  readonly action: AgentAction;
  readonly start: number;
  readonly end: number;
}

/**
 * 从文本中提取所有有效的 JSON 对象，包括多行对象。
 *
 * 算法：从扫描窗口起始位置开始，找到每个 `{`，
 * 逐步扩展 slice 直到 JSON.parse 成功。
 *
 * 返回每个对象的原始子串、字符偏移和置信度提示
 * （代码块内更高，用于区分模型有意输出的 JSON 和碰巧是 JSON 的代码片段）。
 */
function extractJsonObjects(
  text: string,
  scanWindow: number,
): ExtractedObject[] {
  const results: ExtractedObject[] = [];

  // 先找出所有 ```json ... ``` 代码块的范围
  const fencedRanges = findFencedCodeBlockRanges(text);
  const windowStart =
    scanWindow > 0 ? Math.max(0, text.length - scanWindow) : 0;

  let i = windowStart;
  while (i < text.length) {
    const idx = text.indexOf("{", i);
    if (idx === -1) break;

    let found = false;
    // 从 { 位置开始逐步扩展，尝试 JSON.parse
    for (let j = idx + 1; j <= text.length; j++) {
      const slice = text.slice(idx, j);
      try {
        const obj = JSON.parse(slice) as unknown;
        // 只接受非数组的对象
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const inFence = fencedRanges.some(
            (r) => idx >= r.start && j <= r.end,
          );
          results.push({
            obj: obj as Record<string, unknown>,
            raw: slice,
            start: idx,
            end: j,
            confidence: inFence ? CODE_BLOCK_CONFIDENCE : BARE_JSON_CONFIDENCE,
          });
          i = j;
          found = true;
          break;
        }
      } catch {
        /* JSON.parse 失败，继续扩展 slice */
      }
    }
    if (!found) {
      i = idx + 1;
    }
  }
  return results;
}

/** 返回每个 ```json … ``` 代码块的主体范围 [start, end) */
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
 * 扫描模型输出，将每个提取到的 JSON 对象转为可识别的 action，
 * 保持原始顺序和字符范围。
 */
function scanAgentActions(
  text: string,
  scanWindow: number,
  knownTools?: ReadonlySet<string>,
): ScannedAction[] {
  const objects = extractJsonObjects(text, scanWindow);
  const actions: ScannedAction[] = [];
  for (const { obj, start, end } of objects) {
    const action = parseActionFromJsonObject(obj, knownTools);
    if (action) {
      actions.push({ action, start, end });
    }
  }
  return actions;
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
 * 从模型输出中解析最后一个可操作的 JSON 对象。
 *
 * 返回 null 表示没有识别到任何结构化动作 → 调用方应把全文当作自由文本回复处理。
 *
 * 为什么取"最后一个"？
 * 模型通常在推理/解释后输出最终的动作 JSON，最后一个更可能是当前意图。
 */
export function parseAgentActionFromModelText(
  text: string,
  opts?: ParseToolCallOptions,
): AgentAction | null {
  const scanWindow = opts?.scanWindow ?? DEFAULT_JSON_SCAN_WINDOW;
  const actions = scanAgentActions(text, scanWindow, opts?.knownTools);
  for (let i = actions.length - 1; i >= 0; i--) {
    return actions[i]!.action;
  }
  return null;
}

/**
 * 扫描全部文本，收集所有有效的 tool_call JSON 对象。
 *
 * 返回收集到的工具调用 + 去除 JSON 后的纯文本（reasoningText）。
 *
 * 当传入 knownTools 时，工具名不在集合中的调用会被静默丢弃——
 * 这些几乎肯定是代码块、日志或文件内容的误匹配。
 *
 * 为什么需要返回纯文本？
 * 纯文本部分是模型的"推理过程"（reasoning），在注入上下文时不应该包含
 * 已被解析为结构化动作的 JSON（否则模型下一轮会看到重复信息）。
 */
export function parseAgentActionsFromModelText(
  text: string,
  opts?: ParseToolCallOptions,
): {
  actions: AgentToolCallAction[];
  text: string;
} {
  const scanWindow = opts?.scanWindow ?? DEFAULT_JSON_SCAN_WINDOW;
  const actions = scanAgentActions(text, scanWindow, opts?.knownTools);
  const toolCalls: AgentToolCallAction[] = [];
  const seen = new Set<string>();
  const toolRanges: Array<{ start: number; end: number }> = [];

  for (const { action, start, end } of actions) {
    if (action.type !== "tool_call") continue;
    const key = toolCallDedupKey(action.tool, action.args);
    if (!seen.has(key)) {
      seen.add(key);
      toolCalls.push(action);
    }
    toolRanges.push({ start, end });
  }

  // 从文本中移除已被解析为工具调用的 JSON 对象
  let prose = "";
  let lastEnd = 0;
  for (const { start, end } of toolRanges) {
    prose += text.slice(lastEnd, start);
    lastEnd = end;
  }
  prose += text.slice(lastEnd);

  return { actions: toolCalls, text: prose.trim() };
}

/**
 * 解析工具参数。支持两种格式：
 * - 直接是对象：{ "filePath": "..." }
 * - JSON 字符串："{ \"filePath\": \"...\" }"
 */
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
      /* 忽略无效 JSON 字符串 */
    }
  }
  return null;
}

/**
 * 从单个 JSON 对象中识别并解析 action。
 *
 * 识别优先级：
 * 1. tool_call（tool/name 字段存在 + args/arguments）→ 工具调用
 * 2. final_answer（action/type 为 "final_answer" + summary）→ 最终答案
 * 3. ask_user（action/type 为 "ask_user" + question）→ 向用户提问
 * 4. plan_update（action/type 为 "plan_update" + new_items）→ 更新计划
 * 5. abort（action/type 为 "abort" + reason）→ 中止任务
 *
 * 兼容 snake_case 和 camelCase 两种命名风格。
 */
function parseActionFromJsonObject(
  obj: Record<string, unknown>,
  knownTools?: ReadonlySet<string>,
): AgentAction | null {
  // ── 工具调用 ──
  // 支持 Paw 格式（tool + args）和 OpenAI 格式（name + arguments）
  const toolId =
    typeof obj.tool === "string" && obj.tool
      ? obj.tool
      : typeof obj.name === "string" && obj.name
        ? obj.name
        : null;
  if (toolId) {
    // 已知工具名过滤：不在注册表中的工具名直接拒绝
    // 这消除了代码块和文件内容中的大量误匹配
    if (knownTools && !knownTools.has(toolId)) {
      return null;
    }
    const args = asRecord(obj.args) ?? parseArguments(obj.arguments) ?? {};
    return {
      type: "tool_call",
      tool: toolId,
      args,
    };
  }

  // ── 结构化动作 ──
  // 兼容 action 和 type 两种字段名，兼容连字符和下划线
  const rawKind =
    (typeof obj.action === "string" && obj.action) ||
    (typeof obj.type === "string" && obj.type) ||
    "";
  const kind = rawKind.toLowerCase().replace(/-/g, "_");

  // final_answer / finalanswer
  if (kind === "final_answer" || kind === "finalanswer") {
    if (typeof obj.summary !== "string") {
      return null;
    }
    return { type: "final_answer", summary: obj.summary };
  }

  // ask_user / askuser
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

  // plan_update / planupdate
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

  // abort
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
