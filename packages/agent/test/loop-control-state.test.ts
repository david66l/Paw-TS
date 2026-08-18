import { describe, expect, test } from "bun:test";
import {
  checkpointLoopControlV1,
  parseLoopControlCheckpointV1,
  resetLoopControlForRewindV1,
  restoreLoopControlFlagsV1,
} from "../src/loop-control-state.js";

const READINESS_KEY = "a".repeat(64);

describe("Loop control checkpoint v1", () => {
  test("round-trips provider cursor, readiness budget, and one pending control", () => {
    const checkpoint = checkpointLoopControlV1({
      autoContinueNudges: 0,
      lastTurnHadToolCall: false,
      hasEverUsedTools: true,
      providerTerminal: {
        runId: "run-1",
        lastTurn: 3,
        pendingProtocolIssue: "empty_response",
      },
      loopV2ReadinessFeedbackKey: READINESS_KEY,
      loopV2ReadinessNudges: 1,
      pendingControl: {
        kind: "readiness",
        text: "repair the missing verification",
      },
    });

    expect(parseLoopControlCheckpointV1(checkpoint)).toEqual(checkpoint);
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 3,
        value: checkpoint,
        legacyMessages: [],
      }),
    ).toEqual({
      providerTerminal: {
        runId: "run-1",
        lastTurn: 3,
        pendingProtocolIssue: "empty_response",
      },
      loopV2ReadinessFeedbackKey: READINESS_KEY,
      loopV2ReadinessNudges: 1,
      pendingControl: {
        kind: "readiness",
        text: "repair the missing verification",
      },
    });
  });

  test("rejects corrupt untyped JSON instead of trusting persisted control", () => {
    for (const value of [
      null,
      {},
      { schemaVersion: "paw.loop-control.v1" },
      {
        schemaVersion: "paw.loop-control.v1",
        providerTerminal: { runId: "run-1", lastTurn: -1 },
      },
      {
        schemaVersion: "paw.loop-control.v1",
        readiness: { key: "not-a-hash", nudges: 1 },
      },
      {
        schemaVersion: "paw.loop-control.v1",
        pendingControl: { kind: "readiness", text: "" },
      },
    ]) {
      expect(parseLoopControlCheckpointV1(value)).toBeUndefined();
    }
    expect(() =>
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 0,
        value: { schemaVersion: "paw.loop-control.v1" },
        legacyMessages: [],
      }),
    ).toThrow("Invalid loop-control checkpoint");
    expect(() =>
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 2,
        value: {
          schemaVersion: "paw.loop-control.v1",
          providerTerminal: { runId: "run-1", lastTurn: 1 },
        },
        legacyMessages: [],
      }),
    ).toThrow("does not match AppState");
  });

  test("uses a legacy readiness marker only when no v1 checkpoint exists", () => {
    const legacyMessages = [
      {
        role: "user" as const,
        content: `[LoopV2Readiness:needs_work key=${READINESS_KEY}]\nrepair`,
      },
    ];
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 0,
        value: undefined,
        legacyMessages,
      }),
    ).toEqual({
      loopV2ReadinessFeedbackKey: READINESS_KEY,
      loopV2ReadinessNudges: 1,
    });

    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 0,
        value: {
          schemaVersion: "paw.loop-control.v1",
          pendingControl: {
            kind: "protocol_recovery",
            text: "retry once",
          },
        },
        legacyMessages,
      }),
    ).toEqual({
      pendingControl: {
        kind: "protocol_recovery",
        text: "retry once",
      },
    });

    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 0,
        value: resetLoopControlForRewindV1("run-1", 0),
        legacyMessages,
      }),
    ).toEqual({
      providerTerminal: { runId: "run-1", lastTurn: 0 },
    });
  });
});
