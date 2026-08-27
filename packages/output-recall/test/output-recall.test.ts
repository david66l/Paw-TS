import { describe, expect, test } from "bun:test";

import { CONTEXT_RECALL } from "@paw/harness";
import type { JsonValue, RunJournalEnvelopeV1 } from "@paw/protocol";
import { createFrozenToolRegistryV1 } from "@paw/runtime";

import {
  type OutputRecallPolicyV1,
  createDurableOutputRecallServiceV1,
  createOutputRecallProjectorV1,
  createOutputRecallToolPluginV1,
} from "../src/index.js";

const artifactId = `paw-payload:v1:${"a".repeat(64)}`;
const payloadHash = "b".repeat(64);
const signal = new AbortController().signal;
const policy: OutputRecallPolicyV1 = Object.freeze({
  previewThresholdChars: 20,
  previewHeadChars: 5,
  previewTailChars: 4,
  maxCharsPerRecall: 8,
  maxCharsPerTurn: 16,
  maxCharsPerRun: 32,
});

describe("output recall extension", () => {
  test("projects only large artifact observations and never re-stubs recall", async () => {
    const projector = createOutputRecallProjectorV1({ policy });
    const large = { text: "012345678901234567890123456789" };
    const projected = await projector.project(
      {
        callId: "producer-call",
        tool: "workspace_run_shell",
        carrierSeq: 6,
        status: "completed",
        isError: false,
        summary: "large",
        payload: {
          kind: "artifact_ref",
          artifactRef: artifactId,
          hash: payloadHash,
        },
        value: large,
      },
      signal,
    );

    expect(projected).toMatchObject({
      schemaVersion: "paw.output-recall-stub.v1",
      kind: "large_tool_output",
      id: artifactId,
      totalChars: JSON.stringify(large).length,
      source: { tool: "workspace_run_shell", callId: "producer-call" },
      recall: { tool: "context_recall", maxCharsPerCall: 8 },
    });

    const recallValue = { text: "x".repeat(40) };
    expect(
      await projector.project(
        {
          callId: "recall-call",
          tool: "context_recall",
          carrierSeq: 12,
          status: "completed",
          isError: false,
          summary: "recall",
          payload: {
            kind: "artifact_ref",
            artifactRef: artifactId,
            hash: payloadHash,
          },
          value: recallValue,
        },
        signal,
      ),
    ).toBe(recallValue);
  });

  test("stubs delegated reports earlier while leaving equal ordinary output inline", async () => {
    const projector = createOutputRecallProjectorV1();
    const value = { summary: "x".repeat(3_500) };
    const base = {
      callId: "delegated-call",
      carrierSeq: 8,
      status: "completed" as const,
      isError: false,
      summary: "delegated report",
      payload: {
        kind: "artifact_ref" as const,
        artifactRef: artifactId,
        hash: payloadHash,
      },
      value,
    };

    const delegated = await projector.project(
      { ...base, tool: "workspace_delegate" },
      signal,
    );
    if (
      !delegated ||
      typeof delegated !== "object" ||
      Array.isArray(delegated)
    ) {
      throw new Error("Delegated output was not projected to a recall stub");
    }
    const delegatedRecord = delegated as Readonly<Record<string, JsonValue>>;
    const preview = delegatedRecord.preview;
    if (!preview || typeof preview !== "object" || Array.isArray(preview)) {
      throw new Error("Delegated recall preview is invalid");
    }
    const previewRecord = preview as Readonly<Record<string, JsonValue>>;
    expect(delegatedRecord.kind).toBe("large_tool_output");
    expect(previewRecord.head).toBeString();
    expect(previewRecord.tail).toBeString();
    expect((previewRecord.head as string).length).toBe(1_000);
    expect((previewRecord.tail as string).length).toBe(500);

    expect(
      await projector.project(
        { ...base, callId: "read-call", tool: "workspace_read_file" },
        signal,
      ),
    ).toBe(value);
  });

  test("installs an exact-id, capped, read-only Harness tool", () => {
    const registry = createFrozenToolRegistryV1({
      tools: [],
      plugins: [createOutputRecallToolPluginV1({ policy })],
    });
    const valid = registry.validateAndClassify(
      {
        id: "recall-call",
        name: "context_recall",
        arguments: { id: artifactId, part: "chunk", offset: 4, limit: 8 },
      },
      process.cwd(),
    );
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.internalName).toBe(CONTEXT_RECALL);
      expect(valid.value.classification).toMatchObject({
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "exclusive",
      });
    }
    expect(
      registry.validateAndClassify(
        {
          id: "bad-call",
          name: "context_recall",
          arguments: { id: "../../secret", limit: 8 },
        },
        process.cwd(),
      ).ok,
    ).toBe(false);
    expect(
      registry.validateAndClassify(
        {
          id: "large-call",
          name: "context_recall",
          arguments: { id: artifactId, limit: 9 },
        },
        process.cwd(),
      ).ok,
    ).toBe(false);
  });

  test("pages verified Journal-bound output and rebuilds from the same prefix", async () => {
    const request = {
      id: artifactId,
      part: "chunk" as const,
      offset: 5,
      limit: 7,
    };
    const prefix = recallPrefix([request]);
    const largeValue = { output: "abcdefghijklmnopqrstuvwxyz" };
    let evidenceLoads = 0;
    const makeService = () =>
      createDurableOutputRecallServiceV1({
        policy,
        readCanonicalPrefix: () => prefix,
        loadPayloadEvidence: () => {
          evidenceLoads += 1;
          return fakeEvidence(largeValue);
        },
      });

    const first = await makeService().recall(request, signal);
    const afterRestart = await makeService().recall(request, signal);
    expect(first).toEqual(afterRestart);
    expect(first).toMatchObject({
      ok: true,
      id: artifactId,
      tool: "workspace_run_shell",
      callId: "producer-call",
      part: "chunk",
      offset: 5,
      length: 7,
      total: JSON.stringify(largeValue).length,
    });
    if (first.ok) {
      expect(first.content).toBe(JSON.stringify(largeValue).slice(5, 12));
    }
    expect(evidenceLoads).toBe(2);

    const unknown = await makeService().recall(
      { ...request, id: `paw-payload:v1:${"c".repeat(64)}` },
      signal,
    );
    expect(unknown).toEqual({
      ok: false,
      reason: "recall request is not canonically pending",
    });
  });

  test("charges all canonically pending calls before parallel execution", async () => {
    const tightPolicy = Object.freeze({
      ...policy,
      maxCharsPerTurn: 8,
      maxCharsPerRun: 16,
    });
    const first = {
      id: artifactId,
      part: "head" as const,
      offset: 0,
      limit: 8,
    };
    const second = {
      id: artifactId,
      part: "tail" as const,
      offset: 0,
      limit: 8,
    };
    const service = createDurableOutputRecallServiceV1({
      policy: tightPolicy,
      readCanonicalPrefix: () => recallPrefix([first, second]),
      loadPayloadEvidence: () => fakeEvidence({ output: "unused" }),
    });

    expect(await service.recall(first, signal)).toEqual({
      ok: false,
      reason: "turn recall budget exceeded",
    });
    expect(await service.recall(second, signal)).toEqual({
      ok: false,
      reason: "turn recall budget exceeded",
    });
  });

  test("rebuilds run quota from a completed recall settlement", async () => {
    const durablePolicy = Object.freeze({
      ...policy,
      maxCharsPerTurn: 8,
      maxCharsPerRun: 12,
    });
    const historical = {
      id: artifactId,
      part: "head" as const,
      offset: 0,
      limit: 8,
    };
    const current = {
      id: artifactId,
      part: "tail" as const,
      offset: 0,
      limit: 8,
    };
    const prefix = settledRecallPrefix(historical, current);
    const makeService = () =>
      createDurableOutputRecallServiceV1({
        policy: durablePolicy,
        readCanonicalPrefix: () => prefix,
        loadPayloadEvidence: () => fakeEvidence({ output: "unused" }),
      });

    expect(await makeService().recall(current, signal)).toEqual({
      ok: false,
      reason: "run recall budget exceeded",
    });
    expect(await makeService().recall(current, signal)).toEqual({
      ok: false,
      reason: "run recall budget exceeded",
    });
  });
});

