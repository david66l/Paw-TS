import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDefaultLanguageModel } from "../src/default-model.js";
import { OpenAICompatibleModel } from "../src/openai-compatible.js";
import type { ChatMessage, ModelStreamChunk } from "../src/types.js";

const originalFetch = global.fetch;
const dirs: string[] = [];
afterEach(() => {
  global.fetch = originalFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("GLM built-in and named presets use the official model and frozen reasoning profile", () => {
  for (const provider of ["glm", "glmFlash"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-glm-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, ".paw"));
    writeFileSync(
      path.join(dir, ".paw/settings.local.json"),
      JSON.stringify({
        provider,
        models: {
          [provider]: {
            apiKey: "test-glm",
            model: "glm-5.3-flash",
            baseUrl: "https://open.bigmodel.cn/api/paas/v4",
            imageInput: true,
          },
        },
      }),
    );
    const model = createDefaultLanguageModel(dir);
    expect(model.label).toBe("glm:glm-5.3-flash");
    expect(model.capabilities).toEqual({
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      imageInput: true,
    });
    expect(model.runtimeProfile).toMatchObject({
      thinkingEnabled: true,
      reasoningEffort: "max",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    });
  }
});

test("GLM built-in defaults work with a legacy key and local detection", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "paw-glm-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, ".paw"));
  writeFileSync(
    path.join(dir, ".paw/settings.local.json"),
    JSON.stringify({ glm_api_key: "test-glm" }),
  );
  const model = createDefaultLanguageModel(dir);
  expect(model.label).toBe("glm:glm-5.3-flash");
  expect(model.runtimeProfile?.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
  expect(model.capabilities?.imageInput).toBeUndefined();
});

const history: ChatMessage[] = [
  {
    role: "assistant",
    content: "display only",
    nativeToolTurn: {
      schemaVersion: 2,
      protocol: "provider-neutral",
      assistantContent: "",
      reasoningPassback: "exact provider reasoning\n ",
      calls: [
        {
          callId: "call-1",
          providerName: "lookup",
          rawArguments: '{ "id": 7 }',
        },
      ],
      results: [
        {
          callId: "call-1",
          status: "completed",
          isError: false,
          content: "value",
        },
      ],
    },
  },
];

test("GLM complete and streaming preserve native reasoning and never disable mandatory thinking", async () => {
  const captured: Record<string, unknown>[] = [];
  const delta = {
    content: "OK",
    reasoning_content: "next reasoning",
    tool_calls: [
      {
        index: 0,
        id: "call-2",
        type: "function",
        function: { name: "lookup", arguments: '{"id":8}' },
      },
    ],
  };
  global.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-glm");
      const body = JSON.parse(String(init?.body));
      captured.push(body);
      return body.stream
        ? new Response(
            `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          )
        : Response.json({
            choices: [{ message: delta, finish_reason: "tool_calls" }],
          });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  const model = new OpenAICompatibleModel({
    apiKey: "test-glm",
    model: "glm-5.3-flash",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  });
  const result = await model.complete(history, {
    thinkingEnabled: false,
    maxOutputTokens: 1024,
  });
  expect(result.reasoningPassback).toBe("next reasoning");
  expect(result.toolCalls?.[0]?.arguments).toEqual({ id: 8 });
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of model.completeStream(history, {
    thinkingEnabled: false,
    maxOutputTokens: 1024,
  }))
    chunks.push(chunk);
  expect(chunks).toContainEqual({
    type: "reasoning_passback",
    delta: "next reasoning",
  });
  expect(chunks.some((chunk) => chunk.type === "tool_use" && chunk.input === '{"id":8}')).toBe(
    true,
  );
  for (const body of captured) {
    expect(body.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(body.reasoning_effort).toBe("high");
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.95);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: "",
        reasoning_content: "exact provider reasoning\n ",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{ "id": 7 }' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "value" },
    ]);
  }
  expect(captured[0]).not.toHaveProperty("tool_stream");
  expect(captured[1]?.tool_stream).toBe(true);
});
