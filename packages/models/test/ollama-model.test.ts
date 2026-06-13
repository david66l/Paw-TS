import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultLanguageModel } from "../src/default-model.js";
import { FakeLanguageModel } from "../src/fake-model.js";
import { OpenAICompatibleModel } from "../src/openai-compatible.js";

describe("createDefaultLanguageModel with ollama provider", () => {
  test("selects OpenAICompatibleModel when provider=ollama", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-ollama-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "ollama",
        ollama_host: "http://127.0.0.1:11434",
        ollama_model: "qwen2.5:7b",
      }),
    );
    const m = createDefaultLanguageModel(dir);
    expect(m).toBeInstanceOf(OpenAICompatibleModel);
  });

  test("falls back to FakeLanguageModel when no model configured", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-ollama-no-model-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({ provider: "ollama" }),
    );
    const m = createDefaultLanguageModel(dir);
    expect(m).toBeInstanceOf(FakeLanguageModel);
  });

  test("falls back to generic model field when ollama_model absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-ollama-fallback-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({ provider: "ollama", model: "llama3.1:8b" }),
    );
    const m = createDefaultLanguageModel(dir);
    expect(m).toBeInstanceOf(OpenAICompatibleModel);
  });
});

describe("OpenAICompatibleModel with Ollama-like responses", () => {
  test("complete parses text and usage", async () => {
    const originalFetch = global.fetch;
    global.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: "hello from ollama" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      { preconnect: global.fetch.preconnect },
    ) as typeof global.fetch;

    try {
      const model = new OpenAICompatibleModel({
        apiKey: "ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5:7b",
      });
      const r = await model.complete([{ role: "user", content: "hi" }]);
      expect(r.text).toBe("hello from ollama");
      expect(r.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      });
      expect(r.finishReason).toBe("stop");
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("complete keeps usage undefined when absent", async () => {
    const originalFetch = global.fetch;
    global.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: "no usage" }, finish_reason: "stop" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      { preconnect: global.fetch.preconnect },
    ) as typeof global.fetch;

    try {
      const model = new OpenAICompatibleModel({
        apiKey: "ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5:7b",
      });
      const r = await model.complete([{ role: "user", content: "hi" }]);
      expect(r.text).toBe("no usage");
      expect(r.usage).toBeUndefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  test("completeStream yields text deltas and done", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          ),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const originalFetch = global.fetch;
    global.fetch = Object.assign(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      { preconnect: global.fetch.preconnect },
    ) as typeof global.fetch;

    try {
      const model = new OpenAICompatibleModel({
        apiKey: "ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5:7b",
      });
      const chunks: unknown[] = [];
      for await (const c of model.completeStream([
        { role: "user", content: "hi" },
      ])) {
        chunks.push(c);
      }
      const textChunks = chunks.filter(
        (c): c is { type: "text"; delta: string } =>
          typeof c === "object" &&
          c !== null &&
          (c as Record<string, unknown>).type === "text",
      );
      expect(textChunks.map((c) => c.delta).join("")).toBe("Hello world");
      const doneChunk = chunks.find(
        (c): c is { type: "done" } =>
          typeof c === "object" &&
          c !== null &&
          (c as Record<string, unknown>).type === "done",
      );
      expect(doneChunk).toBeDefined();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("resolveCapabilities for Ollama models", () => {
  test("known ollama models get correct context window", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-ollama-caps-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "ollama",
        ollama_model: "llama3.1:8b",
      }),
    );
    const m = createDefaultLanguageModel(dir);
    expect(m.capabilities?.contextWindow).toBe(128_000);
  });

  test("unknown ollama model falls back to 32K", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-ollama-unknown-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        provider: "ollama",
        ollama_model: "some-random-model:7b",
      }),
    );
    const m = createDefaultLanguageModel(dir);
    expect(m.capabilities?.contextWindow).toBe(32_768);
  });
});
