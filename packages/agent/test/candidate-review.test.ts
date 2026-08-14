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
  extractCandidateDeliberation,
  parseCandidateReview,
} from "../src/candidate-review.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { DefaultSubAgentLauncher } from "../src/sub-agent-launcher.js";

describe("candidate solution review", () => {
  test("parses only an explicit terminal verdict and defaults malformed output to partial", () => {
    expect(
      parseCandidateReview("Missing exception detail.\nVERDICT: FAIL"),
    ).toMatchObject({
      verdict: "fail",
      summary: "Missing exception detail.",
    });
    expect(parseCandidateReview("Looks fine").verdict).toBe("partial");
    expect(
      parseCandidateReview(
        "VERDICT: FAIL\nFixed after inspection.\nVERDICT: PASS",
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
          expect(messages[1]?.content).toContain("Return plain text only");
          return {
            text: "The generic message loses required error detail.\nVERDICT: FAIL",
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
          return { text: "Everything is correct.\nVERDICT: PASS" };
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
            text: "The candidate omits actionable exception detail.\nVERDICT: FAIL",
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
            "The candidate drops the regex error position and engine message.\nVERDICT: FAIL",
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
      deliberation: [],
    });

    expect(result.verdict).toBe("fail");
    expect(capturedArgs?.child_policy).toBe("read_only");
    expect(capturedGoal).toContain("error position, and engine message");
    expect(capturedGoal).toContain("Added a generic validation error");
    expect(capturedGoal).toContain("parser.py");
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
            summary:
              "The generic message omits the required regex error position and engine message.",
          };
        }
        return {
          verdict: "pass",
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
        return { verdict: "fail", summary: "Required detail is missing." };
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
              summary: "No blocking semantic issue.\nVERDICT: PASS",
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
