import { describe, expect, test } from "bun:test";

import {
  hasApiKey,
  redactSecrets,
  resolveApiKey,
  resolveBaseUrl,
  resolveModel,
} from "../src/credentials.js";
import type { PawSettingsLocal } from "../src/schema.js";

describe("credentials", () => {
  test("resolveApiKey reads models.<provider>.apiKey first", () => {
    const settings: PawSettingsLocal = {
      models: {
        openai: { apiKey: "sk-nested" },
      },
      openai_api_key: "sk-legacy",
    };
    expect(resolveApiKey(settings, "openai")).toBe("sk-nested");
  });

  test("resolveApiKey falls back to legacy flat field", () => {
    const settings: PawSettingsLocal = {
      openai_api_key: "sk-legacy",
    };
    expect(resolveApiKey(settings, "openai")).toBe("sk-legacy");
  });

  test("resolveApiKey falls back to env var", () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    const settings: PawSettingsLocal = {};
    expect(resolveApiKey(settings, "openai")).toBe("sk-from-env");
    delete process.env.OPENAI_API_KEY;
  });

  test("models key wins over env var", () => {
    process.env.QWEN_API_KEY = "sk-env";
    const settings: PawSettingsLocal = {
      models: { qwen: { apiKey: "sk-models" } },
    };
    expect(resolveApiKey(settings, "qwen")).toBe("sk-models");
    delete process.env.QWEN_API_KEY;
  });

  test("resolveBaseUrl reads models.<provider>.baseUrl first", () => {
    const settings: PawSettingsLocal = {
      models: {
        deepseek: { baseUrl: "https://custom.deepseek.com" },
      },
      deepseek_base_url: "https://legacy.deepseek.com",
    };
    expect(resolveBaseUrl(settings, "deepseek")).toBe(
      "https://custom.deepseek.com",
    );
  });

  test("resolveBaseUrl falls back to legacy flat field", () => {
    const settings: PawSettingsLocal = {
      qwen_base_url: "https://legacy.dashscope.com",
    };
    expect(resolveBaseUrl(settings, "qwen")).toBe("https://legacy.dashscope.com");
  });

  test("resolveBaseUrl falls back to env var", () => {
    process.env.DEEPSEEK_BASE_URL = "https://env.deepseek.com";
    const settings: PawSettingsLocal = {};
    expect(resolveBaseUrl(settings, "deepseek")).toBe("https://env.deepseek.com");
    delete process.env.DEEPSEEK_BASE_URL;
  });

  test("resolveModel prefers models.<provider>.model", () => {
    const settings: PawSettingsLocal = {
      provider: "deepseek",
      model: "top-level-model",
      models: {
        deepseek: { model: "deepseek-v4" },
      },
    };
    expect(resolveModel(settings, "deepseek", "fallback")).toBe("deepseek-v4");
  });

  test("resolveModel falls back to top-level model", () => {
    const settings: PawSettingsLocal = {
      provider: "deepseek",
      model: "top-level-model",
    };
    expect(resolveModel(settings, "deepseek", "fallback")).toBe("top-level-model");
  });

  test("hasApiKey returns false when missing", () => {
    const settings: PawSettingsLocal = {};
    expect(hasApiKey(settings, "openai")).toBeFalse();
  });

  test("hasApiKey returns true for models key", () => {
    const settings: PawSettingsLocal = {
      models: { anthropic: { apiKey: "sk-ant" } },
    };
    expect(hasApiKey(settings, "anthropic")).toBeTrue();
  });

  test("redactSecrets masks model configs and legacy keys", () => {
    const settings: PawSettingsLocal = {
      models: {
        deepseek: { apiKey: "sk-deepseek-secret", baseUrl: "https://api.deepseek.com" },
      },
      qwen_api_key: "sk-qwen-secret",
      model: "gpt-4o",
    };
    const redacted = redactSecrets(settings);
    const models = redacted.models as Record<string, { apiKey: unknown; baseUrl?: string }>;
    expect(models.deepseek?.apiKey).toContain("…");
    expect(models.deepseek?.apiKey).not.toContain("deepseek-secret");
    expect(models.deepseek?.baseUrl).toBe("https://api.deepseek.com");
    expect(redacted.qwen_api_key).toContain("…");
    expect(redacted.qwen_api_key).not.toContain("qwen-secret");
    expect(redacted.model).toBe("gpt-4o");
  });
});
