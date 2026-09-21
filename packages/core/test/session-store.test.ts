import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEventEnvelope } from "../src/run-events.js";
import { FileSystemSessionStore } from "../src/session-store.js";
import { sanitizeRunId, toolResultsDir } from "../src/workspace-paths.js";

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

  test("round-trips a rich tool decision commit without losing replay facts", () => {
    const env: RunEventEnvelope = {
      runId: "rich-tool",
      seq: 7,
      ts: 1_007,
      event: {
        type: "tool.result",
        tool: "workspace.edit_file",
        ok: true,
        summary: "edited src/value.ts",
        decisionCommit: {
          schemaVersion: "paw.tool-decision-commit.v1",
          callId: "legacy:rich-tool:turn:2:call:0",
          tool: "workspace.edit_file",
          args: { path: "src/value.ts", old_string: "a", new_string: "b" },
          result: {
            ok: true,
            payload: { path: "src/value.ts", linesAdded: 1, linesRemoved: 1 },
            summary: "edited src/value.ts",
          },
          repositoryRevision: "run:rich-tool:mutation:0",
          concurrentMutation: false,
          mutationCapture: {
            status: "complete",
            paths: ["src/value.ts"],
            beforeContents: { "src/value.ts": "a\n" },
            afterContents: { "src/value.ts": "b\n" },
          },
          verificationCapture: {
            runner: "bun_test",
            argv: ["bun", "test"],
            cwd: ".",
            scope: ["src/value.ts"],
            mutationRevision: 1,
            outcome: "passed",
            exitCode: 0,
            output: "1 pass",
            authoritative: true,
          },
        },
      },
    };
    store.saveEvent(env.runId, env);
    expect(store.loadRun(env.runId)).toEqual([env]);
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
    expect(() => store.loadRunStrict("corrupt")).toThrow(
      /line 2 is not valid JSON/,
    );
  });

  test("strict journal loading rejects reordered event identities", () => {
    const sessionsDir = path.join(root, ".paw", "sessions");
    const p = path.join(sessionsDir, "reordered.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({
          runId: "reordered",
          seq: 2,
          ts: 2,
          event: { type: "run.started", goal: "x" },
        }),
        JSON.stringify({
          runId: "reordered",
          seq: 1,
          ts: 3,
          event: { type: "run.failed", message: "bad" },
        }),
      ].join("\n"),
      "utf8",
    );
    expect(() => store.loadRunStrict("reordered")).toThrow(
      /sequence must increase/,
    );
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

  test("replayRun can be iterated more than once", async () => {
    for (let i = 1; i <= 3; i++) {
      store.saveEvent("r1", {
        runId: "r1",
        seq: i,
        ts: 1000 + i,
        event: { type: "model.chunk", text: `chunk ${i}` },
      });
    }
    const iterable = store.replayRun("r1");
    const first = [];
    for await (const ev of iterable!) first.push(ev.seq);
    const second = [];
    for await (const ev of iterable!) second.push(ev.seq);
    expect(first).toEqual([1, 2, 3]);
    // 旧实现共享一条已销毁的流，第二次迭代会直接返回空。
    expect(second).toEqual([1, 2, 3]);
  });

  // eventCount 用「文件字节数 / 每行字节数」估算。旧实现拿 UTF-16 码元数当
  // 分子，中文内容会高估约 2-3 倍（每字 3 字节但只占 1 个码元）。
  test("getRunSummary estimates CJK event counts without a byte/char mismatch", () => {
    const total = 50;
    for (let i = 0; i < total; i++) {
      store.saveEvent("cjk", {
        runId: "cjk",
        seq: i + 1,
        ts: 1000 + i,
        event: {
          type: "model.chunk",
          text: `第${i}步：这是一段用于测试字节与字符长度差异的中文内容，需要足够长。`,
        },
      });
    }
    const s = store.getRunSummary("cjk");
    expect(s).toBeDefined();
    // 估算允许有误差，但不允许量纲错误带来的成倍偏差。
    expect(s?.eventCount).toBeGreaterThanOrEqual(total - 10);
    expect(s?.eventCount).toBeLessThanOrEqual(total + 15);
  });

  test("getRunSummary reads the whole first line instead of truncating at 8KB", () => {
    const sessionsDir = path.join(root, ".paw", "sessions");
    void sessionsDir;
    const longGoal = "g".repeat(20_000);
    store.saveEvent("big-head", {
      runId: "big-head",
      seq: 1,
      ts: 4242,
      event: { type: "run.started", goal: longGoal },
    });
    const s = store.getRunSummary("big-head");
    // 旧实现固定读前 8192 字节，首行超长时解析失败 → startedAt 静默变 0、goal 变空。
    expect(s?.startedAt).toBe(4242);
    expect(s?.goal).toBe(longGoal);
  });
});

describe("sanitizeRunId", () => {
  test("neutralizes all-dot ids that would act as path segments", () => {
    // `.` 与 `..` 通过字符白名单，却会被 path.join 当作目录跳转。
    expect(sanitizeRunId("..")).toBe("__");
    expect(sanitizeRunId(".")).toBe("_");
    expect(sanitizeRunId("...")).toBe("___");
  });

  test("keeps legitimate ids containing dots", () => {
    expect(sanitizeRunId("run.2026-01-01")).toBe("run.2026-01-01");
    expect(sanitizeRunId("run-1")).toBe("run-1");
  });

  test("replaces separators as before", () => {
    expect(sanitizeRunId("../../../etc/passwd")).toBe(
      ".._.._.._etc_passwd",
    );
    expect(sanitizeRunId("a/b\\c")).toBe("a_b_c");
  });

  test("toolResultsDir cannot be escaped with a dot id", () => {
    const isolated = mkdtempSync(path.join(tmpdir(), "paw-toolres-"));
    const dir = toolResultsDir(isolated, "..");
    const relative = path.relative(
      path.join(isolated, ".paw", "sessions"),
      dir,
    );
    expect(relative.startsWith("..")).toBe(false);
  });
});
