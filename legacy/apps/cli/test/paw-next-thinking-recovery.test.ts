import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "bun:test";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompleteOptions,
  ModelStreamChunk,
} from "@paw/models";

import {
  PAW_NEXT_THINKING_RECOVERY_POLICY_V1,
  preparePawNextProductRuntimeIdentityV3,
} from "../../../../packages/paw-next/src/composition.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface StallModelHarness {
  readonly model: LanguageModel;
  readonly requests: ChatMessage[][];
}

/**
 * Request 1 streams thinking deltas forever without text or tool output — the
 * desktop-harness-ab V15 max-effort stall shape. Request 2 acts immediately.
 */
function stallThenActModel(): StallModelHarness {
  const requests: ChatMessage[][] = [];
  const model: LanguageModel = {
    label: "openai:glm-stall-test",
    capabilities: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "glm-stall-test",
      baseUrl: "https://example.invalid/v1",
    },
    async complete() {
      throw new Error("stream transport must not fall back to complete()");
    },
    async *completeStream(
      messages: readonly ChatMessage[],
      options?: ModelCompleteOptions,
    ): AsyncGenerator<ModelStreamChunk> {
      requests.push([...messages]);
      if (requests.length === 1) {
        yield { type: "thinking", delta: "planning the implementation " };
        await new Promise<never>((_, reject) => {
          const keepThinking = setInterval(() => undefined, 20);
          options?.signal?.addEventListener(
            "abort",
            () => {
              clearInterval(keepThinking);
              reject(
                (options.signal?.reason as Error | undefined) ??
                  new Error("stalled stream aborted"),
              );
            },
            { once: true },
          );
        });
      }
      yield {
        type: "tool_use",
        id: "call-1",
        name: "workspace_write_file",
        input: '{"path":"src/queue.ts"}',
      };
      yield {
        type: "done",
        finishReason: "tool_calls",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
  return { model, requests };
}

const REQUEST_OPTIONS = {
  tools: [
    {
      type: "function" as const,
      function: {
        name: "workspace_write_file",
        description: "write a file",
        parameters: {},
      },
    },
  ],
  maxOutputTokens: 8_192,
};

test("V3 identity runtime rescues a thinking-only generation with one instructed retry", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paw-thinking-"));
  roots.push(workspaceRoot);
  const { model, requests } = stallThenActModel();
  const events: string[] = [];
  const prepared = preparePawNextProductRuntimeIdentityV3({
    workspaceRoot,
    sessionId: "session-thinking-recovery",
    runId: "run-thinking-recovery",
    inputId: "input-thinking-recovery",
    goal: "test thinking recovery",
    model,
    transport: "stream",
    thinkingRecovery: {
      policyVersion: "test:thinking-recovery:60ms",
      noActionMs: 60,
      maxRecoveries: 1,
    },
    onThinkingRecoveryEvent: (telemetry) => {
      events.push(
        `${telemetry.event.type}:${telemetry.event.reason}:${telemetry.event.recoveriesUsed}`,
      );
    },
  });

  const settlement = await prepared.model.execute(
    {
      messages: [{ role: "user", content: "implement and test" }],
      options: REQUEST_OPTIONS,
    },
    {
      signal: new AbortController().signal,
      onStreamEvent: () => undefined,
    },
  );

  expect(requests).toHaveLength(2);
  expect(settlement.status).toBe("success");
  if (settlement.status !== "success") throw new Error("expected success");
  expect(settlement.toolCalls).toHaveLength(1);
  expect(settlement.toolCalls[0]?.name).toBe("workspace_write_file");
  // The rescue retry carries the incremental-execution instruction.
  const retryInstruction = requests[1]?.at(-1);
  expect(retryInstruction?.role).toBe("system");
  expect(String(retryInstruction?.content)).toContain(
    "Incremental execution mode",
  );
  // Interrupted usage is unknown and must be surfaced, never treated as free.
  expect(events[0]).toBe("interrupted:thinking_without_action:0");
  expect(events).toContain("retry:thinking_without_action:1");
});

test("thinkingRecovery: false disables the rescue even when extensions enable it", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paw-thinking-"));
  roots.push(workspaceRoot);
  const { model, requests } = stallThenActModel();
  const prepared = preparePawNextProductRuntimeIdentityV3({
    workspaceRoot,
    sessionId: "session-thinking-recovery-off",
    runId: "run-thinking-recovery-off",
    inputId: "input-thinking-recovery-off",
    goal: "test thinking recovery disabled",
    model,
    transport: "stream",
    thinkingRecovery: false,
  });

  // Without the rescue, a stalled generation is not retried: the caller-side
  // abort (mirroring the host run signal) settles it as cancelled.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  let settlement: Awaited<ReturnType<typeof prepared.model.execute>>;
  try {
    settlement = await prepared.model.execute(
      {
        messages: [{ role: "user", content: "implement and test" }],
        options: REQUEST_OPTIONS,
      },
      {
        signal: controller.signal,
        onStreamEvent: () => undefined,
      },
    );
  } finally {
    clearTimeout(timer);
  }
  expect(requests).toHaveLength(1);
  expect(settlement.status).toBe("cancelled");
});

