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

import { createRunOrchestrator, parseLoopV2ShadowArtifactV1 } from "@paw/agent";

import {
  persistOnlineLoopV2ShadowArtifact,
  replayPawShadowTraces,
} from "../src/swe-compare/shadow-replay.js";

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
  test("persists a live factory read-edit-verify-final report and strictly rereads it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-shadow-online-"));
    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(workspace, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspace, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    writeFileSync(path.join(workspace, "source.txt"), "before", "utf8");
    writeFileSync(
      path.join(workspace, "smoke-test.js"),
      "process.exit(0);",
      "utf8",
    );
    let modelCalls = 0;
    const model = {
      label: "online-shadow-fixture",
      async complete() {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            text: JSON.stringify({
              tool: "workspace.read_file",
              args: { path: "source.txt" },
            }),
          };
        }
        if (modelCalls === 2) {
          return {
            text: JSON.stringify({
              tool: "workspace.edit_file",
              args: {
                path: "source.txt",
                old_string: "before",
                new_string: "after",
              },
            }),
          };
        }
        if (modelCalls === 3) {
          return {
            text: JSON.stringify({
              tool: "workspace.run_shell",
              args: { command: "node smoke-test.js" },
            }),
          };
        }
        return {
          text: JSON.stringify({
            action: "final_answer",
            summary: "Implemented and verified.",
          }),
        };
      },
    };
    const runtime = createRunOrchestrator({
      workspaceRoot: workspace,
      mainModel: model,
      subAgentModel: model,
      skipAgentSeeds: true,
      memoryExtraction: "off",
      collaborationMode: "coding",
      loopKernelVersion: "v2-shadow",
      toolEffectPolicy: {
        appliesTo: ({ tool }) => tool === "workspace.run_shell",
        prepare: () => undefined,
        settle: ({ result }) => ({
          allowed: true,
          result: {
            ...result,
            payload: {
              ...(result.payload as Record<string, unknown>),
              workspaceEffect: { changed: false, paths: [] },
            },
          },
        }),
      },
    });
    try {
      const runId = "paw-online-shadow-fixture";
      const result = await runtime.orch.run({
        runId,
        goal: "Read, fix, and verify source.txt.",
        workspaceRoot: workspace,
        maxSteps: 8,
      });
      expect(result.status).toBe("completed");
      const report = runtime.orch.getLastLoopV2ShadowReport();
      if (!report) throw new Error("Missing live shadow report");
      const persisted = persistOnlineLoopV2ShadowArtifact({
        repoRoot: root,
        runId,
        report,
        policy: { verificationAuthority: "local" },
      });
      expect(persisted.artifact.assessment).toMatchObject({
        artifact: { status: "valid" },
        readiness: { disposition: "ready_for_review" },
      });
      const disk = parseLoopV2ShadowArtifactV1(
        readFileSync(path.join(root, persisted.artifactPath), "utf8"),
      );
      expect(disk).toEqual(persisted.artifact);
      expect(persisted.artifactPath).toBe(
        "benchmarks/swe-compare/runs/paw-online-shadow-fixture/loop-v2-shadow-v1.json",
      );
    } finally {
      runtime.watcher.stop();
    }

    const legacy = createRunOrchestrator({
      workspaceRoot: workspace,
      mainModel: model,
      subAgentModel: model,
      skipAgentSeeds: true,
      memoryExtraction: "off",
      collaborationMode: "coding",
    });
    try {
      const result = await legacy.orch.run({
        runId: "paw-default-v1-fixture",
        goal: "Report the completed fixture.",
        workspaceRoot: workspace,
        maxSteps: 2,
      });
      expect(result.status).toBe("completed");
      expect(legacy.orch.getLastLoopV2ShadowReport()).toBeUndefined();
    } finally {
      legacy.watcher.stop();
    }
  });

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
