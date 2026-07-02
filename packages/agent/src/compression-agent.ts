/**
 * 压缩 Agent：单次模型调用生成对话摘要。
 * =========================================
 *
 * 这是 L2 上下文压缩的核心。不是完整的 Agent 循环——只需要一次
 * 辅助模型调用就能生成结构化的 markdown 摘要。
 *
 * 与完整 Agent 循环的区别：
 * - 不需要工具调用
 * - 不需要多轮对话
 * - 用便宜的辅助模型（auxiliaryModel）执行
 * - 输出被解析为 SessionMemory 结构，供后续的 maybeCompactHistory 使用
 *
 * 输出结构（8 个章节）：
 * - Active Task：当前正在执行的任务
 * - Goal：总体目标
 * - Progress：已完成进度
 * - Key Decisions：关键决策
 * - Relevant Files：涉及的文件
 * - Errors & Fixes：错误和修复
 * - Next Steps：下一步
 * - Pending Questions：待解决问题
 */

import type { SessionMemory } from "@paw/core";
import { parseMarkdownSections } from "@paw/core";
import type { LanguageModel } from "@paw/models";

import { completeAuxiliaryTask } from "./auxiliary-complete.js";

export interface CompressionAgentResult {
  /** 替换被压缩历史的 markdown 摘要文本 */
  readonly summary: string;
  /** 从对话中提取的结构化会话记忆 */
  readonly sessionMemory: SessionMemory;
}

/** 压缩 Agent 的系统提示词 */
const COMPRESSION_SYSTEM = `You are a context compression assistant. Distill conversation history into structured markdown so the AI can continue without re-reading the full thread. Be concise but preserve actionable information.`;

/** 输出格式指令：要求模型按固定章节输出 markdown */
const COMPRESSION_SECTIONS = `Respond with ONLY a markdown document containing these sections:
## Active Task
## Goal
## Progress
## Key Decisions
## Relevant Files
## Errors & Fixes
## Next Steps
## Pending Questions`;

/**
 * 通过一次便宜的辅助模型调用总结对话片段。
 *
 * @param model 辅助模型（通常比主模型便宜）
 * @param prompt 包含待压缩消息的完整提示词
 * @param runId 当前 Run ID（用于 SessionMemory 的 session 字段）
 * @param signal 中断信号
 */
export async function runCompressionAgent(
  model: LanguageModel,
  prompt: string,
  runId: string,
  signal?: AbortSignal,
): Promise<CompressionAgentResult> {
  const summary = await completeAuxiliaryTask({
    model,
    system: COMPRESSION_SYSTEM,
    user: `${prompt}\n\n${COMPRESSION_SECTIONS}`,
    signal,
  });

  const sessionMemory = parseSummaryToSessionMemory(summary, runId);

  return { summary, sessionMemory };
}

/**
 * 将压缩 Agent 输出的 markdown 解析为 SessionMemory 结构。
 *
 * 使用 parseMarkdownSections 按 ## 标题分割，然后映射到 SessionMemory 字段。
 */
function parseSummaryToSessionMemory(
  summary: string,
  runId: string,
): SessionMemory {
  const sections = parseMarkdownSections(summary);

  return {
    session: runId,
    project: "",
    updatedAt: Date.now(),
    task: sections["active task"],
    currentState: sections.progress,
    filesAndFunctions: sections["relevant files"]
      ?.split("\n")
      .filter((l) => l.trim().startsWith("- ") || l.trim().startsWith("`"))
      .map((l) => l.trim()),
    keyDecisions: sections["key decisions"]
      ?.split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => l.trim().slice(2)),
    errorsAndFixes: sections["errors & fixes"]
      ?.split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => l.trim().slice(2)),
    relevantContext:
      sections["next steps"] || sections["pending questions"]
        ? `Next Steps:\n${sections["next steps"] ?? ""}\n\nPending Questions:\n${sections["pending questions"] ?? ""}`
        : undefined,
  };
}
