import { describe, expect, test } from "bun:test";
import {
  type ProviderResponseV2,
  createProviderTerminalStateV2,
  normalizeProviderResponseV2,
} from "../src/loop-v2/index.js";

const RUN_ID = "provider-terminal-replay";

function response(
  turn: number,
  overrides: Partial<ProviderResponseV2> = {},
): ProviderResponseV2 {
  return {
    runId: RUN_ID,
    turn,
    finishReason: "stop",
    visibleText: "",
    toolCalls: [],
    ...overrides,
  };
}

describe("Loop Kernel v2 provider terminal normalization", () => {
  test("R11 natural stop with visible text creates a candidate, never completed", () => {
    const result = normalizeProviderResponseV2(
      createProviderTerminalStateV2(RUN_ID),
      response(1, { visibleText: "Implemented and verified the minimal fix." }),
    );

    expect(result.decision).toEqual({
      kind: "candidate_proposed",
      source: "natural_stop",
      visibleText: "Implemented and verified the minimal fix.",
    });
    expect("completed" in result.decision).toBeFalse();
    expect("executionStatus" in result.decision).toBeFalse();
  });

  test("tool calls take priority over simultaneous terminal prose", () => {
    const calls = [
      { callId: "read", tool: "workspace.read_file", args: { path: "a.ts" } },
      { callId: "grep", tool: "workspace.grep", args: { pattern: "x" } },
    ];
    const result = normalizeProviderResponseV2(
      createProviderTerminalStateV2(RUN_ID),
      response(1, {
        finishReason: "tool_calls",
        visibleText: "I think this is done.",
        toolCalls: calls,
      }),
    );

    expect(result.decision).toEqual({ kind: "dispatch_tools", calls });
  });

  test("explicit control actions advance the provider turn and reset recovery", () => {
    const empty = normalizeProviderResponseV2(
      createProviderTerminalStateV2(RUN_ID),
      response(1),
    );
    const control = normalizeProviderResponseV2(
      empty.state,
      response(2, { controlAction: "ask_user" }),
    );
    const laterEmpty = normalizeProviderResponseV2(control.state, response(3));

    expect(control.decision).toEqual({
      kind: "dispatch_control",
      control: "ask_user",
    });
    expect(control.state.pendingProtocolIssue).toBeUndefined();
    expect(laterEmpty.decision).toMatchObject({
      kind: "recover_protocol",
      issue: "empty_response",
    });
  });

  test("parse correction does not reopen an exhausted protocol budget", () => {
    const empty = normalizeProviderResponseV2(
      createProviderTerminalStateV2(RUN_ID),
      response(1),
    );
    const malformed = normalizeProviderResponseV2(
      empty.state,
      response(2, { controlAction: "parse_recovery" }),
    );
    const laterEmpty = normalizeProviderResponseV2(
      malformed.state,
      response(3),
    );

    expect(malformed.decision).toEqual({
      kind: "dispatch_control",
      control: "parse_recovery",
    });
    expect(malformed.state.pendingProtocolIssue).toBe("empty_response");
    expect(laterEmpty.decision).toMatchObject({
      kind: "incomplete",
      reasonCode: "empty_response",
    });
  });

  test("legacy final_answer maps to a candidate without completion authority", () => {
    const result = normalizeProviderResponseV2(
      createProviderTerminalStateV2(RUN_ID),
      response(1, {
        visibleText: '{"action":"final_answer"}',
        legacyFinalAnswer: { summary: "Legacy completion claim." },
      }),
    );

    expect(result.decision).toEqual({
      kind: "candidate_proposed",
      source: "legacy_final_answer",
      visibleText: "Legacy completion claim.",
    });
    expect("completed" in result.decision).toBeFalse();
  });

  test("R12 two consecutive empty stops recover once then end incomplete", () => {
    const first = normalizeProviderResponseV2(
      createProviderTerminalStateV2(RUN_ID),
      response(1),
    );
    const second = normalizeProviderResponseV2(first.state, response(2));

    expect(first.decision).toEqual({
      kind: "recover_protocol",
      issue: "empty_response",
      attempt: 1,
    });
    expect(second.decision).toMatchObject({
      kind: "incomplete",
      reasonCode: "empty_response",
    });
  });

  test("a valid intervening response resets consecutive protocol recovery", () => {
    const first = normalizeProviderResponseV2(
      createProviderTerminalStateV2(RUN_ID),
      response(1),
    );
    const tools = normalizeProviderResponseV2(
      first.state,
      response(2, {
        finishReason: "tool_calls",
        toolCalls: [
          {
            callId: "read",
            tool: "workspace.read_file",
            args: { path: "a.ts" },
          },
        ],
      }),
    );
    const laterEmpty = normalizeProviderResponseV2(tools.state, response(3));

    expect(tools.state.pendingProtocolIssue).toBeUndefined();
    expect(laterEmpty.decision).toMatchObject({
      kind: "recover_protocol",
      issue: "empty_response",
    });
  });

  test("length never dispatches possibly truncated calls and is bounded", () => {
    const truncated = response(1, {
      finishReason: "length",
      toolCalls: [
        {
          callId: "unsafe",
          tool: "workspace.write_file",
          args: { path: "a.ts" },
        },
      ],
    });
    const first = normalizeProviderResponseV2(
      createProviderTerminalStateV2(RUN_ID),
      truncated,
    );
    const second = normalizeProviderResponseV2(first.state, {
      ...truncated,
      turn: 2,
    });

    expect(first.decision).toEqual({
      kind: "recover_protocol",
      issue: "truncated_response",
      attempt: 1,
    });
    expect(second.decision).toMatchObject({
      kind: "incomplete",
      reasonCode: "truncated_response",
    });
    expect(first.decision.kind).not.toBe("dispatch_tools");
  });

  test("alternating protocol faults cannot reopen the one-shot recovery budget", () => {
    const empty = normalizeProviderResponseV2(
      createProviderTerminalStateV2(RUN_ID),
      response(1),
    );
    const length = normalizeProviderResponseV2(
      empty.state,
      response(2, { finishReason: "length" }),
    );

    expect(length.decision).toMatchObject({
      kind: "incomplete",
      reasonCode: "truncated_response",
    });
  });

  test("run and turn mismatches fail before producing a decision", () => {
    const state = createProviderTerminalStateV2(RUN_ID);
    expect(() =>
      normalizeProviderResponseV2(state, {
        ...response(1),
        runId: "different-run",
      }),
    ).toThrow("run mismatch");
    expect(() => normalizeProviderResponseV2(state, response(2))).toThrow(
      "turn must be contiguous",
    );
  });
});
