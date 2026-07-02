/**
 * Scorer Types — 评分相关的类型定义
 * ===================================
 *
 * 【是什么】
 * 定义评分系统的核心输出类型：规则检查结果（RuleResult）、维度得分
 * （DimensionScore）、单次运行报告（ScoreReport）和聚合报告
 * （AggregateScoreReport）。
 *
 * 【为什么】
 * 评分逻辑（RuleScorer、LlmScorer、Aggregator）和报告渲染（Reporter）
 * 需要共享一致的数据结构。集中定义这些类型避免：
 * - 不同模块间隐式的数据结构契约
 * - 评分器输出和报告器输入不一致
 * - 类型分散导致的维护困难
 *
 * 【关键设计决策】
 * 1. **全部 readonly**：评分结果一旦生成不应被修改，确保报告的可靠性。
 * 2. **0-100 统一尺度**：所有分数（ruleScore、llmScore、overallScore、
 *    dimension.score、stabilityScore）都在 0-100 范围内，便于直接比较和加权计算。
 * 3. **stabilityScore 的语义**：变异系数（CV = sigma/mu）的补数 * 100，
 *    即 CV 越小 → stabilityScore 越接近 100 → 表示输出越稳定。
 *    minScore/maxScore 提供直观的波动范围。
 * 4. **perRepetition 保留**：聚合报告中保存每次重复的完整 ScoreReport，
 *    支持细粒度的回归分析和调试。
 */

import type { EvalDimension } from "../test-suite/types.js";

// ── 规则检查结果 ──

/** 单条规则的检查结果 */
export interface RuleResult {
  /** 规则类型（如 tool_called、output_contains 等） */
  readonly ruleType: string;
  /** 规则参数 */
  readonly params: unknown;
  /** 规则描述（可选，供报告展示） */
  readonly description?: string;
  /** 是否通过 */
  readonly passed: boolean;
  /** 详细信息（通过/失败的具体原因） */
  readonly detail?: string;
}

// ── 维度评分 ──

/** LLM 评判的单个维度得分 */
export interface DimensionScore {
  /** 评分维度 */
  readonly dimension: EvalDimension;
  /** 得分，0-100 */
  readonly score: number;
  /** 裁判模型的评分理由（可选） */
  readonly reason?: string;
}

// ── 单次运行评分报告 ──

/** 单次运行的完整评分报告 */
export interface ScoreReport {
  /** 测试用例 ID */
  readonly testCaseId: string;
  /** 第几次重复 */
  readonly repetitionIndex: number;
  /** 加权总分 0-100 */
  readonly overallScore: number;
  /** 规则评分子分 0-100 */
  readonly ruleScore?: number;
  /** LLM 评分子分 0-100 */
  readonly llmScore?: number;
  /** 每条规则的检查结果 */
  readonly ruleResults: RuleResult[];
  /** LLM 评判的各维度得分（若可用） */
  readonly dimensionScores?: DimensionScore[];
  /** 是否达到通过阈值 */
  readonly passed: boolean;
  /** 人类可读的摘要 */
  readonly summary: string;
}

// ── 多次重复聚合报告 ──

/** 同一用例多次重复运行的聚合统计报告 */
export interface AggregateScoreReport {
  /** 测试用例 ID */
  readonly testCaseId: string;
  /** 实际重复次数 */
  readonly repetitionCount: number;
  /** 多次重复的均值分数 0-100 */
  readonly overallScore: number;
  /** 稳定性分数（基于变异系数），0 = 极度不稳定，100 = 完全一致 */
  readonly stabilityScore: number;
  /** 最低分数 */
  readonly minScore: number;
  /** 最高分数 */
  readonly maxScore: number;
  /** 每次重复的完整报告（用于细粒度调试） */
  readonly perRepetition: ScoreReport[];
  /** 基于均值的通过判定 */
  readonly passed: boolean;
  /** 聚合摘要文字 */
  readonly summary: string;
}
