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
 * Reads memory retrieval mode from `.paw/settings.local.json`.
 * Defaults to cascade (keyword + DeepSeek Flash LLM fallback on low confidence).
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

export function toRetrieveMemoriesOptions(
  settings: MemoryRetrievalSettings,
  runtime: RetrieveMemoriesRuntime,
): RetrieveMemoriesOptions {
  const options: RetrieveMemoriesOptions = { mode: settings.mode };

  if (settings.mode === "cascade") {
    const selectorModel =
      createDeepSeekFlashModel(runtime.workspaceRoot) ??
      runtime.auxiliaryModel;
    if (selectorModel) {
      options.llmSelect = createLlmMemorySelectFn(
        selectorModel,
        runtime.signal,
      );
    }
  }

  return options;
}
