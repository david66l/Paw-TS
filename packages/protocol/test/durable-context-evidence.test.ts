import { describe, expect, test } from "bun:test";

import {
  MODEL_RESPONSE_SCHEMA_VERSION_V1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  TOOL_OBSERVATION_SCHEMA_VERSION_V1,
  isModelResponseV1,
  isRunJournalEnvelopeV1,
  isToolObservationV1,
  parseModelResponseV1,
  parseRunJournalEnvelopeV1,
  parseToolObservationV1,
} from "../src/index.js";

function envelope(fact: unknown): unknown {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq: 1,
    ts: 1,
    record: { kind: "input_fact", fact },
  };
}

function modelResponse(): Record<string, unknown> {
  return {
    schemaVersion: MODEL_RESPONSE_SCHEMA_VERSION_V1,
    providerProtocol: "openai-compatible",
    assistantContent: "Inspecting both files.",
    auditThinking: "private audit trace",
    reasoningPassback: "provider passback state",
    finishReason: "tool_calls",
    usage: {
      promptTokens: 10,
      completionTokens: 6,
      totalTokens: 16,
      cachedPromptTokens: 4,
    },
    toolCalls: [
      {
        callId: "call-1",
        name: "read_file",
        rawArguments: '{"path":"src/a.ts","lines":[1,20]}',
        args: { lines: [1, 20], path: "src/a.ts" },
        sourceIndex: 0,
        argumentsValid: true,
      },
      {
        callId: "call-2",
        name: "read_file",
        rawArguments: '{"path":"src/b.ts"}',
        args: { path: "src/b.ts" },
        sourceIndex: 1,
        argumentsValid: true,
      },
    ],
  };
}

function observation(isError: boolean): Record<string, unknown> {
  return {
    schemaVersion: TOOL_OBSERVATION_SCHEMA_VERSION_V1,
    summary: isError ? "tool did not complete safely" : "read 20 lines",
    isError,
    payload: {
      kind: "inline",
      value: { ok: !isError, content: "bounded model-visible evidence" },
      hash: "payload-hash",
    },
  };
}

function mutableToolCall(
  response: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const calls = response.toolCalls;
  if (!Array.isArray(calls)) throw new Error("test response has no calls");
  const call = calls[index];
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    throw new Error(`test response has no call at ${index}`);
  }
  return call as Record<string, unknown>;
}

