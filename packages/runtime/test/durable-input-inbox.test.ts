import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InputAcceptedFactV1 } from "@paw/protocol";
import {
  DurableInputInboxV1,
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  SessionCoordinatorV1,
  acquireFileSessionExecutionLeaseV1,
} from "../src/index.js";
import type { FileRunSessionV1 } from "../src/index.js";
import { openFencedTestSession } from "./support/fenced-file-session.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next durable input inbox", () => {
  test("accepts first, deduplicates an exact retry, and rejects identity drift", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    const request = {
      inputId: "input-1",
      delivery: "steer" as const,
      content: "inspect the latest failure",
      callerId: "desktop-user",
    };

    expect(await inbox.accept(request)).toEqual({
      status: "accepted",
      inputId: "input-1",
    });
    expect(await inbox.accept(request)).toEqual({
      status: "already_accepted",
      inputId: "input-1",
    });
    await expect(
      inbox.accept({ ...request, content: "different instruction" }),
    ).rejects.toThrow("idempotency conflict");
    expect((await session.readInputSnapshot()).entries).toHaveLength(1);
    session.close();
  });

  test("keeps same-id concurrent admission strictly idempotent", async () => {
    const sameRoot = tempRoot();
    const sameSession = openSession(sameRoot);
    const sameInbox = new DurableInputInboxV1(sameSession);
    const sameRequest = input("same-id", "steer");
    const sameResults = await Promise.all([
      sameInbox.accept(sameRequest),
      sameInbox.accept(sameRequest),
    ]);
    expect(sameResults.map((result) => result.status).sort()).toEqual([
      "accepted",
      "already_accepted",
    ]);
    expect((await sameInbox.inspect()).acceptedCount).toBe(1);
    sameSession.close();

    const conflictRoot = tempRoot();
    const conflictSession = openSession(conflictRoot);
    const conflictInbox = new DurableInputInboxV1(conflictSession);
    const conflictResults = await Promise.allSettled([
      conflictInbox.accept(input("conflict-id", "queue")),
      conflictInbox.accept({
        ...input("conflict-id", "queue"),
        content: "different immutable body",
      }),
    ]);
    expect(
      conflictResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      conflictResults.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect((await conflictInbox.inspect()).acceptedCount).toBe(1);
    conflictSession.close();
  });

  test("recovers pending and promoted state only from the canonical journal", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    await inbox.accept(input("steer-1", "steer"));
    await inbox.accept(input("queue-1", "queue"));
    await inbox.reportSafeBoundary("before_first_model_request");
    expect(await inbox.consumePromotedInputIds()).toEqual(["steer-1"]);
    session.close();

    const resumed = openSession(root);
    const recovered = new DurableInputInboxV1(resumed);
    expect(await recovered.inspect()).toEqual({
      acceptedCount: 2,
      promotedCount: 1,
      pendingSteerIds: [],
      pendingQueueIds: ["queue-1"],
    });
    expect(await recovered.accept(input("steer-1", "steer"))).toEqual({
      status: "already_accepted",
      inputId: "steer-1",
    });
    resumed.close();
  });

  test("promotes all steers at a safe boundary but queues one FIFO item only when idle", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    await inbox.accept(input("queue-1", "queue"));
    await inbox.accept(input("steer-1", "steer"));
    await inbox.accept(input("queue-2", "queue"));
    await inbox.accept(input("steer-2", "steer"));

    await inbox.reportSafeBoundary("before_first_model_request");
    expect(await inbox.consumePromotedInputIds()).toEqual([
      "steer-1",
      "steer-2",
    ]);
    await appendCompletedModel(session, 1);
    await inbox.reportSafeBoundary("after_model_turn_without_tool_calls");
    expect(await inbox.consumePromotedInputIds()).toEqual([]);
    await inbox.prepareIdleExecution();
    await inbox.reportSafeBoundary("before_first_model_request");
    expect(await inbox.consumePromotedInputIds()).toEqual(["queue-1"]);
    await appendCompletedModel(session, 2);
    await inbox.prepareIdleExecution();
    await inbox.reportSafeBoundary("before_first_model_request");
    expect(await inbox.consumePromotedInputIds()).toEqual(["queue-2"]);
    expect((await inbox.inspect()).pendingQueueIds).toEqual([]);
    session.close();
  });

  test("reconstructs an unconsumed delivery after a crash before model dispatch", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    await inbox.accept(input("steer-1", "steer"));
    await inbox.reportSafeBoundary("before_first_model_request");
    session.close();

    const resumed = openSession(root);
    const recovered = new DurableInputInboxV1(resumed);
    expect(await recovered.consumePromotedInputIds()).toEqual(["steer-1"]);
    expect((await recovered.inspect()).pendingSteerIds).toEqual([]);
    resumed.close();
  });

  test("does not promote the next queue item when an idle promotion crashes", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    await inbox.accept(input("queue-1", "queue"));
    await inbox.accept(input("queue-2", "queue"));
    expect(await inbox.prepareIdleExecution()).toEqual(["queue-1"]);
    session.close();

    const resumed = openSession(root);
    const recovered = new DurableInputInboxV1(resumed);
    expect(await recovered.prepareIdleExecution()).toEqual(["queue-1"]);
    await recovered.reportSafeBoundary("before_first_model_request");
    expect(await recovered.consumePromotedInputIds()).toEqual(["queue-1"]);
    expect((await recovered.inspect()).pendingQueueIds).toEqual(["queue-2"]);
    resumed.close();
  });

  test("fails closed on reversed or multi-item queue promotion history", async () => {
    const reversedRoot = tempRoot();
    const reversedSession = openSession(reversedRoot);
    const reversed = new DurableInputInboxV1(reversedSession);
    await reversed.accept(input("queue-1", "queue"));
    await reversed.accept(input("queue-2", "queue"));
    const accepted = (await reversedSession.readInputSnapshot()).entries.map(
      (entry) => entry.fact,
    );
    const queueOne = accepted.find(
      (fact) => fact.type === "input.accepted" && fact.inputId === "queue-1",
    );
    const queueTwo = accepted.find(
      (fact) => fact.type === "input.accepted" && fact.inputId === "queue-2",
    );
    if (
      queueOne?.type !== "input.accepted" ||
      queueTwo?.type !== "input.accepted"
    ) {
      throw new Error("queue fixture is incomplete");
    }
    await reversedSession.appendInputFacts([
      promotedFromAccepted(queueTwo),
      promotedFromAccepted(queueOne),
    ]);
    await expect(reversed.inspect()).rejects.toThrow("not FIFO");
    reversedSession.close();

    const multiRoot = tempRoot();
    const multiSession = openSession(multiRoot);
    const multi = new DurableInputInboxV1(multiSession);
    await multi.accept(input("queue-1", "queue"));
    await multi.accept(input("queue-2", "queue"));
    const multiAccepted = (await multiSession.readInputSnapshot()).entries
      .map((entry) => entry.fact)
      .filter((fact) => fact.type === "input.accepted");
    await multiSession.appendInputFacts(
      multiAccepted.map(promotedFromAccepted),
    );
    await expect(multi.inspect()).rejects.toThrow("more than one queue item");
    multiSession.close();
  });

  test("refuses to promote inside an unfinished model or tool transaction", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    await inbox.accept(input("steer-1", "steer"));
    await session.appendInputFacts([
      {
        type: "model.dispatch_recorded",
        modelCallId: "model-1",
        turn: 1,
        requestHash: "request-1",
      },
    ]);
    await expect(
      inbox.reportSafeBoundary("after_model_turn_without_tool_calls"),
    ).rejects.toThrow("unfinished model or tool work");
    session.close();
  });

  test("refuses to promote after only part of a native tool batch settled", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    await inbox.accept(input("steer-1", "steer"));
    await session.appendInputFacts([
      {
        type: "model.dispatch_recorded",
        modelCallId: "model-tools",
        turn: 1,
        requestHash: "request-tools",
      },
      {
        type: "model.settled",
        modelCallId: "model-tools",
        turn: 1,
        status: "completed",
        hasToolCalls: true,
        hasVisibleOutput: false,
        response: {
          kind: "inline",
          hash: "response-tools",
          value: {
            schemaVersion: "paw.model-response.v1",
            providerProtocol: "openai-compatible",
            assistantContent: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                callId: "call-1",
                name: "workspace_read_file",
                rawArguments: '{"path":"a.ts"}',
                args: { path: "a.ts" },
                sourceIndex: 0,
                argumentsValid: true,
              },
            ],
          },
        },
      },
      {
        type: "tool.call_observed",
        callId: "call-1",
        modelCallId: "model-tools",
        turn: 1,
        tool: "workspace_read_file",
        args: { path: "a.ts" },
        order: 0,
      },
      {
        type: "tool.dispatch_recorded",
        callId: "call-1",
        turn: 1,
        sourceIndex: 0,
        batchId: "batch-1",
        mode: "serial",
      },
    ]);

    await expect(
      inbox.reportSafeBoundary("after_tool_batch_settled"),
    ).rejects.toThrow("unfinished model or tool work");
    session.close();
  });

  test("rejects persisted promotion interleaved before late tool facts", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    await inbox.accept(input("steer-1", "steer"));
    const accepted = (await session.readInputSnapshot()).entries[0]?.fact;
    if (accepted?.type !== "input.accepted") {
      throw new Error("steer fixture is incomplete");
    }
    await session.appendInputFacts([
      {
        type: "model.dispatch_recorded",
        modelCallId: "model-late-tools",
        turn: 1,
        requestHash: "request-late-tools",
      },
      {
        type: "model.settled",
        modelCallId: "model-late-tools",
        turn: 1,
        status: "completed",
        hasToolCalls: true,
        hasVisibleOutput: false,
        response: {
          kind: "inline",
          hash: "response-late-tools",
          value: {
            schemaVersion: "paw.model-response.v1",
            providerProtocol: "openai-compatible",
            assistantContent: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                callId: "call-late",
                name: "workspace_read_file",
                rawArguments: '{"path":"late.ts"}',
                args: { path: "late.ts" },
                sourceIndex: 0,
                argumentsValid: true,
              },
            ],
          },
        },
      },
      promotedFromAccepted(accepted),
      {
        type: "tool.call_observed",
        callId: "call-late",
        modelCallId: "model-late-tools",
        turn: 1,
        tool: "workspace_read_file",
        args: { path: "late.ts" },
        order: 0,
      },
      {
        type: "tool.settled",
        callId: "call-late",
        status: "cancelled",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          summary: "cancelled",
          isError: true,
        },
      },
    ]);

    await expect(inbox.inspect()).rejects.toThrow("inside tool batch");
    session.close();
  });
});

