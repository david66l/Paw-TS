import { describe, expect, test } from "bun:test";
import { createAgentLoopModelAdapter } from "../src/agent-loop-adapter.js";
import type { LanguageModel } from "../src/language-model.js";
import type { ModelCompleteOptions } from "../src/model-options.js";
import {
  THINKING_RECOVERY_BATCH_INSTRUCTION,
  THINKING_RECOVERY_INSTRUCTION,
  createThinkingRecoveryModel,
} from "../src/thinking-recovery.js";
import type { ChatMessage, ModelStreamChunk } from "../src/types.js";

const tools = [
  {
    type: "function" as const,
    function: { name: "write", description: "write", parameters: {} },
  },
];
const options = { tools, maxOutputTokens: 128000 };
const messages: ChatMessage[] = [
  { role: "system", content: "original policy" },
  { role: "user", content: "whole task" },
];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
async function collect(model: LanguageModel, opts: ModelCompleteOptions = options) {
  const chunks: ModelStreamChunk[] = [];
  for await (const chunk of model.completeStream!(messages, opts)) chunks.push(chunk);
  return chunks;
}
function fake(stream: NonNullable<LanguageModel["completeStream"]>): LanguageModel {
  return {
    label: "test",
    capabilities: { contextWindow: 1000000, maxOutputTokens: 128000 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "test",
      baseUrl: "http://localhost",
      reasoningEffort: "max",
    },
    complete: async () => ({ text: "auxiliary" }),
    completeStream: stream,
  };
}
const policy = { noActionMs: 30, maxRecoveries: 2 };
const tool: ModelStreamChunk = {
  type: "tool_use",
  id: "call-1",
  name: "write",
  input: '{"text":"ok"}',
  sourceIndex: 0,
};

