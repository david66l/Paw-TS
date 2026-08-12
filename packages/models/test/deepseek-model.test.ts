import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultLanguageModel } from "../src/default-model.js";
import { OpenAICompatibleModel } from "../src/openai-compatible.js";

describe("createDefaultLanguageModel with deepseek provider", () => {
  test("selects OpenAICompatibleModel when provider=deepseek", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-deepseek-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "deepseek",
        deepseek_api_key: "sk-test",
      }),
    );
    const m = createDefaultLanguageModel(dir);
    expect(m).toBeInstanceOf(OpenAICompatibleModel);
    expect((m as OpenAICompatibleModel).label).toBe("deepseek:deepseek-chat");
  });

  test("reads models.<provider> config", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-deepseek-models-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        models: {
          deepseek: {
            model: "deepseek-v4",
            apiKey: "sk-models",
            baseUrl: "https://custom.deepseek.com",
          },
        },
      }),
    );
    const m = createDefaultLanguageModel(dir) as OpenAICompatibleModel;
    expect(m.label).toBe("deepseek:deepseek-v4");
  });

  test("propagates explicit reasoning settings into runtime profile", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-deepseek-reasoning-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "deepseekEval",
        models: {
          deepseekEval: {
            model: "deepseek-v4-flash",
            apiKey: "sk-models",
            baseUrl: "https://api.deepseek.com",
            thinkingEnabled: true,
            reasoningEffort: "max",
          },
        },
      }),
    );

    const model = createDefaultLanguageModel(dir);

    expect(model.runtimeProfile).toMatchObject({
      protocol: "openai-compatible",
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
      reasoningEffort: "max",
    });
  });

  test("detects deepseek from openai key + deepseek base url", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-deepseek-compat-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        openai_api_key: "sk-test",
        openai_base_url: "https://api.deepseek.com",
      }),
    );
    const m = createDefaultLanguageModel(dir);
    expect((m as OpenAICompatibleModel).label).toBe("deepseek:deepseek-chat");
  });

  test("provider=deepseek wins over other API keys", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-deepseek-wins-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "deepseek",
        deepseek_api_key: "sk-deepseek",
        anthropic_api_key: "sk-anthropic",
        openai_api_key: "sk-openai",
      }),
    );
    const m = createDefaultLanguageModel(dir) as OpenAICompatibleModel;
    expect(m.label).toBe("deepseek:deepseek-chat");
  });
});
