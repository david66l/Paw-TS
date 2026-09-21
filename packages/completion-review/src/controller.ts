import type { SessionInputSnapshot } from "@paw/agent-loop";
import {
  COMPLETION_REVIEW_POLICY_VERSION_V1,
  type CompletionReviewSettledFactV1,
  type CompletionReviewTriggerV1,
  type InputFactV1,
} from "@paw/protocol";
import type { CompletionReviewCandidateV1 } from "./candidate.js";
import type { CompletionReviewerResultV1 } from "./reviewer.js";

export interface CompletionReviewControllerV1 {
  review(
    candidate: CompletionReviewCandidateV1,
    triggers: readonly CompletionReviewTriggerV1[],
  ): Promise<CompletionReviewSettledFactV1>;
}

export interface CompletionReviewSessionV1 {
  readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>>;
  appendInputFacts(facts: readonly InputFactV1[]): Promise<void>;
  commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict">;
}

export function createCompletionReviewControllerV1(options: {
  readonly session: CompletionReviewSessionV1;
  readonly reviewer: Readonly<{
    reviewerId: string;
    review(
      candidate: CompletionReviewCandidateV1,
      options: Readonly<{ signal: AbortSignal; attempt?: 0 | 1 }>,
    ): Promise<CompletionReviewerResultV1>;
  }>;
  readonly signal: AbortSignal;
  /** Opt-in bounded retry. The caller freezes this policy in its run identity. */
  readonly retryOnceOn?: readonly string[];
  /** Revalidate the candidate and pending input before starting a retry. */
  readonly canRetry?: () => Promise<boolean>;
  readonly clock?: () => number;
}): CompletionReviewControllerV1 {
  const clock = options.clock ?? Date.now;
  const review = options.reviewer.review.bind(options.reviewer);
  const retryReasons = new Set(options.retryOnceOn ?? []);
  if ([...retryReasons].some((reason) => !reason.trim()))
    throw new Error("Completion review retry reasons are invalid");
  if (!options.reviewer.reviewerId.trim() || !options.signal) {
    throw new Error("Completion review controller options are invalid");
  }
  return Object.freeze({
    async review(
      candidate: CompletionReviewCandidateV1,
      triggers: readonly CompletionReviewTriggerV1[],
    ) {
      if (triggers.length === 0) {
        throw new Error("Completion review requires at least one trigger");
      }
      const first = await reviewAttempt(0);
      if (
        options.signal.aborted ||
        first.status === "completed" ||
        !retryReasons.has(first.reasonCode)
      )
        return first;
      const retryTailSeq = (await options.session.readInputSnapshot()).tailSeq;
      if (options.canRetry && !(await options.canRetry())) return first;
      return reviewAttempt(1, retryTailSeq, first);

      async function reviewAttempt(
        attempt: 0 | 1,
        retryTailSeq?: number,
        fallback?: CompletionReviewSettledFactV1,
      ): Promise<CompletionReviewSettledFactV1> {
        const reviewId = `completion-review-${candidate.candidateHash.slice(0, 32)}${attempt ? "-retry-1" : ""}`;
        const snapshot = await options.session.readInputSnapshot();
        if (retryTailSeq !== undefined && snapshot.tailSeq !== retryTailSeq)
          return fallback!;
        const existing = findReview(
          snapshot,
          reviewId,
          candidate.candidateHash,
        );
        if (existing.settlement) return existing.settlement;
        options.signal.throwIfAborted();
        if (!existing.claimed) {
          if (!(await claim())) return fallback!;
        }
        const result = await review(candidate, {
          signal: options.signal,
          attempt,
        });
        const settlement = toSettlement(
          reviewId,
          options.signal.aborted
            ? { status: "unknown", errorCode: "CompletionReviewCancelled" }
            : result,
          clock(),
        );
        await options.session.appendInputFacts([settlement]);
        return settlement;

        async function claim(): Promise<boolean> {
          while (true) {
            options.signal.throwIfAborted();
            const snapshot = await options.session.readInputSnapshot();
            // Linearize retry eligibility with its durable claim. A queued
            // input racing the guard must not silently start an obsolete audit.
            if (retryTailSeq !== undefined && snapshot.tailSeq !== retryTailSeq)
              return false;
            const projected = findReview(
              snapshot,
              reviewId,
              candidate.candidateHash,
            );
            if (projected.claimed) return true;
            const committed = await options.session.commitInputFacts(
              snapshot.tailSeq,
              [
                {
                  type: "completion.review_claimed",
                  reviewId,
                  candidateHash: candidate.candidateHash,
                  policyVersion: COMPLETION_REVIEW_POLICY_VERSION_V1,
                  reviewerId: options.reviewer.reviewerId,
                  triggers: Object.freeze([...new Set(triggers)]),
                  sourceThroughSeq: candidate.sourceThroughSeq,
                  claimedAt: clock(),
                },
              ],
            );
            if (committed === "committed") return true;
          }
        }
      }
    },
  });
}

function findReview(
  snapshot: SessionInputSnapshot<InputFactV1>,
  reviewId: string,
  candidateHash: string,
): Readonly<{
  claimed: boolean;
  settlement?: CompletionReviewSettledFactV1;
}> {
  const claims = snapshot.entries.filter(
    (entry) =>
      entry.fact.type === "completion.review_claimed" &&
      entry.fact.reviewId === reviewId,
  );
  if (claims.length > 1) throw new Error("Duplicate completion review claim");
  const claim = claims[0]?.fact;
  if (
    claim?.type === "completion.review_claimed" &&
    claim.candidateHash !== candidateHash
  ) {
    throw new Error("Completion review candidate identity drifted");
  }
  const settlements = snapshot.entries.filter(
    (entry) =>
      entry.fact.type === "completion.review_settled" &&
      entry.fact.reviewId === reviewId,
  );
  if (settlements.length > 1) {
    throw new Error("Duplicate completion review settlement");
  }
  const settlement = settlements[0]?.fact;
  return Object.freeze({
    claimed: claim !== undefined,
    ...(settlement?.type === "completion.review_settled" ? { settlement } : {}),
  });
}

function toSettlement(
  reviewId: string,
  result: CompletionReviewerResultV1,
  settledAt: number,
): CompletionReviewSettledFactV1 {
  if (result.status === "completed") {
    return Object.freeze({
      type: "completion.review_settled",
      ...(result.environmentAudit
        ? { environmentAudit: result.environmentAudit }
        : {}),
      reviewId,
      status: "completed",
      verdict: result.verdict,
      reasonCode: result.reasonCode,
      summary: singleLine(result.summary),
      settledAt,
    });
  }
  return Object.freeze({
    type: "completion.review_settled",
    ...(result.environmentAudit
      ? { environmentAudit: result.environmentAudit }
      : {}),
    reviewId,
    status: result.status,
    verdict: "unknown",
    reasonCode: result.errorCode,
    summary: singleLine(result.summary ?? result.errorCode),
    settledAt,
  });
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}
