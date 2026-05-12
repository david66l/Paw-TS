import { describe, expect, test } from "bun:test";

import { executeTool } from "../src/registry.js";

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
      { workspaceRoot: "/tmp", subAgentLauncher: { launch: async () => ({ result: "", stepsTaken: 0, status: "completed" as const }) } },
      "workspace.run_agent",
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("missing goal");
  });

  test("delegates to launcher", async () => {
    let launched = false;
    const launcher = {
      launch: async (goal: string, _maxSteps?: number) => {
        launched = true;
        return { result: `Done: ${goal}`, stepsTaken: 3, status: "completed" as const };
      },
    };
    const r = await executeTool(
      { workspaceRoot: "/tmp", subAgentLauncher: launcher },
      "workspace.run_agent",
      { goal: "hello", max_steps: 5 },
    );
    expect(launched).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("completed");
  });
});
