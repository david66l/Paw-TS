import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultLanguageModel } from "../src/default-model.js";
import { OpenAICompatibleModel } from "../src/openai-compatible.js";
import { FakeLanguageModel } from "../src/fake-model.js";

describe("createDefaultLanguageModel settings fallback", () => {
  test("uses process.cwd() settings when workspace has none", () => {
    // project root (cwd when tests run from monorepo) should already have settings
    // with deepseek; if not, create an isolated cwd-like scenario via chdir
    const emptyWs = mkdtempSync(path.join(tmpdir(), "paw-ws-empty-"));
    const settingsHome = mkdtempSync(path.join(tmpdir(), "paw-settings-home-"));
    mkdirSync(path.join(settingsHome, ".paw"), { recursive: true });
    writeFileSync(
      path.join(settingsHome, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "deepseek",
        deepseek_api_key: "sk-fallback-test",
        deepseek_model: "deepseek-chat",
      }),
    );

    const prev = process.cwd();
    try {
      process.chdir(settingsHome);
      const m = createDefaultLanguageModel(emptyWs);
      expect(m).toBeInstanceOf(OpenAICompatibleModel);
      expect(m.label).toMatch(/deepseek/i);
    } finally {
      process.chdir(prev);
    }
  });

  test("uses fake model when neither workspace nor cwd has settings", () => {
    const emptyWs = mkdtempSync(path.join(tmpdir(), "paw-ws-none-"));
    const emptyCwd = mkdtempSync(path.join(tmpdir(), "paw-cwd-none-"));
    const prev = process.cwd();
    try {
      process.chdir(emptyCwd);
      const m = createDefaultLanguageModel(emptyWs);
      expect(m).toBeInstanceOf(FakeLanguageModel);
    } finally {
      process.chdir(prev);
    }
  });
});
