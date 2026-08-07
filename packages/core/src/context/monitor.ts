/**
 * P5.1 侧信道触发：上下文压缩的主动化调度（SWE-MeM Workflow-only + Self-GC planner）。
 * ===================================================================================
 *
 * 不训练时主 agent 自触发不可靠（实测 2-4% 触发率）——触发判断由 harness 侧
 * 规则引擎承担（侧信道），不依赖模型自觉：
 * - subtask_end：最近回合出现完成证据 + 低信息密度 + 错误已解决
 * - low_density：最近 N 轮连续低密度、自包含
 * - critical_issue：具体错误证据 + 跨多轮未解
 *
 * 调度：monitor 每步 10% 概率采样 + 5 步冷却（防开销与过度压缩）；
 * 预算软启动（剩余 <20%）提高采样概率、<5% 必触发。
 */

import type { ChatMessage } from "./manager.js";
import { isToolResultMessage } from "../tool-result/format.js";

export type TriggerReason =
  | "subtask_end"
  | "low_density"
  | "critical_issue"
  | "budget_critical";

export interface MonitorDecision {
  readonly triggered: boolean;
  readonly reason?: TriggerReason;
}

export interface ContextMonitorOptions {
  /** 每轮采样概率（默认 0.10，SWE-MeM monitor） */
  readonly sampleProbability?: number;
  /** 触发后冷却轮数（默认 5） */
  readonly cooldownTurns?: number;
  /** 预算软启动：剩余预算低于此比例时提高采样概率 */
  readonly softBudgetRatio?: number;
  /** 剩余预算低于此比例时必触发（硬线） */
  readonly criticalBudgetRatio?: number;
}

export const DEFAULT_MONITOR_OPTIONS: Required<ContextMonitorOptions> = {
  sampleProbability: 0.1,
  cooldownTurns: 5,
  softBudgetRatio: 0.2,
  criticalBudgetRatio: 0.05,
};

/** 完成证据（复用生命周期段判定同源信号） */
const COMPLETION_EVIDENCE =
  /final_answer|final answer|all tests? (?:pass|passed)|测试(?:全部|都)?通过|✅ done|completed|sub-?agent.*(?:completed|done)/i;

/** 错误证据（跨轮未解检测） */
const ERROR_EVIDENCE =
  /error|fail(?:ed|ure)?|exception|traceback|exit code|✗|panic/i;

/** 低密度：单条消息 token 数低于此值视为低密度（chars/4 近似） */
const LOW_DENSITY_CHARS = 120;
/** low_density 判定所需的最低连续低密度轮数 */
const LOW_DENSITY_WINDOW = 3;
/** critical_issue：两次错误证据间的最小消息间隔（跨轮 = 未解决） */
const CRITICAL_ISSUE_GAP = 2;

/**
 * 规则引擎：给定最近窗口消息，判定是否该触发压缩。
 * 确定性启发式（零 LLM 调用）——侧信道不烧辅助模型。
 */
export function evaluateTrigger(
  messages: readonly ChatMessage[],
  opts?: { readonly window?: number },
): MonitorDecision {
  const window = opts?.window ?? 10;
  const recent = messages.slice(-window);
  if (recent.length < 4) return { triggered: false };

  // ── critical_issue：具体错误证据 + 跨多轮未解 ──
  const errorIdx: number[] = [];
  for (let i = 0; i < recent.length; i++) {
    const content = recent[i]?.content ?? "";
    if (!isToolResultMessage(content) && !ERROR_EVIDENCE.test(content)) {
      continue;
    }
    if (isToolResultMessage(content)) {
      const parsed = content.slice(0, 400);
      if (ERROR_EVIDENCE.test(parsed)) errorIdx.push(i);
    }
  }
  // 错误出现 ≥2 次且间隔 ≥2 条消息（跨轮未解）
  for (let i = 1; i < errorIdx.length; i++) {
    if (errorIdx[i]! - errorIdx[i - 1]! >= CRITICAL_ISSUE_GAP) {
      return { triggered: true, reason: "critical_issue" };
    }
  }

  // ── low_density：最近 N 轮连续低密度、自包含 ──
  // （工具结果消息不算——短工具结果不代表对话低密度）
  let lowCount = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    if (m.role !== "user" || isToolResultMessage(m.content)) continue;
    if (m.content.length <= LOW_DENSITY_CHARS) lowCount++;
    else break;
    if (lowCount >= LOW_DENSITY_WINDOW) {
      return { triggered: true, reason: "low_density" };
    }
  }

  // ── subtask_end：完成证据 + 低信息密度 + 错误已解决 ──
  const lastTwo = recent.slice(-2).map((m) => m.content ?? "").join("\n");
  if (COMPLETION_EVIDENCE.test(lastTwo)) {
    // 错误已解决：工具结果错误要么从未出现，要么出现在完成信号之前。
    // 只统计工具结果中的错误——普通文本提到 "error"（文档/代码）不是未解问题。
    let lastError = -1;
    let lastCompletion = -1;
    for (let i = 0; i < recent.length; i++) {
      const c = recent[i]?.content ?? "";
      if (isToolResultMessage(c) && ERROR_EVIDENCE.test(c.slice(0, 400))) {
        lastError = i;
      }
      if (COMPLETION_EVIDENCE.test(c)) lastCompletion = i;
    }
    const resolved = lastError < lastCompletion || lastError === -1;
    if (resolved) {
      return { triggered: true, reason: "subtask_end" };
    }
  }

  return { triggered: false };
}

/**
 * 侧信道调度器：采样 + 冷却 + 预算软启动。
 */
export class ContextMonitor {
  private readonly opts: Required<ContextMonitorOptions>;
  private cooldownLeft = 0;
  private _samples = 0;
  private _triggers = 0;
  private lastTurn = -1;

  constructor(opts?: ContextMonitorOptions) {
    this.opts = { ...DEFAULT_MONITOR_OPTIONS, ...opts };
  }

  /** 采样统计（行为层指标：采样数/触发数） */
  get stats(): { readonly samples: number; readonly triggers: number } {
    return { samples: this._samples, triggers: this._triggers };
  }

  /**
   * 每轮调用：决定是否执行一次侧信道评估。
   * - 冷却期/同轮重复 → false
   * - 剩余预算 <5% → 必触发（硬线，替代硬阈值）
   * - 剩余预算 <20% → 采样概率提高 3 倍（软启动，VISTA ρ=0.8 的调度侧）
   * - 否则 10% 采样
   */
  shouldEvaluate(turn: number, remainingBudgetRatio: number): boolean {
    if (this.cooldownLeft > 0) {
      this.cooldownLeft--;
      return false;
    }
    if (turn === this.lastTurn) return false;
    this.lastTurn = turn;

    if (remainingBudgetRatio < this.opts.criticalBudgetRatio) {
      return true;
    }
    const p =
      remainingBudgetRatio < this.opts.softBudgetRatio
        ? Math.min(1, this.opts.sampleProbability * 3)
        : this.opts.sampleProbability;
    return Math.random() < p;
  }

  /** 记录一次评估（触发后进入冷却；未触发也采样计数） */
  noteEvaluated(triggered: boolean): void {
    this._samples++;
    if (triggered) {
      this._triggers++;
      this.cooldownLeft = this.opts.cooldownTurns;
    }
  }
}
