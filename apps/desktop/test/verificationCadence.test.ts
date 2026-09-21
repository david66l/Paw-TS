import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenAICompatibleModel } from "@paw/models";
import { runDesktopNext } from "../agent-host/paw-next.js";

test("desktop carries verification advice through failed checks, repair and reviewed completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-verification-cadence-"));
  let cleanupFailure: Error | undefined;
  const originalFetch = globalThis.fetch;
  const requests: Array<{
    messages: Array<{ role: string; content: string }>;
  }> = [];
  const shellResults: boolean[] = [];
  let reviews = 0;
  const actions = [
    ["workspace_write_file", { path: "add.cjs", content: "module.exports = (a, b) => a - b;\n" }],
    [
      "workspace_write_file",
      {
        path: "add.test.cjs",
        content:
          "const test = require('node:test'); const assert = require('node:assert/strict'); const add = require('./add.cjs'); test('adds two numbers', () => assert.equal(add(2, 3), 5));\n",
      },
    ],
    [
      "workspace_write_file",
      {
        path: "package.json",
        content: JSON.stringify({
          private: true,
          scripts: { test: "node --test add.test.cjs" },
        }),
      },
    ],
    ["workspace_write_file", { path: "README.md", content: "Run npm test to check addition.\n" }],
    [
      "workspace_run_shell",
      {
        command: 'npm test | node -e "process.stdin.resume()"',
        timeout_sec: 15,
      },
    ],
    ["workspace_run_shell", { command: "npm test", timeout_sec: 15 }],
    ["workspace_edit_file", { path: "add.cjs", old_string: "a - b", new_string: "a + b" }],
    ["workspace_run_shell", { command: "npm test", timeout_sec: 15 }],
  ] as const;
  globalThis.fetch = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (!request.stream) {
        reviews++;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  decision: "allow",
                  reasonCode: "evidence_sufficient",
                  summary: "The repaired addition check passed.",
                }),
              },
              finish_reason: "stop",
            },
          ],
        });
      }
      requests.push(request);
      const action = actions[requests.length - 1];
      if (requests.length > actions.length + 1)
        throw new Error("Unexpected extra main-model request");
      const delta = action
        ? {
            tool_calls: [
              {
                index: 0,
                id: `cadence-${requests.length}`,
                type: "function",
                function: {
                  name: action[0],
                  arguments: JSON.stringify(action[1]),
                },
              },
            ],
          }
        : { content: "Addition implemented and tested." };
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: action ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  try {
    const result = await runDesktopNext(
      "Implement addition, add a test and README, run the test and fix any failure.",
      {
        workspaceRoot: root,
        model: new OpenAICompatibleModel({
          apiKey: "test",
          model: "cadence-test",
          capabilities: { contextWindow: 128000, maxOutputTokens: 4096 },
        }),
        settings: {},
        taskMode: "standard",
        memoryEnabled: false,
        environmentAudit: false,
        maxSteps: 11,
        // Every action is a fixed fixture above; no live model can choose commands.
        resolveToolApproval: async () => true,
        onEvent(envelope) {
          const event = envelope.event;
          if (event.type === "tool.result" && event.tool === "workspace_run_shell")
            shellResults.push(event.ok);
        },
      },
    );
    expect(JSON.parse(result.text).status).toBe("completed");
    expect(result.ok).toBe(true);
    expect(shellResults).toEqual([true, false, true]);
    expect(requests).toHaveLength(9);
    expect(reviews).toBe(1);
    const reminders = (index: number) =>
      requests[index]!.messages.filter((message) =>
        message.content?.includes("adviceId=verification_due:"),
      );
    expect(reminders(3)).toHaveLength(0);
    expect(reminders(4)).toHaveLength(1);
    expect(reminders(4)[0]?.content).toContain("4 mutation turns");
    // The original reminder stays anchored; repair does not append duplicates.
    expect(reminders(8)).toEqual(reminders(4));
    expect(
      requests[5]!.messages.some((message) =>
        message.content?.includes("adviceId=verification_repair:"),
      ),
    ).toBe(true);
    expect(
      requests[8]!.messages.filter((message) =>
        message.content?.includes("adviceId=verification_repair:"),
      ),
    ).toHaveLength(1);
    expect(
      requests[7]!.messages.some((message) =>
        message.content?.includes("adviceId=convergence_checkpoint:"),
      ),
    ).toBe(true);
    expect(
      requests[7]!.messages.some((message) => message.content?.includes("4 model calls remain")),
    ).toBe(true);
    expect(fs.readFileSync(path.join(root, "add.cjs"), "utf8")).toContain("a + b");
  } finally {
    globalThis.fetch = originalFetch;
    if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "paw-verification-cadence-"))) {
      cleanupFailure = new Error("Unsafe fixture cleanup path");
    } else {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  if (cleanupFailure) throw cleanupFailure;
}, 30000);
