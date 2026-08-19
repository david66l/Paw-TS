import type { SemanticReviewOnceResultV2 } from "./candidate-certification.js";

export type LoopV2SemanticReviewGateDecisionV1 =
  | Readonly<{ readonly type: "accept"; readonly key: string }>
  | Readonly<{
      readonly type: "feedback";
      readonly key: string;
      readonly message: string;
    }>
  | Readonly<{
      readonly type: "incomplete";
      readonly key: string;
      readonly message: string;
      readonly reason: "no_turn_budget";
    }>;

/**
 * 统一不变量（与验证探针门共用，2026-08-17 起生效）：候选绑定的对抗性
 * 发现只被"候选身份变化"这一事实解除。评审结果按 candidateInputHash
 * at-most-once 持久化（claim/artifact 机制），相同候选的重交会重放同一
 * 份失败评审——它不构成新事件，直接回弹，不消耗任何名额；只有真实的
 * 候选变化才会触发新评审。唯一的诚实退出边界是运行预算（no turn
 * budget），没有任何计数阈值。
 */
export function evaluateLoopV2SemanticReviewGateV1(input: {
  readonly result: SemanticReviewOnceResultV2;
  readonly noRoomForAnotherTurn: boolean;
}): LoopV2SemanticReviewGateDecisionV1 {
  const { result } = input;
  if (result.review.verdict === "pass") {
    return { type: "accept", key: result.reviewKey };
  }
  const message = semanticReviewFeedbackMessage(result);
  if (!input.noRoomForAnotherTurn) {
    return { type: "feedback", key: result.reviewKey, message };
  }
  return {
    type: "incomplete",
    key: result.reviewKey,
    message,
    reason: "no_turn_budget",
  };
}

function semanticReviewFeedbackMessage(
  result: SemanticReviewOnceResultV2,
): string {
  if (result.reasonCode === "review_subject_changed") {
    return [
      `[LoopV2SemanticReview:checkpoint_stale key=${result.reviewKey}]`,
      "The code revision did not change, but the non-verification review contract changed after its host checkpoint.",
      "The previous verdict was not reused and the reviewer was not called again. Reconcile the changed criteria, risk, or source facts; make a source edit only when that reconciliation identifies a genuine code defect.",
    ].join("\n");
  }
  const verdict = result.review.verdict;
  const findings = result.review.findings.slice(0, 8).map((finding, index) => {
    const binding = finding.criterionId
      ? `criterion=${finding.criterionId}`
      : finding.invariantId
        ? `invariant=${finding.invariantId}`
        : "unbound-warning";
    const location = finding.file
      ? ` file=${finding.file}${finding.line ? `:${finding.line}` : ""}`
      : "";
    return `${index + 1}. ${finding.severity} ${binding}${location}: ${bound(finding.observedChange, 500)} Risk: ${bound(finding.risk, 500)}${finding.minimalAlternative ? ` Minimal alternative: ${bound(finding.minimalAlternative, 500)}` : ""}`;
  });
  return [
    `[LoopV2SemanticReview:${verdict} key=${result.reviewKey}]`,
    `Independent semantic review returned ${verdict} for the persisted candidate.`,
    ...findings,
    verdict === "fail"
      ? "Fix the bound issue, produce a real source mutation, re-run relevant verification, and then submit a new candidate. Resubmitting identical code is pointless: this review is bound to the exact candidate, and an identical resubmission replays the same verdict. Only a real code change produces a new candidate and a fresh review."
      : "Semantic review did not produce a certifying verdict. Do not resubmit the unchanged candidate; make a fact-changing correction or report an honest blocker.",
  ].join("\n");
}

function bound(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxChars
    ? compact
    : `${compact.slice(0, maxChars - 1)}…`;
}
