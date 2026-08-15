import { describe, expect, test } from "bun:test";

import {
  parseCapabilityExposureTraceV1,
  summarizeCapabilityExposureV1,
} from "../src/capability-exposure-summary.js";

function trace(runId: string, outcome: "hit" | "fallback" | "no_tool") {
  const actualTools = outcome === "no_tool" ? [] : ["workspace.read_file"];
  const outsideSuggestion =
    outcome === "fallback" ? ["workspace.read_file"] : [];
  return JSON.stringify([
    {
      runId,
      seq: 1,
      ts: 1,
      event: {
        type: "capability.inventory",
        schemaVersion: "paw.capability-exposure.v1",
        mode: "shadow",
        fullToolCount: 32,
        fullToolTokens: 3_200,
        suggestedToolCount: 20,
        suggestedToolTokens: 2_000,
        estimatedSavingsTokens: 1_200,
        suggestedTools: [],
        deferredTools: [],
      },
    },
    {
      runId,
      seq: 2,
      ts: 2,
      event: {
        type: "capability.selection",
        schemaVersion: "paw.capability-exposure.v1",
        mode: "shadow",
        turn: 0,
        actualTools,
        suggestedTools: [],
        outsideSuggestion,
        outcome,
        exposedToolCount: 32,
      },
    },
  ]);
}

function publicResult(runId: string, resolved = true): string {
  return JSON.stringify({
    runId,
    runner: "paw",
    instanceId: "owner__repo-123",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    artifactStatus: "valid",
    integrity: { valid: true, violations: [] },
    resolved,
    resolvedSource: resolved ? "swebench_harness" : "none",
  });
}

describe("capability exposure evidence summary", () => {
  test("parses a valid trace and links its external result", () => {
    const run = parseCapabilityExposureTraceV1({
      tracePath: "run/trace.json",
      traceRaw: trace("run-1", "hit"),
      resultRaw: publicResult("run-1"),
    });
    expect(run.valid).toBe(true);
    expect(run.linkedResult).toBe(true);
    expect(run.evidenceClass).toBe("public_benchmark");
    expect(run.resolved).toBe(true);
    expect(run.estimatedSavingsTokens).toBe(1_200);
  });

  test("fails closed on missing shadow events", () => {
    const run = parseCapabilityExposureTraceV1({
      tracePath: "old/trace.json",
      traceRaw: JSON.stringify([
        { runId: "old", seq: 1, ts: 1, event: { type: "run.started" } },
      ]),
    });
    const summary = summarizeCapabilityExposureV1([run], [], 1);
    expect(run.valid).toBe(false);
    expect(summary.shadowCoverageReady).toBe(false);
    expect(summary.hardActivationReady).toBe(false);
  });

  test("requires clean zero-fallback coverage before a controlled trial", () => {
    const hits = Array.from({ length: 10 }, (_, index) =>
      parseCapabilityExposureTraceV1({
        tracePath: `run-${index}/trace.json`,
        traceRaw: trace(`run-${index}`, "hit"),
        resultRaw: publicResult(`run-${index}`),
      }),
    );
    const ready = summarizeCapabilityExposureV1(hits);
    expect(ready.shadowCoverageReady).toBe(true);
    expect(ready.hardActivationReady).toBe(false);
    expect(ready.blockers).toContain(
      "controlled memory-off full-vs-deferred resolved comparison missing",
    );

    const fallback = parseCapabilityExposureTraceV1({
      tracePath: "fallback/trace.json",
      traceRaw: trace("fallback", "fallback"),
      resultRaw: publicResult("fallback"),
    });
    const blocked = summarizeCapabilityExposureV1([...hits, fallback]);
    expect(blocked.shadowCoverageReady).toBe(false);
    expect(blocked.fallbackSelections).toBe(1);
    expect(blocked.outsideSuggestion).toEqual([
      { tool: "workspace.read_file", count: 1 },
    ]);
  });

  test("never counts deterministic diagnostics as public evidence", () => {
    const diagnostics = Array.from({ length: 10 }, (_, index) =>
      parseCapabilityExposureTraceV1({
        tracePath: `diagnostic-${index}/trace.json`,
        traceRaw: trace(`diagnostic-${index}`, "hit"),
        resultRaw: JSON.stringify({
          runId: `diagnostic-${index}`,
          runner: "paw-diagnostic",
          resolved: true,
        }),
      }),
    );
    const summary = summarizeCapabilityExposureV1(diagnostics);
    expect(summary.structurallyValidRuns).toBe(10);
    expect(summary.diagnosticRuns).toBe(10);
    expect(summary.qualifyingRuns).toBe(0);
    expect(summary.hitSelections).toBe(10);
    expect(summary.qualifyingToolSelections).toBe(0);
    expect(summary.shadowCoverageReady).toBe(false);
  });
});
