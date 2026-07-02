/**
 * Input sanitizer — 用户输入净化器
 *
 * 【模块职责】
 * 在用户消息进入 LLM 上下文之前，检测并中和其中可能被误解析为工具调用、
 * 工具结果或系统指令的恶意/意外模式。这是 paw-ts 的第一道安全防线。
 *
 * 【为什么需要净化器】
 * LLM 在上下文窗口中解析文本时，如果用户输入包含类似工具调用的 JSON 格式、
 * 伪造的工具结果标记（如 "[Tool xxx completed]"）、或 XML 工具标签，模型
 * 可能将用户文本误解为真实系统消息，导致：
 * 1. 提示注入攻击（用户冒充系统/工具输出）
 * 2. 模型行为异常（跳过实际需要的工具调用）
 * 3. 安全边界被突破
 *
 * 【设计决策】
 * - 四层规则防御，逐层处理，不依赖单一正则
 * - 中和后的文本仍然可见（用 ⚠ 标记包裹），方便调试和安全审计
 * - 不删除恶意内容，而是转义/标记——避免信息丢失
 * - 仅对用户输入执行净化，不对系统生成的工具结果执行
 * - 返回 SanitizeResult 包含变更摘要，上层可记录日志
 *
 * Input sanitizer — neutralizes tool-like patterns in user messages
 * before they enter the LLM context.
 *
 * This prevents prompt injection via fake tool results, forged tool calls,
 * and XML/JSON tool formatting abuse. All neutralized content remains
 * visible as text but loses its "actionable" format.
 *
 * The sanitizer is NOT applied to system-generated tool results.
 */

// ── Patterns ──

/**
 * 伪造的工具结果模式：[Tool workspace.xxx completed/failed]
 *
 * 攻击者可在用户输入中插入此类文本，冒充系统工具执行结果，
 * 诱导模型相信某个操作已被执行。
 */
/** Fake tool result: [Tool workspace.xxx completed/failed] */
const FAKE_TOOL_RESULT_RE = /^\[Tool\s+\S+.*?\](?:\n|$)/gim;

/**
 * 伪造的工具调用 JSON：{"tool":"...","args":{...}}
 *
 * 攻击者构造与系统工具调用格式相同的 JSON，可能被模型解析为
 * 需要执行的真实工具调用指令。
 */
/** Tool call JSON lines: {"tool":"...","args":{...}} */
const TOOL_CALL_JSON_RE = /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[^}]*\}\s*\}/gi;

/**
 * 伪造的行动指令 JSON：{"action":"final_answer"|"ask_user"|...}
 *
 * 攻击者可能注入包含系统级 action 字段的 JSON，试图控制
 * 编排器的执行流程（如强制结束、请求用户输入等）。
 */
/** Action JSON lines: {"action":"final_answer"|"ask_user"|"plan_update"|"abort",...} */
const ACTION_JSON_RE = /\{\s*"action"\s*:\s*"(?:final_answer|ask_user|plan_update|abort)"[^}]*\}/gi;

/**
 * XML/HTML 格式的工具调用标签
 *
 * 某些 LLM 使用 XML 标签格式传递工具调用（如 <tool_call>、<function>）。
 * 攻击者可注入此类标签混淆模型解析。
 */
/** XML/HTML tool tags */
const TOOL_XML_TAGS = [
  /<\/?tool_call>/gi,
  /<\/?tool>/gi,
  /<\/?args>/gi,
  /<\/?function_call>/gi,
  /<\/?function>/gi,
  /<\/?parameter>/gi,
];

// ── Sanitizer ──

/**
 * 净化结果
 *
 * 返回净化后的文本、是否发生修改、以及具体变更的摘要。
 * 调用方可据此决定是否记录安全事件日志。
 */
export interface SanitizeResult {
  /** 净化后安全可放入 LLM 上下文的文本 */
  /** The sanitized text safe for LLM context. */
  readonly text: string;
  /** 是否有任何修改发生 */
  /** Whether any modifications were made. */
  readonly modified: boolean;
  /** 变更摘要列表（如 "neutralized 3 fake tool result line(s)"） */
  /** Summary of what was neutralized. */
  readonly changes: readonly string[];
}

