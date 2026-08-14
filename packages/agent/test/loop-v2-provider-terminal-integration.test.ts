import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FileSystemAppStateStore,
  FileSystemSessionStore,
  type RunEventEnvelope,
} from "@paw/core";
import { FakeLanguageModel, type LanguageModel } from "@paw/models";

import type { ToolEffectPolicy } from "../src/execution-policy.js";
import {
  type LoopV2LiveCandidateAssessmentV1,
  assessLoopV2AuthorityEligibilityV1,
  buildLoopV2LiveReviewArtifactV1,
  buildLoopV2LiveReviewClaimV1,
  buildLoopV2LiveReviewPayloadV1,
  createInterruptedSemanticReviewRecordV2,
  createSemanticReviewLedgerV2,
  loopV2LiveArtifactPath,
  loopV2LiveReviewArtifactPath,
  loopV2LiveReviewClaimPath,
  loopV2LiveTerminalArtifactPath,
  loopV2ProjectionCheckpointPath,
  parseLoopV2LiveCandidateArtifactV1,
  parseLoopV2LiveReviewArtifactV1,
  parseLoopV2LiveReviewClaimV1,
  parseLoopV2LiveTerminalArtifactV1,
  parseLoopV2ProjectionCheckpointV1,
  reviewCandidateOnceV2,
  serializeLoopV2LiveReviewArtifactV1,
  serializeLoopV2LiveReviewClaimV1,
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
      const candidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(
          loopV2LiveArtifactPath(workspaceRoot, "v2-provider-natural"),
          "utf8",
        ),
      );
      const terminal = parseLoopV2LiveTerminalArtifactV1(
        fs.readFileSync(
          loopV2LiveTerminalArtifactPath(workspaceRoot, "v2-provider-natural"),
          "utf8",
        ),
        candidate,
      );
      expect(terminal).toMatchObject({
        legacyTerminal: { status: "completed" },
        v2Outcome: {
          executionStatus: "incomplete",
          candidateStatus: "proposed",
          localVerification: "not_required",
          artifactStatus: "none",
          reasonCode: "semantic_review_missing",
        },
        comparison: "legacy_more_permissive",
      });
      expect(
        assessLoopV2AuthorityEligibilityV1(terminal, candidate),
      ).toMatchObject({
        eligible: false,
        reasons: expect.arrayContaining([
          "product_mutation_not_required",
          "mutation_missing",
          "review_missing",
          "v2_not_completed",
          "candidate_not_certified",
          "artifact_not_valid",
          "terminal_comparison_not_equal",
        ]),
      });
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
      expect(
        parseLoopV2LiveTerminalArtifactV1(
          fs.readFileSync(
            loopV2LiveTerminalArtifactPath(workspaceRoot, "v2-provider-empty"),
            "utf8",
          ),
        ),
      ).toMatchObject({
        legacyTerminal: { status: "incomplete" },
        v2Outcome: {
          executionStatus: "incomplete",
          candidateStatus: "none",
          reasonCode: "provider_protocol_empty_response",
        },
        comparison: "equal",
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("terminal dual-calculation covers max-step exhaustion and runtime failure", async () => {
    const exhaustedWorkspace = tempWorkspace("paw-v2-terminal-exhausted-");
    const failedWorkspace = tempWorkspace("paw-v2-terminal-failed-");
    fs.writeFileSync(
      path.join(exhaustedWorkspace, "note.txt"),
      "hello\n",
      "utf8",
    );

    try {
      const exhausted = await new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: new FakeLanguageModel({
          responses: [
            {
              text: '{"tool":"workspace.read_file","args":{"path":"note.txt"}}',
              finishReason: "stop",
            },
          ],
        }),
      }).run({
        runId: "v2-terminal-exhausted",
        goal: "Read note.txt.",
        workspaceRoot: exhaustedWorkspace,
        maxSteps: 1,
      });
      expect(exhausted.status).toBe("incomplete");
      expect(
        parseLoopV2LiveTerminalArtifactV1(
          fs.readFileSync(
            loopV2LiveTerminalArtifactPath(
              exhaustedWorkspace,
              "v2-terminal-exhausted",
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({
        legacyTerminal: {
          status: "incomplete",
          outcome: "budget_exhausted",
          reasonCode: "max_steps_reached_after_tools",
        },
        v2Outcome: {
          executionStatus: "incomplete",
          reasonCode: "max_steps_reached_after_tools",
        },
        comparison: "equal",
      });

      const failed = await new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: new FakeLanguageModel({
          responses: [{ error: "HTTP 400 terminal fixture" }],
        }),
      }).run({
        runId: "v2-terminal-failed",
        goal: "Trigger the deterministic provider failure.",
        workspaceRoot: failedWorkspace,
        maxSteps: 2,
      });
      expect(failed.status).toBe("failed");
      expect(
        parseLoopV2LiveTerminalArtifactV1(
          fs.readFileSync(
            loopV2LiveTerminalArtifactPath(
              failedWorkspace,
              "v2-terminal-failed",
            ),
            "utf8",
          ),
        ),
      ).toMatchObject({
        legacyTerminal: { status: "failed" },
        v2Outcome: {
          executionStatus: "failed",
          reasonCode: "runtime_failed",
        },
        comparison: "equal",
      });
    } finally {
      fs.rmSync(exhaustedWorkspace, { recursive: true, force: true });
      fs.rmSync(failedWorkspace, { recursive: true, force: true });
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
      expect(
        parseLoopV2LiveTerminalArtifactV1(
          fs.readFileSync(
            loopV2LiveTerminalArtifactPath(workspaceRoot, runId),
            "utf8",
          ),
        ),
      ).toMatchObject({
        legacyTerminal: { status: "aborted" },
        v2Outcome: {
          executionStatus: "aborted",
          reasonCode: "user_aborted",
        },
        comparison: "equal",
      });

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

  test("explicit v2 persists and accounts one semantic review before completion", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-semantic-pass-");
    const runId = "v2-semantic-pass";
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
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
          finishReason: "stop",
        },
        { text: "Implemented and verified.", finishReason: "stop" },
      ],
    });
    let reviewCalls = 0;
    let legacyReviewerCalls = 0;
    const reviewModel: LanguageModel = {
      label: "v2-semantic-review-fixture",
      async complete(messages) {
        reviewCalls += 1;
        const material = messages.at(-1)?.content ?? "";
        const candidateInputHash = /"candidateInputHash":"([^"]+)"/.exec(
          material,
        )?.[1];
        const mutationRevision = Number(
          /"mutationRevision":(\d+)/.exec(material)?.[1],
        );
        if (!candidateInputHash || !Number.isSafeInteger(mutationRevision)) {
          throw new Error(
            "Reviewer fixture did not receive candidate identity",
          );
        }
        return {
          text: JSON.stringify({
            candidateInputHash,
            mutationRevision,
            verdict: "pass",
            findings: [],
          }),
          usage: {
            promptTokens: 11,
            completionTokens: 3,
          },
          finishReason: "stop",
        };
      },
    };
    const events: RunEventEnvelope[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      loopV2SemanticReviewModel: reviewModel,
      candidateReviewer: {
        async review() {
          legacyReviewerCalls += 1;
          return {
            verdict: "pass",
            reportGrounding: "pass",
            summary: "Legacy reviewer must not run in explicit v2.",
          };
        },
      },
      verificationPolicy: { authority: "local", requireMutation: true },
      toolEffectPolicy: trustedNoEffectShellPolicy(),
      onEvent: (event) => events.push(event),
    });

    try {
      const result = await orchestrator.run({
        runId,
        goal: "Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 6,
      });
      expect(result.status).toBe("completed");
      expect(reviewCalls).toBe(1);
      expect(legacyReviewerCalls).toBe(0);
      const candidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(loopV2LiveArtifactPath(workspaceRoot, runId), "utf8"),
      );
      const persistedReview = parseLoopV2LiveReviewArtifactV1(
        fs.readFileSync(
          loopV2LiveReviewArtifactPath(workspaceRoot, runId),
          "utf8",
        ),
        candidate,
      );
      expect(
        fs.existsSync(loopV2LiveReviewClaimPath(workspaceRoot, runId)),
      ).toBeTrue();
      expect(persistedReview.record.review.verdict).toBe("pass");
      const terminal = parseLoopV2LiveTerminalArtifactV1(
        fs.readFileSync(
          loopV2LiveTerminalArtifactPath(workspaceRoot, runId),
          "utf8",
        ),
        candidate,
        persistedReview,
      );
      expect(terminal).toMatchObject({
        legacyTerminal: {
          status: "completed",
          outcome: "verified",
          reasonCode: "tests_passed",
        },
        v2Outcome: {
          executionStatus: "completed",
          candidateStatus: "certified",
          localVerification: "passed",
          externalVerification: "not_configured",
          artifactStatus: "valid",
          reasonCode: "candidate_certified",
        },
        comparison: "equal",
      });
      expect(
        assessLoopV2AuthorityEligibilityV1(
          terminal,
          candidate,
          persistedReview,
        ),
      ).toEqual({ eligible: true, reasons: [] });
      expect(
        events.find((event) => event.event.type === "candidate.review")?.event,
      ).toMatchObject({
        type: "candidate.review",
        verdict: "pass",
        modelCalls: 1,
        usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("resume reuses the same semantic candidate and does not review revised prose", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-semantic-resume-");
    const runId = "v2-semantic-resume";
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
    let reviewCalls = 0;
    const reviewModel: LanguageModel = {
      label: "v2-semantic-partial-fixture",
      async complete(messages) {
        reviewCalls += 1;
        const material = messages.at(-1)?.content ?? "";
        const candidateInputHash = /"candidateInputHash":"([^"]+)"/.exec(
          material,
        )?.[1];
        const mutationRevision = Number(
          /"mutationRevision":(\d+)/.exec(material)?.[1],
        );
        return {
          text: JSON.stringify({
            candidateInputHash,
            mutationRevision,
            verdict: "partial",
            findings: [
              {
                severity: "warning",
                observedChange: "The candidate needs an independent follow-up.",
                risk: "Semantic certification is incomplete.",
                evidenceRefs: ["snapshot:source.txt"],
              },
            ],
          }),
          finishReason: "stop",
        };
      },
    };
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
          {
            text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
            finishReason: "stop",
          },
          { text: "First proposed report.", finishReason: "stop" },
        ],
      }),
      loopV2SemanticReviewModel: reviewModel,
      appStateStore,
      sessionStore,
      toolEffectPolicy: trustedNoEffectShellPolicy(),
      onEvent: (event) => {
        if (event.event.type === "candidate.review") abort.abort();
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
      expect(reviewCalls).toBe(1);
      const firstCandidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(loopV2LiveArtifactPath(workspaceRoot, runId), "utf8"),
      );

      const resumedEvents: RunEventEnvelope[] = [];
      const resumed = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: new FakeLanguageModel({
          responses: [
            { text: "Reworded report, no fact change.", finishReason: "stop" },
          ],
        }),
        loopV2SemanticReviewModel: reviewModel,
        appStateStore,
        sessionStore,
        toolEffectPolicy: trustedNoEffectShellPolicy(),
        onEvent: (event) => resumedEvents.push(event),
      });
      const result = await resumed.resumeRun({ runId, workspaceRoot });
      expect(result.status).toBe("incomplete");
      expect(result.message).toContain("feedback_exhausted");
      expect(reviewCalls).toBe(1);
      const resumedCandidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(loopV2LiveArtifactPath(workspaceRoot, runId), "utf8"),
      );
      expect(resumedCandidate.artifactHash).toBe(firstCandidate.artifactHash);
      expect(
        resumedEvents.find((event) => event.event.type === "candidate.review")
          ?.event,
      ).toMatchObject({
        type: "candidate.review",
        verdict: "partial",
        modelCalls: 0,
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("resume converts an unsettled review claim to partial without another model call", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-semantic-claim-resume-");
    const runId = "v2-semantic-claim-resume";
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
          {
            text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
            finishReason: "stop",
          },
          { text: "Candidate before reviewer dispatch.", finishReason: "stop" },
        ],
      }),
      appStateStore,
      sessionStore,
      toolEffectPolicy: trustedNoEffectShellPolicy(),
    });

    try {
      const firstResult = await first.run({
        runId,
        goal: "Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 7,
      });
      expect(firstResult.status).toBe("completed");
      const candidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(loopV2LiveArtifactPath(workspaceRoot, runId), "utf8"),
      );
      const claim = buildLoopV2LiveReviewClaimV1(candidate);
      fs.writeFileSync(
        loopV2LiveReviewClaimPath(workspaceRoot, runId),
        serializeLoopV2LiveReviewClaimV1(claim, candidate),
        "utf8",
      );

      let reviewCalls = 0;
      const reviewModel: LanguageModel = {
        label: "must-not-repeat-claimed-review",
        async complete() {
          reviewCalls += 1;
          return { text: "{}" };
        },
      };
      const resumed = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: new FakeLanguageModel({
          responses: [
            { text: "Resume the same candidate.", finishReason: "stop" },
            { text: "Still the same candidate.", finishReason: "stop" },
          ],
        }),
        loopV2SemanticReviewModel: reviewModel,
        appStateStore,
        sessionStore,
        toolEffectPolicy: trustedNoEffectShellPolicy(),
      });
      const result = await resumed.resumeRun({ runId, workspaceRoot });
      expect(result.status).toBe("incomplete");
      expect(result.message).toContain("feedback_exhausted");
      expect(reviewCalls).toBe(0);
      const interruptedReview = parseLoopV2LiveReviewArtifactV1(
        fs.readFileSync(
          loopV2LiveReviewArtifactPath(workspaceRoot, runId),
          "utf8",
        ),
        candidate,
      );
      expect(interruptedReview.record).toMatchObject({
        completion: "protocol_partial",
        reasonCode: "reviewer_interrupted",
        review: { verdict: "partial" },
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
      const reviewPayload = buildLoopV2LiveReviewPayloadV1(persisted.report);
      expect(reviewPayload.candidateInputHash).toBe(
        captured.candidateInputHash,
      );
      expect(reviewPayload.snapshots).toEqual([
        expect.objectContaining({
          path: "source.txt",
          content: "after\n",
        }),
      ]);
      const claim = buildLoopV2LiveReviewClaimV1(persisted);
      const parsedClaim = parseLoopV2LiveReviewClaimV1(
        serializeLoopV2LiveReviewClaimV1(claim, persisted),
        persisted,
      );
      expect(parsedClaim.reviewKey).toBe(claim.reviewKey);
      const interruptedRecord =
        createInterruptedSemanticReviewRecordV2(reviewPayload);
      const interruptedArtifact = parseLoopV2LiveReviewArtifactV1(
        serializeLoopV2LiveReviewArtifactV1(
          buildLoopV2LiveReviewArtifactV1(persisted, interruptedRecord),
          persisted,
        ),
        persisted,
      );
      let interruptedReviewerCalls = 0;
      const interruptedResume = await reviewCandidateOnceV2(
        {
          records: {
            [interruptedArtifact.reviewKey]: interruptedArtifact.record,
          },
        },
        reviewPayload,
        async () => {
          interruptedReviewerCalls += 1;
          return {};
        },
      );
      expect(interruptedResume.reused).toBe(true);
      expect(interruptedResume.review.verdict).toBe("partial");
      expect(interruptedReviewerCalls).toBe(0);

      const tamperedClaim = JSON.parse(JSON.stringify(claim)) as {
        status: string;
      };
      tamperedClaim.status = "settled";
      expect(() =>
        parseLoopV2LiveReviewClaimV1(JSON.stringify(tamperedClaim), persisted),
      ).toThrow();

      let reviewerCalls = 0;
      const reviewed = await reviewCandidateOnceV2(
        createSemanticReviewLedgerV2(),
        reviewPayload,
        async () => {
          reviewerCalls += 1;
          return {
            candidateInputHash: reviewPayload.candidateInputHash,
            mutationRevision: reviewPayload.input.mutationRevision,
            verdict: "pass",
            findings: [],
          };
        },
      );
      const record = reviewed.ledger.records[reviewed.reviewKey];
      if (!record) throw new Error("Missing semantic review record");
      const reviewArtifact = buildLoopV2LiveReviewArtifactV1(persisted, record);
      const parsedReview = parseLoopV2LiveReviewArtifactV1(
        serializeLoopV2LiveReviewArtifactV1(reviewArtifact, persisted),
        persisted,
      );
      expect(parsedReview.record).toEqual(record);
      const resumed = await reviewCandidateOnceV2(
        { records: { [parsedReview.reviewKey]: parsedReview.record } },
        reviewPayload,
        async () => {
          reviewerCalls += 1;
          return {};
        },
      );
      expect(resumed.reused).toBe(true);
      expect(reviewerCalls).toBe(1);

      const tamperedReview = JSON.parse(JSON.stringify(reviewArtifact)) as {
        record: { review: { verdict: string } };
      };
      tamperedReview.record.review.verdict = "fail";
      expect(() =>
        parseLoopV2LiveReviewArtifactV1(
          JSON.stringify(tamperedReview),
          persisted,
        ),
      ).toThrow();
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
