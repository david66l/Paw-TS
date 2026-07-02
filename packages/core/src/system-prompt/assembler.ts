/**
 * System Prompt 组装器。
 * =====================
 *
 * 将多个独立章节组装成完整的 system prompt。
 * 每个章节是一个独立的模块（system-prompt/sections/*.ts），
 * 组合模式使得可以按需增减章节、按模型定制。
 *
 * 组装顺序：
 * 1. Base prompt（首选按模型定制的 .txt 文件，回退到 8 个硬编码章节）
 * 2. Using Tools 章节（工具目录 + 使用说明）
 * 3. Skills 章节（可用技能）
 * 4. Memory 章节（记忆目录说明）
 * 5. Environment 章节（Git 状态、PAW.md、项目记忆、相关记忆、Todo 等）
 *
 * 面试要点：
 * - 模块化章节设计：每个 section 独立，方便按模型定制
 * - Base prompt 可以是外部 .txt 文件（V2 特性，支持 prompt 版本管理和 A/B 测试）
 */

import { resolveBasePrompt } from "../prompt/loader.js";
import { truncateChars } from "./format.js";
import type { SystemPromptOptions } from "./types.js";
import { getActionsSection } from "./sections/actions.js";
import { getDoingTasksSection } from "./sections/doing-tasks.js";
import { getEnvironmentSection } from "./sections/environment.js";
import { getIdentitySection } from "./sections/identity.js";
import { getMemorySection } from "./sections/memory.js";
import { getOutputEfficiencySection } from "./sections/output-efficiency.js";
import { getSecurityBoundariesSection } from "./sections/security.js";
import { getSystemSection } from "./sections/system.js";
import { getToneAndStyleSection } from "./sections/tone-and-style.js";
import { getUsingToolsSection } from "./sections/using-tools.js";
import { getVerificationSection } from "./sections/verification.js";

/**
 * 组装完整的 system prompt。
 *
 * @param opts 包含所有构建 system prompt 所需的信息
 * @returns 完整的 system prompt 字符串（各章节用 \n\n 分隔）
 */
export function assembleSystemPrompt(opts: SystemPromptOptions): string {
  const platform = process.platform;
  const shell = process.env.SHELL?.split("/").pop() ?? "unknown";
  const osVersion = `${platform} ${process.env.OS_VERSION ?? ""}`.trim();

  // 工具目录截断（如果指定了最大字符数）
  const toolCatalog =
    opts.toolCatalogMaxChars !== undefined
      ? truncateChars(opts.toolCatalog, opts.toolCatalogMaxChars)
      : opts.toolCatalog;

  // Skills 截断（可选的 omitSkills 控制是否包含）
  let skills: string | undefined;
  if (!opts.omitSkills && opts.skills) {
    skills =
      opts.skillsMaxChars !== undefined
        ? truncateChars(opts.skills, opts.skillsMaxChars)
        : opts.skills;
  }

  // V2：按模型定制的 base prompt（.txt 文件）替代旧的硬编码章节
  // 如果找不到定制 prompt，回退到 8 个硬编码章节的组合
  const basePrompt =
    resolveBasePrompt(opts.modelId) ||
    [
      getIdentitySection(),
      getSecurityBoundariesSection(),
      getSystemSection(),
      getDoingTasksSection(),
      getVerificationSection(),
      getActionsSection(),
      getToneAndStyleSection(),
      getOutputEfficiencySection(),
    ].join("\n\n");

  const sections: (string | null)[] = [
    basePrompt,
    getUsingToolsSection({
      hasTaskTool: true,
      hasSkills: skills !== undefined && skills.length > 0,
      toolCatalog,
    }),
    skills ?? null,
    getMemorySection({
      memoryDir: opts.memoryDir,
      hasAutoMemory: opts.hasAutoMemory,
      memoryIndex: opts.memoryIndex,
      maxMemoryIndexLines: opts.maxMemoryIndexLines,
    }),
    getEnvironmentSection({
      workspaceRoot: opts.workspaceRoot,
      isGit: opts.gitStatus !== undefined,
      gitStatus: opts.gitStatus,
      pawMd: opts.pawMd,
      projectMemory: opts.projectMemory,
      relevantMemories: opts.relevantMemories,
      todos: opts.todos,
      language: opts.language,
      modelLabel: opts.modelLabel,
      modelId: opts.modelId,
      platform,
      shell,
      osVersion,
      includeMemoryDetail: opts.includeMemoryDetail,
      maxRelevantMemories: opts.maxRelevantMemories,
      omitPawMd: opts.omitPawMd,
      omitProjectMemoryLocal: opts.omitProjectMemoryLocal,
    }),
  ];

  // 过滤掉 null 章节（如 Skills 为 undefined 时）
  return sections.filter((s): s is string => s !== null).join("\n\n");
}