/**
 * 净化用户输入，中和所有工具类模式
 *
 * 处理顺序：
 * 1. 伪造工具结果行 -> 包裹为带警告标记的纯文本
 * 2. 工具调用 JSON  -> 包裹为带警告标记的纯文本
 * 3. 行动指令 JSON  -> 包裹为带警告标记的纯文本
 * 4. XML 工具标签   -> HTML 实体转义（< 变 &lt;, > 变 &gt;）
 *
 * @param raw - 原始用户输入文本
 * @returns SanitizeResult 含净化后文本和变更摘要
 *
 * Sanitize user input to neutralize tool-like patterns.
 *
 * - Fake tool results → wrapped in warning markers
 * - Tool call JSON  → escaped to plain text
 * - Action JSON     → escaped to plain text
 * - XML tool tags   → HTML-entity escaped
 */
export function sanitizeUserInput(raw: string): SanitizeResult {
  const changes: string[] = [];
  let text = raw;

  // 步骤 1：中和伪造的工具结果行
  // ——使用 ⚠ 标记前缀包裹，既保留原文本可见又明确标注非系统输出
  // 1. Neutralize fake tool-result lines
  if (FAKE_TOOL_RESULT_RE.test(raw)) {
    // 注意：test() 会移动正则的 lastIndex，使用前必须重置
    FAKE_TOOL_RESULT_RE.lastIndex = 0; // reset after test
    const matchCount = (raw.match(FAKE_TOOL_RESULT_RE) ?? []).length;
    // Wrap each fake tool result line with warning markers
    text = text.replace(FAKE_TOOL_RESULT_RE, (match) => {
      const trimmed = match.trimEnd();
      return `[⚠ USER TEXT — NOT A REAL TOOL RESULT] ${trimmed}`;
    });
    changes.push(`neutralized ${matchCount} fake tool result line(s)`);
  }

  // 步骤 2：中和工具调用 JSON
  // ——整个 JSON 字符串被包裹为带警告的纯文本，防止被模型解析为结构化指令
  // 2. Neutralize tool-call JSON
  if (TOOL_CALL_JSON_RE.test(text)) {
    TOOL_CALL_JSON_RE.lastIndex = 0;
    const matchCount = (text.match(TOOL_CALL_JSON_RE) ?? []).length;
    text = text.replace(TOOL_CALL_JSON_RE, (match) => {
      return `[⚠ USER TEXT, NOT A TOOL CALL: ${match}]`;
    });
    changes.push(`neutralized ${matchCount} tool-call JSON block(s)`);
  }

  // 步骤 3：中和行动指令 JSON
  // ——与工具调用类似，防止用户伪造系统级 action 指令
  // 3. Neutralize action JSON
  if (ACTION_JSON_RE.test(text)) {
    ACTION_JSON_RE.lastIndex = 0;
    const matchCount = (text.match(ACTION_JSON_RE) ?? []).length;
    text = text.replace(ACTION_JSON_RE, (match) => {
      return `[⚠ USER TEXT, NOT AN ACTION: ${match}]`;
    });
    changes.push(`neutralized ${matchCount} action JSON block(s)`);
  }

  // 步骤 4：转义 XML 工具标签
  // ——使用 HTML 实体编码尖括号，标签变为不可解析的纯文本
  // 统计被转义的标签类型数（而非总出现次数）
  // 4. Escape XML tool tags
  let xmlChanges = 0;
  for (const tagRe of TOOL_XML_TAGS) {
    if (tagRe.test(text)) {
      tagRe.lastIndex = 0;
      text = text.replace(tagRe, (match) => {
        // 对所有尖括号进行 HTML 实体转义
        return match.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      });
      xmlChanges++;
    }
  }
  if (xmlChanges > 0) {
    changes.push(`escaped ${xmlChanges} XML tool tag type(s)`);
  }

  return {
    text,
    modified: changes.length > 0,
    changes,
  };
}
