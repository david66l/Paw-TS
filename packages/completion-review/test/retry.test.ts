import { expect, test } from "bun:test";
import type { InputFactV1 } from "@paw/protocol";
import {
  createCompletionReviewCandidateV1,
  createCompletionReviewControllerV1,
} from "../src/index.js";

const candidate = createCompletionReviewCandidateV1({
  sourceThroughSeq: 1,
  goal: "Deliver a tested change",
  assistantText: "Done",
  changedPaths: ["file.ts"],
  mutationCount: 1,
  hasUnknownMutationPath: false,
  toolEvidence: [],
});
const timeout = { status: "unknown" as const, errorCode: "AuditTimeout" };
const passed = {
  status: "completed" as const,
  verdict: "allow" as const,
  reasonCode: "environment_verified",
  summary: "Verified",
};
function fixture() {
  const facts: InputFactV1[] = [];
  const session = {
    async readInputSnapshot() {
      return {
        entries: facts.map((fact, i) => ({ seq: i + 1, fact })),
        tailSeq: facts.length,
        latestInputSeq: 1,
      };
    },
    async appendInputFacts(next: readonly InputFactV1[]) {
      facts.push(...next);
    },
    async commitInputFacts(tail: number, next: readonly InputFactV1[]) {
      if (tail !== facts.length) return "conflict" as const;
      facts.push(...next);
      return "committed" as const;
    },
  };
  return { facts, session };
}

test("timeout retries the same candidate once with distinct durable identities and reuses both settlements", async () => {
  const { session, facts } = fixture();
  const attempts: number[] = [];
  const options = {
    session,
    signal: new AbortController().signal,
    retryOnceOn: ["AuditTimeout"],
    reviewer: {
      reviewerId: "audit",
      async review(value: typeof candidate, call: { attempt?: 0 | 1 }) {
        expect(value).toBe(candidate);
        attempts.push(call.attempt!);
        return call.attempt === 0 ? timeout : passed;
      },
    },
  };
  expect(
    await createCompletionReviewControllerV1(options).review(candidate, [
      "user_requested",
    ]),
  ).toMatchObject({ verdict: "allow" });
  expect(
    await createCompletionReviewControllerV1(options).review(candidate, [
      "user_requested",
    ]),
  ).toMatchObject({ verdict: "allow" });
  expect(attempts).toEqual([0, 1]);
  const claims = facts.filter((f) => f.type === "completion.review_claimed");
  expect(claims.map((f) => f.candidateHash)).toEqual([
    candidate.candidateHash,
    candidate.candidateHash,
  ]);
  expect(claims[1]?.reviewId).toBe(`${claims[0]?.reviewId}-retry-1`);
  expect(facts.map((f) => f.type)).toEqual([
    "completion.review_claimed",
    "completion.review_settled",
    "completion.review_claimed",
    "completion.review_settled",
  ]);
});

test("a crash between attempts resumes the retry without repeating the first review", async () => {
  const { session } = fixture();
  let crash = true;
  const attempts: number[] = [];
  const options = {
    session,
    signal: new AbortController().signal,
    retryOnceOn: ["AuditTimeout"],
    async canRetry() {
      if (crash) {
        crash = false;
        throw new Error("simulated crash");
      }
      return true;
    },
    reviewer: {
      reviewerId: "audit",
      async review(_value: typeof candidate, call: { attempt?: 0 | 1 }) {
        attempts.push(call.attempt!);
        return call.attempt === 0 ? timeout : passed;
      },
    },
  };
  await expect(
    createCompletionReviewControllerV1(options).review(candidate, [
      "user_requested",
    ]),
  ).rejects.toThrow("simulated crash");
  expect(
    await createCompletionReviewControllerV1(options).review(candidate, [
      "user_requested",
    ]),
  ).toMatchObject({ verdict: "allow" });
  expect(attempts).toEqual([0, 1]);
});

test("exhaustion stays unknown across controller recreation instead of replenishing the retry allowance", async () => {
  const { session, facts } = fixture();
  let calls = 0;
  const options = {
    session,
    signal: new AbortController().signal,
    retryOnceOn: ["AuditTimeout"],
    reviewer: {
      reviewerId: "audit",
      async review() {
        calls++;
        return timeout;
      },
    },
  };
  for (let i = 0; i < 3; i++)
    expect(
      await createCompletionReviewControllerV1(options).review(candidate, [
        "user_requested",
      ]),
    ).toMatchObject({ status: "unknown", reasonCode: "AuditTimeout" });
  expect(calls).toBe(2);
  expect(facts).toHaveLength(4);
});

test("a changed candidate or pending user input can decline the retry", async () => {
  const { session, facts } = fixture();
  let calls = 0;
  const result = await createCompletionReviewControllerV1({
    session,
    signal: new AbortController().signal,
    retryOnceOn: ["AuditTimeout"],
    canRetry: async () => false,
    reviewer: {
      reviewerId: "audit",
      async review() {
        calls++;
        return timeout;
      },
    },
  }).review(candidate, ["user_requested"]);
  expect(result.reasonCode).toBe("AuditTimeout");
  expect(calls).toBe(1);
  expect(facts).toHaveLength(2);
});

test("input arriving between the retry guard and claim wins without a second model call", async () => {
  const { session, facts } = fixture();
  let calls = 0;
  const commit = session.commitInputFacts.bind(session);
  session.commitInputFacts = async (tail, next) => {
    if (
      next.some(
        (f) =>
          f.type === "completion.review_claimed" &&
          f.reviewId.endsWith("-retry-1"),
      )
    ) {
      facts.push({
        type: "input.accepted",
        inputId: "new-user-work",
        delivery: "queue",
        content: "New requirement",
        contentHash: "input",
        callerId: "user",
      });
      return "conflict";
    }
    return commit(tail, next);
  };
  const result = await createCompletionReviewControllerV1({
    session,
    signal: new AbortController().signal,
    retryOnceOn: ["AuditTimeout"],
    canRetry: async () => true,
    reviewer: {
      reviewerId: "audit",
      async review() {
        calls++;
        return timeout;
      },
    },
  }).review(candidate, ["user_requested"]);
  expect(result.reasonCode).toBe("AuditTimeout");
  expect(calls).toBe(1);
  expect(
    facts.filter((f) => f.type === "completion.review_claimed"),
  ).toHaveLength(1);
  expect(facts.at(-1)?.type).toBe("input.accepted");
});

test("parent cancellation cannot publish a late allow or start a retry", async () => {
  const { session, facts } = fixture();
  const abort = new AbortController();
  const result = await createCompletionReviewControllerV1({
    session,
    signal: abort.signal,
    retryOnceOn: ["AuditTimeout"],
    reviewer: {
      reviewerId: "audit",
      async review() {
        abort.abort();
        return passed;
      },
    },
  }).review(candidate, ["user_requested"]);
  expect(result).toMatchObject({
    status: "unknown",
    reasonCode: "CompletionReviewCancelled",
  });
  expect(facts).toHaveLength(2);
});

test.each([
  { ...passed, verdict: "block" as const },
  { status: "unknown" as const, errorCode: "AuditReportInvalid" },
])("non-timeout outcomes do not trigger audit retry: %j", async (outcome) => {
  const { session } = fixture();
  let calls = 0;
  await createCompletionReviewControllerV1({
    session,
    signal: new AbortController().signal,
    retryOnceOn: ["AuditTimeout"],
    reviewer: {
      reviewerId: "audit",
      async review() {
        calls++;
        return outcome;
      },
    },
  }).review(candidate, ["user_requested"]);
  expect(calls).toBe(1);
});
