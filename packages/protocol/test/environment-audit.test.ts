import { expect, test } from "bun:test";
import { COMPLETION_REVIEW_POLICY_VERSION_V1, parseRunJournalPrefixV1 } from "../src/index.js";

const evidence = {
  policyVersion: "paw.environment-audit.v1",
  candidateHash: "a".repeat(64),
  sourceRevision: "b".repeat(64),
  childRunId: `child-run-${"c".repeat(32)}`,
  childSessionId: `child-session-${"c".repeat(32)}`,
  integrity: "clean",
  inspected: [{ path: "src/app.ts", hash: "d".repeat(64) }],
  unmetCriteria: [],
};
function prefix(audit: unknown = evidence, reviewerId = "paw.environment-audit.v1") {
  return [
    { type: "attempt.started", goalHash: "goal", configHash: "config" },
    {
      type: "completion.review_claimed",
      reviewId: "review1",
      candidateHash: "a".repeat(64),
      policyVersion: COMPLETION_REVIEW_POLICY_VERSION_V1,
      reviewerId,
      triggers: ["non_trivial_change"],
      sourceThroughSeq: 1,
      claimedAt: 1,
    },
    {
      type: "completion.review_settled",
      reviewId: "review1",
      status: "completed",
      verdict: "allow",
      reasonCode: "environment_verified",
      summary: "checked",
      settledAt: 2,
      ...(audit ? { environmentAudit: audit } : {}),
    },
  ].map((fact, i) => ({
    schemaVersion: "paw.run-journal.v1",
    sessionId: "s",
    runId: "r",
    seq: i + 1,
    ts: i,
    record: { kind: "input_fact", fact },
  }));
}
test("environment audit evidence is candidate-bound and requires a clean grounded verdict", () => {
  expect(parseRunJournalPrefixV1(prefix())).toHaveLength(3);
  expect(() => parseRunJournalPrefixV1(prefix({ ...evidence, integrity: "suspect" }))).toThrow();
  expect(() => parseRunJournalPrefixV1(prefix({ ...evidence, inspected: [] }))).toThrow();
  expect(() =>
    parseRunJournalPrefixV1(prefix({ ...evidence, unmetCriteria: ["missing behavior"] })),
  ).toThrow();
  expect(() =>
    parseRunJournalPrefixV1(prefix({ ...evidence, candidateHash: "e".repeat(64) })),
  ).toThrow();
  expect(() => parseRunJournalPrefixV1(prefix(undefined, "legacy-reviewer"))).toThrow();
  expect(() => parseRunJournalPrefixV1(prefix(null))).toThrow();
  expect(parseRunJournalPrefixV1(prefix(null, "legacy-reviewer"))).toHaveLength(3);
});

test("browser audit evidence is optional, bounded, and rejects empty or duplicate proof", () => {
  const check = {
    callId: "browser1",
    url: "http://127.0.0.1:3000/",
    scenarioHash: "e".repeat(64),
    observationHash: "f".repeat(64),
    assertions: 1,
    checkedAt: 10,
  };
  expect(parseRunJournalPrefixV1(prefix({ ...evidence, browserChecks: [check] }))).toHaveLength(3);
  for (const invalid of [
    { ...check, assertions: 0 },
    { ...check, url: "https://external.invalid/" },
    { ...check, observationHash: "invented" },
    { ...check, passed: true },
  ]) {
    expect(() =>
      parseRunJournalPrefixV1(prefix({ ...evidence, browserChecks: [invalid] })),
    ).toThrow();
  }
  expect(() =>
    parseRunJournalPrefixV1(prefix({ ...evidence, browserChecks: [check, check] })),
  ).toThrow();
});
