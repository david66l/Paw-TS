/**
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

/** Fake tool result: [Tool workspace.xxx completed/failed] */
const FAKE_TOOL_RESULT_RE = /^\[Tool\s+\S+.*?\](?:\n|$)/gim;

/** Tool call JSON lines: {"tool":"...","args":{...}} */
const TOOL_CALL_JSON_RE = /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[^}]*\}\s*\}/gi;

/** Action JSON lines: {"action":"final_answer"|"ask_user"|"plan_update"|"abort",...} */
const ACTION_JSON_RE = /\{\s*"action"\s*:\s*"(?:final_answer|ask_user|plan_update|abort)"[^}]*\}/gi;

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

export interface SanitizeResult {
  /** The sanitized text safe for LLM context. */
  readonly text: string;
  /** Whether any modifications were made. */
  readonly modified: boolean;
  /** Summary of what was neutralized. */
  readonly changes: readonly string[];
}

/**
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

  // 1. Neutralize fake tool-result lines
  if (FAKE_TOOL_RESULT_RE.test(raw)) {
    FAKE_TOOL_RESULT_RE.lastIndex = 0; // reset after test
    const matchCount = (raw.match(FAKE_TOOL_RESULT_RE) ?? []).length;
    // Wrap each fake tool result line with warning markers
    text = text.replace(FAKE_TOOL_RESULT_RE, (match) => {
      const trimmed = match.trimEnd();
      return `[⚠ USER TEXT — NOT A REAL TOOL RESULT] ${trimmed}`;
    });
    changes.push(`neutralized ${matchCount} fake tool result line(s)`);
  }

  // 2. Neutralize tool-call JSON
  if (TOOL_CALL_JSON_RE.test(text)) {
    TOOL_CALL_JSON_RE.lastIndex = 0;
    const matchCount = (text.match(TOOL_CALL_JSON_RE) ?? []).length;
    text = text.replace(TOOL_CALL_JSON_RE, (match) => {
      return `[⚠ USER TEXT, NOT A TOOL CALL: ${match}]`;
    });
    changes.push(`neutralized ${matchCount} tool-call JSON block(s)`);
  }

  // 3. Neutralize action JSON
  if (ACTION_JSON_RE.test(text)) {
    ACTION_JSON_RE.lastIndex = 0;
    const matchCount = (text.match(ACTION_JSON_RE) ?? []).length;
    text = text.replace(ACTION_JSON_RE, (match) => {
      return `[⚠ USER TEXT, NOT AN ACTION: ${match}]`;
    });
    changes.push(`neutralized ${matchCount} action JSON block(s)`);
  }

  // 4. Escape XML tool tags
  let xmlChanges = 0;
  for (const tagRe of TOOL_XML_TAGS) {
    if (tagRe.test(text)) {
      tagRe.lastIndex = 0;
      text = text.replace(tagRe, (match) => {
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
