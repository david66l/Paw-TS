import { expect, test } from "bun:test";
import { parseRunJournalPrefixV1, type InputFactV1 } from "@paw/protocol";
import { projectExecutionBudgetV1, withExecutionBudgetInputV1 } from "../../../../packages/paw-next/src/execution-budget.js";
import { projectPawNextRequestGuidanceV1 } from "../../../../packages/paw-next/src/request-guidance.js";

const initial: InputFactV1 = { type: "input.promoted", inputId: "input-1", delivery: "initial", content: "work", contentHash: "goal" };
const snapshot = (facts: readonly InputFactV1[]) => ({ entries: facts.map((fact, i) => ({ seq: i + 1, fact })), tailSeq: facts.length, latestInputSeq: facts.length });
const delegate = { async reportSafeBoundary() {}, async consumePromotedInputIds() { return []; } };
function fixture() {
  const facts: InputFactV1[] = [initial];
  const session = { async readInputSnapshot() { return snapshot(facts); }, async appendInputFacts(next: readonly InputFactV1[]) { facts.push(...next); } };
  return { facts, session };
}

test("a long first request reaches closeout even with 48 calls available; replay never reads the clock", async () => {
  const { facts, session } = fixture(); let now = 0;
  const port = withExecutionBudgetInputV1(delegate, session, { deadlineAtMs: 1_200_000, reserveMs: 180_000 }, () => now);
  await port.reportSafeBoundary("before_first_model_request");
  expect(projectExecutionBudgetV1(snapshot(facts))!.content).toContain("1200 seconds");
  now = 1_050_000;
  await port.reportSafeBoundary("after_tool_batch_settled");
  const view = snapshot(facts);
  const advice = projectPawNextRequestGuidanceV1(view, { mode: "interactive", maxModelTurns: 48, maxTotalModelTurns: 96, maxSegments: 2, naturalStop: "complete" });
  expect(advice.at(-1)!.content).toContain("reserve has been reached");
  expect(advice.at(-1)!.content).toContain("user-facing entry point");
  now = 9_000_000;
  expect(projectExecutionBudgetV1(view)).toEqual(projectExecutionBudgetV1(structuredClone(view)));
  expect(projectExecutionBudgetV1(view)!.content).toContain("150 seconds");
});

test("unbounded tasks append no budget and never sample a clock", async () => {
  const { facts, session } = fixture();
  const port = withExecutionBudgetInputV1(delegate, session, undefined, () => { throw new Error("must not read clock"); });
  await port.reportSafeBoundary("before_first_model_request");
  expect(facts).toHaveLength(1);
  expect(projectExecutionBudgetV1(snapshot(facts))).toBeUndefined();
});

test("measured admission declines an unaffordable next request and survives recovery without changing old budgets", async () => {
  const { facts, session } = fixture();
  let now = 0;
  const deadline = { deadlineAtMs: 20_000, reserveMs: 3000, admissionPolicy: "recent_round_floor_v1" as const };
  const port = withExecutionBudgetInputV1(delegate, session, deadline, () => now);
  await port.reportSafeBoundary("before_first_model_request");
  facts.push({ type: "model.settled", modelCallId: "m1", turn: 1, status: "completed", hasToolCalls: true, hasVisibleOutput: false });
  now = 10_000;
  await port.reportSafeBoundary("after_tool_batch_settled");
  facts.push({ type: "model.settled", modelCallId: "m2", turn: 2, status: "completed", hasToolCalls: true, hasVisibleOutput: false });
  now = 19_500;
  await expect(port.reportSafeBoundary("after_tool_batch_settled")).rejects.toThrow("ExecutionBudgetInsufficientForRequest");
  expect(facts.at(-1)).toMatchObject({ type: "execution.budget_observed", observedAtMs: 19_500 });
  await expect(withExecutionBudgetInputV1(delegate, session, undefined, () => now).reportSafeBoundary("before_first_model_request")).rejects.toThrow("ExecutionBudgetInsufficientForRequest");
  await expect(withExecutionBudgetInputV1(delegate, session, { deadlineAtMs: 20_000, reserveMs: 3000 }, () => now).reportSafeBoundary("before_first_model_request")).rejects.toThrow("changed");
  const old = fixture();
  const legacy = withExecutionBudgetInputV1(delegate, old.session, { deadlineAtMs: 20_000, reserveMs: 3000 }, () => now);
  await legacy.reportSafeBoundary("before_first_model_request");
  expect(projectExecutionBudgetV1(snapshot(old.facts))!.content).toContain("1 seconds");
});

