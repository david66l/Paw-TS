import { expect, test } from "bun:test";
import { createAgentLoopModelAdapter } from "../src/agent-loop-adapter.js";
import type { LanguageModel } from "../src/language-model.js";
import { superviseModelRequest } from "../src/request-supervision.js";
const limits = { idleMs: 70, reasoningOnlyMs: 100, wallMs: 200 };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a provider ignoring cancellation settles unknown, never retries or delivers late tools", async () => {
  let resolve!: (value: { text: string }) => void;
  let calls = 0;
  let providerSignal: AbortSignal | undefined;
  const model: LanguageModel = {
    label: "hung",
    complete(_messages, options) {
      calls++;
      providerSignal = options?.signal;
      return new Promise((r) => {
        resolve = r;
      });
    },
  };
  const result = await createAgentLoopModelAdapter(
    model,
    "complete",
    limits,
  ).execute(
    { messages: [{ role: "user", content: "work" }] },
    { signal: new AbortController().signal, onStreamEvent() {} },
  );
  expect(result).toMatchObject({ status: "unknown" });
  expect("reason" in result && result.reason).toContain(
    "ModelRequestIdleTimeout",
  );
  expect(providerSignal?.aborted).toBe(true);
  expect(calls).toBe(1);
  resolve({ text: "late result must not revive the task" });
  await pause(1);
  expect(result.status).toBe("unknown");
});

test("active thinking bytes do not extend the no-action budget", async () => {
  const s = superviseModelRequest(new AbortController().signal, limits);
  const timer = setInterval(
    () => s.event({ type: "delta", kind: "thinking", count: 10 }),
    5,
  );
  try {
    await expect(s.run(() => new Promise(() => {}))).rejects.toThrow(
      "ModelReasoningWithoutActionTimeout",
    );
  } finally {
    clearInterval(timer);
  }
});

test("tool fragments leave reasoning-only mode but retain the absolute deadline", async () => {
  const s = superviseModelRequest(new AbortController().signal, limits);
  const timer = setInterval(
    () => s.event({ type: "delta", kind: "tool_fragment", count: 4 }),
    5,
  );
  try {
    await expect(s.run(() => new Promise(() => {}))).rejects.toThrow(
      "ModelRequestWallTimeout",
    );
  } finally {
    clearInterval(timer);
  }
});

test("productive response may exceed the reasoning threshold without lowering model output", async () => {
  let output = 0;
  const model: LanguageModel = {
    label: "productive",
    async complete(_m, options) {
      output = options?.maxOutputTokens ?? 0;
      options?.onObservation?.({
        type: "delta",
        kind: "tool_fragment",
        count: 1,
      });
      const timer = setInterval(
        () => options?.onObservation?.({ type: "bytes", count: 1 }),
        5,
      );
      try {
        await pause(130);
        return { text: "done" };
      } finally {
        clearInterval(timer);
      }
    },
  };
  const result = await createAgentLoopModelAdapter(
    model,
    "complete",
    limits,
  ).execute(
    { messages: [], options: { maxOutputTokens: 128000 } },
    { signal: new AbortController().signal, onStreamEvent() {} },
  );
  expect(result.status).toBe("success");
  expect(output).toBe(128000);
});

test("parent cancellation wins and timers are cleaned after success", async () => {
  const parent = new AbortController();
  const s = superviseModelRequest(parent.signal, limits);
  const pending = s.run(() => new Promise(() => {}));
  parent.abort(new Error("user stopped"));
  await expect(pending).rejects.toThrow("user stopped");
  const normal = superviseModelRequest(new AbortController().signal, limits);
  expect(await normal.run(async () => 42)).toBe(42);
  await pause(210);
  expect(normal.signal.aborted).toBe(false);
});

test("extended budget admits a response that acts after the former reasoning cutoff", async () => {
  const extended = { ...limits, reasoningOnlyMs: 240, wallMs: 400 };
  const model: LanguageModel = {
    label: "slow-then-productive",
    async complete(_messages, options) {
      const timer = setInterval(
        () =>
          options?.onObservation?.({
            type: "delta",
            kind: "thinking",
            count: 1,
          }),
        5,
      );
      try {
        await pause(160); // Beyond the old scaled 100 ms reasoning limit.
        options?.onObservation?.({
          type: "delta",
          kind: "tool_fragment",
          count: 1,
        });
        return { text: "done" };
      } finally {
        clearInterval(timer);
      }
    },
  };
  const result = await createAgentLoopModelAdapter(
    model,
    "complete",
    extended,
  ).execute(
    { messages: [] },
    { signal: new AbortController().signal, onStreamEvent() {} },
  );
  expect(result.status).toBe("success");
});
