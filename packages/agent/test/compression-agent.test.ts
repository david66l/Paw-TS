import { describe, expect, it } from "bun:test";
import { runCompressionAgent } from "../src/compression-agent.js";
import type { SubAgentLauncher } from "@paw/harness";

const fakeLauncher: SubAgentLauncher = {
  launch: async (_goal: string, _maxSteps?: number) => {
    return {
      result: `## Active Task\nTest task\n\n## Goal\nDo something\n\n## Progress\nDone step 1\n\n## Key Decisions\n- Use approach A\n\n## Relevant Files\n- src/foo.ts\n\n## Errors & Fixes\n- None\n\n## Next Steps\nStep 2\n\n## Pending Questions\nNone`,
      stepsTaken: 1,
      status: "completed" as const,
    };
  },
};

describe("runCompressionAgent", () => {
  it("returns summary and session memory", async () => {
    const result = await runCompressionAgent(fakeLauncher, "Compress this", "run-1");
    expect(result.summary).toContain("## Active Task");
    expect(result.sessionMemory.session).toBe("run-1");
    expect(result.sessionMemory.task).toBe("Test task");
    expect(result.sessionMemory.currentState).toBe("Done step 1");
    expect(result.sessionMemory.keyDecisions).toEqual(["Use approach A"]);
    expect(result.sessionMemory.filesAndFunctions).toContain("- src/foo.ts");
  });

  it("handles empty result gracefully", async () => {
    const emptyLauncher: SubAgentLauncher = {
      launch: async () => ({
        result: "",
        stepsTaken: 0,
        status: "completed" as const,
      }),
    };
    const result = await runCompressionAgent(emptyLauncher, "Compress this", "run-2");
    expect(result.summary).toBe("");
    expect(result.sessionMemory.session).toBe("run-2");
    expect(result.sessionMemory.task).toBeUndefined();
  });

  it("passes goal to launcher", async () => {
    let receivedGoal = "";
    const capturingLauncher: SubAgentLauncher = {
      launch: async (_goal: string, _maxSteps?: number) => {
        receivedGoal = _goal;
        return {
          result: "## Active Task\nCaptured",
          stepsTaken: 1,
          status: "completed" as const,
        };
      },
    };
    await runCompressionAgent(capturingLauncher, "my prompt", "run-3");
    expect(receivedGoal).toContain("Compress the following conversation");
    expect(receivedGoal).toContain("my prompt");
  });
});
