/** git 只读工具（status/log/diff）。 */
import { gitDiffAsync, gitLogAsync, gitStatusAsync } from "@paw/workspace";
import type { ToolRunResult } from "../definitions.js";
import { type ToolScope, num } from "../tool-support.js";

/** `workspace.git_status` */
export async function handleGitStatus(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx } = scope;
  const r = await gitStatusAsync(ctx.workspaceRoot, ctx.abortSignal);
  if (r.error) {
    return { ok: false, payload: r, summary: `git_status: ${r.error}` };
  }
  const parts: string[] = [];
  if (r.branch) parts.push(`branch: ${r.branch}`);
  if (r.ahead) parts.push(`ahead ${r.ahead}`);
  if (r.behind) parts.push(`behind ${r.behind}`);
  if (r.staged?.length) parts.push(`${r.staged.length} staged`);
  if (r.modified?.length) parts.push(`${r.modified.length} modified`);
  if (r.untracked?.length) parts.push(`${r.untracked.length} untracked`);
  const summary = parts.length > 0 ? parts.join(", ") : "clean";
  return { ok: true, payload: r, summary: `git_status: ${summary}` };
}

/** `workspace.git_log` */
export async function handleGitLog(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const maxCount = num(rec.max_count, undefined) ?? num(rec.maxCount, undefined) ?? 10;
  const r = await gitLogAsync(ctx.workspaceRoot, maxCount, ctx.abortSignal);
  if (r.error) {
    return { ok: false, payload: r, summary: `git_log: ${r.error}` };
  }
  const n = r.commits?.length ?? 0;
  return { ok: true, payload: r, summary: `git_log: ${n} commit(s)` };
}

/** `workspace.git_diff` */
export async function handleGitDiff(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const diffPath = typeof rec.path === "string" && rec.path.trim() ? rec.path : undefined;
  const r = await gitDiffAsync(ctx.workspaceRoot, diffPath, ctx.abortSignal);
  if (r.error) {
    return { ok: false, payload: r, summary: `git_diff: ${r.error}` };
  }
  const lines = r.diff?.split("\n").length ?? 0;
  return { ok: true, payload: r, summary: `git_diff: ${lines} line(s)` };
}
