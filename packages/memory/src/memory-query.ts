/**
 * 记忆查询启发式规则 —— 用于检索和注入的规则驱动提取与分类
 * Memory query heuristics — rule-based extraction and classification used by
 * retrieval and injection.
 *
 * ============================================================================
 * 模块职责 (Module Purpose)
 * ============================================================================
 * 本模块是记忆系统的"查询理解层"，负责在不调用 LLM 的情况下（纯规则驱动）：
 *
 *   1. **查询清洗**：从 goal 字符串中剥离恢复会话的上下文（background + previous
 *      goals），只保留当前用户请求用于记忆评分。
 *   2. **信号提取**：从最近的对话消息中提取文件路径、工具名称、错误信息等信号，
 *      用于后续的记忆相关性评分。
 *   3. **元查询检测**：判断用户是否在询问"关于记忆的记忆"（如"你还记得什么？"），
 *      此时应走元查询路径而非正常检索。
 *   4. **架构查询检测**：判断用户是否在询问核心 agent 架构/基础设施相关问题。
 *   5. **任务分类**：将用户任务归入四种类型之一（refactor_arch / bug_fix /
 *      simple_script / general），驱动后续的 token 预算分配。
 *   6. **辅助工具**：文件路径提取、错误签名提取、标签推断等。
 *
 * 架构定位：本模块处于"用户输入 → 记忆检索"的预处理环节，所有规则都是确定性的，
 * 零 LLM 调用，确保记忆系统的延迟可控。
 * ============================================================================
 */

import type { ChatMessage } from "@paw/core";
import {
  isToolResultMessage,
  parseToolResult,
  splitToolBlocks,
} from "@paw/core";
import type { MemoryRecord } from "./memory-record.js";

/**
 * 从 goal 字符串中剥离恢复会话的上下文（background + previous goals），
 * 使记忆检索仅针对当前用户请求进行评分。
 *
 * 背景：当对话被恢复时，goal 字符串会包含类似 "[Current user request]" 的
 * 标记，前面是之前的上下文。此函数提取标记之后的部分作为干净的查询。
 *
 * Strip resumed-session context (background + previous goals) from a goal
 * string so that memory retrieval only scores against the current user
 * request.
 */
export function extractCleanMemoryQuery(goal: string): string {
  const marker = "[Current user request]";
  const idx = goal.indexOf(marker);
  if (idx >= 0) {
    return goal.slice(idx + marker.length).trim();
  }
  return goal;
}

/**
 * 记忆检索信号：从近期对话中提取的、用于增强记忆评分的信息。
 * Memory retrieval signals extracted from recent conversation.
 */
export interface MemoryRetrievalSignals {
  /** 近期对话中出现过的文件路径 */
  readonly recentFiles: readonly string[];
  /** 近期使用过的工具名称 */
  readonly recentToolNames: readonly string[];
  /** 最近遇到的错误信息（如果有） */
  readonly errorMessage?: string;
}

/**
 * 从最近的对话消息中提取文件路径、工具名和错误信息等信号。
 *
 * 设计要点：
 * - 排除 system 角色的消息（系统提示不反映用户实际工作上下文）
 * - lookback 参数控制回溯的消息数量，默认 24 条
 * - 只记录第一个错误，避免大量重复错误信息浪费 token
 *
 * Derive path/tool/error signals from recent conversation for memory scoring.
 */
export function buildRetrievalSignalsFromMessages(
  messages: readonly ChatMessage[],
  lookback = 24,
): MemoryRetrievalSignals {
  // 过滤掉 system 消息，取最近的 lookback 条
  const recent = messages.filter((m) => m.role !== "system").slice(-lookback);
  const recentFilesSet = new Set<string>();
  const recentToolNames: string[] = [];
  let errorMessage: string | undefined;

  for (const msg of recent) {
    // 从每条消息中提取文件路径
    for (const p of extractFilePaths(msg.content)) {
      recentFilesSet.add(p);
    }
    // 只处理 user 角色的工具结果消息
    if (msg.role !== "user") continue;
    if (!isToolResultMessage(msg.content)) continue;
    // 解析每个工具结果块
    for (const block of splitToolBlocks(msg.content)) {
      const parsed = parseToolResult(block);
      if (!parsed) continue;
      recentToolNames.push(parsed.tool);
      // 只保留第一个错误信息
      if (!parsed.ok && errorMessage === undefined) {
        errorMessage = msg.content.slice(0, 500);
      }
    }
  }

  return {
    recentFiles: [...recentFilesSet],
    recentToolNames,
    errorMessage,
  };
}

/**
 * 判断用户是否在查询"关于记忆的记忆"（元查询），而非执行代码任务。
 *
 * 例如："你还记得什么？"、"有哪些 reference 记忆？"、"之前的记忆"
 * 这些查询应该走元查询路径，直接列出记忆记录，而非进行正常的记忆检索+注入。
 *
 * True when the user is asking about stored memories rather than a code task.
 */
