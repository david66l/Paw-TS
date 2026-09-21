import { afterEach, expect, test } from "bun:test";
import { createAgentLoopModelAdapter } from "../src/agent-loop-adapter.js";
import { OpenAICompatibleModel } from "../src/openai-compatible.js";
import { MODEL_REQUEST_SUPERVISION_V1 } from "../src/request-supervision.js";
import { createThinkingRecoveryModel } from "../src/thinking-recovery.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const model = () =>
  new OpenAICompatibleModel({
    apiKey: "test-only",
    baseUrl: "https://provider.invalid/v1",
    model: "glm-5.3-flash",
    reasoningEffort: "max",
    capabilities: { contextWindow: 1000000, maxOutputTokens: 128000 },
  });
const options = {
  tools: [
    {
      type: "function" as const,
      function: { name: "write", description: "write", parameters: {} },
    },
  ],
  maxOutputTokens: 128000,
};

test("real SSE adapter aborts continuous reasoning and retries without lowering max/native output", async () => {
  const requests: Record<string, unknown>[] = [];
  let aborted = false;
  globalThis.fetch = Object.assign(
    async (_: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encode({
                  choices: [{ delta: { reasoning_content: "discard" } }],
                }),
              );
              init?.signal?.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  controller.error(init.signal?.reason);
                },
                { once: true },
              );
            },
          }),
        );
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encode({
                choices: [
                  {
                    delta: {
                      reasoning_content: "keep",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-1",
                          type: "function",
                          function: {
                            name: "write",
                            arguments: '{"text":"ok"}',
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            controller.enqueue(
              encode({
                choices: [{ delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              }),
            );
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  const wrapped = createThinkingRecoveryModel(model(), {
    noActionMs: 50,
    maxRecoveries: 1,
  });
  const result = await createAgentLoopModelAdapter(wrapped, "stream").execute(
    { messages: [{ role: "user", content: "implement and test" }], options },
    { signal: new AbortController().signal, onStreamEvent: () => {} },
  );
  expect(aborted).toBe(true);
  expect(requests.map((r) => [r.max_tokens, r.reasoning_effort])).toEqual([
    [128000, "max"],
    [128000, "max"],
  ]);
  expect(JSON.stringify(requests[1])).not.toContain("discard");
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error("Expected success");
  expect(result.message.reasoningPassback).toBe("keep");
  expect(result.toolCalls).toHaveLength(1);
  expect(result.message.usage?.totalTokens).toBe(15);
});

test("real raw SSE tool fragments keep an unfinished argument stream alive", async () => {
  let requests = 0;
  globalThis.fetch = Object.assign(
    async () => {
      requests++;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encode({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-1",
                          type: "function",
                          function: { name: "write", arguments: '{"text":' },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            setTimeout(() => {
              controller.enqueue(
                encode({
                  choices: [
                    {
                      delta: {
                        tool_calls: [{ index: 0, function: { arguments: '"ok"}' } }],
                      },
                    },
                  ],
                }),
              );
              controller.enqueue(
                encode({
                  choices: [{ delta: {}, finish_reason: "tool_calls" }],
                }),
              );
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            }, 100);
          },
        }),
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  const wrapped = createThinkingRecoveryModel(model(), {
    noActionMs: 50,
    maxRecoveries: 1,
  });
  const result = await createAgentLoopModelAdapter(wrapped, "stream").execute(
    { messages: [{ role: "user", content: "write" }], options },
    { signal: new AbortController().signal, onStreamEvent: () => {} },
  );
  expect(result.status).toBe("success");
  if (result.status !== "success") throw new Error("Expected success");
  expect(result.toolCalls[0]?.arguments).toEqual({ text: "ok" });
  expect(requests).toBe(1);
});

test("rescue retry signals supervision to reset the reasoning-only window", async () => {
  let phase = 0;
  globalThis.fetch = Object.assign(
    async (_: unknown, init?: RequestInit) => {
      phase += 1;
      if (phase === 1) {
        // Stalled thinking-only stream that respects abort.
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encode({
                  choices: [{ delta: { reasoning_content: "stall" } }],
                }),
              );
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
        );
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encode({
                choices: [
                  {
                    delta: {
                      text: "acting",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-r",
                          type: "function",
                          function: {
                            name: "write",
                            arguments: '{"text":"ok"}',
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            controller.enqueue(encode({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  const wrapped = createThinkingRecoveryModel(model(), {
    noActionMs: 80,
    maxRecoveries: 1,
  });
  const adapter = createAgentLoopModelAdapter(
    wrapped,
    "stream",
    Object.freeze({ ...MODEL_REQUEST_SUPERVISION_V1, reasoningOnlyMs: 500 }),
  );
  const settlement = await adapter.execute(
    { messages: [{ role: "user", content: "implement" }], options },
    {
      signal: new AbortController().signal,
      onStreamEvent: () => undefined,
    },
  );
  // Without the recovery_attempt reset, the 500 ms reasoning-only supervisor
  // would kill the logical call before/while the 80 ms rescue retries; with it
  // the retry gets a fresh window and completes with a tool call.
  expect(settlement.status).toBe("success");
  if (settlement.status !== "success") throw new Error("expected success");
  expect(settlement.toolCalls).toHaveLength(1);
  // The stalled attempt was aborted and retried exactly once: two physical
  // fetches, and the retry survived the supervisor's reasoning-only window.
  expect(phase).toBe(2);
});