describe("experimental thinking recovery", () => {
  test("batches only after two confirmed post-recovery writes, not emitted, failed or duplicate calls", async () => {
    let calls = 0;
    const received: string[] = [];
    const model = createThinkingRecoveryModel(
      fake(async function* (actual, opts) {
        if (++calls === 1) {
          yield { type: "thinking", delta: "thinking" };
          await waitAbort(opts!.signal!);
        }
        received.push(actual.at(-1)!.content);
        yield tool;
        yield { type: "done" };
      }),
      policy,
    );
    const history = (id: string, status: "completed" | "failed" = "completed"): ChatMessage => ({
      role: "assistant",
      content: "write",
      nativeToolTurn: {
        schemaVersion: 2,
        protocol: "provider-neutral",
        assistantContent: "",
        calls: [
          {
            callId: id,
            providerName: "workspace_write_file",
            rawArguments: "{}",
          },
        ],
        results: [
          {
            callId: id,
            status,
            isError: status !== "completed",
            content: "result",
          },
        ],
      },
    });
    await collect(model);
    for (const additions of [
      [history("one"), history("one"), history("bad", "failed")],
      [history("one"), history("two")],
    ]) {
      for await (const _ of model.completeStream!([...messages, ...additions], options)) {
        /* consume */
      }
    }
    expect(received).toEqual([
      THINKING_RECOVERY_INSTRUCTION,
      THINKING_RECOVERY_INSTRUCTION,
      THINKING_RECOVERY_BATCH_INSTRUCTION,
    ]);
  });
  test("discards interrupted history, retains full task/options, and returns only successful native tools", async () => {
    let calls = 0;
    const events: string[] = [];
    const base = fake(async function* (actual, opts) {
      expect(opts?.maxOutputTokens).toBe(128000);
      expect(opts?.tools).toBe(tools);
      if (++calls === 1) {
        expect(actual).toBe(messages);
        yield { type: "thinking", delta: "discard this" };
        yield { type: "reasoning_passback", delta: "discard native state" };
        await waitAbort(opts!.signal!);
      }
      expect(actual.slice(0, -1)).toEqual(messages);
      expect(actual.at(-1)).toEqual({
        role: "system",
        content: THINKING_RECOVERY_INSTRUCTION,
      });
      yield { type: "thinking", delta: "successful" };
      yield tool;
      yield { type: "done", finishReason: "tool_calls" };
    });
    const model = createThinkingRecoveryModel(base, {
      ...policy,
      onEvent: (e) => events.push(e.type),
    });
    expect(model.runtimeProfile).toBe(base.runtimeProfile);
    const adapter = createAgentLoopModelAdapter(model, "stream");
    const result = await adapter.execute(
      { messages, options },
      { signal: new AbortController().signal, onStreamEvent: () => {} },
    );
    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("Expected success");
    expect(result.message.thinking).toBe("successful");
    expect(result.message.reasoningPassback).toBeUndefined();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.rawArguments).toBe('{"text":"ok"}');
    expect(events).toEqual(["interrupted", "retry"]);
    expect(messages).toHaveLength(2);
  });

  test("raw tool fragments protect long argument generation before assembled tool_use", async () => {
    let calls = 0;
    const model = createThinkingRecoveryModel(
      fake(async function* (_, opts) {
        calls++;
        yield { type: "thinking", delta: "ready" };
        opts?.onObservation?.({
          type: "delta",
          kind: "tool_fragment",
          count: 1,
        });
        await sleep(70);
        opts?.signal?.throwIfAborted();
        yield tool;
        yield { type: "done" };
      }),
      policy,
    );
    expect(await collect(model)).toContainEqual(tool);
    expect(calls).toBe(1);
  });

  test("nonempty text disarms guard, empty text does not", async () => {
    const model = createThinkingRecoveryModel(
      fake(async function* (_, opts) {
        yield { type: "text", delta: "Working" };
        await sleep(70);
        opts?.signal?.throwIfAborted();
        yield { type: "done" };
      }),
      policy,
    );
    expect(await collect(model)).toHaveLength(2);
    const empty = createThinkingRecoveryModel(
      fake(async function* (_, opts) {
        yield { type: "text", delta: "" };
        await waitAbort(opts!.signal!);
      }),
      policy,
    );
    await expect(collect(empty)).rejects.toThrow("no_response");
  });

  test("repeated stall terminates after one retry and latches across later calls", async () => {
    let calls = 0;
    const model = createThinkingRecoveryModel(
      fake(async function* (_, opts) {
        calls++;
        yield { type: "thinking", delta: "thinking" };
        await waitAbort(opts!.signal!);
      }),
      policy,
    );
    await expect(collect(model)).rejects.toThrow("recovery allowance");
    await expect(collect(model)).rejects.toThrow("recovery allowance");
    expect(calls).toBe(2);
  });

  test("run allowance does not reset after a successful recovered turn", async () => {
    let calls = 0;
    const model = createThinkingRecoveryModel(
      fake(async function* (_, opts) {
        if (++calls !== 2) {
          yield { type: "thinking", delta: "thinking" };
          await waitAbort(opts!.signal!);
        }
        yield tool;
        yield { type: "done" };
      }),
      { ...policy, maxRecoveries: 1 },
    );
    await collect(model);
    await expect(collect(model)).rejects.toThrow("recovery allowance");
    expect(calls).toBe(3);
  });

  test("user cancellation never retries", async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = createThinkingRecoveryModel(
      fake(async function* (_, opts) {
        calls++;
        yield { type: "thinking", delta: "thinking" };
        controller.abort(new Error("user stopped"));
        await waitAbort(opts!.signal!);
      }),
      policy,
    );
    await expect(collect(model, { ...options, signal: controller.signal })).rejects.toThrow(
      "user stopped",
    );
    expect(calls).toBe(1);
  });

  test("provider failures and silent requests are not automatically retried", async () => {
    let calls = 0;
    const model = createThinkingRecoveryModel(
      // biome-ignore lint/correctness/useYield: deliberate failing test double — it must expose the async-generator interface and reject on first next()
      fake(async function* () {
        calls++;
        throw new Error("HTTP failure");
      }),
      policy,
    );
    await expect(collect(model)).rejects.toThrow("HTTP failure");
    expect(calls).toBe(1);
  });

  test("fast tasks, nonstreaming auxiliary calls, and tool-free streams stay unchanged", async () => {
    const base = fake(async function* (actual, opts) {
      expect(actual).toBe(messages);
      if (!opts?.tools) await sleep(70);
      yield { type: "text", delta: "ok" };
      yield { type: "done" };
    });
    const model = createThinkingRecoveryModel(base, policy);
    expect(await collect(model)).toEqual([{ type: "text", delta: "ok" }, { type: "done" }]);
    expect(await collect(model, {})).toHaveLength(2);
    expect(await model.complete(messages)).toEqual({ text: "auxiliary" });
  });

  test("invalid policy rejected; non-stream model remains non-streaming", () => {
    const model: LanguageModel = {
      label: "test",
      complete: async () => ({ text: "ok" }),
    };
    expect(() => createThinkingRecoveryModel(model, { ...policy, noActionMs: 0 })).toThrow();
    expect(() => createThinkingRecoveryModel(model, { ...policy, maxRecoveries: -1 })).toThrow();
    expect(createThinkingRecoveryModel(model, policy).completeStream).toBeUndefined();
  });
});
