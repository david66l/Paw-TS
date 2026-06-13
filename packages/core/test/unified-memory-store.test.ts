import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionMemoryStore } from "../src/session-memory.js";
import { UnifiedMemoryStore } from "../src/unified-memory-store.js";

describe("UnifiedMemoryStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paw-unified-memory-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes multiple recent session memories in the pool", () => {
    const sessionStore = new SessionMemoryStore({ workspaceRoot: tmpDir });
    sessionStore.save("run-a", {
      session: "run-a",
      project: "p",
      updatedAt: 1,
      task: "Task A",
    });
    sessionStore.save("run-b", {
      session: "run-b",
      project: "p",
      updatedAt: 2,
      task: "Task B",
    });
    sessionStore.save("run-c", {
      session: "run-c",
      project: "p",
      updatedAt: 3,
      task: "Task C",
    });

    const unified = new UnifiedMemoryStore({
      workspaceRoot: tmpDir,
      sessionPoolSize: 5,
    });
    const sessionRecords = unified
      .list()
      .filter((r) => r.source === "session")
      .map((r) => r.id);
    expect(sessionRecords).toEqual(["run-c", "run-b", "run-a"]);
  });

  it("listExcludingCurrent omits the active session id", () => {
    const sessionStore = new SessionMemoryStore({ workspaceRoot: tmpDir });
    sessionStore.save("current", {
      session: "current",
      project: "p",
      updatedAt: 2,
      task: "Current",
    });
    sessionStore.save("past", {
      session: "past",
      project: "p",
      updatedAt: 1,
      task: "Past",
    });

    const unified = new UnifiedMemoryStore({
      workspaceRoot: tmpDir,
      sessionId: "current",
    });
    const ids = unified
      .listExcludingCurrent()
      .filter((r) => r.source === "session")
      .map((r) => r.id);
    expect(ids).toEqual(["past"]);
  });
});
