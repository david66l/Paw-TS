import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEventEnvelope } from "@paw/core";
import { FakeLanguageModel } from "@paw/models";

import { AgentOrchestrator } from "../src/orchestrator.js";

describe("AgentOrchestrator", () => {
  test("run emits tool.result when fake model requests list_dir", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-"));
    writeFileSync(path.join(dir, "note.txt"), "x");
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => {
        events.push(e);
      },
    });
    const r = await o.run({
      runId: "t1",
      goal: "list the directory",
      workspaceRoot: dir,
    });
    expect(r.status).toBe("completed");
    expect(events.some((e) => e.event.type === "agent.action")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.event.type === "agent.action" &&
          e.event.action.type === "tool_call",
      ),
    ).toBe(true);
    expect(events.some((e) => e.event.type === "tool.result")).toBe(true);
    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.detail).toContain("note.txt");
    }
    expect(events.some((e) => e.event.type === "run.completed")).toBe(true);
  });

  test("run emits tool.result when fake model requests search", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-search-"));
    writeFileSync(path.join(dir, "a.txt"), "unique-needle-xyz\n", "utf8");
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "sr1",
      goal: `search for 'unique-needle-xyz'`,
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    expect(
      events.some(
        (e) =>
          e.event.type === "agent.action" &&
          e.event.action.type === "tool_call" &&
          e.event.action.tool === "workspace.search",
      ),
    ).toBe(true);
    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.summary).toContain("match");
    }
  });

  test("run emits tool.result when fake model requests write_file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-write-"));
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => {
        events.push(e);
      },
    });
    const r = await o.run({
      runId: "wf1",
      goal: `write file 'hello.txt' 'hello world'`,
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    expect(
      events.some(
        (e) =>
          e.event.type === "agent.action" &&
          e.event.action.type === "tool_call" &&
          e.event.action.tool === "workspace.write_file",
      ),
    ).toBe(true);
    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.detail ?? tr.event.summary).toMatch(/bytes|written/i);
    }
    expect(readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe(
      "hello world",
    );
  });

  test("last-turn plain text after tools completes (no wasted nudge)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-last-turn-"));
    writeFileSync(path.join(dir, "a.txt"), "hi");
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "last-turn",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: '{"tool":"workspace.read_file","args":{"path":"a.txt"}}',
            };
          }
          // plain answer without final_answer on the last budgeted turn
          return { text: "File says hi." };
        },
      },
      retrySleep: async () => {},
    });
    const r = await o.run({
      runId: "lt1",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 2, // tool + one reply = no room to nudge
    });
    expect(r.status).toBe("completed");
    expect(r.message).toContain("hi");
    expect(calls).toBe(2);
  });

  test("run completes with final_answer JSON action", async () => {
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: {
        label: "final-json",
        async complete() {
          return {
            text: 'Thoughts.\n{"action":"final_answer","summary":"Shipped."}',
          };
        },
      },
      onEvent: (e) => {
        events.push(e);
      },
    });
    const r = await o.run({
      runId: "fa1",
      goal: "task",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-fa-")),
    });
    expect(r.status).toBe("completed");
    expect(r.message).toBe("Shipped.");
    expect(
      events.some(
        (e) =>
          e.event.type === "agent.action" &&
          e.event.action.type === "final_answer",
      ),
    ).toBe(true);
  });

  test("run completes without tool when model returns plain text", async () => {
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: {
        label: "noop",
        async complete() {
          return { text: "Just thinking out loud." };
        },
      },
      onEvent: (e) => {
        events.push(e);
      },
    });
    const r = await o.run({
      runId: "t2",
      goal: "hello",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch2-")),
    });
    expect(r.status).toBe("completed");
    expect(r.message).toContain("thinking");
    expect(events.some((e) => e.event.type === "agent.action")).toBe(false);
  });

;

