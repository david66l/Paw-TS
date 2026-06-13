/**
 * Context pruner — Layer 1 compression.
 *
 * Phase A: oversized single tool results → persist to disk + preview in context.
 * Phase B: keep the N most recent compactable tool results; older → persist + preview.
 * Zero LLM calls.
 */

import type { ChatMessage } from "./context-manager.js";
import { estimateTokens } from "./token-estimate.js";
import {
  buildPersistedToolResultContent,
  DEFAULT_KEEP_RECENT_TOOLS,
  DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  isPersistedToolResult,
  persistToolResultToDisk,
  toolResultExceedsLimits,
} from "./tool-result-storage.js";

export interface PruneConfig {
  /** `.paw/sessions/{runId}/tool-results` — required for persist; without it L1 is a no-op. */
  readonly toolResultsDir?: string;
  /** Keep this many most recent compactable tool results (Phase B). Default 5. */
  readonly keepRecentTools?: number;
  /** @deprecated Token tail budget removed; use keepRecentTools. Ignored if set. */
  readonly protectRecentTokens?: number;
  /** @deprecated Ignored; kept for test compatibility. */
  readonly contextWindow?: number;
  /** @deprecated Line count removed — use maxToolOutputBytes. Ignored. */
  readonly maxToolOutputLines?: number;
  /** @deprecated Token threshold removed — use maxToolOutputBytes only. Ignored. */
  readonly maxToolOutputTokens?: number;
  /** Max bytes per tool result before Phase A persist (default 50_000). */
  readonly maxToolOutputBytes?: number;
  /** Tools never persisted or evicted in Phase B. */
  readonly protectedTools?: readonly string[];
}

export interface PruneResult {
  readonly pruned: boolean;
  readonly freedTokens: number;
  readonly messages: ChatMessage[];
}

const DEFAULT_PROTECTED_TOOLS = [
  "skill",
  "web_fetch",
  "web_search",
  "todo_write",
];

const TOOL_RESULT_RE = /^\[Tool (.+?) (completed|failed)\]\n(.+)/s;
const TOOL_BLOCK_SPLIT = /\n\n(?=\[Tool .+? (?:completed|failed)\]\n)/;

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
  const tool = m[1]!;
  const ok = m[2] === "completed";
  const rest = m[3] ?? "";
  const nlIdx = rest.indexOf("\n");
  const summary = nlIdx >= 0 ? rest.slice(0, nlIdx) : rest;
  const detail = nlIdx >= 0 ? rest.slice(nlIdx + 1) : "";
  return { tool, ok, summary, detail, originalContent: content };
}

function splitToolBlocks(content: string): string[] {
  if (!content.startsWith("[Tool ")) return [];
  return content.split(TOOL_BLOCK_SPLIT);
}

function isProtectedTool(
  tool: string,
  protectedSet: ReadonlySet<string>,
): boolean {
  return protectedSet.has(tool);
}

function persistBlock(
  toolResultsDir: string,
  id: string,
  parsed: ParsedToolResult,
): string {
  const filepath = persistToolResultToDisk(
    toolResultsDir,
    id,
    parsed.originalContent,
  );
  return buildPersistedToolResultContent({
    tool: parsed.tool,
    ok: parsed.ok,
    summary: parsed.summary,
    filepath,
    originalSize: parsed.originalContent.length,
    fullBody: parsed.originalContent,
  });
}