export function isMemoryMetaQuery(goal: string): boolean {
  const g = goal.trim();
  // 中文元查询模式：记得/记不记得、什么记忆、之前的记忆
  if (
    /(?:还记得|记不记得|之前的记忆|有哪些\s*(?:reference\s*)?记忆|什么记忆|记得.*吗)/i.test(
      g,
    )
  ) {
    return true;
  }
  // "以前...记" —— "记"后面不能跟"录/录器/账/号/者"
  if (/以前.{0,8}记(?!录|录器|账|号|者)/i.test(g)) {
    return true;
  }
  // 英文元查询模式
  if (
    /\b(?:what|which|list|show)\s+(?:are\s+)?(?:my|the|all|stored)?\s*memories\b/i.test(
      g,
    )
  ) {
    return true;
  }
  if (/\bdo\s+you\s+remember\b/i.test(g)) {
    return true;
  }
  if (/\brecall\s+(?:our|the|any)\s+memories\b/i.test(g)) {
    return true;
  }
  return false;
}

/**
 * 核心架构/基础设施相关的查询关键词。
 * 这些词代表 agent 内部组件，命中时需要检索 reference 记忆。
 */
const ARCHITECTURE_QUERY_KEYWORDS = [
  "registry",
  "compactor",
  "orchestrator",
  "path-guard",
  "path guard",
  "context-manager",
  "context manager",
  "memory-retriever",
  "memory retriever",
  "memory retrieval",
] as const;

/**
 * 判断查询是否涉及核心 agent 架构/基础设施。
 * 命中时优先召回 reference 类型的记忆（架构文档、项目事实等）。
 *
 * True when the query is about core agent architecture / infrastructure.
 */
export function isArchitectureQuery(goal: string): boolean {
  const lower = goal.toLowerCase();
  return ARCHITECTURE_QUERY_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * 判断记忆记录是否为 reference 类型（架构文档、长期项目事实）。
 * Reference memories (architecture docs, long-lived project facts).
 */
export function isReferenceMemory(record: MemoryRecord): boolean {
  return record.tags.includes("reference");
}

// ── 任务分类 (B.4) ──────────────────────────────────────────────────────────
// Task classification keywords for each profile

/**
 * 重构/架构类任务的关键词。
 * 包含中英文重构相关词汇，覆盖 restructure、拆分、合并、迁移、抽象等操作。
 */
const REFACTOR_ARCH_KEYWORDS = [
  "refactor",
  "重构",
  "架构",
  "architecture",
  "design",
  "设计",
  "restructure",
  "reorganize",
  "拆分",
  "合并",
  "pattern",
  "migrate",
  "迁移",
  "abstract",
  "interface",
  "modularize",
];

/**
 * Bug 修复任务的关键词。
 * 覆盖中文"报错"、"修复"、"调试"以及英文 bug/fix/debug/error/crash 等。
 */
const BUG_FIX_KEYWORDS = [
  "bug",
  "fix",
  "repair",
  "报错",
  "修复",
  "debug",
  "调试",
  "error",
  "crash",
  "broken",
  "incorrect",
  "wrong",
  "issue",
  "defect",
  "stack trace",
  "exception",
  "regression",
];

/**
 * 简单脚本任务的关键词。
 * 标记一次性、快速、临时性的任务。
 */
const SIMPLE_SCRIPT_KEYWORDS = [
  "script",
  "脚本",
  "simple",
  "简单",
  "quick",
  "快速",
  "one-off",
  "一次性",
  "scratch",
  "temp",
];

/**
 * 任务档案类型 —— 用于记忆检索阶段动态 token 分配（B.4 流程）。
 * Task profile for dynamic token allocation in retrieval.
 *
 * - refactor_arch: 重构/架构设计（需要最多上下文）
 * - bug_fix: Bug修复（需要错误相关上下文）
 * - simple_script: 简单脚本（需要最少上下文）
 * - general: 通用任务（默认）
 */
export type TaskProfile =
  | "refactor_arch"
  | "bug_fix"
  | "simple_script"
  | "general";

/**
 * 根据 goal 文本对用户任务进行分类。
 * 纯规则驱动 —— 零 LLM 调用，确保分类延迟可忽略不计。
 *
 * 分类优先级（从高到低）：
 * 1. 有错误信息 → bug_fix
 * 2. 命中 bug 关键词 → bug_fix
 * 3. 命中简单脚本关键词 → simple_script
 * 4. 命中重构/架构关键词 → refactor_arch
 * 5. 以上都不命中 → general
 *
 * Classify the user's task from the goal text.
 * Pure rule-based — zero LLM calls.
 */
export function classifyTask(
  goal: string,
  errorMessage?: string,
): TaskProfile {
  const lower = goal.toLowerCase();

  // Bug fix: 存在错误信息或命中 bug 相关关键词时优先判定
  if (errorMessage) return "bug_fix";
  if (BUG_FIX_KEYWORDS.some((kw) => matchWord(kw, lower))) return "bug_fix";

  // Simple script: 命中简短任务标识符，且没有错误信息
  if (SIMPLE_SCRIPT_KEYWORDS.some((kw) => matchWord(kw, lower))) {
    return "simple_script";
  }

  // Refactor/architecture: 命中大规模结构性关键词
  if (REFACTOR_ARCH_KEYWORDS.some((kw) => matchWord(kw, lower))) {
    return "refactor_arch";
  }

  return "general";
}

/**
 * 以词边界感知的方式匹配关键词。
 *
 * 策略：先尝试用正则表达式的词边界匹配（适用于英文单词），
 * 如果正则构造失败或对 CJK（中日韩）文本不适用，则降级为简单的 includes 匹配。
 * CJK 字符之间本来就没有空格分隔，所以 includes 是合理的 fallback。
 *
 * Match a keyword against text with word-boundary awareness.
 */
function matchWord(keyword: string, text: string): boolean {
  // 先用词边界正则匹配；对 CJK 和多词关键词降级使用 includes
  // （因为 CJK 字符的边界不可靠）
  try {
    const re = new RegExp(
      `(?:^|[\\s\\-_.,;:!?()])${escapeRegExp(keyword)}(?:$|[\\s\\-_.,;:!?()])`,
    );
    if (re.test(text)) return true;
  } catch {
    // 正则太复杂 —— 降级到 includes
    // regex too complex — fall through
  }
  // CJK 和复合短语的 fallback
  return text.includes(keyword);
}

/**
 * 转义正则表达式中的特殊字符，防止关键词中的特殊字符破坏正则。
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 从自由文本中提取文件路径（启发式方法）。
 *
 * 匹配模式：`src/foo.ts`、`packages/core/src/bar.ts`、`./relative/path.js` 等。
 * 使用正则匹配常见的路径模式，去重后返回。
 *
 * Extract file paths from free-form text (heuristic).
 */
export function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  // 匹配常见路径模式：包含至少一个目录层级和文件扩展名
  const re =
    /(?:\.\/|[a-zA-Z0-9_-]+\/)(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    paths.push(m[0]);
    m = re.exec(text);
  }
  return [...new Set(paths)];
}

