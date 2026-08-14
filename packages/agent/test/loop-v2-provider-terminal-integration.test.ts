import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FakeLanguageModel } from "@paw/models";

import { AgentOrchestrator } from "../src/orchestrator.js";

function tempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("Loop Kernel v2 provider terminal production seam", () => {
  test("R11 natural stop after a tool becomes a candidate without a tail nudge", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-provider-natural-");
    fs.writeFileSync(path.join(workspaceRoot, "note.txt"), "hello\n", "utf8");
    const model = new FakeLanguageModel({
      responses: [
        {
          text: '{"tool":"workspace.read_file","args":{"path":"note.txt"}}',
          finishReason: "stop",
        },
        {
          text: "The file contains hello.",
          finishReason: "stop",
        },
      ],
    });
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model,
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-provider-natural",
        goal: "Read note.txt and report its content.",
        workspaceRoot,
        maxSteps: 5,
      });

      expect(result.status).toBe("completed");
      expect(result.message).toBe("The file contains hello.");
      expect(model.callCount).toBe(2);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("R12 two empty stops recover exactly once then end incomplete", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-provider-empty-");
    fs.writeFileSync(path.join(workspaceRoot, "note.txt"), "hello\n", "utf8");
    const model = new FakeLanguageModel({
      responses: [
        {
          text: '{"tool":"workspace.read_file","args":{"path":"note.txt"}}',
          finishReason: "stop",
        },
        { text: "", finishReason: "stop" },
        { text: "", finishReason: "stop" },
      ],
    });
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model,
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-provider-empty",
        goal: "Read note.txt and report its content.",
        workspaceRoot,
        maxSteps: 8,
      });
      expect(result.status).toBe("incomplete");
      expect(result.message).toContain("ProviderProtocol:empty_response");
      expect(result.message).toContain("recovery exhausted");
      expect(model.callCount).toBe(3);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("truncated v2 tool JSON is discarded before execution", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-provider-length-");
    const model = new FakeLanguageModel({
      responses: [
        {
          text: '{"tool":"workspace.write_file","args":{"path":"unsafe.txt","content":"must not run"}}',
          finishReason: "length",
        },
        {
          text: "The truncated request was discarded; no change was applied.",
          finishReason: "stop",
        },
      ],
    });
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model,
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-provider-length",
        goal: "Inspect the workspace without changing files.",
        workspaceRoot,
        maxSteps: 4,
      });
      expect(result.status).toBe("completed");
      expect(model.callCount).toBe(2);
      expect(fs.existsSync(path.join(workspaceRoot, "unsafe.txt"))).toBeFalse();
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("legacy final_answer is normalized then evaluated by the existing gate", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-provider-legacy-");
    const model = new FakeLanguageModel({
      responses: [
        {
          text: '{"action":"final_answer","summary":"Legacy candidate."}',
          finishReason: "stop",
        },
      ],
    });
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model,
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-provider-legacy",
        goal: "Answer with a short status.",
        workspaceRoot,
        maxSteps: 3,
      });

      expect(result.status).toBe("completed");
      expect(result.message).toBe("Legacy candidate.");
      expect(model.callCount).toBe(1);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
