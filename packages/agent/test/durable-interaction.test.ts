import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileSystemAppStateStore,
  type RunEventEnvelope,
  isAppStateFinished,
} from "@paw/core";

import {
  appendUserReplyV1,
  createWaitingUserInteractionV1,
  prepareInteractionResumeV1,
} from "../src/durable-interaction.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

describe("durable waiting-user interaction", () => {
  test("reply preparation is idempotent across a crash after consumption", () => {
    const waiting = createWaitingUserInteractionV1({
      runId: "run-1",
      turn: 2,
      question: "Which color?",
      context: { choices: ["blue", "green"] },
      timeoutSec: null,
      now: 10,
    });
    const base = {
      runId: "run-1",
      goal: "choose",
      workspaceRoot: "C:\\workspace",
      turn: 3,
      maxSteps: 8,
      messages: [{ role: "assistant" as const, content: "Which color?" }],
      memoryTaskId: "memory-task-1",
      interaction: waiting,
      savedAt: 10,
    };
    const submitted = appendUserReplyV1(base, {
      requestId: waiting.requestId,
      reply: "blue",
      now: 20,
    });
    const first = prepareInteractionResumeV1(submitted, 30);
    if (first.kind !== "ready") throw new Error("Expected ready interaction");
    const second = prepareInteractionResumeV1(first.state, 40);
    if (second.kind !== "ready") throw new Error("Expected ready interaction");

    const marker = `[User reply request_id=${waiting.requestId}`;
    expect(
      second.state.messages.filter((message) =>
        message.content.startsWith(marker),
      ),
    ).toHaveLength(1);
    expect(second.state.interaction).toMatchObject({
      status: "consumed",
    });
    expect(second.state.memoryTaskId).toBe("memory-task-1");
    expect(() =>
      prepareInteractionResumeV1({
        ...submitted,
        interaction: { ...waiting, requestId: 7 } as never,
      }),
    ).toThrow(/Invalid waiting-user interaction/);
  });

  test("persists question, appends one reply, and resumes without replaying tools", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-waiting-"));
    const pawDir = path.join(workspaceRoot, ".paw");
    mkdirSync(pawDir);
    writeFileSync(
      path.join(pawDir, "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    writeFileSync(path.join(workspaceRoot, "source.txt"), "evidence\n", "utf8");
    const stateStore = new FileSystemAppStateStore({
      statesDir: path.join(pawDir, "states"),
    });
    const firstEvents: RunEventEnvelope[] = [];
    let firstModelCalls = 0;
    const first = new AgentOrchestrator({
      appStateStore: stateStore,
      memoryExtraction: "off",
      memoryLlm: "off",
      model: {
        label: "waiting-first",
        async complete() {
          firstModelCalls += 1;
          if (firstModelCalls === 1) {
            return {
              text: '{"tool":"workspace.read_file","args":{"path":"source.txt"}}',
            };
          }
          return {
            text: '{"action":"ask_user","question":"Which color?","context":{"choices":["blue","green"]},"timeout_sec":null}',
          };
        },
      },
      onEvent: (event) => firstEvents.push(event),
    });

    const paused = await first.run({
      runId: "durable-wait",
      goal: "Read source.txt, ask for a color, then report it.",
      workspaceRoot,
      maxSteps: 6,
    });
    expect(paused).toMatchObject({
      status: "incomplete",
      completionReason: "user_input_required",
    });
    expect(
      firstEvents.filter((event) => event.event.type === "tool.call"),
    ).toHaveLength(1);
    expect(firstEvents.some((event) => event.event.type === "run.paused")).toBe(
      true,
    );
    expect(
      firstEvents.some((event) => event.event.type === "run.completed"),
    ).toBe(false);
    expect(
      firstEvents.filter((event) => event.event.type === "run.metrics"),
    ).toHaveLength(1);

    const savedWaiting = stateStore.load("durable-wait");
    expect(savedWaiting?.outcome).toBeUndefined();
    expect(savedWaiting && isAppStateFinished(savedWaiting)).toBe(false);
    expect(savedWaiting?.interaction).toMatchObject({
      status: "waiting_user",
      question: "Which color?",
      requestedTurn: 1,
    });
    const requestId = savedWaiting?.interaction?.requestId;
    if (!requestId) throw new Error("Missing durable request id");

    let resumedModelCalls = 0;
    const resumedEvents: RunEventEnvelope[] = [];
    const resumed = new AgentOrchestrator({
      appStateStore: stateStore,
      memoryExtraction: "off",
      memoryLlm: "off",
      model: {
        label: "waiting-resumed",
        async complete(messages) {
          resumedModelCalls += 1;
          expect(
            messages.filter((message) =>
              message.content.startsWith(`[User reply request_id=${requestId}`),
            ),
          ).toHaveLength(1);
          expect(
            messages.filter((message) =>
              message.content.includes("Which color?"),
            ),
          ).toHaveLength(1);
          return {
            text: '{"action":"final_answer","summary":"The selected color is blue."}',
          };
        },
      },
      onEvent: (event) => resumedEvents.push(event),
    });

    const stillWaiting = await resumed.resumeRun({ runId: "durable-wait" });
    expect(stillWaiting).toMatchObject({
      status: "incomplete",
      completionReason: "user_input_required",
    });
    expect(resumedModelCalls).toBe(0);

    await expect(
      resumed.submitUserReply({
        runId: "durable-wait",
        requestId: "wrong",
        reply: "blue",
      }),
    ).rejects.toThrow(/requestId/);
    const submitted = await resumed.submitUserReply({
      runId: "durable-wait",
      requestId,
      reply: "blue",
    });
    expect(submitted.appended).toBe(true);
    const duplicate = await resumed.submitUserReply({
      runId: "durable-wait",
      requestId,
      reply: "blue",
    });
    expect(duplicate).toEqual({
      replyId: submitted.replyId,
      appended: false,
    });
    await expect(
      resumed.submitUserReply({
        runId: "durable-wait",
        requestId,
        reply: "green",
      }),
    ).rejects.toThrow(/different reply/);

    const completed = await resumed.resumeRun({ runId: "durable-wait" });
    expect(completed).toMatchObject({
      status: "completed",
      message: "The selected color is blue.",
    });
    expect(resumedModelCalls).toBe(1);
    expect(
      resumedEvents.filter((event) => event.event.type === "tool.call"),
    ).toHaveLength(0);
    const finalState = stateStore.load("durable-wait");
    expect(finalState?.interaction).toMatchObject({
      status: "consumed",
      consumedReplyId: submitted.replyId,
    });
    expect(finalState?.interactionInbox).toHaveLength(1);
  });

  test("persists before an inline resolver waits and consumes before continuing", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-inline-wait-"));
    const pawDir = path.join(workspaceRoot, ".paw");
    mkdirSync(pawDir);
    writeFileSync(
      path.join(pawDir, "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const stateStore = new FileSystemAppStateStore({
      statesDir: path.join(pawDir, "states"),
    });
    let calls = 0;
    let observedWaiting = false;
    const orchestrator = new AgentOrchestrator({
      appStateStore: stateStore,
      memoryExtraction: "off",
      memoryLlm: "off",
      resolveAskUser: async () => {
        observedWaiting =
          stateStore.load("inline-wait")?.interaction?.status ===
          "waiting_user";
        return "blue";
      },
      model: {
        label: "inline-wait",
        async complete() {
          calls += 1;
          return calls === 1
            ? {
                text: '{"action":"ask_user","question":"Color?","context":{},"timeoutSec":null}',
              }
            : {
                text: '{"action":"final_answer","summary":"Blue selected."}',
              };
        },
      },
    });

    const result = await orchestrator.run({
      runId: "inline-wait",
      goal: "Ask for a color.",
      workspaceRoot,
      maxSteps: 4,
    });
    expect(result.status).toBe("completed");
    expect(observedWaiting).toBe(true);
    const state = stateStore.load("inline-wait");
    expect(state?.interaction).toMatchObject({ status: "consumed" });
    expect(state?.interactionInbox).toHaveLength(1);
  });
});
