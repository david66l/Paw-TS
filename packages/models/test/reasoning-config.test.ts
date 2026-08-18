import { afterEach, describe, expect, test } from "bun:test";

import { AnthropicCompatibleModel } from "../src/anthropic-compatible.js";
import { OpenAICompatibleModel } from "../src/openai-compatible.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function captureJsonResponse(
  responseBody: unknown,
  captured: Array<Record<string, unknown>>,
): typeof fetch {
  return Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}

function captureStreamResponse(
  payload: string,
  captured: Array<Record<string, unknown>>,
): typeof fetch {
  return Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}

describe("reasoning configuration", () => {
  test("OpenAI DeepSeek request explicitly enables max thinking", async () => {
    const captured: Array<Record<string, unknown>> = [];
    global.fetch = captureJsonResponse(
      {
        choices: [
          {
            message: { content: "done", reasoning_content: "reasoning" },
            finish_reason: "stop",
          },
        ],
      },
      captured,
    );
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
      reasoningEffort: "max",
    });

    const result = await model.complete([{ role: "user", content: "solve" }]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.thinking).toEqual({ type: "enabled" });
    expect(captured[0]?.reasoning_effort).toBe("max");
    expect(captured[0]).not.toHaveProperty("temperature");
    expect(result.thinking).toBe("reasoning");
    expect(model.runtimeProfile).toEqual({
      protocol: "openai-compatible",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      thinkingEnabled: true,
      reasoningEffort: "max",
    });
  });

  test("Anthropic request maps max effort to output_config", async () => {
    const captured: Array<Record<string, unknown>> = [];
    global.fetch = captureJsonResponse(
      { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
      captured,
    );
    const model = new AnthropicCompatibleModel({
      apiKey: "test",
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-flash",
      reasoningEffort: "max",
    });

    await model.complete([{ role: "user", content: "solve" }]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.output_config).toEqual({ effort: "max" });
    expect(model.runtimeProfile).toEqual({
      protocol: "anthropic-compatible",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com/anthropic",
      reasoningEffort: "max",
    });
  });

  test("streaming requests preserve the same reasoning intent", async () => {
    const openAiCaptured: Array<Record<string, unknown>> = [];
    global.fetch = captureStreamResponse(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      openAiCaptured,
    );
    const openAi = new OpenAICompatibleModel({
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
      reasoningEffort: "max",
    });
    for await (const _chunk of openAi.completeStream([
      { role: "user", content: "solve" },
    ])) {
      // drain stream
    }
    expect(openAiCaptured[0]?.thinking).toEqual({ type: "enabled" });
    expect(openAiCaptured[0]?.reasoning_effort).toBe("max");
    expect(openAiCaptured[0]).not.toHaveProperty("temperature");

    const anthropicCaptured: Array<Record<string, unknown>> = [];
    global.fetch = captureStreamResponse(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      anthropicCaptured,
    );
    const anthropic = new AnthropicCompatibleModel({
      apiKey: "test",
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-flash",
      reasoningEffort: "max",
    });
    for await (const _chunk of anthropic.completeStream([
      { role: "user", content: "solve" },
    ])) {
      // drain stream
    }
    expect(anthropicCaptured[0]?.output_config).toEqual({ effort: "max" });
  });

  test("OpenAI requests never replay historical audit thinking", async () => {
    const completeCaptured: Array<Record<string, unknown>> = [];
    global.fetch = captureJsonResponse(
      { choices: [{ message: { content: "done" }, finish_reason: "stop" }] },
      completeCaptured,
    );
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
    });
    const history = [
      { role: "user" as const, content: "solve" },
      {
        role: "assistant" as const,
        content: "plain assistant answer",
        thinking: "plain audit reasoning",
      },
      {
        role: "assistant" as const,
        content: '{"tool":"workspace_read_file","args":{}}',
        thinking: "text-json audit reasoning",
      },
    ];

    await model.complete(history);
    const completeMessages = completeCaptured[0]?.messages as
      | Array<Record<string, unknown>>
      | undefined;
    expect(completeMessages?.[1]).not.toHaveProperty("reasoning_content");
    expect(completeMessages?.[2]).not.toHaveProperty("reasoning_content");

    const streamCaptured: Array<Record<string, unknown>> = [];
    global.fetch = captureStreamResponse(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      streamCaptured,
    );
    for await (const _chunk of model.completeStream(history)) {
      // drain stream
    }
    const streamMessages = streamCaptured[0]?.messages as
      | Array<Record<string, unknown>>
      | undefined;
    expect(streamMessages?.[1]).not.toHaveProperty("reasoning_content");
    expect(streamMessages?.[2]).not.toHaveProperty("reasoning_content");
  });

  test("stream 400 fallback also excludes historical audit thinking", async () => {
    const captured: Array<Record<string, unknown>> = [];
    let attempt = 0;
    global.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        captured.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        attempt += 1;
        if (attempt === 1)
          return new Response("unsupported stream_options", { status: 400 });
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "deepseek-v4-flash",
      thinkingEnabled: true,
    });

    for await (const _chunk of model.completeStream([
      { role: "assistant", content: "tool action", thinking: "audit only" },
    ])) {
      // drain stream
    }

    expect(captured).toHaveLength(2);
    for (const body of captured) {
      const requestMessages = body.messages as Array<Record<string, unknown>>;
      expect(requestMessages[0]).not.toHaveProperty("reasoning_content");
    }
  });

  test("rejects contradictory thinking settings", () => {
    expect(
      () =>
        new OpenAICompatibleModel({
          apiKey: "test",
          model: "deepseek-v4-flash",
          thinkingEnabled: false,
          reasoningEffort: "max",
        }),
    ).toThrow("reasoningEffort cannot be set");
  });
});
