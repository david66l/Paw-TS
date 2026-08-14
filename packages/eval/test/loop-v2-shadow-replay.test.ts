import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseLoopV2ShadowArtifactV1 } from "@paw/agent";

import { replayPawShadowTraces } from "../src/swe-compare/shadow-replay.js";

function writeTrace(
  root: string,
  runId: string,
  events: readonly Readonly<Record<string, unknown>>[],
): string {
  const runDir = path.join(root, "benchmarks", "swe-compare", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const tracePath = path.join(runDir, "trace.json");
  writeFileSync(
    tracePath,
    `${JSON.stringify(
      events.map((event, index) => ({
        runId,
        seq: index * 10 + 1,
        ts: 30_000 + index,
        event,
      })),
      null,
      2,
    )}\n`,
    "utf8",
  );
  return tracePath;
}

describe("SWE compare loop v2 shadow replay", () => {
  test("writes verified per-run artifacts and a deterministic sorted summary", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-shadow-replay-"));
    const second = writeTrace(root, "paw-second", [
      { type: "run.started", goal: "Inspect failure" },
      { type: "run.failed", message: "timeout" },
    ]);
    const first = writeTrace(root, "paw-first", [
      { type: "run.started", goal: "Fix source" },
      {
        type: "tool.result",
        tool: "workspace.edit_file",
        ok: true,
        summary: "edited",
        workspaceEffect: { changed: true, paths: ["src/a.ts"] },
      },
      {
        type: "agent.action",
        action: { type: "final_answer", summary: "done" },
      },
      { type: "run.completed", status: "completed", message: "done" },
    ]);
    const originalTrace = readFileSync(first, "utf8");

    const result = replayPawShadowTraces({
      repoRoot: root,
      tracePaths: [second, first],
      summaryName: "exposed.json",
    });

    expect(result.summary.runs.map((run) => run.runId)).toEqual([
      "paw-first",
      "paw-second",
    ]);
    expect(result.summary.totals).toEqual({
      runs: 2,
      observed: 6,
      projected: 3,
      gaps: 1,
      ignored: 2,
      validArtifacts: 0,
      readyForReview: 0,
    });
    expect(readFileSync(first, "utf8")).toBe(originalTrace);
    expect(path.basename(result.summaryPath)).toBe("exposed.json");
    for (const run of result.summary.runs) {
      const artifactPath = path.join(root, run.artifactPath);
      expect(existsSync(artifactPath)).toBeTrue();
      expect(
        parseLoopV2ShadowArtifactV1(readFileSync(artifactPath, "utf8"))
          .artifactHash,
      ).toBe(run.artifactHash);
    }

    const repeated = replayPawShadowTraces({
      repoRoot: root,
      tracePaths: [first, second],
      summaryName: "exposed.json",
    });
    expect(repeated.summary).toEqual(result.summary);
  });

  test("validates the complete batch before writing any output", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-shadow-reject-"));
    const valid = writeTrace(root, "paw-valid", [
      { type: "run.started", goal: "Inspect" },
      { type: "run.completed", status: "incomplete", message: "stopped" },
    ]);
    const invalid = writeTrace(root, "paw-invalid", [
      { type: "run.started", goal: "Inspect" },
      { type: "run.completed", status: "completed", message: "done" },
    ]);
    const parsed = JSON.parse(readFileSync(invalid, "utf8")) as Array<{
      runId: string;
    }>;
    const last = parsed.at(-1);
    if (!last) throw new Error("Missing invalid fixture event");
    last.runId = "paw-other";
    writeFileSync(invalid, JSON.stringify(parsed), "utf8");

    expect(() =>
      replayPawShadowTraces({
        repoRoot: root,
        tracePaths: [valid, invalid],
        summaryName: "rejected.json",
      }),
    ).toThrow(/trace envelope/);
    expect(
      existsSync(path.join(path.dirname(valid), "loop-v2-shadow-v1.json")),
    ).toBeFalse();
    expect(
      existsSync(
        path.join(
          root,
          "benchmarks",
          "swe-compare",
          "shadow-reports",
          "rejected.json",
        ),
      ),
    ).toBeFalse();
  });

  test("rejects Claude runs, paths outside runs, duplicate runs, and output traversal", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-shadow-boundary-"));
    const paw = writeTrace(root, "paw-one", [
      { type: "run.started", goal: "Inspect" },
    ]);
    const claude = writeTrace(root, "claude-one", [
      { type: "run.started", goal: "Inspect" },
    ]);
    const outside = path.join(root, "trace.json");
    writeFileSync(outside, "[]", "utf8");

    expect(() =>
      replayPawShadowTraces({
        repoRoot: root,
        tracePaths: [claude],
        summaryName: "x.json",
      }),
    ).toThrow(/not a Paw run/);
    expect(() =>
      replayPawShadowTraces({
        repoRoot: root,
        tracePaths: [outside],
        summaryName: "x.json",
      }),
    ).toThrow(/must be below/);
    expect(() =>
      replayPawShadowTraces({
        repoRoot: root,
        tracePaths: [paw, paw],
        summaryName: "x.json",
      }),
    ).toThrow(/Duplicate/);
    expect(() =>
      replayPawShadowTraces({
        repoRoot: root,
        tracePaths: [paw],
        summaryName: "../x.json",
      }),
    ).toThrow(/JSON basename/);
  });
});
