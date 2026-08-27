import { describe, expect, test } from "bun:test";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { InputFactV1 } from "@paw/protocol";

import {
  type CompletionReviewSessionV1,
  classifyVerificationCommandV1,
  completionReviewFeedbackInputIdV1,
  createCompletionReviewCandidateV1,
  createCompletionReviewControllerV1,
  createCompletionReviewEvidencePacketV1,
  createCompletionReviewFallbackFeedbackV1,
  createCompletionReviewFeedbackV1,
  createModelCompletionReviewerV1,
  evaluateCompletionReviewGateV1,
  evaluateCompletionReviewTriggersV1,
  projectCompletionReviewToolEvidenceV1,
  projectPendingCompletionReviewFeedbackV1,
} from "../src/index.js";

describe("completion review evidence projector", () => {
  test("recognizes Django and Python test runners", () => {
    expect(
      classifyVerificationCommandV1(
        "python tests/runtests.py i18n.tests.MiscTests",
      ),
    ).toBe("test");
    expect(
      classifyVerificationCommandV1(
        "./tests/runtests.py --settings=test_sqlite i18n.tests",
      ),
    ).toBe("test");
    expect(classifyVerificationCommandV1("python manage.py test i18n")).toBe(
      "test",
    );
    expect(
      classifyVerificationCommandV1("python -m unittest tests.test_i18n"),
    ).toBe("test");
  });

  test("separates shell execution from a failed test outcome", () => {
    const [projected] = projectCompletionReviewToolEvidenceV1({
      latestMutationSeq: 1,
      calls: [
        {
          seq: 2,
          callId: "call-test",
          tool: "workspace_run_shell",
          status: "completed",
          args: { command: "bun test" },
          summary: "run_shell: exit 1",
          isError: true,
          payload: { exit_code: 1, timed_out: false },
        },
      ],
    });

    expect(projected).toMatchObject({
      executionStatus: "completed",
      outcome: "failed",
      verificationKind: "test",
      verificationTarget: "test:bun test",
      exitCode: 1,
      afterLatestMutation: true,
    });
    expect(projected?.timedOut).toBeUndefined();
  });

  test("does not count a started background job as completed verification", () => {
    const projected = projectCompletionReviewToolEvidenceV1({
      latestMutationSeq: 1,
      calls: [
        {
          seq: 2,
          callId: "start",
          tool: "workspace_job_start",
          status: "completed",
          args: { command: "bun test" },
          summary: "job started",
          isError: false,
          payload: { jobId: "job-1", status: "running" },
        },
        {
          seq: 3,
          callId: "wait",
          tool: "workspace_job_wait",
          status: "completed",
          args: { id: "job-1" },
          summary: "job completed",
          isError: false,
          payload: {
            timedOut: false,
            snapshot: { status: "completed", detail: "exit code: 0" },
          },
        },
      ],
    });

    expect(projected[0]).toMatchObject({ verificationKind: "none" });
    expect(projected[1]).toMatchObject({
      verificationKind: "test",
      outcome: "passed",
      exitCode: 0,
    });
  });

  test("keeps a timed-out test distinct from an ordinary failed assertion", () => {
    const [projected] = projectCompletionReviewToolEvidenceV1({
      latestMutationSeq: 1,
      calls: [
        {
          seq: 2,
          callId: "timed-out-test",
          tool: "workspace_run_shell",
          status: "completed",
          args: { command: "pytest" },
          summary: "run_shell: E_RETRY timeout",
          isError: true,
          payload: {
            error_code: "E_RETRY",
            error: "timeout",
            message: "timeout",
          },
        },
      ],
    });

    expect(projected).toMatchObject({
      outcome: "indeterminate",
      verificationKind: "test",
      timedOut: true,
    });
  });
});

