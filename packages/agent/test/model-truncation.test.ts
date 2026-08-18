import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { RunEventEnvelope, SessionStore } from "@paw/core";
import { FakeLanguageModel } from "@paw/models";

import { AgentOrchestrator } from "../src/orchestrator.js";
import { tmpDir } from "./fixtures.js";

describe("Model Truncation", () => {
  test("truncated finishReason triggers continuation", async () => {
    const dir = tmpDir("paw-trunc-cont-");
    writeFileSync(path.join(dir, "a.txt"), "x");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        {
          finishReason: "length",
          text: '{"action":"final_answer","summary":"This got cut',
        },
        {
          text: ' off in the middle."}',
        },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    const r = await o.run({
      runId: "trunc-cont",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r.status).toBe("completed");
    expect(model.callCount).toBe(2);
  });

  test("continuation concatenates text correctly", async () => {
    const dir = tmpDir("paw-trunc-text-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        {
          finishReason: "length",
          text: '{"action":"final_answer","summary":"Part one',
        },
        {
          text: ' and part two."}',
        },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    await o.run({
      runId: "trunc-text",
      goal: "hello",
      workspaceRoot: dir,
      maxSteps: 2,
    });
    const done = events.find((e) => e.event.type === "model.done");
    expect(done?.event.type).toBe("model.done");
    if (done?.event.type === "model.done") {
      expect(done.event.text).toBe(
        '{"action":"final_answer","summary":"Part one and part two."}',
      );
    }
  });

  test("model.truncated event is emitted with finishReason", async () => {
    const dir = tmpDir("paw-trunc-ev-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        { finishReason: "max_tokens", text: "..." },
        { text: '{"action":"final_answer","summary":"Done."}' },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    await o.run({
      runId: "trunc-ev",
      goal: "hello",
      workspaceRoot: dir,
      maxSteps: 2,
    });
    const truncated = events.find((e) => e.event.type === "model.truncated");
    expect(truncated?.event.type).toBe("model.truncated");
    if (truncated?.event.type === "model.truncated") {
      expect(truncated.event.finishReason).toBe("max_tokens");
    }
  });

  test("usage is accumulated across continuation", async () => {
    const dir = tmpDir("paw-trunc-usage-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        {
          finishReason: "length",
          text: "...",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        },
        {
          text: "...",
          usage: {
            promptTokens: 12,
            completionTokens: 8,
            totalTokens: 20,
            cachedPromptTokens: 3,
          },
        },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    await o.run({
      runId: "trunc-usage",
      goal: "hello",
      workspaceRoot: dir,
      maxSteps: 2,
    });
    const done = events.find((e) => e.event.type === "model.done");
    expect(done?.event.type).toBe("model.done");
    if (done?.event.type === "model.done") {
      expect(done.event.usage).toMatchObject({
        promptTokens: 22,
        completionTokens: 13,
        totalTokens: 35,
        cachedPromptTokens: 3,
      });
    }
  });

  test("concatenated text can be parsed by parseAgentAction", async () => {
    const dir = tmpDir("paw-trunc-parse-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        {
          finishReason: "length",
          text: '{"action":"final_answer","summary":"Hello',
        },
        {
          text: ' world."}',
        },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    const r = await o.run({
      runId: "trunc-parse",
      goal: "hello",
      workspaceRoot: dir,
      maxSteps: 2,
    });
    expect(r.status).toBe("completed");
    const completed = events.find((e) => e.event.type === "run.completed");
    expect(completed?.event.type).toBe("run.completed");
    if (completed?.event.type === "run.completed") {
      expect(completed.event.status).toBe("completed");
    }
  });

  test("emits exactly one model.done after truncation", async () => {
    const dir = tmpDir("paw-trunc-once-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        { finishReason: "length", text: "a" },
        { text: '{"action":"final_answer","summary":"Done."}' },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    await o.run({
      runId: "trunc-once",
      goal: "hello",
      workspaceRoot: dir,
      maxSteps: 2,
    });
    const dones = events.filter((e) => e.event.type === "model.done");
    expect(dones.length).toBe(1);
  });

  test("a truncated native tool turn fails closed without executing", async () => {
    const dir = tmpDir("paw-trunc-native-");
    writeFileSync(path.join(dir, "a.txt"), "must not be read");
    const events: RunEventEnvelope[] = [];
    const saved: RunEventEnvelope[] = [];
    let modelCalls = 0;
    const model: import("@paw/models").LanguageModel = {
      label: "truncated-native-fixture",
      async complete() {
        modelCalls += 1;
        return {
          finishReason: "length",
          text: "",
          thinking: "partial native audit thinking",
          reasoningPassback: "partial provider state",
          toolCalls: [
            {
              id: "partial-call",
              name: "workspace_read_file",
              arguments: { path: "a.txt" },
              rawArguments: '{"path":"a.txt"}',
            },
          ],
        };
      },
    };
    const o = new AgentOrchestrator({
      model,
      onEvent: (event) => events.push(event),
      sessionStore: {
        saveEvent(_runId: string, envelope: RunEventEnvelope) {
          saved.push(envelope);
        },
      } as SessionStore,
      retrySleep: async () => {},
    });

    const result = await o.run({
      runId: "trunc-native",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 2,
    });

    expect(result.status).toBe("failed");
    expect(modelCalls).toBe(1);
    expect(events.some((event) => event.event.type === "tool.call")).toBe(
      false,
    );
    const durableDones = saved.filter(
      (envelope) => envelope.event.type === "model.done",
    );
    expect(durableDones).toHaveLength(1);
    expect(durableDones[0]?.event).toMatchObject({
      type: "model.done",
      thinking: "partial native audit thinking",
    });
  });

  test("truncated reasoning-only text still auto-continues", async () => {
    const dir = tmpDir("paw-trunc-reasoning-only-");
    let modelCalls = 0;
    const model: import("@paw/models").LanguageModel = {
      label: "truncated-reasoning-only-fixture",
      async complete() {
        modelCalls += 1;
        return modelCalls === 1
          ? {
              finishReason: "length",
              text: '{"action":"final_answer","summary":"long answer',
              reasoningPassback: "provider reasoning state",
            }
          : { text: ' continued"}' };
      },
    };
    const o = new AgentOrchestrator({
      model,
      retrySleep: async () => {},
    });

    const result = await o.run({
      runId: "trunc-reasoning-only",
      goal: "answer a long reasoning question",
      workspaceRoot: dir,
      maxSteps: 2,
    });

    expect(result.status).toBe("completed");
    expect(modelCalls).toBe(2);
  });

  test("text continuation cannot collapse a later native tool turn", async () => {
    const dir = tmpDir("paw-trunc-later-native-");
    writeFileSync(path.join(dir, "a.txt"), "must not be read");
    const events: RunEventEnvelope[] = [];
    const saved: RunEventEnvelope[] = [];
    let modelCalls = 0;
    const model: import("@paw/models").LanguageModel = {
      label: "truncated-then-native-fixture",
      async complete() {
        modelCalls += 1;
        return modelCalls === 1
          ? {
              finishReason: "length",
              text: "partial explanation",
              thinking: "first audit;",
            }
          : {
              text: "",
              thinking: "second audit",
              toolCalls: [
                {
                  id: "later-native-call",
                  name: "workspace_read_file",
                  arguments: { path: "a.txt" },
                  rawArguments: '{"path":"a.txt"}',
                },
              ],
            };
      },
    };
    const o = new AgentOrchestrator({
      model,
      onEvent: (event) => events.push(event),
      sessionStore: {
        saveEvent(_runId: string, envelope: RunEventEnvelope) {
          saved.push(envelope);
        },
      } as SessionStore,
      retrySleep: async () => {},
    });

    const result = await o.run({
      runId: "trunc-later-native",
      goal: "read a.txt after explaining",
      workspaceRoot: dir,
      maxSteps: 2,
    });

    expect(result.status).toBe("failed");
    expect(modelCalls).toBe(2);
    expect(events.some((event) => event.event.type === "tool.call")).toBe(
      false,
    );
    const durableDones = saved.filter(
      (envelope) => envelope.event.type === "model.done",
    );
    expect(durableDones).toHaveLength(1);
    expect(durableDones[0]?.event).toMatchObject({
      type: "model.done",
      thinking: "first audit;second audit",
    });
  });
});
