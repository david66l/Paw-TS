/**
 * Apply a unified diff patch to multiple workspace files.
 *
 * Uses the `diff` package (already a workspace dependency) to parse and apply
 * patches. Operations are transactional: all patches are validated first, then
 * applied. If any patch fails, previously applied changes are rolled back.
 */

import fs from "node:fs";

import { applyPatch, parsePatch } from "diff";

import { checkWorkspacePath } from "./path-guard.js";

export interface PatchFileResult {
  readonly path: string;
  readonly ok: boolean;
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
  readonly error?: string;
}

export interface PatchResult {
  readonly ok: boolean;
  readonly results: readonly PatchFileResult[];
  readonly summary: string;
}

function countLinesChanged(patch: ReturnType<typeof parsePatch>[number]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

/**
 * Apply a unified diff patch string to workspace files.
 *
 * @param workspaceRoot Absolute workspace root.
 * @param patchText Unified diff text (may contain multiple files).
 */
export function applyWorkspacePatch(
  workspaceRoot: string,
  patchText: string,
): PatchResult {
  if (!patchText.trim()) {
    return { ok: false, results: [], summary: "apply_patch: empty patch" };
  }

  let patches: ReturnType<typeof parsePatch>;
  try {
    patches = parsePatch(patchText);
  } catch {
    return { ok: false, results: [], summary: "apply_patch: failed to parse patch" };
  }

  if (patches.length === 0) {
    return { ok: false, results: [], summary: "apply_patch: no patches found" };
  }

  // Phase 1: resolve target paths and validate workspace boundaries
  const targets: Array<{
    patch: (typeof patches)[number];
    relPath: string;
    resolvedPath: string;
  }> = [];

  for (const patch of patches) {
    // Git-style diffs often prefix with a/b; strip those.
    const rawPath = patch.newFileName ?? patch.oldFileName ?? "";
    if (!rawPath) {
      return {
        ok: false,
        results: [],
        summary: "apply_patch: patch missing file name",
      };
    }

    const relPath = rawPath.replace(/^(a|b)\//, "");
    const guard = checkWorkspacePath(workspaceRoot, relPath);
    if (!guard.allowed) {
      return {
        ok: false,
        results: [],
        summary: `apply_patch: ${guard.reason}`,
      };
    }
    targets.push({ patch, relPath, resolvedPath: guard.resolvedPath });
  }

  // Phase 2: read original contents (for rollback)
  const originals = new Map<string, string>();
  for (const t of targets) {
    try {
      if (fs.existsSync(t.resolvedPath) && fs.statSync(t.resolvedPath).isFile()) {
        originals.set(t.resolvedPath, fs.readFileSync(t.resolvedPath, "utf8"));
      } else if (t.patch.isCreate !== true) {
        return {
          ok: false,
          results: [],
          summary: `apply_patch: file not found: ${t.relPath}`,
        };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        results: [],
        summary: `apply_patch: read error on ${t.relPath}: ${msg}`,
      };
    }
  }

  // Phase 3: validate all patches (dry-run) then apply
  const results: PatchFileResult[] = [];

  for (const t of targets) {
    const original = originals.get(t.resolvedPath) ?? "";
    const patched = applyPatch(original, t.patch, { autoConvertLineEndings: true });

    if (patched === false) {
      // Rollback: restore all already-written files
      for (const r of results) {
        if (r.ok) {
          const rp = targets.find((tt) => tt.relPath === r.path)?.resolvedPath;
          if (rp) {
            const orig = originals.get(rp);
            if (orig !== undefined) {
              fs.writeFileSync(rp, orig, "utf8");
            }
          }
        }
      }
      return {
        ok: false,
        results: [
          ...results,
          {
            path: t.relPath,
            ok: false,
            error: "patch does not apply cleanly",
          },
        ],
        summary: `apply_patch: failed on ${t.relPath}`,
      };
    }

    // Write patched content
    try {
      fs.writeFileSync(t.resolvedPath, patched, "utf8");
      const counts = countLinesChanged(t.patch);
      results.push({
        path: t.relPath,
        ok: true,
        linesAdded: counts.added,
        linesRemoved: counts.removed,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Rollback on write error too
      for (const r of results) {
        if (r.ok) {
          const rp = targets.find((tt) => tt.relPath === r.path)?.resolvedPath;
          if (rp) {
            const orig = originals.get(rp);
            if (orig !== undefined) {
              fs.writeFileSync(rp, orig, "utf8");
            }
          }
        }
      }
      return {
        ok: false,
        results: [
          ...results,
          { path: t.relPath, ok: false, error: msg },
        ],
        summary: `apply_patch: write error on ${t.relPath}: ${msg}`,
      };
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const totalAdded = results.reduce((s, r) => s + (r.linesAdded ?? 0), 0);
  const totalRemoved = results.reduce((s, r) => s + (r.linesRemoved ?? 0), 0);
  const summary = `apply_patch: ${okCount}/${results.length} file(s) edited (+${totalAdded}/-${totalRemoved})`;

  return { ok: true, results, summary };
}
