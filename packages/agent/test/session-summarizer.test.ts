/**
 * Unit tests for A.2.1 + A.2.3 session summarization.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { AutoMemoryStore, type SessionMemory } from "@paw/core";
import {
  extractSessionHighlightsToAutoMemory,
  maybeGenerateShortSessionMemory,
} from "../src/orchestrator/session-summarizer.js";

// Stub LanguageModel for testing (no real LLM calls)
function stubModel(response: string) {
  return {
    label: "stub",
    async complete() {
      return { text: response };
    },
    async *completeStream() {
      yield { type: "done" as const };
    },
  };
}

describe("A.2.1: extractSessionHighlightsToAutoMemory", () => {
  test("extracts decisions and errors from session memory into auto memory", async () => {
    const dir = path.join(tmpdir(), `paw-a21-${Date.now()}`);
    const store = new AutoMemoryStore({ workspaceRoot: dir, memoryDir: path.join(dir, "memory") });

    const sessionMemory: SessionMemory = {
      session: "test-session-1",
      project: "paw-test",
      updatedAt: Date.now(),
      task: "Fix build error",
      keyDecisions: ["Use esbuild instead of tsc for faster builds", "Pin dependency versions in package.json"],
      errorsAndFixes: ["TS2307: Cannot find module → added paths to tsconfig", "Build failed: out of memory → increased Node max-old-space-size"],
    };

    const result = await extractSessionHighlightsToAutoMemory({
      sessionMemory,
      autoMemoryStore: store,
      workspaceRoot: dir,
    });

    expect(result.created + result.updated).toBeGreaterThanOrEqual(2);

    // Verify entries exist in the store
    const all = store.list();
    const decisionEntries = all.filter((e) => e.name.includes("-dec-"));
    const errorEntries = all.filter((e) => e.name.includes("-err-"));
    expect(decisionEntries.length).toBeGreaterThanOrEqual(1);
    expect(errorEntries.length).toBeGreaterThanOrEqual(1);

    // Verify content is meaningful
    for (const d of decisionEntries) {
      expect(d.content).toContain("test-session-1");
    }
    for (const e of errorEntries) {
      expect(e.content).toContain("test-session-1");
    }

    // Cleanup
    for (const e of all) store.delete(e.name);
  });

  test("skips short (< 10 char) decisions and errors", async () => {
    const dir = path.join(tmpdir(), `paw-a21-skip-${Date.now()}`);
    const store = new AutoMemoryStore({ workspaceRoot: dir, memoryDir: path.join(dir, "memory") });

    const sessionMemory: SessionMemory = {
      session: "test-session-2",
      project: "paw-test",
      updatedAt: Date.now(),
      keyDecisions: ["OK"], // too short
      errorsAndFixes: ["x".repeat(5)], // too short
    };

    const result = await extractSessionHighlightsToAutoMemory({
      sessionMemory,
      autoMemoryStore: store,
      workspaceRoot: dir,
    });

    expect(result.created + result.updated).toBe(0);
  });

  test("empty session memory returns zero", async () => {
    const dir = path.join(tmpdir(), `paw-a21-empty-${Date.now()}`);
    const store = new AutoMemoryStore({ workspaceRoot: dir, memoryDir: path.join(dir, "memory") });

    const sessionMemory: SessionMemory = {
      session: "test-session-3",
      project: "paw-test",
      updatedAt: Date.now(),
    };

    const result = await extractSessionHighlightsToAutoMemory({
      sessionMemory,
      autoMemoryStore: store,
      workspaceRoot: dir,
    });

    expect(result.created + result.updated).toBe(0);
  });
});


describe("A.2.3: maybeGenerateShortSessionMemory", () => {
  test("skips long runs (turn > 5)", async () => {
    const result = await maybeGenerateShortSessionMemory({
      runId: "test-run",
      goal: "fix build error",
      turn: 6,
      finalText: "done",
      filePaths: [],
      errors: [],
      model: stubModel("should not be called"),
      workspaceRoot: "/tmp",
    });
    expect(result).toBeNull();
  });

  test("skips non-high-value goals", async () => {
    const result = await maybeGenerateShortSessionMemory({
      runId: "test-run",
      goal: "add a new feature",
      turn: 2,
      finalText: "done",
      filePaths: [],
      errors: [],
      model: stubModel("should not be called"),
      workspaceRoot: "/tmp",
    });
    expect(result).toBeNull();
  });

  test("generates session memory for short high-value run", async () => {
    const runId = `test-short-${Date.now()}`;
    const ws = path.join(tmpdir(), `paw-a23-${Date.now()}`);
    const result = await maybeGenerateShortSessionMemory({
      runId,
      goal: "fix build error in compile script",
      turn: 3,
      finalText: "Fixed by updating the tsconfig paths configuration.",
      filePaths: ["src/build.ts", "tsconfig.json"],
      errors: ["TS2307: Cannot find module"],
      model: stubModel(
        "## Current State\nFixed the build error by updating tsconfig paths.\n## Errors & Fixes\n- TS2307: updated tsconfig paths",
      ),
      workspaceRoot: ws,
    });

    expect(result).not.toBeNull();
    if (result) {
      expect(result.session).toBe(runId);
      expect(result.task).toContain("fix build error");
      expect(result.currentState).toContain("Fixed");
      expect(result.errorsAndFixes).toBeDefined();
      expect(result.errorsAndFixes!.length).toBeGreaterThanOrEqual(1);
    }
  });
});
