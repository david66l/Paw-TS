import type { ConversationTurn } from "./conversationHistory";
import { formatModelTextForUi } from "./formatModelText";
import type { UiMessage } from "./types";

export type ChatSession = {
  readonly id: string;
  /** 侧栏标题（通常取首条用户消息） */
  readonly title: string;
  readonly updatedAt: number;
  readonly messages: readonly UiMessage[];
  readonly history: readonly ConversationTurn[];
};

export const SESSIONS_STORAGE_KEY = "paw-desktop-sessions-v1";
export const ACTIVE_SESSION_STORAGE_KEY = "paw-desktop-active-session-v1";
export const MAX_SESSIONS = 40;

export function deriveSessionTitle(
  messages: readonly UiMessage[],
  fallback = "新对话",
): string {
  const firstUser = messages.find((m) => m.role === "user")?.content?.trim();
  if (!firstUser) return fallback;
  return firstUser.length > 28 ? `${firstUser.slice(0, 28)}…` : firstUser;
}

export function createEmptySession(id?: string): ChatSession {
  const now = Date.now();
  return {
    id: id ?? `conv-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: "新对话",
    updatedAt: now,
    messages: [],
    history: [],
  };
}

export function loadSessionsFromStorage(): {
  sessions: ChatSession[];
  activeId: string;
} {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    const activeRaw = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (!raw) {
      const s = createEmptySession();
      return { sessions: [s], activeId: s.id };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      const s = createEmptySession();
      return { sessions: [s], activeId: s.id };
    }
    const sessions: ChatSession[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : "";
      if (!id) continue;
      const messages = Array.isArray(o.messages)
        ? (o.messages as UiMessage[]).map((m) => {
            const base = { ...m, streaming: false };
            // 历史会话里可能残留未清洗的 final_answer / tool JSON
            if (base.role === "assistant" && typeof base.content === "string") {
              const cleaned = formatModelTextForUi(base.content);
              if (cleaned !== null && cleaned !== base.content) {
                return { ...base, content: cleaned };
              }
              // 纯工具 JSON → 空正文（保留 thinking）
              if (cleaned === null) {
                return { ...base, content: "" };
              }
            }
            return base;
          })
        : [];
      const history = Array.isArray(o.history)
        ? (o.history as ConversationTurn[])
        : [];
      sessions.push({
        id,
        title:
          typeof o.title === "string" && o.title.trim()
            ? o.title
            : deriveSessionTitle(messages),
        updatedAt:
          typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
        messages,
        history,
      });
    }
    if (sessions.length === 0) {
      const s = createEmptySession();
      return { sessions: [s], activeId: s.id };
    }
    const activeId =
      typeof activeRaw === "string" &&
      sessions.some((s) => s.id === activeRaw)
        ? activeRaw
        : sessions[0]!.id;
    return { sessions, activeId };
  } catch {
    const s = createEmptySession();
    return { sessions: [s], activeId: s.id };
  }
}

/** 比较消息内容是否实质相同（忽略 streaming 标记） */
export function sameSessionMessages(
  a: readonly UiMessage[],
  b: readonly UiMessage[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.role !== y.role || x.content !== y.content) {
      return false;
    }
  }
  return true;
}

export function sameSessionHistory(
  a: readonly ConversationTurn[],
  b: readonly ConversationTurn[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.role !== y.role || x.content !== y.content) return false;
  }
  return true;
}

/**
 * 持久化时按 updatedAt 截断，但**不**重排传入数组顺序。
 * 列表 UI 顺序由内存 state 决定；仅在真实内容变更时 touch updatedAt。
 */
export function saveSessionsToStorage(
  sessions: readonly ChatSession[],
  activeId: string,
): void {
  try {
    // 超出上限时丢掉最旧（updatedAt 最小），保留其余的相对顺序
    let list = sessions.slice();
    if (list.length > MAX_SESSIONS) {
      const dropIds = new Set(
        [...list]
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, list.length - MAX_SESSIONS)
          .map((s) => s.id),
      );
      list = list.filter((s) => !dropIds.has(s.id));
    }
    const trimmed = list.map((s) => ({
      ...s,
      messages: s.messages.map((m) => ({
        ...m,
        streaming: false,
      })),
    }));
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(trimmed));
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeId);
  } catch {
    /* quota / private mode */
  }
}