describe("completion review policy", () => {
  test("reviews explicit, non-trivial, and unverified source work without penalizing docs", () => {
    const source = candidate({
      goal: "Implement the fix",
      changedPaths: ["src/a.ts"],
      mutationCount: 1,
    });
    expect(evaluateCompletionReviewTriggersV1(source)).toEqual([
      "missing_fresh_verification",
    ]);

    const docs = candidate({
      goal: "Fix a typo",
      changedPaths: ["README.md"],
      mutationCount: 1,
    });
    expect(evaluateCompletionReviewTriggersV1(docs)).toEqual([]);

    const requested = candidate({
      goal: "Implement this and verify it carefully",
      changedPaths: ["README.md"],
      mutationCount: 3,
    });
    expect(evaluateCompletionReviewTriggersV1(requested)).toEqual([
      "user_requested",
      "non_trivial_change",
    ]);
  });

  test("fresh shell evidence avoids only the missing-verification trigger", () => {
    const value = candidate({
      goal: "Implement the fix",
      changedPaths: ["src/a.ts"],
      mutationCount: 1,
      toolEvidence: [
        {
          callId: "call-test",
          tool: "workspace_run_shell",
          executionStatus: "completed",
          outcome: "passed",
          verificationKind: "test",
          args: { command: "bun test" },
          summary: "tests passed",
          afterLatestMutation: true,
        },
      ],
    });
    expect(evaluateCompletionReviewTriggersV1(value)).toEqual([]);
  });

  test("explicit verification with a fresh pass does not spend a reviewer call", () => {
    const value = candidate({
      goal: "Run the focused test and report the result",
      changedPaths: [],
      mutationCount: 0,
      toolEvidence: [
        {
          callId: "delegated-test",
          tool: "workspace_run_shell",
          executionStatus: "completed",
          outcome: "passed",
          verificationKind: "test",
          args: { command: "node --test delegated.test.js" },
          summary: "test passed",
          afterLatestMutation: true,
        },
      ],
    });

    expect(evaluateCompletionReviewGateV1(value)).toEqual({ action: "allow" });
  });

  test("does not mistake starting a background job for completed verification", () => {
    const started = candidate({
      goal: "Implement the fix",
      changedPaths: ["src/a.ts"],
      mutationCount: 1,
      toolEvidence: [evidence("workspace_job_start", "job-1 running")],
    });
    const completed = candidate({
      goal: "Implement the fix",
      changedPaths: ["src/a.ts"],
      mutationCount: 1,
      toolEvidence: [
        evidence("workspace_job_wait", "job_wait: job-1 completed"),
      ],
    });

    expect(evaluateCompletionReviewTriggersV1(started)).toContain(
      "missing_fresh_verification",
    );
    expect(evaluateCompletionReviewTriggersV1(completed)).toEqual([]);
  });
});

