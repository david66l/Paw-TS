/**
 * 记忆反射器（Memory Reflector）——周期性的后台记忆去重与归档模块。
 *
 * ## 模块职责
 *
 * 在 AI Agent 运行过程中，自动记忆模块（AutoMemoryStore）会持续从对话中提取并存储
 * 事实性记忆条目。随着时间推移，这些条目会累积重复信息（同一事实被多次提取但措辞
 * 不同）、过期信息（已修复的 bug、已废弃的特性等）以及相互矛盾的表述。
 *
 * 本模块通过调用辅助 LLM 模型周期性地审查记忆目录，自动执行以下操作：
 * 1. **合并重复**（merge）——识别描述同一事实但措辞不同的条目，保留最新的一条
 * 2. **归档过期**（archive）——将已过时的记忆条目移至归档文件
 * 3. **标记冲突**（conflicts）——标记存在矛盾的两条记忆，不自动解决
 *
 * ## 触发机制
 *
 * 每次记忆提取后调用 shouldRunReflection()，计数器递增。当达到 20 次提取后触发一次
 * 反射周期。计数器状态持久化在 `.reflection_state.json` 中，进程重启后不丢失。
 *
 * ## 关键设计决策
 *
 * - **辅助模型而非主模型**：反射使用独立的 `complete` 函数，通常由更轻量（更便宜）
 *   的模型执行，避免消耗主模型配额
 * - **只传元数据不传全文**：构建给 LLM 的 catalog 只包含 name/type/priority/description
 *   等元数据，不包含完整 content，以控制 token 消耗
 * - **容错设计**：LLM 返回的 JSON 解析失败时返回空计划（不做任何修改），避免因
 *   模型输出格式异常导致数据损坏
 * - **合并时读取-修改-写回**：每合并一个条目后重新从 store 读取 keeper，确保多次
 *   合并的结果能正确累积
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { atomicWrite } from "@paw/core";
import path from "node:path";
import type { AutoMemoryStore } from "./auto-memory.js";
import { archiveEntryByName } from "./memory-archive.js";

/** 反射状态：记录自上次反射以来的提取次数和上次反射时间戳 */
export interface ReflectionState {
  /** 自上次反射以来的记忆提取总次数 */
  extractionCount: number;
  /** 上次反射发生的时间戳（毫秒） */
  lastReflectionAt: number;
}

/** 每隔 N 次记忆提取触发一次反射 */
const REFLECTION_INTERVAL = 20;

/** 从 `.reflection_state.json` 文件中加载反射状态 */
function loadReflectionState(memoryDir: string): ReflectionState {
  const statePath = path.join(memoryDir, ".reflection_state.json");
  try {
    if (existsSync(statePath)) {
      const raw = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<ReflectionState>;
      return {
        extractionCount: raw.extractionCount ?? 0,
        lastReflectionAt: raw.lastReflectionAt ?? 0,
      };
    }
  } catch {
    // 文件损坏或格式错误 —— 重置为零
  }
  return { extractionCount: 0, lastReflectionAt: 0 };
}

/** 将反射状态持久化到 `.reflection_state.json` 文件中 */
function saveReflectionState(memoryDir: string, state: ReflectionState): void {
  mkdirSync(memoryDir, { recursive: true });
  atomicWrite(
    path.join(memoryDir, ".reflection_state.json"),
    JSON.stringify(state, null, 2),
  );
}

/**
 * 递增提取计数器，并判断是否应该执行反射。
 *
 * 每次记忆提取后调用此函数。当计数器达到 REFLECTION_INTERVAL 时返回 true，
 * 同时重置计数器并更新最后反射时间戳。
 */
export function shouldRunReflection(memoryDir: string): boolean {
  const state = loadReflectionState(memoryDir);
  state.extractionCount++;
  const shouldRun = state.extractionCount >= REFLECTION_INTERVAL;
  if (shouldRun) {
    state.extractionCount = 0;
    state.lastReflectionAt = Date.now();
  }
  saveReflectionState(memoryDir, state);
  return shouldRun;
}

/** 手动重置反射计数器（例如在手动触发反射后调用） */
export function resetReflectionCounter(memoryDir: string): void {
  saveReflectionState(memoryDir, { extractionCount: 0, lastReflectionAt: Date.now() });
}

