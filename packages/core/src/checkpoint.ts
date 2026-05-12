/**
 * Checkpoint / rollback system for workspace file modifications.
 *
 * Before a file-mutating tool runs, the orchestrator saves a snapshot of the
 * files that will be touched.  The user can `/undo` to restore the last
 * checkpoint.
 */

import fs from "node:fs";
import path from "node:path";

export interface CheckpointEntry {
  readonly seq: number;
  readonly tool: string;
  readonly targets: readonly string[];
  readonly savedAt: number;
}

export interface Checkpoint {
  readonly runId: string;
  readonly seq: number;
  readonly entries: readonly CheckpointEntry[];
  readonly savedAt: number;
}

/** Detect target file paths from tool-call args. */
export function extractCheckpointTargets(
  tool: string,
  args: unknown,
): string[] {
  const rec =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  switch (tool) {
    case "workspace.write_file":
    case "workspace.edit_file":
    case "workspace.notebook_edit": {
      const p = typeof rec.path === "string" ? rec.path : "";
      return p ? [p] : [];
    }
    case "workspace.apply_patch": {
      const patchText = typeof rec.patch === "string" ? rec.patch : "";
      // Extract file paths from unified diff headers (--- a/xxx, +++ b/xxx)
      const paths: string[] = [];
      for (const line of patchText.split(/\r?\n/)) {
        const m = line.match(/^\+\+\+\s+(?:b\/)?(.*)/);
        if (m && m[1] && m[1] !== "/dev/null") {
          paths.push(m[1]);
        }
      }
      return paths;
    }
    case "workspace.run_shell": {
      // Shell commands may touch arbitrary files; we can't predict targets.
      // Return empty so the checkpoint stores no per-file snapshot.
      // A future enhancement could do a pre/post file-tree diff.
      return [];
    }
    default:
      return [];
  }
}

import { createHash } from "node:crypto";

/**
 * Save a checkpoint before executing a mutating tool.
 * Only files that currently exist are snapshotted; new files are recorded
 * with a null snapshot so undo can delete them.
 */
export function saveCheckpoint(
  workspaceRoot: string,
  runId: string,
  seq: number,
  tool: string,
  args: unknown,
): CheckpointEntry {
  const targets = extractCheckpointTargets(tool, args);
  const checkpointDir = path.join(
    workspaceRoot,
    ".paw",
    "checkpoints",
    sanitizeRunId(runId),
    String(seq),
  );
  fs.mkdirSync(checkpointDir, { recursive: true });

  const savedTargets: string[] = [];
  for (const rel of targets) {
    const full = path.join(workspaceRoot, rel);
    // Skip paths that escape workspace
    if (!full.startsWith(path.resolve(workspaceRoot))) continue;

    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const content = fs.readFileSync(full);
      const hash = hashBytes(content);
      const snapshotFile = path.join(checkpointDir, `${hash}-${sanitizeFileName(rel)}`);
      fs.writeFileSync(snapshotFile, content);
      savedTargets.push(rel);
    } else {
      // File doesn't exist yet — record as "will be created" so undo can delete it
      const marker = path.join(checkpointDir, `.create-${sanitizeFileName(rel)}`);
      fs.writeFileSync(marker, "", "utf8");
      savedTargets.push(rel);
    }
  }

  const meta: CheckpointEntry = { seq, tool, targets: savedTargets, savedAt: Date.now() };
  fs.writeFileSync(
    path.join(checkpointDir, "_meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
  return meta;
}

/** Restore the most recent checkpoint for a run. Returns the restored checkpoint or null. */
export function undoLastCheckpoint(
  workspaceRoot: string,
  runId: string,
): CheckpointEntry | null {
  const checkpointsDir = path.join(
    workspaceRoot,
    ".paw",
    "checkpoints",
    sanitizeRunId(runId),
  );
  if (!fs.existsSync(checkpointsDir)) return null;

  const dirs = fs
    .readdirSync(checkpointsDir)
    .filter((n) => /^\d+$/.test(n))
    .map((n) => ({ name: n, seq: parseInt(n, 10) }))
    .sort((a, b) => b.seq - a.seq);

  for (const d of dirs) {
    const checkpointDir = path.join(checkpointsDir, d.name);
    const metaPath = path.join(checkpointDir, "_meta.json");
    if (!fs.existsSync(metaPath)) continue;

    const meta: CheckpointEntry = JSON.parse(
      fs.readFileSync(metaPath, "utf8"),
    ) as CheckpointEntry;

    for (const rel of meta.targets) {
      const full = path.join(workspaceRoot, rel);
      if (!full.startsWith(path.resolve(workspaceRoot))) continue;

      const createMarker = path.join(checkpointDir, `.create-${sanitizeFileName(rel)}`);
      if (fs.existsSync(createMarker)) {
        // File was created by the tool → delete it on undo
        try {
          fs.unlinkSync(full);
        } catch {
          // ignore missing
        }
        continue;
      }

      // Find snapshot file by searching prefix
      const prefix = sanitizeFileName(rel);
      const snapshotFiles = fs
        .readdirSync(checkpointDir)
        .filter((n) => n.endsWith(`-${prefix}`));
      if (snapshotFiles.length > 0) {
        const snapshotFile = path.join(checkpointDir, snapshotFiles[0]!);
        fs.copyFileSync(snapshotFile, full);
      }
    }

    // Remove the checkpoint dir after undo so `/undo` goes to the previous one
    fs.rmSync(checkpointDir, { recursive: true, force: true });
    return meta;
  }
  return null;
}

/** List all checkpoints for a run, newest first. */
export function listCheckpoints(
  workspaceRoot: string,
  runId: string,
): CheckpointEntry[] {
  const checkpointsDir = path.join(
    workspaceRoot,
    ".paw",
    "checkpoints",
    sanitizeRunId(runId),
  );
  if (!fs.existsSync(checkpointsDir)) return [];

  const out: CheckpointEntry[] = [];
  for (const name of fs.readdirSync(checkpointsDir)) {
    if (!/^\d+$/.test(name)) continue;
    const metaPath = path.join(checkpointsDir, name, "_meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as CheckpointEntry;
      out.push(meta);
    } catch {
      // skip corrupt
    }
  }
  return out.sort((a, b) => b.seq - a.seq);
}

function sanitizeRunId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function sanitizeFileName(rel: string): string {
  return rel.replace(/[/\\]/g, "_");
}

function hashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/** Return true if the tool may mutate workspace files. */
export function isMutatingTool(tool: string): boolean {
  return (
    tool === "workspace.write_file" ||
    tool === "workspace.edit_file" ||
    tool === "workspace.apply_patch" ||
    tool === "workspace.notebook_edit" ||
    tool === "workspace.run_shell"
  );
}
