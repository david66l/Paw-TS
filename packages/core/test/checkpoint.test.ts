import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  extractCheckpointTargets,
  finalizeCheckpoint,
  inspectLastSafeFileMutationCheckpoint,
  isMutatingTool,
  listCheckpoints,
  restoreCheckpoint,
  saveCheckpoint,
  undoLastCheckpoint,
  undoLastSafeFileMutationCheckpoint,
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

  test("checkpoint sequence targets are no-overwrite physical slots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-no-overwrite-"));
    writeFileSync(path.join(root, "a.txt"), "before", "utf8");
    saveCheckpoint(root, "run-1", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    const metaPath = path.join(
      root,
      ".paw",
      "checkpoints",
      "run-1",
      "1",
      "_meta.json",
    );
    const originalMeta = readFileSync(metaPath, "utf8");

    writeFileSync(path.join(root, "a.txt"), "later", "utf8");
    expect(() =>
      saveCheckpoint(root, "run-1", 1, "workspace.edit_file", {
        path: "a.txt",
      }),
    ).toThrow("checkpoint sequence target already exists: 1");
    expect(readFileSync(metaPath, "utf8")).toBe(originalMeta);
  });

  test("checkpoint allocation permits journal-authorized sequence gaps", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-gap-"));
    writeFileSync(path.join(root, "a.txt"), "before", "utf8");

    expect(
      saveCheckpoint(root, "run-gap", 2, "workspace.edit_file", {
        path: "a.txt",
      }).seq,
    ).toBe(2);
    expect(
      existsSync(path.join(root, ".paw", "checkpoints", "run-gap", "1")),
    ).toBe(false);
  });

  test("checkpoint storage refuses a redirected Paw directory", () => {
    const base = mkdtempSync(path.join(tmpdir(), "paw-cp-state-link-"));
    const root = path.join(base, "work");
    const outside = path.join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(root, "a.txt"), "before", "utf8");
    symlinkSync(outside, path.join(root, ".paw"), "junction");

    expect(() =>
      saveCheckpoint(root, "run-link", 1, "workspace.edit_file", {
        path: "a.txt",
      }),
    ).toThrow("checkpoint storage path is not a safe directory");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("post-save namespace redirection cannot read, finalize, restore, or delete outside state", () => {
    const base = mkdtempSync(path.join(tmpdir(), "paw-cp-late-run-link-"));
    const root = path.join(base, "work");
    const outside = path.join(base, "outside");
    mkdirSync(root);
    writeFileSync(path.join(root, "a.txt"), "before", "utf8");
    saveCheckpoint(root, "late-run", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    writeFileSync(path.join(root, "a.txt"), "agent", "utf8");
    const runDir = path.join(root, ".paw", "checkpoints", "late-run");
    fs.renameSync(runDir, outside);
    symlinkSync(outside, runDir, "junction");
    const outsideMeta = path.join(outside, "1", "_meta.json");
    const originalMeta = readFileSync(outsideMeta, "utf8");

    expect(() => finalizeCheckpoint(root, "late-run", 1)).toThrow(
      "checkpoint storage path is not a safe directory",
    );
    expect(() =>
      inspectLastSafeFileMutationCheckpoint(root, "late-run"),
    ).toThrow("checkpoint storage path is not a safe directory");
    expect(() => undoLastSafeFileMutationCheckpoint(root, "late-run")).toThrow(
      "checkpoint storage path is not a safe directory",
    );
    expect(() => undoLastCheckpoint(root, "late-run")).toThrow(
      "checkpoint storage path is not a safe directory",
    );
    expect(() => restoreCheckpoint(root, "late-run", 1)).toThrow(
      "checkpoint storage path is not a safe directory",
    );
    expect(() => listCheckpoints(root, "late-run")).toThrow(
      "checkpoint storage path is not a safe directory",
    );
    expect(readFileSync(outsideMeta, "utf8")).toBe(originalMeta);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("agent");
  });

  test("post-save sequence-directory redirection fails before touching outside metadata", () => {
    const base = mkdtempSync(path.join(tmpdir(), "paw-cp-late-seq-link-"));
    const root = path.join(base, "work");
    const outside = path.join(base, "outside-seq");
    mkdirSync(root);
    writeFileSync(path.join(root, "a.txt"), "before", "utf8");
    saveCheckpoint(root, "late-seq", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    const seqDir = path.join(root, ".paw", "checkpoints", "late-seq", "1");
    fs.renameSync(seqDir, outside);
    symlinkSync(outside, seqDir, "junction");
    const outsideMeta = path.join(outside, "_meta.json");
    const originalMeta = readFileSync(outsideMeta, "utf8");

    expect(() => finalizeCheckpoint(root, "late-seq", 1)).toThrow(
      "checkpoint storage path is not a safe directory",
    );
    expect(() =>
      inspectLastSafeFileMutationCheckpoint(root, "late-seq"),
    ).toThrow("checkpoint storage path is not a safe directory");
    expect(readFileSync(outsideMeta, "utf8")).toBe(originalMeta);
  });

  test("checkpoint sequence slots reject pre-existing files and links", () => {
    const base = mkdtempSync(path.join(tmpdir(), "paw-cp-slot-types-"));
    const outside = path.join(base, "outside");
    mkdirSync(outside);

    const fileRoot = path.join(base, "file-root");
    const fileRunDir = path.join(fileRoot, ".paw", "checkpoints", "run-file");
    mkdirSync(fileRunDir, { recursive: true });
    writeFileSync(path.join(fileRunDir, "1"), "occupied", "utf8");
    expect(() =>
      saveCheckpoint(fileRoot, "run-file", 1, "workspace.run_shell", {
        command: "echo no-op",
      }),
    ).toThrow("checkpoint sequence target already exists: 1");
    expect(readFileSync(path.join(fileRunDir, "1"), "utf8")).toBe("occupied");

    const linkRoot = path.join(base, "link-root");
    const linkRunDir = path.join(linkRoot, ".paw", "checkpoints", "run-link");
    mkdirSync(linkRunDir, { recursive: true });
    symlinkSync(outside, path.join(linkRunDir, "1"), "junction");
    expect(() =>
      saveCheckpoint(linkRoot, "run-link", 1, "workspace.run_shell", {
        command: "echo no-op",
      }),
    ).toThrow("checkpoint sequence target already exists: 1");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("two real processes cannot both own one checkpoint sequence slot", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-race-"));
    const readyOne = path.join(root, "ready-one");
    const readyTwo = path.join(root, "ready-two");
    const barrier = path.join(root, "go");
    const first = runCheckpointChild([root, readyOne, barrier, "first"]);
    const second = runCheckpointChild([root, readyTwo, barrier, "second"]);
    await waitForCheckpointChildren(
      () => existsSync(readyOne) && existsSync(readyTwo),
    );
    writeFileSync(barrier, "go", "utf8");

    const results = await Promise.all([first, second]);
    expect(results.filter((item) => item.status === "saved")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    expect(
      results.find((item) => item.status === "rejected")?.message,
    ).toContain("checkpoint sequence target already exists: 1");
    expect(
      existsSync(
        path.join(
          root,
          ".paw",
          "checkpoints",
          "concurrent-run",
          "1",
          "_meta.json",
        ),
      ),
    ).toBe(true);
  }, 15_000);

  test("a partially written checkpoint consumes its physical sequence slot", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-partial-"));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() =>
      saveCheckpoint(root, "run-partial", 1, "workspace.run_shell", cyclic),
    ).toThrow();
    expect(
      existsSync(path.join(root, ".paw", "checkpoints", "run-partial", "1")),
    ).toBe(true);
    expect(() =>
      saveCheckpoint(root, "run-partial", 1, "workspace.run_shell", {
        command: "echo retry",
      }),
    ).toThrow("checkpoint sequence target already exists: 1");
  });

  test("invalid checkpoint sequences fail before creating Paw storage", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-bad-seq-"));

    expect(() =>
      saveCheckpoint(root, "run-invalid", 0, "workspace.run_shell", {
        command: "echo no-op",
      }),
    ).toThrow("checkpoint sequence must be a positive safe integer");
    expect(existsSync(path.join(root, ".paw"))).toBe(false);
  });

  test("checkpoint namespaces reject traversal and physical aliases", () => {
    for (const namespace of ["..", "a/b", "a?b", "Run-A", "."]) {
      const root = mkdtempSync(path.join(tmpdir(), "paw-cp-bad-namespace-"));
      expect(() =>
        saveCheckpoint(root, namespace, 1, "workspace.run_shell", {
          command: "echo no-op",
        }),
      ).toThrow("checkpoint namespace must contain only lowercase letters");
      expect(existsSync(path.join(root, ".paw"))).toBe(false);
    }
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

  test("safe undo skips failed attempts and restores the latest actual edit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-safe-"));
    writeFileSync(path.join(root, "a.txt"), "before", "utf8");
    saveCheckpoint(root, "run-safe", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    writeFileSync(path.join(root, "a.txt"), "after", "utf8");
    finalizeCheckpoint(root, "run-safe", 1);
    saveCheckpoint(root, "run-safe", 2, "workspace.edit_file", {
      path: "a.txt",
    });
    finalizeCheckpoint(root, "run-safe", 2);

    const inspection = inspectLastSafeFileMutationCheckpoint(root, "run-safe");
    expect(inspection.status).toBe("ready");
    if (inspection.status !== "ready") throw new Error("expected ready");
    expect(inspection.entry.seq).toBe(1);

    const undone = undoLastSafeFileMutationCheckpoint(root, "run-safe");
    expect(undone.status).toBe("ready");
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("before");
    expect(listCheckpoints(root, "run-safe")).toHaveLength(0);
  });

  test("safe undo refuses to overwrite an intervening external change", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-conflict-"));
    writeFileSync(path.join(root, "a.txt"), "before", "utf8");
    saveCheckpoint(root, "run-conflict", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    writeFileSync(path.join(root, "a.txt"), "agent", "utf8");
    finalizeCheckpoint(root, "run-conflict", 1);
    writeFileSync(path.join(root, "a.txt"), "external", "utf8");

    const undone = undoLastSafeFileMutationCheckpoint(root, "run-conflict");

    expect(undone.status).toBe("conflict");
    if (undone.status !== "conflict") throw new Error("expected conflict");
    expect(undone.conflictingPaths).toEqual(["a.txt"]);
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("external");
    expect(listCheckpoints(root, "run-conflict")).toHaveLength(1);
  });

  test("multi-file safe undo rechecks each target and rolls back on a mid-restore conflict", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-mid-restore-"));
    const aPath = path.join(root, "a.txt");
    const bPath = path.join(root, "b.txt");
    writeFileSync(aPath, "a0", "utf8");
    writeFileSync(bPath, "b0", "utf8");
    saveCheckpoint(root, "run-mid-restore", 1, "workspace.apply_patch", {
      patch: [
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-a0",
        "+a1",
        "--- a/b.txt",
        "+++ b/b.txt",
        "@@ -1 +1 @@",
        "-b0",
        "+b1",
      ].join("\n"),
    });
    writeFileSync(aPath, "a1", "utf8");
    writeFileSync(bPath, "b1", "utf8");
    finalizeCheckpoint(root, "run-mid-restore", 1);

    const originalWrite = fs.writeFileSync;
    let injected = false;
    Object.defineProperty(fs, "writeFileSync", {
      configurable: true,
      value(
        file: fs.PathOrFileDescriptor,
        data: string | NodeJS.ArrayBufferView,
      ) {
        const result = originalWrite(file, data);
        if (!injected && path.resolve(String(file)) === path.resolve(aPath)) {
          injected = true;
          originalWrite(bPath, "EXTERNAL", "utf8");
        }
        return result;
      },
    });
    let undone: ReturnType<typeof undoLastSafeFileMutationCheckpoint>;
    try {
      undone = undoLastSafeFileMutationCheckpoint(root, "run-mid-restore");
    } finally {
      Object.defineProperty(fs, "writeFileSync", {
        configurable: true,
        value: originalWrite,
      });
    }

    expect(undone?.status).toBe("conflict");
    expect(readFileSync(aPath, "utf8")).toBe("a1");
    expect(readFileSync(bPath, "utf8")).toBe("EXTERNAL");
    expect(listCheckpoints(root, "run-mid-restore")).toHaveLength(1);
  });

  test("safe undo ignores shell checkpoints and legacy unfinalized entries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-nonfile-"));
    writeFileSync(path.join(root, "a.txt"), "before", "utf8");
    saveCheckpoint(root, "run-none", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    writeFileSync(path.join(root, "a.txt"), "legacy", "utf8");
    saveCheckpoint(root, "run-none", 2, "workspace.run_shell", {
      command: "pytest",
    });
    finalizeCheckpoint(root, "run-none", 2);

    expect(inspectLastSafeFileMutationCheckpoint(root, "run-none")).toEqual({
      status: "none",
    });
    expect(readFileSync(path.join(root, "a.txt"), "utf8")).toBe("legacy");
  });

  test("checkpoint paths cannot escape into a sibling with the same prefix", () => {
    const base = mkdtempSync(path.join(tmpdir(), "paw-cp-sibling-"));
    const root = path.join(base, "work");
    const sibling = path.join(base, "workevil");
    mkdirSync(root);
    mkdirSync(sibling);
    const victim = path.join(sibling, "victim.txt");
    writeFileSync(victim, "before", "utf8");

    expect(() =>
      saveCheckpoint(root, "run-escape", 1, "workspace.edit_file", {
        path: "../workevil/victim.txt",
      }),
    ).toThrow("escapes workspace");
    writeFileSync(victim, "external", "utf8");

    expect(inspectLastSafeFileMutationCheckpoint(root, "run-escape")).toEqual({
      status: "none",
    });
    expect(readFileSync(victim, "utf8")).toBe("external");
  });

  test("checkpoint preparation rejects Paw state targets before creating metadata", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-reserved-"));

    expect(() =>
      saveCheckpoint(root, "audit", 1, "workspace.write_file", {
        path: ".paw/checkpoints/audit/1/_meta.json",
        content: "overwrite",
      }),
    ).toThrow("reserved Paw state");
    expect(
      existsSync(path.join(root, ".paw", "checkpoints", "audit", "1")),
    ).toBe(false);
  });

  test("checkpoint paths cannot escape through a workspace symlink", () => {
    const base = mkdtempSync(path.join(tmpdir(), "paw-cp-symlink-"));
    const root = path.join(base, "work");
    const outside = path.join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "victim.txt"), "outside", "utf8");
    symlinkSync(outside, path.join(root, "link"), "junction");

    expect(() =>
      saveCheckpoint(root, "run-symlink", 1, "workspace.edit_file", {
        path: "link/victim.txt",
      }),
    ).toThrow("escapes workspace");
    expect(readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe(
      "outside",
    );
  });

  test("checkpoint preparation rejects colliding snapshot keys", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-collision-"));
    const patchText = [
      "--- /dev/null",
      "+++ b/a/b",
      "@@ -0,0 +1 @@",
      "+nested",
      "--- /dev/null",
      "+++ b/a_b",
      "@@ -0,0 +1 @@",
      "+flat",
    ].join("\n");

    expect(() =>
      saveCheckpoint(root, "run-collision", 1, "workspace.apply_patch", {
        patch: patchText,
      }),
    ).toThrow("collide after path sanitization");
    expect(
      existsSync(path.join(root, ".paw", "checkpoints", "run-collision")),
    ).toBe(false);
  });

  test("safe undo fails closed on malformed outcome metadata", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-malformed-"));
    const filePath = path.join(root, "a.txt");
    writeFileSync(filePath, "before", "utf8");
    saveCheckpoint(root, "run-malformed", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    writeFileSync(filePath, "agent", "utf8");
    finalizeCheckpoint(root, "run-malformed", 1);
    const metaPath = path.join(
      root,
      ".paw",
      "checkpoints",
      "run-malformed",
      "1",
      "_meta.json",
    );
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      metaPath,
      JSON.stringify({
        ...meta,
        outcome: {
          schemaVersion: "paw.checkpoint-outcome.v1",
          toolSucceeded: true,
          materiallyChanged: true,
          after: [{ path: "../outside.txt", state: "missing" }],
        },
      }),
      "utf8",
    );

    const inspected = inspectLastSafeFileMutationCheckpoint(
      root,
      "run-malformed",
    );
    expect(inspected.status).toBe("invalid");
    expect(
      undoLastSafeFileMutationCheckpoint(root, "run-malformed").status,
    ).toBe("invalid");
    expect(readFileSync(filePath, "utf8")).toBe("agent");
    expect(listCheckpoints(root, "run-malformed")).toHaveLength(1);
  });

  test("safe undo rejects a snapshot whose bytes do not match its filename hash", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-tamper-"));
    const filePath = path.join(root, "a.txt");
    writeFileSync(filePath, "before", "utf8");
    saveCheckpoint(root, "run-tamper", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    writeFileSync(filePath, "after", "utf8");
    finalizeCheckpoint(root, "run-tamper", 1);
    const checkpointDir = path.join(
      root,
      ".paw",
      "checkpoints",
      "run-tamper",
      "1",
    );
    const snapshot = readdirSync(checkpointDir).find(
      (name) => !name.startsWith(".") && name !== "_meta.json",
    );
    expect(snapshot).toBeDefined();
    if (!snapshot) throw new Error("expected checkpoint snapshot");
    writeFileSync(path.join(checkpointDir, snapshot), "corrupt", "utf8");

    const undone = undoLastSafeFileMutationCheckpoint(root, "run-tamper");

    expect(undone.status).toBe("invalid");
    expect(readFileSync(filePath, "utf8")).toBe("after");
    expect(existsSync(checkpointDir)).toBe(true);
  });

  test("safe undo skips a failed tool even if its target state changed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-failed-"));
    const filePath = path.join(root, "a.txt");
    writeFileSync(filePath, "zero", "utf8");
    saveCheckpoint(root, "run-failed", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    writeFileSync(filePath, "one", "utf8");
    finalizeCheckpoint(root, "run-failed", 1, { toolSucceeded: true });
    saveCheckpoint(root, "run-failed", 2, "workspace.edit_file", {
      path: "a.txt",
    });
    writeFileSync(filePath, "partial", "utf8");
    finalizeCheckpoint(root, "run-failed", 2, { toolSucceeded: false });

    const inspection = inspectLastSafeFileMutationCheckpoint(
      root,
      "run-failed",
    );
    expect(inspection.status).toBe("conflict");
    if (inspection.status !== "conflict") throw new Error("expected conflict");
    expect(inspection.entry.seq).toBe(1);
    expect(inspection.conflictingPaths).toEqual(["a.txt"]);
  });

  test("safe undo rejects metadata whose sequence disagrees with its directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-cp-seq-"));
    writeFileSync(path.join(root, "a.txt"), "before", "utf8");
    saveCheckpoint(root, "run-seq", 1, "workspace.edit_file", {
      path: "a.txt",
    });
    const metaPath = path.join(
      root,
      ".paw",
      "checkpoints",
      "run-seq",
      "1",
      "_meta.json",
    );
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(metaPath, JSON.stringify({ ...meta, seq: 2 }), "utf8");

    expect(inspectLastSafeFileMutationCheckpoint(root, "run-seq").status).toBe(
      "invalid",
    );
  });

  test("isMutatingTool recognizes mutating tools", () => {
    expect(isMutatingTool("workspace.write_file")).toBe(true);
    expect(isMutatingTool("workspace.edit_file")).toBe(true);
    expect(isMutatingTool("workspace.apply_patch")).toBe(true);
    expect(isMutatingTool("workspace.run_shell")).toBe(true);
    expect(isMutatingTool("workspace.job_start")).toBe(true);
    expect(isMutatingTool("workspace.notebook_edit")).toBe(true);
    expect(isMutatingTool("workspace.undo_last_edit")).toBe(true);
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

    const backupDirs = existsSync(
      path.join(root, ".paw", "checkpoints", "run-bk", ".backup"),
    );
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
        path.join(
          root,
          ".paw",
          "checkpoints",
          "run-shell",
          "1",
          ".shell-meta.json",
        ),
        "utf8",
      ),
    );
    expect(shellMeta.tool).toBe("workspace.run_shell");
    expect(shellMeta.args).toEqual({ command: "echo hello" });
  });
});

interface CheckpointChildResult {
  readonly status: "saved" | "rejected";
  readonly label: string;
  readonly message?: string;
}

function runCheckpointChild(
  args: readonly string[],
): Promise<CheckpointChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(import.meta.dir, "fixtures", "checkpoint-save-child.ts"),
        ...args,
      ],
      {
        cwd: path.resolve(import.meta.dir, ".."),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(JSON.parse(stdout) as CheckpointChildResult);
      } else {
        reject(new Error(`checkpoint child exited ${code}: ${stderr}`));
      }
    });
  });
}

async function waitForCheckpointChildren(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error("checkpoint child barrier timeout");
    await Bun.sleep(5);
  }
}
