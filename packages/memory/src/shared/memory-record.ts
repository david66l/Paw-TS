/**
 * 统一记忆记录（Unified Memory Record）——所有记忆类型的通用接口。
 *
 * ## 模块定位
 *
 * 本模块定义了整个记忆系统的核心数据结构 MemoryRecord，以及将不同来源的记忆
 *（SessionMemory、AutoMemoryEntry、ProjectMemory）映射为统一格式的转换函数。
 *
 * ## 为什么需要统一记录格式
 *
 * 系统中存在多种记忆来源：
 * - SessionMemory: 会话级别的记忆（一次对话中的关键决策、错误修复等）
 * - AutoMemoryEntry: 自动持久化的记忆（从 YAML frontmatter 文件中读取）
 * - ProjectMemory: 项目级别的显式记忆
 *
 * 这些来源的数据结构各不相同，但检索和注入时需要统一处理。
 * MemoryRecord 提供了"单一真相来源"的数据结构，让打分器、选择器、注入器
 * 都面向同一个接口编程，无需关心数据的具体来源。
 *
 * ## 关键设计决策
 *
 * - 所有字段均为 readonly：记忆一旦创建不可变，避免并发修改导致的不一致
 * - 优先级（priority）通过乘法系数影响检索得分，而非硬性排序
 * - embedding 字段可选：只有 AutoMemory 可能携带预计算的 embedding 向量
 * - relatedErrors 存储的是错误签名（error signatures）而非完整描述，
 *   这样可以在检索时做精确匹配而非模糊语义匹配
 * - validUntil 支持记忆过期机制：0 表示永不过期
 * - linkedMemories 支持记忆间的双向链接，构建知识图谱
 */

import type { LegacyMemoryRecordV1, MemoryPriority } from "@paw/protocol";
import type { AutoMemoryEntry } from "../compat/auto-memory.js";
import type { SessionMemory } from "../session/session-memory.js";
import { EmbeddingCache } from "./embedding-cache.js";
import {
  extractErrorSignatures,
  extractFilePaths,
  inferTags,
} from "./memory-query.js";
import { kindFromLegacyType } from "./memory-types.js";

export type {
  LegacyMemoryRecordV1,
  MemoryPriority,
  MemoryScope,
  MemorySource,
  TaskProfile,
} from "@paw/protocol";

/** @deprecated WP1a compatibility alias. */
export type MemoryRecord = LegacyMemoryRecordV1;

/**
 * 优先级乘法系数映射表。
 *
 * 在 memory-scorer 中，每条记忆的基础得分会乘以此系数，
 * 实现对高优先级记忆的加权提升和对低优先级记忆的降权。
 * 设计为乘法而非加法，是为了保证系数在不同基数得分下的一致性。
 */
export const PRIORITY_COEFFICIENTS: Record<MemoryPriority, number> = {
  high: 1.3,
  mid: 1.0,
  low: 0.7,
};

// ── 映射函数（Mappers）──
// 以下两个函数分别将 SessionMemory 和 AutoMemoryEntry 映射为统一的 MemoryRecord

/**
 * 将 SessionMemory 转换为 MemoryRecord。
 *
 * 转换逻辑：
 * - id 使用 session ID（便于去重和排除当前会话）
 * - title 使用 session 的 task 字段，回退到 "Untitled session"
 * - content 将多个字段拼接为一段完整文本（task + currentState + keyDecisions + errorsAndFixes + relevantContext）
 * - tags 通过 inferTags 从 session 文本中自动推断
 * - relatedErrors 从 errorsAndFixes 中提取错误签名而非完整描述
 * - priority 固定为 "mid"（会话记忆默认中等优先级）
 */
