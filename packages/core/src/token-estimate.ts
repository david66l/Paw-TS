/**
 * Token 估算启发式方法（对外暴露的便捷函数）。
 * Token estimation heuristic.
 *
 * ============================================================================
 * 模块职责 (Module Purpose)
 * ============================================================================
 * 本模块是对外暴露的 token 估算 API 层。它提供了一套简洁的函数接口，
 * 用于估算文本和消息的 token 数量。
 *
 * 设计决策：
 * - **单一 Estimator 实例**：所有函数共享同一个 FastEstimator 实例
 *   （通过 getSharedFastEstimator() 获取），避免重复初始化和重复计算。
 * - **委托模式**：实际估算逻辑委托给 token-estimator.ts 中的 FastEstimator
 *   类。本模块纯属更简洁、更易用的外观（Facade）层。
 * - **保留向后兼容**：保留了旧版 API 的函数签名（estimateTokens、
 *   estimateMessageTokens、estimateMessagesTokens），所有旧版调用点无需修改。
 *
 * 核心估算方法：字符数 / 4（英文的粗略比例是每 4 个字符约 1 个 token）。
 *
 * 架构定位：外观层（Facade），位于消费者代码和 token-estimator.ts 核心实现之间。
 * ============================================================================
 */

import type { ChatMessage } from "./context/manager.js";
import { getSharedFastEstimator } from "./token-estimator.js";

/**
 * 对纯文本字符串的粗略 token 计数。
 * 使用"长度 / 4"启发式算法：英文中大约每 4 个字符对应 1 个 token。
 *
 * Rough token count for a plain string using the length/4 heuristic.
 */
export function estimateTokens(text: string): number {
  return getSharedFastEstimator().count(text);
}

/**
 * 对单条 ChatMessage 的 token 计数。
 * 计入消息内容、思考块（thinking blocks）和图片附件。
 *
 * Token count for a single {@link ChatMessage}.
 * Accounts for message content, thinking blocks, and image attachments.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  return getSharedFastEstimator().countMessages([message]);
}

/**
 * 对消息数组（如完整对话）的 token 计数。
 *
 * Token count for an array of messages (e.g. the full conversation).
 */
export function estimateMessagesTokens(
  messages: readonly ChatMessage[],
): number {
  return getSharedFastEstimator().countMessages(messages);
}
