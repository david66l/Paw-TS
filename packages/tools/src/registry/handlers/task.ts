/** 任务状态类工具（acceptance_update/todo_write/progress_read/context.compact/brief）。 */
import { generateBrief } from "@paw/workspace";
import type { ToolRunResult } from "../definitions.js";
import { type ToolScope, num, parseAcceptanceUpdate, toolErrorResult } from "../tool-support.js";

/** `workspace.acceptance_update` */
export async function handleAcceptanceUpdate(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const parsed = parseAcceptanceUpdate(rec);
  if (typeof parsed === "string") {
    return toolErrorResult("acceptance_update", "E_SCHEMA_INVALID", parsed);
  }
  if (!ctx.acceptanceLedger) {
    return toolErrorResult("acceptance_update", "E_FATAL", "acceptance ledger not configured");
  }
  const result = await ctx.acceptanceLedger.apply(parsed);
  if (!result.ok) {
    return toolErrorResult(
      "acceptance_update",
      "E_USER",
      result.error ?? "acceptance ledger rejected the update",
    );
  }
  return {
    ok: true,
    payload: {
      updated: true,
      state: result.state,
    },
    summary: `acceptance_update: ${parsed.add.length} added, ${parsed.updates.length} updated`,
  };
}

/** `workspace.todo_write` */
export async function handleTodoWrite(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const todos = Array.isArray(rec.todos) ? rec.todos : [];
  const items = todos
    .map((t: unknown): import("@paw/core").TodoItem | null => {
      if (t === null || typeof t !== "object") return null;
      const o = t as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : "";
      const content = typeof o.content === "string" ? o.content : "";
      const status =
        o.status === "pending" || o.status === "in_progress" || o.status === "done"
          ? o.status
          : "pending";
      const priority =
        o.priority === "low" || o.priority === "medium" || o.priority === "high"
          ? o.priority
          : undefined;
      if (!id || !content) return null;
      return { id, content, status, ...(priority ? { priority } : {}) };
    })
    .filter((t): t is import("@paw/core").TodoItem => t !== null);
  if (ctx.taskProgress) {
    const outcome = await ctx.taskProgress.write(items, ctx.abortSignal);
    if (!outcome.ok) {
      return toolErrorResult("todo_write", "E_USER", outcome.reason);
    }
    return {
      ok: true,
      payload: outcome.value,
      summary: `todo_write: ${items.length} task(s), ${outcome.value.percent}% complete`,
    };
  }
  const todoStore = ctx.todoStore;
  if (!todoStore) {
    return {
      ok: false,
      payload: { error: "todo store not configured" },
      summary: "todo_write: todo store not configured",
    };
  }
  todoStore.set(items);
  return {
    ok: true,
    payload: { count: items.length },
    summary: `todo_write: ${items.length} task(s)`,
  };
}

/** `workspace.progress_read` */
export async function handleProgressRead(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx } = scope;
  if (!ctx.taskProgress) {
    return toolErrorResult("progress_read", "E_FATAL", "task progress service not configured");
  }
  const outcome = await ctx.taskProgress.read(ctx.abortSignal);
  if (!outcome.ok) {
    return toolErrorResult("progress_read", "E_USER", outcome.reason);
  }
  return {
    ok: true,
    payload: outcome.value,
    summary: outcome.value.snapshot
      ? `progress_read: ${outcome.value.snapshot.percent}% complete, ${outcome.value.activities.length} background job(s)`
      : `progress_read: no task list, ${outcome.value.activities.length} background job(s)`,
  };
}

/** `context.compact` */
export async function handleContextCompact(_scope: ToolScope): Promise<ToolRunResult> {
  return {
    ok: true,
    payload: {
      requested: true,
      note: "Compaction checkpoint requested; it runs at the next safe boundary.",
    },
    summary: "context_compact: checkpoint requested",
  };
}

/** `workspace.brief` */
export async function handleBrief(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const briefPath = typeof rec.path === "string" ? rec.path : ".";
  const maxFiles = num(rec.max_files, undefined) ?? num(rec.maxFiles, undefined);
  const r = generateBrief(ctx.workspaceRoot, {
    path: briefPath,
    ...(maxFiles !== undefined ? { maxFiles } : {}),
  });
  if (r.error) {
    return { ok: false, payload: r, summary: `brief: ${r.error}` };
  }
  const lines = r.summary?.split("\n").length ?? 0;
  return {
    ok: true,
    payload: r,
    summary: `brief: ${r.filesScanned ?? 0} files, ${lines} lines`,
  };
}
