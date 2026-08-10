/**
 * 桌面多轮：把近期对话拼进 goal，供 agent-host / runStubRun 使用。
 * 不依赖记忆系统；记忆对齐是后续阶段。
 */

export type ConversationTurn = {
  readonly role: "user" | "assistant";
  readonly content: string;
};

export type BuildGoalWithHistoryOptions = {
  /** 最多带入的 turn 数（user+assistant 各算 1），默认 16 */
  readonly maxTurns?: number;
  /** history 文本最大字符，默认 12000 */
  readonly maxChars?: number;
};

/**
 * 将历史 turns + 当前用户请求合成 effective goal。
 * history 不含当前这条 user 消息。
 */
export function buildGoalWithHistory(
  currentGoal: string,
  history: readonly ConversationTurn[],
  options?: BuildGoalWithHistoryOptions,
): string {
  const goal = currentGoal.trim();
  if (!goal) return "";

  const maxTurns = options?.maxTurns ?? 16;
  const maxChars = options?.maxChars ?? 12_000;

  const trimmed = history
    .filter((t) => t.content.trim().length > 0)
    .slice(-maxTurns);

  if (trimmed.length === 0) return goal;

  const lines: string[] = [
    "[Conversation so far — context only. The user has a NEW request below; act on that.]",
  ];
  for (const t of trimmed) {
    const label = t.role === "user" ? "User" : "Assistant";
    const body = t.content.trim();
    lines.push(`${label}: ${body}`);
  }

  let historyBlock = lines.join("\n");
  if (historyBlock.length > maxChars) {
    historyBlock =
      "…(earlier turns truncated)…\n" +
      historyBlock.slice(historyBlock.length - maxChars);
  }

  return `${historyBlock}\n\n[Current user request]\n${goal}`;
}
