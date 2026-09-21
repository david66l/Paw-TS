import { describe, expect, test } from "bun:test";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { InputFactV1 } from "@paw/protocol";

import {
  RUN_DIAGNOSTICS_POLICY_VERSION_V1,
  projectRunDiagnosticsV1,
} from "../src/index.js";

let seq = 0;

function fact(value: unknown): { seq: number; fact: InputFactV1 } {
  seq += 1;
  return { seq, fact: value as InputFactV1 };
}

function settledTurn(
  turn: number,
  hasToolCalls: boolean,
): { seq: number; fact: InputFactV1 } {
  return fact({
    type: "model.settled",
    modelCallId: `model-${turn}`,
    turn,
    status: "completed",
    hasToolCalls,
    hasVisibleOutput: !hasToolCalls,
  });
}

function observed(
  turn: number,
  callId: string,
  tool: string,
  args: Record<string, unknown> = {},
): { seq: number; fact: InputFactV1 } {
  return fact({
    type: "tool.call_observed",
    callId,
    modelCallId: `model-${turn}`,
    turn,
    tool,
    args,
    order: 0,
  });
}

function toolSettled(
  callId: string,
  ok: boolean,
  payload?: Record<string, unknown>,
): { seq: number; fact: InputFactV1 } {
  return fact({
    type: "tool.settled",
    callId,
    status: "completed",
    observation: {
      isError: !ok,
      summary: ok ? "ok" : "failed",
      ...(payload === undefined ? {} : { payload }),
    },
  });
}

function snapshot(
  entries: readonly { seq: number; fact: InputFactV1 }[],
): SessionInputSnapshot<InputFactV1> {
  return { entries, latestInputSeq: seq } as SessionInputSnapshot<InputFactV1>;
}

describe("projectRunDiagnosticsV1", () => {
  test("counts turns, calls, mutations, and verification outcomes", () => {
    const diagnostics = projectRunDiagnosticsV1(
      snapshot([
        settledTurn(1, true),
        observed(1, "w1", "workspace_write_file", { path: "a.ts" }),
        toolSettled("w1", true),
        settledTurn(2, true),
        observed(2, "t1", "workspace_run_shell", {
          command: "node --test a.test.js",
        }),
        toolSettled("t1", true),
        settledTurn(3, false),
      ]),
    );
    expect(diagnostics.policyVersion).toBe(RUN_DIAGNOSTICS_POLICY_VERSION_V1);
    expect(diagnostics.modelTurns).toBe(3);
    expect(diagnostics.textOnlyTurns).toBe(1);
    expect(diagnostics.toolCallsSettled).toBe(2);
    expect(diagnostics.mutationCalls).toBe(1);
    expect(diagnostics.verificationPassed).toBe(1);
    expect(diagnostics.maxConsecutiveStallTurns).toBe(0);
  });

  test("detects consecutive read-only stall windows (analysis-paralysis proxy)", () => {
    const entries: { seq: number; fact: InputFactV1 }[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      entries.push(settledTurn(turn, true));
      entries.push(
        observed(turn, `r${turn}`, "workspace_read_file", {
          path: `f${turn}.ts`,
        }),
      );
      entries.push(toolSettled(`r${turn}`, true));
    }
    // Recovery: turn 5 writes source.
    entries.push(settledTurn(5, true));
    entries.push(observed(5, "w5", "workspace_edit_file", { path: "f1.ts" }));
    entries.push(toolSettled("w5", true));
    // One more read-only stall turn after the recovery.
    entries.push(settledTurn(6, true));
    entries.push(observed(6, "r6", "workspace_read_file", { path: "f6.ts" }));
    entries.push(toolSettled("r6", true));

    const diagnostics = projectRunDiagnosticsV1(snapshot(entries));
    // Turns 1-4 are the longest read-only window; turn 5's mutation resets
    // the streak, and turn 6 alone cannot exceed it.
    expect(diagnostics.maxConsecutiveStallTurns).toBe(4);
    expect(diagnostics.modelTurns).toBe(6);
    expect(diagnostics.mutationCalls).toBe(1);
  });

  test("counts back-to-back identical calls as repeats", () => {
    const diagnostics = projectRunDiagnosticsV1(
      snapshot([
        settledTurn(1, true),
        observed(1, "a", "workspace_read_file", { path: "same.ts" }),
        toolSettled("a", true),
        settledTurn(2, true),
        observed(2, "b", "workspace_read_file", { path: "same.ts" }),
        toolSettled("b", true),
      ]),
    );
    expect(diagnostics.exactRepeatCalls).toBe(1);
    expect(diagnostics.maxConsecutiveStallTurns).toBe(2);
  });

  test("aggregates review and checkpoint facts", () => {
    const diagnostics = projectRunDiagnosticsV1(
      snapshot([
        settledTurn(1, false),
        fact({
          type: "completion.review_claimed",
          reviewId: "r1",
          candidateHash: "h",
          claimedAt: 1,
          policyVersion: "p",
          reviewerId: "rev",
          sourceThroughSeq: 1,
          triggers: [],
        }),
        fact({
          type: "completion.review_settled",
          reviewId: "r1",
          status: "completed",
          verdict: "continue",
          reasonCode: "unresolved_failure",
          summary: "keep going",
          settledAt: 2,
        }),
        fact({
          type: "context.checkpoint_recorded",
          checkpointId: "cp",
          policyVersion: "p",
          sourceFromSeq: 1,
          sourceThroughSeq: 2,
          sourceInputHash: "h",
          checkpoint: { schemaVersion: 1, payload: {} },
        }),
      ]),
    );
    expect(diagnostics.completionReviewsClaimed).toBe(1);
    expect(diagnostics.completionReviewBlocked).toBe(1);
    expect(diagnostics.checkpointsRecorded).toBe(1);
  });

  test("empty journals project to zeroed diagnostics", () => {
    const diagnostics = projectRunDiagnosticsV1(snapshot([]));
    expect(diagnostics.modelTurns).toBe(0);
    expect(diagnostics.toolCallsSettled).toBe(0);
    expect(diagnostics.adviceEvents).toEqual({});
  });
});
