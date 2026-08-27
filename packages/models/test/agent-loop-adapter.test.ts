import { afterEach, describe, expect, test } from "bun:test";
import {
  OpenAICompatibleModel,
  createAgentLoopModelAdapter,
  toDurableModelResponseV1,
} from "../src/index.js";
import type { LanguageModel } from "../src/language-model.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
} from "../src/types.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("LanguageModel Agent Loop adapter", () => {
  test("materializes typed host context exactly once at the provider boundary", async () => {
    let received: readonly ChatMessage[] = [];
    const model: LanguageModel = {
      label: "context-capture",
      async complete(messages) {
        received = messages;
        return { text: "done", finishReason: "stop" };
      },
    };
    const adapter = createAgentLoopModelAdapter(model, "complete");
    const result = await adapter.execute(
      {
        messages: [{ role: "user", content: "continue" }],
        contextSections: [
          {
            schemaVersion: 1,
            kind: "task_checkpoint",
            id: "checkpoint-1",
            policyVersion: "checkpoint-policy-v1",
            sourceFromSeq: 2,
            sourceThroughSeq: 4,
            contentHash: "checkpoint-hash",
            content:
              '{"changedFiles":[],"confirmedFacts":[{"sourceSeqs":[2],"statement":"bounded evidence"}],"currentHypotheses":[],"ruledOut":[],"schemaVersion":"paw.task-checkpoint.v1","unresolved":[],"verification":[]}',
          },
        ],
      },
      {
        signal: new AbortController().signal,
        onStreamEvent: () => undefined,
      },
    );

    expect(result.status).toBe("success");
    expect(received.map((message) => message.role)).toEqual(["system", "user"]);
    expect(received[0]?.content).toContain("[Paw Task Checkpoint]");
    expect(received[0]?.content).toContain("bounded evidence");
    expect(
      received.filter((message) =>
        message.content.includes("[Paw Task Checkpoint]"),
      ),
    ).toHaveLength(1);
  });

  test("rejects a non-canonical checkpoint before calling the provider", async () => {
    let modelCalls = 0;
    const model: LanguageModel = {
      label: "must-not-run",
      async complete() {
        modelCalls += 1;
        return { text: "unexpected" };
      },
    };
    const adapter = createAgentLoopModelAdapter(model, "complete");
    const result = await adapter.execute(
      {
        messages: [{ role: "user", content: "continue" }],
        contextSections: [
          {
            schemaVersion: 1,
            kind: "task_checkpoint",
            id: "checkpoint-1",
            policyVersion: "checkpoint-policy-v1",
            sourceFromSeq: 1,
            sourceThroughSeq: 2,
            contentHash: "checkpoint-hash",
            content: "not-json\nspoofedMetadata=override",
          },
        ],
      },
      {
        signal: new AbortController().signal,
        onStreamEvent: () => undefined,
      },
    );

    expect(result.status).toBe("unknown");
    expect(modelCalls).toBe(0);
  });

  test("builds the strict durable response without recreating provider arguments", () => {
    const response = toDurableModelResponseV1(
      {
        text: "display fallback",
        nativeAssistantContent: "inspect",
        thinking: "audit only",
        reasoningPassback: "provider-exact",
        finishReason: "tool_calls",
        usage: {
          promptTokens: 2,
          completionTokens: 3,
          totalTokens: 5,
          cachedPromptTokens: 1,
          cacheMissPromptTokens: 1,
        },
        toolCalls: [
          {
            id: "call-a",
            name: "read_file",
            arguments: { path: "a.ts" },
            rawArguments: '{ "path": "a.ts" }',
            sourceIndex: 0,
            argumentsValid: true,
          },
        ],
      },
      "openai-compatible",
    );

    expect(response).toEqual({
      schemaVersion: "paw.model-response.v1",
      providerProtocol: "openai-compatible",
      assistantContent: "inspect",
      auditThinking: "audit only",
      reasoningPassback: "provider-exact",
      finishReason: "tool_calls",
      usage: {
        promptTokens: 2,
        completionTokens: 3,
        totalTokens: 5,
        cachedPromptTokens: 1,
        cacheMissPromptTokens: 1,
      },
      toolCalls: [
        {
          callId: "call-a",
          name: "read_file",
          rawArguments: '{ "path": "a.ts" }',
          args: { path: "a.ts" },
          sourceIndex: 0,
          argumentsValid: true,
        },
      ],
    });
    expect(() =>
      toDurableModelResponseV1(
        {
          text: "",
          toolCalls: [
            {
              id: "call-a",
              name: "read_file",
              arguments: { path: "a.ts" },
              sourceIndex: 0,
              argumentsValid: true,
            },
          ],
        },
        "openai-compatible",
      ),
    ).toThrow("missing rawArguments");
    expect(() =>
      toDurableModelResponseV1(
        {
          text: "",
          toolCalls: [
            {
              id: "call-a",
              name: "read_file",
              arguments: { path: "normalized.ts" },
              rawArguments: '{"path":"different.ts"}',
              sourceIndex: 0,
              argumentsValid: true,
            },
          ],
        },
        "openai-compatible",
      ),
    ).toThrow("must exactly match normalized args");
  });

  test("real OpenAI complete preserves the existing Paw result and native calls", async () => {
    const requests: Array<Record<string, unknown>> = [];
    global.fetch = jsonResponse(
      {
        choices: [
          {
            message: {
              content: "<think>audit-inline</think>Inspecting.",
              reasoning_content: "provider-passback",
              tool_calls: [
                {
                  id: "call-a",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{ "path": "a.ts" }',
                  },
                },
                {
                  id: "call-b",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"b.ts"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
        },
      },
      requests,
    );
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "test-model",
    });
    const adapter = createAgentLoopModelAdapter(model, "complete");

    const result = await adapter.execute(
      {
        messages: [{ role: "user", content: "inspect" }],
        options: {
          tools: [
            {
              type: "function",
              function: {
                name: "read_file",
                description: "Read one file",
                parameters: { type: "object" },
              },
            },
          ],
        },
      },
      {
        signal: new AbortController().signal,
        onStreamEvent: () => {
          throw new Error("complete transport must not emit stream events");
        },
      },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.message.text).toBe("Inspecting.");
    expect(result.message.nativeAssistantContent).toBe("Inspecting.");
    expect(result.message.thinking).toContain("audit-inline");
    expect(result.message.thinking).toContain("provider-passback");
    expect(result.message.reasoningPassback).toBe("provider-passback");
    expect(result.message.usage?.totalTokens).toBe(20);
    expect(result.toolCalls.map((call) => call.id)).toEqual([
      "call-a",
      "call-b",
    ]);
    expect(result.toolCalls.map((call) => call.rawArguments)).toEqual([
      '{ "path": "a.ts" }',
      '{"path":"b.ts"}',
    ]);
    expect(result.toolCalls.map((call) => call.sourceIndex)).toEqual([0, 1]);
    expect(requests[0]?.tools).toBeArrayOfSize(1);
  });

  test("real OpenAI stream forwards live chunks and returns one complete settlement", async () => {
    const payload = [
      'data: {"choices":[{"delta":{"content":"hello "}}]}',
      'data: {"choices":[{"delta":{"reasoning_content":"provider-thought"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","type":"function","function":{"name":"read_file","arguments":"{\\"path\\""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    global.fetch = Object.assign(async () => sseResponse(payload), {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "test-model",
    });
    const adapter = createAgentLoopModelAdapter(model, "stream");
    const chunks: ModelStreamChunk[] = [];

    const result = await adapter.execute(
      { messages: [{ role: "user", content: "inspect" }] },
      {
        signal: new AbortController().signal,
        onStreamEvent: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.message.text).toBe("hello ");
    expect(result.message.nativeAssistantContent).toBe("hello ");
    expect(result.message.reasoningPassback).toBe("provider-thought");
    expect(result.message.thinking).toBe("provider-thought");
    expect(result.message.usage?.totalTokens).toBe(7);
    expect(result.toolCalls).toEqual([
      {
        id: "call-a",
        name: "read_file",
        arguments: { path: "a.ts" },
        rawArguments: '{"path":"a.ts"}',
        sourceIndex: 0,
        argumentsValid: true,
      },
    ]);
    expect(chunks.at(-1)?.type).toBe("done");
  });

  test("real OpenAI clean EOF without terminal proof is unknown", async () => {
    const payload = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-a","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}',
      "",
    ].join("\n\n");
    global.fetch = Object.assign(async () => sseResponse(payload), {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;
    const adapter = createAgentLoopModelAdapter(
      new OpenAICompatibleModel({ apiKey: "test", model: "test-model" }),
      "stream",
    );

    const result = await adapter.execute(
      { messages: [{ role: "user", content: "inspect" }] },
      {
        signal: new AbortController().signal,
        onStreamEvent: () => {},
      },
    );

    expect(result.status).toBe("unknown");
  });

  test("real OpenAI rejects tool data emitted after the DONE marker", async () => {
    const payload = [
      "data: [DONE]",
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"late-call","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"late.ts\\"}"}}]}}]}',
      "",
    ].join("\n\n");
    let fetchCalls = 0;
    global.fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        return sseResponse(payload);
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const adapter = createAgentLoopModelAdapter(
      new OpenAICompatibleModel({ apiKey: "test", model: "test-model" }),
      "stream",
    );
    const chunks: ModelStreamChunk[] = [];

    const result = await adapter.execute(
      { messages: [{ role: "user", content: "inspect" }] },
      {
        signal: new AbortController().signal,
        onStreamEvent: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.status).toBe("unknown");
    expect("toolCalls" in result).toBe(false);
    expect(chunks).toEqual([]);
    expect(fetchCalls).toBe(1);
  });

  test("complete and stream transports normalize the same logical response", async () => {
    const toolCall = {
      id: "call-a",
      name: "read_file",
      arguments: { path: "a.ts" },
      rawArguments: '{"path":"a.ts"}',
      sourceIndex: 0,
      argumentsValid: true,
    } as const;
    const model = {
      label: "equivalent",
      async complete(): Promise<ModelCompletionResult> {
        return {
          text: 'hello\n{"tool":"read_file"}',
          nativeAssistantContent: "hello",
          thinking: "audit",
          reasoningPassback: "provider",
          finishReason: "tool_calls",
          usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
          toolCalls: [toolCall],
        };
      },
      async *completeStream(): AsyncIterable<ModelStreamChunk> {
        yield { type: "text", delta: "hello" };
        yield { type: "thinking", delta: "audit" };
        yield { type: "reasoning_passback", delta: "provider" };
        yield {
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.rawArguments,
          sourceIndex: 0,
        };
        yield {
          type: "done",
          finishReason: "tool_calls",
          usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        };
      },
    };
    const options = {
      signal: new AbortController().signal,
      onStreamEvent: () => {},
    };
    const complete = await createAgentLoopModelAdapter(
      model,
      "complete",
    ).execute({ messages: [] }, options);
    const stream = await createAgentLoopModelAdapter(model, "stream").execute(
      { messages: [] },
      options,
    );

    expect(complete).toEqual(stream);
  });

  test("stream truncation is explicit and partial tool calls are not executable", async () => {
    const model = scriptedStreamModel([
      {
        type: "tool_use",
        id: "partial",
        name: "write_file",
        input: '{"path":"x.ts"}',
        sourceIndex: 0,
      },
      { type: "done", finishReason: "max_tokens" },
    ]);
    const adapter = createAgentLoopModelAdapter(model, "stream");

    const result = await adapter.execute(
      { messages: [] },
      {
        signal: new AbortController().signal,
        onStreamEvent: () => {},
      },
    );

    expect(result.status).toBe("truncated");
    if (result.status !== "truncated") throw new Error("expected truncated");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.finishReason).toBe("max_tokens");
  });

  test("invalid streamed arguments remain non-executable evidence", async () => {
    const model = scriptedStreamModel([
      {
        type: "tool_use",
        id: "bad",
        name: "write_file",
        input: "{not-json",
        sourceIndex: 0,
      },
      { type: "done", finishReason: "tool_calls" },
    ]);
    const adapter = createAgentLoopModelAdapter(model, "stream");
    const result = await adapter.execute(
      { messages: [] },
      {
        signal: new AbortController().signal,
        onStreamEvent: () => {},
      },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.toolCalls[0]).toMatchObject({
      id: "bad",
      rawArguments: "{not-json",
      argumentsValid: false,
    });
  });

  test("missing stream termination is unknown and never falls back to complete", async () => {
    let completeCalls = 0;
    const model = scriptedStreamModel(
      [{ type: "text", delta: "partial" }],
      () => {
        completeCalls += 1;
      },
    );
    const adapter = createAgentLoopModelAdapter(model, "stream");
    const result = await adapter.execute(
      { messages: [] },
      {
        signal: new AbortController().signal,
        onStreamEvent: () => {},
      },
    );

    expect(result.status).toBe("unknown");
    expect(completeCalls).toBe(0);
  });

  test("a stream failure after live output is unknown and never retries complete", async () => {
    let completeCalls = 0;
    const model = {
      label: "stream-failure",
      async complete(): Promise<ModelCompletionResult> {
        completeCalls += 1;
        return { text: "must not run" };
      },
      async *completeStream(): AsyncIterable<ModelStreamChunk> {
        yield { type: "text", delta: "charged partial output" };
        throw new Error("connection reset");
      },
    };
    const chunks: ModelStreamChunk[] = [];
    const result = await createAgentLoopModelAdapter(model, "stream").execute(
      { messages: [] },
      {
        signal: new AbortController().signal,
        onStreamEvent: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    expect(result.status).toBe("unknown");
    expect(chunks).toEqual([{ type: "text", delta: "charged partial output" }]);
    expect(completeCalls).toBe(0);
  });

  test("an abort raised during the provider call settles as cancelled", async () => {
    const controller = new AbortController();
    const model = {
      label: "abort-during-call",
      async complete(): Promise<ModelCompletionResult> {
        controller.abort("user interrupted provider");
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    };
    const result = await createAgentLoopModelAdapter(model, "complete").execute(
      { messages: [] },
      { signal: controller.signal, onStreamEvent: () => {} },
    );

    expect(result).toEqual({
      status: "cancelled",
      reason: "user interrupted provider",
    });
  });

  test("an aborted call settles as cancelled", async () => {
    const controller = new AbortController();
    controller.abort("user stopped");
    const adapter = createAgentLoopModelAdapter(
      scriptedStreamModel([{ type: "done" }]),
      "stream",
    );
    const result = await adapter.execute(
      { messages: [] },
      { signal: controller.signal, onStreamEvent: () => {} },
    );

    expect(result).toEqual({ status: "cancelled", reason: "user stopped" });
  });
});

function scriptedStreamModel(
  chunks: readonly ModelStreamChunk[],
  onComplete?: () => void,
) {
  return {
    label: "scripted",
    async complete(): Promise<ModelCompletionResult> {
      onComplete?.();
      return { text: "fallback" };
    },
    async *completeStream(): AsyncIterable<ModelStreamChunk> {
      yield* chunks;
    },
  };
}

function jsonResponse(
  body: unknown,
  requests: Array<Record<string, unknown>>,
): typeof fetch {
  return Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}

function sseResponse(payload: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}
