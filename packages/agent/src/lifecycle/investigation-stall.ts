import { DEFAULT_PROGRESS_ADVISOR_CONFIG_V2 } from "../loop-v2/progress-advisor.js";
import type { TaskState } from "../task-state.js";

/**
 * Loop v2.1 §8.3 停滞阶梯的生产接线（此前 progress-advisor 只存在于纯函数
 * 与测试，真实循环从未注入——matplotlib-21568 的 139 回合调查瘫痪期间
 * 模型没有收到任何停滞建议）。
 *
 * 事实驱动：有意义进展 = TaskState 产品级事实发生变化（mutation
 * revision、改动文件集、最新验证结果 revision）。只有这些都没变、而回合
 * 在走，才构成"调查无进展"的事实。阈值复用版本化的
 * DEFAULT_PROGRESS_ADVISOR_CONFIG_V2（§8.3：阈值必须是版本化配置）。
 *
 * 本模块只产建议文本（advice-only），不拒绝任何工具调用。
 */

export interface ProgressBaselineV1 {
  readonly turn: number;
  readonly mutationRevision: number;
  readonly filesChanged: number;
  /** 最近一次验证结果绑定的 shell 命令 revision；0 表示尚无验证。 */
  readonly lastVerificationRevision: number;
  readonly filesRead: number;
  readonly shellCommandRevision: number;
}

export function computeProgressBaselineV1(
  state: TaskState,
  turn: number,
): ProgressBaselineV1 {
  return {
    turn,
    mutationRevision: state.mutationRevision ?? 0,
    filesChanged: state.filesChanged.length,
    lastVerificationRevision:
      state.testResults.at(-1)?.shellCommandRevision ?? 0,
    filesRead: state.filesRead.length,
    shellCommandRevision: state.shellCommandRevision ?? 0,
  };
}

function hasMeaningfulDelta(
  baseline: ProgressBaselineV1,
  current: ProgressBaselineV1,
): boolean {
  return (
    baseline.mutationRevision !== current.mutationRevision ||
    baseline.filesChanged !== current.filesChanged ||
    baseline.lastVerificationRevision !== current.lastVerificationRevision
  );
}

export interface InvestigationStallResultV1 {
  /** 更新后的基线（有意义进展时重置到当前回合）。 */
  readonly baseline: ProgressBaselineV1;
  /** 本次应注入的建议；undefined 表示无需注入。 */
  readonly message?: string;
}

export function evaluateInvestigationStallV1(input: {
  readonly state: TaskState;
  readonly baseline: ProgressBaselineV1;
  readonly turn: number;
  readonly canDelegate?: boolean;
}): InvestigationStallResultV1 {
  const current = computeProgressBaselineV1(input.state, input.turn);
  if (hasMeaningfulDelta(input.baseline, current)) {
    return { baseline: current };
  }
  const gap = input.turn - input.baseline.turn;
  const thresholds = DEFAULT_PROGRESS_ADVISOR_CONFIG_V2.noDeltaThresholds;
  const investigationFacts = `last ${gap} turns: +${current.filesRead - input.baseline.filesRead} files read, +${current.shellCommandRevision - input.baseline.shellCommandRevision} shell commands, 0 product mutations / new verification results`;
  const parallelFact = input.canDelegate
    ? "Parallel read-only investigators can be dispatched via workspace.run_agent (e.g. agent_id bige): each returns a focused summary."
    : "Compare independent hypotheses and choose the next action with the highest information gain.";
  let message: string | undefined;
  if (gap === thresholds.safetyWarning) {
    message = `[ProgressAdvice:safety_line] ${investigationFacts}. The no-progress safety line has been reached. Preserve the decision state and prepare an honest incomplete/stalled handoff unless new evidence arrives. ${parallelFact}`;
  } else if (gap === thresholds.changeHypothesis) {
    message = `[ProgressAdvice:hypothesis_stale] ${investigationFacts}. Change or reject the current hypothesis and take a materially different falsifying action. ${parallelFact}`;
  } else if (gap === thresholds.inspectGap) {
    message = `[ProgressAdvice:inspect_gap] ${investigationFacts}. State the current hypothesis and the missing evidence, then take one materially different falsifying action. ${parallelFact}`;
  }
  return { baseline: input.baseline, ...(message ? { message } : {}) };
}
