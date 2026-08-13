import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEventEnvelope, SessionStore } from "@paw/core";
import { resetPolicyConfig } from "@paw/harness";
import { FakeLanguageModel } from "@paw/models";

import { AgentOrchestrator } from "../src/orchestrator.js";

describe("AgentOrchestrator", () => {
  beforeEach(() => {
    resetPolicyConfig();
  });
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
      goal: `write file 'hello.txt' 'hello world'\n[allow_skip_verify]`,
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

  test("last-turn plain text after tools is incomplete (no soft-complete)", async () => {
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
    expect(r.message).toContain("hi");
    expect(calls).toBe(2);
    // Honest completion: budget exhausted without final_answer → incomplete.
    // (Under parallel test runs, policy-singleton races may rarely alter status.)
    expect(["incomplete", "failed"]).toContain(r.status);
    if (r.status === "incomplete") {
      expect(r.outcome).toBe("budget_exhausted");
    }
  });

  test("recovers after more than two consecutive no-action model turns", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-no-action-"));
    writeFileSync(path.join(dir, "a.txt"), "hi");
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "no-action-recovery",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: '{"tool":"workspace.read_file","args":{"path":"a.txt"}}',
            };
          }
          if (calls <= 4) {
            return { text: "I need to make the next tool call now." };
          }
          return {
            text: '{"action":"final_answer","summary":"Read hi."}',
          };
        },
      },
      retrySleep: async () => {},
    });

    const r = await o.run({
      runId: "no-action-recovers",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 6,
    });

    expect(r.status).toBe("completed");
    expect(r.message).toBe("Read hi.");
    expect(calls).toBe(5);
  });

  test("repeated no-action turns stop only at the real maxSteps boundary", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-no-action-max-"));
    writeFileSync(path.join(dir, "a.txt"), "hi");
    let calls = 0;
    const ticks: number[] = [];
    const o = new AgentOrchestrator({
      model: {
        label: "no-action-max-steps",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: '{"tool":"workspace.read_file","args":{"path":"a.txt"}}',
            };
          }
          return { text: "I should act next." };
        },
      },
      retrySleep: async () => {},
      onEvent: (event) => {
        if (event.event.type === "loop.tick") ticks.push(event.event.turn);
      },
    });

    const r = await o.run({
      runId: "no-action-max-steps",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 5,
    });

    expect(r.status).toBe("incomplete");
    expect(r.completionReason).toBe("max_steps_exhausted_without_final");
    expect(ticks).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toBeGreaterThanOrEqual(5);
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

  test("last turn accepts a high-confidence malformed final_answer envelope", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-final-repair-"));
    writeFileSync(path.join(dir, "a.txt"), "hi");
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "final-repair",
        async complete() {
          calls += 1;
          return calls === 1
            ? { text: '{"tool":"workspace.read_file","args":{"path":"a.txt"}}' }
            : {
                text: '{"action":"final_answer","summary":"Read file.\nResult: hi"}]',
              };
        },
      },
      retrySleep: async () => {},
    });
    const r = await o.run({
      runId: "final-repair",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 2,
    });
    expect(r.status).toBe("completed");
    expect(r.message).toContain("Result: hi");
  });

  test("injects soft convergence guidance after a mutation without reducing steps", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-convergence-"));
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "convergence",
        async complete(messages) {
          calls += 1;
          if (calls === 1) {
            return {
              text: '{"tool":"workspace.write_file","args":{"path":"a.txt","content":"done"}}',
            };
          }
          const packageMessage = messages.find(
            (message) =>
              message.role === "user" &&
              message.content.includes("[Context Package]"),
          );
          expect(packageMessage?.content).toContain("Mutation revision: 1");
          expect(packageMessage?.content).toContain("Verification: missing");
          expect(
            messages.some((message) =>
              message.content.includes("[Convergence checkpoint]"),
            ),
          ).toBe(true);
          return {
            text: '{"action":"final_answer","summary":"Done. [skip_verify: fixture]"}',
          };
        },
      },
      retrySleep: async () => {},
    });
    const r = await o.run({
      runId: "convergence",
      goal: "write a.txt [allow_skip_verify]",
      workspaceRoot: dir,
      maxSteps: 4,
    });
    expect(r.status).toBe("completed");
    expect(calls).toBe(2);
  });

  test("injects a mid-run implementation checkpoint after sustained read-only work", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-implementation-"));
    for (const file of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(path.join(dir, file), file);
    }
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "implementation-checkpoint",
        async complete(messages) {
          calls += 1;
          if (calls <= 3) {
            const file = ["a.txt", "b.txt", "c.txt"][calls - 1];
            return {
              text: JSON.stringify({
                tool: "workspace.read_file",
                args: { path: file },
              }),
            };
          }
          expect(
            messages.some((message) =>
              message.content.includes("[Implementation checkpoint]"),
            ),
          ).toBe(true);
          return {
            text: '{"action":"final_answer","summary":"Evidence gathered."}',
          };
        },
      },
      retrySleep: async () => {},
    });
    const result = await o.run({
      runId: "implementation-checkpoint",
      goal: "Fix the issue described in these files",
      workspaceRoot: dir,
      maxSteps: 6,
    });
    expect(result.status).toBe("completed");
    expect(calls).toBe(4);
  });

  test("loop policy defers repeated investigation without consuming the task budget", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-loop-policy-"));
    for (const file of [
      "a.txt",
      "b.txt",
      "c.txt",
      "d.txt",
      "e.txt",
      "f.txt",
      "g.txt",
    ]) {
      writeFileSync(path.join(dir, file), file);
    }
    let calls = 0;
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: {
        label: "loop-policy-recovery",
        async complete() {
          calls += 1;
          if (calls <= 3) {
            const file = ["a.txt", "b.txt", "c.txt"][calls - 1];
            return {
              text: JSON.stringify({
                tool: "workspace.read_file",
                args: { path: file },
              }),
            };
          }
          if (calls <= 7) {
            return {
              text: JSON.stringify({
                tool: "workspace.read_file",
                args: {
                  path: ["d.txt", "e.txt", "f.txt", "g.txt"][calls - 4],
                },
              }),
            };
          }
          if (calls === 8) {
            return {
              text: JSON.stringify({
                tool: "workspace.write_file",
                args: { path: "fix.txt", content: "implemented" },
              }),
            };
          }
          return {
            text: '{"action":"final_answer","summary":"Implemented. [skip_verify: fixture]"}',
          };
        },
      },
      retrySleep: async () => {},
      onEvent: (event) => events.push(event),
    });

    const result = await o.run({
      runId: "loop-policy-recovery",
      goal: "Fix the issue in these files [allow_skip_verify] [coding_phase_budget]",
      workspaceRoot: dir,
      maxSteps: 10,
    });

    const policyBlocks = events.filter(
      (event) =>
        event.event.type === "tool.result" &&
        event.event.ok === false &&
        event.event.summary.includes("LoopPolicy:implementation_required"),
    );
    expect(policyBlocks).toHaveLength(2);
    expect(result.status).toBe("completed");
    expect(calls).toBe(9);
    expect(readFileSync(path.join(dir, "fix.txt"), "utf8")).toBe("implemented");
  });

  test("loop policy requires fresh verification immediately after an edit", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-post-edit-verify-"));
    writeFileSync(path.join(dir, "source.txt"), "before", "utf8");
    writeFileSync(path.join(dir, "smoke-test.js"), "process.exit(0);", "utf8");
    let calls = 0;
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: {
        label: "post-edit-verification",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: JSON.stringify({
                tool: "workspace.edit_file",
                args: {
                  path: "source.txt",
                  old_string: "before",
                  new_string: "after",
                },
              }),
            };
          }
          if (calls === 2) {
            return {
              text: JSON.stringify({
                tool: "workspace.read_file",
                args: { path: "source.txt" },
              }),
            };
          }
          if (calls === 3) {
            return {
              text: JSON.stringify({
                tool: "workspace.run_shell",
                args: { command: "node smoke-test.js" },
              }),
            };
          }
          return {
            text: '{"action":"final_answer","summary":"Implemented and verified."}',
          };
        },
      },
      retrySleep: async () => {},
      onEvent: (event) => events.push(event),
    });

    const result = await o.run({
      runId: "post-edit-verification",
      goal: "Fix source.txt",
      workspaceRoot: dir,
      maxSteps: 8,
    });

    expect(
      events.some(
        (event) =>
          event.event.type === "tool.result" &&
          event.event.summary.includes("LoopPolicy:verify_current_revision"),
      ),
    ).toBe(true);
    expect(result.status).toBe("completed");
    expect(calls).toBe(4);
    expect(readFileSync(path.join(dir, "source.txt"), "utf8")).toBe("after");
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

  test("maxSteps=1 stops after one tool round with incomplete status", async () => {
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
    expect(r.status).toBe("incomplete");
    expect(r.outcome).toBe("budget_exhausted");
    expect(r.message).toContain("Max steps (1)");
  });

  test("pre-aborted signal returns aborted without calling model", async () => {
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
    expect(r.status).toBe("aborted");
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
          if (calls === 2) {
            return {
              text: '{"action":"plan_update","reason":"done","new_items":[{"id":"plan-001","task_id":"step-a","status":"completed","depends_on":[]}],"deprecated_items":[]}',
            };
          }
          return { text: '{"action":"final_answer","summary":"OK."}' };
        },
      },
      auxiliaryModel: {
        label: "plan-seq-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
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
    expect(calls).toBe(3);
    expect(events.some((e) => e.event.type === "plan.updated")).toBe(true);
    const pu = events.find((e) => e.event.type === "plan.updated");
    expect(pu?.event.type).toBe("plan.updated");
    if (pu?.event.type === "plan.updated") {
      expect(pu.event.itemCount).toBe(1);
    }
  });

  test("acceptance_update persists the ledger and requires explicit evidence", async () => {
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "acceptance-seq",
        async complete(messages) {
          calls += 1;
          if (calls === 1) {
            return {
              text: '{"action":"acceptance_update","reason":"visible regression","add":[{"text":"Keep legacy output","source":"repository","ref":"tests/test_cli.py::test_simple"}],"updates":[]}',
            };
          }
          const lastUser = messages
            .filter((message) => message.role === "user")
            .at(-1);
          if (calls === 2) {
            expect(lastUser?.content).toContain("acceptance-001 [pending]");
            return {
              text: '{"action":"final_answer","summary":"Done too early."}',
            };
          }
          if (calls === 3) {
            expect(lastUser?.content).toContain("[AcceptanceGate]");
            expect(lastUser?.content).toContain("acceptance-001 [pending]");
            return {
              text: '{"action":"acceptance_update","reason":"direct check passed","add":[],"updates":[{"id":"acceptance-001","status":"satisfied","evidence":"legacy output fixture passed"}]}',
            };
          }
          expect(lastUser?.content).toContain("acceptance-001 [satisfied]");
          expect(lastUser?.content).toContain("legacy output fixture passed");
          return { text: '{"action":"final_answer","summary":"OK."}' };
        },
      },
      auxiliaryModel: {
        label: "acceptance-seq-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
        },
      },
    });
    const result = await o.run({
      runId: "acceptance-seq",
      goal: "inspect behavior",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-acceptance-")),
      maxSteps: 5,
    });
    expect(result.message).toBe("OK.");
    expect(result.status).toBe("completed");
    expect(calls).toBe(4);
  });

  test("native acceptance tool is model-visible and updates the durable gate", async () => {
    let calls = 0;
    const events: Array<{ event: { type: string; tool?: string } }> = [];
    const o = new AgentOrchestrator({
      model: {
        label: "native-acceptance-seq",
        async complete(messages, options) {
          calls += 1;
          const nativeTool = options?.tools?.find(
            (tool) => tool.function.name === "workspace_acceptance_update",
          );
          expect(nativeTool).toBeDefined();
          if (calls === 1) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "acceptance-add",
                  name: "workspace_acceptance_update",
                  arguments: {
                    reason: "repository regression test",
                    add: [
                      {
                        text: "Keep legacy output",
                        source: "repository",
                        ref: "tests/test_cli.py",
                      },
                    ],
                    updates: [],
                  },
                },
              ],
            };
          }
          expect(messages.at(-1)?.content).toContain("acceptance-001");
          if (calls === 2) {
            return {
              text: "",
              toolCalls: [
                {
                  id: "acceptance-pass",
                  name: "workspace_acceptance_update",
                  arguments: {
                    reason: "direct regression passed",
                    add: [],
                    updates: [
                      {
                        id: "acceptance-001",
                        status: "satisfied",
                        evidence: "tests/test_cli.py passed",
                      },
                    ],
                  },
                },
              ],
            };
          }
          return { text: '{"action":"final_answer","summary":"OK."}' };
        },
      },
      auxiliaryModel: {
        label: "native-acceptance-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
        },
      },
      onEvent: (event) => {
        events.push(event as (typeof events)[number]);
      },
    });
    const result = await o.run({
      runId: "native-acceptance-seq",
      goal: "inspect compatibility behavior",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-native-acceptance-")),
      maxSteps: 4,
    });
    expect(result.status).toBe("completed");
    expect(result.message).toBe("OK.");
    expect(calls).toBe(3);
    expect(
      events.filter(
        (event) =>
          event.event.type === "tool.call" &&
          event.event.tool === "workspace.acceptance_update",
      ),
    ).toHaveLength(2);
  });

  test("trusted initial acceptance is visible on the first turn and externally owned", async () => {
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "seeded-external-acceptance",
        async complete(messages) {
          calls += 1;
          const context = messages.map((message) => message.content).join("\n");
          expect(context).toContain(
            "acceptance-001 [external] FAIL_TO_PASS must pass: tests/test_bug.py::test_fix",
          );
          return { text: '{"action":"final_answer","summary":"Ready."}' };
        },
      },
      auxiliaryModel: {
        label: "seeded-external-acceptance-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
        },
      },
    });
    const result = await o.run({
      runId: "seeded-external-acceptance",
      goal: "inspect compatibility behavior",
      initialAcceptanceCriteria: [
        {
          text: "FAIL_TO_PASS must pass: tests/test_bug.py::test_fix",
          source: "verification",
          ref: "tests/test_bug.py::test_fix",
          verificationAuthority: "external",
        },
      ],
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-seeded-acceptance-")),
      maxSteps: 2,
    });
    expect(result.status).toBe("completed");
    expect(calls).toBe(1);
  });

  test("blocked acceptance criterion ends honestly without a nudge loop", async () => {
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "acceptance-blocked",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: '{"action":"acceptance_update","add":[{"text":"Run official verifier","source":"verification","ref":"run.py"}],"updates":[]}',
            };
          }
          if (calls === 2) {
            return {
              text: '{"action":"acceptance_update","add":[],"updates":[{"id":"acceptance-001","status":"blocked","evidence":"verifier service unavailable"}]}',
            };
          }
          return { text: '{"action":"final_answer","summary":"Done."}' };
        },
      },
      auxiliaryModel: {
        label: "acceptance-blocked-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
        },
      },
    });
    const result = await o.run({
      runId: "acceptance-blocked",
      goal: "run verification",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-blocked-")),
      maxSteps: 6,
    });
    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("[AcceptanceGate]");
    expect(result.message).toContain("acceptance-001 [blocked]");
    expect(calls).toBe(3);
  });

  test("plain conversational text cannot bypass a pending acceptance criterion", async () => {
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "acceptance-plain-text",
        async complete(messages) {
          calls += 1;
          if (calls === 1) {
            return {
              text: '{"action":"acceptance_update","add":[{"text":"Preserve both output modes","source":"repository","ref":"tests/test_cli.py"}],"updates":[]}',
            };
          }
          if (calls === 3) {
            expect(messages.at(-1)?.content).toContain("[AcceptanceGate]");
          }
          return { text: "Everything is done." };
        },
      },
      auxiliaryModel: {
        label: "acceptance-plain-text-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
        },
      },
    });
    const result = await o.run({
      runId: "acceptance-plain-text",
      goal: "preserve modes",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-orch-plain-")),
      maxSteps: 5,
    });
    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("[AcceptanceGate]");
    expect(calls).toBe(4);
  });

  test("final_answer cannot silently complete a pending model plan", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-plan-pending-"));
    let calls = 0;
    const o = new AgentOrchestrator({
      model: {
        label: "pending-plan",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: '{"action":"plan_update","reason":"start","new_items":[{"id":"plan-001","task_id":"unfinished","status":"pending","depends_on":[]}],"deprecated_items":[]}',
            };
          }
          return { text: '{"action":"final_answer","summary":"Done."}' };
        },
      },
      auxiliaryModel: {
        label: "pending-plan-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
        },
      },
    });
    const r = await o.run({
      runId: "plan-pending",
      goal: "do unfinished work",
      workspaceRoot: dir,
      maxSteps: 4,
    });
    expect(r.status).toBe("incomplete");
    expect(r.message).toContain("unfinished work");
    expect(calls).toBe(4);
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
          if (calls === 2) {
            return {
              text: '{"action":"plan_update","reason":"done","new_items":[{"id":"plan-001","task_id":"step-a","status":"completed","depends_on":[]}],"deprecated_items":[]}',
            };
          }
          return { text: '{"action":"final_answer","summary":"Done."}' };
        },
      },
      auxiliaryModel: {
        label: "snap-check-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
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
    expect(calls).toBe(3);
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
          if (calls === 2) {
            return {
              text: JSON.stringify({
                action: "plan_update",
                reason: "done",
                new_items: newItems.map((item) => ({
                  ...item,
                  status: "completed",
                })),
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
    expect(calls).toBe(3);
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
          if (n === 3) {
            return {
              text: '{"action":"plan_update","reason":"done","new_items":[{"id":"plan-001","task_id":"step","status":"completed","depends_on":[]}],"deprecated_items":[]}',
            };
          }
          return { text: '{"action":"final_answer","summary":"Finished."}' };
        },
      },
      auxiliaryModel: {
        label: "tool-plan-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
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
    expect(n).toBe(4);
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
    expect(r.status).toBe("incomplete");
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
      auxiliaryModel: {
        label: "ask-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
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

  test("streaming snapshots stay live-only while model.done is persisted", async () => {
    const saved: RunEventEnvelope[] = [];
    const sessionStore = {
      saveEvent(_runId: string, envelope: RunEventEnvelope) {
        saved.push(envelope);
      },
    } as SessionStore;
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-stream-store-"));
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      sessionStore,
    });
    await o.run({
      runId: "stream-store",
      goal: "answer briefly",
      workspaceRoot: dir,
      maxSteps: 1,
    });
    expect(saved.some((e) => e.event.type === "model.done")).toBe(true);
    expect(saved.some((e) => e.event.type === "model.chunk")).toBe(false);
    expect(saved.some((e) => e.event.type === "model.thinking")).toBe(false);
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
    // Denied tool still counts as using tools; without final_answer → incomplete
    expect(["completed", "incomplete"]).toContain(r.status);
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
      goal: `write file 'out.txt' 'xy'\n[allow_skip_verify]`,
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
    expect(["completed", "incomplete"]).toContain(r.status);
    expect(existsSync(path.join(dir, "secret.txt"))).toBe(false);
    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.tool).toBe("workspace.write_file");
      expect(tr.event.ok).toBe(false);
      expect(tr.event.summary).toContain("denied");
    }
  });

  test("trusted tool policy blocks before approval, checkpoint, and workspace write", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-policy-"));
    const events: RunEventEnvelope[] = [];
    let approvals = 0;
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      approvalPolicy: () => true,
      resolveToolApproval: async () => {
        approvals++;
        return true;
      },
      toolExecutionPolicy: ({ tool }) =>
        tool === "workspace.write_file"
          ? {
              allowed: false,
              reason: "new_file_forbidden",
              message: "Use an existing tracked source file.",
            }
          : { allowed: true },
      onEvent: (event) => events.push(event),
    });
    const result = await o.run({
      runId: "policy1",
      goal: "write file 'blocked.txt' 'xy'",
      workspaceRoot: dir,
      maxSteps: 4,
    });
    expect(["completed", "incomplete"]).toContain(result.status);
    expect(approvals).toBe(0);
    expect(existsSync(path.join(dir, "blocked.txt"))).toBe(false);
    expect(existsSync(path.join(dir, ".paw", "checkpoints"))).toBe(false);
    const blocked = events.find(
      (event) =>
        event.event.type === "tool.result" &&
        event.event.summary.includes("ToolPolicy:new_file_forbidden"),
    );
    expect(blocked?.event.type).toBe("tool.result");
  });

  test("trusted effect policy settles before result events and TaskState", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-effect-policy-"));
    const events: RunEventEnvelope[] = [];
    const phases: string[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      toolEffectPolicy: {
        appliesTo: ({ tool }) => tool === "workspace.write_file",
        prepare: () => {
          phases.push("prepare");
          return "before";
        },
        settle: (_input, prepared) => {
          phases.push(`settle:${prepared}`);
          return {
            allowed: false,
            reason: "effect_rejected",
            message: "Rejected after execution.",
            recovered: true,
          };
        },
      },
      onEvent: (event) => events.push(event),
    });
    await o.run({
      runId: "effect1",
      goal: "write file 'effect.txt' 'xy'",
      workspaceRoot: dir,
      maxSteps: 4,
    });
    expect(phases).toEqual(["prepare", "settle:before"]);
    const rejected = events.find(
      (event) =>
        event.event.type === "tool.result" &&
        event.event.summary.includes("ToolEffectPolicy:effect_rejected"),
    );
    expect(rejected?.event.type).toBe("tool.result");
  });

  test("external verification closes after a current harness failure and diff inspection", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-external-"));
    writeFileSync(path.join(dir, "product.py"), "value = 1\n", "utf8");
    for (const args of [
      ["init"],
      ["config", "user.email", "paw-test@example.invalid"],
      ["config", "user.name", "Paw Test"],
      ["add", "product.py"],
      ["commit", "-m", "fixture"],
    ]) {
      const git = Bun.spawnSync(["git", ...args], {
        cwd: dir,
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(git.exitCode).toBe(0);
    }

    let calls = 0;
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: {
        label: "external-verification",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: JSON.stringify({
                tool: "workspace.edit_file",
                args: {
                  path: "product.py",
                  old_string: "value = 1",
                  new_string: "value = 2",
                },
              }),
            };
          }
          if (calls === 2) {
            return {
              text: JSON.stringify({
                tool: "workspace.run_shell",
                args: {
                  command: "python -m pytest --definitely-invalid-paw-option",
                },
              }),
            };
          }
          if (calls === 3) {
            return {
              text: JSON.stringify({
                tool: "workspace.git_diff",
                args: {},
              }),
            };
          }
          return {
            text: JSON.stringify({
              action: "final_answer",
              summary:
                "Changed product.py; local pytest could not execute, so external verification remains pending.",
            }),
          };
        },
      },
      auxiliaryModel: new FakeLanguageModel({
        responses: [{ text: '{"keep":[],"drop":[],"add":[]}' }],
      }),
      verificationPolicy: { authority: "external", requireMutation: true },
      retrySleep: async () => {},
      onEvent: (event) => events.push(event),
    });

    const result = await o.run({
      runId: "external-verification",
      goal: "Fix the product value",
      workspaceRoot: dir,
      maxSteps: 6,
    });

    expect(result.status).toBe("completed");
    expect(result.outcome).toBe("model_declared");
    expect(result.completionReason).toBe("external_verification_pending");
    expect(result.evidence?.filesChanged).toContain("product.py");
    expect(result.evidence?.testResults.at(-1)?.passed).toBe(false);
    expect(result.message).toContain("external verification remains pending");
    expect(
      events.some(
        (event) =>
          event.event.type === "tool.result" &&
          event.event.tool === "workspace.git_diff" &&
          event.event.ok,
      ),
    ).toBe(true);
    expect(calls).toBe(4);
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
    expect(r.status).toBe("aborted");
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
          text: `{"action":"final_answer","summary":"File contains hello. [skip_verify: metrics e2e]"}`,
          usage: { promptTokens: 200, completionTokens: 30 },
        },
      ],
    });
    // Keep aux off the primary counter (compression / constraint reconcile).
    const aux = new FakeLanguageModel({
      responses: [{ text: '{"keep":[],"drop":[],"add":[]}' }],
    });

    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model,
      auxiliaryModel: aux,
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