test("recovery preserves deadline, rejects extensions and clamps a backwards clock", async () => {
  const { facts, session } = fixture();
  await withExecutionBudgetInputV1(delegate, session, { deadlineAtMs: 1_000_000, reserveMs: 100_000 }, () => 800_000).reportSafeBoundary("before_first_model_request");
  await withExecutionBudgetInputV1(delegate, session, undefined, () => 200_000).reportSafeBoundary("before_first_model_request");
  expect(projectExecutionBudgetV1(snapshot(facts))!.content).toContain("200 seconds");
}, 5000);

test("exhaustion is persisted before the next request; a changed allowance is rejected", async () => {
  const { facts, session } = fixture();
  await withExecutionBudgetInputV1(delegate, session, { deadlineAtMs: 1000, reserveMs: 100 }, () => 800).reportSafeBoundary("before_first_model_request");
  await expect(withExecutionBudgetInputV1(delegate, session, { deadlineAtMs: 2000, reserveMs: 100 }, () => 900).reportSafeBoundary("before_first_model_request")).rejects.toThrow("changed");
  await expect(withExecutionBudgetInputV1(delegate, session, undefined, () => 1000).reportSafeBoundary("before_first_model_request")).rejects.toThrow("ExecutionDeadlineExceeded");
  expect(projectExecutionBudgetV1(snapshot(facts))!.content).toContain("0 seconds");
});

test("a new work item does not inherit an old deadline; steering keeps the current scope", async () => {
  const { facts, session } = fixture();
  await withExecutionBudgetInputV1(delegate, session, { deadlineAtMs: 1000, reserveMs: 100 }, () => 100).reportSafeBoundary("before_first_model_request");
  facts.push({ ...initial, inputId: "steer", delivery: "steer" });
  expect(projectExecutionBudgetV1(snapshot(facts))).toBeDefined();
  facts.push({ type: "work.segment_started", inputId: "next", segmentIndex: 1, reducerVersion: "v2", previousDecisionStateHash: "hash", previousAction: { kind: "complete", reasonCode: "done" }, policyVersion: "paw.work-segment.v1" });
  expect(projectExecutionBudgetV1(snapshot(facts))).toBeUndefined();
});

test("strict journal rejects forged allowance changes, unpromoted scopes and invalid clock values", () => {
  const budget: InputFactV1 = { type: "execution.budget_observed", inputId: "input-1", deadlineAtMs: 1000, reserveMs: 100, observedAtMs: 200 };
  const prefix = (facts: unknown[]) => facts.map((fact, index) => ({ schemaVersion: "paw.run-journal.v1", sessionId: "s", runId: "r", seq: index + 1, ts: 100 + index, record: { kind: "input_fact", fact } }));
  const start = { type: "attempt.started", goalHash: "goal", configHash: "config" };
  expect(() => parseRunJournalPrefixV1(prefix([start, initial, budget]))).not.toThrow();
  for (const changed of [{ ...budget, deadlineAtMs: 2000 }, { ...budget, reserveMs: 1 }, { ...budget, observedAtMs: 100 }, { ...budget, observedAtMs: Infinity }, { ...budget, observedAtMs: Number.MAX_SAFE_INTEGER + 1 }])
    expect(() => parseRunJournalPrefixV1(prefix([start, initial, budget, changed]))).toThrow();
  expect(() => parseRunJournalPrefixV1(prefix([start, budget]))).toThrow();
});