describe("durable model response v1", () => {
  test("accepts one complete provider-neutral response with ordered native calls", () => {
    const value = modelResponse();
    expect(parseModelResponseV1(value) as unknown).toBe(value);
    expect(isModelResponseV1(value)).toBe(true);

    const settled = envelope({
      type: "model.settled",
      modelCallId: "model-1",
      turn: 1,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: true,
      response: { kind: "inline", value, hash: "response-hash" },
      finishReason: "tool_calls",
    });
    expect(parseRunJournalEnvelopeV1(settled) as unknown).toBe(settled);
  });

  test("requires continuous source order, unique call ids, and exact raw args", () => {
    const gap = modelResponse();
    mutableToolCall(gap, 1).sourceIndex = 2;
    expect(() => parseModelResponseV1(gap)).toThrow("contiguous");

    const duplicate = modelResponse();
    mutableToolCall(duplicate, 1).callId = "call-1";
    expect(() => parseModelResponseV1(duplicate)).toThrow("duplicate callId");

    const mismatch = modelResponse();
    mutableToolCall(mismatch, 0).args = {
      path: "src/not-a.ts",
      lines: [1, 20],
    };
    expect(() => parseModelResponseV1(mismatch)).toThrow("exactly match");
  });

  test("invalid arguments preserve raw evidence but never executable args", () => {
    const valid = modelResponse();
    valid.toolCalls = [
      {
        callId: "call-invalid",
        name: "write_file",
        rawArguments: "{not-json",
        args: {},
        sourceIndex: 0,
        argumentsValid: false,
      },
    ];
    expect(parseModelResponseV1(valid) as unknown).toBe(valid);

    const executable = modelResponse();
    executable.toolCalls = [
      {
        callId: "call-invalid",
        name: "write_file",
        rawArguments: '{"path":"x.ts"}',
        args: {},
        sourceIndex: 0,
        argumentsValid: false,
      },
    ];
    expect(() => parseModelResponseV1(executable)).toThrow("invalid arguments");
  });

  test("rejects unknown response fields and invalid usage counters", () => {
    expect(isModelResponseV1({ ...modelResponse(), providerBlob: true })).toBe(
      false,
    );
    expect(
      isModelResponseV1({
        ...modelResponse(),
        usage: { promptTokens: -1 },
      }),
    ).toBe(false);
    expect(
      isModelResponseV1({
        ...modelResponse(),
        usage: {},
      }),
    ).toBe(false);
    expect(() =>
      parseModelResponseV1({
        ...modelResponse(),
        providerProtocol: "anthropic-compatible",
      }),
    ).toThrow("cannot use string reasoningPassback");
  });

  test("keeps legacy artifact references readable but rejects unversioned inline JSON", () => {
    expect(
      isRunJournalEnvelopeV1(
        envelope({
          type: "model.settled",
          modelCallId: "legacy-model",
          turn: 1,
          status: "completed",
          hasToolCalls: false,
          hasVisibleOutput: true,
          response: {
            kind: "artifact_ref",
            artifactRef: "artifact:legacy-response",
            hash: "legacy-hash",
          },
        }),
      ),
    ).toBe(true);
    expect(
      isRunJournalEnvelopeV1(
        envelope({
          type: "model.settled",
          modelCallId: "legacy-model",
          turn: 1,
          status: "completed",
          hasToolCalls: false,
          hasVisibleOutput: true,
          response: {
            kind: "inline",
            value: { text: "unversioned response" },
            hash: "legacy-hash",
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("durable promoted-input attachments", () => {
  test("accepts immutable inline and artifact-backed attachments", () => {
    const value = envelope({
      type: "input.promoted",
      inputId: "input-1",
      delivery: "initial",
      content: "Inspect these files",
      contentHash: "input-with-attachments-hash",
      attachments: [
        {
          attachmentId: "attachment-image",
          type: "image",
          name: "screen.png",
          mimeType: "image/png",
          content: {
            kind: "inline",
            value: "base64-image-data",
            hash: "image-hash",
          },
        },
        {
          attachmentId: "attachment-file",
          type: "file",
          name: "trace.log",
          content: {
            kind: "artifact_ref",
            artifactRef: "artifact:trace-log",
            hash: "trace-hash",
          },
        },
      ],
    });
    expect(parseRunJournalEnvelopeV1(value) as unknown).toBe(value);
  });

  test("rejects duplicate ids, empty arrays, non-string inline content, and extras", () => {
    const attachment = {
      attachmentId: "attachment-1",
      type: "file",
      name: "a.txt",
      content: { kind: "inline", value: "a", hash: "a-hash" },
    };
    const promoted = (attachments: unknown) =>
      envelope({
        type: "input.promoted",
        inputId: "input-1",
        delivery: "initial",
        content: "inspect",
        contentHash: "content-hash",
        attachments,
      });

    expect(isRunJournalEnvelopeV1(promoted([]))).toBe(false);
    expect(
      isRunJournalEnvelopeV1(promoted([attachment, { ...attachment }])),
    ).toBe(false);
    expect(
      isRunJournalEnvelopeV1(
        promoted([
          {
            ...attachment,
            content: { kind: "inline", value: { text: "a" }, hash: "hash" },
          },
        ]),
      ),
    ).toBe(false);
    expect(
      isRunJournalEnvelopeV1(promoted([{ ...attachment, mutable: true }])),
    ).toBe(false);
  });
});

describe("model-visible tool observation v1", () => {
  test("strictly parses the standalone observation DTO", () => {
    const value = observation(false);
    expect(parseToolObservationV1(value) as unknown).toBe(value);
    expect(isToolObservationV1(value)).toBe(true);
    expect(isToolObservationV1({ ...value, role: "system" })).toBe(false);
  });

  test("supports every settlement status and retains legacy result hashes", () => {
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "unknown",
      "rejected",
    ] as const) {
      const fact = {
        type: "tool.settled",
        callId: `call-${status}`,
        status,
        observation: observation(status !== "completed"),
        result: { legacyEvidence: true },
        resultHash: `legacy-result-hash-${status}`,
        ...(status === "failed" || status === "rejected"
          ? { errorCode: `error-${status}` }
          : {}),
      };
      expect(isRunJournalEnvelopeV1(envelope(fact))).toBe(true);
    }
  });

  test("non-completed settlements cannot present themselves as success", () => {
    expect(
      isRunJournalEnvelopeV1(
        envelope({
          type: "tool.settled",
          callId: "call-unknown",
          status: "unknown",
          observation: observation(false),
        }),
      ),
    ).toBe(false);
  });

  test("keeps old settlements readable while malformed new observations fail", () => {
    expect(
      isRunJournalEnvelopeV1(
        envelope({
          type: "tool.settled",
          callId: "legacy-call",
          status: "completed",
          result: { ok: true },
          resultHash: "legacy-result-hash",
        }),
      ),
    ).toBe(true);
    expect(
      isRunJournalEnvelopeV1(
        envelope({
          type: "tool.settled",
          callId: "call-bad-observation",
          status: "completed",
          observation: { ...observation(false), mutable: true },
        }),
      ),
    ).toBe(false);
  });
});
