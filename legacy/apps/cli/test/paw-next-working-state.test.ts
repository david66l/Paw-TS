import { expect, test } from "bun:test";
import type { InputFactV1, JsonValue } from "@paw/protocol";
import {
  PAW_WORKING_STATE_MAX_CHARS_V1,
  projectPawWorkingStateV1,
} from "../../../../packages/paw-next/src/working-state.js";

function snapshot(facts: InputFactV1[]) {
  return {
    entries: facts.map((fact, i) => ({ seq: i + 1, fact })),
    tailSeq: facts.length,
    latestInputSeq: facts.length,
  };
}
function state(facts: InputFactV1[]) {
  return JSON.parse(
    projectPawWorkingStateV1(snapshot(facts))!.content.split("\n").at(-1)!,
  );
}
function tool(
  facts: InputFactV1[],
  name: string,
  args: JsonValue,
  payload?: JsonValue,
  isError = false,
) {
  const callId = `call-${facts.length}`;
  facts.push({
    type: "tool.call_observed",
    modelCallId: "model",
    callId,
    turn: 1,
    order: 0,
    tool: name,
    args,
  });
  facts.push({
    type: "tool.settled",
    callId,
    status: "completed",
    observation: {
      schemaVersion: "paw.tool-observation.v1",
      isError,
      summary: "fixture",
      ...(payload === undefined
        ? {}
        : { payload: { kind: "inline", value: payload, hash: "fixture" } }),
    },
  });
}
const clean = { workspaceEffect: { changed: false, paths: [] } };

test("a passing check in another directory does not overwrite the failing target", () => {
  const facts: InputFactV1[] = [];
  tool(
    facts,
    "workspace_run_shell",
    { command: "cd package-a && npm test" },
    { ...clean, exit_code: 1 },
    true,
  );
  tool(
    facts,
    "workspace_run_shell",
    { command: "cd package-b && npm test" },
    { ...clean, exit_code: 0 },
  );
  const checks = state(facts).latestVerificationByTarget.items;
  expect(checks).toHaveLength(2);
  expect(checks[0].outcome).toBe("failed");
  expect(checks[0].scope).toContain("package-a");
  expect(checks[1].outcome).toBe("passed");
  expect(checks[1].scope).toContain("package-b");
});

test("a new work segment does not inherit previous task completion or errors", () => {
  const facts: InputFactV1[] = [];
  tool(
    facts,
    "workspace_run_shell",
    { command: "npm test" },
    { ...clean, exit_code: 1 },
    true,
  );
  facts.push({
    type: "work.segment_started",
    segmentIndex: 1,
    inputId: "new",
    reducerVersion: "fixture",
    previousDecisionStateHash: "fixture",
    previousAction: { kind: "complete", reasonCode: "fixture" },
    policyVersion: "paw.work-segment.v1",
  });
  facts.push({
    type: "input.promoted",
    inputId: "new",
    delivery: "initial",
    content: "A different task",
    contentHash: "fixture",
  });
  expect(projectPawWorkingStateV1(snapshot(facts))).toBeUndefined();
  tool(facts, "workspace_read_file", { path: "new.txt" });
  expect(state(facts).recentUnsuccessfulActions.items).toHaveLength(0);
  expect(state(facts).latestVerificationByTarget.items).toHaveLength(0);
  expect(state(facts).segmentStartSeq).toBe(3);
});

test("tool-free input stays unchanged; projection is stable without new tool evidence", () => {
  expect(projectPawWorkingStateV1(snapshot([]))).toBeUndefined();
  const facts: InputFactV1[] = [];
  tool(facts, "workspace_read_file", { path: "REQUIREMENTS.md", limit: 1 });
  const prior = projectPawWorkingStateV1(snapshot(facts));
  facts.push({
    type: "model.settled",
    modelCallId: "answer",
    turn: 2,
    status: "completed",
    hasToolCalls: false,
    hasVisibleOutput: true,
  });
  expect(projectPawWorkingStateV1(snapshot(facts))).toEqual(prior);
  expect(projectPawWorkingStateV1(structuredClone(snapshot(facts)))).toEqual(
    prior,
  );
  expect(state(facts).fileReads.items[0]).toEqual({
    sourceSeq: 2,
    path: "REQUIREMENTS.md",
  });
  expect(prior!.content).toContain("Read records can be partial");
  expect(prior!.placement).toBe("tail");
});

