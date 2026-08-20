import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDeepSeekFlashModel } from "@paw/models";

describe("createDeepSeekFlashModel", () => {
  it("returns deepseek-v4-flash when deepseek_api_key is configured", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-flash-model-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        deepseek_api_key: "test-key",
      }),
    );

    const model = createDeepSeekFlashModel(dir);
    expect(model?.label).toBe("deepseek:deepseek-v4-flash");
  });

  it("falls back to openai_api_key + deepseek base url", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-flash-model-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        openai_api_key: "test-key",
        openai_base_url: "https://api.deepseek.com",
      }),
    );

    const model = createDeepSeekFlashModel(dir);
    expect(model?.label).toBe("deepseek:deepseek-v4-flash");
  });

  it("returns undefined when api key is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-flash-model-"));
    expect(createDeepSeekFlashModel(dir)).toBeUndefined();
  });

  it("marks the production Flash client as supporting per-call thinking disable", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-flash-model-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({ deepseek_api_key: "test-key" }),
    );
    const originalFetch = global.fetch;
    let requestBody: Record<string, unknown> | undefined;
    try {
      global.fetch = Object.assign(
        async (_input: string | URL | Request, init?: RequestInit) => {
          requestBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
            }),
            { status: 200 },
          );
        },
        { preconnect: originalFetch.preconnect },
      ) as typeof fetch;
      const model = createDeepSeekFlashModel(dir);
      await model?.complete([{ role: "user", content: "bounded planner" }], {
        thinkingEnabled: false,
        maxOutputTokens: 1_536,
      });
      expect(requestBody?.thinking).toEqual({ type: "disabled" });
      expect(requestBody?.max_tokens).toBe(1_536);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
