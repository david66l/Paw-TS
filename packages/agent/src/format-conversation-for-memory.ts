/**
 * 将对话历史格式化为记忆提取子 Agent 的输入。
 * ==============================================
 *
 * 跳过 system prompt（工具目录），保持提取负载聚焦于有意义的对话内容。
 *
 * 导出函数：
 * - formatConversationForMemoryExtraction()：格式化消息为纯文本
 * - shouldAttemptMemoryExtraction()：判断对话是否值得提取记忆
 */

import type { ChatMessage } from "@paw/models";

/**
 * 将消息列表格式化为记忆提取 Agent 的输入文本。
 *
 * 过滤规则：
 * - 跳过 system 消息（工具定义等，不包含需要记忆的信息）
 * - 跳过空消息
 * - 每条消息标为 [User] 或 [Assistant]
 */
export function formatConversationForMemoryExtraction(
  messages: readonly ChatMessage[],
): string {
  const blocks: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    const content = msg.content.trim();
    if (!content) continue;
    const label = msg.role === "user" ? "User" : "Assistant";
    blocks.push(`[${label}]\n${content}`);
  }
  return blocks.join("\n\n");
}

/**
 * 判断对话是否值得尝试记忆提取。
 *
 * 条件：至少 2 条非 system 非空消息。
 * 如果只有 system prompt + 一条 goal，说明对话太短，没有可提取的记忆。
 */
export function shouldAttemptMemoryExtraction(
  messages: readonly ChatMessage[],
): boolean {
  const nonSystem = messages.filter(
    (m) => m.role !== "system" && m.content.trim().length > 0,
  );
  return nonSystem.length >= 2;
}
