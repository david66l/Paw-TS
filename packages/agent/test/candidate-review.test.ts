import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CostTracker, type RunEventEnvelope } from "@paw/core";
import type { SubAgentLauncher, SubAgentResult } from "@paw/harness";
import { FakeLanguageModel } from "@paw/models";
import {
  type CandidateReviewInput,
  type CandidateReviewer,
  ModelCandidateReviewer,
  SubAgentCandidateReviewer,
  candidateReviewInput,
  extractCandidateDeliberation,
  parseCandidateReview,
} from "../src/candidate-review.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { DefaultSubAgentLauncher } from "../src/sub-agent-launcher.js";
import { TaskStateManager } from "../src/task-state.js";

describe("candidate solution review", () => {
  test("parses only an explicit terminal verdict and defaults malformed output to partial", () => {
    expect(
      parseCandidateReview(
        "Missing exception detail.\nREPORT_GROUNDING: PASS\nVERDICT: FAIL",
      ),
    ).toMatchObject({
      verdict: "fail",
      reportGrounding: "pass",
      summary: "Missing exception detail.",
    });
    expect(parseCandidateReview("Looks fine")).toMatchObject({
      verdict: "partial",
      reportGrounding: "unknown",
    });
    expect(
      parseCandidateReview(
        "REPORT_GROUNDING: FAIL\nVERDICT: FAIL\nFixed after inspection.\nREPORT_GROUNDING: PASS\nVERDICT: PASS",
      ).verdict,
    ).toBe("pass");
  });

  test("selects risk-bearing deliberation instead of blindly taking the last messages", () => {
    const excerpts = extractCandidateDeliberation([
      {
        role: "assistant",
        content:
          "The strictly safer option is to preserve the exception position and original message.",
      },
      { role: "assistant", content: "Reading another file now." },
      { role: "assistant", content: "I will finish." },
    ]);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toContain("preserve the exception position");
  });

  test("builds reviewer evidence from host test results across mutation revisions", () => {
    const state = new TaskStateManager("fix the behavior");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "python -m pytest tests/test_value.py -q" },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: { exit_code: 1, stdout: "1 failed in 0.10s" },
      },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.write_file",
        args: { path: "value.py" },
      },
      {
        ok: true,
        summary: "wrote value.py",
        payload: { path: "value.py", changed: true },
      },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "python -m pytest tests/test_value.py -q" },
      },
      {
        ok: true,
        summary: "run_shell: exit 0",
        payload: { exit_code: 0, stdout: "1 passed in 0.09s" },
      },
    );

    const input = candidateReviewInput(
      "evidence-map",
      process.cwd(),
      "The test now passes.",
      state.snapshot(),
    );
    expect(input.verificationEvidence).toEqual([
      expect.objectContaining({
        mutationRevision: 0,
        outcome: "code_failed",
        evidence: "1 failed in 0.10s",
      }),
      expect.objectContaining({
        mutationRevision: 1,
        outcome: "passed",
        evidence: "1 passed in 0.09s",
      }),
    ]);
  });

  test("bounded model reviewer uses a fresh two-message context and records usage", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-candidate-model-"));
    writeFileSync(
      path.join(dir, "parser.py"),
      'message = f"Invalid regular expression: {value}"\n',
      "utf8",
    );
    const costTracker = new CostTracker();
    let receivedMessages = 0;
    const reviewer = new ModelCandidateReviewer({
      model: {
        label: "bounded-reviewer",
        async complete(messages) {
          receivedMessages = messages.length;
          expect(messages[1]?.content).toContain("Information preservation");
          expect(messages[1]?.content).toContain(
            "Canonical representation and precision",
          );
          expect(messages[1]?.content).toContain(
            '"Parseable" or "looks standard" is not sufficient',
          );
          expect(messages[1]?.content).toContain("strictly safer behavior");
          expect(messages[1]?.content).toContain(
            'message = f"Invalid regular expression: {value}"',
          );
          expect(messages[1]?.content).toContain(
            "Host-recorded verification ledger",
          );
          expect(messages[1]?.content).toContain("Return plain text only");
          return {
            text: "The generic message loses required error detail.\nREPORT_GROUNDING: PASS\nVERDICT: FAIL",
            usage: { promptTokens: 500, completionTokens: 50 },
          };
        },
      },
      costTracker,
    });

    const result = await reviewer.review({
      runId: "bounded-review",
      workspaceRoot: dir,
      goal: "Preserve actionable error diagnostics.",
      proposedSummary: "Added a generic error.",
      mutationRevision: 1,
      filesChanged: ["parser.py"],
      acceptanceCriteria: [],
      verificationEvidence: [],
      deliberation: ["I considered strictly safer behavior with full detail."],
    });

    expect(result.verdict).toBe("fail");
    expect(result.modelCalls).toBe(1);
    expect(result.usage?.totalTokens).toBe(550);
    expect(receivedMessages).toBe(2);
    expect(costTracker.snapshot().totalTokens).toBe(550);
  });

  test("does not accept a pass when neither diff nor current files are available", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-candidate-no-evidence-"));
    const reviewer = new ModelCandidateReviewer({
      model: {
        label: "unsupported-pass-reviewer",
        async complete() {
          return {
            text: "Everything is correct.\nREPORT_GROUNDING: PASS\nVERDICT: PASS",
          };
        },
      },
    });

    const result = await reviewer.review({
      runId: "no-evidence",
      workspaceRoot: dir,
      goal: "Implement the requested behavior.",
      proposedSummary: "Done.",
      mutationRevision: 1,
      filesChanged: ["missing.ts"],
      acceptanceCriteria: [],
      verificationEvidence: [],
      deliberation: [],
    });

    expect(result.verdict).toBe("partial");
    expect(result.summary).toContain("PASS is not supportable");
  });

  test("bounded model reviewer recovers one tool-shaped response without opening a loop", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-candidate-recover-"));
    let calls = 0;
    const reviewer = new ModelCandidateReviewer({
      model: {
        label: "review-protocol-recovery",
        async complete(messages) {
          calls += 1;
          if (calls === 1) return { text: '<tool_call name="read_file" />' };
          expect(messages.at(-1)?.content).toContain("tools are unavailable");
          return {
            text: "The candidate omits actionable exception detail.\nREPORT_GROUNDING: PASS\nVERDICT: FAIL",
          };
        },
      },
    });

    const result = await reviewer.review({
      runId: "review-recovery",
      workspaceRoot: dir,
      goal: "Keep error detail.",
      proposedSummary: "Added an error.",
      mutationRevision: 1,
      filesChanged: ["parser.py"],
      acceptanceCriteria: [],
      verificationEvidence: [],
      deliberation: [],
    });

    expect(result.verdict).toBe("fail");
    expect(result.modelCalls).toBe(2);
    expect(calls).toBe(2);
  });

  test("sub-agent reviewer receives original semantics and is forced read-only", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-candidate-prompt-"));
    let capturedGoal = "";
    let capturedArgs: Record<string, unknown> | undefined;
    const launcher = {
      async launch(goal, _maxSteps, options) {
        capturedGoal = goal;
        capturedArgs = options?.args;
        return {
          status: "completed",
          summary:
            "The candidate drops the regex error position and engine message.\nREPORT_GROUNDING: PASS\nVERDICT: FAIL",
        } satisfies SubAgentResult;
      },
      async launchStreaming() {
        throw new Error("not used");
      },
    } satisfies SubAgentLauncher;
    const reviewer = new SubAgentCandidateReviewer({ launcher });

    const result = await reviewer.review({
      runId: "prompt-fixture",
      workspaceRoot: dir,
      goal: "Preserve the regex pattern, error position, and engine message.",
      proposedSummary: "Added a generic validation error.",
      mutationRevision: 1,
      filesChanged: ["parser.py"],
      acceptanceCriteria: [],
      verificationEvidence: [],
      deliberation: [],
    });

    expect(result.verdict).toBe("fail");
    expect(capturedArgs?.child_policy).toBe("read_only");
    expect(capturedGoal).toContain("error position, and engine message");
    expect(capturedGoal).toContain("Added a generic validation error");
    expect(capturedGoal).toContain("parser.py");
  });

  test("model reviewer receives revision-scoped verification facts and separates report grounding", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-candidate-grounding-"));
    writeFileSync(path.join(dir, "candidate.py"), "value = 2\n", "utf8");
    const reviewer = new ModelCandidateReviewer({
      model: {
        label: "grounding-review-fixture",
        async complete(messages) {
          const prompt = messages[1]?.content ?? "";
          expect(prompt).toContain(
            "[r0; pre-change/stale] code_failed: python -m pytest",
          );
          expect(prompt).toContain(
            "[r1; current candidate] code_failed: python -m pytest",
          );
          expect(prompt).toContain(
            "A baseline-equivalence claim requires a comparable command",
          );
          return {
            text: "The code is semantically sound, but the summary says all tests passed while the current ledger records a failure.\nREPORT_GROUNDING: FAIL\nVERDICT: PASS",
          };
        },
      },
    });

    const result = await reviewer.review({
      runId: "grounding-review",
      workspaceRoot: dir,
      goal: "Set value to two.",
      proposedSummary: "Implemented it and all tests passed.",
      mutationRevision: 1,
      filesChanged: ["candidate.py"],
      acceptanceCriteria: [],
      verificationEvidence: [
        {
          command: "python -m pytest",
          mutationRevision: 0,
          outcome: "code_failed",
          summary: "exit 1",
          evidence: "1 failed",
        },
        {
          command: "python -m pytest",
          mutationRevision: 1,
          outcome: "code_failed",
          summary: "exit 1",
          evidence: "1 failed",
        },
      ],
      deliberation: [],
    });

    expect(result).toMatchObject({
      verdict: "pass",
      reportGrounding: "fail",
      modelCalls: 1,
    });
  });

  test("an unsupported report is corrected and re-reviewed without a source mutation", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-report-correction-"));
    const reviewInputs: CandidateReviewInput[] = [];
    const reviewer: CandidateReviewer = {
      async review(input) {
        reviewInputs.push(input);
        const unsupported = input.proposedSummary.includes("baseline");
        return {
          verdict: "pass",
          reportGrounding: unsupported ? "fail" : "pass",
          summary: unsupported
            ? "No pre-change test exists in the host ledger, so the baseline claim is unsupported."
            : "The revised report only states the current observed result.",
        };
      },
    };
    let modelCalls = 0;
    const model = {
      label: "report-correction-fixture",
      async complete() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            text: JSON.stringify({
              tool: "workspace.write_file",
              args: { path: "candidate.txt", content: "correct" },
            }),
          };
        }
        return {
          text: JSON.stringify({
            action: "final_answer",
            summary:
              modelCalls === 2
                ? "Implemented correctly; failures are identical to the pre-change baseline. [skip_verify: deterministic review fixture]"
                : "Implemented correctly; executable verification was skipped by this deterministic fixture. [skip_verify: deterministic review fixture]",
          }),
        };
      },
    };
    const events: RunEventEnvelope[] = [];

    const result = await new AgentOrchestrator({
      model,
      auxiliaryModel: new FakeLanguageModel(),
      candidateReviewer: reviewer,
      retrySleep: async () => {},
      onEvent: (event) => events.push(event),
    }).run({
      runId: "report-correction",
      goal: "Write the correct result. [allow_skip_verify]",
      workspaceRoot: dir,
      maxSteps: 5,
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("verification was skipped");
    expect(reviewInputs.map((input) => input.mutationRevision)).toEqual([1, 1]);
    expect(reviewInputs.map((input) => input.proposedSummary)).toHaveLength(2);
    expect(
      events
        .filter((event) => event.event.type === "candidate.review")
        .map((event) =>
          event.event.type === "candidate.review"
            ? event.event.reportGrounding
            : undefined,
        ),
    ).toEqual(["fail", "pass"]);
    expect(modelCalls).toBe(3);
  });

  test("an unchanged unsupported report is deduplicated and cannot loop forever", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-report-dedupe-"));
    let reviewerCalls = 0;
    const reviewer: CandidateReviewer = {
      async review() {
        reviewerCalls += 1;
        return {
          verdict: "pass",
          reportGrounding: "fail",
          summary: "No pre-change test exists for the claimed baseline.",
        };
      },
    };
    let modelCalls = 0;
    const model = {
      label: "report-dedupe-fixture",
      async complete() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            text: JSON.stringify({
              tool: "workspace.write_file",
              args: { path: "candidate.txt", content: "correct" },
            }),
          };
        }
        return {
          text: JSON.stringify({
            action: "final_answer",
            summary:
              "Failures match the pre-change baseline. [skip_verify: deterministic review fixture]",
          }),
        };
      },
    };

    const result = await new AgentOrchestrator({
      model,
      auxiliaryModel: new FakeLanguageModel(),
      candidateReviewer: reviewer,
      retrySleep: async () => {},
    }).run({
      runId: "report-dedupe",
      goal: "Write the correct result. [allow_skip_verify]",
      workspaceRoot: dir,
      maxSteps: 5,
    });

    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("REPORT_GROUNDING_FAIL");
    expect(reviewerCalls).toBe(1);
    expect(modelCalls).toBe(4);
  });

  test("missing report-grounding protocol fails closed instead of silently completing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-report-protocol-"));
    let reviewerCalls = 0;
    const reviewer: CandidateReviewer = {
      async review() {
        reviewerCalls += 1;
        return {
          verdict: "partial",
          reportGrounding: "unknown",
          summary: "Reviewer output omitted the report-grounding decision.",
        };
      },
    };
    let modelCalls = 0;
    const model = {
      label: "report-protocol-fixture",
      async complete() {
        modelCalls += 1;
        return modelCalls === 1
          ? {
              text: JSON.stringify({
                tool: "workspace.write_file",
                args: { path: "candidate.txt", content: "correct" },
              }),
            }
          : {
              text: JSON.stringify({
                action: "final_answer",
                summary:
                  "Implemented. [skip_verify: deterministic review fixture]",
              }),
            };
      },
    };

    const result = await new AgentOrchestrator({
      model,
      auxiliaryModel: new FakeLanguageModel(),
      candidateReviewer: reviewer,
      retrySleep: async () => {},
    }).run({
      runId: "report-protocol",
      goal: "Write the correct result. [allow_skip_verify]",
      workspaceRoot: dir,
      maxSteps: 5,
    });

    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("PROTOCOL_INCOMPLETE");
    expect(reviewerCalls).toBe(1);
    expect(modelCalls).toBe(2);
  });

  test("failed semantic review forces a source revision before completion", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-candidate-loop-"));
    const reviewInputs: CandidateReviewInput[] = [];
    const reviewer: CandidateReviewer = {
      async review(input) {
        reviewInputs.push(input);
        if (input.mutationRevision === 1) {
          return {
            verdict: "fail",
            reportGrounding: "pass",
            summary:
              "The generic message omits the required regex error position and engine message.",
          };
        }
        return {
          verdict: "pass",
          reportGrounding: "pass",
          summary: "The revised message preserves all required diagnostics.",
        };
      },
    };
    let modelCalls = 0;
    const events: RunEventEnvelope[] = [];
    const model = {
      label: "candidate-review-loop-fixture",
      async complete() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            text: JSON.stringify({
              tool: "workspace.write_file",
              args: {
                path: "parser.py",
                content: 'message = f"Invalid regular expression: {value}"\n',
              },
            }),
          };
        }
        if (modelCalls === 2) {
          return {
            text: JSON.stringify({
              action: "final_answer",
              summary:
                "Added regex validation. [skip_verify: deterministic review fixture]",
            }),
          };
        }
        if (modelCalls === 3) {
          return {
            text: JSON.stringify({
              tool: "workspace.edit_file",
              args: {
                path: "parser.py",
                old_string: 'message = f"Invalid regular expression: {value}"',
                new_string:
                  'message = f"Error in regular expression {value} at {error.pos}: {error.msg}"',
              },
            }),
          };
        }
        return {
          text: JSON.stringify({
            action: "final_answer",
            summary:
              "Preserved the pattern, position, and engine message. [skip_verify: deterministic review fixture]",
          }),
        };
      },
    };
    const orchestrator = new AgentOrchestrator({
      model,
      auxiliaryModel: new FakeLanguageModel(),
      candidateReviewer: reviewer,
      retrySleep: async () => {},
      onEvent: (event) => events.push(event),
    });

    const result = await orchestrator.run({
      runId: "candidate-review-loop",
      goal: "Preserve the regex pattern, error position, and engine message. [allow_skip_verify]",
      workspaceRoot: dir,
      maxSteps: 6,
    });

    expect(result.status).toBe("completed");
    expect(result.message).toContain("position, and engine message");
    expect(reviewInputs.map((input) => input.mutationRevision)).toEqual([1, 2]);
    expect(
      events
        .filter((event) => event.event.type === "candidate.review")
        .map((event) =>
          event.event.type === "candidate.review"
            ? [event.event.mutationRevision, event.event.verdict]
            : [],
        ),
    ).toEqual([
      [1, "fail"],
      [2, "pass"],
    ]);
    expect(modelCalls).toBe(4);
  });

  test("a repeated final answer on the same failed revision reuses the verdict", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-candidate-dedupe-"));
    let reviewerCalls = 0;
    const reviewer: CandidateReviewer = {
      async review() {
        reviewerCalls += 1;
        return {
          verdict: "fail",
          reportGrounding: "pass",
          summary: "Required detail is missing.",
        };
      },
    };
    let modelCalls = 0;
    const model = {
      label: "candidate-review-dedupe-fixture",
      async complete() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            text: JSON.stringify({
              tool: "workspace.write_file",
              args: { path: "candidate.txt", content: "incomplete" },
            }),
          };
        }
        return {
          text: JSON.stringify({
            action: "final_answer",
            summary: "Done. [skip_verify: deterministic review fixture]",
          }),
        };
      },
    };

    const result = await new AgentOrchestrator({
      model,
      auxiliaryModel: new FakeLanguageModel(),
      candidateReviewer: reviewer,
      retrySleep: async () => {},
    }).run({
      runId: "candidate-review-dedupe",
      goal: "Write the complete result. [allow_skip_verify]",
      workspaceRoot: dir,
      maxSteps: 4,
    });

    expect(result.status).toBe("incomplete");
    expect(result.message).toContain("IndependentReview:FAIL");
    expect(reviewerCalls).toBe(1);
    expect(modelCalls).toBe(4);
  });

  test("child reviewer model usage is charged to the root cost ledger", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-candidate-cost-"));
    const costTracker = new CostTracker();
    const launcher = new DefaultSubAgentLauncher({
      workspaceRoot: dir,
      model: new FakeLanguageModel({
        responses: [
          {
            text: JSON.stringify({
              action: "final_answer",
              summary:
                "No blocking semantic issue.\nREPORT_GROUNDING: PASS\nVERDICT: PASS",
            }),
            usage: { promptTokens: 120, completionTokens: 30 },
          },
        ],
      }),
      costTracker,
    });

    const result = await new SubAgentCandidateReviewer({ launcher }).review({
      runId: "candidate-review-cost",
      workspaceRoot: dir,
      goal: "Review this candidate.",
      proposedSummary: "Done.",
      mutationRevision: 1,
      filesChanged: ["candidate.ts"],
      acceptanceCriteria: [],
      verificationEvidence: [],
      deliberation: [],
    });

    expect(result.verdict).toBe("pass");
    expect(costTracker.snapshot()).toMatchObject({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
    });
  });
});
