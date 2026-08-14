import type { SemanticReviewOnceResultV2 } from "./candidate-certification.js";

export const LOOP_V2_SEMANTIC_REVIEW_FEEDBACK_LIMIT = 1 as const;

export interface LoopV2SemanticReviewFeedbackStateV1 {
  readonly key: string;
  readonly nudges: number;
}

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
      readonly reason: "feedback_exhausted" | "no_turn_budget";
    }>;

export function evaluateLoopV2SemanticReviewGateV1(input: {
  readonly result: SemanticReviewOnceResultV2;
  readonly priorKey?: string;
  readonly priorNudges?: number;
  readonly noRoomForAnotherTurn: boolean;
}): LoopV2SemanticReviewGateDecisionV1 {
  const { result } = input;
  if (result.review.verdict === "pass") {
    return { type: "accept", key: result.reviewKey };
  }
  const message = semanticReviewFeedbackMessage(result);
  const priorNudges =
    input.priorKey === result.reviewKey ? (input.priorNudges ?? 0) : 0;
  if (
    priorNudges < LOOP_V2_SEMANTIC_REVIEW_FEEDBACK_LIMIT &&
    !input.noRoomForAnotherTurn
  ) {
    return { type: "feedback", key: result.reviewKey, message };
  }
  return {
    type: "incomplete",
    key: result.reviewKey,
    message,
    reason: input.noRoomForAnotherTurn
      ? "no_turn_budget"
      : "feedback_exhausted",
  };
}

export function parseLoopV2SemanticReviewFeedbackMarker(
  content: string,
): LoopV2SemanticReviewFeedbackStateV1 | undefined {
  const match =
    /\[LoopV2SemanticReview:(?:fail|partial) key=([^\]\s]+) nudges=(\d+)\]/.exec(
      content,
    );
  if (!match?.[1] || !match[2]) return undefined;
  const nudges = Number(match[2]);
  if (!Number.isSafeInteger(nudges) || nudges < 0) return undefined;
  return { key: match[1], nudges };
}

function semanticReviewFeedbackMessage(
  result: SemanticReviewOnceResultV2,
): string {
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
    `[LoopV2SemanticReview:${verdict} key=${result.reviewKey} nudges=1]`,
    `Independent semantic review returned ${verdict} for the persisted candidate.`,
    ...findings,
    verdict === "fail"
      ? "Fix the bound issue, produce a real source mutation, re-run relevant verification, and then submit a new candidate. The same candidate will not be reviewed again."
      : "Semantic review did not produce a certifying verdict. Do not resubmit the unchanged candidate; make a fact-changing correction or report an honest blocker.",
  ].join("\n");
}

function bound(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxChars
    ? compact
    : `${compact.slice(0, maxChars - 1)}…`;
}
