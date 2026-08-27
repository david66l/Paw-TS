import type { CompletionReviewSettledFactV1, InputFactV1 } from "@paw/protocol";

export const COMPLETION_REVIEW_CONTINUATION_POLICY_VERSION_V2 =
  "paw.completion-review-continuation.v2" as const;
export const COMPLETION_REVIEW_FEEDBACK_CALLER_ID_V1 =
  "completion-review" as const;

export interface PendingCompletionReviewFeedbackV1 {
  readonly reviewId: string;
  readonly candidateHash: string;
  readonly inputId: string;
}

export function completionReviewFeedbackInputIdV1(
  candidateHash: string,
): string {
  if (!/^[0-9a-f]{64}$/u.test(candidateHash)) {
    throw new Error("Completion review feedback candidate hash is invalid");
  }
  return `completion-review-feedback-${candidateHash.slice(0, 32)}`;
}

export function createCompletionReviewFeedbackV1(
  settlement: CompletionReviewSettledFactV1,
): string {
  if (settlement.status !== "completed" || settlement.verdict !== "block") {
    throw new Error("Completion review feedback requires a blocking verdict");
  }
  return `Continue the existing task. An independent completion review blocked the previous delivery (${settlement.reasonCode}). Address this concrete issue before finishing: ${settlement.summary}. Run proportionate verification and report the evidence.`;
}

export function createCompletionReviewFallbackFeedbackV1(
  settlement: CompletionReviewSettledFactV1,
): string {
  if (settlement.status !== "failed" && settlement.status !== "unknown") {
    throw new Error(
      "Completion review fallback requires an unavailable reviewer",
    );
  }
  return `Continue the existing task. The independent completion review could not decide (${settlement.reasonCode}): ${settlement.summary}. Recheck the final diff, run the narrowest relevant verification without hiding its exit status, and resolve any remaining uncertainty before finishing.`;
}

/**
 * Recognize only the FIFO head created by a durable blocking review or a
 * bounded unavailable-reviewer fallback. Other work and identity drift fail
 * closed.
 */
export function projectPendingCompletionReviewFeedbackV1(
  facts: readonly InputFactV1[],
): PendingCompletionReviewFeedbackV1 | undefined {
  const promoted = new Set(
    facts.flatMap((fact) =>
      fact.type === "input.promoted" ? [fact.inputId] : [],
    ),
  );
  const pendingAccepted = facts.flatMap((fact, index) =>
    fact.type === "input.accepted" && !promoted.has(fact.inputId)
      ? [{ fact, index }]
      : [],
  );
  if (pendingAccepted.some(({ fact }) => fact.delivery === "steer")) {
    return undefined;
  }
  const head = pendingAccepted.find(({ fact }) => fact.delivery === "queue");
  if (!head || head.fact.callerId !== COMPLETION_REVIEW_FEEDBACK_CALLER_ID_V1) {
    return undefined;
  }

  for (let index = head.index - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    if (!fact || fact.type !== "completion.review_settled") {
      continue;
    }
    const content =
      fact.status === "completed" && fact.verdict === "block"
        ? createCompletionReviewFeedbackV1(fact)
        : fact.status === "failed" || fact.status === "unknown"
          ? createCompletionReviewFallbackFeedbackV1(fact)
          : undefined;
    if (!content) continue;
    const claimIndex = facts.findIndex(
      (candidate) =>
        candidate.type === "completion.review_claimed" &&
        candidate.reviewId === fact.reviewId,
    );
    const claim = claimIndex >= 0 ? facts[claimIndex] : undefined;
    if (
      !claim ||
      claim.type !== "completion.review_claimed" ||
      claimIndex >= index
    ) {
      return undefined;
    }
    const inputId = completionReviewFeedbackInputIdV1(claim.candidateHash);
    if (head.fact.inputId !== inputId || head.fact.content !== content) {
      return undefined;
    }
    return Object.freeze({
      reviewId: claim.reviewId,
      candidateHash: claim.candidateHash,
      inputId,
    });
  }
  return undefined;
}
