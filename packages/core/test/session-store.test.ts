import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEventEnvelope } from "../src/run-events.js";
import { FileSystemSessionStore } from "../src/session-store.js";

describe("FileSystemSessionStore", () => {
  let root: string;
  let store: FileSystemSessionStore;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "paw-session-"));
    store = new FileSystemSessionStore({ workspaceRoot: root, maxRuns: 5 });
  });

  afterEach(() => {
    // cleanup handled by OS tmpdir purge
  });

  test("saves and loads events", () => {
    const env: RunEventEnvelope = {
      runId: "r1",
      seq: 1,
      ts: 1000,
      event: { type: "run.started", goal: "test" },
    };
    store.saveEvent("r1", env);
    const loaded = store.loadRun("r1");
    expect(loaded).toEqual([env]);
  });

  test("listRuns returns newest first", () => {
    store.saveEvent("r1", {
      runId: "r1",
      seq: 1,
      ts: 1000,
      event: { type: "run.started", goal: "first" },
    });
    // small delay to ensure ordering
    store.saveEvent("r2", {
      runId: "r2",
      seq: 1,
      ts: 2000,
      event: { type: "run.started", goal: "second" },
    });
    const runs = store.listRuns();
    expect(runs.length).toBe(2);
    expect(runs[0]?.runId).toBe("r2");
    expect(runs[1]?.runId).toBe("r1");
  });

  test("getRunSummary captures goal and status", () => {
    store.saveEvent("r1", {
      runId: "r1",
      seq: 1,
      ts: 1000,
      event: { type: "run.started", goal: "do thing" },
    });
    store.saveEvent("r1", {
      runId: "r1",
      seq: 2,
      ts: 2000,
      event: { type: "run.completed", status: "completed", message: "done" },
    });
    const s = store.getRunSummary("r1");
    expect(s).toBeDefined();
    expect(s?.goal).toBe("do thing");
    expect(s?.status).toBe("completed");
    expect(s?.finalMessage).toBe("done");
    expect(s?.startedAt).toBe(1000);
    expect(s?.completedAt).toBe(2000);
  });

  test("loadRun returns null for missing run", () => {
    expect(store.loadRun("nonexistent")).toBeNull();
  });

  test("deleteRun removes session file", () => {
    store.saveEvent("r1", {
      runId: "r1",
      seq: 1,
      ts: 1000,
      event: { type: "run.started", goal: "x" },
    });
    expect(store.deleteRun("r1")).toBe(true);
    expect(store.loadRun("r1")).toBeNull();
    expect(store.deleteRun("r1")).toBe(false);
  });

  test("prunes oldest runs when maxRuns exceeded", () => {
    for (let i = 0; i < 7; i++) {
      store.saveEvent(`run-${i}`, {
        runId: `run-${i}`,
        seq: 1,
        ts: 1000 + i,
        event: { type: "run.started", goal: `goal ${i}` },
      });
    }
    const runs = store.listRuns();
    expect(runs.length).toBe(5);
    // oldest (run-0, run-1) should be pruned
    expect(store.loadRun("run-0")).toBeNull();
    expect(store.loadRun("run-1")).toBeNull();
    expect(store.loadRun("run-2")).not.toBeNull();
  });

  test("sanitizes runId for filesystem", () => {
    const evilId = "../../../etc/passwd";
    store.saveEvent(evilId, {
      runId: evilId,
      seq: 1,
      ts: 1000,
      event: { type: "run.started", goal: "x" },
    });
    // Should not escape sessions dir
    const badPath = path.join(root, "..", "..", "..", "etc", "passwd.jsonl");
    expect(existsSync(badPath)).toBe(false);
    expect(store.loadRun(evilId)).not.toBeNull();
  });

  test("handles corrupt lines gracefully", () => {
    const sessionsDir = path.join(root, ".paw", "sessions");
    const p = path.join(sessionsDir, "corrupt.jsonl");
    writeFileSync(
      p,
      '{"runId":"corrupt","seq":1,"ts":1,"event":{"type":"run.started","goal":"ok"}}\nnot-json\n',
      "utf8",
    );
    const loaded = store.loadRun("corrupt");
    expect(loaded).not.toBeNull();
    expect(loaded?.length).toBe(1);
    expect(loaded?.[0]?.event.type).toBe("run.started");
  });

  test("getRunSummary counts tool calls", () => {
    store.saveEvent("r1", {
      runId: "r1",
      seq: 1,
      ts: 1000,
      event: { type: "run.started", goal: "test" },
    });
    store.saveEvent("r1", {
      runId: "r1",
      seq: 2,
      ts: 1500,
      event: { type: "tool.call", tool: "read_file", args: {} },
    });
    store.saveEvent("r1", {
      runId: "r1",
      seq: 3,
      ts: 1600,
      event: { type: "tool.call", tool: "list_dir", args: {} },
    });
    store.saveEvent("r1", {
      runId: "r1",
      seq: 4,
      ts: 2000,
      event: { type: "run.completed", status: "completed", message: "done" },
    });
    const s = store.getRunSummary("r1");
    expect(s).toBeDefined();
    expect(s?.toolCallCount).toBe(2);
  });

  test("loadRunPaginated returns a slice", () => {
    for (let i = 1; i <= 5; i++) {
      store.saveEvent("r1", {
        runId: "r1",
        seq: i,
        ts: 1000 + i,
        event: { type: "model.chunk", text: `chunk ${i}` },
      });
    }
    const page = store.loadRunPaginated("r1", 1, 2);
    expect(page).toBeDefined();
    expect(page?.total).toBe(5);
    expect(page?.events.length).toBe(2);
    expect(page?.events[0]?.seq).toBe(2);
    expect(page?.events[1]?.seq).toBe(3);
  });

  test("loadRunPaginated returns null for missing run", () => {
    expect(store.loadRunPaginated("missing", 0, 10)).toBeNull();
  });

  test("loadRunPaginated offset beyond length returns empty", () => {
    store.saveEvent("r1", {
      runId: "r1",
      seq: 1,
      ts: 1000,
      event: { type: "run.started", goal: "test" },
    });
    const page = store.loadRunPaginated("r1", 10, 5);
    expect(page).toBeDefined();
    expect(page?.events.length).toBe(0);
    expect(page?.total).toBe(1);
  });

  test("replayRun yields all events in order", async () => {
    for (let i = 1; i <= 3; i++) {
      store.saveEvent("r1", {
        runId: "r1",
        seq: i,
        ts: 1000 + i,
        event: { type: "model.chunk", text: `chunk ${i}` },
      });
    }
    const iterable = store.replayRun("r1");
    expect(iterable).not.toBeNull();
    const collected: RunEventEnvelope[] = [];
    for await (const ev of iterable!) {
      collected.push(ev);
    }
    expect(collected.length).toBe(3);
    expect(collected[0]?.seq).toBe(1);
    expect(collected[2]?.seq).toBe(3);
  });

  test("replayRun returns null for missing run", () => {
    expect(store.replayRun("missing")).toBeNull();
  });

  test("replayRun skips corrupt lines", async () => {
    const sessionsDir = path.join(root, ".paw", "sessions");
    const p = path.join(sessionsDir, "corrupt.jsonl");
    writeFileSync(
      p,
      '{"runId":"corrupt","seq":1,"ts":1,"event":{"type":"run.started","goal":"ok"}}\nnot-json\n{"runId":"corrupt","seq":2,"ts":2,"event":{"type":"run.completed","status":"completed","message":"done"}}\n',
      "utf8",
    );
    const iterable = store.replayRun("corrupt");
    expect(iterable).not.toBeNull();
    const collected: RunEventEnvelope[] = [];
    for await (const ev of iterable!) {
      collected.push(ev);
    }
    expect(collected.length).toBe(2);
    expect(collected[0]?.event.type).toBe("run.started");
    expect(collected[1]?.event.type).toBe("run.completed");
  });
});
