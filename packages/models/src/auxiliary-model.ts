import {
  defaultSettingsPath,
  hasApiKey,
  loadPawSettingsLocal,
  resolveApiKey,
  resolveBaseUrl,
} from "@paw/settings";

import type { LanguageModel } from "./language-model.js";
import { OpenAICompatibleModel } from "./openai-compatible.js";

const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";

/** Cheap auxiliary model for memory selection, compression, extraction, sub-agents. */
export function createDeepSeekFlashModel(
  workspaceRoot: string,
): LanguageModel | undefined {
  try {
    const settings = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));

    // Prefer explicit deepseek credentials, fall back to openai-compatible DeepSeek config.
    let apiKey: string | undefined;
    let baseUrl: string | undefined;
    if (hasApiKey(settings, "deepseek")) {
      apiKey = resolveApiKey(settings, "deepseek");
      baseUrl = resolveBaseUrl(settings, "deepseek");
    } else {
      apiKey = resolveApiKey(settings, "openai");
      baseUrl = resolveBaseUrl(settings, "openai");
    }
    if (!apiKey) return undefined;

    return new OpenAICompatibleModel({
      apiKey,
      baseUrl: baseUrl || "https://api.deepseek.com",
      model: DEEPSEEK_FLASH_MODEL,
      capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
    });
  } catch {
    return undefined;
  }
}
