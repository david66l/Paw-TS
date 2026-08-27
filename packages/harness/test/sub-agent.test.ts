import { describe, expect, test } from "bun:test";

import { executeTool } from "../src/registry/index.js";

describe("run_agent tool", () => {
  test("returns error when launcher not configured", async () => {
    const r = await executeTool(
      { workspaceRoot: "/tmp" },
      "workspace.run_agent",
      { goal: "test" },
    );
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
      launch: async (
        goal: string,
        _maxSteps?: number,
        options?: { readonly agentId?: string },
      ) => {
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
});
