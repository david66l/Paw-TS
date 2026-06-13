import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceWatcher } from "../src/watch.js";

async function waitForExternalChanges(
  watcher: WorkspaceWatcher,
  predicate: (changed: string[]) => boolean,
): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  let changed: string[] = [];
  while (Date.now() < deadline) {
    changed = watcher.takeExternallyModified();
    if (predicate(changed)) {
      return changed;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return changed;
}

describe("WorkspaceWatcher", () => {
  test("tracks external file changes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-watch-"));
    const watcher = new WorkspaceWatcher(dir);
    watcher.start();
    // fs.watch callbacks may register asynchronously on some platforms.
    await new Promise((r) => setTimeout(r, 100));

    writeFileSync(path.join(dir, "a.txt"), "hello");

    const changed = await waitForExternalChanges(watcher, (files) =>
      files.includes("a.txt"),
    );
    expect(changed).toContain("a.txt");
    watcher.stop();
  });

  test("ignores agent-written files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-watch-"));
    const watcher = new WorkspaceWatcher(dir);
    watcher.start();

    writeFileSync(path.join(dir, "agent.txt"), "agent content");
    await new Promise((r) => setTimeout(r, 300));

    watcher.markAgentWritten("agent.txt");
    const changed = watcher.takeExternallyModified();
    expect(changed).not.toContain("agent.txt");
    watcher.stop();
  });

  test("clears tracking on take", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-watch-"));
    const watcher = new WorkspaceWatcher(dir);
    watcher.start();
    await new Promise((r) => setTimeout(r, 100));

    writeFileSync(path.join(dir, "b.txt"), "content");
    const changed = await waitForExternalChanges(
      watcher,
      (files) => files.length > 0,
    );

    expect(changed.length).toBeGreaterThan(0);
    expect(watcher.takeExternallyModified().length).toBe(0);
    watcher.stop();
  });

  test("ignores .git and .paw directories", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-watch-"));
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    const watcher = new WorkspaceWatcher(dir);
    watcher.start();

    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    await new Promise((r) => setTimeout(r, 50));

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
