import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LanguageModel, OpenAICompatibleModel } from "@paw/models";
import { desktopProfile } from "../agent-host/paw-next-profile.js";
import { PAW_AGENT_SYSTEM_PROMPT } from "../agent-host/agent-system-prompt.js";
import { runDesktopNext } from "../agent-host/paw-next.js";

setDefaultTimeout(30_000);
const originalFetch = globalThis.fetch;
const roots: string[] = [];
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-output-budget-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) {
    if (
      !path
        .resolve(root)
        .startsWith(path.join(os.tmpdir(), "paw-output-budget-"))
    )
      throw new Error("Unsafe fixture path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("desktop reserves each selected model's output limit, including model switches and unknown capabilities", () => {
  const root = workspace();
  for (const [limit, expected] of [
    [128_000, 128_000],
    [384_000, 384_000],
    [4096, 4096],
    [undefined, 8192],
  ]) {
    const model = new OpenAICompatibleModel({
      apiKey: "test",
      model: "budget-test",
      capabilities: { contextWindow: 1_000_000, maxOutputTokens: limit },
    });
    const profile = desktopProfile(root, model, {}, 4, false);
    expect(profile.model.capabilities.maxOutputTokens).toBe(expected);
    expect(profile.budget.reservedOutputTokens).toBe(expected);
  }
});

test("desktop GLM stream sends native 128K on first request and recovery while preserving max reasoning", async () => {
  const root = workspace();
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = Object.assign(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const first = requests.length === 1;
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: first ? { reasoning_content: "partial reasoning" } : { content: "Done" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: first ? "length" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  const model = new OpenAICompatibleModel({
    apiKey: "test",
    model: "glm-5.3-flash",
    baseUrl: "https://desktop.invalid/v1",
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    reasoningEffort: "max",
  });
  const result = await runDesktopNext("Answer Done", {
    workspaceRoot: root,
    conversationId: "output-budget",
    taskMode: "standard",
    model,
    settings: {},
    memoryEnabled: false,
    environmentAudit: false,
    maxSteps: 4,
    resolveToolApproval: async () => true,
    onEvent: () => {},
  });
  expect(result.ok).toBe(true);
  expect(JSON.parse(result.text).status).toBe("completed");
  const approvedPrompt = fs
    .readFileSync(
      path.resolve(
        import.meta.dir,
        "./fixtures/agent-system-prompt.zh-CN.txt",
      ),
      "utf8",
    )
    .replace(/\r\n/g, "\n")
    .trim();
  expect(PAW_AGENT_SYSTEM_PROMPT).toBe(approvedPrompt);
  for (const request of requests) {
    const messages = request.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content.startsWith(approvedPrompt)).toBe(true);
    expect(messages[0]?.content).toContain("[Paw workspace context v1]");
  }
  expect(requests.map((request) => request.max_tokens)).toEqual([
    128_000, 128_000,
  ]);
  expect(requests.every((request) => request.reasoning_effort === "max")).toBe(
    true,
  );
  expect(
    (requests[1].messages as Array<Record<string, unknown>>).some(
      (message) => message.reasoning_content === "partial reasoning",
    ),
  ).toBe(true);
});

test("delegated agent uses its own model output capacity instead of the parent's limit", async () => {
  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    name,
    arguments: args,
    rawArguments: JSON.stringify(args),
    sourceIndex: 0,
    argumentsValid: true,
  });
  const root = workspace();
  fs.writeFileSync(path.join(root, "evidence.txt"), "Evidence");
  const childLimits: Array<number | undefined> = [];
  const parentLimits: Array<number | undefined> = [];
  const child: LanguageModel = {
    label: "openai:large-child",
    capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "large-child",
      baseUrl: "https://desktop.invalid/v1",
    },
    async complete(_messages, options) {
      childLimits.push(options?.maxOutputTokens);
      return childLimits.length === 1
        ? {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              call("read", "workspace_read_file", { path: "evidence.txt" }),
            ],
          }
        : { text: "Evidence reviewed", finishReason: "stop" };
    },
  };
  const parent: LanguageModel = {
    ...child,
    label: "openai:small-parent",
    capabilities: { contextWindow: 32_000, maxOutputTokens: 4096 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "small-parent",
      baseUrl: "https://desktop.invalid/v1",
    },
    async complete(_messages, options) {
      parentLimits.push(options?.maxOutputTokens);
      return parentLimits.length === 1
        ? {
            text: "",
            finishReason: "tool_calls",
            toolCalls: [
              call("delegate", "workspace_delegate", {
                goal: "Read evidence.txt",
                kind: "review",
                agent_id: "keji",
                max_steps: 3,
              }),
            ],
          }
        : { text: "Done", finishReason: "stop" };
    },
  };
  const result = await runDesktopNext("Ask a reviewer to read evidence.txt", {
    workspaceRoot: root,
    taskMode: "standard",
    model: parent,
    collaborationModels: { keji: child },
    settings: {},
    memoryEnabled: false,
    environmentAudit: false,
    maxSteps: 4,
    resolveToolApproval: async () => true,
    onEvent: () => {},
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(result.ok).toBe(true);
  expect(childLimits.length).toBeGreaterThanOrEqual(2);
  expect(childLimits.every((limit) => limit === 128_000)).toBe(true);
  expect(parentLimits.every((limit) => limit === 4096)).toBe(true);
});
