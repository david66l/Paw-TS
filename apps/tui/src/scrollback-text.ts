import {
  parseAgentActionFromModelText,
  parseAgentActionsFromModelText,
} from "@paw/agent";

/**
 * 清理模型输出文本，使其适合展示在滚动日志中。
 *
 * 主要处理：
 * 1. 移除 `<overview>`、`<thinking>`、`<think>` 等内部标签；
 * 2. 如果模型输出包含 `final_answer` 动作，仅返回其 summary；
 * 3. 去掉工具调用的 JSON 块，并压缩连续空行。
 *
 * @param text 原始模型输出
 * @returns 清理后的可展示文本
 */
export function stripAssistantTextForScrollback(text: string): string {
  // 第一步：移除常见内部思考/概览标签
  const withoutTags = text
    .replace(/<overview>[\s\S]*?<\/overview>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  // 第二步：若存在最终答案动作，仅展示其摘要
  const finalAction = parseAgentActionFromModelText(withoutTags);
  if (finalAction?.type === "final_answer") {
    return finalAction.summary.trim();
  }

  // 第三步：去掉工具调用 JSON，压缩多余空行
  return parseAgentActionsFromModelText(withoutTags).text.trim().replace(/\n{3,}/g, "\n\n");
}
