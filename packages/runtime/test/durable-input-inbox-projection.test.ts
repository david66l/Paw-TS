import { describe, expect, test } from "bun:test";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { InputFactV1 } from "@paw/protocol";

import {
  DurableInputInboxV1,
  projectDurableInputInboxStateV1,
} from "../src/index.js";

describe("pure durable Inbox projection", () => {
  test("projects interleaved initial, steer, and FIFO queue history without I/O", async () => {
    const snapshot = toSnapshot([
      promoted("initial", "initial"),
      accepted("queue-1", "queue"),
      accepted("steer-1", "steer"),
      accepted("queue-2", "queue"),
      accepted("steer-pending", "steer"),
      accepted("queue-pending", "queue"),
      promoted("steer-1", "steer"),
      promoted("queue-1", "queue"),
      modelDispatch(),
      modelSettledWithoutTools(),
      promoted("queue-2", "queue"),
    ]);
    const before = JSON.stringify(snapshot);

    const state = projectDurableInputInboxStateV1(snapshot);

    expect(state).toEqual({
      acceptedCount: 5,
      promotedCount: 4,
      pendingSteerIds: ["steer-pending"],
      pendingQueueIds: ["queue-pending"],
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.pendingSteerIds)).toBe(true);
    expect(Object.isFrozen(state.pendingQueueIds)).toBe(true);
    expect(() =>
      (state.pendingQueueIds as string[]).push("hostile-mutation"),
    ).toThrow();
    expect(JSON.stringify(snapshot)).toBe(before);

    let reads = 0;
    const inbox = new DurableInputInboxV1({
      async readInputSnapshot() {
        reads += 1;
        return snapshot;
      },
    } as never);
    await expect(inbox.inspect()).resolves.toEqual(state);
    expect(reads).toBe(1);
  });

  test("preserves duplicate, FIFO, active-model, and partial-tool-batch rejection", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly facts: readonly InputFactV1[];
      readonly expected: RegExp;
    }> = [
      {
        name: "duplicate accepted",
        facts: [accepted("same", "steer"), accepted("same", "steer")],
        expected: /duplicate inbox input/i,
      },
      {
        name: "queue out of order",
        facts: [
          accepted("queue-1", "queue"),
          accepted("queue-2", "queue"),
          promoted("queue-2", "queue"),
        ],
        expected: /FIFO/i,
      },
      {
        name: "two queue promotions before dispatch",
        facts: [
          accepted("queue-1", "queue"),
          accepted("queue-2", "queue"),
          promoted("queue-1", "queue"),
          promoted("queue-2", "queue"),
        ],
        expected: /more than one queue item/i,
      },
      {
        name: "promotion inside active model",
        facts: [
          accepted("steer-1", "steer"),
          modelDispatch(),
          promoted("steer-1", "steer"),
        ],
        expected: /active model call/i,
      },
      {
        name: "promotion inside partial tool batch",
        facts: [
          accepted("steer-1", "steer"),
          modelDispatch(),
          modelSettledWithTools(),
          toolObserved(),
          promoted("steer-1", "steer"),
          toolSettled(),
        ],
        expected: /inside tool batch/i,
      },
    ];

    for (const item of cases) {
      expect(
        () => projectDurableInputInboxStateV1(toSnapshot(item.facts)),
        item.name,
      ).toThrow(item.expected);
    }
  });
});

function toSnapshot(
  facts: readonly InputFactV1[],
): SessionInputSnapshot<InputFactV1> {
  return {
    entries: facts.map((fact, index) => ({ seq: index + 1, fact })),
    tailSeq: facts.length,
    latestInputSeq: facts.length,
  };
}

function accepted(inputId: string, delivery: "steer" | "queue"): InputFactV1 {
  return {
    type: "input.accepted",
    inputId,
    delivery,
    content: `content:${inputId}`,
    contentHash: `hash:${inputId}`,
    callerId: "test-caller",
  };
}

function promoted(
  inputId: string,
  delivery: "initial" | "steer" | "queue",
): InputFactV1 {
  return {
    type: "input.promoted",
    inputId,
    delivery,
    content: `content:${inputId}`,
    contentHash: `hash:${inputId}`,
  };
}

function modelDispatch(): InputFactV1 {
  return {
    type: "model.dispatch_recorded",
    modelCallId: "model-1",
    turn: 1,
    requestHash: "request-hash",
  };
}

function modelSettledWithoutTools(): InputFactV1 {
  return {
    type: "model.settled",
    modelCallId: "model-1",
    turn: 1,
    status: "completed",
    hasToolCalls: false,
    hasVisibleOutput: true,
    response: {
      kind: "inline",
      value: {
        schemaVersion: "paw.model-response.v1",
        providerProtocol: "openai-compatible",
        assistantContent: "done",
        toolCalls: [],
      },
      hash: "model-response-hash",
    },
  };
}

function modelSettledWithTools(): InputFactV1 {
  return {
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
        toolCalls: [
          {
            callId: "tool-1",
            name: "workspace_read_file",
            rawArguments: '{"path":"a.txt"}',
            args: { path: "a.txt" },
            sourceIndex: 0,
            argumentsValid: true,
          },
        ],
      },
      hash: "model-response-hash",
    },
  };
}

function toolObserved(): InputFactV1 {
  return {
    type: "tool.call_observed",
    callId: "tool-1",
    modelCallId: "model-1",
    turn: 1,
    tool: "workspace_read_file",
    args: { path: "a.txt" },
    order: 0,
  };
}

function toolSettled(): InputFactV1 {
  return {
    type: "tool.settled",
    callId: "tool-1",
    status: "completed",
  };
}
