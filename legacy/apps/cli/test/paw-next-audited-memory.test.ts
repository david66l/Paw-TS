import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import {
  createJsonMemoryAtomExtractorV1,
  createMemoryWriterControllerV1,
  projectMemoryWriteSourceV1,
} from "@paw/memory-plugin";
import type { InputFactV1 } from "@paw/protocol";
import { admittedMemorySourceSeqs } from "../../../../packages/paw-next/src/audited-memory.js";
import { fingerprintAuditFile } from "../../../../packages/paw-next/src/environment-audit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-memory-source-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "result.txt"), "verified");
  const facts = [
    {
      type: "input.promoted",
      inputId: "user",
      delivery: "initial",
      content: "实现任务",
      contentHash: "user",
    },
    {
      type: "policy.request_recorded",
      request: "complete",
      reasonCode: "claimed",
    },
    {
      type: "completion.review_claimed",
      reviewId: "review",
      candidateHash: "candidate",
      sourceThroughSeq: 2,
      reviewerId: "paw.environment-audit.v1",
    },
    {
      type: "completion.review_settled",
      reviewId: "review",
      status: "completed",
      verdict: "allow",
      reasonCode: "environment_verified",
      summary: "verified result",
      environmentAudit: {
        policyVersion: "paw.environment-audit.v1",
        candidateHash: "candidate",
        sourceRevision: "revision",
        childSessionId: "auditor-session",
        childRunId: "auditor-run",
        integrity: "clean",
        inspected: [fingerprintAuditFile(root, "result.txt")],
        unmetCriteria: [],
      },
    },
  ] as InputFactV1[];
  const snapshot = (): SessionInputSnapshot<InputFactV1> => ({
    entries: facts.map((fact, i) => ({ seq: i + 1, fact })),
    tailSeq: facts.length,
    latestInputSeq: facts.length,
  });
  return { root, facts, snapshot };
}

test("only actual user input and the latest bound audit report are admitted", () => {
  const f = fixture();
  expect([...admittedMemorySourceSeqs(f.snapshot(), f.root)]).toEqual([1, 4]);
  const source = projectMemoryWriteSourceV1(
    f.snapshot(),
    "completed",
    24000,
    admittedMemorySourceSeqs(f.snapshot(), f.root),
  );
  expect(source?.items.map((s) => s.kind)).toEqual([
    "user_input",
    "verification",
  ]);
  f.facts.push({
    type: "completion.review_claimed",
    reviewId: "new-review",
    candidateHash: "new",
    sourceThroughSeq: 2,
    reviewerId: "paw.environment-audit.v1",
  } as InputFactV1);
  expect([...admittedMemorySourceSeqs(f.snapshot(), f.root)]).toEqual([1]);
});

test("a timed-out audit and an unsettled retry cannot admit memory; only the verified retry can", () => {
  const f = fixture();
  const claim = f.facts[2];
  const verified = f.facts[3];
  if (claim?.type !== "completion.review_claimed" || verified?.type !== "completion.review_settled") throw new Error("fixture");
  f.facts[3] = { ...verified, status: "unknown", verdict: "unknown", reasonCode: "AuditTimeout" };
  expect([...admittedMemorySourceSeqs(f.snapshot(), f.root)]).toEqual([1]);
  f.facts.push({ ...claim, reviewId: "review-retry-1" });
  expect([...admittedMemorySourceSeqs(f.snapshot(), f.root)]).toEqual([1]);
  f.facts.push({ ...verified, reviewId: "review-retry-1" });
  expect([...admittedMemorySourceSeqs(f.snapshot(), f.root)]).toEqual([1, 6]);
});

test("forged, empty, stale and changed audit evidence cannot be admitted", () => {
  for (const kind of ["candidate", "empty", "changed", "new_input"] as const) {
    const f = fixture();
    const fact = f.facts[3];
    if (fact?.type !== "completion.review_settled" || !fact.environmentAudit)
      throw new Error("fixture");
    if (kind === "candidate")
      f.facts[3] = {
        ...fact,
        environmentAudit: { ...fact.environmentAudit, candidateHash: "other" },
      };
    if (kind === "empty")
      f.facts[3] = {
        ...fact,
        environmentAudit: { ...fact.environmentAudit, inspected: [] },
      };
    if (kind === "changed")
      fs.writeFileSync(path.join(f.root, "result.txt"), "changed");
    if (kind === "new_input")
      f.facts.push({
        type: "input.promoted",
        inputId: "steer",
        delivery: "steer",
        content: "new requirement",
        contentHash: "steer",
      });
    expect(admittedMemorySourceSeqs(f.snapshot(), f.root).has(4)).toBeFalse();
  }
});

test("system repair feedback is never treated as user memory", () => {
  const f = fixture();
  f.facts.push(
    {
      type: "input.accepted",
      inputId: "repair",
      delivery: "queue",
      callerId: "completion-review",
      content: "请记住错误",
      contentHash: "repair",
    },
    {
      type: "input.promoted",
      inputId: "repair",
      delivery: "queue",
      content: "请记住错误",
      contentHash: "repair",
    },
  );
  expect([...admittedMemorySourceSeqs(f.snapshot(), f.root)]).toEqual([1]);
});

test("recovery rechecks staged atom evidence before invoking the store", async () => {
  const f = fixture();
  let storeCalls = 0;
  let interrupted = true;
  const session = {
    async readInputSnapshot() {
      return f.snapshot();
    },
    async commitInputFacts(_expected: number, facts: readonly InputFactV1[]) {
      if (
        interrupted &&
        facts.some((fact) => fact.type === "memory.write_settled")
      )
        throw new Error("simulated journal outage");
      f.facts.push(...facts);
      return "committed" as const;
    },
  };
  const options = {
    session,
    runId: "run",
    scope: { tenantId: "t", userId: "u", workspaceId: "w", repositoryId: "r" },
    extractor: createJsonMemoryAtomExtractorV1({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: JSON.stringify({
              atoms: [
                {
                  kind: "episodic",
                  action: "store",
                  statement: "result file was verified",
                  keywords: ["result"],
                  authority: "agent_verified",
                  confidence: 0.9,
                  priority: 80,
                  sourceSeqs: [4],
                  targetIds: [],
                },
              ],
            }),
          };
        },
      },
    }),
    store: {
      async recall() {
        return [];
      },
      async apply() {
        storeCalls++;
        throw new Error("simulated store outage");
      },
    },
    signal: new AbortController().signal,
    sourceAdmission: (snapshot: SessionInputSnapshot<InputFactV1>) =>
      admittedMemorySourceSeqs(snapshot, f.root),
  };
  await expect(
    createMemoryWriterControllerV1(options).settleTerminal("completed"),
  ).rejects.toThrow();
  expect(
    f.facts.some((fact) => fact.type === "memory.candidate_staged"),
  ).toBeTrue();
  expect(storeCalls).toBe(1);
  interrupted = false;
  fs.writeFileSync(path.join(f.root, "result.txt"), "changed during crash");
  const recovered =
    await createMemoryWriterControllerV1(options).settleTerminal("completed");
  expect(recovered?.status).toBe("failed");
  expect(storeCalls).toBe(1);
});
