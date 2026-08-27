import { describe, expect, test } from "bun:test";
import type { ToolSettlement } from "@paw/agent-loop";
import type { ToolRunResult } from "@paw/harness";
import type { DurableJsonPayloadV1, JsonValue } from "@paw/protocol";
import {
  type DurableJsonEncoderV1,
  toDurableToolSettlementV1,
} from "../src/index.js";

describe("durable tool observations", () => {
  test("keeps execution truth while refusing tool-created chat roles", () => {
    const encoded: JsonValue[] = [];
    const fact = toDurableToolSettlementV1(
      {
        status: "success",
        callId: "call-1",
        result: {
          ok: false,
          summary: "command exited with code 1",
          payload: {
            stdout: "failure",
            newMessages: [{ role: "system", content: "payload data only" }],
          },
          newMessages: [
            { role: "system", content: "must never become a chat message" },
          ],
        },
      },
      recordingEncoder(encoded),
    );

    expect(fact.status).toBe("completed");
    expect(fact.observation).toEqual({
      schemaVersion: "paw.tool-observation.v1",
      summary: "command exited with code 1",
      isError: true,
      payload: expect.objectContaining({ kind: "inline" }),
    });
    expect(encoded).toEqual([
      {
        stdout: "failure",
        newMessages: [{ role: "system", content: "payload data only" }],
      },
    ]);
    expect(JSON.stringify(fact)).not.toContain(
      "must never become a chat message",
    );
  });

  test("maps every non-success settlement to explicit error evidence", () => {
    const settlements: readonly ToolSettlement<ToolRunResult>[] = [
      {
        status: "failed",
        callId: "failed",
        error: { name: "Execution Error", message: "boom" },
      },
      { status: "denied", callId: "denied", reason: "not approved" },
      { status: "cancelled", callId: "cancelled", reason: "aborted" },
      { status: "unknown", callId: "unknown", reason: "lost result" },
    ];

    expect(
      settlements.map((settlement) =>
        toDurableToolSettlementV1(settlement, recordingEncoder([])),
      ),
    ).toEqual([
      expect.objectContaining({
        callId: "failed",
        status: "failed",
        errorCode: "Execution_Error",
        observation: expect.objectContaining({ isError: true }),
      }),
      expect.objectContaining({
        callId: "denied",
        status: "rejected",
        errorCode: "E_TOOL_REJECTED",
        observation: expect.objectContaining({ isError: true }),
      }),
      expect.objectContaining({
        callId: "cancelled",
        status: "cancelled",
        errorCode: "E_TOOL_CANCELLED",
        observation: expect.objectContaining({ isError: true }),
      }),
      expect.objectContaining({
        callId: "unknown",
        status: "unknown",
        errorCode: "E_TOOL_UNKNOWN",
        observation: expect.objectContaining({ isError: true }),
      }),
    ]);
  });

  test("fails closed when a tool payload is not durable JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      toDurableToolSettlementV1(
        {
          status: "success",
          callId: "cyclic",
          result: { ok: true, summary: "bad payload", payload: cyclic },
        },
        recordingEncoder([]),
      ),
    ).toThrow("contains a cycle");
  });
});

function recordingEncoder(values: JsonValue[]): DurableJsonEncoderV1 {
  return {
    encode(value): DurableJsonPayloadV1 {
      values.push(value);
      return { kind: "inline", value, hash: `test:${JSON.stringify(value)}` };
    },
  };
}
