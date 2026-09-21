import type { InteractiveControlConfigV2, SessionInputSnapshot } from "@paw/agent-loop";
import { projectPendingCompletionReviewFeedbackV1 } from "@paw/completion-review";
import {
  projectProgressAdviceTimelineV1,
  projectProgressAdviceV1,
  renderProgressAdviceMessageV1,
} from "@paw/progress-advisor";
import type { InputFactV1 } from "@paw/protocol";
import { type JournalContextAnnotationV1, projectLatestWorkSegmentBoundaryV1 } from "@paw/runtime";
import { projectExecutionBudgetV1 } from "./execution-budget.js";

/** Pure, request-only projections. No delivery receipts or process-local state. */
export function projectPawNextRequestGuidanceV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  budget: InteractiveControlConfigV2,
): readonly JournalContextAnnotationV1[] {
  const timeline = projectProgressAdviceTimelineV1(snapshot, budget);
  const annotations: JournalContextAnnotationV1[] = timeline.map((advice) => ({
    sourceThroughSeq: advice.sourceThroughSeq,
    content: renderProgressAdviceMessageV1(advice).content,
    placement: "after_unit",
  }));
  // Only a condition that still holds can survive omission of its historical
  // anchor. Its fallback is rebuilt from current facts, never from a stale hint.
  for (const lane of ["ordinary", "closeout"] as const) {
    const current = projectProgressAdviceV1(snapshot, budget, lane);
    if (!current) continue;
    const fallbackContent = renderProgressAdviceMessageV1(current).content;
    const anchor = timeline
      .map((advice, index) => ({ advice, index }))
      .reverse()
      .find(({ advice }) => advice.kind === current.kind);
    const item = anchor && annotations[anchor.index];
    if (anchor && item) {
      annotations[anchor.index] = { ...item, fallbackContent };
    } else {
      annotations.push({
        sourceThroughSeq: current.sourceThroughSeq,
        content: fallbackContent,
        fallbackContent,
        placement: "after_unit",
      });
    }
  }
  const boundary = projectLatestWorkSegmentBoundaryV1(snapshot);
  const markerSeq = boundary?.markerSeq ?? 0;
  if (
    boundary &&
    !snapshot.entries.some(
      ({ seq, fact }) =>
        seq > markerSeq &&
        (fact.type === "completion.review_settled" ||
          (fact.type === "input.promoted" && fact.delivery === "steer")),
    )
  ) {
    const before = snapshot.entries
      .filter((entry) => entry.seq < markerSeq)
      .map((entry) => entry.fact);
    const pending = projectPendingCompletionReviewFeedbackV1(before);
    const review =
      pending &&
      [...before]
        .reverse()
        .find(
          (fact) => fact.type === "completion.review_settled" && fact.reviewId === pending.reviewId,
        );
    if (
      pending?.inputId === boundary.inputId &&
      review?.type === "completion.review_settled" &&
      ["failed", "unknown"].includes(review.status) &&
      ["AuditReportInvalid", "AuditEvidencePathInvalid"].includes(review.reasonCode)
    ) {
      annotations.push({
        sourceThroughSeq: markerSeq,
        placement: "tail",
        content:
          "[Paw audit report retry] The preceding audit report failed format or file-reference validation. Preserve the implementation and valid verification evidence. This status alone establishes no code or test defect. Give a concise, evidence-grounded final response to request another independent review; investigate or change code only when separate evidence identifies a defect. Acceptance remains unverified until the review succeeds.",
      });
    }
  }
  const interrupted =
    budget.recoverReasoningTimeout &&
    [...snapshot.entries]
      .reverse()
      .find(
        ({ seq, fact }) =>
          seq > markerSeq &&
          fact.type === "model.settled" &&
          fact.status === "unknown" &&
          fact.errorCode === "ModelReasoningWithoutActionTimeout" &&
          !fact.hasToolCalls &&
          !fact.hasVisibleOutput,
      );
  if (interrupted) {
    const content = `[Paw execution recovery; sourceSeq=${interrupted.seq}] The host interrupted a generation that produced only thinking. No tools from that request executed, and its usage is unknown. Continue the original task from confirmed tool results. Choose one small, coherent implementation or verification step and issue the corresponding tool call before designing the remaining work. Read missing evidence if needed; do not redo completed work. Keep subsequent steps incremental until the entire task is implemented and verified. This guidance grants no permissions and changes no user requirements. This run permits only one automatic recovery; another thinking-only timeout stops execution.`;
    annotations.push({
      sourceThroughSeq: interrupted.seq,
      content,
      fallbackContent: content,
      placement: "tail",
    });
  }
  const executionBudget = projectExecutionBudgetV1(snapshot);
  if (executionBudget) annotations.push(executionBudget);
  return Object.freeze(annotations.map((item) => Object.freeze(item)));
}
