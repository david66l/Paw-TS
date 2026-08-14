import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEvent, RunEventEnvelope } from "@paw/core";
import { FakeLanguageModel } from "@paw/models";

import {
  createLoopV2ShadowObserver,
  materializeCandidateArtifactV2,
} from "../src/loop-v2/index.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

function legacyEnvelope(
  seq: number,
  event: RunEvent,
  runId = "shadow-r19",
): RunEventEnvelope {
  return { runId, seq, ts: 10_000 + seq, event };
}

describe("Loop Kernel v2 shadow migration", () => {
  test("rich read facts project exact coverage while repeated spans stay non-progress", () => {
    const observer = createLoopV2ShadowObserver("shadow-r19");
    observer.observe(
      legacyEnvelope(1, { type: "run.started", goal: "Inspect src/a.ts" }),
    );
    for (const seq of [2, 3]) {
      observer.observe(
        legacyEnvelope(seq, {
          type: "tool.result",
          tool: "workspace.read_file",
          ok: true,
          summary: "Read two lines",
        }),
      );
      observer.observeToolCommit({
        sourceSeq: seq,
        callId: `call-${seq}`,
        tool: "workspace.read_file",
        args: { path: "src/a.ts", offset: 10, limit: 2 },
        result: {
          ok: true,
          summary: "Read two lines",
          payload: { content: "alpha\nbeta", line_count: 2 },
        },
        repositoryRevision: "run:shadow-r19:mutation:0",
        sourceContentHash: "sha256:full-file-r0",
        concurrentMutation: false,
      });
    }

    const report = observer.snapshot();
    expect(report.coverage).toEqual({
      observed: 3,
      projected: 3,
      gaps: 0,
      ignored: 0,
    });
    expect(report.projectedEvents).toHaveLength(3);
    expect(report.artifactBlobs).toHaveLength(1);
    const evidence = Object.values(report.state.evidence);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.observationCount).toBe(2);
    expect(evidence[0]?.observation).toEqual({
      kind: "read",
      path: "src/a.ts",
      start: 10,
      endExclusive: 12,
      contentHash: "sha256:full-file-r0",
      repositoryRevision: "run:shadow-r19:mutation:0",
      artifactRef: report.artifactBlobs[0]?.ref,
    });
    expect(report.diagnostics.slice(1).map((item) => item.reason)).toEqual([
      "rich_read_projected",
      "rich_read_projected",
    ]);
  });

  test("rich search is hashed from raw results and a racing mutation stays a gap", () => {
    const observer = createLoopV2ShadowObserver("shadow-r19");
    observer.observe(
      legacyEnvelope(1, { type: "run.started", goal: "Find the symbol" }),
    );
    observer.observe(
      legacyEnvelope(2, {
        type: "tool.result",
        tool: "workspace.search",
        ok: true,
        summary: "one match",
      }),
    );
    observer.observeToolCommit({
      sourceSeq: 2,
      callId: "search-2",
      tool: "workspace.search",
      args: { path: "src", pattern: "needle", case_sensitive: true },
      result: {
        ok: true,
        summary: "one match",
        payload: { matches: [{ path: "src/a.ts", line: 3, text: "needle" }] },
      },
      repositoryRevision: "run:shadow-r19:mutation:0",
      concurrentMutation: false,
    });
    observer.observe(
      legacyEnvelope(3, {
        type: "tool.result",
        tool: "workspace.read_file",
        ok: true,
        summary: "raced read",
      }),
    );
    observer.observeToolCommit({
      sourceSeq: 3,
      callId: "read-3",
      tool: "workspace.read_file",
      args: { path: "src/a.ts" },
      result: {
        ok: true,
        summary: "raced read",
        payload: { content: "needle", line_count: 1 },
      },
      repositoryRevision: "run:shadow-r19:mutation:0",
      sourceContentHash: "sha256:full-file-r0",
      concurrentMutation: true,
    });

    const report = observer.snapshot();
    expect(Object.values(report.state.evidence)).toHaveLength(1);
    expect(Object.values(report.state.evidence)[0]?.observation.kind).toBe(
      "search",
    );
    expect(report.coverage).toEqual({
      observed: 3,
      projected: 2,
      gaps: 1,
      ignored: 0,
    });
    expect(report.diagnostics.at(-1)?.reason).toBe(
      "rich_concurrent_mutation_ambiguous",
    );
  });

  test("two captured file commits form a continuous, reconstructible mutation journal", () => {
    const observer = createLoopV2ShadowObserver("shadow-r19");
    observer.observe(
      legacyEnvelope(1, {
        type: "run.started",
        goal: "Create then edit a file",
      }),
    );
    const commits = [
      { seq: 2, before: null, after: "value = 1\n" },
      { seq: 3, before: "value = 1\n", after: "value = 2\n" },
    ] as const;
    for (const commit of commits) {
      observer.observe(
        legacyEnvelope(commit.seq, {
          type: "tool.result",
          tool: "workspace.write_file",
          ok: true,
          summary: "wrote src/value.py",
          workspaceEffect: { changed: true, paths: ["src/value.py"] },
        }),
      );
      observer.observeToolCommit({
        sourceSeq: commit.seq,
        callId: `write-${commit.seq}`,
        tool: "workspace.write_file",
        args: { path: "src/value.py" },
        result: { ok: true, summary: "wrote", payload: { changed: true } },
        repositoryRevision: `run:shadow-r19:mutation:${commit.seq - 2}`,
        concurrentMutation: true,
        mutationCapture: {
          status: "complete",
          paths: ["src/value.py"],
          beforeContents: { "src/value.py": commit.before },
          afterContents: { "src/value.py": commit.after },
        },
      });
    }

    const report = observer.snapshot();
    const mutations = Object.values(report.state.mutations);
    expect(mutations.map((mutation) => mutation.mutationRevision)).toEqual([
      1, 2,
    ]);
    expect(report.diagnostics.slice(1).map((item) => item.reason)).toEqual([
      "rich_mutation_projected",
      "rich_mutation_projected",
    ]);
    const artifact = materializeCandidateArtifactV2(
      mutations,
      report.artifactBlobs,
      { status: "unavailable", detail: "shadow does not require Git" },
    );
    expect(artifact.status).toBe("valid");
    expect(artifact.changedPaths).toEqual(["src/value.py"]);
    expect(artifact.patch).toContain("+value = 2");
    expect(artifact.patch).not.toContain("+value = 1");
  });

  test("unbounded mutation captures stay explicit gaps", () => {
    const observer = createLoopV2ShadowObserver("shadow-r19");
    observer.observe(
      legacyEnvelope(1, { type: "run.started", goal: "Change safely" }),
    );
    observer.observe(
      legacyEnvelope(2, {
        type: "tool.result",
        tool: "workspace.run_shell",
        ok: true,
        summary: "shell completed",
        workspaceEffect: { changed: true, paths: ["src/a.ts"] },
      }),
    );
    observer.observeToolCommit({
      sourceSeq: 2,
      callId: "shell-2",
      tool: "workspace.run_shell",
      args: { command: "generate" },
      result: { ok: true, summary: "shell completed", payload: {} },
      repositoryRevision: "run:shadow-r19:mutation:0",
      concurrentMutation: true,
      mutationCapture: {
        status: "gap",
        reason: "unbounded_mutation_surface",
      },
    });

    const report = observer.snapshot();
    expect(Object.keys(report.state.mutations)).toHaveLength(0);
    expect(report.diagnostics.at(-1)?.reason).toBe("rich_mutation_capture_gap");
  });

  test("R19 projects only facts proved by the legacy event contract", () => {
    const observer = createLoopV2ShadowObserver("shadow-r19");
    observer.observe(
      legacyEnvelope(1, {
        type: "run.started",
        goal: "Fix the bug and verify the behavior.",
      }),
    );
    observer.observe(
      legacyEnvelope(2, {
        type: "tool.result",
        tool: "workspace.read_file",
        ok: true,
        summary: "Read 200 lines",
        detail: "truncated legacy payload",
      }),
    );
    observer.observe(
      legacyEnvelope(3, {
        type: "tool.result",
        tool: "workspace.edit_file",
        ok: true,
        summary: "Edited src/a.ts",
        workspaceEffect: { changed: true, paths: ["src/a.ts"] },
        fileChanges: [
          { path: "src/a.ts", added: 1, removed: 1, diff: "truncated" },
        ],
      }),
    );
    observer.observe(
      legacyEnvelope(4, {
        type: "agent.action",
        action: { type: "final_answer", summary: "Done" },
      }),
    );

    const report = observer.snapshot();
    expect(report.projectedEvents).toHaveLength(1);
    expect(report.projectedEvents[0]?.event.type).toBe("task.started");
    expect(report.state.goal?.verbatim).toBe(
      "Fix the bug and verify the behavior.",
    );
    expect(Object.keys(report.state.evidence)).toHaveLength(0);
    expect(Object.keys(report.state.mutations)).toHaveLength(0);
    expect(report.state.currentCandidate).toBeUndefined();
    expect(report.coverage).toEqual({
      observed: 4,
      projected: 1,
      gaps: 3,
      ignored: 0,
    });
    expect(report.diagnostics.map((item) => item.reason)).toEqual([
      "task_started_projected",
      "legacy_evidence_missing_content_identity",
      "legacy_mutation_missing_content_refs",
      "legacy_candidate_missing_certification_input",
    ]);
  });

  test("shadow reports are deterministic and reject cross-run or reordered input", () => {
    const events = [
      legacyEnvelope(1, { type: "run.started", goal: "Inspect safely" }),
      legacyEnvelope(2, { type: "phase", name: "tool" }),
      legacyEnvelope(3, {
        type: "compression.auto_compact.done",
        afterTokens: 20,
        summaryTokens: 5,
      }),
    ];
    const first = createLoopV2ShadowObserver("shadow-r19");
    const second = createLoopV2ShadowObserver("shadow-r19");
    for (const event of events) {
      first.observe(event);
      second.observe(event);
    }

    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.snapshot().reportHash).toBe(second.snapshot().reportHash);
    expect(first.snapshot().coverage).toEqual({
      observed: 3,
      projected: 1,
      gaps: 1,
      ignored: 1,
    });
    const finalEvent = events.at(-1);
    if (!finalEvent) throw new Error("Expected a final fixture event");
    expect(() => first.observe(finalEvent)).toThrow(/sequence must increase/);
    expect(() =>
      first.observe(
        legacyEnvelope(4, { type: "run.started", goal: "x" }, "other"),
      ),
    ).toThrow(/run mismatch/);
  });

  test("v2-shadow leaves the authoritative v1 result and event stream unchanged", async () => {
    const makeWorkspace = (suffix: string) => {
      const dir = mkdtempSync(path.join(tmpdir(), `paw-shadow-${suffix}-`));
      writeFileSync(path.join(dir, "note.txt"), "same input", "utf8");
      return dir;
    };
    const v1Events: RunEventEnvelope[] = [];
    const shadowEvents: RunEventEnvelope[] = [];
    const v1 = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      memoryExtraction: "off",
      memoryLlm: "off",
      loopKernelVersion: "v1",
      onEvent: (event) => v1Events.push(event),
    });
    let terminalReports = 0;
    const shadow = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      memoryExtraction: "off",
      memoryLlm: "off",
      loopKernelVersion: "v2-shadow",
      onEvent: (event) => shadowEvents.push(event),
      onLoopV2ShadowReport: () => {
        terminalReports += 1;
        throw new Error("diagnostic consumer failure");
      },
    });

    const [v1Result, shadowResult] = await Promise.all([
      v1.run({
        runId: "shadow-parity",
        goal: "read file 'note.txt'",
        workspaceRoot: makeWorkspace("v1"),
      }),
      shadow.run({
        runId: "shadow-parity",
        goal: "read file 'note.txt'",
        workspaceRoot: makeWorkspace("v2"),
      }),
    ]);

    expect(shadowResult).toEqual(v1Result);
    expect(shadowEvents.map((item) => item.event.type)).toEqual(
      v1Events.map((item) => item.event.type),
    );
    expect(v1.getLastLoopV2ShadowReport()).toBeUndefined();
    const report = shadow.getLastLoopV2ShadowReport();
    const terminal = [...shadowEvents]
      .reverse()
      .find(
        (item) =>
          item.event.type === "run.completed" ||
          item.event.type === "run.failed",
      );
    expect(report?.sourceThroughSeq).toBe(terminal?.seq);
    expect(report?.projectedEvents).toHaveLength(2);
    expect(Object.keys(report?.state.evidence ?? {})).toHaveLength(1);
    expect(
      report?.diagnostics.some(
        (diagnostic) => diagnostic.reason === "rich_read_projected",
      ),
    ).toBe(true);
    expect(terminalReports).toBe(1);
  });

  test("live v2-shadow captures a complete write without changing completion", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-shadow-write-"));
    const shadow = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      memoryExtraction: "off",
      memoryLlm: "off",
      loopKernelVersion: "v2-shadow",
    });
    const result = await shadow.run({
      runId: "shadow-live-write",
      goal: "write file 'hello.txt' 'hello world'\n[allow_skip_verify]",
      workspaceRoot: dir,
      maxSteps: 8,
    });

    expect(result.status).toBe("completed");
    const report = shadow.getLastLoopV2ShadowReport();
    const mutations = Object.values(report?.state.mutations ?? {});
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.paths).toEqual(["hello.txt"]);
    expect(mutations[0]?.beforeHashes["hello.txt"]).toBeNull();
    expect(mutations[0]?.afterHashes["hello.txt"]).toMatch(/^sha256:/);
    expect(
      report?.diagnostics.some(
        (item) => item.reason === "rich_mutation_projected",
      ),
    ).toBe(true);
  });
});
