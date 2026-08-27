import { describe, expect, test } from "bun:test";

import {
  COMPLETION_REVIEW_POLICY_VERSION_V1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  parseRunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
} from "../src/index.js";

describe("canonical completion review protocol", () => {
  test("strictly parses the durable claim and settlement shapes", () => {
    expect(parseRunJournalEnvelopeV1(envelope(2, claim()))).toEqual(
      envelope(2, claim()),
    );
    expect(parseRunJournalEnvelopeV1(envelope(3, settlement()))).toEqual(
      envelope(3, settlement()),
    );
    const gateClaim = {
      ...claim(),
      triggers: ["fresh_verification_failed"] as const,
    };
    expect(parseRunJournalEnvelopeV1(envelope(2, gateClaim))).toEqual(
      envelope(2, gateClaim),
    );

    for (const invalid of [
      { ...claim(), reviewId: "" },
      { ...claim(), candidateHash: "bad" },
      { ...claim(), policyVersion: "paw.completion-review.v2" },
      { ...claim(), triggers: [] },
      { ...claim(), triggers: ["user_requested", "user_requested"] },
      { ...claim(), sourceThroughSeq: 0 },
      { ...claim(), extra: true },
      { ...settlement(), verdict: "unknown" },
      { ...settlement(), summary: "" },
      { ...settlement(), extra: true },
    ]) {
      expect(() => parseRunJournalEnvelopeV1(envelope(2, invalid))).toThrow();
    }
  });

  test("binds exactly one settlement to one earlier claim", () => {
    const valid = [attempt(), envelope(2, claim()), envelope(3, settlement())];
    expect(parseRunJournalPrefixV1(valid)).toEqual(valid);

    expect(() =>
      parseRunJournalPrefixV1([attempt(), envelope(2, settlement())]),
    ).toThrow(/claim/i);
    expect(() =>
      parseRunJournalPrefixV1([
        attempt(),
        envelope(2, claim()),
        envelope(3, claim()),
      ]),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseRunJournalPrefixV1([
        attempt(),
        envelope(2, claim()),
        envelope(3, settlement()),
        envelope(4, settlement()),
      ]),
    ).toThrow(/duplicate/i);
  });
});

function claim() {
  return {
    type: "completion.review_claimed" as const,
    reviewId: "completion-review-0123456789abcdef",
    candidateHash: "a".repeat(64),
    policyVersion: COMPLETION_REVIEW_POLICY_VERSION_V1,
    reviewerId: "paw.completion-reviewer.v1",
    triggers: ["user_requested", "missing_fresh_verification"] as const,
    sourceThroughSeq: 1,
    claimedAt: 1_800_000_000_002,
  };
}

function settlement() {
  return {
    type: "completion.review_settled" as const,
    reviewId: claim().reviewId,
    status: "completed" as const,
    verdict: "block" as const,
    reasonCode: "missing_verification",
    summary: "Run the focused verification.",
    settledAt: 1_800_000_000_003,
  };
}

function attempt(): RunJournalEnvelopeV1 {
  return envelope(1, {
    type: "attempt.started",
    goalHash: "b".repeat(64),
    configHash: "c".repeat(64),
  });
}

function envelope(seq: number, fact: unknown): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "completion-review-session",
    runId: "completion-review-run",
    seq,
    ts: 1_800_000_000_000 + seq,
    record: {
      kind: "input_fact",
      fact,
    } as RunJournalEnvelopeV1["record"],
  };
}
