/**
 * Context pruner — Layer 1 compression.
 *
 * Trims old tool-result messages and caps oversized individual tool outputs.
 * Zero LLM calls; pure text manipulation.
 */

import type { ChatMessage } from "./context-manager.js";
import { estimateMessageTokens, estimateTokens } from "./token-estimate.js";

export interface PruneConfig {
  /** Tokens to protect from tail (recent tool outputs kept intact). */
  readonly protectRecentTokens?: number;
  /** Max lines per individual tool result (applied regardless of position). */
  readonly maxToolOutputLines?: number;
  /** Max bytes per individual tool result (applied regardless of position). */
  readonly maxToolOutputBytes?: number;
  /** Tools that should never be pruned. */
  readonly protectedTools?: readonly string[];
}

export interface PruneResult {
  readonly pruned: boolean;
  /** Approximate tokens freed by this prune pass. */
  readonly freedTokens: number;
  /** Messages after pruning (may be a new array or the same reference). */
  readonly messages: ChatMessage[];
}

const DEFAULT_PROTECT_RECENT_TOKENS = 20_000;
const DEFAULT_MAX_TOOL_OUTPUT_LINES = 500;
const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 50_000;
const DEFAULT_PROTECTED_TOOLS = ["skill"];

const TOOL_RESULT_RE = /^Tool result \(([^)]+)\):\s*(OK|FAIL)\s*—\s*/;

interface ParsedToolResult {
  readonly tool: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly detail: string;
  readonly originalContent: string;
}

function parseToolResult(content: string): ParsedToolResult | null {
  const m = content.match(TOOL_RESULT_RE);
  if (!m) return null;
  const tool = m[1];
  const ok = m[2] === "OK";
  if (!tool) return null;
  const afterPrefix = content.slice(m[0].length);
  // Detail starts with a newline followed by JSON payload
  const detailIdx = afterPrefix.indexOf("\n");
  const summary = detailIdx >= 0 ? afterPrefix.slice(0, detailIdx) : afterPrefix;
  const detail = detailIdx >= 0 ? afterPrefix.slice(detailIdx + 1) : "";
  return { tool, ok, summary, detail, originalContent: content };
}

function compactToolResult(parsed: ParsedToolResult): string {
  // Single-line summary replacing the full payload
  return `Tool result (${parsed.tool}): ${parsed.ok ? "OK" : "FAIL"} — <tool_result compacted: ${parsed.summary}>`;
}

function capToolResultContent(content: string, maxLines: number, maxBytes: number): string {
  // Use array spread to avoid splitting surrogate pairs when capping by bytes
  let capped = content;
  if (capped.length > maxBytes) {
    const chars = [...capped];
    capped = chars.slice(0, maxBytes).join("") + "\n... (output truncated)";
  }
  const lines = capped.split("\n");
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const removed = lines.length - maxLines;
    capped = kept.join("\n") + `\n... (${removed} more lines)`;
  }
  return capped;
}

function isProtectedTool(tool: string, protectedSet: ReadonlySet<string>): boolean {
  return protectedSet.has(tool);
}

/**
 * Prune tool results in a message list.
 *
 * 1. Cuts individual tool results that exceed line/byte limits (all positions).
 * 2. Replaces tool-result messages beyond `protectRecentTokens` from the tail
 *    with single-line compacted placeholders.
 */
export function pruneToolResults(
  messages: ChatMessage[],
  config?: PruneConfig,
): PruneResult {
  const protectRecentTokens = config?.protectRecentTokens ?? DEFAULT_PROTECT_RECENT_TOKENS;
  const maxToolOutputLines = config?.maxToolOutputLines ?? DEFAULT_MAX_TOOL_OUTPUT_LINES;
  const maxToolOutputBytes = config?.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;
  const protectedTools = new Set(config?.protectedTools ?? DEFAULT_PROTECTED_TOOLS);

  let pruned = false;
  let freedTokens = 0;

  // Phase A: cap individual tool results regardless of position
  const afterCap: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") {
      afterCap.push(msg);
      continue;
    }
    const parsed = parseToolResult(msg.content);
    if (!parsed) {
      afterCap.push(msg);
      continue;
    }
    if (isProtectedTool(parsed.tool, protectedTools)) {
      afterCap.push(msg);
      continue;
    }
    const newContent = capToolResultContent(msg.content, maxToolOutputLines, maxToolOutputBytes);
    if (newContent !== msg.content) {
      pruned = true;
      freedTokens += estimateTokens(msg.content) - estimateTokens(newContent);
      afterCap.push({ ...msg, content: newContent });
    } else {
      afterCap.push(msg);
    }
  }

  // Phase B: replace old tool results beyond protectRecentTokens with compact placeholders
  // Walk from tail backward, accumulating tokens.  Once we exceed the budget,
  // every subsequent tool-result message gets compacted.
  let tokensFromTail = 0;
  let insideBudget = true;
  const afterCompact: ChatMessage[] = [];

  for (let i = afterCap.length - 1; i >= 0; i--) {
    const msg = afterCap[i]!;
    const msgTokens = estimateMessageTokens(msg);

    if (insideBudget) {
      tokensFromTail += msgTokens;
      if (tokensFromTail > protectRecentTokens) {
        insideBudget = false;
      }
      afterCompact.unshift(msg);
      continue;
    }

    // Beyond budget — try to compact tool results
    if (msg.role === "user") {
      const parsed = parseToolResult(msg.content);
      if (parsed && !isProtectedTool(parsed.tool, protectedTools)) {
        const compacted = compactToolResult(parsed);
        freedTokens += estimateTokens(msg.content) - estimateTokens(compacted);
        pruned = true;
        afterCompact.unshift({ ...msg, content: compacted });
        continue;
      }
    }

    afterCompact.unshift(msg);
  }

  return { pruned, freedTokens, messages: afterCompact };
}