function recallPrefix(
  recalls: readonly {
    readonly id: string;
    readonly part: "head" | "tail" | "chunk";
    readonly offset: number;
    readonly limit: number;
  }[],
): readonly RunJournalEnvelopeV1[] {
  const facts: Array<RunJournalEnvelopeV1["record"]> = [];
  facts.push(
    inputFact({
      type: "model.dispatch_recorded",
      modelCallId: "producer-model",
      turn: 1,
      requestHash: "producer-request",
    }),
    inputFact({
      type: "model.settled",
      modelCallId: "producer-model",
      turn: 1,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
      response: inline({
        schemaVersion: "paw.model-response.v1",
        providerProtocol: "openai-compatible",
        assistantContent: "",
        toolCalls: [nativeCall("producer-call", "workspace_run_shell", {}, 0)],
      }),
    }),
    inputFact({
      type: "tool.call_observed",
      callId: "producer-call",
      modelCallId: "producer-model",
      turn: 1,
      tool: "workspace_run_shell",
      args: {},
      order: 0,
    }),
    inputFact({
      type: "tool.dispatch_recorded",
      callId: "producer-call",
      turn: 1,
      sourceIndex: 0,
      batchId: "producer-batch",
      mode: "parallel",
    }),
    inputFact({
      type: "tool.permission_resolved",
      turn: 1,
      sourceIndex: 0,
      callId: "producer-call",
      tool: "workspace_run_shell",
      policyVersion: "permission-v1",
      resolution: "allow_once",
      source: "base_policy",
    }),
    inputFact({
      type: "tool.settled",
      callId: "producer-call",
      status: "completed",
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        summary: "large output",
        isError: false,
        payload: {
          kind: "artifact_ref",
          artifactRef: artifactId,
          hash: payloadHash,
        },
      },
    }),
    inputFact({
      type: "model.dispatch_recorded",
      modelCallId: "recall-model",
      turn: 2,
      requestHash: "recall-request",
    }),
    inputFact({
      type: "model.settled",
      modelCallId: "recall-model",
      turn: 2,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
      response: inline({
        schemaVersion: "paw.model-response.v1",
        providerProtocol: "openai-compatible",
        assistantContent: "",
        toolCalls: recalls.map((request, index) =>
          nativeCall(`recall-call-${index}`, "context_recall", request, index),
        ),
      }),
    }),
  );
  for (const [index, request] of recalls.entries()) {
    facts.push(
      inputFact({
        type: "tool.call_observed",
        callId: `recall-call-${index}`,
        modelCallId: "recall-model",
        turn: 2,
        tool: "context_recall",
        args: request,
        order: index,
      }),
      inputFact({
        type: "tool.dispatch_recorded",
        callId: `recall-call-${index}`,
        turn: 2,
        sourceIndex: index,
        batchId: "recall-batch",
        mode: "parallel",
      }),
      inputFact({
        type: "tool.permission_resolved",
        turn: 2,
        sourceIndex: index,
        callId: `recall-call-${index}`,
        tool: "context_recall",
        policyVersion: "permission-v1",
        resolution: "allow_once",
        source: "base_policy",
      }),
    );
  }
  return Object.freeze(
    facts.map((record, index) =>
      Object.freeze({
        schemaVersion: "paw.run-journal.v1" as const,
        sessionId: "session-output-recall",
        runId: "run-output-recall",
        seq: index + 1,
        ts: 1_800_000_000_000 + index,
        record,
      }),
    ),
  );
}

