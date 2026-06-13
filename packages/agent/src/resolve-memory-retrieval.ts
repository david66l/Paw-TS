import type { RetrieveMemoriesOptions } from "@paw/core";
import { createDeepSeekFlashModel, type LanguageModel } from "@paw/models";
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";

import { createLlmMemorySelectFn } from "./llm-memory-selector.js";

export interface MemoryRetrievalSettings {
  readonly mode: "keyword" | "cascade";
}

/**
 * Reads memory retrieval mode from `.paw/settings.local.json`.
 * Defaults to cascade (keyword + DeepSeek Flash LLM fallback on low confidence).
 */
export function resolveMemoryRetrievalSettings(
  workspaceRoot: string,
): MemoryRetrievalSettings {
  try {
    const settings = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));
    const mode = settings.memory_retrieval ?? "cascade";
    if (mode === "keyword") {
      return { mode: "keyword" };
    }
    return { mode: "cascade" };
  } catch {
    return { mode: "cascade" };
  }
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
