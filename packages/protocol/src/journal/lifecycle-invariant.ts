/**
 * 生命周期不变量的稳定 code 与抛错类型。
 * ==========================================
 *
 * 背景（docs/CODE-REVIEW.md §R2）：`validate-lifecycle.ts` 用散文式字符串就地抛错，
 * 于是**同一条规则在两处被检测到时抛出完全相同的文案**，日志与测试都无法区分
 * 是哪一处失败的。这个模块给每条规则一个稳定 id，并把"现场"单独记下来。
 *
 * 设计上的一个判断：**同一条规则在多个检测点触发时，code 相同、`detectedAt` 不同。**
 * 以 `terminalPromotionNeedsSegmentMarker` 为例 —— promotion 先到时就地拒绝
 * （`input.promoted`），工作段后到时拒绝该工作段（`work.segment_started`），
 * 因为工作段本应出现在 promotion 之前。两者是**一个不变量**的两面，所以消息
 * 保持一致是对的；需要被区分的是**现场**，不是规则。
 */

/**
 * 不变量 code 登记表。每条规则一个稳定 id，命名空间即事实类型。
 *
 * code 一旦发布就不应改动 —— 它是日志检索与回归测试的锚点，而散文消息不是。
 */
export const LIFECYCLE_INVARIANT_CODES_V1 = {
  /** work segment 的序号必须从 1 起连续。 */
  segmentIndexContiguous: "work_segment.index_contiguous",
  /** work segment 必须紧跟在一条派生决策之后。 */
  segmentFollowsDecision: "work_segment.follows_decision",
  /** 前置决策必须是完成 / 等待用户 / 崩溃恢复未完成之一。 */
  segmentTerminalDecisionEligible: "work_segment.terminal_decision_eligible",
  /** work segment 的 reducerVersion 必须等于前置决策的 reducerVersion。 */
  segmentReducerVersionMatchesDecision: "work_segment.reducer_version_matches_decision",
  /** work segment 记录的 previousDecisionStateHash 必须等于前置决策的 stateHash。 */
  segmentPreviousStateHashMatches: "work_segment.previous_state_hash_matches",
  /** work segment 记录的 previousAction 必须等于前置决策的 action。 */
  segmentPreviousActionMatches: "work_segment.previous_action_matches",
  /**
   * 终局决策边界打开期间，promotion 不得先于它的工作段标记。
   *
   * 一个不变量，两个检测点 —— 见文件头说明。靠 `detectedAt` 区分现场。
   */
  terminalPromotionNeedsSegmentMarker: "work_segment.terminal_promotion_needs_marker",
  /** work segment 引用的输入必须有持久化准入记录。 */
  segmentInputDurablyAdmitted: "work_segment.input_durably_admitted",
  /** work segment 引用的输入不能已经被提升过。 */
  segmentInputNotAlreadyPromoted: "work_segment.input_already_promoted",
  /** work segment 必须紧邻它自己的 promotion。 */
  segmentPrecedesPromotion: "work_segment.precedes_promotion",
  /** work segment 不能跨越未结算的模型调用。 */
  segmentNoUnsettledModel: "work_segment.unsettled_model",
  /** work segment 不能跨越未结算的工具生命周期。 */
  segmentNoUnsettledTool: "work_segment.unsettled_tool",
  /** work segment 不能跨越待处理的 checkpoint 蒸馏。 */
  segmentNoPendingCheckpointDistillation: "work_segment.pending_checkpoint_distillation",
} as const;

export type LifecycleInvariantCodeV1 =
  (typeof LIFECYCLE_INVARIANT_CODES_V1)[keyof typeof LIFECYCLE_INVARIANT_CODES_V1];

/** 不变量在哪些事实分支上被检测到。 */
export type LifecycleInvariantSiteV1 = "input.promoted" | "work.segment_started";

/**
 * 不变量被违反。
 *
 * 继承 `Error` 并带上 `code`（规则身份）与 `detectedAt`（现场）。
 * `message` 与改动前逐字相同 —— 调用方可能已经在比对文案，而 code 是新增的
 * 区分手段，不替代它。
 */
export class LifecycleInvariantErrorV1 extends Error {
  readonly code: LifecycleInvariantCodeV1;
  readonly detectedAt: LifecycleInvariantSiteV1 | undefined;

  constructor(
    code: LifecycleInvariantCodeV1,
    message: string,
    detectedAt?: LifecycleInvariantSiteV1,
  ) {
    super(message);
    this.name = "LifecycleInvariantErrorV1";
    this.code = code;
    this.detectedAt = detectedAt;
  }
}

/** 构造一个不变量违规错误（`throw lifecycleInvariant(...)` 读起来即"这里必须成立"）。 */
export function lifecycleInvariant(
  code: LifecycleInvariantCodeV1,
  message: string,
  detectedAt?: LifecycleInvariantSiteV1,
): LifecycleInvariantErrorV1 {
  return new LifecycleInvariantErrorV1(code, message, detectedAt);
}
