import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceWatcher } from "../src/watch.js";

describe("WorkspaceWatcher", () => {
  test("tracks external file changes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-watch-"));
    const watcher = new WorkspaceWatcher(dir);
    watcher.start();

    writeFileSync(path.join(dir, "a.txt"), "hello");
    // Give fs.watch a moment to fire
    await new Promise((r) => setTimeout(r, 200));

    const changed = watcher.takeExternallyModified();
    expect(changed).toContain("a.txt");
    watcher.stop();
  });

  test("ignores agent-written files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-watch-"));
    const watcher = new WorkspaceWatcher(dir);
    watcher.start();

    writeFileSync(path.join(dir, "agent.txt"), "agent content");
    await new Promise((r) => setTimeout(r, 200));

    watcher.markAgentWritten("agent.txt");
    const changed = watcher.takeExternallyModified();
    expect(changed).not.toContain("agent.txt");
    watcher.stop();
  });

  test("clears tracking on take", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-watch-"));
    const watcher = new WorkspaceWatcher(dir);
    watcher.start();

    writeFileSync(path.join(dir, "b.txt"), "content");
    await new Promise((r) => setTimeout(r, 200));

    expect(watcher.takeExternallyModified().length).toBeGreaterThan(0);
    expect(watcher.takeExternallyModified().length).toBe(0);
    watcher.stop();
  });

  test("ignores .git and .paw directories", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-watch-"));
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const watcher = new WorkspaceWatcher(dir);
    watcher.start();

    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    await new Promise((r) => setTimeout(r, 200));

    const changed = watcher.takeExternallyModified();
    expect(changed).not.toContain(".git/HEAD");
    watcher.stop();
  });

  test("stop is idempotent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-watch-"));
    const watcher = new WorkspaceWatcher(dir);
    watcher.start();
    watcher.stop();
    expect(() => watcher.stop()).not.toThrow();
  });
});
