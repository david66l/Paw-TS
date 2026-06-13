import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultLanguageModel } from "../src/default-model.js";
import { OpenAICompatibleModel } from "../src/openai-compatible.js";

describe("createDefaultLanguageModel with qwen provider", () => {
  test("selects OpenAICompatibleModel when provider=qwen", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-qwen-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "qwen",
        qwen_api_key: "sk-test",
      }),
    );
    const m = createDefaultLanguageModel(dir);
    expect(m).toBeInstanceOf(OpenAICompatibleModel);
  });

  test("defaults model to qwen-plus", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-qwen-default-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "qwen",
        qwen_api_key: "sk-test",
      }),
    );
    const m = createDefaultLanguageModel(dir) as OpenAICompatibleModel;
    expect(m.label).toBe("qwen:qwen-plus");
  });

  test("provider=qwen wins over other API keys", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-qwen-wins-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "qwen",
        qwen_api_key: "sk-qwen",
        anthropic_api_key: "sk-anthropic",
        openai_api_key: "sk-openai",
      }),
    );
    const m = createDefaultLanguageModel(dir) as OpenAICompatibleModel;
    expect(m.label).toBe("qwen:qwen-plus");
  });

  test("falls back to qwen when only qwen_api_key is set", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-qwen-key-only-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        qwen_api_key: "sk-qwen",
      }),
    );
    const m = createDefaultLanguageModel(dir) as OpenAICompatibleModel;
    expect(m.label).toBe("qwen:qwen-plus");
  });
});
