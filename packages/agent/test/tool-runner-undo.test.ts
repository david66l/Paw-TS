import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RunEvent, RunEventEnvelope } from "@paw/core";
import { inspectLastSafeFileMutationCheckpoint } from "@paw/core";

import {
  createLoopV2ShadowObserver,
  observeLoopV2DurableEnvelopeV1,
  replayLegacyTraceToLoopV2ShadowV1,
} from "../src/loop-v2/index.js";
import {
  commitToolExecutionResult,
  executeToolCalls,
} from "../src/orchestrator/tool-runner.js";
import { TaskStateManager } from "../src/task-state.js";

describe("safe Agent edit undo", () => {
  test("finalizes an edit checkpoint and restores it without checkpointing the undo", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-tool-undo-"),
    );
    const sourcePath = path.join(workspaceRoot, "source.txt");
    fs.writeFileSync(sourcePath, "before\n", "utf8");
    const checkpointSeq = { n: 0 };
    const context = {
      workspaceRoot,
      runId: "run-tool-undo",
      emit: () => {},
      checkpointSeq,
      captureLoopV2Facts: true,
      allowedTools: ["workspace.edit_file", "workspace.undo_last_edit"],
    } as const;

    const edited = await executeToolCalls(
      [
        {
          type: "tool_call" as const,
          tool: "workspace.edit_file",
          args: {
            path: "source.txt",
            old_string: "before",
            new_string: "after",
          },
        },
      ],
      context,
      {},
    );

    expect(edited.results[0]?.ok).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("after\n");
    expect(checkpointSeq.n).toBe(1);
    expect(
      inspectLastSafeFileMutationCheckpoint(workspaceRoot, context.runId)
        .status,
    ).toBe("ready");

    const undone = await executeToolCalls(
      [
        {
          type: "tool_call" as const,
          tool: "workspace.undo_last_edit",
          args: {},
        },
      ],
      context,
      {},
    );

    expect(undone.results[0]?.ok).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("before\n");
    expect(checkpointSeq.n).toBe(1);
    expect(undone.mutationCaptures[0]).toEqual({
      status: "complete",
      paths: ["source.txt"],
      beforeContents: { "source.txt": "after\n" },
      afterContents: { "source.txt": "before\n" },
    });
    expect(
      inspectLastSafeFileMutationCheckpoint(workspaceRoot, context.runId),
    ).toEqual({ status: "none" });

    const trace: RunEventEnvelope[] = [
      {
        runId: context.runId,
        seq: 1,
        ts: 1,
        event: { type: "run.started", goal: "edit and then undo source.txt" },
      },
    ];
    const taskState = new TaskStateManager("edit and then undo source.txt");
    const emit = (event: RunEvent) => {
      trace.push({
        runId: context.runId,
        seq: trace.length + 1,
        ts: trace.length + 1,
        event,
      });
    };
    commitToolExecutionResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: {
          path: "source.txt",
          old_string: "before",
          new_string: "after",
        },
      },
      edited.results[0]!,
      0,
      {
        emit,
        runId: context.runId,
        workspaceRoot,
        turn: 1,
        taskState,
        captureLoopV2Facts: true,
      },
      {
        concurrentMutation: false,
        mutationCapture: edited.mutationCaptures[0],
      },
    );
    commitToolExecutionResult(
      {
        type: "tool_call",
        tool: "workspace.undo_last_edit",
        args: {},
      },
      undone.results[0]!,
      0,
      {
        emit,
        runId: context.runId,
        workspaceRoot,
        turn: 2,
        taskState,
        captureLoopV2Facts: true,
      },
      {
        concurrentMutation: false,
        mutationCapture: undone.mutationCaptures[0],
      },
    );

    const live = createLoopV2ShadowObserver(context.runId);
    for (const envelope of trace) {
      observeLoopV2DurableEnvelopeV1(live, envelope);
    }
    const replayed = replayLegacyTraceToLoopV2ShadowV1(context.runId, trace);
    expect(replayed).toEqual(live.snapshot());
    expect(replayed.state.currentMutationRevision).toBe(2);
    expect(
      replayed.projectedEvents.filter(
        (envelope) => envelope.event.type === "mutation.recorded",
      ),
    ).toHaveLength(2);
    expect(taskState.snapshot().mutationRevision).toBe(2);
  });

  test("a rejected Paw-state write cannot shadow the previous real edit", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-tool-undo-reserved-"),
    );
    const sourcePath = path.join(workspaceRoot, "source.txt");
    fs.writeFileSync(sourcePath, "before\n", "utf8");
    const checkpointSeq = { n: 0 };
    const context = {
      workspaceRoot,
      runId: "audit",
      emit: () => {},
      checkpointSeq,
      captureLoopV2Facts: true,
      allowedTools: [
        "workspace.edit_file",
        "workspace.write_file",
        "workspace.undo_last_edit",
      ],
    } as const;

    const edited = await executeToolCalls(
      [
        {
          type: "tool_call" as const,
          tool: "workspace.edit_file",
          args: {
            path: "source.txt",
            old_string: "before",
            new_string: "after",
          },
        },
      ],
      context,
      {},
    );
    expect(edited.results[0]?.ok).toBe(true);

    const rejected = await executeToolCalls(
      [
        {
          type: "tool_call" as const,
          tool: "workspace.write_file",
          args: {
            path: ".paw/checkpoints/audit/2/_meta.json",
            content: "not checkpoint metadata",
          },
        },
      ],
      context,
      {},
    );

    expect(rejected.results[0]).toMatchObject({
      ok: false,
      payload: { code: "E_CHECKPOINT", executed: false },
    });
    expect(rejected.mutationCaptures[0]).toEqual({
      status: "complete",
      paths: [],
      beforeContents: {},
      afterContents: {},
    });
    const inspection = inspectLastSafeFileMutationCheckpoint(
      workspaceRoot,
      context.runId,
    );
    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") throw new Error("expected ready");
    expect(inspection.entry.seq).toBe(1);

    const undone = await executeToolCalls(
      [
        {
          type: "tool_call" as const,
          tool: "workspace.undo_last_edit",
          args: {},
        },
      ],
      context,
      {},
    );
    expect(undone.results[0]?.ok).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("before\n");
  });

  test("legacy batches serialize an edit followed by undo in source order", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-tool-undo-batch-"),
    );
    const sourcePath = path.join(workspaceRoot, "source.txt");
    fs.writeFileSync(sourcePath, "before\n", "utf8");
    const context = {
      workspaceRoot,
      runId: "run-tool-undo-batch",
      emit: () => {},
      checkpointSeq: { n: 0 },
      captureLoopV2Facts: true,
      allowedTools: ["workspace.edit_file", "workspace.undo_last_edit"],
    } as const;

    const batch = await executeToolCalls(
      [
        {
          type: "tool_call" as const,
          tool: "workspace.edit_file",
          args: {
            path: "source.txt",
            old_string: "before",
            new_string: "after",
          },
        },
        {
          type: "tool_call" as const,
          tool: "workspace.undo_last_edit",
          args: {},
        },
      ],
      context,
      {},
    );

    expect(batch.results.map((result) => result.ok)).toEqual([true, true]);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("before\n");
    expect(batch.mutationCaptures).toEqual([
      {
        status: "complete",
        paths: ["source.txt"],
        beforeContents: { "source.txt": "before\n" },
        afterContents: { "source.txt": "after\n" },
      },
      {
        status: "complete",
        paths: ["source.txt"],
        beforeContents: { "source.txt": "after\n" },
        afterContents: { "source.txt": "before\n" },
      },
    ]);
  });

  test("a post-effect checkpoint failure preserves the real tool result and capture", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-tool-checkpoint-finalize-"),
    );
    const sourcePath = path.join(workspaceRoot, "source.txt");
    fs.writeFileSync(sourcePath, "before\n", "utf8");
    const context = {
      workspaceRoot,
      runId: "run-finalize-failure",
      emit: () => {},
      checkpointSeq: { n: 0 },
      captureLoopV2Facts: true,
      allowedTools: ["workspace.edit_file"],
      toolEffectPolicy: {
        prepare() {
          return {};
        },
        settle() {
          fs.writeFileSync(
            path.join(
              workspaceRoot,
              ".paw",
              "checkpoints",
              "run-finalize-failure",
              "1",
              "_meta.json",
            ),
            JSON.stringify({ malformed: true }),
            "utf8",
          );
          return { allowed: true as const };
        },
      },
    } as const;

    const batch = await executeToolCalls(
      [
        {
          type: "tool_call" as const,
          tool: "workspace.edit_file",
          args: {
            path: "source.txt",
            old_string: "before",
            new_string: "after",
          },
        },
      ],
      context,
      {},
    );

    expect(batch.results[0]?.ok).toBe(true);
    expect(batch.results[0]?.summary).toContain("Checkpoint:finalize_failed");
    expect(batch.results[0]?.payload).toMatchObject({
      checkpoint: { finalized: false, seq: 1 },
    });
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("after\n");
    expect(batch.mutationCaptures[0]).toEqual({
      status: "complete",
      paths: ["source.txt"],
      beforeContents: { "source.txt": "before\n" },
      afterContents: { "source.txt": "after\n" },
    });
  });
});
