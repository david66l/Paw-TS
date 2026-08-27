import { describe, expect, test } from "bun:test";
import {
  type DerivedDecisionV1,
  type DurableJsonPayloadV1,
  type InputFactV1,
  type JsonValue,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
} from "@paw/protocol";
import { projectCanonicalDurableJsonPayloadBindingsV1 } from "@paw/runtime";

describe("canonical durable payload binding projection", () => {
  test("projects every carrier in stable journal order from real envelope seq values", () => {
    const prefix = completePrefix();
    const before = JSON.stringify(prefix);

    const occurrences = projectCanonicalDurableJsonPayloadBindingsV1(prefix);

    expect(
      occurrences.map(({ location, binding }) => ({ location, binding })),
    ).toEqual([
      {
        location: {
          kind: "input_attachment",
          carrierType: "input.accepted",
          carrierSeq: 3,
          attachmentIndex: 0,
          inputId: "input-steer",
          attachmentId: "attachment-a",
        },
        binding: {
          originSeq: 3,
          field: {
            kind: "input_attachment",
            inputId: "input-steer",
            attachmentId: "attachment-a",
          },
        },
      },
      {
        location: {
          kind: "input_attachment",
          carrierType: "input.accepted",
          carrierSeq: 3,
          attachmentIndex: 1,
          inputId: "input-steer",
          attachmentId: "attachment-b",
        },
        binding: {
          originSeq: 3,
          field: {
            kind: "input_attachment",
            inputId: "input-steer",
            attachmentId: "attachment-b",
          },
        },
      },
      {
        location: {
          kind: "input_attachment",
          carrierType: "input.promoted",
          carrierSeq: 5,
          attachmentIndex: 0,
          inputId: "input-steer",
          attachmentId: "attachment-a",
        },
        binding: {
          originSeq: 3,
          field: {
            kind: "input_attachment",
            inputId: "input-steer",
            attachmentId: "attachment-a",
          },
        },
      },
      {
        location: {
          kind: "input_attachment",
          carrierType: "input.promoted",
          carrierSeq: 5,
          attachmentIndex: 1,
          inputId: "input-steer",
          attachmentId: "attachment-b",
        },
        binding: {
          originSeq: 3,
          field: {
            kind: "input_attachment",
            inputId: "input-steer",
            attachmentId: "attachment-b",
          },
        },
      },
      {
        location: {
          kind: "input_attachment",
          carrierType: "input.promoted",
          carrierSeq: 6,
          attachmentIndex: 0,
          inputId: "input-initial",
          attachmentId: "attachment-initial",
        },
        binding: {
          originSeq: 6,
          field: {
            kind: "input_attachment",
            inputId: "input-initial",
            attachmentId: "attachment-initial",
          },
        },
      },
      {
        location: {
          kind: "model_response",
          carrierType: "model.settled",
          carrierSeq: 9,
          modelCallId: "model-1",
        },
        binding: {
          originSeq: 9,
          field: { kind: "model_response", modelCallId: "model-1" },
        },
      },
      {
        location: {
          kind: "tool_observation",
          carrierType: "tool.settled",
          carrierSeq: 13,
          callId: "call-1",
        },
        binding: {
          originSeq: 13,
          field: { kind: "tool_observation", callId: "call-1" },
        },
      },
      {
        location: {
          kind: "task_checkpoint",
          carrierType: "context.checkpoint_distillation_settled",
          carrierSeq: 16,
          claimId: "claim-1",
          checkpointId: "checkpoint-1",
        },
        binding: {
          originSeq: 16,
          field: {
            kind: "task_checkpoint",
            checkpointId: "checkpoint-1",
          },
        },
      },
      {
        location: {
          kind: "task_checkpoint",
          carrierType: "context.checkpoint_recorded",
          carrierSeq: 17,
          checkpointId: "checkpoint-1",
          distillationClaimId: "claim-1",
        },
        binding: {
          originSeq: 16,
          field: {
            kind: "task_checkpoint",
            checkpointId: "checkpoint-1",
          },
        },
      },
      {
        location: {
          kind: "task_checkpoint",
          carrierType: "context.checkpoint_recorded",
          carrierSeq: 18,
          checkpointId: "checkpoint-direct",
        },
        binding: {
          originSeq: 18,
          field: {
            kind: "task_checkpoint",
            checkpointId: "checkpoint-direct",
          },
        },
      },
    ]);
    expect(JSON.stringify(prefix)).toBe(before);
    expect(occurrences[2]?.payload).toEqual(occurrences[0]?.payload);
    expect(occurrences[8]?.payload).toEqual(occurrences[7]?.payload);
    assertRecursivelyFrozen(occurrences);
    const initialPayload = occurrences[4]?.payload;
    expect(initialPayload?.kind).toBe("inline");
    if (initialPayload?.kind !== "inline") {
      throw new Error("initial attachment fixture must be inline");
    }
    expect(initialPayload.value).toBe("initial attachment");
  });

  test("validates the strict Protocol prefix before projecting payload bindings", () => {
    const damaged = clonePrefix(completePrefix());
    const envelope = damaged[4];
    if (!envelope) throw new Error("damaged fixture envelope is missing");
    damaged[4] = { ...envelope, seq: envelope.seq + 1 };

    expect(() => projectCanonicalDurableJsonPayloadBindingsV1(damaged)).toThrow(
      "journal seq must be contiguous",
    );
  });

  test("accepts unresolved refs without performing artifact or filesystem I/O", () => {
    const prefix = completePrefix();
    const occurrences = projectCanonicalDurableJsonPayloadBindingsV1(prefix);

    expect(occurrences).toHaveLength(10);
    expect(
      occurrences.filter(({ payload }) => payload.kind === "artifact_ref"),
    ).toHaveLength(9);
  });

  test("rejects one artifact ref reused across attachments with different owners", () => {
    const prefix = completePrefix({ duplicateAcceptedAttachmentRef: true });

    expect(() => projectCanonicalDurableJsonPayloadBindingsV1(prefix)).toThrow(
      "reused across canonical bindings",
    );
  });

  test("rejects cross-input origin reuse even when the Protocol prefix is valid", () => {
    const prefix = completePrefix({ initialUsesAcceptedRef: true });

    expect(() => projectCanonicalDurableJsonPayloadBindingsV1(prefix)).toThrow(
      "reused across canonical bindings",
    );
  });

  test("rejects refs moved across attachment, model, tool, or checkpoint carriers", () => {
    for (const drift of [
      "attachment_to_model",
      "model_to_tool",
      "tool_to_checkpoint",
    ] as const) {
      expect(() =>
        projectCanonicalDurableJsonPayloadBindingsV1(
          completePrefix({ crossCarrierReuse: drift }),
        ),
      ).toThrow("reused across canonical bindings");
    }
  });

  test("rejects one checkpoint ref reused by a new direct checkpoint owner and origin", () => {
    const prefix = completePrefix({ directUsesDistilledRef: true });

    expect(() => projectCanonicalDurableJsonPayloadBindingsV1(prefix)).toThrow(
      "reused across canonical bindings",
    );
  });
});

