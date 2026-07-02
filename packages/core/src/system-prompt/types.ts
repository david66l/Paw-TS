/**
 * 系统提示词（System Prompt）的类型定义模块
 * ============================================
 *
 * 【模块目的】
 * 定义构建系统提示词所需的配置选项和构建结果的类型，是整个 system-prompt 子系统的"合同层"。
 *
 * 【架构定位】
 * 在 Paw.ts 的请求管线中，系统提示词是第一条被注入到上下文窗口的消息。
 * 它由多个可选段组成（PAW.md、git status、工具目录、记忆片段等），
 * 每段都可能极大影响 token 消耗。本模块的选项接口统一控制：
 * - 哪些段参与构建（omitXxx / hasXxx）
 * - 每个段的内容上限（xxxMaxChars / maxXxxLines）
 * - 记忆模块的查询和注入策略（maxRelevantMemories 等）
 *
 * 【关键设计决策】
 * 1. 所有字段用 `readonly` —— 选项对象在一次运行中不可变，避免跨阶段意外修改。
 * 2. 记忆相关的字段集中在一处（projectMemory、relevantMemories、memoryIndex 等），
 *    因为记忆是系统提示词中最复杂、最动态的段。
 * 3. SystemPromptBuildResult 携带 trimmed 数组，记录每一步裁剪了哪些段、释放了多少 token。
 *    这让上层（UI/日志）可以展示 token 预算消耗的完整 audit trail。
 */

import type { MemoryRecord } from "@paw/memory";
import type { ProjectMemory } from "@paw/memory";

/**
 * 构建系统提示词的配置选项
 *
 * 每个字段控制系统提示词中一个可选段的参与与否或上限。
 * 所有字段均为 `readonly`，确保一次构建过程中的配置稳定。
 */
export interface SystemPromptOptions {
  /** 工作区根目录的绝对路径，用于路径相关的上下文化（如 git status 中的相对路径） */
  readonly workspaceRoot: string;
  /** 工具目录文本：列出所有可用工具的名称、描述、参数签名 */
  readonly toolCatalog: string;
  /** 可用技能（skills）的描述文本，可选 */
  readonly skills?: string;
  /** git status 输出文本，帮助模型理解当前工作区状态，可选 */
  readonly gitStatus?: string;
  /** PAW.md（用户/项目指令）的内容，可选 */
  readonly pawMd?: string;
  /** 项目记忆（分层的本地记忆数据），可选 */
  readonly projectMemory?: ProjectMemory;
  /** 当前上下文最相关的记忆记录列表，可选 */
  readonly relevantMemories?: readonly MemoryRecord[];
  /** TODO 列表文本，可选 */
  readonly todos?: string;
  /** 当前会话使用的语言，可选 */
  readonly language?: string;
  /** 模型显示名称（如 "Claude Sonnet 4"），用于提示词中的模型自我介绍 */
  readonly modelLabel: string;
  /** 模型内部 ID（如 "claude-sonnet-4-20250514"） */
  readonly modelId: string;
  /** 记忆文件存储目录的绝对路径 */
  readonly memoryDir: string;
  /** 是否启用了自动记忆功能 */
  readonly hasAutoMemory: boolean;
  /** 记忆索引的序列化文本（摘要列表），可选 */
  readonly memoryIndex?: string;
  /** 是否注入最相关记忆的详情块。设为 false 可跳过 top-1 记忆的 Detail 块，节省 token */
  readonly includeMemoryDetail?: boolean;
  /** 最多注入的相关记忆条数 */
  readonly maxRelevantMemories?: number;
  /** 记忆索引文本的最大行数，超过则截断 */
  readonly maxMemoryIndexLines?: number;
  /** 是否完全省略 PAW.md 段 */
  readonly omitPawMd?: boolean;
  /** 是否省略项目记忆中的本地局部记忆 */
  readonly omitProjectMemoryLocal?: boolean;
  /** 工具目录文本的最大字符数，超过则截断 */
  readonly toolCatalogMaxChars?: number;
  /** 技能描述文本的最大字符数，超过则截断 */
  readonly skillsMaxChars?: number;
  /** 是否完全省略技能段 */
  readonly omitSkills?: boolean;
}

/**
 * 单次裁剪操作的记录
 *
 * 裁剪体系采用阶梯式降级：每步移除或缩减一个段，
 * 然后重新估算 token 数，直到预算达标。
 * 每条记录对应一个降级步骤。
 */
export interface SystemPromptTrimEntry {
  /** 被裁剪的段名（如 "paw_md"、"tool_catalog_4000"） */
  readonly section: string;
  /** 该步裁剪释放的 token 数 */
  readonly freedTokens: number;
}

/**
 * 系统提示词构建的完整结果
 *
 * 包含最终文本内容和裁剪追踪信息。
 * 上层可以根据 trimmed 数组渲染 token 预算的消耗路径。
 */
export interface SystemPromptBuildResult {
  /** 最终构建（或裁剪后）的系统提示词文本 */
  readonly content: string;
  /** 裁剪步骤的完整记录，未裁剪时为空数组 */
  readonly trimmed: readonly SystemPromptTrimEntry[];
}
