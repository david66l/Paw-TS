import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CONTROL_PATHS = new Set([
  ".gitignore",
  "feature_list.json",
  "paw-progress.md",
  ".paw-e2e-last.json",
]);

export interface ProgressSnapshot {
  readonly sourceTreeHash: string;
  readonly gitHead: string;
}

export interface ProgressDelta {
  readonly progressed: boolean;
  readonly reasons: readonly string[];
  readonly sourceChanged: boolean;
  readonly targetE2ePassed: boolean;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

function isControlPath(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    CONTROL_PATHS.has(normalized) ||
    normalized.startsWith(".paw/") ||
    normalized.startsWith("dist/") ||
    normalized.startsWith("node_modules/")
  );
}

/** Content hash of tracked/untracked product files, excluding harness ledgers. */
export function captureProgressSnapshot(workspaceRoot: string): ProgressSnapshot {
  const listed = git(workspaceRoot, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const files = listed
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !isControlPath(value))
    .sort();
  const hash = createHash("sha256");
  for (const relativePath of files) {
    const absolutePath = path.join(workspaceRoot, relativePath);
    if (!existsSync(absolutePath)) continue;
    hash.update(relativePath.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(absolutePath));
    hash.update("\0");
  }
  return {
    sourceTreeHash: hash.digest("hex"),
    gitHead: git(workspaceRoot, ["rev-parse", "HEAD"]) || "(none)",
  };
}

export function evaluateProgressDelta(input: {
  readonly before: ProgressSnapshot;
  readonly after: ProgressSnapshot;
  readonly targetE2ePassed: boolean;
}): ProgressDelta {
  const sourceChanged =
    input.before.sourceTreeHash !== input.after.sourceTreeHash;
  const reasons: string[] = [];
  if (sourceChanged) reasons.push("source_tree_changed");
  if (input.targetE2ePassed) reasons.push("target_e2e_passed");
  return {
    progressed: reasons.length > 0,
    reasons,
    sourceChanged,
    targetE2ePassed: input.targetE2ePassed,
  };
}