;

  test("multi-turn: fake model lists then answers without a second tool", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-mt-"));
    writeFileSync(path.join(dir, "note.txt"), "x");
    const ticks: number[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => {
        if (e.event.type === "loop.tick") {
          ticks.push(e.event.turn);
        }
      },
    });
    const r = await o.run({
      runId: "mt1",
      goal: "list the directory",
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    expect(r.message).toContain("Fake model");
    expect(ticks).toEqual([1, 2]);
  });

  test("maxSteps=1 stops after one tool round with completed status", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-ms-"));
    writeFileSync(path.join(dir, "a.txt"), "1");
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
    });
    const r = await o.run({
      runId: "ms1",
      goal: "list the directory",
      workspaceRoot: dir,
      maxSteps: 1,
    });
    expect(r.status).toBe("completed");
    expect(r.message).toContain("Max steps (1)");
  });

  test("pre-aborted signal returns failed without calling model", async () => {
    const ac = new AbortController();
    ac.abort();
    let modelCalls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "count",
        async complete() {
          modelCalls += 1;
          return { text: "should not run" };
        },
      },
    });
    const r = await o.run({
      runId: "ab0",
      goal: "hello",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-ab-")),
      abortSignal: ac.signal,
    });
    expect(r.status).toBe("failed");
    expect(r.message).toBe("Run aborted.");
    expect(modelCalls).toBe(0);
  });

  test("plan_update applies TaskPlanner and can continue to final_answer", async () => {
    let calls = 0;
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: {
        label: "plan-seq",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: '{"action":"plan_update","reason":"add work","new_items":[{"id":"plan-001","task_id":"step-a","status":"pending","depends_on":[]}],"deprecated_items":[]}',
            };
          }
          return { text: '{"action":"final_answer","summary":"OK."}' };
        },
      },
      onEvent: (e) => {
        events.push(e);
      },
    });
    const r = await o.run({
      runId: "pu1",
      goal: "task",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-pu-")),
      maxSteps: 4,
    });
    expect(r.status).toBe("completed");
    expect(r.message).toBe("OK.");
    expect(calls).toBe(2);
    expect(events.some((e) => e.event.type === "plan.updated")).toBe(true);
    const pu = events.find((e) => e.event.type === "plan.updated");
    expect(pu?.event.type).toBe("plan.updated");
    if (pu?.event.type === "plan.updated") {
      expect(pu.event.itemCount).toBe(1);
    }
  });

  test("plan_update follow-up user message includes plan snapshot JSON", async () => {
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "snap-check",
        async complete(messages) {
          calls += 1;
          if (calls === 2) {
            const userMsgs = messages.filter((m) => m.role === "user");
            const lastUser = userMsgs[userMsgs.length - 1];
            expect(lastUser?.content).toContain("Current plan (JSON):");
            expect(lastUser?.content).toContain('"workflow_id":"snap-run"');
            expect(lastUser?.content).toContain("plan-001");
          }
          if (calls === 1) {
            return {
              text: '{"action":"plan_update","reason":"bootstrap","new_items":[{"id":"plan-001","task_id":"step-a","status":"pending","depends_on":[]}],"deprecated_items":[]}',
            };
          }
          return { text: '{"action":"final_answer","summary":"Done."}' };
        },
      },
    });
    const r = await o.run({
      runId: "snap-run",
      goal: "x",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-snap-")),
      maxSteps: 4,
    });
    expect(r.status).toBe("completed");
    expect(r.message).toBe("Done.");
    expect(calls).toBe(2);
  });

  test("planSnapshotMaxItems truncates embedded plan JSON", async () => {
    const newItems = Array.from({ length: 5 }, (_, i) => ({
      id: `plan-${i}`,
      task_id: `task-${i}`,
      status: "pending",
      depends_on: [] as string[],
    }));
    let calls = 0;
    const o = new AgentOrchestrator({
      planSnapshotMaxItems: 2,
      model: {
        label: "cap-snap",
        async complete(messages) {
          calls += 1;
          if (calls === 2) {
            const userMsgs = messages.filter((m) => m.role === "user");
            const lastUser = userMsgs[userMsgs.length - 1]?.content ?? "";
            const brace = lastUser.indexOf("{");
            expect(brace).toBeGreaterThan(-1);
            const parsed = JSON.parse(lastUser.slice(brace)) as {
              items: unknown[];
              truncated: boolean;
              items_total: number;
            };
            expect(parsed.items.length).toBe(2);
            expect(parsed.items_total).toBe(5);
            expect(parsed.truncated).toBe(true);
          }
          if (calls === 1) {
            return {
              text: JSON.stringify({
                action: "plan_update",
                reason: "many",
                new_items: newItems,
                deprecated_items: [],
              }),
            };
          }
          return { text: '{"action":"final_answer","summary":"ok"}' };
        },
      },
    });
    const r = await o.run({
      runId: "cap1",
      goal: "g",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-cap-")),
      maxSteps: 4,
    });
    expect(r.status).toBe("completed");
    expect(calls).toBe(2);
  });

  test("tool call then plan_update then final_answer", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-chain-"));
    writeFileSync(path.join(dir, "note.txt"), "x");
    let n = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "chain",
        async complete() {
          n += 1;
          if (n === 1) {
            return {
              text: '{"tool":"workspace.list_dir","args":{"path":".","recursive":false}}',
            };
          }
          if (n === 2) {
            return {
              text: '{"action":"plan_update","reason":"track","new_items":[{"id":"plan-001","task_id":"step","status":"pending","depends_on":[]}],"deprecated_items":[]}',
            };
          }
          return { text: '{"action":"final_answer","summary":"Finished."}' };
        },
      },
    });
    const r = await o.run({
      runId: "chain1",
      goal: "work",
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    expect(r.message).toBe("Finished.");
    expect(n).toBe(3);
  });

  test("plan_update with maxSteps=1 stops after planner apply", async () => {
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: {
        label: "pu-only",
        async complete() {
          return {
            text: '{"action":"plan_update","reason":"x","new_items":[{"id":"plan-001","task_id":"t","status":"pending","depends_on":[]}],"deprecated_items":[]}',
          };
        },
      },
      onEvent: (e) => {
        events.push(e);
      },
    });
    const r = await o.run({
      runId: "pu2",
      goal: "g",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-pu2-")),
      maxSteps: 1,
    });
    expect(r.status).toBe("completed");
    expect(r.message).toContain("Max steps (1)");
    expect(events.some((e) => e.event.type === "plan.updated")).toBe(true);
  });

  test("ask_user with resolveAskUser continues the same run", async () => {
    let n = 0;
    const o = new AgentOrchestrator({
      resolveAskUser: async () => "blue",
      model: {
        label: "ask-seq",
        async complete() {
          n += 1;
          if (n === 1) {
            return {
              text: '{"action":"ask_user","question":"color?","context":{},"timeoutSec":null}',
            };
          }
          return { text: '{"action":"final_answer","summary":"Noted."}' };
        },
      },
    });
    const r = await o.run({
      runId: "ask1",
      goal: "x",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-ask-")),
      maxSteps: 4,
    });
    expect(r.status).toBe("completed");
    expect(r.message).toBe("Noted.");
    expect(n).toBe(2);
  });

  test("fake model streams multiple chunks and usage on model.done", async () => {
    const chunks: number[] = [];
    const usages: unknown[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-stream-"));
    writeFileSync(path.join(dir, "n.txt"), "x");
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => {
        if (e.event.type === "model.chunk") {
          chunks.push(e.event.text.length);
        }
        if (e.event.type === "model.done") {
          usages.push(e.event.usage);
        }
      },
    });
    await o.run({
      runId: "st1",
      goal: "list the directory",
      workspaceRoot: dir,
      maxSteps: 2,
    });
    expect(chunks.length).toBeGreaterThan(1);
    const u = usages[0];
    expect(u).toBeDefined();
    expect(u).toMatchObject({
      totalTokens: expect.any(Number),
    });
  });

  test("resolveToolApproval deny skips successful tool execution", async () => {
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      approvalPolicy: () => true,
      resolveToolApproval: async () => false,
      model: {
        label: "deny-tool",
        async complete() {
          return {
            text: '{"tool":"workspace.list_dir","args":{"path":".","recursive":false}}',
          };
        },
      },
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "deny1",
      goal: "x",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-deny-")),
      maxSteps: 4,
    });
    expect(r.status).toBe("completed");
    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.ok).toBe(false);
      expect(tr.event.summary).toContain("denied");
    }
  });

  test("resolveToolApproval approve runs run_shell", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-sh-"));
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      resolveToolApproval: async () => true,
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "shok1",
      goal: `run shell 'echo paw-orch-shell'`,
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.tool).toBe("workspace.run_shell");
      expect(tr.event.ok).toBe(true);
      expect(tr.event.detail ?? tr.event.summary).toMatch(
        /paw-orch-shell|exit/s,
      );
    }
  });

  test("resolveToolApproval approve runs write_file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-w-ok-"));
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      resolveToolApproval: async () => true,
    });
    const r = await o.run({
      runId: "wok1",
      goal: `write file 'out.txt' 'xy'`,
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    expect(readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("xy");
  });

  test("resolveToolApproval deny skips write_file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-w-deny-"));
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      resolveToolApproval: async () => false,
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "wdn1",
      goal: `write file 'secret.txt' 'nope'`,
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    expect(existsSync(path.join(dir, "secret.txt"))).toBe(false);
    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.tool).toBe("workspace.write_file");
      expect(tr.event.ok).toBe(false);
      expect(tr.event.summary).toContain("denied");
    }
  });

  test("abort after first tool stops before next model turn", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-ab2-"));
    writeFileSync(path.join(dir, "x.txt"), "x");
    const ac = new AbortController();
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => {
        if (e.event.type === "tool.result") {
          ac.abort();
        }
      },
    });
    const r = await o.run({
      runId: "ab1",
      goal: "list the directory",
      workspaceRoot: dir,
      maxSteps: 8,
      abortSignal: ac.signal,
    });
    expect(r.status).toBe("failed");
    expect(r.message).toBe("Run aborted.");
  });

  test("parallel tool calls execute both tools in one turn", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-para-"));
    writeFileSync(path.join(dir, "a.txt"), "alpha");
    writeFileSync(path.join(dir, "b.txt"), "beta");
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "para1",
      goal: `read files 'a.txt' and 'b.txt'`,
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    const toolCalls = events.filter((e) => e.event.type === "tool.call");
    expect(toolCalls.length).toBeGreaterThanOrEqual(2);
    const toolResults = events.filter((e) => e.event.type === "tool.result");
    expect(toolResults.length).toBeGreaterThanOrEqual(2);
    const ticks = events.filter((e) => e.event.type === "loop.tick");
    // Both reads should happen in one turn, then model answers in second turn
    expect(ticks.length).toBe(2);
  });

  test("parallel tool calls with one denied still executes the other", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-para-d-"));
    writeFileSync(path.join(dir, "safe.txt"), "ok");
    const events: RunEventEnvelope[] = [];
    let approvalCount = 0;
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "para-deny",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: `Read both.\n{"tool":"workspace.read_file","args":{"path":"safe.txt"}}\n{"tool":"workspace.read_file","args":{"path":"secret.txt"}}`,
            };
          }
          return { text: '{"action":"final_answer","summary":"Done."}' };
        },
      },
      approvalPolicy: () => true,
      resolveToolApproval: async () => {
        approvalCount += 1;
        return approvalCount === 1;
      },
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "para-d1",
      goal: "x",
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    const results = events.filter((e) => e.event.type === "tool.result");
    expect(results.length).toBe(2);
    const okResults = results.filter(
      (e) => e.event.type === "tool.result" && e.event.ok,
    );
    const failResults = results.filter(
      (e) => e.event.type === "tool.result" && !e.event.ok,
    );
    expect(okResults.length).toBe(1);
    expect(failResults.length).toBe(1);
  });
});

