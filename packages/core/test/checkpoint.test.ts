import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  extractCheckpointTargets,
  isMutatingTool,
  listCheckpoints,
  saveCheckpoint,
  undoLastCheckpoint,
} from "../src/checkpoint.js";

describe("checkpoint", () => {
  test("extractCheckpointTargets for write_file", () => {
    const targets = extractCheckpointTargets("workspace.write_file", {
      path: "src/foo.ts",
      content: "x",
    });
    expect(targets).toEqual(["src/foo.ts"]);
  });

  test("extractCheckpointTargets for apply_patch", () => {
    const patch =
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old2\n+new2";
    const targets = extractCheckpointTargets("workspace.apply_patch", {
      patch,
    });
    expect(targets).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("saveCheckpoint snapshots existing files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-"));
    writeFileSync(path.join(root, "a.txt"), "original", "utf8");

    const meta = saveCheckpoint(root, "run-1", 1, "workspace.write_file", {
      path: "a.txt",
      content: "modified",
    });
    expect(meta.targets).toContain("a.txt");
    expect(meta.seq).toBe(1);

    // Modify the file
    writeFileSync(path.join(root, "a.txt"), "modified", "utf8");

    // Undo should restore
    const undone = undoLastCheckpoint(root, "run-1");
    expect(undone).not.toBeNull();
    expect(undone?.tool).toBe("workspace.write_file");
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("original");
  });

  test("undo deletes created files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-new-"));

    saveCheckpoint(root, "run-new", 1, "workspace.write_file", {
      path: "new.txt",
      content: "hello",
    });

    // Simulate tool creating the file
    writeFileSync(path.join(root, "new.txt"), "hello", "utf8");

    // Undo should delete the created file
    const undone = undoLastCheckpoint(root, "run-new");
    expect(undone).not.toBeNull();
    expect(existsSync(path.join(root, "new.txt"))).toBe(false);
  });

  test("listCheckpoints returns newest first", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-list-"));
    writeFileSync(path.join(root, "a.txt"), "x", "utf8");

    saveCheckpoint(root, "run-list", 1, "workspace.write_file", {
      path: "a.txt",
      content: "x",
    });
    saveCheckpoint(root, "run-list", 2, "workspace.edit_file", {
      path: "a.txt",
      old_string: "x",
      new_string: "y",
    });

    const cps = listCheckpoints(root, "run-list");
    expect(cps.length).toBe(2);
    expect(cps[0]?.seq).toBe(2);
    expect(cps[1]?.seq).toBe(1);
  });

  test("undo removes checkpoint after restore", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-rm-"));
    writeFileSync(path.join(root, "a.txt"), "orig", "utf8");

    saveCheckpoint(root, "run-rm", 1, "workspace.write_file", {
      path: "a.txt",
      content: "x",
    });

    writeFileSync(path.join(root, "a.txt"), "x", "utf8");

    undoLastCheckpoint(root, "run-rm");
    // Second undo should find nothing
    const second = undoLastCheckpoint(root, "run-rm");
    expect(second).toBeNull();
  });

  test("isMutatingTool recognizes mutating tools", () => {
    expect(isMutatingTool("workspace.write_file")).toBe(true);
    expect(isMutatingTool("workspace.edit_file")).toBe(true);
    expect(isMutatingTool("workspace.apply_patch")).toBe(true);
    expect(isMutatingTool("workspace.run_shell")).toBe(true);
    expect(isMutatingTool("workspace.notebook_edit")).toBe(true);
    expect(isMutatingTool("workspace.read_file")).toBe(false);
    expect(isMutatingTool("workspace.list_dir")).toBe(false);
  });

  test("restoreCheckpoint restores specific seq and removes newer ones", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-restore-"));
    writeFileSync(path.join(root, "a.txt"), "v0", "utf8");

    saveCheckpoint(root, "run-restore", 1, "workspace.write_file", {
      path: "a.txt",
      content: "v1",
    });
    writeFileSync(path.join(root, "a.txt"), "v1", "utf8");

    saveCheckpoint(root, "run-restore", 2, "workspace.write_file", {
      path: "a.txt",
      content: "v2",
    });
    writeFileSync(path.join(root, "a.txt"), "v2", "utf8");

    // Restore to seq 1
    const { restoreCheckpoint } = require("../src/checkpoint.js");
    const restored = restoreCheckpoint(root, "run-restore", 1);
    expect(restored).not.toBeNull();
    expect(restored?.seq).toBe(1);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("v0");

    // seq 1 and 2 should both be removed
    const remaining = listCheckpoints(root, "run-restore");
    expect(remaining.length).toBe(0);
  });

  test("restoreCheckpoint with backup preserves removed checkpoints", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-backup-"));
    writeFileSync(path.join(root, "a.txt"), "x", "utf8");

    saveCheckpoint(root, "run-bk", 1, "workspace.write_file", {
      path: "a.txt",
      content: "y",
    });

    const { restoreCheckpoint } = require("../src/checkpoint.js");
    restoreCheckpoint(root, "run-bk", 1, { backup: true });

    const backupDirs = existsSync(path.join(root, ".paw", "checkpoints", "run-bk", ".backup"));
    expect(backupDirs).toBe(true);
  });

  test("run_shell checkpoint saves metadata instead of file snapshot", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-shell-"));

    saveCheckpoint(root, "run-shell", 1, "workspace.run_shell", {
      command: "echo hello",
    });

    const meta = JSON.parse(
      readFileSync(
        path.join(root, ".paw", "checkpoints", "run-shell", "1", "_meta.json"),
        "utf8",
      ),
    );
    expect(meta.targets).toContain("__shell_cmd__");

    const shellMeta = JSON.parse(
      readFileSync(
        path.join(root, ".paw", "checkpoints", "run-shell", "1", ".shell-meta.json"),
        "utf8",
      ),
    );
    expect(shellMeta.tool).toBe("workspace.run_shell");
    expect(shellMeta.args).toEqual({ command: "echo hello" });
  });
});
