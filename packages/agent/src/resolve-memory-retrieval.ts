/**
 * 记忆检索设置解析。
 * =================
 *
 * 从 `.paw/settings.local.json` 读取 memory_retrieval 模式：
 * - "keyword"：纯关键词检索（BM25，不需要 LLM）
 * - "cascade"（默认）：关键词 + DeepSeek Flash LLM 级联回退
 *   当关键词匹配置信度低时，用 LLM 从候选清单中精选最相关的 ≤5 条
 */

import type { RetrieveMemoriesOptions } from "@paw/core";
import { createDeepSeekFlashModel, type LanguageModel } from "@paw/models";

import { createLlmMemorySelectFn } from "./llm-memory-selector.js";
import { readSetting } from "./settings.js";

export interface MemoryRetrievalSettings {
  readonly mode: "keyword" | "cascade";
}

function parseMemoryRetrievalMode(value: unknown): "keyword" | "cascade" | undefined {
  if (value === "keyword" || value === "cascade") {
    return value;
  }
  return undefined;
}

/**
 * 从 `.paw/settings.local.json` 读取记忆检索模式。
 * 默认 cascade：关键词 + DeepSeek Flash LLM 低置信度回退。
 */
export function resolveMemoryRetrievalSettings(
  workspaceRoot: string,
): MemoryRetrievalSettings {
  const mode = readSetting(
    workspaceRoot,
    (s) => s.memory_retrieval,
    "cascade" as const,
    parseMemoryRetrievalMode,
  );
  return { mode };
}

export interface RetrieveMemoriesRuntime {
  readonly workspaceRoot: string;
  readonly auxiliaryModel?: LanguageModel;
  readonly signal?: AbortSignal;
}

/**
 * 将 MemoryRetrievalSettings 转换为 retrieveMemories() 可用的选项。
 *
 * cascade 模式下：
 * 1. 优先使用 DeepSeek Flash 作为 LLM 选择器（便宜且针对此任务优化）
 * 2. 回退到 auxiliaryModel
 * 3. 都没有 → 降级为纯 keyword 模式
 */
export function toRetrieveMemoriesOptions(
  settings: MemoryRetrievalSettings,
  runtime: RetrieveMemoriesRuntime,
): RetrieveMemoriesOptions {
  if (settings.mode !== "cascade") {
    return { mode: settings.mode };
  }

  const selectorModel =
    createDeepSeekFlashModel(runtime.workspaceRoot) ?? runtime.auxiliaryModel;
  if (!selectorModel) {
    return { mode: settings.mode };
  }

  return {
    mode: settings.mode,
    llmSelect: createLlmMemorySelectFn(selectorModel, runtime.signal),
  };
}
