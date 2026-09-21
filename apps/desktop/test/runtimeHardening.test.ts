import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "@paw/models";
import { superviseModelRequest } from "../../../packages/models/src/request-supervision.js";
import { DesktopNextEvents } from "../agent-host/paw-next-events.js";
import { runDesktopNext } from "../agent-host/paw-next.js";
import { desktopProjectContext } from "../agent-host/project-context.js";
const roots: string[] = [];

test("ordinary desktop does not enable unproven automatic reasoning recovery", async () => {
  let calls = 0;
  const model: LanguageModel = {
    label: "openai:no-recovery-test",
    capabilities: { contextWindow: 32000, maxOutputTokens: 4096 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "no-recovery-test",
      baseUrl: "https://invalid.local",
    },
    async complete(_messages, options) {
      calls++;
      const guard = superviseModelRequest(options!.signal!, {
        idleMs: 1000,
        reasoningOnlyMs: 10,
        wallMs: 2000,
      });
      guard.event({ type: "delta", kind: "thinking", count: 1 });
      return guard.run(() => new Promise<never>(() => {}));
    },
  };
  const result = await runDesktopNext("Implement the task", {
    workspaceRoot: workspace(),
    model,
    settings: {},
    memoryEnabled: false,
    environmentAudit: false,
    onEvent() {},
    maxSteps: 6,
  });
  expect(result.ok).toBe(false);
  expect(calls).toBe(1);
  expect(result.text).toContain("ModelReasoningWithoutActionTimeout");
}, 30000);

for (const stallsAgain of [false, true])
  test(`desktop reasoning recovery ${stallsAgain ? "stops a second stall" : "writes and replays without resetting allowance"}`, async () => {
    const root = workspace();
    const events: any[] = [];
    let calls = 0;
    const model: LanguageModel = {
      label: "openai:recovery-test",
      capabilities: { contextWindow: 32000, maxOutputTokens: 4096 },
      runtimeProfile: {
        protocol: "openai-compatible",
        model: "recovery-test",
        baseUrl: "https://invalid.local",
      },
      async complete(messages, options) {
        if (messages[0]?.content.includes("completion reviewer"))
          return {
            text: '{"decision":"allow","reasonCode":"evidence_sufficient","summary":"Fixture verified"}',
          };
        calls++;
        if (calls === 1 || stallsAgain || calls === 4) {
          // Exercise a real host timeout with a short deterministic deadline.
          const guard = superviseModelRequest(options!.signal!, {
            idleMs: 1000,
            reasoningOnlyMs: 10,
            wallMs: 2000,
          });
          guard.event({ type: "delta", kind: "thinking", count: 1 });
          return guard.run(() => new Promise<never>(() => {}));
        }
        const guidance = messages.map((m) => m.content).join("\n");
        expect(guidance).toContain("[Paw execution recovery;");
        expect(guidance).toContain("usage is unknown");
        expect(options?.maxOutputTokens).toBe(4096);
        if (calls === 2) {
          const args = { path: "recovered.txt", content: "recovered\n" };
          return {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "write-recovered",
                name: "workspace_write_file",
                arguments: args,
                rawArguments: JSON.stringify(args),
                sourceIndex: 0,
                argumentsValid: true,
              },
            ],
          };
        }
        return { text: "Created recovered.txt", finishReason: "stop" };
      },
    };
    const options = {
      workspaceRoot: root,
      conversationId: "reasoning",
      model,
      settings: {},
      memoryEnabled: false,
      environmentAudit: false,
      experimentalReasoningRecovery: true as const,
      maxSteps: 6,
      resolveToolApproval: async () => true,
      onEvent: (event: any) => {
        events.push(event);
      },
    };
    const result = await runDesktopNext("Write recovered.txt", options);
    expect(result.ok).toBe(!stallsAgain);
    expect(calls).toBe(stallsAgain ? 2 : 3);
    if (!stallsAgain) {
      expect(fs.readFileSync(path.join(root, "recovered.txt"), "utf8")).toBe(
        "recovered\n",
      );
      // A new host invocation replays the original run; it must not regain an allowance.
      const next = await runDesktopNext(
        "Continue with another change",
        options,
      );
      expect(next.ok).toBe(false);
      expect(calls).toBe(4);
      expect(JSON.parse(next.text).runId).toBe(JSON.parse(result.text).runId);
    }
  }, 30000);
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-hardening-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      !path.resolve(root).startsWith(path.join(os.tmpdir(), "paw-hardening-"))
    )
      throw new Error("Unsafe fixture");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project guidance is bounded, scoped, and describes the real execution environment", () => {
  const root = workspace();
  fs.mkdirSync(path.join(root, ".paw"));
  fs.writeFileSync(path.join(root, "PAW.md"), "project-rule-marker");
  fs.writeFileSync(path.join(root, ".paw/CLAUDE.md"), "committed-rule-marker");
  fs.writeFileSync(
    path.join(root, ".paw/CLAUDE.local.md"),
    "local-rule-marker",
  );
  const context = desktopProjectContext(root, {
    mode: "strict",
    commandShell: "sh",
  });
  for (const marker of [
    "project-rule-marker",
    "committed-rule-marker",
    "local-rule-marker",
    "Linux container",
    "grants no permissions",
  ])
    expect(context).toContain(marker);
  fs.writeFileSync(path.join(root, "PAW.md"), "x".repeat(100000));
  const bounded = desktopProjectContext(root, { mode: "off" });
  expect(bounded).toContain('"truncated":true');
  expect(bounded.length).toBeLessThan(14000);
});

