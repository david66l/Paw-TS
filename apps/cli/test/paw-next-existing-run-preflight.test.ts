import { describe, expect, test } from "bun:test";
import {
  type DurableJsonPayloadV1,
  type InputFactV1,
  type JsonValue,
  type ModelResponseV1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  TASK_CHECKPOINT_SCHEMA_VERSION_V1,
} from "@paw/protocol";

import { assertPawNextInlinePayloadPreflightV1 } from "../src/paw-next/existing-run-preflight.js";
import { hashCanonicalJsonV1 } from "../src/paw-next/product-manifest.js";

describe("Paw Next existing-run payload preflight", () => {
  test("rejects artifact references at every durable product payload position", () => {
    for (const [name, prefix] of artifactPositions()) {
      expect(
        () =>
          assertPawNextInlinePayloadPreflightV1(prefix, "openai-compatible"),
        name,
      ).toThrow(/artifact resolver/i);
    }
  });

  test("rejects hash drift at every inline durable product payload position", () => {
    for (const [name, prefix] of badHashPositions()) {
      expect(
        () =>
          assertPawNextInlinePayloadPreflightV1(prefix, "openai-compatible"),
        name,
      ).toThrow(/hash mismatch/i);
    }
  });

  test("accepts a truncated native response with no executable observation", () => {
    const response = modelResponse();
    expect(() =>
      assertPawNextInlinePayloadPreflightV1(
        modelPrefix(
          inlinePayload(response as unknown as JsonValue),
          "truncated",
        ),
        "openai-compatible",
      ),
    ).not.toThrow();
  });

  test("accepts typed inline context and distillation checkpoints", () => {
    const payload = inlinePayload(taskCheckpoint());
    for (const prefix of [
      recordedCheckpointPrefix(payload),
      distilledCheckpointPrefix(payload),
    ]) {
      expect(() =>
        assertPawNextInlinePayloadPreflightV1(prefix, "openai-compatible"),
      ).not.toThrow();
    }
  });

  test("rejects completed native response and observation drift before repair", () => {
    const response = modelResponse();
    const payload = inlinePayload({ ok: true });
    const cases: ReadonlyArray<
      readonly [string, readonly RunJournalEnvelopeV1[]]
    > = [
      [
        "count",
        modelPrefix(
          inlinePayload(response as unknown as JsonValue),
          "completed",
        ),
      ],
      ["name", toolPrefix(payload, {}, { tool: "workspace_write_file" })],
      ["order", twoCallOrderDriftPrefix(payload)],
      ["arguments", toolPrefix(payload, {}, { args: { path: "other.md" } })],
    ];
    for (const [name, prefix] of cases) {
      expect(
        () =>
          assertPawNextInlinePayloadPreflightV1(prefix, "openai-compatible"),
        name,
      ).toThrow(/response\/observation (count|identity) mismatch/i);
    }
  });

  test("rejects an observation forged from an invalid native call", () => {
    const response: ModelResponseV1 = {
      ...modelResponse(),
      toolCalls: [
        {
          callId: "call-1",
          name: "workspace_read_file",
          rawArguments: "{not-json",
          args: {},
          sourceIndex: 0,
          argumentsValid: false,
        },
      ],
    };
    expect(() =>
      assertPawNextInlinePayloadPreflightV1(
        toolPrefix(inlinePayload({ ok: true }), {}, {}, response),
        "openai-compatible",
      ),
    ).toThrow(/invalid native calls cannot have observations/i);
  });

  test("rejects legacy tool result carriers even when Protocol can read them", () => {
    const prefix = toolPrefix(inlinePayload({ ok: true }), {
      result: { legacy: true },
      resultHash: "legacy-result-hash",
    });
    expect(() =>
      assertPawNextInlinePayloadPreflightV1(prefix, "openai-compatible"),
    ).toThrow(/legacy tool result evidence/i);
  });
});

function artifactPositions(): ReadonlyArray<
  readonly [string, readonly RunJournalEnvelopeV1[]]
> {
  const payload = artifactPayload();
  return [
    ["attachment", attachmentPrefix(payload)],
    ["model response", modelPrefix(payload, "completed")],
    ["tool observation", toolPrefix(payload)],
    ["context checkpoint", recordedCheckpointPrefix(payload)],
    ["distilled checkpoint", distilledCheckpointPrefix(payload)],
  ];
}