describe("AgentOrchestrator streaming shell", () => {
  test("run_shell emits tool.result.chunk events", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-chunk-"));
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      resolveToolApproval: async () => true,
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "chunk1",
      goal: `run shell 'echo paw-orch-chunk'`,
      workspaceRoot: dir,
      maxSteps: 8,
    });
    expect(r.status).toBe("completed");
    const chunkEvents = events.filter(
      (e) => e.event.type === "tool.result.chunk",
    );
    expect(chunkEvents.length).toBeGreaterThan(0);
    const firstChunk = chunkEvents[0];
    if (firstChunk?.event.type === "tool.result.chunk") {
      expect(firstChunk.event.tool).toBe("workspace.run_shell");
      expect(firstChunk.event.isStderr).toBe(false);
      expect(firstChunk.event.chunk).toContain("paw-orch-chunk");
    }
    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.ok).toBe(true);
    }
  });

;

;

  test("end-to-end: run.metrics matches offline evaluator", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-metrics-"));
    writeFileSync(path.join(dir, "note.txt"), "hello", "utf8");

    // Preset two model responses so the run is deterministic:
    // 1. Tool call to read_file
    // 2. Final answer after seeing tool result
    const model = new FakeLanguageModel({
      responses: [
        {
          text: `Reading the file.\n{"tool":"workspace.read_file","args":{"path":"note.txt"}}`,
          usage: { promptTokens: 100, completionTokens: 50 },
        },
        {
          text: `{"action":"final_answer","summary":"File contains hello."}`,
          usage: { promptTokens: 200, completionTokens: 30 },
        },
      ],
    });

    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
    });

    const r = await o.run({
      runId: "metrics-e2e",
      goal: "read note.txt",
      workspaceRoot: dir,
      maxSteps: 8,
    });

    expect(r.status).toBe("completed");
    expect(model.callCount).toBe(2);

    // ── Online metrics ──
    const metricsEvent = events.find((e) => e.event.type === "run.metrics");
    expect(metricsEvent).toBeDefined();
    if (metricsEvent?.event.type !== "run.metrics") {
      throw new Error("metricsEvent is not run.metrics");
    }
    const online = metricsEvent.event;

    expect(online.modelCalls).toBe(2);
    expect(online.toolCalls).toBe(1);
    expect(online.toolSuccesses).toBe(1);
    expect(online.totalTokens).toBe(380); // (100+50) + (200+30)
    expect(online.steps).toBeGreaterThanOrEqual(1);
    expect(online.durationMs).toBeGreaterThanOrEqual(0);
    expect(online.modelLatencyMs).toBeGreaterThanOrEqual(0);
    expect(online.truncationCount).toBe(0);

    // ── Offline evaluator cross-check ──
    const { evaluateRunFromEnvelopes } = await import("@paw/core");
    const offline = evaluateRunFromEnvelopes(events);

    expect(offline.modelCalls).toBe(online.modelCalls);
    expect(offline.toolCalls).toBe(online.toolCalls);
    expect(offline.toolSuccesses).toBe(online.toolSuccesses);
    expect(offline.totalTokens).toBe(online.totalTokens);
    expect(offline.steps).toBe(online.steps);
    expect(offline.truncationCount).toBe(online.truncationCount);

    // Latency and duration are derived from envelope timestamps offline
    // vs Date.now() online; they should be close but not necessarily equal.
    expect(offline.durationMs).toBeGreaterThanOrEqual(0);
    expect(offline.modelLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
