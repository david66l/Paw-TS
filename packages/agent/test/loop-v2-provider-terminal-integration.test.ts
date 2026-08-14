import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FakeLanguageModel } from "@paw/models";

import {
  type LoopV2LiveCandidateAssessmentV1,
  loopV2LiveArtifactPath,
  parseLoopV2LiveCandidateArtifactV1,
} from "../src/loop-v2/index.js";
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

  test("live candidate identity ignores natural-stop versus legacy-final wording", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-live-candidate-");
    const sourcePath = path.join(workspaceRoot, "source.txt");
    fs.writeFileSync(sourcePath, "before\n", "utf8");
    fs.writeFileSync(
      path.join(workspaceRoot, "smoke-test.js"),
      "process.exit(0);\n",
      "utf8",
    );

    const runTrajectory = async (
      terminalText: string,
    ): Promise<LoopV2LiveCandidateAssessmentV1> => {
      let call = 0;
      let captured: LoopV2LiveCandidateAssessmentV1 | undefined;
      const orchestrator = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: {
          label: "v2-live-candidate-identity",
          async complete() {
            call += 1;
            if (call === 1) {
              return {
                text: '{"tool":"workspace.read_file","args":{"path":"source.txt"}}',
                finishReason: "stop",
              };
            }
            if (call === 2) {
              return {
                text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
                finishReason: "stop",
              };
            }
            if (call === 3) {
              return {
                text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
                finishReason: "stop",
              };
            }
            return { text: terminalText, finishReason: "stop" };
          },
        },
        toolEffectPolicy: {
          appliesTo: ({ tool }) => tool === "workspace.run_shell",
          prepare: () => undefined,
          settle: ({ result }) => ({
            allowed: true,
            result: {
              ...result,
              payload: {
                ...(result.payload as Record<string, unknown>),
                workspaceEffect: { changed: false, paths: [] },
              },
            },
          }),
        },
        onLoopV2CandidateAssessment(assessment) {
          captured = assessment;
        },
      });
      const result = await orchestrator.run({
        runId: "v2-live-candidate-identity",
        goal: "Read, change, and verify source.txt.",
        workspaceRoot,
        maxSteps: 6,
      });
      expect(result.status).toBe("completed");
      expect(orchestrator.getLastLoopV2CandidateAssessment()).toEqual(captured);
      if (!captured) throw new Error("Missing live candidate assessment");
      const artifactPath = loopV2LiveArtifactPath(
        workspaceRoot,
        "v2-live-candidate-identity",
      );
      const persisted = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(artifactPath, "utf8"),
      );
      expect(persisted.assessment).toEqual(captured);
      return captured;
    };

    try {
      const natural = await runTrajectory("Implemented through natural stop.");
      const artifactPath = loopV2LiveArtifactPath(
        workspaceRoot,
        "v2-live-candidate-identity",
      );
      const tampered = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
        assessment: { candidateInputHash: string };
      };
      tampered.assessment.candidateInputHash = "tampered";
      expect(() =>
        parseLoopV2LiveCandidateArtifactV1(JSON.stringify(tampered)),
      ).toThrow("assessment does not match");
      fs.writeFileSync(sourcePath, "before\n", "utf8");
      const legacy = await runTrajectory(
        '{"action":"final_answer","summary":"Different legacy wording."}',
      );

      expect(natural.candidateInputHash).toBe(legacy.candidateInputHash);
      expect(natural.artifact.patchHash).toBe(legacy.artifact.patchHash);
      expect(natural.readiness).toMatchObject({
        disposition: "ready_for_review",
        readyForSemanticReview: true,
        localVerification: "passed",
        gaps: [],
      });
      expect(legacy.readiness).toEqual(natural.readiness);
      expect(natural.facts).toEqual({
        evidence: 1,
        mutations: 1,
        verification: 1,
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