function processMessageToolBlocks(
  msgIndex: number,
  content: string,
  opts: {
    readonly toolResultsDir: string;
    readonly maxToolOutputBytes: number;
    readonly protectedTools: ReadonlySet<string>;
    readonly shouldEvict: (tool: string, globalIndex: number) => boolean;
    readonly toolCounter: { n: number };
  },
): { content: string; changed: boolean; freed: number } {
  const blocks = splitToolBlocks(content);
  if (blocks.length === 0) {
    return { content, changed: false, freed: 0 };
  }

  let changed = false;
  let freed = 0;
  const nextBlocks: string[] = [];

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx]!;
    const parsed = parseToolResult(block);
    if (!parsed) {
      nextBlocks.push(block);
      continue;
    }

    const globalIndex = opts.toolCounter.n;
    opts.toolCounter.n++;

    if (isProtectedTool(parsed.tool, opts.protectedTools)) {
      nextBlocks.push(block);
      continue;
    }

    if (isPersistedToolResult(block)) {
      nextBlocks.push(block);
      continue;
    }

    const evict = opts.shouldEvict(parsed.tool, globalIndex);
    const oversize = toolResultExceedsLimits(block, opts.maxToolOutputBytes);

    if (!evict && !oversize) {
      nextBlocks.push(block);
      continue;
    }

    const id = `${msgIndex}-${blockIdx}-${parsed.tool}`;
    const persisted = persistBlock(opts.toolResultsDir, id, parsed);
    freed += Math.max(0, estimateTokens(block) - estimateTokens(persisted));
    changed = true;
    nextBlocks.push(persisted);
  }

  const newContent = nextBlocks.join("\n\n");
  return { content: newContent, changed, freed };
}

interface ToolSlot {
  readonly msgIndex: number;
  readonly tool: string;
  readonly globalIndex: number;
  readonly compactable: boolean;
}

function collectToolSlots(
  messages: ChatMessage[],
  protectedTools: ReadonlySet<string>,
): ToolSlot[] {
  const slots: ToolSlot[] = [];
  let globalIndex = 0;
  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex]!;
    if (msg.role !== "user") continue;
    for (const block of splitToolBlocks(msg.content)) {
      const parsed = parseToolResult(block);
      if (!parsed) continue;
      const compactable = !isProtectedTool(parsed.tool, protectedTools);
      slots.push({
        msgIndex,
        tool: parsed.tool,
        globalIndex,
        compactable,
      });
      globalIndex++;
    }
  }
  return slots;
}

function buildKeepSet(
  slots: readonly ToolSlot[],
  keepRecentTools: number,
): Set<number> {
  const compactable = slots.filter((s) => s.compactable);
  const keep = compactable.slice(-Math.max(1, keepRecentTools));
  return new Set(keep.map((s) => s.globalIndex));
}

/**
 * Prune tool results in a message list.
 *
 * 1. Phase A: persist oversized tool results (byte limit).
 * 2. Phase B: persist tool results beyond the last N compactable tools.
 */
export function pruneToolResults(
  messages: ChatMessage[],
  config?: PruneConfig,
): PruneResult {
  const toolResultsDir = config?.toolResultsDir;
  if (!toolResultsDir) {
    return { pruned: false, freedTokens: 0, messages };
  }

  const keepRecentTools =
    config?.keepRecentTools ?? DEFAULT_KEEP_RECENT_TOOLS;
  const maxToolOutputBytes =
    config?.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;
  const protectedTools = new Set(
    config?.protectedTools ?? DEFAULT_PROTECTED_TOOLS,
  );

  const slots = collectToolSlots(messages, protectedTools);
  const keepGlobalIndices = buildKeepSet(slots, keepRecentTools);

  let pruned = false;
  let freedTokens = 0;
  const toolCounter = { n: 0 };
  const out: ChatMessage[] = [];

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex]!;
    if (msg.role !== "user" || !msg.content.startsWith("[Tool ")) {
      out.push(msg);
      continue;
    }

    const { content, changed, freed } = processMessageToolBlocks(
      msgIndex,
      msg.content,
      {
        toolResultsDir,
        maxToolOutputBytes,
        protectedTools,
        shouldEvict: (_tool, globalIndex) =>
          !keepGlobalIndices.has(globalIndex),
        toolCounter,
      },
    );

    if (changed) {
      pruned = true;
      freedTokens += freed;
      out.push({ ...msg, content });
    } else {
      out.push(msg);
    }
  }

  return { pruned, freedTokens, messages: out };
}
