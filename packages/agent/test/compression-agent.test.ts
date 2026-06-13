import { describe, expect, it } from "bun:test";
import type { ChatMessage, LanguageModel } from "@paw/models";
import { runCompressionAgent } from "../src/compression-agent.js";

const SUMMARY =
  "## Active Task\nTest task\n\n## Goal\nDo something\n\n## Progress\nDone step 1\n\n## Key Decisions\n- Use approach A\n\n## Relevant Files\n- src/foo.ts\n\n## Errors & Fixes\n- None\n\n## Next Steps\nStep 2\n\n## Pending Questions\nNone";

function fakeModel(text: string): LanguageModel {
  return {
    label: "fake-compression",
    async complete() {
      return { text };
    },
    async *completeStream() {
      yield { type: "done" as const };
    },
  };
}

describe("runCompressionAgent", () => {
  it("returns summary and session memory", async () => {
    const result = await runCompressionAgent(
      fakeModel(SUMMARY),
      "Compress this",
      "run-1",
    );
    expect(result.summary).toContain("## Active Task");
    expect(result.sessionMemory.session).toBe("run-1");
    expect(result.sessionMemory.task).toBe("Test task");
    expect(result.sessionMemory.currentState).toBe("Done step 1");
    expect(result.sessionMemory.keyDecisions).toEqual(["Use approach A"]);
    expect(result.sessionMemory.filesAndFunctions).toContain("- src/foo.ts");
  });

  it("handles empty result gracefully", async () => {
    const result = await runCompressionAgent(
      fakeModel(""),
      "Compress this",
      "run-2",
    );
    expect(result.summary).toBe("");
    expect(result.sessionMemory.session).toBe("run-2");
    expect(result.sessionMemory.task).toBeUndefined();
  });

  it("passes prompt to model", async () => {
    let receivedUser = "";
    const capturingModel: LanguageModel = {
      label: "capture",
      async complete(messages: readonly ChatMessage[]) {
        receivedUser =
          messages.find((m) => m.role === "user")?.content?.toString() ?? "";
        return { text: "## Active Task\nCaptured" };
      },
      async *completeStream() {
        yield { type: "done" as const };
      },
    };
    await runCompressionAgent(capturingModel, "my prompt", "run-3");
    expect(receivedUser).toContain("my prompt");
    expect(receivedUser).toContain("## Active Task");
  });
});
