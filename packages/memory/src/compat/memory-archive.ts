/**
 * memory-archive — 自动记忆归档模块
 *
 * 【模块职责】
 * 管理 paw-ts 记忆系统中"过期记忆"的归档流程，包括：
 * - 将单个记忆条目文件从 memoryDir/ 移动到 memoryDir/archive/
 * - 判断记忆条目是否应被归档（按优先级 + 时间过期规则）
 * - 批量归档所有过期条目
 * - 重建归档目录的可浏览索引文件
 *
 * 【为什么需要归档机制】
 * 记忆系统持续运行会积累大量记忆文件。如果不归档旧/低价值记忆：
 * 1. 记忆目录文件过多，内存索引和查找性能下降
 * 2. LLM 上下文窗口被低价值历史记忆占据
 * 3. 用户无法有效管理长期记忆的质量
 *
 * 归档不是删除——被归档的记忆仍可通过 archive/ 目录访问，
 * 但不再参与活跃记忆索引和上下文组装。
 *
 * 【设计决策】
 * - 归档 = 物理文件移动（rename），而非复制——简单、原子、零额外存储
 * - 两套过期规则：低优先级 + 时间戳（默认 90 天）和显式 valid_until
 * - 归档索引（MEMORY.md）仅记录数量，不做全文索引——保持简单
 * - 所有文件操作容错（best-effort），失败时静默忽略不抛异常
 *
 * Archive operations for auto-memory.
 *
 * Centralises the physical move from `memoryDir/` to `memoryDir/archive/`
 * and the archive's own browseable index.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { atomicWrite } from "@paw/core";
import type { AutoMemoryEntry } from "./auto-memory.js";
import { kindFromLegacyType } from "../shared/memory-types.js";

/**
 * 默认最大存活天数：低优先级记忆条目超过此天数后自动归档
 *
 * 90 天是一个平衡选择：
 * - 足够长，不会丢失近期可能有用的上下文
 * - 足够短，防止大量无用记忆堆积
 */
const DEFAULT_MAX_AGE_DAYS = 90;

/**
 * 获取归档目录的物理路径（memoryDir/archive）
 *
 * @param memoryDir - 记忆模块的根目录路径
 * @returns 归档目录的绝对路径
 */
export function archiveDirFor(memoryDir: string): string {
  return path.join(memoryDir, "archive");
}

/**
 * 将单个记忆条目文件移动到归档目录
 *
 * 物理操作：memoryDir/{name}.md → memoryDir/archive/{name}.md
 * 如果目录不存在则自动创建（mkdir recursive）
 *
 * @param name - 记忆条目的名称（不含 .md 扩展名）
 * @param memoryDir - 记忆模块根目录
 * @returns 如果文件存在并成功移动返回 true，文件不存在返回 false
 *
 * Move a single entry file into the archive directory.
 * Returns true if the file existed and was moved.
 */
export function archiveEntryByName(name: string, memoryDir: string): boolean {
  const archiveDir = archiveDirFor(memoryDir);
  // 确保归档目录存在（recursive 确保父目录一并创建）
  mkdirSync(archiveDir, { recursive: true });
  const src = path.join(memoryDir, `${name}.md`);
  const dst = path.join(archiveDir, `${name}.md`);

  // 文件不存在时返回 false，由调用方决定是否记录警告
  if (!existsSync(src)) return false;

  // rename 是原子操作（同文件系统内），不会出现中间状态
  renameSync(src, dst);
  return true;
}

/**
 * 判断记忆条目是否满足归档条件
 *
 * 归档规则（满足任一即归档）：
 * 1. 低优先级条目：priority 为 "low"，且距上次更新/创建超过 maxAgeDays 天
 * 2. 显式过期：valid_until 时间戳已过当前时间
 *
 * @param entry - 记忆条目
 * @param now - 当前时间戳（毫秒），由调用方传入以保证幂等
 * @param maxAgeDays - 低优先级条目的最大存活天数，默认 90
 * @returns 是否应被归档
 *
 * Decide whether an entry should be archived.
 *
 * Rules:
 *   - low-priority entries older than `maxAgeDays`
 *   - any entry whose `valid_until` timestamp has passed
 */
