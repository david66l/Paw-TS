/**
 * L2 压缩摘要验证（质量门控）——v3 三层门控的规则层 + 实体层。
 *
 * 【模块职责】
 * 对对话压缩产生的摘要文本进行结构化、定量和实体级验证。
 *
 * 【三层门控（方案 v3 P0.2）】
 * ① 规则层（本文件）：必需章节非空 + 节省比例 20-80%（对齐 SWE-MeM 过滤线）
 * ② 实体层（本文件）：5 类锚点 verbatim 存活校验——
 *    用户约束原文块 / 文件路径 / 函数名 / 错误行 / 命令。
 *    用确定性块匹配（非关键词命中）——关键词会放过"禁止 X"→"允许 X"
 *    的语义翻转，原文块匹配才能抓住。
 * ③ judge 层（离线，见方案）：Self-GC no-impact 评估，建回归集后在线抽检。
 *
 * 【关键设计决策】
 * - 节省阈值 20%：对齐 SWE-MeM 的过滤线（<20% 压缩无意义、>80% 危险）。
 * - 约束存活校验：requiredConstraints 中的每条用户约束必须**整块逐字**
 *   出现在摘要中（精确匹配），否则拒绝摘要——这是 Governance Decay 的
 *   机制性防御（约束存活→违规 0%，被丢弃→38%）。
 * - 验证失败返回 Result 类型，不抛异常。
 */

/** 压缩摘要必须包含的章节标题（Markdown 二级标题） */
export const REQUIRED_SUMMARY_SECTIONS = [
  "active task", // 活跃任务：当前正在执行什么
  "goal", // 目标：最终要达成什么
  "progress", // 进度：已经完成了什么
] as const;

/** 压缩最低节省比例：对齐 SWE-MeM 过滤线（<20% 压缩无意义） */
export const MIN_COMPRESSION_SAVINGS_RATIO = 0.2;

/** 压缩最高节省比例：超过 80% 意味着关键信息被过度丢弃（SWE-MeM 危险线） */
export const MAX_COMPRESSION_SAVINGS_RATIO = 0.8;

/** 实体层锚点提取的上限（防止巨型原文提取过多锚点撑爆门控） */
const MAX_ANCHORS = 32;

/** 实体层锚点的行级信号（错误行/命令行） */
const ANCHOR_LINE_PATTERNS = [
  /\b(?:error|fail(?:ed|ure)?|exception|traceback|exit code|FAILED|✗)\b/i,
  /^(?:npm|bun|git|python|pytest|node|pnpm|yarn|go test|cd|ls|cat|grep|rg)\s+\S+/i,
];

/** 文件路径锚点（源码/文档/配置扩展名） */
const PATH_PATTERN =
  /[\w./@-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|json|ya?ml|toml|md|css|scss|html|sh)\b/g;

import { parseMarkdownSections } from "../markdown.js";
import { isToolResultMessage } from "../tool-result/format.js";

/** 实体层校验选项 */
export interface SummaryValidationOptions {
  /** 原文消息列表（用于提取文件路径/函数名/错误行/命令锚点） */
  readonly originalMessages?: readonly {
    role: string;
    content: string;
  }[];
  /** 必须逐字存活的用户约束原文（来自约束检测，整块精确匹配） */
  readonly requiredConstraints?: readonly string[];
}

/**
 * 从原文消息中提取实体锚点（文件路径/函数名/错误行/命令）。
 * 只从真实用户消息提取——工具结果消息（文件内容/日志）里的路径、
 * 错误行是内容噪音而非关键信息，提取它们会导致门控误杀。
 * 系统注入的 user 消息（[Context Package] / [Context Summary] 等）同样排除：
 * 其中的代码路径来自自动上下文发现，不是用户关心的关键实体。
 * 相对路径（./ ../）排除。
 * 提取后去重、截断到 MAX_ANCHORS。
 */
const SYSTEM_INJECTED_PREFIXES = [
  "[Context Package]",
  "[Context Summary]",
  "[Previous session context]",
  "[You stopped",
  "[Max steps",
  "[MAX_STEPS",
  "[model produced only reasoning]",
  "[Task]",
];

