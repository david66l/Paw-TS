/**
 * 系统提示词 token 预算裁剪模块
 * ============================================
 *
 * 【模块目的】
 * 当系统提示词的 token 数超过上下文窗口的预算上限时，按照预设的阶梯降级策略
 * 逐步裁减各个可选段，直到内容适配预算。这是 token 预算管理的最后一道防线。
 *
 * 【架构定位】
 * 本模块将裁剪逻辑从 system-prompt.ts 的组装逻辑中分离出来，遵循单一职责原则：
 * - system-prompt.ts：负责"组装"各段内容，不关心 token 是否超预算
 * - trim.ts：负责"降级"组装结果，使最终内容适配给定的 token 预算
 * 组装器只需关心内容的结构和语义，不需要内嵌复杂的阶梯式裁剪表。
 *
 * 【裁剪策略 — 两阶段阶梯降级】
 * 第一阶段（STANDARD_TRIM_STEPS）：优先裁减最重且最不关键的内容段：
 *   1. 去掉 top-1 记忆详情块（includeMemoryDetail: false）
 *   2. 相关记忆从全部 → 3 条
 *   3. 相关记忆从 3 条 → 1 条
 *   4. 记忆索引截断至 100 行
 *   5. 记忆索引截断至 50 行
 *   6. 省略项目本地记忆（omitProjectMemoryLocal）
 *   7. 省略 PAW.md（omitPawMd）—— 最激进的内容裁减
 *
 * 第二阶段（EMERGENCY_TRIM_STEPS）：当内容裁减不够时，压缩工具目录：
 *   1. 工具目录上限 8000 字符
 *   2. 工具目录上限 4000 字符
 *   3. 工具目录上限 2000 字符
 *   4. 省略技能段，工具目录继续 2000 字符
 *   5. 工具目录上限 1000 字符
 *   6. 工具目录上限 500 字符 —— 最激进的工具目录压缩
 *
 * 如果两阶段都走完仍超预算，则对最终内容强制截断（hard_truncate）。
 * 这个设计避免了复杂的内存估算公式，用简单的穷举策略换取确定性。
 *
 * 【关键设计决策】
 * 1. 裁剪是有损的：每步都是不可逆的裁减，所以按"信息密度最低优先"排序。
 * 2. 裁减仅针对可选段，核心指令（如系统角色、安全策略）不会被裁剪。
 * 3. trimmed 数组记录了完整的降级路径，形成可审计的 token 预算消费记录。
 * 4. 使用函数依赖注入（estimate / assemble / truncate）而非直接调用，
 *    解耦裁剪逻辑与具体的估算和组装实现。
 */

 /**
 * System-prompt budget trimming.
 *
 * Keeps the step-wise degradation table out of `system-prompt.ts` so the
 * assembler stays focused on section content.
 */

import type {
  SystemPromptBuildResult,
  SystemPromptOptions,
  SystemPromptTrimEntry,
} from "./types.js";

/**
 * 裁剪函数的输入参数
 * 通过依赖注入解耦裁剪逻辑与具体实现（估算、组装、截断）
 */
export interface TrimSystemPromptInput {
  /** 原始的、未裁剪的系统提示词选项 */
  readonly opts: SystemPromptOptions;
  /** 系统提示词可用的 token 预算上限 */
  readonly systemBudget: number;
  /** 基于原始选项组装的初始内容（全文） */
  readonly initialContent: string;
  /** 初始内容的 token 估算数 */
  readonly initialTokens: number;
  /** token 估算函数：给定文本，返回 token 数 */
  readonly estimate: (text: string) => number;
  /** 组装函数：给定选项，返回组装后的系统提示词文本 */
  readonly assemble: (opts: SystemPromptOptions) => string;
  /** 强制截断函数：给定文本和 token 预算，返回截断后的文本 */
  readonly truncate: (content: string, budget: number) => string;
}

/**
 * 单个裁剪步骤的定义
 * 每个步骤通过 patch 修改 SystemPromptOptions 的若干字段
 */
interface TrimStep {
  /** 步骤标签，用于日志/审计（如 "memory_detail"、"tool_catalog_4000"） */
  readonly label: string;
  /** 覆盖原始选项的补丁，会与之前步骤的 patch 合并（spread 语义） */
  readonly patch: Partial<SystemPromptOptions>;
}

/**
 * 标准裁剪步骤：优先裁减记忆和项目上下文等"重但非核心"的内容段
 * 按信息密度最低优先的顺序排列——先裁内容最重、对当前任务关联最小的段
 */
