import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompleteOptions,
  ModelStreamChunk,
} from "../src/index.js";
import {
  createAgentLoopModelAdapter,
  createPhaseEffortModel,
} from "../src/index.js";

function recordingModel(): {
  model: LanguageModel;
  efforts: Array<string | undefined>;
} {
  const efforts: Array<string | undefined> = [];
  const model: LanguageModel = {
    label: "openai:phase-effort-test",
    capabilities: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "glm-5.3-flash",
      baseUrl: "https://example.invalid/v1",
      reasoningEffort: "max",
    },
    async complete() {
      efforts.push("complete-untouched");
      return { text: "ok", finishReason: "stop" };
    },
    async *completeStream(
      _messages: readonly ChatMessage[],
      options?: ModelCompleteOptions,
    ): AsyncGenerator<ModelStreamChunk> {
      efforts.push(options?.reasoningEffort);
      yield { type: "text", delta: "hi" };
      yield { type: "done", finishReason: "stop" };
    },
  };
  return { model, efforts };
}

const TOOLS = [
  {
    type: "function" as const,
    function: { name: "write", description: "w", parameters: {} },
  },
];

describe("phase-effort model", () => {
  test("planning calls use planning effort, later calls execution effort", async () => {
    const { model, efforts } = recordingModel();
    const wrapped = createPhaseEffortModel(model, {
      planningEffort: "max",
      executionEffort: "high",
      planningCalls: 2,
    });
    for (let index = 0; index < 4; index += 1) {
      for await (const _chunk of wrapped.completeStream!(
        [{ role: "user", content: "go" }],
        { tools: TOOLS },
      )) {
        // drain
      }
    }
    expect(efforts).toEqual(["max", "max", "high", "high"]);
  });

  test("tool-less stream calls and complete() never participate", async () => {
    const { model, efforts } = recordingModel();
    const wrapped = createPhaseEffortModel(model, {
      planningEffort: "max",
      executionEffort: "high",
      planningCalls: 1,
    });
    for await (const _chunk of wrapped.completeStream!([
      { role: "user", content: "aux" },
    ])) {
      // drain — no tools: passthrough
    }
    await wrapped.complete([{ role: "user", content: "aux" }]);
    // The first tool-bearing call is still planning.
    for await (const _chunk of wrapped.completeStream!(
      [{ role: "user", content: "go" }],
      { tools: TOOLS },
    )) {
      // drain
    }
    // The tool-less stream passes through untouched (undefined effort);
    // complete() never participates; the first tool-bearing call is planning.
    expect(efforts).toEqual([undefined, "complete-untouched", "max"]);
  });

  test("reports phase telemetry per tool-bearing call", async () => {
    const { model } = recordingModel();
    const events: string[] = [];
    const wrapped = createPhaseEffortModel(model, {
      planningEffort: "max",
      executionEffort: "high",
      planningCalls: 1,
      onEvent: (event) =>
        events.push(`${event.call}:${event.phase}:${event.effort}`),
    });
    for (let index = 0; index < 2; index += 1) {
      for await (const _chunk of wrapped.completeStream!(
        [{ role: "user", content: "go" }],
        { tools: TOOLS },
      )) {
        // drain
      }
    }
    expect(events).toEqual(["0:planning:max", "1:execution:high"]);
  });

  test("rejects invalid policies", () => {
    const { model } = recordingModel();
    expect(() =>
      createPhaseEffortModel(model, {
        planningEffort: "max",
        executionEffort: "high",
        planningCalls: -1,
      }),
    ).toThrow();
  });

  test("adapter forwards the phase effort into a real settlement", async () => {
    const { model, efforts } = recordingModel();
    const wrapped = createPhaseEffortModel(model, {
      planningEffort: "max",
      executionEffort: "high",
      planningCalls: 1,
    });
    const adapter = createAgentLoopModelAdapter(wrapped, "stream");
    const settlement = await adapter.execute(
      {
        messages: [{ role: "user", content: "work" }],
        options: { tools: TOOLS, maxOutputTokens: 1_024 },
      },
      { signal: new AbortController().signal, onStreamEvent: () => undefined },
    );
    expect(settlement.status).toBe("success");
    expect(efforts).toEqual(["max"]);
  });
});