export function extractEntityAnchors(
  messages: readonly { role: string; content: string }[],
): string[] {
  const anchors = new Set<string>();
  for (const m of messages) {
    if (m.role !== "user" || isToolResultMessage(m.content)) continue;
    if (SYSTEM_INJECTED_PREFIXES.some((p) => m.content.startsWith(p))) {
      continue;
    }
    // 错误行 / 命令行（按行匹配，取整行）
    for (const line of m.content.split("\n")) {
      const t = line.trim();
      if (!t || t.length > 200) continue;
      if (ANCHOR_LINE_PATTERNS.some((p) => p.test(t))) {
        anchors.add(t.slice(0, 200));
      }
    }
    // 文件路径（排除相对路径噪音）
    const matches = m.content.match(PATH_PATTERN);
    if (matches) {
      for (const p of matches) {
        if (p.startsWith("./") || p.startsWith("../")) continue;
        if (p.length >= 5 && p.length <= 200) anchors.add(p);
      }
    }
    if (anchors.size >= MAX_ANCHORS * 3) break;
  }
  // 去重 + 截断
  const all = [...anchors];
  // 优先保留短锚点（更可能是关键标识符而非长日志行）
  return all.sort((a, b) => a.length - b.length).slice(0, MAX_ANCHORS);
}

/**
 * 验证压缩摘要的质量。
 *
 * 检查项（规则层 + 实体层）：
 * 1. 摘要不能为空
 * 2. 必需章节（## active task / ## goal / ## progress）非空
 * 3. requiredConstraints 中的每条约束**整块逐字**出现在摘要中
 *    （约束是最高价值内容，改写/遗漏 = 拒绝）
 * 4. 实体锚点（路径/错误行/命令）verbatim 存活（抽样校验，避免误杀）
 *
 * @returns 验证结果，ok=false 时附带原因说明
 */
export function validateCompressionSummary(
  summary: string,
  opts?: SummaryValidationOptions,
): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  const trimmed = summary.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty summary" };
  }

  // 解析 Markdown 章节结构，检查每个必需章节是否存在且非空
  const sections = parseMarkdownSections(trimmed);
  for (const sec of REQUIRED_SUMMARY_SECTIONS) {
    if (!sections[sec]?.trim()) {
      return { ok: false, reason: `missing section: ## ${sec}` };
    }
  }

  // ── 实体层：约束整块逐字存活（最高优先级）──
  const constraints = opts?.requiredConstraints ?? [];
  if (constraints.length > 0) {
    if (!sections.constraints?.trim()) {
      return { ok: false, reason: "missing section: ## Constraints" };
    }
    for (const c of constraints) {
      const normalized = c.trim().replace(/\s+/g, " ");
      if (!normalized) continue;
      // 整块精确匹配（容忍空白差异），非关键词命中
      const normalizedSummary = trimmed.replace(/\s+/g, " ");
      if (!normalizedSummary.includes(normalized)) {
        return {
          ok: false,
          reason: `constraint not preserved verbatim: ${normalized.slice(0, 80)}`,
        };
      }
    }
  }

  // ── 实体层：锚点 verbatim 存活（抽样校验）──
  const anchors =
    opts?.originalMessages && opts.originalMessages.length > 0
      ? extractEntityAnchors(opts.originalMessages)
      : [];
  if (anchors.length > 0) {
    // 关键锚点必须存活；全部锚点抽样（最多校验 12 个，防长日志误杀）
    const sample = anchors.slice(0, 12);
    const missing = sample.filter(
      (a) => !trimmed.includes(a) && !a.includes(" "),
    );
    if (missing.length > 0 && missing[0] !== undefined) {
      return {
        ok: false,
        reason: `entity anchor lost: ${missing[0].slice(0, 80)}`,
      };
    }
  }

  return { ok: true };
}

/**
 * 计算压缩节省比例。
 *
 * 公式：(压缩前 token - 压缩后 token) / 压缩前 token
 * 返回 0~1 之间的值。当 beforeTokens <= 0 时返回 0，防御除零错误。
 */
export function compressionSavingsRatio(
  beforeTokens: number,
  afterTokens: number,
): number {
  if (beforeTokens <= 0) return 0;
  return (beforeTokens - afterTokens) / beforeTokens;
}

/**
 * 判断压缩是否达到最低节省阈值（规则层，20-80% 区间）。
 *
 * @param beforeTokens  压缩前的 token 数
 * @param afterTokens   压缩后的 token 数
 * @param minRatio      最低节省比例，默认使用 MIN_COMPRESSION_SAVINGS_RATIO
 */
export function meetsCompressionSavingsThreshold(
  beforeTokens: number,
  afterTokens: number,
  minRatio = MIN_COMPRESSION_SAVINGS_RATIO,
): boolean {
  const ratio = compressionSavingsRatio(beforeTokens, afterTokens);
  return ratio >= minRatio && ratio <= MAX_COMPRESSION_SAVINGS_RATIO;
}
