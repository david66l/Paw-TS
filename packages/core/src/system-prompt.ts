/**
 * 系统提示词构建与预算裁剪 —— 为 LLM 构建上下文窗口的系统提示词部分。
 *
 * ## 模块定位
 *
 * 本模块是 LLM 系统提示词的"组装和裁剪"入口。它负责：
 * 1. 将各类组件（记忆、工具定义、规则、环境信息等）组装为完整的系统提示词
 * 2. 当组装后的提示词超出 token 预算时，按优先级裁剪各组件
 * 3. 对外提供两个公开函数：buildSystemPrompt（简单模式）和 buildSystemPromptWithBudget（预算感知模式）
 *
 * ## 为什么需要预算裁剪
 *
 * 不同模型有不同的上下文窗口大小（如 32K、100K、200K tokens），
 * 而系统提示词的组件数量是动态的（记忆数量、工具数量随项目复杂度变化）。
 * 如果没有预算裁剪，可能出现：
 * - 系统提示词过大，挤占用户消息和输出的空间
 * - 超出模型上下文窗口导致截断或错误
 * - 低优先级组件（如冗长的小记忆）占据高优先级组件的空间
 *
 * ## 核心流程
 *
 * 1. buildSystemPrompt(opts) → 简单模式，内部调用 buildSystemPromptWithBudget
 * 2. buildSystemPromptWithBudget(opts, budget)
 *    a. 调用 assembleSystemPrompt 组装完整提示词
 *    b. 估算 token 数
 *    c. 如果未超预算 → 直接返回
 *    d. 如果超出预算 → 调用 trimSystemPromptToBudget 按优先级裁剪
 *
 * ## 关键设计决策
 *
 * - 组件组装委托给 system-prompt/assembler.ts（单一职责）
 * - 裁剪逻辑委托给 system-prompt/trim.ts（可独立测试和调优）
 * - token 估算使用快速估算法（字符数 ÷ 4），而非精确的 tiktoken 计数
 * - MAX_STEPS_WARNING 作为一个独立的静态提示，在接近步数上限时注入
 */

import { estimateTokens } from "./token-estimate.js";
import { truncateTextToTokenBudget } from "./context/budget.js";
import { assembleSystemPrompt } from "./system-prompt/assembler.js";
import { trimSystemPromptToBudget } from "./system-prompt/trim.js";
import type {
  SystemPromptBuildResult,
  SystemPromptOptions,
} from "./system-prompt/types.js";

// 重新导出类型，方便调用方 import
export type {
  SystemPromptOptions,
  SystemPromptBuildResult,
  SystemPromptTrimEntry,
} from "./system-prompt/types.js";

// 重新导出组装函数（供需要分步构建的调用方使用）
export { assembleSystemPrompt } from "./system-prompt/assembler.js";

/**
 * 最大步数警告提示词。
 *
 * 当 Agent 接近最大执行步数时，将此文本注入到系统提示词中，
 * 强制要求 LLM 停止探索、提交当前结果。
 *
 * 这不是通过常规的 assemble 流程注入的，而是在运行时由
 * 步数监控逻辑动态追加到系统提示词末尾。
 */
export const MAX_STEPS_WARNING = `CRITICAL - APPROACHING MAXIMUM STEPS

You are approaching the maximum number of steps for this task. Stop exploring and complete the task now.

STRICT REQUIREMENTS:
1. Do NOT start any new explorations or read additional files unless absolutely critical
2. Complete the task with the information you already have
3. Call final_answer with a summary of what was accomplished and any remaining work
4. If you cannot complete the task with available information, state what was done and what remains`;

/**
 * 构建系统提示词（简单模式）。
 *
 * 这是最常用的入口。内部调用 buildSystemPromptWithBudget 但不传入 token 预算，
 * 因此不会进行裁剪。适用于不需要预算控制的场景。
 *
 * @param opts - 系统提示词构建选项
 * @returns 完整的系统提示词文本
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
  return buildSystemPromptWithBudget(opts).content;
}

/**
 * 构建系统提示词（预算感知模式）。
 *
 * 这是完整版入口，支持 token 预算控制：
 * 1. 先组装完整提示词
 * 2. 估算 token 数
 * 3. 如果超出预算，按优先级裁剪各组件直到符合预算
 *
 * 裁剪信息（哪些组件被裁剪、各减了多少 token）记录在 result.trimmed 中，
 * 用于日志记录和调试。
 *
 * @param opts - 系统提示词构建选项
 * @param systemBudget - 系统提示词的 token 预算上限（undefined = 不限制）
 * @param estimate - token 估算函数（默认使用 estimateTokens，可注入用于测试）
 * @returns 包含最终文本和裁剪记录的结果
 */
export function buildSystemPromptWithBudget(
  opts: SystemPromptOptions,
  systemBudget?: number,
  estimate?: (text: string) => number,
): SystemPromptBuildResult {
  // 确定 token 估算函数：优先使用传入的，否则使用默认的快速估算法
  const doEstimate = estimate ?? estimateTokens;

  // 第一步：组装完整的系统提示词（包含所有组件，不做裁剪）
  const initialContent = assembleSystemPrompt(opts);
  const initialTokens = doEstimate(initialContent);

  // 第二步：检查是否需要裁剪
  // 没有预算限制 或 token 数未超过预算 → 直接返回完整内容
  if (systemBudget === undefined || initialTokens <= systemBudget) {
    return { content: initialContent, trimmed: [] };
  }

  // 第三步：超出预算，执行裁剪
  return trimSystemPromptToBudget({
    opts,
    systemBudget,
    initialContent,
    initialTokens,
    estimate: doEstimate,
    assemble: assembleSystemPrompt,
    truncate: truncateTextToTokenBudget,
  });
}
