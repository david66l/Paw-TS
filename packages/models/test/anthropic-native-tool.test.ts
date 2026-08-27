import { afterEach, describe, expect, test } from "bun:test";

import { createAgentLoopModelAdapter } from "../src/agent-loop-adapter.js";
import { AnthropicCompatibleModel } from "../src/anthropic-compatible.js";
import type { ModelStreamChunk } from "../src/types.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function toolDefinitions() {
  return [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "Read one file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ];
}

function streamResponse(payload: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("Anthropic native tools", () => {
  test("replays one provider-neutral assistant/tool-result turn atomically", async () => {
    const captured: Array<Record<string, unknown>> = [];
    global.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        captured.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "continuing" }],
            stop_reason: "end_turn",
          }),
          { status: 200 },
        );
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const model = new AnthropicCompatibleModel({
      apiKey: "test",
      model: "claude-test",
    });

    await model.complete([
      { role: "user", content: "inspect both" },
      {
        role: "assistant",
        content: "fallback display",
        nativeToolTurn: {
          schemaVersion: 2,
          protocol: "provider-neutral",
          assistantContent: "I will inspect both.",
          calls: [
            {
              callId: "call-a",
              providerName: "read_file",
              rawArguments: '{"path":"a.ts"}',
            },
            {
              callId: "call-b",
              providerName: "read_file",
              rawArguments: '{"path":"b.ts"}',
            },
          ],
          results: [
            {
              callId: "call-a",
              status: "completed",
              isError: false,
              content: "a contents",
            },
            {
              callId: "call-b",
              status: "unknown",
              isError: true,
              content: "result was not proven",
            },
          ],
        },
      },
    ]);

    expect(captured[0]?.messages).toEqual([
      { role: "user", content: "inspect both" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect both." },
          {
            type: "tool_use",
            id: "call-a",
            name: "read_file",
            input: { path: "a.ts" },
          },
          {
            type: "tool_use",
            id: "call-b",
            name: "read_file",
            input: { path: "b.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-a",
            content: "a contents",
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "call-b",
            content: "result was not proven",
            is_error: true,
          },
        ],
      },
    ]);
  });

  test("rejects OpenAI-only reasoning passback instead of silently dropping it", async () => {
    const model = new AnthropicCompatibleModel({
      apiKey: "test",
      model: "claude-test",
    });

    await expect(
      model.complete([
        {
          role: "assistant",
          content: "plain continuation",
          reasoningPassback: "openai-only-state",
        },
      ]),
    ).rejects.toThrow("cannot replay string reasoningPassback");
  });

  test("complete translates tools and preserves valid and malformed tool inputs", async () => {
    const captured: Array<Record<string, unknown>> = [];
    global.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        captured.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(
          JSON.stringify({
            content: [
              { type: "thinking", thinking: "inspect both" },
              { type: "text", text: "I will inspect both files." },
              {
                type: "tool_use",
                id: "call-a",
                name: "read_file",
                input: { path: "a.ts" },
              },
              {
                type: "tool_use",
                id: "call-b",
                name: "read_file",
                input: '{"path":',
              },
            ],
            stop_reason: "tool_use",
            usage: {
              input_tokens: 12,
              output_tokens: 8,
              cache_read_input_tokens: 4,
            },
          }),
          { status: 200 },
        );
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const model = new AnthropicCompatibleModel({
      apiKey: "test",
      model: "claude-test",
    });

    const adapter = createAgentLoopModelAdapter(model, "complete");
    const settlement = await adapter.execute(
      {
        messages: [{ role: "user", content: "read" }],
        options: { tools: toolDefinitions() },
      },
      {
        signal: new AbortController().signal,
        onStreamEvent: () => {
          throw new Error("complete transport must not emit stream events");
        },
      },
    );
    expect(settlement.status).toBe("success");
    if (settlement.status !== "success") throw new Error("expected success");
    const result = settlement.message;

    expect(captured[0]?.tools).toEqual([
      {
        name: "read_file",
        description: "Read one file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    expect(result.nativeAssistantContent).toBe("I will inspect both files.");
    expect(result.thinking).toBe("inspect both");
    expect(result.finishReason).toBe("tool_use");
    expect(result.usage).toEqual({
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      cachedPromptTokens: 4,
    });
    expect(result.toolCalls).toEqual([
      {
        id: "call-a",
        name: "read_file",
        arguments: { path: "a.ts" },
        rawArguments: '{"path":"a.ts"}',
        sourceIndex: 0,
        argumentsValid: true,
      },
      {
        id: "call-b",
        name: "read_file",
        arguments: {},
        rawArguments: '{"path":',
        sourceIndex: 1,
        argumentsValid: false,
      },
    ]);
  });

  test("stream assembles interleaved tool blocks in stable source order", async () => {
    const payload = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":5}}}',
      'data: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"call-b","name":"write_file","input":{}}}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-a","name":"read_file","input":{}}}',
      'data: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
      'data: {"type":"content_block_delta","index":3,"delta":{"type":"input_json_delta","partial_json":"\\"b.ts\\"}"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}',
      'data: {"type":"content_block_stop","index":3}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}',
      'data: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const captured: Array<Record<string, unknown>> = [];
    global.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        captured.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return streamResponse(payload);
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const model = new AnthropicCompatibleModel({
      apiKey: "test",
      model: "claude-test",
    });
    const chunks: ModelStreamChunk[] = [];
    const adapter = createAgentLoopModelAdapter(model, "stream");
    const settlement = await adapter.execute(
      {
        messages: [{ role: "user", content: "work" }],
        options: { tools: toolDefinitions() },
      },
      {
        signal: new AbortController().signal,
        onStreamEvent: (chunk) => {
          chunks.push(chunk);
        },
      },
    );
    expect(settlement.status).toBe("success");
    if (settlement.status !== "success") throw new Error("expected success");

    expect(captured[0]?.stream).toBe(true);
    expect(captured[0]?.tools).toEqual([
      {
        name: "read_file",
        description: "Read one file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    expect(chunks.filter((chunk) => chunk.type === "tool_use")).toEqual([
      {
        type: "tool_use",
        id: "call-a",
        name: "read_file",
        input: '{"path":"a.ts"}',
        sourceIndex: 0,
      },
      {
        type: "tool_use",
        id: "call-b",
        name: "write_file",
        input: '{"path":"b.ts"}',
        sourceIndex: 1,
      },
    ]);
    expect(chunks.at(-1)).toEqual({
      type: "done",
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
        cachedPromptTokens: 5,
      },
      finishReason: "tool_use",
    });
    expect(settlement.message.toolCalls?.map((call) => call.id)).toEqual([
      "call-a",
      "call-b",
    ]);
  });

  test("real provider plus adapter treats clean EOF without terminal proof as unknown", async () => {
    const payload = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-a","name":"read_file","input":{}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
      'data: {"type":"content_block_stop","index":0}',
      "",
    ].join("\n\n");
    let fetchCalls = 0;
    global.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        return streamResponse(payload);
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const adapter = createAgentLoopModelAdapter(
      new AnthropicCompatibleModel({
        apiKey: "test",
        model: "claude-test",
      }),
      "stream",
    );
    const liveChunks: ModelStreamChunk[] = [];

    const result = await adapter.execute(
      { messages: [{ role: "user", content: "read" }] },
      {
        signal: new AbortController().signal,
        onStreamEvent: (chunk) => {
          liveChunks.push(chunk);
        },
      },
    );

    expect(result.status).toBe("unknown");
    expect(liveChunks).toEqual([]);
    expect(fetchCalls).toBe(1);
  });

  test("real provider plus adapter rejects malformed data with a valid tool sibling", async () => {
    const payload = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-a","name":"read_file","input":{}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.ts\\"}"}}',
      'data: {"type":"content_block_stop","index":0}',
      "data: {not-json",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    let fetchCalls = 0;
    global.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        return streamResponse(payload);
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const adapter = createAgentLoopModelAdapter(
      new AnthropicCompatibleModel({
        apiKey: "test",
        model: "claude-test",
      }),
      "stream",
    );
    const liveChunks: ModelStreamChunk[] = [];

    const result = await adapter.execute(
      { messages: [{ role: "user", content: "read" }] },
      {
        signal: new AbortController().signal,
        onStreamEvent: (chunk) => {
          liveChunks.push(chunk);
        },
      },
    );

    expect(result.status).toBe("unknown");
    expect(liveChunks).toEqual([]);
    expect(fetchCalls).toBe(1);
  });

  test("real provider plus adapter rejects tool blocks after message_stop", async () => {
    const payload = [
      'data: {"type":"message_stop"}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"late-call","name":"write_file","input":{}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"late.ts\\"}"}}',
      'data: {"type":"content_block_stop","index":0}',
      "",
    ].join("\n\n");
    let fetchCalls = 0;
    global.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        return streamResponse(payload);
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const adapter = createAgentLoopModelAdapter(
      new AnthropicCompatibleModel({
        apiKey: "test",
        model: "claude-test",
      }),
      "stream",
    );
    const liveChunks: ModelStreamChunk[] = [];

    const result = await adapter.execute(
      { messages: [{ role: "user", content: "write" }] },
      {
        signal: new AbortController().signal,
        onStreamEvent: (chunk) => {
          liveChunks.push(chunk);
        },
      },
    );

    expect(result.status).toBe("unknown");
    expect("toolCalls" in result).toBe(false);
    expect(liveChunks).toEqual([]);
    expect(fetchCalls).toBe(1);
  });
});