const STANDARD_TRIM_STEPS: TrimStep[] = [
  /** 第1步：去掉 top-1 记忆的详情块（仅保留摘要），释放记忆详情的 token */
  { label: "memory_detail", patch: { includeMemoryDetail: false } },
  {
    /** 第2步：相关记忆缩减到最多 3 条 */
    label: "relevant_memories_3",
    patch: { includeMemoryDetail: false, maxRelevantMemories: 3 },
  },
  {
    /** 第3步：相关记忆缩减到最多 1 条 */
    label: "relevant_memories_1",
    patch: { includeMemoryDetail: false, maxRelevantMemories: 1 },
  },
  {
    /** 第4步：记忆索引文本截断至最多 100 行 */
    label: "memory_index_100",
    patch: {
      includeMemoryDetail: false,
      maxRelevantMemories: 1,
      maxMemoryIndexLines: 100,
    },
  },
  {
    /** 第5步：记忆索引文本截断至最多 50 行 */
    label: "memory_index_50",
    patch: {
      includeMemoryDetail: false,
      maxRelevantMemories: 1,
      maxMemoryIndexLines: 50,
    },
  },
  {
    /** 第6步：省略项目的本地局部记忆 */
    label: "project_memory_local",
    patch: {
      includeMemoryDetail: false,
      maxRelevantMemories: 1,
      maxMemoryIndexLines: 50,
      omitProjectMemoryLocal: true,
    },
  },
  {
    /** 第7步：省略 PAW.md 段（用户/项目自定义指令） */
    label: "paw_md",
    patch: {
      includeMemoryDetail: false,
      maxRelevantMemories: 1,
      maxMemoryIndexLines: 50,
      omitProjectMemoryLocal: true,
      omitPawMd: true,
    },
  },
];

/**
 * 紧急裁剪步骤：当标准步骤裁完内容段仍超预算时，开始压缩工具目录和技能描述
 * 这是最影响模型能力的裁减，因为工具目录决定了模型知道哪些工具可用
 */
const EMERGENCY_TRIM_STEPS: TrimStep[] = [
  /** 紧急第1步：工具目录上限 8000 字符 */
  { label: "tool_catalog_8000", patch: { toolCatalogMaxChars: 8000 } },
  /** 紧急第2步：工具目录上限 4000 字符 */
  { label: "tool_catalog_4000", patch: { toolCatalogMaxChars: 4000 } },
  /** 紧急第3步：工具目录上限 2000 字符 */
  { label: "tool_catalog_2000", patch: { toolCatalogMaxChars: 2000 } },
  /** 紧急第4步：工具目录保持 2000 字符，同时完全省略技能段 */
  { label: "omit_skills", patch: { toolCatalogMaxChars: 2000, omitSkills: true } },
  /** 紧急第5步：工具目录上限 1000 字符，同时省略技能段 */
  { label: "tool_catalog_1000", patch: { toolCatalogMaxChars: 1000, omitSkills: true } },
  /** 紧急第6步：工具目录上限 500 字符，同时省略技能段 —— 极限压缩 */
  { label: "tool_catalog_500", patch: { toolCatalogMaxChars: 500, omitSkills: true } },
];

/**
 * 对系统提示词执行阶梯式 token 预算裁剪
 *
 * 按顺序尝试 STANDARD_TRIM_STEPS 和 EMERGENCY_TRIM_STEPS 中的每个降级步骤。
 * 每一步都会：
 *   1. 将当前步骤的 patch 合并到累积的选项上（spread 语义，后覆盖前）
 *   2. 用合并后的选项重新组装系统提示词
 *   3. 估算组装结果的 token 数
 *   4. 如果 token 数 ≤ 预算，视为达标并返回结果
 *
 * 如果所有步骤都走完仍不达标，则对最终组装结果执行强制截断（hard_truncate）。
 *
 * 返回的 trimmed 数组记录了每一步触发的裁剪信息（段名 + 释放的 token 数），
 * 但不记录未触发的步骤——一旦某个步骤达标就立即返回。
 *
 * @param input - 裁剪输入参数，包含原始选项、预算、初始内容及依赖函数
 * @returns 最终的系统提示词构建结果，包含裁剪后的内容和裁剪追踪记录
 */
export function trimSystemPromptToBudget(
  input: TrimSystemPromptInput,
): SystemPromptBuildResult {
  const { opts, systemBudget, initialContent, initialTokens, estimate, assemble, truncate } =
    input;

  // 初始内容已在预算内，无需裁剪
  if (initialTokens <= systemBudget) {
    return { content: initialContent, trimmed: [] };
  }

  // 裁剪追踪记录
  const trimmed: SystemPromptTrimEntry[] = [];
  // 累积裁剪选项：从原始选项开始，每步通过 spread 合并 patch
  let lastMerged: SystemPromptOptions = opts;

  // 第一阶段：标准裁剪（裁减记忆、PAW.md 等内容段）
  for (const step of STANDARD_TRIM_STEPS) {
    lastMerged = { ...lastMerged, ...step.patch };
    const content = assemble(lastMerged);
    const tokens = estimate(content);
    if (tokens <= systemBudget) {
      trimmed.push({
        section: step.label,
        // 释放的 token 数 = 初始 token 数 - 裁剪后 token 数
        freedTokens: Math.max(0, initialTokens - tokens),
      });
      return { content, trimmed };
    }
  }

  // 第二阶段：紧急裁剪（压缩工具目录和技能段）
  for (const step of EMERGENCY_TRIM_STEPS) {
    lastMerged = { ...lastMerged, ...step.patch };
    const content = assemble(lastMerged);
    const tokens = estimate(content);
    if (tokens <= systemBudget) {
      trimmed.push({
        section: step.label,
        freedTokens: Math.max(0, initialTokens - tokens),
      });
      return { content, trimmed };
    }
  }

  // 兜底：所有步骤都走完后仍超预算，强制截断最终内容
  const hardContent = assemble(lastMerged);
  const truncated = truncate(hardContent, systemBudget);
  trimmed.push({
    section: "hard_truncate",
    freedTokens: Math.max(0, initialTokens - estimate(truncated)),
  });
  return { content: truncated, trimmed };
}
