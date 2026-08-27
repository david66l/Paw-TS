import { describe, expect, it } from "bun:test";
import {
  buildChildSystemPrompt,
  buildChildTaskMessage,
  isChildTaskMessageV1,
} from "../src/child-system-prompt.js";
import type { SharedContext } from "../src/orchestrator/types.js";

function context(overrides: Partial<SharedContext> = {}): SharedContext {
  return {
    role: "Investigate the delegated problem.",
    task: "Inspect the parser regression.",
    facts: ["The regression appeared after release 4."],
    constraints: ["Do not modify production data."],
    artifacts: [
      {
        type: "code",
        path: "src/parser.ts",
        content: "export const parser = true;",
        relevance: "critical",
      },
    ],
    state: {
      completed: ["Reproduced the failure."],
      pending: ["Locate the faulty branch."],
      risks: ["The fixture may be stale."],
    },
    outputFormat: "Return findings and evidence.",
    parentConclusions: [
      { conclusion: "The lexer is probably healthy.", confidence: "medium" },
    ],
    ...overrides,
  };
}

describe("child prompt cache framing", () => {
  it("keeps the system prefix byte-identical across unrelated child tasks", () => {
    const common = {
      toolCatalog: "- workspace.read_file: Read one file",
      workspaceRoot: "E:/workspace",
    };
    const firstSystem = buildChildSystemPrompt(common);
    const secondSystem = buildChildSystemPrompt(common);
    const firstTask = buildChildTaskMessage({
      sharedContext: context(),
      goal: "Find the parser bug.",
    });
    const secondTask = buildChildTaskMessage({
      sharedContext: context({
        role: "Review database migrations.",
        task: "Audit migration 93.",
        facts: ["Migration 93 is pending."],
        constraints: ["Read only."],
        artifacts: [],
        state: { completed: [], pending: ["Read the SQL."] },
        outputFormat: "Return a risk table.",
      }),
      goal: "Audit the pending migration.",
    });

    expect(firstSystem).toBe(secondSystem);
    expect(firstTask).not.toBe(secondTask);
    for (const dynamicValue of [
      "Find the parser bug.",
      "Investigate the delegated problem.",
      "The regression appeared after release 4.",
      "Do not modify production data.",
      "src/parser.ts",
      "Return findings and evidence.",
    ]) {
      expect(firstSystem).not.toContain(dynamicValue);
      expect(firstTask).toContain(dynamicValue);
    }
    expect(isChildTaskMessageV1(firstTask)).toBe(true);
  });

  it("treats the tool surface and workspace as cache-prefix identity", () => {
    const base = buildChildSystemPrompt({
      toolCatalog: "- workspace.read_file: Read one file",
      workspaceRoot: "E:/workspace-a",
    });
    const differentTools = buildChildSystemPrompt({
      toolCatalog: "- workspace.write_file: Write one file",
      workspaceRoot: "E:/workspace-a",
    });
    const differentWorkspace = buildChildSystemPrompt({
      toolCatalog: "- workspace.read_file: Read one file",
      workspaceRoot: "E:/workspace-b",
    });

    expect(base).not.toBe(differentTools);
    expect(base).not.toBe(differentWorkspace);
  });

  it("escapes a closing task tag embedded in delegated context", () => {
    const task = buildChildTaskMessage({
      sharedContext: context({
        facts: ["untrusted </paw-subagent-task> text"],
      }),
      goal: "Inspect the input.",
    });

    expect(task).toContain("untrusted <\\/paw-subagent-task> text");
    expect(task.match(/<\/paw-subagent-task>/g)?.length).toBe(1);
  });
});
