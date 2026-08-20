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
  HOST_TASK_GOAL_REVIEW_CRITERION_ID,
  type LoopV2LiveCandidateArtifactV1,
  type LoopV2LiveCandidateAssessmentV1,
  LoopV2LiveReviewRuntimeV1,
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
  loopV2RunResultShadowArtifactPath,
  parseLoopV2LiveCandidateArtifactV1,
  parseLoopV2LiveReviewArtifactV1,
  parseLoopV2LiveReviewClaimV1,
  parseLoopV2LiveTerminalArtifactV1,
  parseLoopV2ProjectionCheckpointV1,
  parseLoopV2RunResultShadowArtifactV1,
  replayLegacyTraceToLoopV2ShadowV1,
  reviewCandidateOnceV2,
  serializeLoopV2LiveCandidateArtifactV1,
  serializeLoopV2LiveReviewArtifactV1,
  serializeLoopV2LiveReviewClaimV1,
} from "../src/loop-v2/index.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

function tempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function finalAnswer(summary: string): string {
  return JSON.stringify({ action: "final_answer", summary });
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
  test("R11 natural stop is a boundary and only explicit final becomes a candidate", async () => {
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
        {
          text: finalAnswer("The file contains hello."),
          finishReason: "stop",
        },
      ],
    });
    const events: RunEventEnvelope[] = [];
    const sessionStore = new FileSystemSessionStore({ workspaceRoot });
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      sessionStore,
      onEvent: (event) => events.push(event),
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
      expect(model.callCount).toBe(3);
      const boundaryIndex = events.findIndex(
        (event) => event.event.type === "provider.turn_stopped",
      );
      const candidateIndex = events.findIndex(
        (event) =>
          event.event.type === "agent.action" &&
          event.event.action.type === "final_answer",
      );
      expect(boundaryIndex).toBeGreaterThanOrEqual(0);
      expect(candidateIndex).toBeGreaterThan(boundaryIndex);
      expect(events[boundaryIndex]?.event).toEqual({
        type: "provider.turn_stopped",
        turn: 2,
        empty: false,
      });
      expect(
        sessionStore
          .loadRun("v2-provider-natural")
          ?.some((event) => event.event.type === "provider.turn_stopped"),
      ).toBeTrue();
      const candidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(
          loopV2LiveArtifactPath(workspaceRoot, "v2-provider-natural"),
          "utf8",
        ),
      );
      expect(candidate.report.state.currentCandidate?.source).toBe(
        "legacy_final_answer",
      );
      expect(candidate.report.controlState).toMatchObject({
        status: "candidate",
        turn: 2,
      });
      expect(candidate.report.controlState?.candidate).toBeDefined();
      const boundaryCheckpoint = parseLoopV2ProjectionCheckpointV1(
        fs.readFileSync(
          loopV2ProjectionCheckpointPath(workspaceRoot, "v2-provider-natural"),
          "utf8",
        ),
      );
      expect(boundaryCheckpoint.report.controlState).toMatchObject({
        status: "completed",
        turn: 2,
      });
      expect(boundaryCheckpoint.report.controlState?.candidate).toBeDefined();
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

  test("R11 repeated natural stops exhaust the run without creating a candidate", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-provider-boundary-loop-");
    const model = new FakeLanguageModel({
      responses: [
        { text: "I am still thinking.", finishReason: "stop" },
        { text: "I have not submitted a candidate.", finishReason: "stop" },
        { text: "Another ordinary response.", finishReason: "stop" },
      ],
    });
    const events: RunEventEnvelope[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      onEvent: (event) => events.push(event),
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-provider-boundary-loop",
        goal: "Return a status only after explicitly proposing completion.",
        workspaceRoot,
        maxSteps: 3,
      });

      expect(result.status).toBe("incomplete");
      expect(
        events.filter((event) => event.event.type === "model.request"),
      ).toHaveLength(3);
      expect(
        events.filter((event) => event.event.type === "provider.turn_stopped"),
      ).toHaveLength(3);
      expect(
        events.some(
          (event) =>
            event.event.type === "agent.action" &&
            event.event.action.type === "final_answer",
        ),
      ).toBeFalse();
      expect(
        fs.existsSync(
          loopV2LiveArtifactPath(workspaceRoot, "v2-provider-boundary-loop"),
        ),
      ).toBeFalse();
      const checkpoint = parseLoopV2ProjectionCheckpointV1(
        fs.readFileSync(
          loopV2ProjectionCheckpointPath(
            workspaceRoot,
            "v2-provider-boundary-loop",
          ),
          "utf8",
        ),
      );
      expect(checkpoint.report.controlState).toMatchObject({
        status: "running",
        turn: 3,
      });
      expect(checkpoint.report.controlState?.candidate).toBeUndefined();
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
    const requests: (readonly import("@paw/models").ChatMessage[])[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model,
      evalHooks: {
        beforeModelCall: ({ messages }) => requests.push(messages),
      },
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
        requests[2]?.filter((message) =>
          message.content.includes("[ProviderProtocol:empty_response]"),
        ),
      ).toHaveLength(1);
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

  test("protocol recovery survives a crash without entering durable transcript", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-provider-recovery-resume-");
    const runId = "v2-provider-recovery-resume";
    fs.writeFileSync(path.join(workspaceRoot, "note.txt"), "hello\n", "utf8");
    const appStateStore = new FileSystemAppStateStore({
      statesDir: path.join(workspaceRoot, ".paw", "states"),
    });
    const sessionStore = new FileSystemSessionStore({ workspaceRoot });
    const abort = new AbortController();
    const first = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      appStateStore,
      sessionStore,
      model: new FakeLanguageModel({
        responses: [
          {
            text: '{"tool":"workspace.read_file","args":{"path":"note.txt"}}',
            finishReason: "stop",
          },
          { text: "", finishReason: "stop" },
        ],
      }),
      onEvent(envelope) {
        if (
          envelope.event.type === "provider.turn_stopped" &&
          envelope.event.empty
        ) {
          abort.abort();
        }
      },
    });

    try {
      const interrupted = await first.run({
        runId,
        goal: "Read note.txt and report its content.",
        workspaceRoot,
        maxSteps: 6,
        abortSignal: abort.signal,
      });
      expect(interrupted.status).toBe("aborted");
      const saved = appStateStore.load(runId);
      expect(saved?.loopControl).toMatchObject({
        schemaVersion: "paw.loop-control.v1",
        providerTerminal: { pendingProtocolIssue: "empty_response" },
        pendingControl: { kind: "protocol_recovery" },
      });
      expect(
        saved?.messages.some((message) =>
          message.content.startsWith("[ProviderProtocol:empty_response]"),
        ),
      ).toBeFalse();

      const requests: (readonly import("@paw/models").ChatMessage[])[] = [];
      const resumed = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        appStateStore,
        sessionStore,
        model: new FakeLanguageModel({
          responses: [{ text: "", finishReason: "stop" }],
        }),
        evalHooks: {
          beforeModelCall: ({ messages }) => requests.push(messages),
        },
      });
      const result = await resumed.resumeRun({ runId, workspaceRoot });
      expect(result.status).toBe("incomplete");
      expect(result.message).toContain("recovery exhausted");
      expect(
        requests[0]?.filter((message) =>
          message.content.includes("[ProviderProtocol:empty_response]"),
        ),
      ).toHaveLength(1);
      expect(
        appStateStore
          .load(runId)
          ?.messages.some((message) =>
            message.content.startsWith("[ProviderProtocol:empty_response]"),
          ),
      ).toBeFalse();
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("provider failure preserves the pending control at the current cursor", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-provider-pending-failure-");
    const runId = "v2-provider-pending-failure";
    const appStateStore = new FileSystemAppStateStore({
      statesDir: path.join(workspaceRoot, ".paw", "states"),
    });
    const sessionStore = new FileSystemSessionStore({ workspaceRoot });
    appStateStore.save({
      runId,
      goal: "Recover the pending provider turn.",
      workspaceRoot,
      turn: 1,
      maxSteps: 3,
      messages: [
        { role: "user", content: "Recover the pending provider turn." },
      ],
      loopControl: {
        schemaVersion: "paw.loop-control.v1",
        providerTerminal: {
          runId,
          lastTurn: 1,
          pendingProtocolIssue: "empty_response",
        },
        pendingControl: {
          kind: "protocol_recovery",
          text: "[ProviderProtocol:empty_response] retry once",
        },
      },
      savedAt: Date.now(),
    });
    sessionStore.saveEvent(runId, {
      runId,
      seq: 1,
      ts: Date.now(),
      event: {
        type: "run.started",
        goal: "Recover the pending provider turn.",
      },
    });
    let failedCalls = 0;
    const failingModel: LanguageModel = {
      label: "pending-control-provider-failure",
      async complete() {
        failedCalls += 1;
        throw new Error("provider offline");
      },
    };

    try {
      const failing = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: failingModel,
        appStateStore,
        sessionStore,
      });
      const failed = await failing.resumeRun({ runId, workspaceRoot });
      expect(failed.status).toBe("failed");
      expect(failedCalls).toBe(1);
      expect(appStateStore.load(runId)).toMatchObject({
        turn: 1,
        loopControl: {
          providerTerminal: { lastTurn: 1 },
          pendingControl: { kind: "protocol_recovery" },
        },
      });

      let resumedCalls = 0;
      const resumed = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: {
          label: "pending-control-second-resume",
          async complete() {
            resumedCalls += 1;
            return { text: "", finishReason: "stop" };
          },
        },
        appStateStore,
        sessionStore,
      });
      const result = await resumed.resumeRun({ runId, workspaceRoot });
      expect(result.status).toBe("incomplete");
      expect(resumedCalls).toBe(1);
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
          reasonCode: "runtime_error",
        },
        comparison: "equal",
      });
    } finally {
      fs.rmSync(exhaustedWorkspace, { recursive: true, force: true });
      fs.rmSync(failedWorkspace, { recursive: true, force: true });
    }
  });

  test("resume rebuilds pre-candidate rich commits from the durable journal without a checkpoint", async () => {
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
      const durablePrefix = (sessionStore.loadRun(runId) ?? []).filter(
        (event) => event.seq <= checkpoint.report.sourceThroughSeq,
      );
      const replayed = replayLegacyTraceToLoopV2ShadowV1(runId, durablePrefix);
      expect(replayed.projectedEvents).toEqual(
        checkpoint.report.projectedEvents,
      );
      expect(replayed.stateHash).toBe(checkpoint.report.stateHash);
      expect(replayed.controlStateHash).toBe(
        checkpoint.report.controlStateHash,
      );
      expect(replayed.artifactBlobs).toEqual(checkpoint.report.artifactBlobs);
      expect(replayed.sourceThroughSeq).toBe(
        checkpoint.report.sourceThroughSeq,
      );
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
      fs.unlinkSync(loopV2ProjectionCheckpointPath(workspaceRoot, runId));
      const journalPath = path.join(
        workspaceRoot,
        ".paw",
        "sessions",
        `${runId}.jsonl`,
      );
      const validJournal = fs.readFileSync(journalPath, "utf8");
      const legacyJournal = validJournal
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const envelope = JSON.parse(line) as RunEventEnvelope;
          if (envelope.event.type !== "tool.result") return line;
          const { decisionCommit: _, ...legacyResult } = envelope.event;
          return JSON.stringify({ ...envelope, event: legacyResult });
        })
        .join("\n");
      fs.writeFileSync(journalPath, `${legacyJournal}\n`, "utf8");
      const rejectedLegacyResume = await new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: new FakeLanguageModel({ responses: [] }),
        appStateStore,
        sessionStore,
      }).resumeRun({ runId, workspaceRoot });
      expect(rejectedLegacyResume).toMatchObject({
        status: "failed",
        message: expect.stringContaining("lacks a decision commit"),
      });
      fs.writeFileSync(journalPath, validJournal, "utf8");
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
            {
              text: finalAnswer("The resumed change is verified."),
              finishReason: "stop",
            },
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

  test("resume accepts a durable native rejection disposition without a projection checkpoint", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-native-rejection-resume-");
    const runId = "v2-native-rejection-resume";
    const appStateStore = new FileSystemAppStateStore({
      statesDir: path.join(workspaceRoot, ".paw", "states"),
    });
    const sessionStore = new FileSystemSessionStore({ workspaceRoot });
    const abort = new AbortController();
    try {
      const interrupted = await new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        appStateStore,
        sessionStore,
        model: {
          label: "v2-native-rejection-fixture",
          runtimeProfile: {
            protocol: "openai-compatible",
            model: "deepseek-v4-flash",
            baseUrl: "https://example.test",
          },
          async complete() {
            return {
              text: "",
              nativeAssistantContent: "attempt malformed read",
              toolCalls: [
                {
                  id: "malformed-read",
                  name: "workspace_read_file",
                  arguments: {},
                  rawArguments: '{"path":',
                  argumentsValid: false,
                },
              ],
            };
          },
        },
        onEvent(envelope) {
          if (envelope.event.type === "tool.result") abort.abort();
        },
      }).run({
        runId,
        goal: "Recover from a malformed native call and report the result.",
        workspaceRoot,
        maxSteps: 4,
        abortSignal: abort.signal,
      });
      expect(interrupted.status).toBe("aborted");
      const rejection = (sessionStore.loadRunStrict(runId) ?? []).find(
        (event) => event.event.type === "tool.result",
      );
      expect(rejection?.event).toMatchObject({
        type: "tool.result",
        ok: false,
        decisionDisposition: {
          schemaVersion: "paw.tool-decision-disposition.v1",
          status: "not_executed",
        },
      });
      const projectionPath = loopV2ProjectionCheckpointPath(
        workspaceRoot,
        runId,
      );
      if (fs.existsSync(projectionPath)) fs.unlinkSync(projectionPath);

      let resumeCalls = 0;
      const resumed = await new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        appStateStore,
        sessionStore,
        model: {
          label: "v2-native-rejection-resume-fixture",
          async complete() {
            resumeCalls += 1;
            return {
              text: finalAnswer("Recovered without executing the call."),
            };
          },
        },
      }).resumeRun({ runId, workspaceRoot });
      expect(resumed.status).toBe("completed");
      expect(resumeCalls).toBe(1);
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
        {
          text: finalAnswer("Done without verification."),
          finishReason: "stop",
        },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
          finishReason: "stop",
        },
        {
          text: finalAnswer("Implemented and verified."),
          finishReason: "stop",
        },
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

  test("novel investigation evidence reopens readiness repair without allowing prose-only loops", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-readiness-investigate-");
    fs.writeFileSync(
      path.join(workspaceRoot, "source.txt"),
      "before\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "notes.txt"),
      "implementation clue\n",
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
          text: '{"tool":"workspace.read_file","args":{"path":"source.txt"}}',
          finishReason: "stop",
        },
        {
          text: "Let me inspect one more relevant file.",
          finishReason: "stop",
        },
        {
          text: '{"tool":"workspace.read_file","args":{"path":"notes.txt"}}',
          finishReason: "stop",
        },
        { text: "Now I will implement the fix.", finishReason: "stop" },
        {
          text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
          finishReason: "stop",
        },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
          finishReason: "stop",
        },
        {
          text: finalAnswer("Implemented and verified."),
          finishReason: "stop",
        },
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
        runId: "v2-readiness-investigate",
        goal: "[require_mutation] Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 10,
      });
      expect(result.status).toBe("completed");
      expect(model.callCount).toBe(7);
      expect(orchestrator.getLastLoopV2CandidateAssessment()).toMatchObject({
        facts: { evidence: 2, mutations: 1, verification: 1 },
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
        {
          text: finalAnswer("Implemented and verified."),
          finishReason: "stop",
        },
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
          reasonCode: "candidate_certified",
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
      const resultShadow = parseLoopV2RunResultShadowArtifactV1(
        fs.readFileSync(
          loopV2RunResultShadowArtifactPath(workspaceRoot, runId),
          "utf8",
        ),
        terminal,
        candidate,
        persistedReview,
      );
      expect(resultShadow).toMatchObject({
        legacyResult: result,
        eligibility: { eligible: true, reasons: [] },
        mappedResult: {
          status: "completed",
          outcome: "verified",
          completionReason: "candidate_certified",
          evidence: result.evidence,
        },
        comparison: {
          authorityFieldsEqual: true,
          evidencePreserved: true,
          cutoverReady: true,
        },
      });
      expect(resultShadow.mappedResult?.message).toContain("# Paw Run Report");
      expect(
        events.find((event) => event.event.type === "candidate.review")?.event,
      ).toMatchObject({
        type: "candidate.review",
        candidateId: candidate.assessment.candidateId,
        reviewKey: persistedReview.reviewKey,
        verdict: "pass",
        externalVerification: "not_configured",
        modelCalls: 1,
        usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
      });
      const controlCheckpoint = parseLoopV2ProjectionCheckpointV1(
        fs.readFileSync(
          loopV2ProjectionCheckpointPath(workspaceRoot, runId),
          "utf8",
        ),
      );
      expect(controlCheckpoint.report.controlState).toMatchObject({
        status: "completed",
        semanticReview: {
          candidateId: candidate.assessment.candidateId,
          reviewKey: persistedReview.reviewKey,
          verdict: "pass",
        },
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("explicit v2 reviews and probes a verified inspected revision before final_answer", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-stable-checkpoint-");
    const runId = "v2-stable-checkpoint";
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
    for (const args of [
      ["init"],
      ["config", "user.email", "paw@example.test"],
      ["config", "user.name", "Paw Test"],
      ["add", "."],
      ["commit", "-m", "baseline"],
    ]) {
      const command = Bun.spawnSync(["git", ...args], { cwd: workspaceRoot });
      if (command.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed`);
      }
    }
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
        {
          text: '{"tool":"workspace.git_diff","args":{}}',
          finishReason: "stop",
        },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
          finishReason: "stop",
        },
        {
          text: finalAnswer("Implemented and verified."),
          finishReason: "stop",
        },
      ],
    });
    let reviewCalls = 0;
    const reviewModel: LanguageModel = {
      label: "stable-review-fixture",
      async complete(messages) {
        reviewCalls += 1;
        expect(model.callCount).toBe(3);
        const material = messages.at(-1)?.content ?? "";
        const candidateInputHash = /"candidateInputHash":"([^"]+)"/.exec(
          material,
        )?.[1];
        const mutationRevision = Number(
          /"mutationRevision":(\d+)/.exec(material)?.[1],
        );
        if (!candidateInputHash || !Number.isSafeInteger(mutationRevision)) {
          throw new Error("stable reviewer did not receive candidate identity");
        }
        return {
          text: JSON.stringify({
            candidateInputHash,
            mutationRevision,
            verdict: "pass",
            findings: [],
          }),
          finishReason: "stop",
        };
      },
    };
    let probeCalls = 0;
    const probeModel: LanguageModel = {
      label: "stable-probe-fixture",
      async complete() {
        probeCalls += 1;
        expect(model.callCount).toBe(3);
        return { text: '{"probes":[]}', finishReason: "stop" };
      },
    };
    const events: RunEventEnvelope[] = [];
    const candidateArtifacts: LoopV2LiveCandidateArtifactV1[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      loopV2SemanticReviewModel: reviewModel,
      loopV2VerificationProbeModel: probeModel,
      verificationPolicy: { authority: "local", requireMutation: true },
      toolEffectPolicy: trustedNoEffectShellPolicy(),
      onEvent: (event) => events.push(event),
      onLoopV2CandidateAssessment() {
        candidateArtifacts.push(
          parseLoopV2LiveCandidateArtifactV1(
            fs.readFileSync(
              loopV2LiveArtifactPath(workspaceRoot, runId),
              "utf8",
            ),
          ),
        );
      },
    });

    try {
      const result = await orchestrator.run({
        runId,
        goal: "Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 8,
      });
      expect(result.status).toBe("completed");
      expect(reviewCalls).toBe(1);
      expect(probeCalls).toBe(1);
      expect(model.callCount).toBe(5);
      expect(
        events.filter((event) => event.event.type === "candidate.checkpoint"),
      ).toHaveLength(1);
      const reviews = events
        .filter((event) => event.event.type === "candidate.review")
        .map((event) => event.event);
      expect(reviews).toHaveLength(2);
      expect(reviews[0]).toMatchObject({
        type: "candidate.review",
        stage: "checkpoint",
        verdict: "pass",
        modelCalls: 1,
      });
      expect(reviews[1]).toMatchObject({
        type: "candidate.review",
        stage: "final_submission",
        verdict: "pass",
        modelCalls: 0,
      });
      if (
        reviews[0]?.type !== "candidate.review" ||
        reviews[1]?.type !== "candidate.review" ||
        !reviews[0].reviewKey
      ) {
        throw new Error("missing stable review events");
      }
      const checkpointReviewKey = reviews[0].reviewKey;
      expect(reviews[1].reviewKey).not.toBe(reviews[0].reviewKey);
      const probes = events
        .filter((event) => event.event.type === "candidate.probe")
        .map((event) => event.event);
      expect(probes).toHaveLength(2);
      expect(probes[0]).toMatchObject({
        type: "candidate.probe",
        stage: "checkpoint",
        verdict: "pass",
        modelCalls: 1,
      });
      expect(probes[1]).toMatchObject({
        type: "candidate.probe",
        stage: "final_submission",
        verdict: "pass",
        modelCalls: 0,
      });
      expect(
        events.findIndex(
          (event) =>
            event.event.type === "candidate.review" &&
            event.event.stage === "checkpoint",
        ),
      ).toBeLessThan(
        events.findIndex(
          (event) =>
            event.event.type === "agent.action" &&
            event.event.action.type === "final_answer",
        ),
      );
      const candidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(loopV2LiveArtifactPath(workspaceRoot, runId), "utf8"),
      );
      const review = parseLoopV2LiveReviewArtifactV1(
        fs.readFileSync(
          loopV2LiveReviewArtifactPath(workspaceRoot, runId),
          "utf8",
        ),
        candidate,
      );
      expect(review.reuse).toEqual({
        fromReviewKey: checkpointReviewKey,
        semanticSubjectHash: expect.any(String),
      });
      const terminal = parseLoopV2LiveTerminalArtifactV1(
        fs.readFileSync(
          loopV2LiveTerminalArtifactPath(workspaceRoot, runId),
          "utf8",
        ),
        candidate,
        review,
      );
      expect(terminal.v2Outcome).toMatchObject({
        candidateStatus: "certified",
        localVerification: "passed",
        reasonCode: "candidate_certified",
      });
      expect(
        assessLoopV2AuthorityEligibilityV1(terminal, candidate, review),
      ).toEqual({ eligible: true, reasons: [] });

      // Claim-only migration uses the same write ordering: a future
      // interrupted record is durable before the candidate commit. Exercise
      // both sides of that commit without another reviewer invocation.
      expect(candidateArtifacts).toHaveLength(2);
      const checkpointCandidate = candidateArtifacts[0];
      const finalCandidate = candidateArtifacts[1];
      if (!checkpointCandidate || !finalCandidate) {
        throw new Error("missing checkpoint candidate artifacts");
      }
      const candidatePath = loopV2LiveArtifactPath(workspaceRoot, runId);
      const claimPath = loopV2LiveReviewClaimPath(workspaceRoot, runId);
      const reviewPath = loopV2LiveReviewArtifactPath(workspaceRoot, runId);
      const resetClaimOnly = () => {
        fs.writeFileSync(
          candidatePath,
          serializeLoopV2LiveCandidateArtifactV1(checkpointCandidate),
        );
        fs.writeFileSync(
          claimPath,
          serializeLoopV2LiveReviewClaimV1(
            buildLoopV2LiveReviewClaimV1(checkpointCandidate),
            checkpointCandidate,
          ),
        );
        fs.rmSync(reviewPath, { force: true });
      };
      let claimOnlyModelCalls = 0;
      const createClaimOnlyRuntime = () =>
        new LoopV2LiveReviewRuntimeV1({
          workspaceRoot,
          runId,
          model: {
            label: "must-not-repeat-claim-only-review",
            async complete() {
              claimOnlyModelCalls += 1;
              return { text: "{}" };
            },
          },
        });
      resetClaimOnly();
      const beforeCommit = createClaimOnlyRuntime();
      beforeCommit.restoreCandidate(checkpointCandidate);
      type CandidateCommit = (
        artifactPath: string,
        artifact: LoopV2LiveCandidateArtifactV1,
      ) => void;
      const prototype = LoopV2LiveReviewRuntimeV1.prototype as unknown as {
        commitCandidateArtifact: CandidateCommit;
      };
      const originalCommit = prototype.commitCandidateArtifact;
      prototype.commitCandidateArtifact = () => {
        throw new Error("injected claim-only candidate commit crash");
      };
      try {
        expect(() => beforeCommit.persistCandidate(finalCandidate)).toThrow(
          "injected claim-only candidate commit crash",
        );
      } finally {
        prototype.commitCandidateArtifact = originalCommit;
      }
      const oldSide = createClaimOnlyRuntime();
      oldSide.restoreCandidate(checkpointCandidate);
      expect(await oldSide.reviewCandidate()).toMatchObject({
        modelCalls: 0,
        reasonCode: "reviewer_interrupted",
      });

      resetClaimOnly();
      const afterCommit = createClaimOnlyRuntime();
      afterCommit.restoreCandidate(checkpointCandidate);
      afterCommit.persistCandidate(finalCandidate);
      const newSide = createClaimOnlyRuntime();
      newSide.restoreCandidate(finalCandidate);
      expect(await newSide.reviewCandidate()).toMatchObject({
        modelCalls: 0,
        reasonCode: "reviewer_interrupted",
      });
      expect(claimOnlyModelCalls).toBe(0);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("candidate commit crash keeps the old guard claim and never repeats semantic review", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-stable-commit-crash-");
    const runId = "v2-stable-commit-crash";
    fs.writeFileSync(path.join(workspaceRoot, "source.txt"), "before\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "smoke-test.js"),
      "process.exit(0);\n",
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "paw@example.test"],
      ["config", "user.name", "Paw Test"],
      ["add", "."],
      ["commit", "-m", "baseline"],
    ]) {
      const command = Bun.spawnSync(["git", ...args], { cwd: workspaceRoot });
      if (command.exitCode !== 0) throw new Error("git fixture setup failed");
    }
    const implementationModel = new FakeLanguageModel({
      responses: [
        {
          text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
        },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
        },
        { text: '{"tool":"workspace.git_diff","args":{}}' },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
        },
        { text: finalAnswer("Commit the reviewed candidate.") },
      ],
    });
    let reviewCalls = 0;
    const reviewModel: LanguageModel = {
      label: "stable-commit-crash-review",
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
            verdict: "pass",
            findings: [],
          }),
        };
      },
    };
    type CandidateCommit = (
      artifactPath: string,
      artifact: LoopV2LiveCandidateArtifactV1,
    ) => void;
    const prototype = LoopV2LiveReviewRuntimeV1.prototype as unknown as {
      commitCandidateArtifact: CandidateCommit;
    };
    const originalCommit = prototype.commitCandidateArtifact;
    let commits = 0;
    prototype.commitCandidateArtifact = function crashSecondCommit(
      artifactPath,
      artifact,
    ) {
      commits += 1;
      if (commits === 2) throw new Error("injected candidate commit crash");
      return originalCommit.call(this, artifactPath, artifact);
    };
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model: implementationModel,
      loopV2SemanticReviewModel: reviewModel,
      verificationPolicy: { authority: "local", requireMutation: true },
      toolEffectPolicy: trustedNoEffectShellPolicy(),
    });
    try {
      const result = await orchestrator.run({
        runId,
        goal: "Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 8,
      });
      expect(result.status).toBe("failed");
      expect(result.message).toContain("injected candidate commit crash");
      expect(reviewCalls).toBe(1);
      const oldCandidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(loopV2LiveArtifactPath(workspaceRoot, runId), "utf8"),
      );
      let repeatedCalls = 0;
      const recovery = new LoopV2LiveReviewRuntimeV1({
        workspaceRoot,
        runId,
        model: {
          label: "must-not-repeat-after-commit-crash",
          async complete() {
            repeatedCalls += 1;
            return { text: "{}" };
          },
        },
      });
      recovery.restoreCandidate(oldCandidate);
      const recovered = await recovery.reviewCandidate();
      expect(recovered).toMatchObject({
        modelCalls: 0,
        reasonCode: "reviewer_interrupted",
        review: { verdict: "partial" },
      });
      expect(repeatedCalls).toBe(0);
    } finally {
      prototype.commitCandidateArtifact = originalCommit;
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("a blocking stable semantic review feeds back without running the probe or terminal reducer", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-stable-block-");
    const runId = "v2-stable-block";
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
    for (const args of [
      ["init"],
      ["config", "user.email", "paw@example.test"],
      ["config", "user.name", "Paw Test"],
      ["add", "."],
      ["commit", "-m", "baseline"],
    ]) {
      const command = Bun.spawnSync(["git", ...args], { cwd: workspaceRoot });
      if (command.exitCode !== 0) throw new Error("git fixture setup failed");
    }
    let implementationCalls = 0;
    let sawCheckpointFeedback = false;
    let sawInspectedPatch = false;
    const implementationModel: LanguageModel = {
      label: "stable-block-implementation",
      async complete(messages) {
        implementationCalls += 1;
        if (implementationCalls === 1)
          return {
            text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
          };
        if (implementationCalls === 2)
          return {
            text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
          };
        if (implementationCalls === 3)
          return {
            text: '{"tool":"workspace.run_shell","args":{"command":"git status --short && echo ==== && git --no-pager diff HEAD"}}',
          };
        sawInspectedPatch = messages.some(
          (message) =>
            message.content.includes("diff --git a/source.txt b/source.txt") &&
            message.content.includes("-before") &&
            message.content.includes("+after"),
        );
        sawCheckpointFeedback = messages.some((message) =>
          message.content.includes("LoopV2SemanticReview:fail"),
        );
        return { text: '{"action":"abort","reason":"fixture complete"}' };
      },
    };
    let reviewCalls = 0;
    const reviewModel: LanguageModel = {
      label: "stable-block-review",
      async complete(messages) {
        reviewCalls += 1;
        const material = JSON.parse(
          messages.at(-1)?.content.split("\n\n").at(-1) ?? "{}",
        ) as { candidateInputHash: string; mutationRevision: number };
        return {
          text: JSON.stringify({
            candidateInputHash: material.candidateInputHash,
            mutationRevision: material.mutationRevision,
            verdict: "fail",
            findings: [
              {
                severity: "blocking",
                criterionId: HOST_TASK_GOAL_REVIEW_CRITERION_ID,
                file: "source.txt",
                observedChange:
                  "The terminal value does not satisfy the complete task goal.",
                risk: "The requested observable behavior remains incomplete.",
                evidenceRefs: ["snapshot:source.txt"],
              },
            ],
          }),
        };
      },
    };
    let probeCalls = 0;
    const probeModel: LanguageModel = {
      label: "stable-block-probe",
      async complete() {
        probeCalls += 1;
        return { text: '{"probes":[]}' };
      },
    };
    const events: RunEventEnvelope[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model: implementationModel,
      loopV2SemanticReviewModel: reviewModel,
      loopV2VerificationProbeModel: probeModel,
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
      expect(result.status).toBe("failed");
      expect(result.completionReason).toBe("model_abort");
      expect(reviewCalls).toBe(1);
      expect(probeCalls).toBe(0);
      expect(sawInspectedPatch).toBe(true);
      expect(sawCheckpointFeedback).toBe(true);
      expect(
        events.filter((event) => event.event.type === "candidate.checkpoint"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.event.type === "candidate.review"),
      ).toEqual([
        expect.objectContaining({
          event: expect.objectContaining({
            stage: "checkpoint",
            verdict: "fail",
            modelCalls: 1,
          }),
        }),
      ]);
      expect(
        events.some((event) => event.event.type === "candidate.readiness"),
      ).toBe(false);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("a later failing verification replaces checkpoint readiness without repeating review", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-stable-late-failure-");
    const runId = "v2-stable-late-failure";
    fs.writeFileSync(
      path.join(workspaceRoot, "source.txt"),
      "before\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "pass-test.js"),
      "process.exit(0);\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "fail-test.js"),
      "process.exit(1);\n",
      "utf8",
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "paw@example.test"],
      ["config", "user.name", "Paw Test"],
      ["add", "."],
      ["commit", "-m", "baseline"],
    ]) {
      const command = Bun.spawnSync(["git", ...args], { cwd: workspaceRoot });
      if (command.exitCode !== 0) throw new Error("git fixture setup failed");
    }
    const implementationModel = new FakeLanguageModel({
      responses: [
        {
          text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
        },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node pass-test.js"}}',
        },
        { text: '{"tool":"workspace.git_diff","args":{}}' },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node fail-test.js"}}',
        },
        { text: finalAnswer("The candidate is ready.") },
        { text: '{"action":"abort","reason":"fixture complete"}' },
      ],
    });
    let reviewCalls = 0;
    const reviewModel: LanguageModel = {
      label: "stable-late-failure-review",
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
          throw new Error("review identity missing");
        }
        return {
          text: JSON.stringify({
            candidateInputHash,
            mutationRevision,
            verdict: "pass",
            findings: [],
          }),
        };
      },
    };
    let probeCalls = 0;
    const probeModel: LanguageModel = {
      label: "stable-late-failure-probe",
      async complete() {
        probeCalls += 1;
        return { text: '{"probes":[]}' };
      },
    };
    const events: RunEventEnvelope[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model: implementationModel,
      loopV2SemanticReviewModel: reviewModel,
      loopV2VerificationProbeModel: probeModel,
      verificationPolicy: { authority: "local", requireMutation: true },
      toolEffectPolicy: trustedNoEffectShellPolicy(),
      onEvent: (event) => events.push(event),
    });
    try {
      const result = await orchestrator.run({
        runId,
        goal: "Change source.txt and reject it if broader verification fails.",
        workspaceRoot,
        maxSteps: 8,
      });
      expect(result.status).toBe("failed");
      expect(result.completionReason).toBe("model_abort");
      expect(reviewCalls).toBe(1);
      expect(probeCalls).toBe(1);
      expect(
        events.filter((event) => event.event.type === "candidate.review"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.event.type === "candidate.probe"),
      ).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.event.type === "candidate.readiness" &&
            event.event.result.kind === "repair_required",
        ),
      ).toBe(true);
      const candidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(loopV2LiveArtifactPath(workspaceRoot, runId), "utf8"),
      );
      expect(candidate.assessment.readiness).toMatchObject({
        readyForSemanticReview: false,
        localVerification: "code_failed",
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("a pending failing-test control defers the stable checkpoint", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-stable-not-ready-");
    const runId = "v2-stable-not-ready";
    fs.writeFileSync(path.join(workspaceRoot, "source.txt"), "before\n");
    fs.writeFileSync(
      path.join(workspaceRoot, "fail-test.js"),
      "process.exit(1);\n",
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "paw@example.test"],
      ["config", "user.name", "Paw Test"],
      ["add", "."],
      ["commit", "-m", "baseline"],
    ]) {
      const command = Bun.spawnSync(["git", ...args], { cwd: workspaceRoot });
      if (command.exitCode !== 0) throw new Error("git fixture setup failed");
    }
    const model = new FakeLanguageModel({
      responses: [
        {
          text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
        },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node fail-test.js"}}',
        },
        { text: '{"tool":"workspace.git_diff","args":{}}' },
        { text: '{"tool":"workspace.read_file","args":{"path":"source.txt"}}' },
        { text: '{"action":"abort","reason":"fixture complete"}' },
      ],
    });
    let reviewCalls = 0;
    const events: RunEventEnvelope[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      loopV2SemanticReviewModel: {
        label: "must-not-review-not-ready",
        async complete() {
          reviewCalls += 1;
          return { text: "{}" };
        },
      },
      verificationPolicy: { authority: "local", requireMutation: true },
      toolEffectPolicy: trustedNoEffectShellPolicy(),
      onEvent: (event) => events.push(event),
    });
    try {
      const result = await orchestrator.run({
        runId,
        goal: "Change source.txt only if verification passes.",
        workspaceRoot,
        maxSteps: 7,
      });
      expect(result.status).toBe("failed");
      expect(reviewCalls).toBe(0);
      expect(
        events.filter((event) => event.event.type === "candidate.checkpoint"),
      ).toHaveLength(0);
      expect(
        events.filter((event) => event.event.type === "candidate.review"),
      ).toHaveLength(0);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("v2 readiness does not run the old verification gate again", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-no-double-verification-");
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
          text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js | more"}}',
          finishReason: "stop",
        },
        {
          text: finalAnswer("Ready for the trusted external verifier."),
          finishReason: "stop",
        },
      ],
    });
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      verificationPolicy: { authority: "external", requireMutation: true },
      toolEffectPolicy: trustedNoEffectShellPolicy(),
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-no-double-verification",
        goal: "Change source.txt; final acceptance belongs to the external verifier.",
        workspaceRoot,
        maxSteps: 5,
      });

      expect(result).toMatchObject({
        status: "completed",
        outcome: "model_declared",
        completionReason: "external_verification_pending",
      });
      expect(model.callCount).toBe(3);
      expect(orchestrator.getLastLoopV2CandidateAssessment()).toMatchObject({
        readiness: {
          disposition: "ready_for_review",
          readyForSemanticReview: true,
          localVerification: "harness_failed",
          gaps: [],
        },
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("external base-checkout code failure still reaches one semantic review", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-external-code-failed-");
    fs.writeFileSync(
      path.join(workspaceRoot, "source.txt"),
      "before\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceRoot, "smoke-test.js"),
      "process.exit(1);\n",
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
        {
          text: finalAnswer(
            "The local base assertion remains failed; external verification is required.",
          ),
          finishReason: "stop",
        },
      ],
    });
    let reviewCalls = 0;
    let reviewMaterial = "";
    let probeCalls = 0;
    const reviewModel: LanguageModel = {
      label: "external-code-failed-review",
      async complete(messages) {
        reviewCalls += 1;
        const material = messages.at(-1)?.content ?? "";
        reviewMaterial = material;
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
          finishReason: "stop",
        };
      },
    };
    const events: RunEventEnvelope[] = [];
    const probeModel: LanguageModel = {
      label: "external-code-failed-probe",
      async complete() {
        probeCalls += 1;
        return { text: '{"probes":[]}', finishReason: "stop" };
      },
    };
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      loopV2SemanticReviewModel: reviewModel,
      loopV2VerificationProbeModel: probeModel,
      verificationPolicy: { authority: "external", requireMutation: true },
      toolEffectPolicy: trustedNoEffectShellPolicy(),
      onEvent: (event) => events.push(event),
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-external-code-failed",
        goal: "Change source.txt; official acceptance belongs to the external verifier.",
        workspaceRoot,
        maxSteps: 5,
      });

      expect(result).toMatchObject({
        status: "completed",
        outcome: "model_declared",
        completionReason: "external_verification_pending",
      });
      expect(reviewCalls).toBe(1);
      expect(probeCalls).toBe(1);
      expect(reviewMaterial).toContain('"authority":"external"');
      expect(reviewMaterial).toContain(
        '"localEvidenceRole":"diagnostic_not_acceptance"',
      );
      expect(reviewMaterial).toContain('"externalVerification":"pending"');
      expect(reviewMaterial).toContain('"outcome":"code_failed"');
      expect(orchestrator.getLastLoopV2CandidateAssessment()).toMatchObject({
        readiness: {
          disposition: "ready_for_review",
          readyForSemanticReview: true,
          localVerification: "code_failed",
          gaps: [],
        },
      });
      expect(
        events.find((event) => event.event.type === "candidate.review")?.event,
      ).toMatchObject({
        type: "candidate.review",
        verdict: "pass",
        externalVerification: "pending",
        modelCalls: 1,
      });
      expect(
        events.find((event) => event.event.type === "candidate.probe")?.event,
      ).toMatchObject({
        type: "candidate.probe",
        verdict: "pass",
        modelCalls: 1,
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
          {
            text: finalAnswer("First proposed report."),
            finishReason: "stop",
          },
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
            {
              text: finalAnswer("Reworded report, no fact change."),
              finishReason: "stop",
            },
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
      expect(result.message).toContain("LoopControl:repair_required");
      expect(reviewCalls).toBe(1);
      const resumedCandidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(loopV2LiveArtifactPath(workspaceRoot, runId), "utf8"),
      );
      expect(resumedCandidate.artifactHash).toBe(firstCandidate.artifactHash);
      expect(
        resumedEvents.find((event) => event.event.type === "candidate.review")
          ?.event,
      ).toBeUndefined();
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
          {
            text: finalAnswer("Candidate before reviewer dispatch."),
            finishReason: "stop",
          },
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
            {
              text: finalAnswer("Resume the same candidate."),
              finishReason: "stop",
            },
            {
              text: finalAnswer("Still the same candidate."),
              finishReason: "stop",
            },
          ],
        }),
        loopV2SemanticReviewModel: reviewModel,
        appStateStore,
        sessionStore,
        toolEffectPolicy: trustedNoEffectShellPolicy(),
      });
      const result = await resumed.resumeRun({ runId, workspaceRoot });
      expect(result.status).toBe("incomplete");
      expect(result.message).toContain("LoopControl:repair_required");
      expect(reviewCalls).toBe(0);
      const resumedCandidate = parseLoopV2LiveCandidateArtifactV1(
        fs.readFileSync(loopV2LiveArtifactPath(workspaceRoot, runId), "utf8"),
      );
      const interruptedReview = parseLoopV2LiveReviewArtifactV1(
        fs.readFileSync(
          loopV2LiveReviewArtifactPath(workspaceRoot, runId),
          "utf8",
        ),
        resumedCandidate,
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

  test("v2 readiness opens a durable obligation that rejects repeated final answers", async () => {
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
        {
          text: finalAnswer("Done without verification."),
          finishReason: "stop",
        },
        { text: "I will verify it next.", finishReason: "stop" },
        {
          text: '{"tool":"workspace.read_file","args":{"path":"source.txt"}}',
          finishReason: "stop",
        },
        {
          text: finalAnswer("Still done without new evidence."),
          finishReason: "stop",
        },
      ],
    });
    let reviewerCalls = 0;
    const events: RunEventEnvelope[] = [];
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
      onEvent: (event) => events.push(event),
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-readiness-bounded",
        goal: "Change source.txt from before to after and verify it.",
        workspaceRoot,
        maxSteps: 5,
      });
      expect(result.status).toBe("incomplete");
      expect(result.message).toContain("LoopControl:repair_required");
      expect(result.message).toContain("direct authoritative verification");
      expect(result.message).toContain("another final_answer do not satisfy");
      expect(model.callCount).toBe(5);
      expect(reviewerCalls).toBe(0);
      expect(
        events.filter((event) => event.event.type === "candidate.readiness"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.event.type === "provider.turn_stopped"),
      ).toHaveLength(1);
      const checkpoint = parseLoopV2ProjectionCheckpointV1(
        fs.readFileSync(
          loopV2ProjectionCheckpointPath(workspaceRoot, "v2-readiness-bounded"),
          "utf8",
        ),
      );
      expect(
        checkpoint.report.controlState?.openRepairObligation,
      ).toMatchObject({
        kind: "direct_verification",
        revision: 1,
        runnerFamily: "any",
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("a material-change obligation survives reads and clears only after a committed mutation", async () => {
    const workspaceRoot = tempWorkspace("paw-v2-material-repair-");
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
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        {
          text: finalAnswer("Done without making the required change."),
          finishReason: "stop",
        },
        {
          text: '{"tool":"workspace.read_file","args":{"path":"source.txt"}}',
          finishReason: "stop",
        },
        {
          text: '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"before","new_string":"after"}}',
          finishReason: "stop",
        },
        {
          text: '{"tool":"workspace.run_shell","args":{"command":"node smoke-test.js"}}',
          finishReason: "stop",
        },
        {
          text: finalAnswer("Implemented and verified."),
          finishReason: "stop",
        },
      ],
    });
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model,
      toolEffectPolicy: trustedNoEffectShellPolicy(),
      onEvent: (event) => events.push(event),
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-material-repair",
        goal: "[require_mutation] Change source.txt and verify it.",
        workspaceRoot,
        maxSteps: 7,
      });

      expect(result.status).toBe("completed");
      expect(model.callCount).toBe(5);
      const readinessFacts = events.filter(
        (event) => event.event.type === "candidate.readiness",
      );
      expect(readinessFacts).toHaveLength(2);
      expect(readinessFacts[0]?.event).toMatchObject({
        type: "candidate.readiness",
        result: {
          kind: "repair_required",
          requirement: { kind: "material_change", afterRevision: 0 },
        },
      });
      expect(readinessFacts[1]?.event).toMatchObject({
        type: "candidate.readiness",
        result: { kind: "ready" },
      });
      const checkpoint = parseLoopV2ProjectionCheckpointV1(
        fs.readFileSync(
          loopV2ProjectionCheckpointPath(workspaceRoot, "v2-material-repair"),
          "utf8",
        ),
      );
      expect(checkpoint.report.controlState).toMatchObject({
        status: "completed",
        mutationRevision: 1,
      });
      expect(
        checkpoint.report.controlState?.openRepairObligation,
      ).toBeUndefined();
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("resume preserves the durable repair obligation identity", async () => {
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
        {
          text: finalAnswer("Done without verification."),
          finishReason: "stop",
        },
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
        maxSteps: 3,
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
      ).toBeFalse();
      expect(saved?.loopControl).toMatchObject({
        schemaVersion: "paw.loop-control.v1",
        readiness: { nudges: 1 },
        pendingControl: { kind: "readiness" },
      });
      const beforeResume = parseLoopV2ProjectionCheckpointV1(
        fs.readFileSync(
          loopV2ProjectionCheckpointPath(workspaceRoot, runId),
          "utf8",
        ),
      ).report.controlState?.openRepairObligation;
      expect(beforeResume?.kind).toBe("direct_verification");
      expect(
        sessionStore
          .loadRun(runId)
          ?.some((event) => event.event.type === "candidate.readiness"),
      ).toBeTrue();

      const resumedModel = new FakeLanguageModel({
        responses: [
          {
            text: finalAnswer("Still done without new evidence."),
            finishReason: "stop",
          },
        ],
      });
      const resumedRequests: (readonly import("@paw/models").ChatMessage[])[] =
        [];
      const resumed = new AgentOrchestrator({
        loopKernelVersion: "v2",
        memoryExtraction: "off",
        memoryLlm: "off",
        model: resumedModel,
        appStateStore,
        sessionStore,
        evalHooks: {
          beforeModelCall: ({ messages }) => resumedRequests.push(messages),
        },
      });
      const result = await resumed.resumeRun({ runId, workspaceRoot });
      expect(result.status).toBe("incomplete");
      expect(result.message).toContain("LoopControl:repair_required");
      expect(resumedModel.callCount).toBe(1);
      expect(
        resumedRequests[0]?.filter((message) =>
          message.content.includes("[LoopV2Readiness:needs_work"),
        ),
      ).toHaveLength(1);
      expect(
        appStateStore
          .load(runId)
          ?.messages.some((message) =>
            message.content.startsWith("[LoopV2Readiness:needs_work"),
          ),
      ).toBeFalse();
      const afterResume = parseLoopV2ProjectionCheckpointV1(
        fs.readFileSync(
          loopV2ProjectionCheckpointPath(workspaceRoot, runId),
          "utf8",
        ),
      ).report.controlState?.openRepairObligation;
      expect(afterResume).toEqual(beforeResume);
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
          text: finalAnswer(
            "The truncated request was discarded; no change was applied.",
          ),
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

  test("live candidate identity ignores explicit final-answer wording", async () => {
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
            return { text: finalAnswer(terminalText), finishReason: "stop" };
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
      const first = await runTrajectory("First explicit wording.");
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
      const second = await runTrajectory("Different explicit wording.");

      expect(first.candidateInputHash).toBe(second.candidateInputHash);
      expect(first.artifact.patchHash).toBe(second.artifact.patchHash);
      expect(first.readiness).toMatchObject({
        disposition: "ready_for_review",
        readyForSemanticReview: true,
        localVerification: "passed",
        gaps: [],
      });
      expect(second.readiness).toEqual(first.readiness);
      expect(first.facts).toEqual({
        evidence: 1,
        mutations: 1,
        verification: 1,
      });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