function badHashPositions(): ReadonlyArray<
  readonly [string, readonly RunJournalEnvelopeV1[]]
> {
  return [
    ["attachment", attachmentPrefix(inlinePayload("text", "wrong-hash"))],
    [
      "model response",
      modelPrefix(
        inlinePayload(modelResponse() as unknown as JsonValue, "wrong-hash"),
        "completed",
      ),
    ],
    ["tool observation", toolPrefix(inlinePayload({ ok: true }, "wrong-hash"))],
    [
      "context checkpoint",
      recordedCheckpointPrefix(inlinePayload(taskCheckpoint(), "wrong-hash")),
    ],
    [
      "distilled checkpoint",
      distilledCheckpointPrefix(inlinePayload(taskCheckpoint(), "wrong-hash")),
    ],
  ];
}

function baseFacts(): InputFactV1[] {
  return [
    {
      type: "attempt.started",
      goalHash: "goal-hash",
      configHash: "config-hash",
    },
    {
      type: "input.promoted",
      inputId: "input-1",
      delivery: "initial",
      content: "goal",
      contentHash: "goal-hash",
    },
  ];
}

function attachmentPrefix(
  payload: DurableJsonPayloadV1,
): readonly RunJournalEnvelopeV1[] {
  return envelopes([
    ...baseFacts(),
    {
      type: "input.accepted",
      inputId: "attachment-input",
      delivery: "queue",
      content: "inspect attachment",
      contentHash: "attachment-input-hash",
      callerId: "test",
      attachments: [
        {
          attachmentId: "attachment-1",
          type: "file",
          name: "evidence.txt",
          content: payload,
        },
      ],
    },
  ]);
}

function modelPrefix(
  payload: DurableJsonPayloadV1,
  status: "completed" | "truncated",
): readonly RunJournalEnvelopeV1[] {
  return envelopes([
    ...baseFacts(),
    modelDispatch(),
    {
      type: "model.settled",
      modelCallId: "model-1",
      turn: 1,
      status,
      hasToolCalls: true,
      hasVisibleOutput: false,
      response: payload,
      finishReason: "tool_calls",
    },
  ]);
}

function toolPrefix(
  payload: DurableJsonPayloadV1,
  settlementPatch: Readonly<Record<string, unknown>> = {},
  observedPatch: Readonly<{
    tool?: string;
    order?: number;
    args?: JsonValue;
  }> = {},
  response: ModelResponseV1 = modelResponse(),
): readonly RunJournalEnvelopeV1[] {
  const observed = {
    tool: observedPatch.tool ?? "workspace_read_file",
    order: observedPatch.order ?? 0,
    args: observedPatch.args ?? { path: "README.md" },
  };
  return envelopes([
    ...baseFacts(),
    modelDispatch(),
    {
      type: "model.settled",
      modelCallId: "model-1",
      turn: 1,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
      response: inlinePayload(response as unknown as JsonValue),
      finishReason: "tool_calls",
    },
    {
      type: "tool.call_observed",
      callId: "call-1",
      modelCallId: "model-1",
      turn: 1,
      tool: observed.tool,
      args: observed.args,
      order: observed.order,
    },
    {
      type: "tool.dispatch_recorded",
      callId: "call-1",
      turn: 1,
      sourceIndex: observed.order,
      batchId: "batch-1",
      mode: "parallel",
    },
    {
      type: "tool.permission_resolved",
      callId: "call-1",
      turn: 1,
      sourceIndex: observed.order,
      tool: observed.tool,
      policyVersion: "permission.v1",
      resolution: "allow_once",
      source: "base_policy",
    },
    {
      type: "tool.settled",
      callId: "call-1",
      status: "completed",
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        summary: "read complete",
        isError: false,
        payload,
      },
      ...settlementPatch,
    },
  ] as InputFactV1[]);
}

function recordedCheckpointPrefix(
  payload: DurableJsonPayloadV1,
): readonly RunJournalEnvelopeV1[] {
  return envelopes([
    ...baseFacts(),
    {
      type: "context.checkpoint_recorded",
      checkpointId: "checkpoint-1",
      policyVersion: "checkpoint.v1",
      sourceFromSeq: 1,
      sourceThroughSeq: 2,
      sourceInputHash: "source-hash",
      checkpoint: payload,
    },
  ]);
}