describe("completion review evidence packet and deterministic routing", () => {
  test("routes a completed shell process whose latest test failed to review", () => {
    const decision = evaluateCompletionReviewGateV1(
      candidate({
        goal: "Implement the fix",
        changedPaths: ["src/a.ts"],
        mutationCount: 1,
        toolEvidence: [
          {
            callId: "failed-test",
            tool: "workspace_run_shell",
            executionStatus: "completed",
            outcome: "failed",
            verificationKind: "test",
            args: { command: "bun test" },
            summary: "run_shell: exit 1",
            afterLatestMutation: true,
            isError: true,
            exitCode: 1,
          },
        ],
      }),
    );

    expect(decision).toMatchObject({
      action: "review",
      triggers: ["fresh_verification_failed"],
    });
  });

  test("projects only the latest objective evidence for each target", () => {
    const value = candidate({
      changedPaths: ["src/a.ts"],
      mutationCount: 1,
      toolEvidence: [
        evidence("workspace_run_shell", "failed first", {
          callId: "first",
          outcome: "failed",
          verificationKind: "test",
          verificationTarget: "test:bun test",
        }),
        evidence("workspace_run_shell", "passed later", {
          callId: "second",
          outcome: "passed",
          verificationKind: "test",
          verificationTarget: "test:bun test",
        }),
      ],
    });

    expect(createCompletionReviewEvidencePacketV1(value)).toMatchObject({
      candidateHash: value.candidateHash,
      source: { changedPaths: ["src/a.ts"], mutationCount: 1 },
      verification: {
        state: "passed",
        latestByTarget: [{ callId: "second", outcome: "passed" }],
      },
    });
  });

  test("a later passing test resolves an earlier failure of the same target", () => {
    const base = {
      tool: "workspace_run_shell",
      executionStatus: "completed" as const,
      verificationKind: "test" as const,
      args: { command: "bun test" },
      verificationTarget: "test:bun test",
      afterLatestMutation: true,
    };
    const decision = evaluateCompletionReviewGateV1(
      candidate({
        goal: "Implement the fix",
        changedPaths: ["src/a.ts"],
        mutationCount: 1,
        toolEvidence: [
          {
            ...base,
            callId: "failed-test",
            outcome: "failed",
            summary: "run_shell: exit 1",
          },
          {
            ...base,
            callId: "passing-test",
            outcome: "passed",
            summary: "run_shell: exit 0",
          },
        ],
      }),
    );

    expect(decision).toEqual({ action: "allow" });
  });

  test("an unrelated passing test cannot hide an earlier failed target", () => {
    const decision = evaluateCompletionReviewGateV1(
      candidate({
        goal: "Implement the fix",
        changedPaths: ["src/a.ts"],
        mutationCount: 1,
        toolEvidence: [
          {
            callId: "failed-suite",
            tool: "workspace_run_shell",
            executionStatus: "completed",
            outcome: "failed",
            verificationKind: "test",
            verificationTarget: "test:python tests/runtests.py i18n",
            args: { command: "python tests/runtests.py i18n" },
            summary: "full suite failed",
            afterLatestMutation: true,
          },
          {
            callId: "passing-subset",
            tool: "workspace_run_shell",
            executionStatus: "completed",
            outcome: "passed",
            verificationKind: "test",
            verificationTarget: "test:python tests/runtests.py i18n.patterns",
            args: { command: "python tests/runtests.py i18n.patterns" },
            summary: "subset passed",
            afterLatestMutation: true,
          },
        ],
      }),
    );

    expect(decision).toMatchObject({
      action: "review",
      triggers: ["fresh_verification_failed"],
    });
  });

  test("a trailing shell command cannot mask verification exit status", () => {
    const [projected] = projectCompletionReviewToolEvidenceV1({
      latestMutationSeq: 1,
      calls: [
        {
          seq: 2,
          callId: "masked-test",
          tool: "workspace_run_shell",
          status: "completed",
          args: {
            command:
              "python tests/runtests.py i18n 2>&1 | tail -20; echo exit: $?",
          },
          summary: "shell exited through echo",
          isError: false,
          payload: { exit_code: 0 },
        },
      ],
    });

    expect(projected).toMatchObject({
      outcome: "indeterminate",
      verificationKind: "test",
      verificationTarget: "test:python tests/runtests.py i18n",
    });
  });

  test("shell setup before a verification command does not mask its exit", () => {
    const [projected] = projectCompletionReviewToolEvidenceV1({
      latestMutationSeq: 1,
      calls: [
        {
          seq: 2,
          callId: "prepared-test",
          tool: "workspace_run_shell",
          status: "completed",
          args: {
            command:
              "cd /testbed; source activate testbed; python tests/runtests.py i18n",
          },
          summary: "tests passed",
          isError: false,
          payload: { exit_code: 0 },
        },
      ],
    });

    expect(projected).toMatchObject({
      outcome: "passed",
      verificationTarget: "test:python tests/runtests.py i18n",
    });
  });
});

