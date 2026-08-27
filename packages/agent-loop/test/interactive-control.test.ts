import { describe, expect, test } from "bun:test";
import type { InputFactV1 } from "@paw/protocol";

import {
  type InteractiveControlConfigV1,
  createInteractiveControlReducerV1,
} from "../src/index.js";

const config: InteractiveControlConfigV1 = {
  mode: "interactive",
  maxModelTurns: 8,
  naturalStop: "complete",
};

describe("interactive control reducer", () => {
  const reducer = createInteractiveControlReducerV1();

  test("treats a natural stop as a configured reducer decision", () => {
    const state = reducer.reduce(
      [model({ status: "completed", hasToolCalls: false })],
      config,
    );
    expect(state.decision).toEqual({
      kind: "completed",
      reason: "interactive-natural-stop",
    });
  });

  test("continues through tool calls and ordinary tool business failures", () => {
    expect(
      reducer.reduce(
        [
          model({ status: "completed", hasToolCalls: true }),
          tool({ status: "failed" }),
        ],
        config,
      ).decision,
    ).toEqual({ kind: "continue" });
  });

  test("fails closed for unknown effects, denial, runtime failure and abort", () => {
    expect(reducer.reduce(toolBatch("unknown"), config).decision.kind).toBe(
      "incomplete",
    );
    expect(reducer.reduce(toolBatch("rejected"), config).decision.kind).toBe(
      "await_user",
    );
    expect(
      reducer.reduce(
        [
          {
            type: "runtime.failed",
            area: "context",
            errorCode: "E_CONTEXT",
            message: "bad context",
            retryable: false,
          },
        ],
        config,
      ).decision,
    ).toEqual({ kind: "failed", reason: "E_CONTEXT" });
    expect(
      reducer.reduce(
        [{ type: "abort.requested", source: "user", reason: "stop" }],
        config,
      ).decision,
    ).toEqual({ kind: "aborted", reason: "stop" });
  });

  test("does not let provider stop bypass the interactive wait rule", () => {
    const state = reducer.reduce(
      [model({ status: "completed", hasToolCalls: false })],
      { ...config, naturalStop: "await_user" },
    );
    expect(state.decision).toEqual({
      kind: "await_user",
      reason: "interactive-turn-finished",
    });
  });

  test("reduces every result in a parallel batch regardless of result order", () => {
    for (const statuses of [
      ["unknown", "completed"],
      ["completed", "unknown"],
    ] as const) {
      expect(reducer.reduce(toolBatch(...statuses), config).decision).toEqual({
        kind: "incomplete",
        reason: "tool-result-unknown",
      });
    }
    for (const statuses of [
      ["rejected", "completed"],
      ["completed", "rejected"],
    ] as const) {
      expect(reducer.reduce(toolBatch(...statuses), config).decision).toEqual({
        kind: "await_user",
        reason: "tool-permission-rejected",
      });
    }
  });

  test("an empty natural stop is incomplete in either interactive mode", () => {
    const facts = [
      model({
        status: "completed",
        hasToolCalls: false,
        hasVisibleOutput: false,
      }),
    ];
    for (const naturalStop of ["complete", "await_user"] as const) {
      expect(
        reducer.reduce(facts, { ...config, naturalStop }).decision,
      ).toEqual({
        kind: "incomplete",
        reason: "model-visible-output-missing",
      });
    }
  });

  test("enforces the frozen model-turn budget before another tool batch", () => {
    const state = reducer.reduce(
      [
        model({ turn: 1, status: "completed", hasToolCalls: true }),
        model({ turn: 2, status: "completed", hasToolCalls: true }),
      ],
      { ...config, maxModelTurns: 2 },
    );
    expect(state.decision).toEqual({
      kind: "incomplete",
      reason: "model-turn-budget-exhausted",
    });
  });
});

function model(
  input: Partial<Extract<InputFactV1, { type: "model.settled" }>>,
): Extract<InputFactV1, { type: "model.settled" }> {
  return {
    type: "model.settled",
    modelCallId: `model-${input.turn ?? 1}`,
    turn: input.turn ?? 1,
    status: input.status ?? "completed",
    hasToolCalls: input.hasToolCalls ?? false,
    hasVisibleOutput: input.hasVisibleOutput ?? true,
  };
}

function tool(
  input: Partial<Extract<InputFactV1, { type: "tool.settled" }>>,
): Extract<InputFactV1, { type: "tool.settled" }> {
  return {
    type: "tool.settled",
    callId: input.callId ?? "call-1",
    status: input.status ?? "completed",
  };
}

function toolBatch(
  ...statuses: readonly Extract<
    InputFactV1,
    { type: "tool.settled" }
  >["status"][]
): InputFactV1[] {
  return [
    model({ status: "completed", hasToolCalls: true }),
    ...statuses.map(
      (_status, index): InputFactV1 => ({
        type: "tool.call_observed",
        callId: `call-${index}`,
        modelCallId: "model-1",
        turn: 1,
        tool: "workspace_read_file",
        args: { path: `file-${index}.txt` },
        order: index,
      }),
    ),
    ...statuses.map((status, index) =>
      tool({ callId: `call-${index}`, status }),
    ),
  ];
}
