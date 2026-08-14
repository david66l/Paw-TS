import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEvent, RunEventEnvelope } from "@paw/core";
import { FakeLanguageModel } from "@paw/models";

import { createLoopV2ShadowObserver } from "../src/loop-v2/index.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

function legacyEnvelope(
  seq: number,
  event: RunEvent,
  runId = "shadow-r19",
): RunEventEnvelope {
  return { runId, seq, ts: 10_000 + seq, event };
}

describe("Loop Kernel v2 shadow migration", () => {
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
        goal: "list the directory",
        workspaceRoot: makeWorkspace("v1"),
      }),
      shadow.run({
        runId: "shadow-parity",
        goal: "list the directory",
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
    expect(report?.projectedEvents).toHaveLength(1);
    expect(report?.coverage.gaps).toBeGreaterThan(0);
    expect(terminalReports).toBe(1);
  });
});