function settledRecallPrefix(
  historical: {
    readonly id: string;
    readonly part: "head" | "tail" | "chunk";
    readonly offset: number;
    readonly limit: number;
  },
  current: {
    readonly id: string;
    readonly part: "head" | "tail" | "chunk";
    readonly offset: number;
    readonly limit: number;
  },
): readonly RunJournalEnvelopeV1[] {
  const prefix = [...recallPrefix([historical])];
  const records: RunJournalEnvelopeV1["record"][] = [
    inputFact({
      type: "tool.settled",
      callId: "recall-call-0",
      status: "completed",
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        summary: "historical recall",
        isError: false,
        payload: inline("historical window"),
      },
    }),
    inputFact({
      type: "model.dispatch_recorded",
      modelCallId: "current-recall-model",
      turn: 3,
      requestHash: "current-recall-request",
    }),
    inputFact({
      type: "model.settled",
      modelCallId: "current-recall-model",
      turn: 3,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
      response: inline({
        schemaVersion: "paw.model-response.v1",
        providerProtocol: "openai-compatible",
        assistantContent: "",
        toolCalls: [
          nativeCall("current-recall-call", "context_recall", current, 0),
        ],
      }),
    }),
    inputFact({
      type: "tool.call_observed",
      callId: "current-recall-call",
      modelCallId: "current-recall-model",
      turn: 3,
      tool: "context_recall",
      args: current,
      order: 0,
    }),
    inputFact({
      type: "tool.dispatch_recorded",
      callId: "current-recall-call",
      turn: 3,
      sourceIndex: 0,
      batchId: "current-recall-batch",
      mode: "parallel",
    }),
    inputFact({
      type: "tool.permission_resolved",
      turn: 3,
      sourceIndex: 0,
      callId: "current-recall-call",
      tool: "context_recall",
      policyVersion: "permission-v1",
      resolution: "allow_once",
      source: "base_policy",
    }),
  ];
  return Object.freeze([
    ...prefix,
    ...records.map((record, index) =>
      Object.freeze({
        schemaVersion: "paw.run-journal.v1" as const,
        sessionId: "session-output-recall",
        runId: "run-output-recall",
        seq: prefix.length + index + 1,
        ts: 1_800_000_000_000 + prefix.length + index,
        record,
      }),
    ),
  ]);
}

function inputFact(
  fact: Extract<RunJournalEnvelopeV1["record"], { kind: "input_fact" }>["fact"],
): Extract<RunJournalEnvelopeV1["record"], { kind: "input_fact" }> {
  return { kind: "input_fact", fact };
}

function inline(value: JsonValue) {
  return { kind: "inline" as const, value, hash: "inline-hash" };
}

function nativeCall(
  callId: string,
  name: string,
  args: Readonly<Record<string, JsonValue>>,
  sourceIndex: number,
) {
  return {
    callId,
    name,
    rawArguments: JSON.stringify(args),
    args,
    sourceIndex,
    argumentsValid: true,
  };
}

function fakeEvidence(value: JsonValue) {
  return {
    assertSnapshot() {},
    requireModelResponse() {
      throw new Error("unexpected model response lookup");
    },
    requirePayload() {
      return value;
    },
  };
}