test("thinking projection sends linear-sized deltas and an exact final response", async () => {
  const events: any[] = [];
  const projection = new DesktopNextEvents("run", (event) => {
    events.push(event.event);
  });
  for (let i = 0; i < 1000; i++)
    projection.stream({ type: "thinking", delta: "abcd" });
  projection.stream({ type: "text", delta: "done" });
  projection.stream({ type: "done", finishReason: "stop" });
  await projection.flush();
  const chunks = events.filter((e) => e.type === "model.thinking");
  expect(chunks.map((e) => e.text).join("")).toBe("abcd".repeat(1000));
  expect(chunks).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({
    type: "model.done",
    text: "done",
    thinking: "abcd".repeat(1000),
  });
});

for (const action of [true, false])
  test(`default desktop delivery review ${action ? "blocks a promise without execution" : "allows a tool-free answer"}`, async () => {
    const root = workspace();
    let main = 0;
    let reviews = 0;
    const model: LanguageModel = {
      label: "openai:test-delivery",
      capabilities: { contextWindow: 32000, maxOutputTokens: 4096 },
      runtimeProfile: {
        protocol: "openai-compatible",
        model: "test-delivery",
        baseUrl: "https://invalid.local",
      },
      async complete(messages, options) {
        if (messages[0]?.content.includes("completion reviewer")) {
          reviews++;
          expect(options?.maxOutputTokens).toBe(512);
          expect(options?.thinkingEnabled).toBe(false);
          return {
            text: JSON.stringify(
              action
                ? {
                    decision: "continue",
                    reasonCode: "missing_requirement",
                    summary: "Create src/main.js with the requested export.",
                  }
                : {
                    decision: "allow",
                    reasonCode: "evidence_sufficient",
                    summary: "The definition answers the question.",
                  },
            ),
          };
        }
        main++;
        return {
          text: action
            ? "I will now create the requested file."
            : "A closure is a function retaining access to its lexical scope.",
          finishReason: "stop",
        };
      },
    };
    const result = await runDesktopNext(
      action ? "Create src/main.js that exports 42." : "What is a closure?",
      {
        workspaceRoot: root,
        conversationId: "delivery",
        model,
        settings: {},
        memoryEnabled: false,
        onEvent() {},
        maxSteps: 4,
      },
    );
    const body = JSON.parse(result.text);
    expect(result.ok).toBe(!action);
    expect(body.status).toBe(action ? "incomplete" : "completed");
    expect(main).toBe(action ? 3 : 1);
    expect(reviews).toBe(action ? 3 : 1);
    expect(fs.existsSync(path.join(root, "src/main.js"))).toBe(false);
  }, 30000);
