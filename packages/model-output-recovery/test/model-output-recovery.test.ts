import { describe, expect, test } from "bun:test";
import type { PawAgentLoopModel, PawModelRequest } from "@paw/models";
import {
  createModelOutputRecoveryPluginV1,
  resolveModelOutputRecoveryBudgetV1,
} from "../src/index.js";

const callOptions = () => ({
  signal: new AbortController().signal,
  onStreamEvent: () => undefined,
});

describe("model output recovery plugin", () => {
  test("uses each model's native output limit without fixed tiers", () => {
    expect(resolveModelOutputRecoveryBudgetV1()).toEqual({
      defaultMaxOutputTokens: 8_192,
      recoveryMaxOutputTokens: 8_192,
    });
    expect(resolveModelOutputRecoveryBudgetV1(100_000)).toEqual({
      defaultMaxOutputTokens: 100_000,
      recoveryMaxOutputTokens: 100_000,
    });
    expect(resolveModelOutputRecoveryBudgetV1(200_000)).toEqual({
      defaultMaxOutputTokens: 200_000,
      recoveryMaxOutputTokens: 200_000,
    });
    expect(resolveModelOutputRecoveryBudgetV1(16_000)).toEqual({
      defaultMaxOutputTokens: 16_000,
      recoveryMaxOutputTokens: 16_000,
    });
  });

  test("continues with the native cap and combines usage and reasoning", async () => {
    const requests: PawModelRequest[] = [];
    const model: PawAgentLoopModel = {
      async execute(request) {
        requests.push(request);
        if (requests.length === 1) {
          return {
            status: "truncated",
            message: {
              text: "first ",
              reasoningPassback: "reasoning-state",
              finishReason: "length",
              usage: { promptTokens: 10, completionTokens: 32_000 },
            },
            toolCalls: [],
            reason: "cut off",
            finishReason: "length",
          };
        }
        return {
          status: "success",
          message: {
            text: "second",
            finishReason: "stop",
            usage: { promptTokens: 20, completionTokens: 2 },
          },
          toolCalls: [],
        };
      },
    };

    const result = await createModelOutputRecoveryPluginV1(model, {
      nativeMaxOutputTokens: 200_000,
    }).execute(
      { messages: [{ role: "user", content: "work" }] },
      callOptions(),
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(requests.map((request) => request.options?.maxOutputTokens)).toEqual(
      [200_000, 200_000],
    );
    expect(requests[1]?.messages.at(-2)).toEqual({
      role: "assistant",
      content: "first ",
      reasoningPassback: "reasoning-state",
    });
    expect(requests[1]?.messages.at(-1)?.content).toContain(
      "No tool call from the truncated response was executed",
    );
    expect(result.message.text).toBe("first second");
    expect(result.message.usage).toEqual({
      promptTokens: 30,
      completionTokens: 32_002,
      totalTokens: 32_032,
    });
  });

  test("recovery respects both a smaller context reserve and the native limit", async () => {
    for (const [native, reserve, expected] of [
      [384_000, 384_000, 384_000],
      [128_000, 16_000, 16_000],
      [4_096, 8_192, 4_096],
    ]) {
      const limits: Array<number | undefined> = [];
      const model: PawAgentLoopModel = {
        async execute(request) {
          limits.push(request.options?.maxOutputTokens);
          return limits.length === 1
            ? {
                status: "truncated",
                message: { text: "", finishReason: "length" },
                toolCalls: [],
                reason: "cut off",
                finishReason: "length",
              }
            : { status: "success", message: { text: "done" }, toolCalls: [] };
        },
      };
      await createModelOutputRecoveryPluginV1(model, {
        nativeMaxOutputTokens: native,
        reservedOutputTokens: reserve,
      }).execute(
        { messages: [], options: { maxOutputTokens: 1024 } },
        callOptions(),
      );
      expect(limits).toEqual([1024, expected]);
    }
    expect(() => resolveModelOutputRecoveryBudgetV1(0)).toThrow();
    expect(() => resolveModelOutputRecoveryBudgetV1(Number.NaN)).toThrow();
  });

  test("never exposes a tool call from a truncated attempt", async () => {
    let calls = 0;
    const model: PawAgentLoopModel = {
      async execute() {
        calls += 1;
        if (calls === 1) {
          const partialCall = {
            id: "partial",
            name: "run_shell",
            arguments: {},
            rawArguments: "{",
            sourceIndex: 0,
            argumentsValid: false,
          };
          return {
            status: "truncated",
            message: {
              text: "",
              finishReason: "length",
              toolCalls: [partialCall],
            },
            toolCalls: [partialCall],
            reason: "cut off",
            finishReason: "length",
          };
        }
        const completeCall = {
          id: "complete",
          name: "run_shell",
          arguments: { command: "git status" },
          rawArguments: '{"command":"git status"}',
          sourceIndex: 0,
          argumentsValid: true,
        };
        return {
          status: "success",
          message: {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [completeCall],
          },
          toolCalls: [completeCall],
        };
      },
    };

    const result = await createModelOutputRecoveryPluginV1(model).execute(
      { messages: [{ role: "user", content: "inspect" }] },
      callOptions(),
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") throw new Error("expected success");
    expect(result.toolCalls.map((call) => call.id)).toEqual(["complete"]);
    expect(result.message.toolCalls?.map((call) => call.id)).toEqual([
      "complete",
    ]);
  });

  test("stops after three continuations and returns no executable calls", async () => {
    let calls = 0;
    const model: PawAgentLoopModel = {
      async execute() {
        calls += 1;
        const partialCall = {
          id: `partial-${calls}`,
          name: "run_shell",
          arguments: {},
          rawArguments: "{",
          sourceIndex: 0,
          argumentsValid: false,
        };
        return {
          status: "truncated",
          message: {
            text: String(calls),
            finishReason: "max_tokens",
            toolCalls: [partialCall],
          },
          toolCalls: [partialCall],
          reason: "cut off",
          finishReason: "max_tokens",
        };
      },
    };

    const result = await createModelOutputRecoveryPluginV1(model).execute(
      { messages: [{ role: "user", content: "work" }] },
      callOptions(),
    );

    expect(calls).toBe(4);
    expect(result.status).toBe("truncated");
    if (result.status !== "truncated") throw new Error("expected truncation");
    expect(result.message.text).toBe("1234");
    expect(result.toolCalls).toEqual([]);
    expect(result.reason).toContain("after 3 continuations");
  });
});