test("default rescue policy stays below the supervision reasoning-only deadline", () => {
  expect(PAW_NEXT_THINKING_RECOVERY_POLICY_V1.noActionMs).toBeLessThan(600_000);
  expect(PAW_NEXT_THINKING_RECOVERY_POLICY_V1.maxRecoveries).toBeGreaterThan(0);
});

test("V3 runtime honors an explicit phase-effort policy per request", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paw-phase-"));
  roots.push(workspaceRoot);
  const efforts: Array<string | undefined> = [];
  const model: LanguageModel = {
    label: "openai:phase-wire-test",
    capabilities: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "glm-5.3-flash",
      baseUrl: "https://example.invalid/v1",
      reasoningEffort: "max",
    },
    async complete() {
      throw new Error("stream transport expected");
    },
    async *completeStream(
      _messages: readonly ChatMessage[],
      options?: ModelCompleteOptions,
    ): AsyncGenerator<ModelStreamChunk> {
      efforts.push(options?.reasoningEffort);
      yield {
        type: "tool_use",
        id: "call-1",
        name: "workspace_write_file",
        input: '{"path":"src/a.ts"}',
      };
      yield {
        type: "done",
        finishReason: "tool_calls",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
  const phases: string[] = [];
  const prepared = preparePawNextProductRuntimeIdentityV3({
    workspaceRoot,
    sessionId: "session-phase-effort",
    runId: "run-phase-effort",
    inputId: "input-phase-effort",
    goal: "test phase effort",
    model,
    transport: "stream",
    phaseEffort: {
      policyVersion: "test:phase-effort:max1",
      planningEffort: "max",
      executionEffort: "high",
      planningCalls: 1,
    },
    onPhaseEffortEvent: (telemetry) => {
      phases.push(`${telemetry.event.call}:${telemetry.event.effort}`);
    },
  });
  for (let index = 0; index < 2; index += 1) {
    const settlement = await prepared.model.execute(
      {
        messages: [{ role: "user", content: "implement" }],
        options: REQUEST_OPTIONS,
      },
      {
        signal: new AbortController().signal,
        onStreamEvent: () => undefined,
      },
    );
    expect(settlement.status).toBe("success");
  }
  expect(efforts).toEqual(["max", "high"]);
  expect(phases).toEqual(["0:max", "1:high"]);
});

test("outputMaskingThresholdChars encodes into the output-recall plugin identity", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paw-mask-"));
  roots.push(workspaceRoot);
  const identityModel: LanguageModel = {
    label: "openai:mask-threshold-test",
    capabilities: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "glm-5.3-flash",
      baseUrl: "https://example.invalid/v1",
    },
    async complete() {
      return { text: "ok", finishReason: "stop" };
    },
  };
  const prepared = preparePawNextProductRuntimeIdentityV3({
    workspaceRoot,
    sessionId: "session-mask-threshold",
    runId: "run-mask-threshold",
    inputId: "input-mask-threshold",
    goal: "test masking threshold",
    model: identityModel,
    outputMaskingThresholdChars: 4_000,
  });
  const recall = prepared.registry.plugins.find(
    (plugin) => plugin.pluginId === "paw.output-recall",
  );
  expect(recall?.pluginVersion).toContain("t4000");
  // head/tail scale down with the threshold (freeze requires head+tail <= 4000).
  expect(recall?.pluginVersion).toContain("h2000");
  expect(recall?.pluginVersion).toContain("l2000");
});