test("latest result supersedes a failure per target; later mutations invalidate passing evidence", () => {
  const facts: InputFactV1[] = [];
  tool(
    facts,
    "workspace_run_shell",
    { command: "npm test" },
    { ...clean, exit_code: 1 },
    true,
  );
  tool(
    facts,
    "workspace_run_shell",
    { command: "npm test" },
    { ...clean, exit_code: 0 },
  );
  expect(state(facts).latestVerificationByTarget.items).toEqual([
    {
      sourceSeq: 4,
      target: "test:npm test",
      outcome: "passed",
      freshness: "after_last_observed_change",
    },
  ]);
  tool(
    facts,
    "workspace_edit_file",
    { path: "src/a.js" },
    { workspaceEffect: { changed: true, paths: ["src/a.js"] } },
  );
  expect(state(facts).latestVerificationByTarget.items[0].freshness).toBe(
    "stale_or_overlapping_change",
  );
  expect(state(facts).workspaceChanges.paths.items[0].path).toBe("src/a.js");
  expect(state(facts).workspaceChanges.confirmedOperations).toBe(1);
});

test("missing status, masked pipelines, nonzero exit and unknown writes cannot become passing current evidence", () => {
  const facts: InputFactV1[] = [];
  tool(facts, "workspace_run_shell", { command: "npm test" }, clean);
  expect(state(facts).latestVerificationByTarget.items[0].outcome).toBe(
    "indeterminate",
  );
  tool(
    facts,
    "workspace_run_shell",
    { command: "npm test | tail -5" },
    { ...clean, exit_code: 0 },
  );
  expect(state(facts).latestVerificationByTarget.items[0].outcome).toBe(
    "indeterminate",
  );
  tool(
    facts,
    "workspace_run_shell",
    { command: "npm test" },
    { ...clean, exit_code: 1 },
  );
  expect(state(facts).latestVerificationByTarget.items[0].outcome).toBe(
    "failed",
  );
  tool(facts, "workspace_write_file", { path: "partial.js" }, undefined, true);
  expect(state(facts).workspaceChanges.uncertainOperations).toBe(1);
  expect(state(facts).latestVerificationByTarget.items[0].freshness).toBe(
    "stale_or_overlapping_change",
  );
});

test("asynchronous verification begun before an edit cannot certify the new revision", () => {
  const facts: InputFactV1[] = [];
  tool(
    facts,
    "workspace_job_start",
    { command: "npm test" },
    { ...clean, jobId: "test-job" },
  );
  tool(
    facts,
    "workspace_write_file",
    { path: "a.js" },
    { workspaceEffect: { changed: true, paths: ["a.js"] } },
  );
  tool(
    facts,
    "workspace_job_wait",
    { id: "test-job" },
    { ...clean, snapshot: { status: "completed", detail: "exit code: 0" } },
  );
  expect(state(facts).latestVerificationByTarget.items[0]).toMatchObject({
    outcome: "passed",
    freshness: "stale_or_overlapping_change",
  });
});

test("overlapping calls and payload references remain conservative", () => {
  const facts: InputFactV1[] = [];
  tool(
    facts,
    "workspace_write_file",
    { path: "a.js" },
    { workspaceEffect: { changed: true, paths: ["a.js"] } },
  );
  tool(
    facts,
    "workspace_run_shell",
    { command: "npm test" },
    { ...clean, exit_code: 0 },
  );
  // Both requests precede either result, as in a parallel tool batch.
  [facts[1], facts[2]] = [facts[2]!, facts[1]!];
  expect(state(facts).latestVerificationByTarget.items[0].freshness).toBe(
    "stale_or_overlapping_change",
  );
  const last = facts.at(-1)!;
  if (last.type === "tool.settled")
    facts[facts.length - 1] = {
      ...last,
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        isError: false,
        summary: "archived; see original observation",
      },
    };
  expect(state(facts).latestVerificationByTarget.items[0].outcome).toBe(
    "indeterminate",
  );
});

test("projection is bounded even with escaped hostile paths and many independent checks", () => {
  const facts: InputFactV1[] = [];
  for (let i = 0; i < 80; i++) {
    tool(facts, "workspace_read_file", {
      path: `${i}\n${"\u0000".repeat(500)}`,
    });
    tool(
      facts,
      "workspace_run_shell",
      { command: `npm test -- ${i}${"\u0000".repeat(300)}` },
      { ...clean, exit_code: 1 },
      true,
    );
  }
  const result = projectPawWorkingStateV1(snapshot(facts))!;
  expect(result.content.length).toBeLessThanOrEqual(
    PAW_WORKING_STATE_MAX_CHARS_V1,
  );
  expect(state(facts).fileReads.omitted).toBeGreaterThan(0);
  expect(state(facts).latestVerificationByTarget.items.length).toBeGreaterThan(
    0,
  );
  expect(result.content).toContain("untrusted data");
});