export function shouldArchiveEntry(
  entry: AutoMemoryEntry,
  now: number,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  /** 按优先级自定义过期天数。未设置时保持旧行为：仅 low 优先级受 age 规则影响。 */
  ttlByPriority?: { readonly high?: number; readonly mid?: number; readonly low?: number },
): boolean {
  if (isProtectedUserPreference(entry)) return false;

  // 规则 1：按优先级 TTL 过期
  // 保持向后兼容：未设置 ttlByPriority 时，仅 low 优先级受 age 规则影响
  const priority = entry.priority ?? "mid";
  if (ttlByPriority) {
    // 新行为：按优先级查 TTL，high 可设 Infinity 永不过期
    const days = ttlByPriority[priority];
    if (days !== undefined && Number.isFinite(days)) {
      const cutoff = now - days * 24 * 60 * 60 * 1000;
      const ts = entry.updatedAt ?? entry.createdAt;
      if (ts !== undefined && ts <= cutoff) return true;
    }
  } else {
    // 旧行为：仅 low 优先级受全局 maxAgeDays 影响
    if (priority === "low") {
      const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
      const ts = entry.updatedAt ?? entry.createdAt;
      if (ts !== undefined && ts <= cutoff) return true;
    }
  }

  // 规则 2：显式有效期已过
  if (
    entry.valid_until !== undefined &&
    entry.valid_until > 0 &&
    now > entry.valid_until
  ) {
    return true;
  }

  return false;
}

function isProtectedUserPreference(entry: AutoMemoryEntry): boolean {
  const kind = entry.kind ?? kindFromLegacyType(entry.type);
  return kind === "user_preference" && (entry.confidence ?? 0.7) >= 0.8;
}

/**
 * 批量归档所有过期条目
 *
 * 遍历全部记忆条目，对每个满足归档条件的条目执行物理移动操作。
 *
 * @param entries - 全部记忆条目列表
 * @param memoryDir - 记忆模块根目录
 * @param maxAgeDays - 低优先级条目的最大存活天数
 * @returns 被成功归档的条目名称列表
 *
 * Archive all expired entries and return the names that were moved.
 */
export function archiveExpiredEntries(
  entries: readonly AutoMemoryEntry[],
  memoryDir: string,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  ttlByPriority?: { readonly high?: number; readonly mid?: number; readonly low?: number },
): { archivedNames: readonly string[] } {
  const now = Date.now();
  const archivedNames: string[] = [];

  for (const entry of entries) {
    if (shouldArchiveEntry(entry, now, maxAgeDays, ttlByPriority)) {
      if (archiveEntryByName(entry.name, memoryDir)) {
        archivedNames.push(entry.name);
      }
    }
  }

  return { archivedNames };
}

/**
 * 重建归档索引文件
 *
 * 在 memoryDir/archive/MEMORY.md 中写入简单的归档统计信息。
 * 该文件帮助用户快速了解归档中有多少历史记忆条目。
 *
 * 设计为 best-effort：文件系统错误会被静默吞掉。
 * 归档操作不应因索引重建失败而中断。
 *
 * @param memoryDir - 记忆模块根目录
 *
 * Rebuild `memoryDir/archive/MEMORY.md` with a simple count of archived entries.
 * Best-effort: swallows filesystem errors.
 */
export function rebuildArchiveIndex(memoryDir: string): void {
  const archiveDir = archiveDirFor(memoryDir);

  // 归档目录不存在则不操作（尚未进行过任何归档）
  if (!existsSync(archiveDir)) return;

  try {
    // 统计归档目录中的 .md 文件数量（排除索引自身）
    const archiveEntries = readdirSync(archiveDir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .length;

    // 写入简化的索引文件
    atomicWrite(
      path.join(archiveDir, "MEMORY.md"),
      `# Archive Index\n\nArchived entries: ${archiveEntries}\n\n`,
    );
  } catch {
    // best-effort：索引写入失败不应影响主流程
    // best-effort
  }
}
