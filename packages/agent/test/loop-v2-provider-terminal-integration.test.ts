import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FileSystemAppStateStore, FileSystemSessionStore } from "@paw/core";
import { FakeLanguageModel } from "@paw/models";

import type { ToolEffectPolicy } from "../src/execution-policy.js";
import {
  type LoopV2LiveCandidateAssessmentV1,
  loopV2LiveArtifactPath,
  loopV2ProjectionCheckpointPath,
  parseLoopV2LiveCandidateArtifactV1,
  parseLoopV2ProjectionCheckpointV1,
} from "../src/loop-v2/index.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

function tempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function trustedNoEffectShellPolicy(): ToolEffectPolicy {
  return {
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
  };
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

  test("resume restores pre-candidate rich commits from the latest projection checkpoint", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-projection-resume-");
    const runId = "v2-projection-resume";
    fs.writeFileSync(
      path.join(workspaceRoot, "source.txt"),
      "before\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "smoke-test.js"),
      "process.exit(0);\n",
      "utf8",
    );
    const appStateStore = new FileSystemAppStateStore({
      statesDir: path.join(workspaceRoot, ".paw", "states"),
    });
    const sessionStore = new FileSystemSessionStore({ workspaceRoot });
    const abort = new AbortController();
    const effectPolicy = trustedNoEffectShellPolicy();

    try {
      const first = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: new FakeLanguageModel({
          responses: [
            {
              text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
              finishReason: "stop",
            },
          ],
        }),
        appStateStore,
        sessionStore,
        onEvent(envelope) {
          if (envelope.event.type === "tool.result") abort.abort();
        },
      });
      const interrupted = await first.run({
        runId,
        goal: "Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 5,
        abortSignal: abort.signal,
      });
      expect(interrupted.status).toBe("aborted");

      const checkpoint = parseLoopV2ProjectionCheckpointV1(
        fs.readFileSync(
          loopV2ProjectionCheckpointPath(workspaceRoot, runId),
          "utf8",
        ),
      );
      expect(checkpoint.report.state.currentMutationRevision).toBe(1);
      expect(checkpoint.report.state.currentCandidate).toBeUndefined();
      const tampered = JSON.parse(
        fs.readFileSync(
          loopV2ProjectionCheckpointPath(workspaceRoot, runId),
          "utf8",
        ),
      ) as { report: { state: { currentMutationRevision: number } } };
      tampered.report.state.currentMutationRevision = 2;
      expect(() =>
        parseLoopV2ProjectionCheckpointV1(JSON.stringify(tampered)),
      ).toThrow("projected state mismatch");
      expect(
        fs.existsSync(loopV2LiveArtifactPath(workspaceRoot, runId)),
      ).toBeFalse();

      const resumed = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: new FakeLanguageModel({
          responses: [
            {
              text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
              finishReason: "stop",
            },
            { text: "The resumed change is verified.", finishReason: "stop" },
          ],
        }),
        appStateStore,
        sessionStore,
        toolEffectPolicy: effectPolicy,
      });
      const result = await resumed.resumeRun({ runId, workspaceRoot });
      expect(result.status).toBe("completed");
      expect(resumed.getLastLoopV2CandidateAssessment()).toMatchObject({
        facts: { evidence: 0, mutations: 1, verification: 1 },
        readiness: {
          disposition: "ready_for_review",
          readyForSemanticReview: true,
          gaps: [],
        },
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("v2 readiness feeds back one missing-verification gap then accepts a changed candidate", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-readiness-repair-");
    fs.writeFileSync(
      path.join(workspaceRoot, "source.txt"),
      "before\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "smoke-test.js"),
      "process.exit(0);\n",
      "utf8",
    );
    const model = new FakeLanguageModel({
      responses: [
        {
          text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
          finishReason: "stop",
        },
        { text: "Done without verification.", finishReason: "stop" },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
          finishReason: "stop",
        },
        { text: "Implemented and verified.", finishReason: "stop" },
      ],
    });
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      toolEffectPolicy: trustedNoEffectShellPolicy(),
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-readiness-repair",
        goal: "Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 6,
      });
      expect(result.status).toBe("completed");
      expect(model.callCount).toBe(4);
      expect(orchestrator.getLastLoopV2CandidateAssessment()).toMatchObject({
        facts: { mutations: 1, verification: 1 },
        readiness: {
          disposition: "ready_for_review",
          readyForSemanticReview: true,
          gaps: [],
        },
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("v2 readiness rejects an unchanged not-ready candidate after one feedback", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-readiness-bounded-");
    fs.writeFileSync(
      path.join(workspaceRoot, "source.txt"),
      "before\n",
      "utf8",
    );
    const model = new FakeLanguageModel({
      responses: [
        {
          text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
          finishReason: "stop",
        },
        { text: "Done without verification.", finishReason: "stop" },
        { text: "Still done without new evidence.", finishReason: "stop" },
      ],
    });
    let reviewerCalls = 0;
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      candidateReviewer: {
        async review() {
          reviewerCalls += 1;
          return {
            verdict: "pass",
            reportGrounding: "pass",
            summary: "must not run before deterministic readiness",
          };
        },
      },
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-readiness-bounded",
        goal: "Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 6,
      });
      expect(result.status).toBe("incomplete");
      expect(result.message).toContain("LoopV2Readiness:needs_work");
      expect(result.message).toContain("verification_missing");
      expect(result.message).toContain("feedback_exhausted");
      expect(model.callCount).toBe(3);
      expect(reviewerCalls).toBe(0);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("resume restores the durable readiness feedback marker without opening a second retry", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-readiness-resume-");
    const runId = "v2-readiness-resume";
    fs.writeFileSync(
      path.join(workspaceRoot, "source.txt"),
      "before\n",
      "utf8",
    );
    const appStateStore = new FileSystemAppStateStore({
      statesDir: path.join(workspaceRoot, ".paw", "states"),
    });
    const sessionStore = new FileSystemSessionStore({ workspaceRoot });
    const abort = new AbortController();
    const firstModel = new FakeLanguageModel({
      responses: [
        {
          text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
          finishReason: "stop",
        },
        { text: "Done without verification.", finishReason: "stop" },
      ],
    });
    const first = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model: firstModel,
      appStateStore,
      sessionStore,
      onEvent(envelope) {
        if (
          envelope.event.type === "agent.action" &&
          envelope.event.action.type === "final_answer"
        ) {
          abort.abort();
        }
      },
    });

    try {
      const interrupted = await first.run({
        runId,
        goal: "Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 6,
        abortSignal: abort.signal,
      });
      expect(interrupted.status).toBe("aborted");
      expect(firstModel.callCount).toBe(2);
      const saved = appStateStore.load(runId);
      expect(
        saved?.messages.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.startsWith("[LoopV2Readiness:needs_work"),
        ),
      ).toBeTrue();

      const resumedModel = new FakeLanguageModel({
        responses: [
          { text: "Still done without new evidence.", finishReason: "stop" },
        ],
      });
      const resumed = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: resumedModel,
        appStateStore,
        sessionStore,
      });
      const result = await resumed.resumeRun({ runId, workspaceRoot });
      expect(result.status).toBe("incomplete");
      expect(result.message).toContain("feedback_exhausted");
      expect(resumedModel.callCount).toBe(1);
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
