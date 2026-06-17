import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FakeLanguageModel } from "@paw/models";

import {
  resolveMemoryRetrievalSettings,
  toRetrieveMemoriesOptions,
} from "../src/resolve-memory-retrieval.js";

describe("resolveMemoryRetrievalSettings", () => {
  test("defaults to cascade when settings file is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-memory-settings-"));
    const settings = resolveMemoryRetrievalSettings(dir);
    expect(settings.mode).toBe("cascade");
  });

  test("selects keyword when configured", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-memory-settings-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({ memory_retrieval: "keyword" }),
    );

    const settings = resolveMemoryRetrievalSettings(dir);
    expect(settings.mode).toBe("keyword");
    expect(toRetrieveMemoriesOptions(settings, { workspaceRoot: dir }).mode).toBe(
      "keyword",
    );
  });

  test("selects cascade when configured", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-memory-settings-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({ memory_retrieval: "cascade" }),
    );

    const settings = resolveMemoryRetrievalSettings(dir);
    expect(settings.mode).toBe("cascade");
  });

  test("wires llmSelect for cascade with deepseek flash or auxiliary fallback", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-memory-settings-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        openai_api_key: "test-key",
        openai_base_url: "https://api.deepseek.com",
      }),
    );

    const settings = { mode: "cascade" as const };
    const options = toRetrieveMemoriesOptions(settings, {
      workspaceRoot: dir,
      auxiliaryModel: new FakeLanguageModel(),
    });
    expect(options.mode).toBe("cascade");
    expect(options.llmSelect).toBeDefined();
  });

  test("uses auxiliary model when deepseek flash is unavailable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-memory-settings-"));
    const settings = { mode: "cascade" as const };
    const options = toRetrieveMemoriesOptions(settings, {
      workspaceRoot: dir,
      auxiliaryModel: new FakeLanguageModel(),
    });
    expect(options.llmSelect).toBeDefined();
  });
});


