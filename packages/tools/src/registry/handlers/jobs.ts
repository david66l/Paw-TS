import type { ToolRunResult } from "../definitions.js";
/** 后台作业类工具（job_start/list/read/wait/kill）。 */
import { type ToolScope, num, toolErrorResult } from "../tool-support.js";

/** `workspace.job_start` */
export async function handleJobStart(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const command = typeof rec.command === "string" ? rec.command.trim() : "";
  if (!command) {
    return toolErrorResult("job_start", "E_USER", "missing command", {
      field: "command",
    });
  }
  if (!ctx.managedJobs) {
    return toolErrorResult("job_start", "E_FATAL", "managed job controller not configured");
  }
  const cwd = typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd : undefined;
  const outputLimitBytes =
    num(rec.output_limit_bytes, undefined) ?? num(rec.outputLimitBytes, undefined);
  if (
    outputLimitBytes !== undefined &&
    (!Number.isSafeInteger(outputLimitBytes) ||
      outputLimitBytes < 1_024 ||
      outputLimitBytes > 4 * 1024 * 1024)
  ) {
    return toolErrorResult(
      "job_start",
      "E_SCHEMA_INVALID",
      "output_limit_bytes must be an integer between 1024 and 4194304",
    );
  }
  try {
    const started = await ctx.managedJobs.startShell({
      command,
      ...(cwd ? { cwd } : {}),
      ...(outputLimitBytes !== undefined ? { outputLimitBytes } : {}),
    });
    return {
      ok: true,
      payload: started,
      summary: `job_start: ${started.jobId} running (pid ${started.pid})`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolErrorResult(
      "job_start",
      message.startsWith("[ToolExecutionPolicy:") ? "E_POLICY_DENIED" : "E_FATAL",
      message,
    );
  }
}

/** `workspace.job_list` */
export async function handleJobList(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx } = scope;
  if (!ctx.managedJobs) {
    return toolErrorResult("job_list", "E_FATAL", "managed job controller not configured");
  }
  const jobs = ctx.managedJobs.list();
  return {
    ok: true,
    payload: { jobs },
    summary: `job_list: ${jobs.length} job(s)`,
  };
}

/** `workspace.job_read` */
export async function handleJobRead(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return toolErrorResult("job_read", "E_USER", "missing id");
  if (!ctx.managedJobs) {
    return toolErrorResult("job_read", "E_FATAL", "managed job controller not configured");
  }
  try {
    const read = ctx.managedJobs.read(id);
    return {
      ok: true,
      payload: read,
      summary: `job_read: ${id} ${read.snapshot.status} (${read.text.length} chars)`,
    };
  } catch (error) {
    return toolErrorResult(
      "job_read",
      "E_USER",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** `workspace.job_wait` */
export async function handleJobWait(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return toolErrorResult("job_wait", "E_USER", "missing id");
  if (!ctx.managedJobs) {
    return toolErrorResult("job_wait", "E_FATAL", "managed job controller not configured");
  }
  const requested = num(rec.timeout_sec, undefined) ?? 10;
  if (!Number.isFinite(requested) || requested < 0.1 || requested > 30) {
    return toolErrorResult(
      "job_wait",
      "E_SCHEMA_INVALID",
      "timeout_sec must be between 0.1 and 30",
    );
  }
  try {
    const waited = await ctx.managedJobs.wait(id, Math.floor(requested * 1_000), ctx.abortSignal);
    return {
      ok: true,
      payload: waited,
      summary: waited.timedOut
        ? `job_wait: ${id} still ${waited.snapshot.status} after ${requested}s`
        : `job_wait: ${id} ${waited.snapshot.status}`,
    };
  } catch (error) {
    return toolErrorResult(
      "job_wait",
      "E_USER",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** `workspace.job_kill` */
export async function handleJobKill(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) return toolErrorResult("job_kill", "E_USER", "missing id");
  if (!ctx.managedJobs) {
    return toolErrorResult("job_kill", "E_FATAL", "managed job controller not configured");
  }
  const reason =
    typeof rec.reason === "string" && rec.reason.trim() ? rec.reason.trim() : undefined;
  try {
    const status = ctx.managedJobs.kill(id, reason);
    return {
      ok: true,
      payload: { id, status },
      summary: `job_kill: ${id} ${status}`,
    };
  } catch (error) {
    return toolErrorResult(
      "job_kill",
      "E_USER",
      error instanceof Error ? error.message : String(error),
    );
  }
}
