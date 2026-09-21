import { describe, expect, test } from "bun:test";
import type { InputFactV1 } from "@paw/protocol";

import {
  CONTEXT_COMPACT_PROVIDER_TOOL_V1,
  createContextCompactToolPluginV1,
  projectPendingContextCompactRequestV1,
} from "../src/index.js";

function compactObserved(seq: number, callId = `call-${seq}`): InputFactV1 {
  return {
    type: "tool.call_observed",
    callId,
    modelCallId: `model-${seq}`,
    turn: 1,
    tool: CONTEXT_COMPACT_PROVIDER_TOOL_V1,
    args: {},
    order: 0,
  } as InputFactV1;
}

function otherObserved(seq: number): InputFactV1 {
  return {
    type: "tool.call_observed",
    callId: `other-${seq}`,
    modelCallId: `model-${seq}`,
    turn: 1,
    tool: "workspace_read_file",
    args: {},
    order: 0,
  } as InputFactV1;
}

function settled(
  seq: number,
  status: "completed" | "failed",
  callId = `call-${seq}`,
): InputFactV1 {
  return {
    type: "tool.settled",
    callId,
    status,
  } as InputFactV1;
}

function checkpoint(): InputFactV1 {
  return {
    type: "context.checkpoint_recorded",
    checkpointId: "cp",
    policyVersion: "p",
    sourceFromSeq: 1,
    sourceThroughSeq: 3,
    sourceInputHash: "h",
    checkpoint: { schemaVersion: 1, payload: {} },
  } as unknown as InputFactV1;
}

describe("projectPendingContextCompactRequestV1", () => {
  test("a successful compact request is pending", () => {
    expect(
      projectPendingContextCompactRequestV1([
        otherObserved(1),
        settled(1, "completed", "other-1"),
        compactObserved(2),
        settled(2, "completed"),
      ]),
    ).toBe(true);
  });

  test("a newer checkpoint consumes the request", () => {
    expect(
      projectPendingContextCompactRequestV1([
        compactObserved(1),
        settled(1, "completed"),
        checkpoint(),
      ]),
    ).toBe(false);
  });

  test("a failed request never counts", () => {
    expect(
      projectPendingContextCompactRequestV1([
        compactObserved(1),
        settled(1, "failed"),
      ]),
    ).toBe(false);
  });

  test("no request means no pending compaction", () => {
    expect(
      projectPendingContextCompactRequestV1([
        otherObserved(1),
        settled(1, "completed", "other-1"),
      ]),
    ).toBe(false);
  });

  test("a request after a checkpoint is pending again", () => {
    expect(
      projectPendingContextCompactRequestV1([
        compactObserved(1),
        settled(1, "completed"),
        checkpoint(),
        compactObserved(2),
        settled(2, "completed"),
      ]),
    ).toBe(true);
  });
});

describe("createContextCompactToolPluginV1", () => {
  test("rejects non-empty arguments and classifies as a read-only no-op", () => {
    const plugin = createContextCompactToolPluginV1();
    expect(plugin.entries).toHaveLength(1);
    const entry = plugin.entries[0];
    if (!entry) throw new Error("missing entry");
    expect(entry.validate({})).toEqual({ ok: true, args: {} });
    expect(entry.validate({ force: true }).ok).toBe(false);
    const classification = entry.classify({}, "E:\\work\\repo");
    expect(classification.effectClass).toBe("read");
    expect(classification.resources).toEqual([]);
  });
});
