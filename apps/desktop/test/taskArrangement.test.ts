import { expect, test } from "bun:test";
import { arrangeDesktopTask, parseTaskArrangement } from "../agent-host/task-arrangement.js";

test("task arrangement never starts a request after cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("user stopped"));
  let calls = 0;
  await expect(
    arrangeDesktopTask(
      {
        label: "fixture",
        async complete() {
          calls++;
          return { text: '{"taskMode":"long","visualAudit":true}' };
        },
      },
      "task",
      controller.signal,
    ),
  ).rejects.toThrow("user stopped");
  expect(calls).toBe(0);
});

test("task arrangement uses a bounded tool-free model request and validates the result", async () => {
  const result = await arrangeDesktopTask(
    {
      label: "fixture",
      async complete(messages, options) {
        expect(messages.at(-1)?.content).toBe("重做界面并完成验收");
        expect(options?.tools).toBeUndefined();
        expect(options?.maxOutputTokens).toBe(2048);
        expect(options?.thinkingEnabled).toBe(false);
        return { text: '{"taskMode":"long","visualAudit":true}' };
      },
    },
    "重做界面并完成验收",
  );
  expect(result).toEqual({ taskMode: "long", visualAudit: true });
  expect(() => parseTaskArrangement('{"taskMode":"delete","visualAudit":true}')).toThrow();
  expect(() => parseTaskArrangement('{"taskMode":"standard","visualAudit":"false"}')).toThrow();
});

test("task arrangement releases a hung classifier at its deadline", async () => {
  let requestSignal: AbortSignal | undefined;
  await expect(
    arrangeDesktopTask(
      {
        label: "fixture",
        complete(_messages, options) {
          requestSignal = options?.signal;
          return new Promise(() => {});
        },
      },
      "task",
      undefined,
      15,
    ),
  ).rejects.toMatchObject({ name: "TimeoutError" });
  expect(requestSignal?.aborted).toBe(true);
});

test("task arrangement discards a result produced during cancellation", async () => {
  const controller = new AbortController();
  await expect(
    arrangeDesktopTask(
      {
        label: "fixture",
        async complete() {
          controller.abort(new Error("stopped during routing"));
          return { text: '{"taskMode":"long","visualAudit":true}' };
        },
      },
      "task",
      controller.signal,
    ),
  ).rejects.toThrow("stopped during routing");
});
