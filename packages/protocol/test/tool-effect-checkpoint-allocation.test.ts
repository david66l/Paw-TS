import { describe, expect, test } from "bun:test";

import {
  type InputFactV1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  parseRunJournalPrefixV1,
} from "../src/index.js";

describe("tool effect checkpoint allocation protocol", () => {
  test("rejects orphan, pre-dispatch, pre-permission, denied, and post-settlement allocations", () => {
    const orphan = new PrefixBuilder();
    orphan.add(allocation("call-0", 0, 1));
    expect(() => orphan.parse()).toThrow("no observed call");

    const preDispatch = toolPrefix(["call-0"]);
    preDispatch.add(allocation("call-0", 0, 1));
    expect(() => preDispatch.parse()).toThrow("no dispatch");

    const prePermission = toolPrefix(["call-0"]);
    prePermission.add(dispatch("call-0", 0));
    prePermission.add(allocation("call-0", 0, 1));
    expect(() => prePermission.parse()).toThrow("requires allowed permission");

    const denied = toolPrefix(["call-0"]);
    denied.add(dispatch("call-0", 0));
    denied.add(permission("call-0", 0, "deny"));
    denied.add(allocation("call-0", 0, 1));
    expect(() => denied.parse()).toThrow("requires allowed permission");

    const settled = toolPrefix(["call-0"]);
    settled.add(dispatch("call-0", 0));
    settled.add(permission("call-0", 0));
    settled.add({
      type: "tool.settled",
      callId: "call-0",
      status: "completed",
    });
    settled.add(allocation("call-0", 0, 1));
    expect(() => settled.parse()).toThrow("follows settlement");
  });

  test("rejects duplicate, non-positive, non-increasing, and identity-drifted allocations", () => {
    const duplicate = toolPrefix(["call-0"]);
    duplicate.add(dispatch("call-0", 0));
    duplicate.add(permission("call-0", 0));
    duplicate.add(allocation("call-0", 0, 1));
    duplicate.add(allocation("call-0", 0, 2));
    expect(() => duplicate.parse()).toThrow("duplicate tool effect checkpoint");

    for (const checkpointSeq of [0, -1]) {
      const nonPositive = toolPrefix(["call-0"]);
      nonPositive.add(dispatch("call-0", 0));
      nonPositive.add(permission("call-0", 0));
      nonPositive.add({
        ...allocation("call-0", 0, 1),
        checkpointSeq,
      } as InputFactV1);
      expect(() => nonPositive.parse()).toThrow("positive");
    }

    for (const checkpointSeq of [2, 1]) {
      const nonIncreasing = authorizedTwoCallPrefix(2, checkpointSeq);
      expect(() => nonIncreasing.parse()).toThrow("strictly increasing");
    }

    for (const drift of [{ turn: 2 }, { sourceIndex: 1 }] as const) {
      const identity = toolPrefix(["call-0"]);
      identity.add(dispatch("call-0", 0));
      identity.add(permission("call-0", 0));
      identity.add({ ...allocation("call-0", 0, 1), ...drift });
      expect(() => identity.parse()).toThrow("identity mismatch");
    }
  });

  test("accepts allowed allocations in journal order and permits sequence gaps", () => {
    const prefix = authorizedTwoCallPrefix(2, 7);

    expect(prefix.parse()).toHaveLength(prefix.entries.length);
  });

  test("keeps an old allowed tool without an allocation protocol-valid for the resume migration gate", () => {
    const prefix = toolPrefix(["call-0"]);
    prefix.add(dispatch("call-0", 0));
    prefix.add(permission("call-0", 0));
    prefix.add({
      type: "tool.settled",
      callId: "call-0",
      status: "completed",
    });

    expect(prefix.parse()).toHaveLength(prefix.entries.length);
  });
});

function authorizedTwoCallPrefix(
  firstCheckpointSeq: number,
  secondCheckpointSeq: number,
): PrefixBuilder {
  const prefix = toolPrefix(["call-0", "call-1"]);
  prefix.add(dispatch("call-0", 0));
  prefix.add(permission("call-0", 0));
  prefix.add(allocation("call-0", 0, firstCheckpointSeq));
  prefix.add(dispatch("call-1", 1));
  prefix.add(permission("call-1", 1, "allow_rule"));
  prefix.add(allocation("call-1", 1, secondCheckpointSeq));
  return prefix;
}

function toolPrefix(callIds: readonly string[]): PrefixBuilder {
  const prefix = new PrefixBuilder();
  prefix.add({
    type: "model.dispatch_recorded",
    modelCallId: "model-1",
    turn: 1,
    requestHash: "request-1",
  });
  prefix.add({
    type: "model.settled",
    modelCallId: "model-1",
    turn: 1,
    status: "completed",
    hasToolCalls: true,
    hasVisibleOutput: false,
    response: {
      kind: "inline",
      value: {
        schemaVersion: "paw.model-response.v1",
        providerProtocol: "openai-compatible",
        assistantContent: "",
        finishReason: "tool_calls",
        toolCalls: callIds.map((callId, sourceIndex) => ({
          callId,
          name: "workspace_edit_file",
          rawArguments: "{}",
          args: {},
          sourceIndex,
          argumentsValid: true,
        })),
      },
      hash: "response-1",
    },
  });
  for (const [order, callId] of callIds.entries()) {
    prefix.add({
      type: "tool.call_observed",
      callId,
      modelCallId: "model-1",
      turn: 1,
      tool: "workspace_edit_file",
      args: {},
      order,
    });
  }
  return prefix;
}

function dispatch(
  callId: string,
  sourceIndex: number,
): Extract<InputFactV1, { type: "tool.dispatch_recorded" }> {
  return {
    type: "tool.dispatch_recorded",
    callId,
    turn: 1,
    sourceIndex,
    batchId: "batch-1",
    mode: "parallel",
  };
}

function permission(
  callId: string,
  sourceIndex: number,
  resolution: "allow_once" | "allow_rule" | "deny" = "allow_once",
): Extract<InputFactV1, { type: "tool.permission_resolved" }> {
  return {
    type: "tool.permission_resolved",
    callId,
    turn: 1,
    sourceIndex,
    tool: "workspace_edit_file",
    policyVersion: "permission-v1",
    resolution,
    source: resolution === "allow_rule" ? "user_prompt" : "base_policy",
    ...(resolution === "allow_rule" ? { ruleId: "run-rule-1" } : {}),
  };
}

function allocation(
  callId: string,
  sourceIndex: number,
  checkpointSeq: number,
): Extract<InputFactV1, { type: "tool.effect_checkpoint_allocated" }> {
  return {
    type: "tool.effect_checkpoint_allocated",
    callId,
    turn: 1,
    sourceIndex,
    checkpointSeq,
  };
}

class PrefixBuilder {
  readonly entries: unknown[] = [];

  add(fact: InputFactV1): void {
    const seq = this.entries.length + 1;
    this.entries.push({
      schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
      sessionId: "session-1",
      runId: "run-1",
      seq,
      ts: 1_750_000_000_000 + seq,
      record: { kind: "input_fact", fact },
    });
  }

  parse() {
    return parseRunJournalPrefixV1(this.entries);
  }
}