describe("Paw Next in-process session coordinator", () => {
  test("waits without polling and resumes when an external fact wakes it", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    let executions = 0;
    const coordinator = new SessionCoordinatorV1({
      sessionKey: "external-wake-session",
      inbox,
      execute: async () => {
        executions += 1;
        return { awaitExternal: executions === 1 };
      },
      shouldAwaitExternal: (result) => result.awaitExternal,
    });

    const running = coordinator.wake();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executions).toBe(1);
    void coordinator.wakeExternal();
    await running;
    expect(executions).toBe(2);

    await coordinator.close();
    session.close();
  });

  test("coalesces concurrent wakeups, runs one executor, and drains queued inputs FIFO", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    await inbox.accept(input("queue-1", "queue"));
    await inbox.accept(input("queue-2", "queue"));
    const deliveries: string[][] = [];
    let active = 0;
    let maximumActive = 0;
    let executions = 0;
    const coordinator = new SessionCoordinatorV1({
      sessionKey: "session-1",
      inbox,
      execute: async () => {
        executions += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await inbox.reportSafeBoundary("before_first_model_request");
        deliveries.push([...(await inbox.consumePromotedInputIds())]);
        await appendCompletedModel(session, executions);
        active -= 1;
      },
    });

    const first = coordinator.wake();
    const second = coordinator.wake();
    const third = coordinator.wake();
    await Promise.all([first, second, third]);

    expect(maximumActive).toBe(1);
    expect(executions).toBe(2);
    expect(deliveries).toEqual([["queue-1"], ["queue-2"]]);
    await coordinator.close();
    session.close();
  });

  test("rejects two live coordinators for the same session key", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    const first = new SessionCoordinatorV1({
      sessionKey: "same-session",
      inbox,
      execute: async () => undefined,
    });
    expect(
      () =>
        new SessionCoordinatorV1({
          sessionKey: "same-session",
          inbox,
          execute: async () => undefined,
        }),
    ).toThrow("already has an in-process coordinator");
    await first.close();
    session.close();
  });

  test("binds ownership to the actual Session even when callers use different keys", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const firstInbox = new DurableInputInboxV1(session);
    const secondInbox = new DurableInputInboxV1(session);
    const first = new SessionCoordinatorV1({
      sessionKey: "misleading-key-a",
      inbox: firstInbox,
      execute: async () => undefined,
    });
    expect(
      () =>
        new SessionCoordinatorV1({
          sessionKey: "misleading-key-b",
          inbox: secondInbox,
          execute: async () => undefined,
        }),
    ).toThrow("already has an in-process coordinator");
    await first.close();
    session.close();
  });

  test("prevents two runs in one canonical session from executing concurrently", async () => {
    const root = tempRoot();
    const runOne = openSession(root);
    const second = acquireFileSessionExecutionLeaseV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-2",
      ownerId: "run-two-owner",
      ttlMs: 1_000,
      baseTailSeq: 0,
      basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
      clock: () => 42,
    });
    expect(second.status).toBe("busy");
    runOne.close();
  });

  test("coalesces duplicate wakeups without starting a redundant empty run", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    let executions = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new SessionCoordinatorV1({
      sessionKey: "empty-session",
      inbox,
      execute: async () => {
        executions += 1;
        await gate;
      },
    });

    const first = coordinator.wake();
    const duplicate = coordinator.wake();
    release?.();
    await Promise.all([first, duplicate]);

    expect(executions).toBe(1);
    await coordinator.close();
    session.close();
  });

  test("an executor failure leaves its promoted queue item recoverable", async () => {
    const root = tempRoot();
    const session = openSession(root);
    const inbox = new DurableInputInboxV1(session);
    await inbox.accept(input("queue-1", "queue"));
    let fail = true;
    const deliveries: string[][] = [];
    const coordinator = new SessionCoordinatorV1({
      sessionKey: "recoverable-session",
      inbox,
      execute: async () => {
        if (fail) throw new Error("simulated executor crash");
        await inbox.reportSafeBoundary("before_first_model_request");
        deliveries.push([...(await inbox.consumePromotedInputIds())]);
        await appendCompletedModel(session, 1);
      },
    });

    await expect(coordinator.wake()).rejects.toThrow(
      "simulated executor crash",
    );
    fail = false;
    await coordinator.wake();
    expect(deliveries).toEqual([["queue-1"]]);
    expect((await inbox.inspect()).pendingQueueIds).toEqual([]);
    await coordinator.close();
    session.close();
  });
});