describe("completion reviewer", () => {
  test("parses one strict model verdict", async () => {
    let packet: Record<string, unknown> | undefined;
    const reviewer = createModelCompletionReviewerV1({
      model: {
        async complete(request) {
          packet = JSON.parse(request.user) as Record<string, unknown>;
          return {
            status: "completed" as const,
            text: JSON.stringify({
              decision: "continue",
              reasonCode: "missing_verification",
              summary: "Run the focused regression test.",
            }),
          };
        },
      },
    });
    await expect(
      reviewer.review(candidate(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      status: "completed",
      verdict: "block",
      reasonCode: "missing_verification",
    });
    expect(packet).toMatchObject({
      policyVersion: "paw.completion-review-evidence-packet.v1",
      verification: { state: "not_required", latestByTarget: [] },
    });
    expect(packet).not.toHaveProperty("toolEvidence");
  });

  test("preserves an uncertain semantic review as durable unknown evidence", async () => {
    const reviewer = createModelCompletionReviewerV1({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: JSON.stringify({
              decision: "uncertain",
              reasonCode: "insufficient_evidence",
              summary:
                "The available test output does not identify the failure.",
            }),
          };
        },
      },
    });

    await expect(
      reviewer.review(candidate(), { signal: new AbortController().signal }),
    ).resolves.toEqual({
      status: "unknown",
      errorCode: "insufficient_evidence",
      summary: "The available test output does not identify the failure.",
    });
  });

  test("uses a bounded output budget and retries one truncated review", async () => {
    const budgets: number[] = [];
    let calls = 0;
    const reviewer = createModelCompletionReviewerV1({
      model: {
        async complete(request) {
          budgets.push(request.maxOutputTokens);
          calls += 1;
          return calls === 1
            ? {
                status: "truncated" as const,
                errorCode: "CompletionReviewModelTruncated",
              }
            : {
                status: "completed" as const,
                text: JSON.stringify({
                  decision: "allow",
                  reasonCode: "evidence_sufficient",
                  summary: "The focused verification passed.",
                }),
              };
        },
      },
    });

    await expect(
      reviewer.review(candidate(), { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ status: "completed", verdict: "allow" });
    expect(budgets).toEqual([4_096, 4_096]);
  });
});

describe("completion review controller", () => {
  test("persists claim and settlement and reuses the candidate result", async () => {
    const session = new MemoryReviewSession();
    let calls = 0;
    const controller = createCompletionReviewControllerV1({
      session,
      reviewer: {
        reviewerId: "test-reviewer.v1",
        async review() {
          calls += 1;
          return {
            status: "completed" as const,
            verdict: "allow" as const,
            reasonCode: "evidence_sufficient",
            summary: "Evidence is sufficient.",
          };
        },
      },
      signal: new AbortController().signal,
      clock: () => 10,
    });
    const value = candidate();
    const first = await controller.review(value, ["user_requested"]);
    const second = await controller.review(value, ["user_requested"]);

    expect(first).toEqual(second);
    expect(calls).toBe(1);
    expect(session.facts.map((fact) => fact.type)).toEqual([
      "attempt.started",
      "completion.review_claimed",
      "completion.review_settled",
    ]);
  });
});

