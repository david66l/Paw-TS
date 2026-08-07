/**
 * P1 入口闸：注入时截断 + 内容哈希去重。
 * ========================================
 *
 * v3 方案 P1（TokenPilot ingestion gate + SWE-Pruner Pro 保守侧）：
 * - 分档截断：read 类永不截断（模型需要原文做编辑锚点）；
 *   run_shell 等长输出用固定小预览块（头 600 + 尾 400 字符）
 *   + 错误行智能保留（含语句块上下文）；
 *   短输出（<2,200 字符）不剪（长度感知保守性）。
 * - 内容哈希去重：同一内容重复出现 → 替换为 [repeat of #hash] 预览
 *   （coding agent 最常见的浪费：重复读同一文件/重复跑同一命令）。
 *
 * 截断内容按哈希存入 artifact registry 供 context.recall 取回（P3 冷库）。
 */

import { simpleHash } from "@paw/core";

export const MAX_TOOL_RESULT_CHARS = 40_000;
const MEDIUM_TOOL_LIMIT = 20_000;
const DEFAULT_TOOL_LIMIT = 50_000;
const SHORT_OUTPUT_THRESHOLD = 2_200;
const HEAD_CHARS = 600;
const TAIL_CHARS = 400;
const MAX_KEPT_ERROR_LINES = 20;
const MAX_KEPT_LINE_LEN = 200;
const DEDUP_MIN_CHARS = 2_000;

/**
 * 截断结果：标注是否发生截断 + 原文全文（供 P3 冷库归档）。
 * - truncated=false：payload 原样（未截断）
 * - truncated=true：fullText 为原始全文，payload 为头尾预览
 */
export interface TruncateOutcome {
  readonly payload: unknown;
  readonly truncated: boolean;
  /** 原始全文（仅 truncated=true 时存在） */
  readonly fullText?: string;
}

/** read 类工具：模型需要文件内容原文做编辑锚点，永不截断 */
const NO_TRUNCATE_TOOLS = new Set([
  "workspace.read_file",
  "workspace.list_dir",
  "workspace.glob",
  "workspace.grep",
  "workspace.lsp",
  "workspace.symbol_search",
]);

/** 中长输出工具：收紧上限 */
const MEDIUM_TRUNCATE_TOOLS = new Set([
  "workspace.search",
  "workspace.brief",
  "workspace.web_search",
]);

/** 错误行信号（SWE-Pruner Pro 标注协议的保守侧：不确定行按保留处理） */
const ERROR_LINE_PATTERN =
  /error|fail(?:ed|ure)?|exception|traceback|exit code|FAILED|✗/i;

function toolLimit(tool: string, defaultMax: number): number {
  if (NO_TRUNCATE_TOOLS.has(tool)) return Number.POSITIVE_INFINITY;
  if (MEDIUM_TRUNCATE_TOOLS.has(tool)) return MEDIUM_TOOL_LIMIT;
  return Math.min(defaultMax, DEFAULT_TOOL_LIMIT);
}

/**
 * 按工具分档截断工具结果 payload。
 * - read 类：原样返回（永不截断）
 * - string：超限 → 头 600 + 尾 400 + 截断标记 + 错误行智能保留
 * - object：序列化后超限才截断，否则原样
 */
export function truncatePayload(
  payload: unknown,
  tool: string,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): unknown {
  return truncatePayloadWithOutcome(payload, tool, maxChars).payload;
}

/**
 * truncatePayload 的完整信息版本：额外报告是否截断 + 原文全文
 * （tool-runner 接线 P3 冷库：截断时把全文存入 artifact registry）。
 */
export function truncatePayloadWithOutcome(
  payload: unknown,
  tool: string,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): TruncateOutcome {
  const limit = toolLimit(tool, maxChars);
  if (!Number.isFinite(limit)) return { payload, truncated: false };
  if (typeof payload === "string") {
    if (payload.length <= limit) return { payload, truncated: false };
    return {
      payload: truncateString(payload, limit),
      truncated: true,
      fullText: payload,
    };
  }
  if (payload !== null && typeof payload === "object") {
    const s = JSON.stringify(payload);
    if (s.length > limit) {
      return {
        payload: truncateString(s, limit),
        truncated: true,
        fullText: s,
      };
    }
  }
  return { payload, truncated: false };
}

/**
 * 截断字符串：头 600 + 尾 400 + 标记 + 保留错误行（含前后 2 行上下文）。
 * 短输出（<2,200 字符）不剪。
 */
export function truncateString(s: string, limit: number): string {
  if (s.length <= limit) return s;
  if (s.length <= SHORT_OUTPUT_THRESHOLD) return s;

  const head = s.slice(0, HEAD_CHARS);
  const tail = s.slice(-TAIL_CHARS);
  const body = s.slice(HEAD_CHARS, s.length - TAIL_CHARS);

  // 错误行智能保留：head/tail 之外的关键行（含语句块上下文）
  const lines = body.split("\n");
  const kept = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && ERROR_LINE_PATTERN.test(line)) {
      for (
        let j = Math.max(0, i - 2);
        j <= Math.min(lines.length - 1, i + 2);
        j++
      ) {
        kept.add(j);
      }
    }
  }
  const extras: string[] = [];
  for (const i of [...kept].sort((a, b) => a - b)) {
    const line = lines[i]?.trim() ?? "";
    if (line && line.length <= MAX_KEPT_LINE_LEN) {
      extras.push(line);
    }
    if (extras.length >= MAX_KEPT_ERROR_LINES) break;
  }

  const marker = `\n...[truncated ${s.length - HEAD_CHARS - TAIL_CHARS} chars]...\n`;
  const extraBlock =
    extras.length > 0 ? `\n[kept error lines]\n${extras.join("\n")}\n` : "";
  return `${head}${marker}${extraBlock}${tail}`;
}

/** 稳定字符串哈希（非密码学，仅用于内容寻址/去重；与 @paw/core 归档模块同源） */
export { simpleHash };

/** 会话级内容去重器：同一工具输出重复出现 → 预览引用 */
export interface PayloadDeduper {
  /**
   * 检查 payload 是否已见过。
   * @returns 已见过 → {hash, turn}；否则 null
   */
  check(
    payload: unknown,
  ): { readonly hash: string; readonly turn: number } | null;
  /** 记录 payload 并返回其 hash */
  record(payload: unknown, turn: number): string | null;
}

/** 创建会话级去重器（orchestrator 每 run 一个） */
export function createPayloadDeduper(): PayloadDeduper {
  const seen = new Map<string, { turn: number; size: number }>();
  return {
    check(payload) {
      if (typeof payload !== "string" || payload.length < DEDUP_MIN_CHARS) {
        return null;
      }
      const hash = simpleHash(payload);
      const prev = seen.get(hash);
      return prev ? { hash, turn: prev.turn } : null;
    },
    record(payload, turn) {
      if (typeof payload !== "string" || payload.length < DEDUP_MIN_CHARS) {
        return null;
      }
      const hash = simpleHash(payload);
      seen.set(hash, { turn, size: payload.length });
      return hash;
    },
  };
}
