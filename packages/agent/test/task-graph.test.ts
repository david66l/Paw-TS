import { describe, expect, test } from "bun:test";

import {
  appendTaskGraphFactsV1,
  appendTaskGraphPlanV1,
  formatTaskGraphV1,
  hostFactsFromTaskStateV1,
  parseTaskGraphEventsV1,
  replayTaskGraphV1,
} from "../src/task-graph.js";
import {
  TaskStateManager,
  formatTaskStateForContext,
} from "../src/task-state.js";

describe("TaskGraphV1", () => {
  test("keeps model completion as a claim rather than host completion", () => {
    const events = appendTaskGraphPlanV1(
      [],
      [
        {
          id: "plan-1",
          task_id: "inspect",
          status: "completed",
          depends_on: [],
        },
        {
          id: "plan-2",
          task_id: "implement",
          status: "running",
          depends_on: ["plan-1"],
        },
      ],
    );

    const graph = replayTaskGraphV1(events);
    expect(graph).toMatchObject({
      authority: "advisory_projection",
      completionAuthority: "CompletionPolicy",
      currentNodeId: "plan-2",
    });
    expect(graph.nodes[0]).toMatchObject({
      id: "plan-1",
      status: "claimed_done",
      provenance: "model_proposal",
    });
    expect(graph.nodes.some((node) => node.status === "host_observed")).toBe(
      false,
    );
  });

  test("blocks missing and cyclic proposal dependencies without blocking the loop", () => {
    const events = appendTaskGraphPlanV1(
      [],
      [
        {
          id: "missing",
          task_id: "missing dependency",
          depends_on: ["not-there"],
        },
        { id: "cycle-a", task_id: "A", depends_on: ["cycle-b"] },
        { id: "cycle-b", task_id: "B", depends_on: ["cycle-a"] },
      ],
    );
    const graph = replayTaskGraphV1(events);

    expect(graph.nodes.find((node) => node.id === "missing")).toMatchObject({
      status: "blocked",
      reason: "missing_dependency:not-there",
    });
    expect(graph.nodes.find((node) => node.id === "cycle-a")).toMatchObject({
      status: "blocked",
      reason: "dependency_cycle",
    });
    expect(graph.currentNodeId).toBeUndefined();
  });

  test("revisions retain removed nodes as superseded and status-only claims", () => {
    let events = appendTaskGraphPlanV1(
      [],
      [
        { id: "old", task_id: "old path", status: "pending", depends_on: [] },
        { id: "keep", task_id: "keep", status: "pending", depends_on: [] },
      ],
    );
    events = appendTaskGraphPlanV1(events, [
      { id: "keep", task_id: "keep", status: "completed", depends_on: [] },
    ]);
    const graph = replayTaskGraphV1(events);

    expect(graph.sourceThroughSeq).toBe(2);
    expect(graph.nodes.find((node) => node.id === "old")).toMatchObject({
      status: "superseded",
    });
    expect(graph.nodes.find((node) => node.id === "keep")).toMatchObject({
      status: "claimed_done",
    });
  });

  test("projects only settled host facts as observed milestones", () => {
    let events = appendTaskGraphPlanV1(
      [],
      [{ id: "plan-1", task_id: "fix", depends_on: [] }],
    );
    events = appendTaskGraphFactsV1(events, {
      filesRead: 2,
      shellRevision: 3,
      mutationRevision: 1,
      verification: "passed",
      verificationMutationRevision: 1,
      diffInspectedRevision: 1,
      lastTool: "workspace.git_diff",
      lastToolOk: true,
    });

    const graph = replayTaskGraphV1(events);
    expect(
      graph.nodes
        .filter((node) => node.provenance === "host_fact")
        .map((node) => node.id),
    ).toEqual([
      "host:investigation",
      "host:mutation",
      "host:verification",
      "host:diff_inspection",
    ]);
    expect(
      graph.nodes.find((node) => node.id === "host:verification"),
    ).toMatchObject({
      status: "host_observed",
    });
  });

  test("marks failed or stale verification as blocked host evidence", () => {
    const codeFailed = replayTaskGraphV1(
      appendTaskGraphFactsV1([], {
        filesRead: 1,
        shellRevision: 1,
        mutationRevision: 2,
        verification: "code_failed",
        verificationMutationRevision: 2,
        diffInspectedRevision: 0,
        lastTool: "workspace.run_shell",
        lastToolOk: false,
      }),
    );
    expect(
      codeFailed.nodes.find((node) => node.id === "host:verification"),
    ).toMatchObject({ status: "blocked", reason: "code_failed" });

    const stale = replayTaskGraphV1(
      appendTaskGraphFactsV1([], {
        filesRead: 1,
        shellRevision: 2,
        mutationRevision: 2,
        verification: "passed",
        verificationMutationRevision: 1,
        diffInspectedRevision: 0,
        lastTool: "workspace.edit_file",
        lastToolOk: true,
      }),
    );
    expect(
      stale.nodes.find((node) => node.id === "host:verification"),
    ).toMatchObject({ status: "blocked", reason: "stale_verification" });
  });

  test("a later harness diagnostic does not erase a current host pass", () => {
    const state = new TaskStateManager("fix source").snapshot();
    const withTests = {
      ...state,
      mutationRevision: 1,
      testResults: [
        {
          command: "bun test",
          passed: true,
          outcome: "passed" as const,
          summary: "passed",
          mutationRevision: 1,
        },
        {
          command: "missing diagnostic",
          passed: false,
          outcome: "harness_failed" as const,
          summary: "missing",
          mutationRevision: 1,
        },
      ],
    };
    const facts = hostFactsFromTaskStateV1(
      withTests,
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "missing diagnostic" },
      },
      { ok: false, summary: "missing", payload: {} },
    );
    expect(facts).toMatchObject({
      verification: "passed",
      verificationMutationRevision: 1,
    });
  });

  test("strict replay is identical after JSON persistence and rejects corruption", () => {
    const events = appendTaskGraphFactsV1(
      appendTaskGraphPlanV1(
        [],
        [{ id: "plan-1", task_id: "inspect", depends_on: [] }],
      ),
      {
        filesRead: 1,
        shellRevision: 0,
        mutationRevision: 0,
        verification: "none",
        verificationMutationRevision: 0,
        diffInspectedRevision: 0,
        lastTool: "workspace.read_file",
        lastToolOk: true,
      },
    );
    const restored = parseTaskGraphEventsV1(JSON.parse(JSON.stringify(events)));
    expect(replayTaskGraphV1(restored)).toEqual(replayTaskGraphV1(events));

    const corrupted = JSON.parse(JSON.stringify(events));
    corrupted[1].seq = 9;
    expect(() => parseTaskGraphEventsV1(corrupted)).toThrow(/event sequence/);
  });

  test("TaskState persists graph events and compaction context shows provenance", () => {
    const state = new TaskStateManager("Inspect source.ts");
    state.setPlan([
      {
        id: "plan-1",
        task_id: "inspect source",
        status: "completed",
        depends_on: [],
      },
    ]);
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.read_file",
        args: { path: "source.ts" },
      },
      { ok: true, summary: "read", payload: { content: "x" } },
    );

    const before = replayTaskGraphV1(state.snapshot().taskGraphEvents);
    const restored = new TaskStateManager(
      "ignored",
      JSON.parse(JSON.stringify(state.snapshot())),
    );
    const eventCountBeforePlanRestore =
      restored.snapshot().taskGraphEvents?.length;
    restored.setPlan([
      {
        id: "plan-1",
        task_id: "inspect source",
        status: "completed",
        depends_on: [],
      },
    ]);
    expect(restored.snapshot().taskGraphEvents).toHaveLength(
      eventCountBeforePlanRestore ?? 0,
    );
    const after = replayTaskGraphV1(restored.snapshot().taskGraphEvents);
    expect(after).toEqual(before);
    expect(formatTaskStateForContext(restored.snapshot())).toContain(
      "plan_proposal/claimed_done/model_proposal",
    );
    expect(formatTaskGraphV1(after)).toContain(
      "host:investigation [host_milestone/host_observed/host_fact]",
    );
  });
});
