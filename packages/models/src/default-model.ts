import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";

import { AnthropicCompatibleModel } from "./anthropic-compatible.js";
import { FakeLanguageModel } from "./fake-model.js";
import type { LanguageModel } from "./language-model.js";
import { OpenAICompatibleModel } from "./openai-compatible.js";

/** Pick a real model from settings when possible; otherwise fake (offline-safe). */
export function createDefaultLanguageModel(
  workspaceRoot: string,
): LanguageModel {
  try {
    const path = defaultSettingsPath(workspaceRoot);
    const s = loadPawSettingsLocal(path);

    // Prefer explicit provider setting, then Anthropic key, then OpenAI key.
    const provider = s.provider?.trim().toLowerCase();

    const anthropicKey = s.anthropic_api_key?.trim();
    if (anthropicKey && provider !== "openai") {
      const model = (s.model?.trim() || "claude-3-5-sonnet-20241022") as string;
      return new AnthropicCompatibleModel({
        apiKey: anthropicKey,
        baseUrl: s.anthropic_base_url?.trim(),
        model,
      });
    }

    const openaiKey = s.openai_api_key?.trim();
    if (openaiKey && provider !== "anthropic") {
      const model = (s.model?.trim() || "gpt-4o-mini") as string;
      return new OpenAICompatibleModel({
        apiKey: openaiKey,
        baseUrl: s.openai_base_url?.trim(),
        model,
      });
    }
  } catch {
    /* missing or invalid settings — fall back */
  }
  return new FakeLanguageModel();
}