describe("completion review continuation", () => {
  test("recognizes only the exact durable feedback at the FIFO head", () => {
    const claimed = {
      type: "completion.review_claimed" as const,
      reviewId: "review-1",
      candidateHash: "a".repeat(64),
      policyVersion: "paw.completion-review.v1" as const,
      reviewerId: "reviewer.v1",
      triggers: ["user_requested"] as const,
      sourceThroughSeq: 1,
      claimedAt: 2,
    };
    const settled = {
      type: "completion.review_settled" as const,
      reviewId: claimed.reviewId,
      status: "completed" as const,
      verdict: "block" as const,
      reasonCode: "missing_verification",
      summary: "Run the focused test.",
      settledAt: 3,
    };
    const inputId = completionReviewFeedbackInputIdV1(claimed.candidateHash);
    const accepted = {
      type: "input.accepted" as const,
      inputId,
      delivery: "queue" as const,
      content: createCompletionReviewFeedbackV1(settled),
      contentHash: "content-hash",
      callerId: "completion-review",
    };
    const facts: InputFactV1[] = [attempt(), claimed, settled, accepted];

    expect(projectPendingCompletionReviewFeedbackV1(facts)).toEqual({
      reviewId: claimed.reviewId,
      candidateHash: claimed.candidateHash,
      inputId,
    });
    expect(
      projectPendingCompletionReviewFeedbackV1([
        attempt(),
        { ...accepted, inputId: "user-first", callerId: "user" },
        claimed,
        settled,
        accepted,
      ]),
    ).toBeUndefined();
    expect(
      projectPendingCompletionReviewFeedbackV1([
        ...facts.slice(0, -1),
        { ...accepted, content: "drifted" },
      ]),
    ).toBeUndefined();
    expect(
      projectPendingCompletionReviewFeedbackV1([
        ...facts,
        {
          type: "input.accepted",
          inputId: "steer-1",
          delivery: "steer",
          content: "stop",
          contentHash: "steer-hash",
          callerId: "user",
        },
      ]),
    ).toBeUndefined();
  });

  test("recovers exact fallback feedback after an unavailable review", () => {
    const candidateHash = "b".repeat(64);
    const claimed = {
      type: "completion.review_claimed" as const,
      reviewId: "review-unavailable",
      candidateHash,
      policyVersion: "paw.completion-review.v1" as const,
      reviewerId: "reviewer.v1",
      triggers: ["missing_fresh_verification"] as const,
      sourceThroughSeq: 1,
      claimedAt: 2,
    };
    const settled = {
      type: "completion.review_settled" as const,
      reviewId: claimed.reviewId,
      status: "unknown" as const,
      verdict: "unknown" as const,
      reasonCode: "CompletionReviewModelTruncated",
      summary: "CompletionReviewModelTruncated",
      settledAt: 3,
    };
    const inputId = completionReviewFeedbackInputIdV1(candidateHash);
    const facts: InputFactV1[] = [
      attempt(),
      claimed,
      settled,
      {
        type: "input.accepted",
        inputId,
        delivery: "queue",
        content: createCompletionReviewFallbackFeedbackV1(settled),
        contentHash: "fallback-content-hash",
        callerId: "completion-review",
      },
    ];

    expect(projectPendingCompletionReviewFeedbackV1(facts)).toEqual({
      reviewId: claimed.reviewId,
      candidateHash,
      inputId,
    });
  });
});

function candidate(
  overrides: Partial<
    Parameters<typeof createCompletionReviewCandidateV1>[0]
  > = {},
) {
  return createCompletionReviewCandidateV1({
    sourceThroughSeq: 1,
    goal: "Review this change",
    assistantText: "Implemented the requested change.",
    changedPaths: [],
    mutationCount: 0,
    hasUnknownMutationPath: false,
    toolEvidence: [],
    ...overrides,
  });
}

function evidence(
  tool: string,
  summary: string,
  overrides: Partial<
    Parameters<
      typeof createCompletionReviewCandidateV1
    >[0]["toolEvidence"][number]
  > = {},
) {
  return {
    callId: `call-${tool}`,
    tool,
    executionStatus: "completed" as const,
    outcome: "passed" as const,
    verificationKind:
      tool === "workspace_job_wait" ? ("test" as const) : ("none" as const),
    args: {},
    summary,
    afterLatestMutation: true,
    ...overrides,
  };
}

class MemoryReviewSession implements CompletionReviewSessionV1 {
  facts: InputFactV1[] = [attempt()];

  async readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>> {
    return {
      entries: this.facts.map((fact, index) => ({ seq: index + 1, fact })),
      latestInputSeq: this.facts.length,
      tailSeq: this.facts.length,
    };
  }

  async appendInputFacts(facts: readonly InputFactV1[]): Promise<void> {
    this.facts.push(...facts);
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if (expectedTailSeq !== this.facts.length) return "conflict";
    this.facts.push(...facts);
    return "committed";
  }
}

function attempt(): Extract<InputFactV1, { type: "attempt.started" }> {
  return { type: "attempt.started", goalHash: "goal", configHash: "config" };
}
