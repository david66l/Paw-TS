/**
 * 上下文裁剪器 — L1 压缩（零 LLM 调用）。
 * =========================================
 *
 * 阶段 A：超大的单个工具结果 → 持久化到磁盘 + 上下文中保留预览
 * 阶段 B：保留最近 N 个可压缩的工具结果；更旧的 → 持久化 + 预览
 *
 * 这是唯一不依赖 LLM 的压缩层。完全基于规则：
 * - 字节限制：超过 maxToolOutputBytes（默认 50KB）的工具结果触发阶段 A
 * - 数量限制：超过 keepRecentTools（默认 5）的最旧可压缩工具触发阶段 B
 *
 * 保护工具：skill/web_fetch/web_search/todo_write 等永远不会被裁剪或驱逐。
 */

import type { ChatMessage } from "./manager.js";
import { estimateTokens } from "../token-estimate.js";
import {
  isToolResultMessage,
  parseToolResult,
  splitToolBlocks,
  type ParsedToolResult,
} from "../tool-result/format.js";
import {
  buildPersistedToolResultContent,
  DEFAULT_KEEP_RECENT_TOOLS,
  DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  isPersistedToolResult,
  persistToolResultToDisk,
  toolResultExceedsLimits,
} from "../tool-result/storage.js";

export interface PruneConfig {
  /** `.paw/sessions/{runId}/tool-results` — 持久化路径；不提供则 L1 为 no-op */
  readonly toolResultsDir?: string;
  /** 保留最近 N 个可压缩工具结果（阶段 B）。默认 5。 */
  readonly keepRecentTools?: number;
  /** @deprecated token tail budget 已移除；改用 keepRecentTools */
  readonly protectRecentTokens?: number;
  /** @deprecated 已忽略；保留用于测试兼容性 */
  readonly contextWindow?: number;
  /** @deprecated 行数限制已移除 — 改用 maxToolOutputBytes */
  readonly maxToolOutputLines?: number;
  /** @deprecated token 阈值已移除 — 只用 maxToolOutputBytes */
  readonly maxToolOutputTokens?: number;
  /** 阶段 A 持久化前每个工具结果的最大字节数（默认 50_000）。 */
  readonly maxToolOutputBytes?: number;
  /** 在阶段 B 中永不持久化或驱逐的工具。 */
  readonly protectedTools?: readonly string[];
}

export interface PruneResult {
  readonly pruned: boolean;
  readonly freedTokens: number;
  readonly messages: ChatMessage[];
}

/** 默认受保护的工具：这些工具的结果永远不会被裁剪 */
const DEFAULT_PROTECTED_TOOLS = [
  "skill",
  "web_fetch",
  "web_search",
  "todo_write",
];

function isProtectedTool(
  tool: string,
  protectedSet: ReadonlySet<string>,
): boolean {
  return protectedSet.has(tool);
}

/** 将单个工具块持久化到磁盘，返回预览内容 */
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

/**
 * 处理一条消息中的工具结果块。
 * 对每个块检查：是否需要驱逐（阶段 B）/是否超大（阶段 A）。
 */
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

    // 受保护的工具 → 跳过
    if (isProtectedTool(parsed.tool, opts.protectedTools)) {
      nextBlocks.push(block);
      continue;
    }

    // 已经持久化的块 → 跳过
    if (isPersistedToolResult(block)) {
      nextBlocks.push(block);
      continue;
    }

    const evict = opts.shouldEvict(parsed.tool, globalIndex);
    const oversize = toolResultExceedsLimits(block, opts.maxToolOutputBytes);

    // 不需要驱逐也不超大 → 保留原样
    if (!evict && !oversize) {
      nextBlocks.push(block);
      continue;
    }

    // 持久化：写入磁盘，上下文中保留预览
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

/** 收集所有消息中的工具结果槽位 */
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

/** 构建保留集合：最近 N 个可压缩工具结果的 globalIndex */
function buildKeepSet(
  slots: readonly ToolSlot[],
  keepRecentTools: number,
): Set<number> {
  const compactable = slots.filter((s) => s.compactable);
  const keep = compactable.slice(-Math.max(1, keepRecentTools));
  return new Set(keep.map((s) => s.globalIndex));
}

/**
 * 裁剪消息列表中的工具结果。
 *
 * 1. 阶段 A：持久化超大的工具结果（字节限制）
 * 2. 阶段 B：持久化超出最近 N 个可压缩工具的结果
 */
export function pruneToolResults(
  messages: ChatMessage[],
  config?: PruneConfig,
): PruneResult {
  const toolResultsDir = config?.toolResultsDir;
  // 没有持久化目录 → L1 为 no-op
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
    if (msg.role !== "user" || !isToolResultMessage(msg.content)) {
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