interface CompletePrefixOptions {
  readonly duplicateAcceptedAttachmentRef?: boolean;
  readonly initialUsesAcceptedRef?: boolean;
  readonly crossCarrierReuse?:
    | "attachment_to_model"
    | "model_to_tool"
    | "tool_to_checkpoint";
  readonly directUsesDistilledRef?: boolean;
}

function completePrefix(
  options: CompletePrefixOptions = {},
): readonly RunJournalEnvelopeV1[] {
  const journal = new JournalFixture();
  const attachmentA = artifact("a");
  const attachmentB = options.duplicateAcceptedAttachmentRef
    ? attachmentA
    : artifact("b");
  const acceptedAttachments = [
    attachment("attachment-a", attachmentA),
    attachment("attachment-b", attachmentB),
  ] as const;
  const initialAttachment = options.initialUsesAcceptedRef
    ? attachmentA
    : inline("initial attachment");
  const modelPayload =
    options.crossCarrierReuse === "attachment_to_model"
      ? attachmentA
      : artifact("c");
  const toolPayload =
    options.crossCarrierReuse === "model_to_tool"
      ? modelPayload
      : artifact("d");
  const distilledPayload =
    options.crossCarrierReuse === "tool_to_checkpoint"
      ? toolPayload
      : artifact("e");
  const directPayload = options.directUsesDistilledRef
    ? distilledPayload
    : artifact("f");

  journal.fact({
    type: "attempt.started",
    goalHash: "goal-hash",
    configHash: "config-hash",
  });
  journal.decision();
  journal.fact({
    type: "input.accepted",
    inputId: "input-steer",
    delivery: "steer",
    content: "steer",
    contentHash: "steer-hash",
    callerId: "caller-1",
    attachments: acceptedAttachments,
  });
  journal.decision();
  journal.fact({
    type: "input.promoted",
    inputId: "input-steer",
    delivery: "steer",
    content: "steer",
    contentHash: "steer-hash",
    attachments: acceptedAttachments,
  });
  journal.fact({
    type: "input.promoted",
    inputId: "input-initial",
    delivery: "initial",
    content: "initial",
    contentHash: "initial-hash",
    attachments: [attachment("attachment-initial", initialAttachment)],
  });
  journal.fact({
    type: "model.dispatch_recorded",
    modelCallId: "model-1",
    turn: 1,
    requestHash: "request-hash",
  });
  journal.decision();
  journal.fact({
    type: "model.settled",
    modelCallId: "model-1",
    turn: 1,
    status: "completed",
    hasToolCalls: true,
    hasVisibleOutput: false,
    response: modelPayload,
  });
  journal.fact({
    type: "tool.call_observed",
    callId: "call-1",
    modelCallId: "model-1",
    turn: 1,
    tool: "workspace.read_file",
    args: { path: "README.md" },
    order: 0,
  });
  journal.fact({
    type: "tool.dispatch_recorded",
    callId: "call-1",
    turn: 1,
    sourceIndex: 0,
    batchId: "batch-1",
    mode: "parallel",
  });
  journal.fact({
    type: "tool.permission_resolved",
    turn: 1,
    sourceIndex: 0,
    callId: "call-1",
    tool: "workspace.read_file",
    policyVersion: "policy-v1",
    resolution: "allow_once",
    source: "base_policy",
  });
  const toolSettledSeq = journal.fact({
    type: "tool.settled",
    callId: "call-1",
    status: "completed",
    observation: {
      schemaVersion: "paw.tool-observation.v1",
      summary: "read",
      isError: false,
      payload: toolPayload,
    },
  });
  journal.fact({
    type: "context.checkpoint_distillation_claimed",
    claimId: "claim-1",
    checkpointId: "checkpoint-1",
    boundary: "after_tool_batch_settled",
    policyVersion: "checkpoint-policy-v1",
    sourceFromSeq: 1,
    sourceThroughSeq: toolSettledSeq,
    sourceInputHash: "source-hash-1",
  });
  journal.decision();
  journal.fact({
    type: "context.checkpoint_distillation_settled",
    claimId: "claim-1",
    status: "completed",
    checkpoint: distilledPayload,
  });
  journal.fact({
    type: "context.checkpoint_recorded",
    checkpointId: "checkpoint-1",
    distillationClaimId: "claim-1",
    policyVersion: "checkpoint-policy-v1",
    sourceFromSeq: 1,
    sourceThroughSeq: toolSettledSeq,
    sourceInputHash: "source-hash-1",
    checkpoint: distilledPayload,
  });
  journal.fact({
    type: "context.checkpoint_recorded",
    checkpointId: "checkpoint-direct",
    supersedesCheckpointId: "checkpoint-1",
    policyVersion: "checkpoint-policy-v1",
    sourceFromSeq: 1,
    sourceThroughSeq: 17,
    sourceInputHash: "source-hash-2",
    checkpoint: directPayload,
  });
  return journal.prefix;
}

