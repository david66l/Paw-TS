/**
 * 系统提示词章节：运行环境
 *
 * 【章节用途】
 * 生成 system prompt 中描述当前运行环境的章节。向 AI 提供其所在上下文的关键信息：
 * 工作目录、Git 状态、平台/Shell/OS、模型标识、项目指令（PAW.md / CLAUDE.md）、
 * 相关记忆记录、待办事项、以及输出语言偏好。
 *
 * 【为什么需要这个章节】
 * AI 需要知道自己"在哪儿"才能做出正确的决策：
 * - 工作目录决定了文件操作的根路径
 * - Git 状态让 AI 了解当前分支和未提交变更，避免误操作
 * - 模型标识让 AI 知道自己的能力边界
 * - 项目指令和记忆提供长期上下文，减少重复说明
 *
 * 【关键设计决策】
 * - 将多个环境子模块聚合到一个章节中，减少 system prompt 的章节碎片化
 * - 通过 `truncateTextToTokenBudget` 对记忆内容做 token 预算截断，防止记忆过长
 * - `omitPawMd` 和 `omitProjectMemoryLocal` 标志允许调用方按场景裁剪（如安全场景）
 * - `maxRelevantMemories` 限制注入的记忆数量，控制上下文长度
 * - 语言设置独立为 "# Language" 子章节，要求 AI 用指定语言回复但保留技术术语原文
 */
import { truncateTextToTokenBudget } from "../../context/budget.js";
import { bullets } from "../format.js";
import type { MemoryRecord } from "@paw/memory";
import type { ProjectMemory } from "@paw/memory";

export function getEnvironmentSection(opts: {
  /** 工作区根目录绝对路径 */
  workspaceRoot: string;
  /** 是否为 Git 仓库 */
  isGit: boolean;
  /** Git 状态文本（git status 输出） */
  gitStatus?: string;
  /** PAW.md 文件内容（项目级别指令） */
  pawMd?: string;
  /** 项目记忆（已提交 + 本地偏好） */
  projectMemory?: ProjectMemory;
  /** 与当前上下文相关的历史记忆记录 */
  relevantMemories?: readonly MemoryRecord[];
  /** 待办事项文本 */
  todos?: string;
  /** 输出语言（如 "Chinese"） */
  language?: string;
  /** 模型显示名称 */
  modelLabel: string;
  /** 模型标识 ID */
  modelId: string;
  /** 操作系统平台 */
  platform: string;
  /** 当前 Shell 类型 */
  shell: string;
  /** 操作系统版本 */
  osVersion: string;
  /** 是否包含详细记忆内容 */
  includeMemoryDetail?: boolean;
  /** 最多注入的记忆条数 */
  maxRelevantMemories?: number;
  /** 是否省略 PAW.md */
  omitPawMd?: boolean;
  /** 是否省略本地项目记忆 */
  omitProjectMemoryLocal?: boolean;
}): string {
  // 基础环境信息列表，包含工作目录、Git 状态、平台、Shell、OS 和模型信息
  const envItems: string[] = [
    `Primary working directory: ${opts.workspaceRoot}`,
    `Is a git repository: ${opts.isGit ? "Yes" : "No"}`,
    `Platform: ${opts.platform}`,
    `Shell: ${opts.shell}`,
    `OS Version: ${opts.osVersion}`,
    `You are powered by the model named ${opts.modelLabel}. The exact model ID is ${opts.modelId}.`,
    "The most recent Claude model family is Claude 4.5/4.6. Model IDs — Opus 4.6: 'claude-opus-4-6', Sonnet 4.6: 'claude-sonnet-4-6', Haiku 4.5: 'claude-haiku-4-5-20251001'. When building AI applications, default to the latest and most capable Claude models.",
  ];

  // 用标题和 bullets 格式开始构建输出行
  const lines: string[] = [
    "# Environment",
    "You have been invoked in the following environment:",
    "",
    bullets(envItems),
  ];

  // 如果有 Git 状态信息，附加到输出
  if (opts.gitStatus) {
    lines.push("", opts.gitStatus);
  }

  // 注入 PAW.md 项目指令（除非被显式省略）
  if (opts.pawMd && !opts.omitPawMd) {
    lines.push("", "Project instructions (PAW.md):", opts.pawMd);
  }

  // 注入已提交的项目规则（.paw/CLAUDE.md）
  if (opts.projectMemory?.committed) {
    lines.push(
      "",
      "Project rules (.paw/CLAUDE.md):",
      opts.projectMemory.committed,
    );
  }
  // 注入本地偏好（.paw/CLAUDE.local.md），除非被显式省略
  if (opts.projectMemory?.local && !opts.omitProjectMemoryLocal) {
    lines.push(
      "",
      "Local preferences (.paw/CLAUDE.local.md):",
      opts.projectMemory.local,
    );
  }

  // 对相关记忆做截断：如果设置了最大条数，只取前 N 条
  const memories = opts.relevantMemories
    ? opts.maxRelevantMemories !== undefined
      ? opts.relevantMemories.slice(0, opts.maxRelevantMemories)
      : opts.relevantMemories
    : undefined;

  // 如果有相关记忆，逐条渲染，第一条可附带截断后的详细内容
  if (memories && memories.length > 0) {
    lines.push("", "Relevant past experiences:");
    for (let i = 0; i < memories.length; i++) {
      const m = memories[i]!;
      lines.push(`- ${m.title}: ${m.summary}`);
      // 仅对第一条记忆展开详细内容（受 token 预算限制）
      if (i === 0 && m.content.trim() && opts.includeMemoryDetail !== false) {
        lines.push(
          `  Detail:\n${truncateTextToTokenBudget(m.content, 300)}`,
        );
      }
      // 列出关联文件，帮助 AI 定位上下文
      if (m.relatedFiles.length > 0) {
        lines.push(`  Related files: ${m.relatedFiles.join(", ")}`);
      }
    }
  }

  // 注入待办事项
  if (opts.todos) {
    lines.push("", opts.todos);
  }

  // 语言设置：要求 AI 用指定语言回复，但保留技术术语原文
  if (opts.language) {
    lines.push(
      "",
      "# Language",
      `Always respond in ${opts.language}. Use ${opts.language} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`,
    );
  }

  return lines.join("\n");
}
