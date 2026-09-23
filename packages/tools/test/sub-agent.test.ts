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
   * 渲染进程在 `useAgentRun.ts:955-967` 按三级兜底解析 run_agent 的 specId：
   *
   *   1. `runAgentSpecByCallRef.get(callId)`  —— tool.call 时从 args 记下的（`:868`）
   *   2. `runAgentSpecId(ev.args)`            —— tool.result 自带的 args（`agent_id`/`agentId`）
   *   3. `ev.summary.match(/\[([a-zA-Z0-9_-]+)\]/)` —— 就是下面这两条测试钉的形状
   *
   * 所以名册**不是**依赖这句人类可读文案：第 3 级只在 `ev.args` 缺席时才起作用。
   * 但它是链上唯一没有类型保护的一环 —— 前两级读结构化字段，改名会 tsc 报错；
   * 第 3 级读一段自由文本，摘要在 `handlers/agents.ts:48` 里拼，改了措辞没有任何
   * 编译期信号，只会静默退化成"名册没有绿点"。
   *
   * 这两条测试的作用就是把那一环从**哑的**变成**响的**，而不是替它加协议字段
   * （那是 §D2 的改动）。
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

  test("agent_id and agentId are read as the same bracket value", async () => {
    const snake = await executeTool(
      { workspaceRoot: "/tmp", subAgentLauncher: stubLauncher },
      "workspace.run_agent",
      { goal: "hello", agent_id: "bige" },
    );
    const camel = await executeTool(
      { workspaceRoot: "/tmp", subAgentLauncher: stubLauncher },
      "workspace.run_agent",
      { goal: "hello", agentId: "bige" },
    );
    expect(snake.summary).toBe(camel.summary);
    expect(snake.summary).toContain("[bige]");
  });

  test("maxSteps is the camel alias of max_steps on the way to the launcher", async () => {
    const seen: Array<number | undefined> = [];
    const launcher = {
      launch: async (_goal: string, maxSteps?: number) => {
        seen.push(maxSteps);
        return { summary: "", status: "completed" as const };
      },
      launchStreaming: async () => ({ summary: "", status: "completed" as const }),
    };
    const ctx = { workspaceRoot: "/tmp", subAgentLauncher: launcher };
    await executeTool(ctx, "workspace.run_agent", { goal: "a", max_steps: 5 });
    await executeTool(ctx, "workspace.run_agent", { goal: "a", maxSteps: 7 });
    expect(seen).toEqual([5, 7]);
  });

  /**
   * 渲染进程的 `runAgentGoal`（`useAgentRun.ts:46-55`）为了展示容错，接受
   * goal/task/description/objective/prompt **五个**键；但工具侧只认 `goal`
   * （`handlers/agents.ts:11`，没有别名），且 `goal` 是声明式必填 ——
   * `tool-support.ts:90` 的通用校验在进处理器之前就拒了。
   *
   * 两边容错度不一致本身不是 bug（一边是为了渲染兜底，一边是硬契约），但这意味着
   * **给渲染侧加别名永远不会让模型多一种合法写法**。这条测试把那个方向钉死：
   * 谁想"顺手"让 `task` 也通过，必须先动 schema，而不是改 `runAgentGoal`。
   */
  test("a desktop-tolerated goal alias is still rejected by the declared schema", async () => {
    const r = await executeTool(
      { workspaceRoot: "/tmp", subAgentLauncher: stubLauncher },
      "workspace.run_agent",
      { task: "hello" },
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("missing required field: goal");
  });
});
