import type { PawSettingsLocal } from "./schema.js";

/** Providers that require an API key + optional base URL. */
export type CredentialProvider = "anthropic" | "openai" | "qwen" | "deepseek";

const API_KEY_FIELDS: Record<CredentialProvider, keyof PawSettingsLocal> = {
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  qwen: "qwen_api_key",
  deepseek: "deepseek_api_key",
};

const BASE_URL_FIELDS: Record<CredentialProvider, keyof PawSettingsLocal> = {
  anthropic: "anthropic_base_url",
  openai: "openai_base_url",
  qwen: "qwen_base_url",
  deepseek: "deepseek_base_url",
};

const API_KEY_ENVS: Record<CredentialProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  qwen: "QWEN_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const BASE_URL_ENVS: Record<CredentialProvider, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  qwen: "QWEN_BASE_URL",
  deepseek: "DEEPSEEK_BASE_URL",
};

/** Resolve the model name for a provider. */
export function resolveModel(
  settings: PawSettingsLocal,
  provider: CredentialProvider,
  fallback: string,
): string {
  const fromModels = settings.models?.[provider]?.model;
  if (typeof fromModels === "string" && fromModels.trim()) {
    return fromModels.trim();
  }
  const topLevel = settings.model;
  if (typeof topLevel === "string" && topLevel.trim()) {
    return topLevel.trim();
  }
  return fallback;
}

/** Resolve API key for a provider.
 *  Resolution order:
 *    1. `models.<provider>.apiKey`
 *    2. Legacy `<provider>_api_key`
 *    3. Env var
 */
export function resolveApiKey(
  settings: PawSettingsLocal,
  provider: CredentialProvider,
): string | undefined {
  const fromModels = settings.models?.[provider]?.apiKey;
  if (typeof fromModels === "string" && fromModels.trim()) {
    return fromModels.trim();
  }
  const legacy = settings[API_KEY_FIELDS[provider]];
  if (typeof legacy === "string" && legacy.trim()) {
    return legacy.trim();
  }
  return process.env[API_KEY_ENVS[provider]]?.trim() || undefined;
}

/** Resolve base URL for a provider.
 *  Resolution order:
 *    1. `models.<provider>.baseUrl`
 *    2. Legacy `<provider>_base_url`
 *    3. Env var
 */
export function resolveBaseUrl(
  settings: PawSettingsLocal,
  provider: CredentialProvider,
): string | undefined {
  const fromModels = settings.models?.[provider]?.baseUrl;
  if (typeof fromModels === "string" && fromModels.trim()) {
    return fromModels.trim();
  }
  const legacy = settings[BASE_URL_FIELDS[provider]];
  if (typeof legacy === "string" && legacy.trim()) {
    return legacy.trim();
  }
  return process.env[BASE_URL_ENVS[provider]]?.trim() || undefined;
}

/** Return true if the provider has a usable API key (settings or env). */
export function hasApiKey(
  settings: PawSettingsLocal,
  provider: CredentialProvider,
): boolean {
  return resolveApiKey(settings, provider) !== undefined;
}

/** Return a copy of settings with all known API keys masked for display. */
export function redactSecrets(settings: PawSettingsLocal): PawSettingsLocal {
  const copy: Record<string, unknown> = { ...settings };

  // Mask nested model configs.
  if (copy.models && typeof copy.models === "object") {
    const modelsCopy: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(copy.models)) {
      if (config && typeof config === "object") {
        const cfgCopy: Record<string, unknown> = { ...config };
        if (typeof cfgCopy.apiKey === "string") {
          cfgCopy.apiKey = maskKey(cfgCopy.apiKey);
        }
        modelsCopy[name] = cfgCopy;
      } else {
        modelsCopy[name] = config;
      }
    }
    copy.models = modelsCopy;
  }

  // Mask legacy flat fields.
  for (const provider of Object.keys(API_KEY_FIELDS) as CredentialProvider[]) {
    const field = API_KEY_FIELDS[provider];
    const value = copy[field];
    if (typeof value === "string") {
      copy[field] = maskKey(value);
    }
  }

  return copy as PawSettingsLocal;
}

function maskKey(v: string): string {
  if (!v || v.length < 8) {
    return v ? "(set, hidden)" : "(not set)";
  }
  return `(set, …${v.slice(-4)})`;
}
