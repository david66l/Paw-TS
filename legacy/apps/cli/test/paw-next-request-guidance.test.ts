import { expect, test } from "bun:test";
import type {
  InteractiveControlConfigV2,
  SessionInputSnapshot,
} from "@paw/agent-loop";
import type { InputFactV1, JsonValue } from "@paw/protocol";
import {
  completionReviewFeedbackInputIdV1,
  createCompletionReviewFallbackFeedbackV1,
} from "@paw/completion-review";
import { projectPawNextRequestGuidanceV1 } from "../../../../packages/paw-next/src/request-guidance.js";

const budget: InteractiveControlConfigV2 = {
  mode: "interactive",
  naturalStop: "complete",
  maxSegments: 4,
  maxModelTurns: 40,
  maxTotalModelTurns: 80,
};

test("audit-format retry guidance is bound to authentic feedback and expires after steering or a new review", () => {
  const candidateHash = "b".repeat(64);
  const inputId = completionReviewFeedbackInputIdV1(candidateHash);
  const review = {
    type: "completion.review_settled" as const,
    reviewId: "review",
    status: "unknown" as const,
    verdict: "unknown" as const,
    reasonCode: "AuditReportInvalid",
    summary: "Report format rejected",
    settledAt: 2,
  };
  const content = createCompletionReviewFallbackFeedbackV1(review);
  const facts: InputFactV1[] = [
    {
      type: "completion.review_claimed",
      reviewId: "review",
      candidateHash,
      policyVersion: "paw.completion-review.v1",
      reviewerId: "reviewer",
      triggers: ["missing_fresh_verification"],
      sourceThroughSeq: 1,
      claimedAt: 1,
    },
    review,
    {
      type: "input.accepted",
      inputId,
      delivery: "queue",
      callerId: "completion-review",
      content,
      contentHash: "feedback",
    },
    {
      type: "work.segment_started",
      segmentIndex: 1,
      inputId,
      reducerVersion: "v2",
      previousDecisionStateHash: "state",
      previousAction: { kind: "complete", reasonCode: "complete" },
      policyVersion: "paw.work-segment.v1",
    },
    {
      type: "input.promoted",
      inputId,
      delivery: "queue",
      content,
      contentHash: "feedback",
    },
  ];
  const hints = (value: InputFactV1[]) =>
    projectPawNextRequestGuidanceV1(snapshot(value), budget).filter((item) =>
      item.content.startsWith("[Paw audit report retry]"),
    );
  expect(hints(facts)).toHaveLength(1);
  expect(hints(structuredClone(facts))).toEqual(hints(facts));
  const spoofed = structuredClone(facts);
  if (spoofed[2]?.type === "input.accepted")
    spoofed[2] = { ...spoofed[2], callerId: "user" };
  expect(hints(spoofed)).toEqual([]);
  expect(
    hints([
      ...facts,
      { ...review, reviewId: "next-review", reasonCode: "AuditTimeout" },
    ]),
  ).toEqual([]);
  expect(
    hints([
      ...facts,
      {
        type: "input.promoted",
        inputId: "steering",
        delivery: "steer",
        content: "New instructions",
        contentHash: "steer",
      },
    ]),
  ).toEqual([]);
});

test("active guidance retains a stable anchor and derives a fresh fallback from journal facts", () => {
  const facts: InputFactV1[] = [];
  for (let turn = 1; turn <= 4; turn++)
    addTurn(facts, turn, "workspace_read_file", { path: `${turn}.ts` });
  const first = projectPawNextRequestGuidanceV1(snapshot(facts), budget);
  expect(first).toHaveLength(1);
  addTurn(facts, 5, "workspace_read_file", { path: "5.ts" });
  const next = projectPawNextRequestGuidanceV1(snapshot(facts), budget);
  expect(next[0]?.sourceThroughSeq).toBe(first[0]?.sourceThroughSeq);
  expect(next[0]?.content).toBe(first[0]?.content);
  expect(next[0]?.fallbackContent).toContain("5 model turns");
  expect(
    projectPawNextRequestGuidanceV1(structuredClone(snapshot(facts)), budget),
  ).toEqual(next);
});

test("a passing verification removes active guidance instead of reviving stale advice after compaction", () => {
  const facts: InputFactV1[] = [];
  for (let turn = 1; turn <= 4; turn++)
    addTurn(facts, turn, "workspace_write_file", { path: `${turn}.ts` });
  expect(
    projectPawNextRequestGuidanceV1(snapshot(facts), budget).some((item) =>
      item.fallbackContent?.includes("adviceId=verification_due:"),
    ),
  ).toBe(true);
  addTurn(
    facts,
    5,
    "workspace_run_shell",
    { command: "npm test" },
    { exit_code: 0, workspaceEffect: { changed: false, paths: [] } },
  );
  const next = projectPawNextRequestGuidanceV1(snapshot(facts), budget);
  expect(
    next.some((item) => item.content.includes("adviceId=verification_due:")),
  ).toBe(true);
  expect(next.every((item) => item.fallbackContent === undefined)).toBe(true);
});

test("an omitted closeout anchor gets current verification evidence rather than an old rerun instruction", () => {
  const facts: InputFactV1[] = [];
  addTurn(facts, 1, "workspace_write_file", { path: "a.ts" });
  for (let turn = 2; turn <= 6; turn++)
    addTurn(facts, turn, "workspace_read_file", { path: `${turn}.ts` });
  const limits = { ...budget, maxModelTurns: 10 };
  const first = projectPawNextRequestGuidanceV1(snapshot(facts), limits).find(
    (item) => item.content.includes("adviceId=convergence_checkpoint:"),
  );
  expect(first?.content).toContain("Run a direct");
  addTurn(
    facts,
    7,
    "workspace_run_shell",
    { command: "npm test" },
    { exit_code: 0, workspaceEffect: { changed: false, paths: [] } },
  );
  const next = projectPawNextRequestGuidanceV1(snapshot(facts), limits).find(
    (item) => item.content.includes("adviceId=convergence_checkpoint:"),
  );
  expect(next?.content).toBe(first?.content);
  expect(next?.fallbackContent).toContain("latest check passed");
  expect(next?.fallbackContent).toContain("3 model calls remain");
});

function snapshot(facts: InputFactV1[]): SessionInputSnapshot<InputFactV1> {
  return {
    entries: facts.map((fact, index) => ({ seq: index + 1, fact })),
    tailSeq: facts.length,
    latestInputSeq: facts.length,
  };
}

function addTurn(
  facts: InputFactV1[],
  turn: number,
  tool: string,
  args: JsonValue,
  payload?: JsonValue,
) {
  const modelCallId = `model-${turn}`;
  const callId = `call-${turn}`;
  facts.push(
    {
      type: "model.settled",
      modelCallId,
      turn,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
    },
    {
      type: "tool.call_observed",
      modelCallId,
      callId,
      turn,
      tool,
      args,
      order: 0,
    },
    {
      type: "tool.settled",
      callId,
      status: "completed",
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        isError: false,
        summary: "completed",
        ...(payload === undefined
          ? {}
          : { payload: { kind: "inline", value: payload, hash: "fixture" } }),
      },
    },
  );
}
