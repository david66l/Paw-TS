/**
 * 记忆检索的任务档案与每档案的 token 预算配置
 * Memory retrieval task profiles and per-profile token budgets.
 *
 * ============================================================================
 * 模块职责 (Module Purpose)
 * ============================================================================
 * 本模块定义了不同任务类型（重构/架构、Bug修复、简单脚本、通用）的 token 预算
 * 和检索限制。在记忆检索阶段（B.4 流程），系统首先对用户任务进行分类
 * （TaskProfile），然后根据分类结果分配不同的 token 配额、记录条数上限、
 * 以及标签偏好权重。这样做的好处是：
 *
 *   1. **按需分配**：重构类任务需要更多上下文（2000 tokens），简单脚本只需
 *      少量记忆（500 tokens），避免浪费 token 预算。
 *   2. **标签加权**：Bug修复任务会提升 "bug"/"error" 标签的检索权重，让相关
 *      记忆更容易被召回。
 *   3. **会话记忆配额**：限制会话记忆中进入 top-K 的条数，防止近期会话记忆
 *      挤占长期参考记忆的空间。
 *
 * 架构定位：这是记忆系统的"预算分配层"，由 memory-query.ts 中的任务分类器
 * 驱动，被 memory-retriever 消费。
 * ============================================================================
 */

import type { TaskProfile } from "./memory-query.js";

/**
 * 每个任务档案的 token 预算与检索限制（参见 B.4 流程）。
 * Per-profile token budget and retrieval limits (B.4).
 *
 * 各字段含义：
 * - maxTokens: 记忆检索阶段可使用的总 token 上限
 * - maxSessionTokens: 会话记忆（session memory）可占用的最大 token 数
 * - recordLimit: 最多返回多少条记忆记录
 * - maxSessionInTopK: 最终 top-K 中最多允许几条会话记忆
 * - preferredTags: 该任务类型偏好的标签，用于加权检索
 * - tagBoost: 偏好标签的加权系数（> 1.0 表示提升权重）
 */
export interface ProfileBudget {
  readonly maxTokens: number;
  readonly maxSessionTokens: number;
  readonly recordLimit: number;
  readonly maxSessionInTopK: number;
  /** 在该档案下对特定记忆类型应用的加权系数。Boost factor for certain memory types in this profile. */
  readonly preferredTags: readonly string[];
  readonly tagBoost: number;
}

/**
 * 任务档案 → 预算配置的映射表。
 * 每种任务类型有独立的 token 预算和检索参数。
 */
export const TASK_PROFILE_BUDGETS: Record<TaskProfile, ProfileBudget> = {
  /**
   * 重构/架构类任务：需要最广泛的上下文（2000 tokens），
   * 偏好 "reference" 和 "project" 标签，因为这类任务需要回顾项目结构和设计文档。
   */
  refactor_arch: {
    maxTokens: 2000,
    maxSessionTokens: 1000,
    recordLimit: 8,
    maxSessionInTopK: 3,
    preferredTags: ["reference", "project"],
    tagBoost: 1.15,
  },
  /**
   * Bug修复任务：会话记忆配额较高（1200 tokens），因为错误上下文很重要；
   * 偏好 "bug" 和 "error" 标签，加权系数 1.2 让相关记忆更突出。
   */
  bug_fix: {
    maxTokens: 1800,
    maxSessionTokens: 1200,
    recordLimit: 6,
    maxSessionInTopK: 3,
    preferredTags: ["bug", "error"],
    tagBoost: 1.2,
  },
  /**
   * 简单脚本任务：最小化的记忆检索（500 tokens），只返回 2 条记录，
   * 无特殊标签偏好——够用即可，不浪费 token。
   */
  simple_script: {
    maxTokens: 500,
    maxSessionTokens: 200,
    recordLimit: 2,
    maxSessionInTopK: 1,
    preferredTags: [],
    tagBoost: 1.0,
  },
  /**
   * 通用任务：中等预算（1500 tokens），平衡覆盖各类记忆，
   * 无标签偏好。
   */
  general: {
    maxTokens: 1500,
    maxSessionTokens: 800,
    recordLimit: 5,
    maxSessionInTopK: 2,
    preferredTags: [],
    tagBoost: 1.0,
  },
};