export function sessionMemoryToRecord(sm: SessionMemory): LegacyMemoryRecordV1 {
  return {
    id: sm.session,
    source: "session",
    scope: "project",
    createdAt: sm.updatedAt,
    updatedAt: sm.updatedAt,
    title: sm.task ?? "Untitled session",
    summary: sm.currentState ?? "",
    // 将多个字段拼接为完整内容文本，过滤空值后以换行符连接
    content: [
      sm.task,
      sm.currentState,
      ...(sm.keyDecisions ?? []),
      ...(sm.errorsAndFixes ?? []),
      sm.relevantContext,
    ]
      .filter((x): x is string => !!x)
      .join("\n"),
    tags: inferTags(sm),
    relatedFiles: sm.filesAndFunctions ?? [],
    // 从错误修复记录中提取错误签名（错误码、异常类名等），而非完整描述
    relatedErrors: extractErrorSignatures(sm.errorsAndFixes),
    priority: "mid",
    kind: "task_episode",
    confidence: 0.7,
    status: "active",
    evidence: [],
    toolsUsed: [],
    validUntil: 0,
    linkedMemories: [],
  };
}

/**
 * 将 AutoMemoryEntry 转换为 MemoryRecord。
 *
 * 转换逻辑：
 * - id 使用 entry.name（即文件名，不含扩展名）
 * - embedding 需要从 base64 编码的字符串解码为 number[]（通过 EmbeddingCache）
 * - createdAt/updatedAt 优先使用 entry 中的值，回退到 mtime 或当前时间
 * - tags 回退到 [entry.type]（至少有一个类型标签）
 * - relatedFiles 优先使用 entry 中的值，否则从 content 中提取文件路径
 */
export function autoMemoryToRecord(
  entry: AutoMemoryEntry,
  mtime?: number,
): LegacyMemoryRecordV1 {
  // 基准时间戳：优先使用 mtime，回退到当前时间
  const ts = mtime ?? Date.now();

  // 解码 embedding 向量（base64 → number[]）
  let embedding: number[] | undefined;
  if (entry.embedding) {
    embedding = EmbeddingCache.decodeEmbedding(entry.embedding) ?? undefined;
  }

  return {
    id: entry.name,
    source: "auto",
    scope: "project",
    createdAt: entry.createdAt ?? ts,
    updatedAt: entry.updatedAt ?? ts,
    title: entry.name,
    summary: entry.description,
    content: entry.content,
    // tags 默认值：如果 entry 没有指定 tags，至少用 type 作为标签
    tags: entry.tags ?? [entry.type],
    // relatedFiles 默认值：如果 entry 没有指定，从 content 中自动提取文件路径
    relatedFiles: entry.relatedFiles ?? extractFilePaths(entry.content),
    relatedErrors: entry.error_signatures ?? [],
    priority: entry.priority ?? "mid",
    kind: entry.kind ?? kindFromLegacyType(entry.type),
    confidence: entry.confidence ?? 0.7,
    status: entry.status ?? "active",
    evidence: entry.evidence ?? [],
    ...(entry.gitCommit ? { gitCommit: entry.gitCommit } : {}),
    ...(entry.branch ? { branch: entry.branch } : {}),
    ...(entry.symbols ? { symbols: entry.symbols } : {}),
    ...(entry.tests ? { tests: entry.tests } : {}),
    ...(entry.supersedes ? { supersedes: entry.supersedes } : {}),
    toolsUsed: entry.tools_used ?? [],
    validUntil: entry.valid_until ?? 0,
    linkedMemories: entry.linked_memories ?? [],
    // 仅当 embedding 有效时才包含该字段（避免 undefined 污染对象）
    ...(embedding ? { embedding } : {}),
  };
}

// ── 查询启发式函数的重导出（Query Heuristics Re-exports）──
// 这些函数来自 memory-query.ts，在此重新导出以提供统一的 import 入口
// 调用方只需 import from "./memory-record.js" 即可获取所有记忆查询相关功能

export {
  classifyTask,
  extractCleanMemoryQuery,
  extractErrorSignatures,
  extractFilePaths,
  inferTags,
  isArchitectureQuery,
  isMemoryMetaQuery,
  isReferenceMemory,
  buildRetrievalSignalsFromMessages,
  type MemoryRetrievalSignals,
} from "./memory-query.js";

export {
  buildConversationAwareQuery,
  cleanMemoryTitle,
  extractExplicitRememberText,
  hasDurableMemorySignal,
  isDecisionStep,
  isLowValueChitchat,
  isSystemFinalizeMessage,
  isWorthWritingLongTermMemory,
  shouldWriteTaskSummary,
  tokenizeForMemoryScore,
  type MemoryWriteSignalInput,
} from "./memory-quality.js";
