import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileSystemAppStateStore,
  InMemoryAppStateStore,
  appStateSummary,
  isAppStateFinished,
  type AppState,
} from "../src/app-state.js";

function makeState(overrides?: Partial<AppState>): AppState {
  return {
    runId: "test-run",
    goal: "test goal",
    workspaceRoot: "/tmp",
    turn: 0,
    maxSteps: 10,
    messages: [],
    savedAt: Date.now(),
    ...overrides,
  };
}

describe("InMemoryAppStateStore", () => {
  test("save and load", () => {
    const store = new InMemoryAppStateStore();
    const state = makeState({ runId: "r1" });
    store.save(state);
    const loaded = store.load("r1");
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("r1");
    expect(loaded!.goal).toBe("test goal");
  });

  test("load missing returns null", () => {
    const store = new InMemoryAppStateStore();
    expect(store.load("missing")).toBeNull();
  });

  test("list returns saved states sorted by savedAt desc", () => {
    const store = new InMemoryAppStateStore();
    store.save(makeState({ runId: "a", savedAt: 1000 }));
    store.save(makeState({ runId: "b", savedAt: 2000 }));
    const list = store.list();
    expect(list.length).toBe(2);
    expect(list[0]!.runId).toBe("b");
    expect(list[1]!.runId).toBe("a");
  });

  test("delete removes state", () => {
    const store = new InMemoryAppStateStore();
    store.save(makeState({ runId: "r1" }));
    store.delete("r1");
    expect(store.load("r1")).toBeNull();
  });
});

describe("FileSystemAppStateStore", () => {
  let tmpDir: string;
  let store: FileSystemAppStateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paw-app-state-"));
    store = new FileSystemAppStateStore({ statesDir: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("save and load", () => {
    const state = makeState({ runId: "r1" });
    store.save(state);
    const loaded = store.load("r1");
    expect(loaded).not.toBeNull();
    expect(loaded!.runId).toBe("r1");
  });

  test("load missing returns null", () => {
    expect(store.load("missing")).toBeNull();
  });

  test("list returns saved states", () => {
    store.save(makeState({ runId: "a", savedAt: 1000 }));
    store.save(makeState({ runId: "b", savedAt: 2000 }));
    const list = store.list();
    expect(list.length).toBe(2);
    expect(list[0]!.runId).toBe("b");
  });

  test("delete removes file", () => {
    store.save(makeState({ runId: "r1" }));
    store.delete("r1");
    expect(store.load("r1")).toBeNull();
  });
});

describe("selectors", () => {
  test("isAppStateFinished true when outcome present", () => {
    const state = makeState({
      outcome: { status: "completed", message: "done" },
    });
    expect(isAppStateFinished(state)).toBe(true);
  });

  test("isAppStateFinished false when no outcome", () => {
    const state = makeState();
    expect(isAppStateFinished(state)).toBe(false);
  });

  test("appStateSummary includes runId and goal", () => {
    const state = makeState({ runId: "abc", goal: "hello world" });
    const summary = appStateSummary(state);
    expect(summary).toContain("Run abc");
    expect(summary).toContain("hello world");
  });

  test("appStateSummary truncates long goal", () => {
    const state = makeState({ goal: "a".repeat(100) });
    const summary = appStateSummary(state);
    expect(summary).toContain("…");
  });
});
