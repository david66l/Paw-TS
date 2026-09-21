import { describe, expect, test } from "bun:test";

import { executeTool } from "../src/registry/index.js";

describe("run_agent tool", () => {
  test("returns error when launcher not configured", async () => {
    const r = await executeTool({ workspaceRoot: "/tmp" }, "workspace.run_agent", { goal: "test" });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("not configured");
  });

  test("returns error for missing goal", async () => {
    const r = await executeTool(
      {
        workspaceRoot: "/tmp",
        subAgentLauncher: {
          launch: async () => ({
            summary: "",
            status: "completed" as const,
          }),
          launchStreaming: async () => ({
            summary: "",
            status: "completed" as const,
          }),
        },
      },
      "workspace.run_agent",
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("missing required field: goal");
  });

  test("delegates to launcher", async () => {
    let launched = false;
    let launchedAgentId: string | undefined;
    const launcher = {
      launch: async (goal: string, _maxSteps?: number, options?: { readonly agentId?: string }) => {
        launched = true;
        launchedAgentId = options?.agentId;
        return {
          summary: `Done: ${goal}`,
          status: "completed" as const,
        };
      },
      launchStreaming: async () => ({
        summary: "",
        status: "completed" as const,
      }),
    };
    const r = await executeTool(
      {
        workspaceRoot: "/tmp",
        subAgentLauncher: launcher,
        currentToolCallId: "parent-call-7",
      },
      "workspace.run_agent",
      { goal: "hello", max_steps: 5 },
    );
    expect(launched).toBe(true);
    expect(launchedAgentId).toBe("parent-call-7");
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("completed");
  });

  /**
   * 渲染进程（`useAgentRun.ts:995-999`）用 /\[([a-zA-Z0-9_-]+)\]/ 从 `summary`
   * 里抠 agentId —— 也就是说子 Agent 名册依赖这句人类可读文案的形状。
   *
   * 这条契约测试的作用不是"修掉"那个耦合（要修得给 tool.result 事件加结构化的
   * agentId，属于 §D2 的协议改动），而是把它从**哑的**变成**响的**：谁改了摘要
   * 措辞，这里就红，而不是静默清空名册。
   */
  const stubLauncher = {
    launch: async () => ({ summary: "", status: "completed" as const }),
    launchStreaming: async () => ({ summary: "", status: "completed" as const }),
  };

  test("summary keeps the bracket shape the renderer scrapes agentId from", async () => {
    const r = await executeTool(
      { workspaceRoot: "/tmp", subAgentLauncher: stubLauncher },
      "workspace.run_agent",
      { goal: "hello", agentId: "sub-42" },
    );
    expect(r.summary.startsWith("run_agent: ")).toBe(true);
    expect(r.summary.match(/\[([a-zA-Z0-9_-]+)\]/)?.[1]).toBe("sub-42");
  });

  test("summary carries no bracket when the launcher reported no agentId", async () => {
    const r = await executeTool(
      { workspaceRoot: "/tmp", subAgentLauncher: stubLauncher },
      "workspace.run_agent",
      { goal: "hello" },
    );
    // 渲染侧拿到 undefined 时不会误建一个空 id 的条目
    expect(r.summary.match(/\[([a-zA-Z0-9_-]+)\]/)).toBeNull();
  });
});