class JournalFixture {
  readonly prefix: RunJournalEnvelopeV1[] = [];

  fact(fact: InputFactV1): number {
    const seq = this.prefix.length + 1;
    this.prefix.push(envelope(seq, { kind: "input_fact", fact }));
    return seq;
  }

  decision(): number {
    const previous = this.prefix.at(-1);
    if (!previous || previous.record.kind !== "input_fact") {
      throw new Error("decision fixture must follow an input fact");
    }
    const seq = this.prefix.length + 1;
    const decision: DerivedDecisionV1 = {
      type: "control.decided",
      reducerVersion: "fixture-reducer-v1",
      inputThroughSeq: previous.seq,
      stateHash: `state-${previous.seq}`,
      action: { kind: "continue", reasonCode: "fixture_continue" },
    };
    this.prefix.push(envelope(seq, { kind: "derived_decision", decision }));
    return seq;
  }
}

function envelope(
  seq: number,
  record: RunJournalEnvelopeV1["record"],
): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq,
    ts: seq,
    record,
  };
}

function artifact(marker: string): DurableJsonPayloadV1 {
  const digit = marker.charCodeAt(0).toString(16).at(-1) ?? "0";
  return {
    kind: "artifact_ref",
    artifactRef: `paw-payload:v1:${digit.repeat(64)}`,
    hash: digit.repeat(64),
  };
}

function inline(value: JsonValue): DurableJsonPayloadV1 {
  return { kind: "inline", value, hash: "inline-hash" };
}

function attachment(attachmentId: string, content: DurableJsonPayloadV1) {
  return {
    attachmentId,
    type: "file" as const,
    name: `${attachmentId}.txt`,
    content,
  };
}

function clonePrefix(
  prefix: readonly RunJournalEnvelopeV1[],
): RunJournalEnvelopeV1[] {
  return JSON.parse(JSON.stringify(prefix)) as RunJournalEnvelopeV1[];
}

function assertRecursivelyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBeTrue();
  for (const item of Object.values(value)) assertRecursivelyFrozen(item);
}
