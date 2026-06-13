import {
  type CredentialProvider,
  defaultSettingsPath,
  hasApiKey,
  loadPawSettingsLocal,
  resolveApiKey,
  resolveBaseUrl,
  resolveModel,
} from "@paw/settings";

import { AnthropicCompatibleModel } from "./anthropic-compatible.js";
import { FakeLanguageModel } from "./fake-model.js";
import type { LanguageModel, ModelCapabilities } from "./language-model.js";
import { OpenAICompatibleModel } from "./openai-compatible.js";

/** Well-known model context windows. Ordered from longest to shortest for prefix matching. */
const KNOWN_CAPABILITIES: Array<{ pattern: RegExp; caps: ModelCapabilities }> =
  [
    // Anthropic
    {
      pattern: /claude-3[.-]5-sonnet|claude-sonnet-4/i,
      caps: { contextWindow: 200_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /claude-3[.-]5-haiku|claude-haiku/i,
      caps: { contextWindow: 200_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /claude-opus/i,
      caps: { contextWindow: 200_000, maxOutputTokens: 32_768 },
    },
    { pattern: /claude/i, caps: { contextWindow: 200_000 } },
    // OpenAI
    {
      pattern: /gpt-4o|gpt-4[.]1/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 16_384 },
    },
    {
      pattern: /gpt-4[.-]turbo/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 4_096 },
    },
    {
      pattern: /o1|o3|o4/i,
      caps: { contextWindow: 200_000, maxOutputTokens: 100_000 },
    },
    {
      pattern: /gpt-3[.]5/i,
      caps: { contextWindow: 16_385, maxOutputTokens: 4_096 },
    },
    // DeepSeek — V4 models: 1M context (must precede generic /deepseek/i)
    {
      pattern: /deepseek-v4|deepseek\/v4/i,
      caps: { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
    },
    { pattern: /deepseek/i, caps: { contextWindow: 64_000 } },
    // Qwen — DashScope / OpenAI-compatible
    {
      pattern: /qwen-max|qwen-turbo|qwen-plus|qwen2\.5/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    },
    // Ollama common models
    {
      pattern: /llama3/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /qwen2\.5/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /deepseek-r1/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /codellama/i,
      caps: { contextWindow: 16_384, maxOutputTokens: 4_096 },
    },
    {
      pattern: /mistral/i,
      caps: { contextWindow: 32_768, maxOutputTokens: 4_096 },
    },
    {
      pattern: /phi[34]/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 4_096 },
    },
  ];

function resolveCapabilities(modelId: string): ModelCapabilities {
  for (const { pattern, caps } of KNOWN_CAPABILITIES) {
    if (pattern.test(modelId)) return caps;
  }
  return { contextWindow: 32_768 };
}

type ClientType = "anthropic" | "openai";

interface ProviderEntry {
  readonly client: ClientType;
  readonly defaultModel: string;
  readonly defaultBaseUrl: string;
}

/** Single source of truth for API-key-based providers.
 *  Adding a new provider only requires updating this table + the schema.
 */
const PROVIDERS: Record<CredentialProvider, ProviderEntry> = {
  anthropic: {
    client: "anthropic",
    defaultModel: "claude-3-5-sonnet-20241022",
    defaultBaseUrl: "https://api.anthropic.com/v1",
  },
  openai: {
    client: "openai",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  qwen: {
    client: "openai",
    defaultModel: "qwen-plus",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  deepseek: {
    client: "openai",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com",
  },
};

/** Detect provider from credentials when the user did not set `provider`.
 *  Preserves backward compatibility: an OpenAI key paired with a DeepSeek
 *  base URL is resolved to the deepseek provider.
 */
function detectProvider(
  settings: ReturnType<typeof loadPawSettingsLocal>,
): CredentialProvider | undefined {
  if (hasApiKey(settings, "anthropic")) return "anthropic";
  if (hasApiKey(settings, "deepseek")) return "deepseek";
  if (hasApiKey(settings, "openai")) {
    const openaiBaseUrl = resolveBaseUrl(settings, "openai");
    if (openaiBaseUrl?.includes("deepseek")) return "deepseek";
    return "openai";
  }
  if (hasApiKey(settings, "qwen")) return "qwen";
  return undefined;
}

/** Pick a real model from settings when possible; otherwise fake (offline-safe). */
export function createDefaultLanguageModel(
  workspaceRoot: string,
): LanguageModel {
  try {
    const settingsPath = defaultSettingsPath(workspaceRoot);
    const s = loadPawSettingsLocal(settingsPath);

    // Single entry point: explicit provider wins; otherwise fall back to API keys.
    const provider = s.provider?.trim().toLowerCase();

    if (provider === "ollama") {
      const ollamaHost = s.ollama_host?.trim();
      const ollamaModel =
        (s.ollama_model as string | undefined)?.trim() || s.model?.trim();
      if (!ollamaModel) {
        console.warn(
          "[paw] provider=ollama but no model configured. Using fake model.",
        );
        return new FakeLanguageModel();
      }
      return new OpenAICompatibleModel({
        apiKey: "ollama",
        baseUrl: ollamaHost
          ? `${ollamaHost.replace(/\/$/, "")}/v1`
          : "http://localhost:11434/v1",
        model: ollamaModel,
        capabilities: resolveCapabilities(ollamaModel),
      });
    }

    const activeProvider =
      (provider as CredentialProvider | undefined) || detectProvider(s);
    if (activeProvider && activeProvider in PROVIDERS) {
      const entry = PROVIDERS[activeProvider];
      const apiKey = resolveApiKey(s, activeProvider) || "";
      const baseUrl = resolveBaseUrl(s, activeProvider) || entry.defaultBaseUrl;
      const model = resolveModel(s, activeProvider, entry.defaultModel);
      if (entry.client === "anthropic") {
        return new AnthropicCompatibleModel({
          apiKey,
          baseUrl,
          model,
          capabilities: resolveCapabilities(model),
        });
      }
      return new OpenAICompatibleModel({
        apiKey,
        baseUrl,
        model,
        capabilities: resolveCapabilities(model),
      });
    }

    // Settings loaded but no API keys configured
    console.warn(
      "[paw] Settings loaded but no API keys found. Using fake model.",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[paw] Settings unavailable (${msg}). Using fake model.`);
  }
  return new FakeLanguageModel();
}