// ── 反射计划类型定义 ─────────────────────────────────────────────────

/** 合并操作：保留 keep 条目，删除 remove 列表中的条目 */
export interface ReflectionMergeAction {
  readonly keep: string;
  readonly remove: readonly string[];
  readonly reason: string;
}

/** 归档操作：将指定条目移至归档 */
export interface ReflectionArchiveAction {
  readonly name: string;
  readonly reason: string;
}

/** 冲突标记：两条相互矛盾的条目 */
export interface ReflectionConflictAction {
  readonly a: string;
  readonly b: string;
  readonly reason: string;
}

/** LLM 生成的反射计划，包含需要执行的合并、归档和冲突标记 */
export interface ReflectionPlan {
  readonly merges: readonly ReflectionMergeAction[];
  readonly archive: readonly ReflectionArchiveAction[];
  readonly conflicts: readonly ReflectionConflictAction[];
}

// ── Prompt 构造 ──────────────────────────────────────────────────────

/** 反射任务的系统提示词，要求 LLM 仅输出 JSON */
const REFLECTION_SYSTEM =
  "You analyze a project's memory store to keep it clean. Output JSON only.";

/**
 * 构造反射提示词，将记忆目录的摘要信息格式化后嵌入 prompt。
 * 注意：只传元数据（名称、类型、优先级、描述、标签），不传完整内容，
 * 以控制 token 消耗。
 */
function buildReflectionPrompt(entries: Array<{
  name: string;
  type: string;
  priority: string;
  description: string;
  updatedAt: number;
  tags: string[];
}>): string {
  const catalog = entries
    .map((e) =>
      `- [${e.name}] type=${e.type} priority=${e.priority} updated=${new Date(e.updatedAt).toISOString().slice(0, 10)} tags=[${e.tags.join(",")}] desc="${e.description}"`,
    )
    .join("\n");

  return `Review this memory catalog and identify issues. Respond with JSON only.

## Catalog (${entries.length} entries)

${catalog}

## Actions to identify

1. **Merge duplicates** — entries describing the same fact with slightly different wording. Keep the most recently updated one, remove the older ones.

2. **Archive expired** — entries that describe obsolete facts (old bugs since fixed, deprecated features, completed one-off tasks). Priority=low entries older than 90 days are already auto-archived — focus on mid/high entries that are clearly stale.

3. **Flag conflicts** — two entries that make contradictory claims. Mark both — don't resolve.

## Output format

{
  "merges": [
    { "keep": "name-to-keep", "remove": ["dupe1", "dupe2"], "reason": "..." }
  ],
  "archive": [
    { "name": "stale-entry", "reason": "..." }
  ],
  "conflicts": [
    { "a": "entry-a", "b": "entry-b", "reason": "..." }
  ]
}

If nothing needs to change, output: { "merges": [], "archive": [], "conflicts": [] }`;
}

// ── 主反射函数 ───────────────────────────────────────────────────────

/** 反射器配置选项 */
export interface ReflectorOptions {
  /** 自动记忆存储实例 */
  readonly store: AutoMemoryStore;
  /** LLM 补全函数（使用辅助模型，通常比主模型更轻量） */
  readonly complete: (system: string, user: string) => Promise<string>;
}

/**
 * 执行一次完整的反射周期：分析记忆目录、合并重复条目、归档过期条目。
 *
 * ## 执行流程
 * 1. 从 store 读取所有记忆条目
 * 2. 构建轻量级目录（仅元数据，不含完整内容）
 * 3. 调用辅助 LLM 获取反射计划
 * 4. 执行合并操作：将待删除条目的内容合并到保留条目中
 * 5. 执行归档操作：将过期条目移至归档文件
 * 6. 如果有任何修改，重建索引
 *
 * @returns 修改的条目数量和反射计划
 */