function twoCallOrderDriftPrefix(
  payload: DurableJsonPayloadV1,
): readonly RunJournalEnvelopeV1[] {
  const response: ModelResponseV1 = {
    ...modelResponse(),
    toolCalls: [
      modelResponse().toolCalls[0] as ModelResponseV1["toolCalls"][number],
      {
        callId: "call-2",
        name: "workspace_read_file",
        rawArguments: '{"path":"OTHER.md"}',
        args: { path: "OTHER.md" },
        sourceIndex: 1,
        argumentsValid: true,
      },
    ],
  };
  const observed = [
    { callId: "call-2", path: "OTHER.md", order: 0 },
    { callId: "call-1", path: "README.md", order: 1 },
  ] as const;
  const facts: InputFactV1[] = [
    ...baseFacts(),
    modelDispatch(),
    {
      type: "model.settled",
      modelCallId: "model-1",
      turn: 1,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
      response: inlinePayload(response as unknown as JsonValue),
      finishReason: "tool_calls",
    },
  ];
  for (const item of observed) {
    facts.push({
      type: "tool.call_observed",
      callId: item.callId,
      modelCallId: "model-1",
      turn: 1,
      tool: "workspace_read_file",
      args: { path: item.path },
      order: item.order,
    });
  }
  for (const item of observed) {
    facts.push(
      {
        type: "tool.dispatch_recorded",
        callId: item.callId,
        turn: 1,
        sourceIndex: item.order,
        batchId: "batch-1",
        mode: "parallel",
      },
      {
        type: "tool.permission_resolved",
        callId: item.callId,
        turn: 1,
        sourceIndex: item.order,
        tool: "workspace_read_file",
        policyVersion: "permission.v1",
        resolution: "allow_once",
        source: "base_policy",
      },
      {
        type: "tool.settled",
        callId: item.callId,
        status: "completed",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          summary: "read complete",
          isError: false,
          payload,
        },
      },
    );
  }
  return envelopes(facts);
}

function distilledCheckpointPrefix(
  payload: DurableJsonPayloadV1,
): readonly RunJournalEnvelopeV1[] {
  return envelopes([
    ...baseFacts(),
    {
      type: "context.checkpoint_distillation_claimed",
      claimId: "claim-1",
      checkpointId: "checkpoint-distilled-1",
      boundary: "after_model_turn_without_tool_calls",
      policyVersion: "checkpoint.v1",
      sourceFromSeq: 1,
      sourceThroughSeq: 2,
      sourceInputHash: "source-hash",
    },
    {
      type: "context.checkpoint_distillation_settled",
      claimId: "claim-1",
      status: "completed",
      checkpoint: payload,
    },
  ]);
}

function modelDispatch(): InputFactV1 {
  return {
    type: "model.dispatch_recorded",
    modelCallId: "model-1",
    turn: 1,
    requestHash: "request-hash",
  };
}

function modelResponse(): ModelResponseV1 {
  return {
    schemaVersion: "paw.model-response.v1",
    providerProtocol: "openai-compatible",
    assistantContent: "",
    finishReason: "tool_calls",
    toolCalls: [
      {
        callId: "call-1",
        name: "workspace_read_file",
        rawArguments: '{"path":"README.md"}',
        args: { path: "README.md" },
        sourceIndex: 0,
        argumentsValid: true,
      },
    ],
  };
}

function taskCheckpoint(): JsonValue {
  return {
    schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION_V1,
    goal: { statement: "finish the task", sourceSeqs: [2] },
    confirmedFacts: [],
    currentHypotheses: [],
    ruledOut: [],
    changedFiles: [],
    verification: [],
    unresolved: [],
    nextAction: { statement: "continue", sourceSeqs: [2] },
  };
}

function inlinePayload(
  value: JsonValue,
  hash = hashCanonicalJsonV1(value),
): DurableJsonPayloadV1 {
  return { kind: "inline", value, hash };
}

function artifactPayload(): DurableJsonPayloadV1 {
  return {
    kind: "artifact_ref",
    artifactRef: "artifact:test/payload",
    hash: "artifact-hash",
  };
}

function envelopes(
  facts: readonly InputFactV1[],
): readonly RunJournalEnvelopeV1[] {
  return facts.map((fact, index) => ({
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq: index + 1,
    ts: 1_750_000_000_000 + index,
    record: { kind: "input_fact", fact },
  }));
}
