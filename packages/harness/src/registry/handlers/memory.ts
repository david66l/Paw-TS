import type { ToolRunResult } from "../definitions.js";
/** 记忆类工具（memory.list/read/save、context.recall）。 */
import { type ToolScope, num } from "../tool-support.js";

/** `memory.list` */
export async function handleMemoryList(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx } = scope;
  if (!ctx.memoryRuntime) {
    return {
      ok: false,
      payload: {
        error: "memory Runtime unavailable (Postgres down or not initialized)",
      },
      summary: "memory.list: runtime unavailable",
    };
  }
  try {
    const records = await ctx.memoryRuntime.listMemories({ limit: 50 });
    const entries = records.map((r) => ({
      name: r.id,
      type: r.type,
      description: r.summary,
      title: r.title,
      confidence: r.confidence,
    }));
    return {
      ok: true,
      payload: { entries },
      summary: `memory.list: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
    };
  } catch (err) {
    return {
      ok: false,
      payload: {
        error: err instanceof Error ? err.message : String(err),
      },
      summary: "memory.list: failed",
    };
  }
}

/** `memory.read` */
export async function handleMemoryRead(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  if (!name) {
    return {
      ok: false,
      payload: { error: "missing name" },
      summary: "memory.read: missing name",
    };
  }
  if (!ctx.memoryRuntime) {
    return {
      ok: false,
      payload: { error: "memory Runtime unavailable" },
      summary: "memory.read: runtime unavailable",
    };
  }
  try {
    const record = await ctx.memoryRuntime.readMemory(name);
    if (!record) {
      return {
        ok: false,
        payload: { error: `memory not found: ${name}` },
        summary: `memory.read: not found (${name})`,
      };
    }
    return {
      ok: true,
      payload: record,
      summary: `memory.read: ${record.title || name}`,
    };
  } catch (err) {
    return {
      ok: false,
      payload: {
        error: err instanceof Error ? err.message : String(err),
      },
      summary: "memory.read: failed",
    };
  }
}

/** `memory.save` */
export async function handleMemorySave(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const content = typeof rec.content === "string" ? rec.content : "";
  const memType =
    typeof rec.type === "string" && ["user", "feedback", "project", "reference"].includes(rec.type)
      ? (rec.type as "user" | "feedback" | "project" | "reference")
      : "project";
  if (!name) {
    return {
      ok: false,
      payload: { error: "missing name" },
      summary: "memory.save: missing name",
    };
  }
  if (!content) {
    return {
      ok: false,
      payload: { error: "missing content" },
      summary: "memory.save: missing content",
    };
  }
  if (!ctx.memoryRuntime) {
    return {
      ok: false,
      payload: { error: "memory Runtime unavailable" },
      summary: "memory.save: runtime unavailable",
    };
  }
  const description = content.replace(/\n/g, " ").slice(0, 120).trim();
  try {
    const typeMap: Record<string, string> = {
      user: "user_preference",
      feedback: "user_preference",
      project: "project_knowledge",
      reference: "project_knowledge",
    };
    const saved = await ctx.memoryRuntime.saveMemory({
      title: name,
      summary: description,
      content,
      type: typeMap[memType] ?? "project_knowledge",
      taskId: ctx.memoryTaskId,
    });
    return {
      ok: true,
      payload: {
        name,
        candidateId: saved.candidateId,
        decision: saved.decision,
        memoryId: saved.memoryId,
      },
      summary: `memory.save: ${saved.decisionStatus} "${name}"`,
    };
  } catch (err) {
    return {
      ok: false,
      payload: {
        error: err instanceof Error ? err.message : String(err),
      },
      summary: "memory.save: failed",
    };
  }
}

/** `context.recall` */
export async function handleContextRecall(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  if (!id) {
    return {
      ok: false,
      payload: { error: "missing id" },
      summary: "context.recall: missing id",
    };
  }
  const part = rec.part === "tail" || rec.part === "chunk" ? rec.part : "head";
  const offset = num(rec.offset, undefined) ?? 0;
  const limit = num(rec.limit, undefined) ?? 8000;
  if (ctx.payloadRecall) {
    const outcome = await ctx.payloadRecall.recall({ id, part, offset, limit }, ctx.abortSignal);
    if (!outcome.ok) {
      return {
        ok: false,
        payload: { error: outcome.reason },
        summary: `context.recall: ${outcome.reason}`,
      };
    }
    const head = [
      `[recalled output id=${outcome.id}, tool=${outcome.tool}, call=${outcome.callId}]`,
      `[window ${outcome.part} offset=${outcome.offset} len=${outcome.length} total=${outcome.total}]`,
      "--- content ---",
    ].join("\n");
    return {
      ok: true,
      payload: `${head}\n${outcome.content}`,
      summary: `context.recall: ${outcome.tool} (${outcome.length}/${outcome.total} chars)`,
    };
  }
  const registry = ctx.artifactRegistry;
  if (!registry) {
    return {
      ok: false,
      payload: { error: "recall service not configured" },
      summary: "context.recall: recall service not configured",
    };
  }
  const outcome = registry.tryRecall(id, { part, offset, limit });
  if (!outcome.ok) {
    // 预算拒绝 / 无效 ID：返回候选列表（不静默失败）
    return {
      ok: false,
      payload: {
        error: outcome.reason ?? "recall failed",
        ...(outcome.candidates && outcome.candidates.length > 0
          ? { candidates: outcome.candidates }
          : {}),
      },
      summary: `context.recall: ${outcome.reason ?? "failed"}`,
    };
  }
  const entry = outcome.entry;
  const window = outcome.window;
  const head = [
    `[recalled archive id=${entry?.id}, tool=${entry?.tool}, ok=${entry?.ok}, created at turn ${entry?.turn}]`,
    `[window ${window?.part ?? "head"} offset=${window?.offset ?? 0} len=${window?.length ?? 0} total=${window?.total ?? 0}]`,
    ...(entry?.callerText ? [`[producing action] ${entry.callerText.slice(0, 400)}`] : []),
    "--- content ---",
  ].join("\n");
  return {
    ok: true,
    payload: `${head}\n${outcome.content ?? ""}`,
    summary: `context.recall: ${entry?.tool ?? id} (${window?.length ?? 0}/${window?.total ?? "?"} chars)`,
  };
}
