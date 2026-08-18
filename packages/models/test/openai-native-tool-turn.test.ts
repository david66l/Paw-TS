import { afterEach, describe, expect, test } from "bun:test";

import { OpenAICompatibleModel } from "../src/openai-compatible.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function mockJson(
  responseBody: unknown,
  captured: Array<Record<string, unknown>>,
): typeof fetch {
  return Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responseBody), { status: 200 });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
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

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

describe("OpenAI native tool turns", () => {
  test("complete preserves provider call ids, raw arguments, and assistant text", async () => {
    const captured: Array<Record<string, unknown>> = [];
    global.fetch = mockJson(
      {
        choices: [
          {
            message: {
              content:
                "<think>inline audit only</think>I will inspect both files.",
              reasoning_content: "provider-exact-passback",
              tool_calls: [
                {
                  id: "provider-a",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{ "path": "a.ts", "line": 1 }',
                  },
                },
                {
                  id: "provider-b",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"line":1,"path":"a.ts"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      captured,
    );
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "deepseek-v4-flash",
    });

    const result = await model.complete([{ role: "user", content: "read" }]);

    expect(result.nativeAssistantContent).toBe("I will inspect both files.");
    expect(result.thinking).toContain("inline audit only");
    expect(result.thinking).toContain("provider-exact-passback");
    expect(result.reasoningPassback).toBe("provider-exact-passback");
    expect(result.toolCalls?.map((call) => call.id)).toEqual([
      "provider-a",
      "provider-b",
    ]);
    expect(result.toolCalls?.map((call) => call.rawArguments)).toEqual([
      '{ "path": "a.ts", "line": 1 }',
      '{"line":1,"path":"a.ts"}',
    ]);
  });

  test("stream aggregates interleaved parallel calls until the terminal chunk", async () => {
    const payload = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"one","arguments":"{\\"x\\""}},{"index":1,"id":"b","type":"function","function":{"name":"two","arguments":"{"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"y\\":2}"}},{"index":0,"function":{"arguments":":1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    global.fetch = Object.assign(async () => streamResponse(payload), {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "deepseek-v4-flash",
    });
    const calls: Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: string;
    }> = [];

    for await (const chunk of model.completeStream([
      { role: "user", content: "go" },
    ])) {
      if (chunk.type === "tool_use") calls.push(chunk);
    }

    expect(calls).toEqual([
      { type: "tool_use", id: "a", name: "one", input: '{"x":1}' },
      { type: "tool_use", id: "b", name: "two", input: '{"y":2}' },
    ]);
  });

  test("stream keeps audit thinking separate from exact provider passback", async () => {
    const payload = [
      'data: {"choices":[{"delta":{"content":"<think>inline audit</think>visible","reasoning_content":"provider-exact","tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"read_file","arguments":"{}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    global.fetch = Object.assign(async () => streamResponse(payload), {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "deepseek-v4-flash",
    });
    let audit = "";
    let passback = "";

    for await (const chunk of model.completeStream([
      { role: "user", content: "go" },
    ])) {
      if (chunk.type === "thinking") audit += chunk.delta;
      if (chunk.type === "reasoning_passback") passback += chunk.delta;
    }

    expect(audit).toContain("inline audit");
    expect(audit).toContain("provider-exact");
    expect(passback).toBe("provider-exact");
  });

  test("complete rejects malformed or duplicate provider identities as one batch", async () => {
    const invalidBatches = [
      [
        {
          id: "valid",
          function: { name: "read_file", arguments: "{}" },
        },
        { function: { name: "read_file", arguments: "{}" } },
      ],
      [{ id: "missing-function" }],
      [{ id: "missing-name", function: { arguments: "{}" } }],
      [
        { id: "dup", function: { name: "read_file", arguments: "{}" } },
        { id: "dup", function: { name: "read_file", arguments: "{}" } },
      ],
    ];

    for (const toolCalls of invalidBatches) {
      global.fetch = mockJson(
        {
          choices: [
            {
              message: { content: "", tool_calls: toolCalls },
              finish_reason: "tool_calls",
            },
          ],
        },
        [],
      );
      const model = new OpenAICompatibleModel({
        apiKey: "test",
        model: "deepseek-v4-flash",
      });
      await expect(
        model.complete([{ role: "user", content: "go" }]),
      ).rejects.toThrow("OpenAI-compatible");
    }
  });

  test("stream rejects incomplete, duplicate, and conflicting provider identities", async () => {
    const invalidPayloads = [
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"valid","function":{"name":"read_file","arguments":"{}"}},{"index":1,"function":{"name":"read_file","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      ],
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"dup","function":{"name":"read_file","arguments":"{}"}},{"index":1,"id":"dup","function":{"name":"read_file","arguments":"{}"}}]}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      ],
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read_file","arguments":"{"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"b","function":{"name":"read_file","arguments":"}"}}]}}]}',
      ],
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read_file","arguments":"{"}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"other","arguments":"}"}}]}}]}',
      ],
    ];

    for (const lines of invalidPayloads) {
      const payload = [...lines, "data: [DONE]", ""].join("\n\n");
      global.fetch = Object.assign(async () => streamResponse(payload), {
        preconnect: originalFetch.preconnect,
      }) as typeof fetch;
      const model = new OpenAICompatibleModel({
        apiKey: "test",
        model: "deepseek-v4-flash",
      });
      await expect(
        drain(model.completeStream([{ role: "user", content: "go" }])),
      ).rejects.toThrow("OpenAI-compatible");
    }
  });

  test("stream rejects a malformed SSE payload instead of executing a valid sibling", async () => {
    const payload = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"valid","function":{"name":"read_file","arguments":"{}"}}]}}]}',
      "data: {not-json",
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    global.fetch = Object.assign(async () => streamResponse(payload), {
      preconnect: originalFetch.preconnect,
    }) as typeof fetch;
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "deepseek-v4-flash",
    });

    await expect(
      drain(model.completeStream([{ role: "user", content: "go" }])),
    ).rejects.toThrow("invalid JSON stream payload");
  });

  test("complete marks malformed raw arguments instead of executing an empty object", async () => {
    global.fetch = mockJson(
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "bad",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      [],
    );
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "deepseek-v4-flash",
    });

    const result = await model.complete([{ role: "user", content: "read" }]);

    expect(result.toolCalls?.[0]).toMatchObject({
      id: "bad",
      rawArguments: '{"path":',
      argumentsValid: false,
    });
  });

  test("complete, stream, and 400 retry expand one atomic native turn identically", async () => {
    const history = [
      {
        role: "assistant" as const,
        content: "fallback transcript",
        nativeToolTurn: {
          schemaVersion: 1 as const,
          protocol: "openai-compatible" as const,
          assistantContent: "checking",
          reasoningPassback: "need both",
          calls: [
            {
              callId: "a",
              providerName: "read_file",
              rawArguments: '{"path":"a.ts"}',
            },
            {
              callId: "b",
              providerName: "read_file",
              rawArguments: '{"path":"b.ts"}',
            },
          ],
          results: [
            { callId: "a", content: "A" },
            { callId: "b", content: "B" },
          ],
        },
      },
    ];
    const expectedMessages = [
      {
        role: "assistant",
        content: "checking",
        reasoning_content: "need both",
        tool_calls: [
          {
            id: "a",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
          },
          {
            id: "b",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"b.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "A" },
      { role: "tool", tool_call_id: "b", content: "B" },
    ];
    const captured: Array<Record<string, unknown>> = [];
    global.fetch = mockJson(
      { choices: [{ message: { content: "done" }, finish_reason: "stop" }] },
      captured,
    );
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "deepseek-v4-flash",
    });
    await model.complete(history);

    let streamAttempt = 0;
    global.fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        captured.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        streamAttempt += 1;
        if (streamAttempt === 1) return new Response("retry", { status: 400 });
        return streamResponse(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        );
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    for await (const _chunk of model.completeStream(history)) {
      // drain
    }

    expect(captured).toHaveLength(3);
    for (const body of captured) {
      expect(body.messages).toEqual(expectedMessages);
    }
  });

  test("serializer degrades corrupt persisted native metadata to plain fallback text", async () => {
    const captured: Array<Record<string, unknown>> = [];
    global.fetch = mockJson(
      { choices: [{ message: { content: "done" }, finish_reason: "stop" }] },
      captured,
    );
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "deepseek-v4-flash",
    });

    await model.complete([
      {
        role: "assistant",
        content: "safe fallback",
        nativeToolTurn: {},
      } as unknown as import("../src/types.js").ChatMessage,
    ]);

    expect(captured[0]?.messages).toEqual([
      { role: "assistant", content: "safe fallback" },
    ]);
  });
});
