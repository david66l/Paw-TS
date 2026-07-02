/**
 * 辅助任务的单次模型调用（压缩、记忆提取）。
 * ============================================
 *
 * 不需要工具，不需要 orchestrator 循环 — 最小的 token 开销。
 *
 * 与完整 Agent 循环的区别：
 * - 只有一次 system + user → assistant 的往返
 * - 不使用流式输出（complete 而非 completeStream）
 * - 不需要工具定义
 * - 用于 L2 压缩、记忆提取、会话摘要等"一次性"任务
 *
 * 为什么叫 "auxiliary"？
 * 这些任务不需要主模型的全能力，用便宜的辅助模型即可。
 */

import type { ChatMessage } from "@paw/models";
import type { LanguageModel } from "@paw/models";

/**
 * 执行一次辅助任务的模型调用。
 *
 * @param opts.model 使用的模型（通常是 auxiliaryModel，比主模型便宜）
 * @param opts.system 系统提示词
 * @param opts.user 用户消息（包含任务的完整上下文）
 * @param opts.signal 可选的 AbortSignal
 * @returns 模型返回的文本（已 trim）
 */
export async function completeAuxiliaryTask(opts: {
  readonly model: LanguageModel;
  readonly system: string;
  readonly user: string;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const result = await opts.model.complete(messages, {
    signal: opts.signal,
  });
  return result.text.trim();
}
