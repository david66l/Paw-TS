import { describe, expect, it } from "bun:test";
import { extractMemories } from "../src/memory-extraction-agent.js";
import type { SubAgentLauncher } from "@paw/harness";

const fakeLauncher: SubAgentLauncher = {
  launch: async (_goal: string, _maxSteps?: number) => {
    return {
      result: `## Entry 1
- **Name**: user_prefers_tabs
- **Type**: user
- **Description**: User prefers tabs over spaces
- **Content**: The user explicitly stated they prefer using tabs for indentation instead of spaces.

## Entry 2
- **Name**: project_stack
- **Type**: project
- **Description**: Tech stack is React + TypeScript
- **Content**: This project uses React with TypeScript and Vite for bundling.

## Entry 3
- **Name**: ignored_section
- **Type**: invalid_type
- **Description**: Should be ignored
- **Content**: Invalid type`,
      stepsTaken: 1,
      status: "completed" as const,
    };
  },
};

describe("extractMemories", () => {
  it("parses memory entries from sub-agent result", async () => {
    const result = await extractMemories(fakeLauncher, "Some conversation");
    expect(result.entries).toHaveLength(3);
    expect(result.entries[0]!.name).toBe("user_prefers_tabs");
    expect(result.entries[0]!.type).toBe("user");
    expect(result.entries[1]!.name).toBe("project_stack");
    expect(result.entries[1]!.type).toBe("project");
  });

  it("passes conversation text to launcher", async () => {
    let receivedGoal = "";
    const capturingLauncher: SubAgentLauncher = {
      launch: async (goal: string, _maxSteps?: number) => {
        receivedGoal = goal;
        return {
          result: "No memories to extract.",
          stepsTaken: 0,
          status: "completed" as const,
        };
      },
    };
    await extractMemories(capturingLauncher, "my conversation");
    expect(receivedGoal).toContain("my conversation");
  });

  it("returns empty array for 'no memories' response", async () => {
    const emptyLauncher: SubAgentLauncher = {
      launch: async () => ({
        result: "No memories to extract.",
        stepsTaken: 0,
        status: "completed" as const,
      }),
    };
    const result = await extractMemories(emptyLauncher, "Short conversation");
    expect(result.entries).toEqual([]);
  });

  it("handles empty result gracefully", async () => {
    const emptyLauncher: SubAgentLauncher = {
      launch: async () => ({
        result: "",
        stepsTaken: 0,
        status: "completed" as const,
      }),
    };
    const result = await extractMemories(emptyLauncher, "Short conversation");
    expect(result.entries).toEqual([]);
  });
});