function input(inputId: string, delivery: "steer" | "queue") {
  return {
    inputId,
    delivery,
    content: `content for ${inputId}`,
    callerId: "test-caller",
  };
}

function promotedFromAccepted(accepted: InputAcceptedFactV1) {
  return {
    type: "input.promoted" as const,
    inputId: accepted.inputId,
    delivery: accepted.delivery,
    content: accepted.content,
    contentHash: accepted.contentHash,
    ...(accepted.attachments === undefined
      ? {}
      : { attachments: accepted.attachments }),
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-next-inbox-"));
  roots.push(root);
  return root;
}

function openSession(root: string): FileRunSessionV1 {
  return openFencedTestSession(root);
}

async function appendCompletedModel(
  session: FileRunSessionV1,
  turn: number,
): Promise<void> {
  const modelCallId = `model-${turn}`;
  await session.appendInputFacts([
    {
      type: "model.dispatch_recorded",
      modelCallId,
      turn,
      requestHash: `request-${turn}`,
    },
    {
      type: "model.settled",
      modelCallId,
      turn,
      status: "completed",
      hasToolCalls: false,
      hasVisibleOutput: true,
      response: {
        kind: "inline",
        hash: `response-${turn}`,
        value: {
          schemaVersion: "paw.model-response.v1",
          providerProtocol: "openai-compatible",
          assistantContent: `answer ${turn}`,
          finishReason: "stop",
          toolCalls: [],
        },
      },
    },
  ]);
}
