import { describe, expect, test } from "bun:test";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import {
  type InputFactV1,
  type JsonValue,
  MODEL_RESPONSE_SCHEMA_VERSION_V1,
  WORK_SEGMENT_POLICY_VERSION_V1,
} from "@paw/protocol";

import {
  DurableInputInboxV1,
  assertTaskCheckpointStableBoundaryV1,
  createJournalContextV1,
  projectCheckpointSequenceHighWaterV1,
  projectDurableInputInboxStateV1,
  projectLatestAssistantTextV1,
  projectLatestWorkSegmentBoundaryV1,
} from "../src/index.js";

const signal = new AbortController().signal;

describe("work segment Runtime consumers", () => {
  test("projects one frozen current boundary without hiding full-run Inbox backlog", () => {
    const snapshot = snapshotOf([
      promoted("initial", "initial"),
      accepted("old-steer", "steer"),
      accepted("segment-root", "queue"),
      marker(1, "segment-root"),
      promoted("segment-root", "queue"),
      accepted("new-steer", "steer"),
      accepted("new-queue", "queue"),
    ]);

    const boundary = projectLatestWorkSegmentBoundaryV1(snapshot);
    expect(boundary).toEqual({
      segmentIndex: 1,
      markerSeq: 4,
      rootPromotionSeq: 5,
      inputId: "segment-root",
    });
    expect(Object.isFrozen(boundary)).toBeTrue();
    expect(projectDurableInputInboxStateV1(snapshot)).toMatchObject({
      pendingSteerIds: ["old-steer", "new-steer"],
      pendingQueueIds: ["new-queue"],
    });
  });

  test("safe-boundary promotion drains pre- and post-marker steers in accepted order", async () => {
    const session = new InboxMemorySession([
      promoted("initial", "initial"),
      accepted("old-steer", "steer"),
      accepted("segment-root", "queue"),
      marker(1, "segment-root"),
      promoted("segment-root", "queue"),
      accepted("new-steer", "steer"),
      accepted("new-queue", "queue"),
    ]);
    const inbox = new DurableInputInboxV1(session as never);

    await inbox.reportSafeBoundary("before_first_model_request");

    expect(session.committedBatches).toHaveLength(1);
    expect(
      session.committedBatches[0]?.flatMap((fact) =>
        fact.type === "input.promoted" ? [fact.inputId] : [],
      ),
    ).toEqual(["old-steer", "new-steer"]);
    expect((await inbox.inspect()).pendingSteerIds).toEqual([]);
    expect((await inbox.inspect()).pendingQueueIds).toEqual(["new-queue"]);
    expect(await inbox.prepareIdleExecution()).toEqual([]);
    expect(session.committedBatches).toHaveLength(1);
  });

  test("requires the safe-boundary name to match the current segment frontier", async () => {
    const session = new InboxMemorySession([
      promoted("initial", "initial"),
      ...plainModel(1, "old assistant"),
      accepted("segment-root", "queue"),
      marker(1, "segment-root"),
      promoted("segment-root", "queue"),
      ...plainModel(2, "new assistant"),
      accepted("new-steer", "steer"),
    ]);
    const inbox = new DurableInputInboxV1(session as never);

    await expect(
      inbox.reportSafeBoundary("before_first_model_request"),
    ).rejects.toThrow(/current-segment model turn/i);
    expect(session.committedBatches).toHaveLength(0);

    await inbox.reportSafeBoundary("after_model_turn_without_tool_calls");
    expect(
      session.committedBatches[0]?.flatMap((fact) =>
        fact.type === "input.promoted" ? [fact.inputId] : [],
      ),
    ).toEqual(["new-steer"]);
  });

  test("does not fall back to an old assistant when a new segment has no model", () => {
    const snapshot = snapshotOf([
      promoted("initial", "initial"),
      ...plainModel(1, "old assistant"),
      accepted("segment-root", "queue"),
      marker(1, "segment-root"),
      promoted("segment-root", "queue"),
    ]);

    expect(
      projectLatestAssistantTextV1({
        snapshot,
        providerProtocol: "openai-compatible",
      }),
    ).toBeUndefined();
  });

  test("keeps old dialogue, then the new root and assistant in chronological Context order", async () => {
    const snapshot = snapshotOf([
      promoted("initial", "initial"),
      ...plainModel(1, "old assistant"),
      accepted("hidden-backlog", "steer"),
      accepted("segment-root", "queue"),
      marker(1, "segment-root"),
      promoted("segment-root", "queue"),
      accepted("hidden-new-steer", "steer"),
      ...plainModel(2, "new assistant"),
    ]);
    const request = await context().build(snapshot, { signal });

    expect(request.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(request.messages.map((message) => message.content)).toEqual([
      "content:initial",
      "old assistant",
      "content:segment-root",
      "new assistant",
    ]);
    expect(JSON.stringify(request)).not.toContain("work.segment_started");
    expect(JSON.stringify(request)).not.toContain("hidden-backlog");
    expect(JSON.stringify(request)).not.toContain("hidden-new-steer");
  });

  test("projects steers accepted on both sides of the marker by promotion order", async () => {
    const snapshot = snapshotOf([
      promoted("initial", "initial"),
      ...plainModel(1, "old assistant"),
      accepted("old-steer", "steer"),
      accepted("segment-root", "queue"),
      marker(1, "segment-root"),
      promoted("segment-root", "queue"),
      accepted("new-steer", "steer"),
      promoted("old-steer", "steer"),
      promoted("new-steer", "steer"),
      ...plainModel(2, "new assistant"),
    ]);

    const request = await context().build(snapshot, { signal });
    expect(request.messages.map((message) => message.content)).toEqual([
      "content:initial",
      "old assistant",
      "content:segment-root",
      "content:old-steer",
      "content:new-steer",
      "new assistant",
    ]);
  });

  test("protects the new segment root when budget removes older dialogue", async () => {
    const snapshot = snapshotOf([
      promoted("initial", "initial"),
      ...plainModel(1, "x".repeat(200)),
      accepted("segment-root", "queue"),
      marker(1, "segment-root"),
      promoted("segment-root", "queue"),
    ]);

    const request = await context(45).build(snapshot, { signal });
    expect(request.messages.map((message) => message.content)).toEqual([
      "content:initial",
      "content:segment-root",
    ]);
  });

  test("retains exact artifact evidence gates for old dialogue across a segment", async () => {
    const oldResponse = response("old artifact assistant");
    const oldModel = plainModel(1, "old artifact assistant");
    const settlement = oldModel[1];
    if (settlement?.type !== "model.settled") {
      throw new Error("model fixture missing");
    }
    oldModel[1] = {
      ...settlement,
      response: {
        kind: "artifact_ref",
        artifactRef: "artifact:old-model",
        hash: hashJson(oldResponse),
      },
    };
    const snapshot = snapshotOf([
      promoted("initial", "initial"),
      ...oldModel,
      accepted("segment-root", "queue"),
      marker(1, "segment-root"),
      promoted("segment-root", "queue"),
      ...plainModel(2, "new assistant"),
    ]);

    await expect(context().build(snapshot, { signal })).rejects.toThrow(
      /artifact payload requires exact canonical evidence/i,
    );
  });

  test("checkpoint stable boundary must be in the current segment, while global high-water does not reset", () => {
    const beforeCurrentModel = snapshotOf([
      promoted("initial", "initial"),
      ...plainModel(1, "old assistant"),
      accepted("segment-root", "queue"),
      marker(1, "segment-root"),
      promoted("segment-root", "queue"),
    ]);
    expect(() =>
      assertTaskCheckpointStableBoundaryV1(
        beforeCurrentModel,
        "after_model_turn_without_tool_calls",
      ),
    ).toThrow(/current work segment/i);

    const afterCurrentModel = snapshotOf([
      ...beforeCurrentModel.entries.map((entry) => entry.fact),
      ...plainModel(2, "new assistant"),
    ]);
    expect(() =>
      assertTaskCheckpointStableBoundaryV1(
        afterCurrentModel,
        "after_model_turn_without_tool_calls",
      ),
    ).not.toThrow();

    expect(
      projectCheckpointSequenceHighWaterV1([
        checkpointAllocation("old-call", 3),
        marker(1, "segment-root"),
        checkpointAllocation("new-call", 8),
      ]),
    ).toBe(8);
  });
});

class InboxMemorySession {
  private facts: InputFactV1[];
  readonly committedBatches: InputFactV1[][] = [];

  constructor(facts: readonly InputFactV1[]) {
    this.facts = [...structuredClone(facts)];
  }

  async readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>> {
    return snapshotOf(this.facts);
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if (expectedTailSeq !== this.facts.length) return "conflict";
    this.committedBatches.push([...structuredClone(facts)]);
    this.facts.push(...structuredClone(facts));
    return "committed";
  }
}

function context(contextWindowTokens = 100_000) {
  return createJournalContextV1({
    payloads: {
      resolve(payload) {
        if (payload.kind === "inline") return Promise.resolve(payload.value);
        throw new Error("legacy artifact resolver must not be called");
      },
      hash: hashJson,
    },
    providerProtocol: "openai-compatible",
    budget: {
      contextWindowTokens,
      reservedOutputTokens: 1,
      estimationMarginTokens: 0,
      estimatorId: "segment-test",
      estimatorVersion: "v1",
      estimator: {
        count: (text) => text.length,
        countMessages: (messages) =>
          messages.reduce(
            (total, message) => total + (message.content?.length ?? 0),
            0,
          ),
      },
    },
  });
}

function snapshotOf(
  facts: readonly InputFactV1[],
): SessionInputSnapshot<InputFactV1> {
  return {
    entries: facts.map((fact, index) => ({ seq: index + 1, fact })),
    tailSeq: facts.length,
    latestInputSeq: facts.length,
  };
}

function accepted(
  inputId: string,
  delivery: "steer" | "queue",
): Extract<InputFactV1, { type: "input.accepted" }> {
  return {
    type: "input.accepted",
    inputId,
    delivery,
    content: `content:${inputId}`,
    contentHash: `hash:${inputId}`,
    callerId: "segment-consumer-test",
  };
}

function promoted(
  inputId: string,
  delivery: "initial" | "steer" | "queue",
): Extract<InputFactV1, { type: "input.promoted" }> {
  return {
    type: "input.promoted",
    inputId,
    delivery,
    content: `content:${inputId}`,
    contentHash: `hash:${inputId}`,
  };
}

function marker(
  segmentIndex: number,
  inputId: string,
): Extract<InputFactV1, { type: "work.segment_started" }> {
  return {
    type: "work.segment_started",
    segmentIndex,
    inputId,
    reducerVersion: "paw.interactive-control.v2",
    previousDecisionStateHash: `state:${segmentIndex}`,
    previousAction: {
      kind: "complete",
      reasonCode: "interactive-natural-stop",
    },
    policyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
  };
}

function plainModel(turn: number, assistantContent: string): InputFactV1[] {
  const modelResponse = response(assistantContent);
  return [
    {
      type: "model.dispatch_recorded",
      modelCallId: `model-${turn}`,
      turn,
      requestHash: `request-${turn}`,
    },
    {
      type: "model.settled",
      modelCallId: `model-${turn}`,
      turn,
      status: "completed",
      hasToolCalls: false,
      hasVisibleOutput: true,
      response: {
        kind: "inline",
        value: modelResponse,
        hash: hashJson(modelResponse),
      },
      finishReason: "stop",
    },
  ];
}

function response(assistantContent: string): JsonValue {
  return {
    schemaVersion: MODEL_RESPONSE_SCHEMA_VERSION_V1,
    providerProtocol: "openai-compatible",
    assistantContent,
    finishReason: "stop",
    toolCalls: [],
  };
}

function checkpointAllocation(
  callId: string,
  checkpointSeq: number,
): Extract<InputFactV1, { type: "tool.effect_checkpoint_allocated" }> {
  return {
    type: "tool.effect_checkpoint_allocated",
    callId,
    turn: checkpointSeq === 3 ? 1 : 2,
    sourceIndex: 0,
    checkpointSeq,
  };
}

function hashJson(value: JsonValue): string {
  return `hash:${JSON.stringify(value)}`;
}
