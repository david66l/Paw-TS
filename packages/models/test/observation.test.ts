import { afterEach, expect, test } from "bun:test";
import { AnthropicCompatibleModel } from "../src/anthropic-compatible.js";
import {
  type ModelObservationEvent,
  type ModelObserver,
  withModelObservationScope,
  withModelObserver,
} from "../src/observation.js";
import { OpenAICompatibleModel } from "../src/openai-compatible.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const model = () =>
  new OpenAICompatibleModel({
    apiKey: "SECRET_KEY",
    baseUrl: "https://provider.invalid/v1",
    model: "glm-5.3-flash",
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    reasoningEffort: "max",
  });
function sink() {
  const calls: Array<{
    input: Parameters<ModelObserver["start"]>[0];
    events: ModelObservationEvent[];
    status?: string;
  }> = [];
  const observer: ModelObserver = {
    start(input) {
      const call = {
        input,
        events: [] as ModelObservationEvent[],
        status: undefined as string | undefined,
      };
      calls.push(call);
      return {
        event: (e) => call.events.push(e),
        end: (s) => {
          call.status = s;
        },
      };
    },
  };
  return { calls, observer };
}
function mockFetch(fn: (init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = Object.assign(
    (_url: unknown, init?: RequestInit) => fn(init),
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
}
const sse = (delta: unknown, finish = "stop") =>
  `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;

test("GLM retry, partial tools and final assembly are observed without capturing bodies or changing requests", async () => {
  const { calls, observer } = sink();
  const requests: Record<string, unknown>[] = [];
  mockFetch(async (init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1)
      return new Response("SECRET_ERROR_BODY", { status: 400 });
    return new Response(
      sse(
        {
          reasoning_content: "PRIVATE_THINKING",
          tool_calls: [
            {
              index: 0,
              id: "tool-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"PRIVATE_PATH"}',
              },
            },
          ],
        },
        "tool_calls",
      ),
    );
  });
  const chunks = await withModelObserver(observer, () =>
    withModelObservationScope("child-1", "agent_loop", async () => {
      const chunks = [];
      for await (const chunk of model().completeStream(
        [{ role: "user", content: "PRIVATE_PROMPT" }],
        { maxOutputTokens: 128_000 },
      ))
        chunks.push(chunk);
      return chunks;
    }),
  );
  expect(
    chunks.some(
      (c) => c.type === "tool_use" && c.input.includes("PRIVATE_PATH"),
    ),
  ).toBe(true);
  expect(requests.map((r) => [r.max_tokens, r.reasoning_effort])).toEqual([
    [128_000, "max"],
    [128_000, "max"],
  ]);
  expect(requests[0]?.stream_options).toEqual({ include_usage: true });
  expect(requests[1]?.stream_options).toBeUndefined();
  expect(calls[0]?.input.runId).toBe("child-1");
  expect(calls[0]?.events.filter((e) => e.type === "request")).toHaveLength(2);
  expect(
    calls[0]?.events.filter((e) => e.type === "tool_assembled"),
  ).toHaveLength(1);
  expect(calls[0]?.status).toBe("completed");
  expect(JSON.stringify(calls)).not.toMatch(/SECRET|PRIVATE/);
});

test("concurrent observations keep run identities isolated and capture auxiliary completions", async () => {
  const { calls, observer } = sink();
  mockFetch(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: "PRIVATE_RESULT" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      ),
  );
  await withModelObserver(observer, () =>
    Promise.all(
      ["a", "b"].map((runId) =>
        withModelObservationScope(runId, "completion_review", () =>
          model().complete([]),
        ),
      ),
    ),
  );
  expect(calls.map((c) => c.input.runId).sort()).toEqual(["a", "b"]);
  expect(
    calls.every(
      (c) =>
        c.status === "completed" &&
        c.events.some(
          (e) => e.type === "result" && e.usage?.promptTokens === 10,
        ),
    ),
  ).toBe(true);
  expect(JSON.stringify(calls)).not.toContain("PRIVATE_RESULT");
});

test("malformed streams and cancellation terminate observation; observer failures never break model results", async () => {
  const { calls, observer } = sink();
  mockFetch(async () => new Response("data: {bad-json}\n\n"));
  await expect(
    withModelObserver(observer, async () => {
      for await (const _ of model().completeStream([])) {
        /* consume */
      }
    }),
  ).rejects.toThrow();
  expect(calls[0]?.status).toBe("failed");
  const abort = new AbortController();
  abort.abort();
  await expect(
    withModelObserver(observer, () =>
      model().complete([], { signal: abort.signal }),
    ),
  ).rejects.toThrow();
  expect(calls[1]?.status).toBe("cancelled");
  mockFetch(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      ),
  );
  const result = await withModelObserver(
    {
      start() {
        return {
          event() {
            throw new Error("sink failure");
          },
          end() {
            throw new Error("sink failure");
          },
        };
      },
    },
    () => model().complete([]),
  );
  expect(result.text).toBe("ok");
});

test("Anthropic stream records network progress and tool fragments with unchanged assembled output", async () => {
  const { calls, observer } = sink();
  mockFetch(
    async () =>
      new Response(
        [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool-a",
              name: "read_file",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"PRIVATE_PATH"}',
            },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 4 },
          },
          { type: "message_stop" },
        ]
          .map((x) => `data: ${JSON.stringify(x)}\n\n`)
          .join(""),
      ),
  );
  const anthropic = new AnthropicCompatibleModel({
    apiKey: "SECRET_KEY",
    model: "claude-test",
  });
  const chunks = await withModelObserver(observer, async () => {
    const out = [];
    for await (const chunk of anthropic.completeStream([])) out.push(chunk);
    return out;
  });
  expect(
    chunks.some((c) => c.type === "tool_use" && c.name === "read_file"),
  ).toBe(true);
  expect(calls[0]?.events.some((e) => e.type === "bytes")).toBe(true);
  expect(
    calls[0]?.events.filter(
      (e) => e.type === "delta" && e.kind === "tool_fragment",
    ),
  ).toHaveLength(2);
  expect(calls[0]?.status).toBe("completed");
  expect(JSON.stringify(calls)).not.toMatch(/PRIVATE|SECRET/);
});
