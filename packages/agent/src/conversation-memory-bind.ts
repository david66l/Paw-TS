/**
 * 进程内 conversationId → memory TaskSession id 绑定。
 * 桌面 agent-host 多轮 run 复用同一 TaskSession，避免每句 completeTask。
 */

import {
  createMemoryRuntime,
  type MemoryListItem,
} from "@paw/memory";

const conversationTaskMap = new Map<string, string>();

export function bindConversationMemoryTask(
  conversationId: string,
  taskId: string,
): void {
  const id = conversationId.trim();
  const tid = taskId.trim();
  if (!id || !tid) return;
  conversationTaskMap.set(id, tid);
}

export function getConversationMemoryTask(
  conversationId: string,
): string | undefined {
  const id = conversationId.trim();
  if (!id) return undefined;
  return conversationTaskMap.get(id);
}

/** 取出并删除绑定（finalize 时用） */
export function takeConversationMemoryTask(
  conversationId: string,
): string | undefined {
  const id = conversationId.trim();
  if (!id) return undefined;
  const tid = conversationTaskMap.get(id);
  if (tid) conversationTaskMap.delete(id);
  return tid;
}

export function clearConversationMemoryBindings(): void {
  conversationTaskMap.clear();
}

/**
 * 结束桌面会话：complete 绑定的 TaskSession（best-effort，无 DB 时 completed=false）。
 */
/**
 * 列出工作区 scope 下的长期记忆（桌面 Memory 总库）。
 * DB 不可用时 ok=false、items=[]。
 */
export async function listWorkspaceMemories(opts: {
  readonly workspaceRoot: string;
  readonly limit?: number;
  readonly type?: string;
}): Promise<{
  ok: boolean;
  items: MemoryListItem[];
  error?: string;
}> {
  try {
    const runtime = await createMemoryRuntime({
      workspaceRoot: opts.workspaceRoot,
    });
    const ok = await runtime.ping();
    if (!ok) {
      await runtime.shutdown().catch(() => {});
      return {
        ok: false,
        items: [],
        error: "memory backend unavailable (postgres ping failed)",
      };
    }
    const items = await runtime.listMemories({
      limit: opts.limit ?? 40,
      ...(opts.type ? { type: opts.type } : {}),
    });
    await runtime.shutdown().catch(() => {});
    return { ok: true, items: [...items] };
  } catch (e) {
    return {
      ok: false,
      items: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function finalizeConversationMemory(opts: {
  readonly conversationId: string;
  readonly workspaceRoot: string;
  readonly finalMessage?: string;
}): Promise<{ completed: boolean; taskId?: string }> {
  const taskId = takeConversationMemoryTask(opts.conversationId);
  if (!taskId) return { completed: false };

  try {
    const runtime = await createMemoryRuntime({
      workspaceRoot: opts.workspaceRoot,
    });
    const ok = await runtime.ping();
    if (!ok) {
      await runtime.shutdown().catch(() => {});
      return { completed: false, taskId };
    }
    const finalMessage = opts.finalMessage?.trim();
    await runtime.completeTask({
      taskId,
      status: "completed",
      // 宿主占位文案不写进 completedSteps；真正内容由 Writer 从 WM 抽取
      ...(finalMessage &&
      !/^(desktop conversation ended|desktop:\s*new conversation|conversation ended)$/i.test(
        finalMessage,
      )
        ? { finalMessage }
        : {}),
    });
    await runtime.shutdown().catch(() => {});
    return { completed: true, taskId };
  } catch {
    return { completed: false, taskId };
  }
}