/**
 * 从完整的错误描述中提取简洁的错误签名。
 *
 * 提取策略：
 * - TypeScript 错误码（TS1234, TS12345）
 * - 异常类型名（Error, TypeError, ReferenceError 等）
 * - 包含 "cannot"/"does not"/"is not" 等关键词的前两行关键信息
 *
 * Extract concise error signatures from full error descriptions.
 */
export function extractErrorSignatures(
  errorsAndFixes?: readonly string[],
): string[] {
  if (!errorsAndFixes) return [];
  const signatures: string[] = [];

  for (const text of errorsAndFixes) {
    // 提取 TypeScript 错误码: TS1234, TS12345
    const tsCodes = text.match(/TS\d{4,5}/g);
    if (tsCodes) signatures.push(...tsCodes);

    // 提取异常类型名
    const exceptions = text.match(
      /\b(Error|TypeError|ReferenceError|SyntaxError|RangeError)\b/g,
    );
    if (exceptions) signatures.push(...exceptions);

    // 提取关键错误行（前 2 行看起来像错误的行），截断到 80 字符
    const keyLines = text
      .split("\n")
      .filter((l) =>
        /cannot|does not|is not|failed|undefined|null/.test(l.toLowerCase()),
      )
      .slice(0, 2);
    for (const line of keyLines) {
      const normalized = line.trim().slice(0, 80);
      if (normalized) signatures.push(normalized);
    }
  }

  return [...new Set(signatures)];
}

/**
 * 从会话记忆内容中推断标签（使用关键词启发式）。
 *
 * 将 task、currentState、errorsAndFixes 拼接后，在文本中搜索特定关键词
 * 来判定应打上哪些标签。标签用于记忆检索时的过滤和加权。
 *
 * Infer tags from session memory content using keyword heuristics.
 */
export function inferTags(sm: {
  readonly task?: string;
  readonly currentState?: string;
  readonly errorsAndFixes?: readonly string[];
}): string[] {
  const tags = new Set<string>();
  // 拼合所有文本字段并转为小写
  const text = [sm.task, sm.currentState, ...(sm.errorsAndFixes ?? [])]
    .join(" ")
    .toLowerCase();

  // 各领域关键词命中即打标
  if (text.includes("bug") || text.includes("fix") || text.includes("error"))
    tags.add("bug");
  if (text.includes("refactor")) tags.add("refactor");
  if (text.includes("test") || text.includes("spec")) tags.add("testing");
  if (text.includes("api") || text.includes("endpoint")) tags.add("api");
  if (
    text.includes("perf") ||
    text.includes("performance") ||
    text.includes("slow")
  )
    tags.add("performance");
  if (text.includes("typescript") || text.includes("type "))
    tags.add("typescript");
  if (text.includes("react") || text.includes("component"))
    tags.add("frontend");
  if (text.includes("memory") || text.includes("context")) tags.add("memory");
  if (text.includes("build") || text.includes("compile")) tags.add("build");
  if (text.includes("lint") || text.includes("format")) tags.add("lint");

  return [...tags];
}