export async function runReflection(
  opts: ReflectorOptions,
): Promise<{ modified: number; plan: ReflectionPlan }> {
  const entries = opts.store.list();

  // 构建轻量级目录（不含完整内容 —— 只传元数据以节省 token）
  const catalog = entries.map((e) => ({
    name: e.name,
    type: e.type,
    priority: e.priority ?? "mid",
    description: e.description,
    updatedAt: e.updatedAt ?? e.createdAt ?? 0,
    tags: e.tags ? [...e.tags] : [],
  }));

  // 从 LLM 获取反射计划
  let plan: ReflectionPlan;
  try {
    const response = await opts.complete(
      REFLECTION_SYSTEM,
      buildReflectionPrompt(catalog),
    );
    plan = parseReflectionPlan(response);
  } catch {
    // LLM 不可用 —— 跳过本次反射，不修改任何数据
    return { modified: 0, plan: { merges: [], archive: [], conflicts: [] } };
  }

  let modified = 0;

  // 执行合并操作
  for (const merge of plan.merges) {
    let keeper = opts.store.load(merge.keep);
    if (!keeper) continue;

    // 逐个将被删除条目的内容合并到保留条目中。
    // 每次保存后重新读取 keeper，确保后续合并操作能累积之前的变更。
    for (const removeName of merge.remove) {
      const removed = opts.store.load(removeName);
      if (!removed) continue;

      // 将 removed 中独有的内容追加到 keeper
      const mergedContent = mergeContent(keeper.content, removed.content);
      const mergedTags: string[] = mergeArrays(keeper.tags, removed.tags);
      const mergedFiles: string[] = mergeArrays(keeper.relatedFiles, removed.relatedFiles);
      const mergedErrors: string[] = mergeArrays(keeper.error_signatures, removed.error_signatures);

      keeper = {
        ...keeper,
        content: mergedContent,
        tags: mergedTags,
        relatedFiles: mergedFiles,
        error_signatures: mergedErrors,
        updatedAt: Date.now(),
      };
      opts.store.save(keeper);

      opts.store.delete(removeName);
      modified++;
    }
  }

  // 执行归档操作
  for (const archive of plan.archive) {
    if (archiveEntryByName(archive.name, opts.store.memoryDir)) {
      modified++;
    }
  }

  // 如果有任何修改，重建索引以确保后续查询能看到最新状态
  if (modified > 0) {
    opts.store.buildIndex();
  }

  return { modified, plan };
}

/**
 * 解析 LLM 返回的 JSON 响应为结构化的 ReflectionPlan。
 *
 * 容错设计：
 * - 如果响应中没有找到 JSON 对象（无花括号），返回空计划
 * - 如果 JSON 解析失败，返回空计划
 * - 过滤掉缺少必填字段的操作项（如没有 keep 的 merge，没有 name 的 archive）
 */
function parseReflectionPlan(text: string): ReflectionPlan {
  // 从响应文本中提取第一个 JSON 对象（以花括号包裹）
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { merges: [], archive: [], conflicts: [] };

  try {
    const parsed = JSON.parse(match[0]) as {
      merges?: Array<{ keep?: string; remove?: string[]; reason?: string }>;
      archive?: Array<{ name?: string; reason?: string }>;
      conflicts?: Array<{ a?: string; b?: string; reason?: string }>;
    };

    return {
      merges: (parsed.merges ?? [])
        .filter((m) => m.keep && m.remove?.length)  // 过滤掉缺少必填字段的项
        .map((m) => ({
          keep: m.keep!,
          remove: m.remove!,
          reason: m.reason ?? "",
        })),
      archive: (parsed.archive ?? [])
        .filter((a) => a.name)
        .map((a) => ({
          name: a.name!,
          reason: a.reason ?? "",
        })),
      conflicts: (parsed.conflicts ?? [])
        .filter((c) => c.a && c.b)
        .map((c) => ({
          a: c.a!,
          b: c.b!,
          reason: c.reason ?? "",
        })),
    };
  } catch {
    return { merges: [], archive: [], conflicts: [] };
  }
}

/**
 * 合并两个内容字符串，避免重复已有文本。
 *
 * 策略：如果 keeper 已包含 removed 的全部内容，则不追加；否则用分隔线
 * 将 removed 的内容追加到 keeper 末尾。
 */
function mergeContent(keeper: string, removed: string): string {
  if (!removed.trim()) return keeper;
  if (keeper.includes(removed.trim())) return keeper;
  return `${keeper.trim()}\n\n---\n\nFrom merged entry:\n\n${removed.trim()}`;
}

/**
 * 合并两个只读数组，去除重复元素。
 * 使用 Set 确保最终数组中的每个值只出现一次。
 */
function mergeArrays<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] {
  const set = new Set(a ?? []);
  if (b) for (const item of b) set.add(item);
  return [...set];
}
