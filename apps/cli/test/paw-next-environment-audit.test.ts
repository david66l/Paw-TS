import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCompletionReviewCandidateV1 } from "@paw/completion-review";
import type { InputFactV1, RunJournalEnvelopeV1 } from "@paw/protocol";
import {
  createEnvironmentCompletionReviewerV1,
  fingerprintAuditFile,
} from "../src/paw-next/environment-audit.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-audit-unit-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "file.txt"), "before");
  const candidate = createCompletionReviewCandidateV1({
    sourceThroughSeq: 5,
    goal: "check the file",
    assistantText: "done",
    changedPaths: ["file.txt"],
    mutationCount: 1,
    hasUnknownMutationPath: false,
    toolEvidence: [],
  });
  return { root, candidate };
}
const call: InputFactV1 = {
  type: "tool.call_observed",
  modelCallId: "m1",
  turn: 1,
  callId: "read1",
  tool: "workspace_read_file",
  args: { path: "file.txt" },
  order: 0,
};
const settled: InputFactV1 = {
  type: "tool.settled",
  callId: "read1",
  status: "completed",
  observation: {
    schemaVersion: "paw.tool-observation.v1",
    summary: "before",
    isError: false,
  },
};

test("audit invalidates changed content including uncommitted files", async () => {
  const { root, candidate } = fixture();
  const reviewer = createEnvironmentCompletionReviewerV1({
    workspaceRoot: root,
    async run(_goal, _signal, observe) {
      observe({
        runId: "child",
        record: { kind: "input_fact", fact: call },
      } as RunJournalEnvelopeV1);
      fs.writeFileSync(path.join(root, "file.txt"), "changed concurrently");
      return {
        facts: [call, settled],
        result: {
          status: "completed",
          summary: JSON.stringify({
            completion: "complete",
            summary: "looks fine",
            evidencePaths: ["file.txt"],
            unmetCriteria: [],
          }),
          childRun: {
            runtime: "paw_next_v3",
            runId: `child-run-${"a".repeat(32)}`,
            sessionId: `child-session-${"a".repeat(32)}`,
            parentCallId: "audit",
            configHash: "b".repeat(64),
            tailSeq: 4,
          },
        },
      };
    },
  });
  const result = await reviewer.review(candidate, {
    signal: new AbortController().signal,
  });
  expect(result.status).toBe("unknown");
  expect(result.environmentAudit?.integrity).toBe("suspect");
  if (result.status === "unknown")
    expect(result.errorCode).toBe("AuditEvidenceChanged");
});

test("audit timeout remains unknown and aborts its child", async () => {
  const { root, candidate } = fixture();
  let aborted = false;
  const reviewer = createEnvironmentCompletionReviewerV1({
    workspaceRoot: root,
    timeoutMs: 10,
    async run(_goal, signal) {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
      throw new Error("unreachable");
    },
  });
  const result = await reviewer.review(candidate, {
    signal: new AbortController().signal,
  });
  expect(aborted).toBe(true);
  expect(result.status).toBe("unknown");
  if (result.status === "unknown")
    expect(result.errorCode).toBe("AuditTimeout");
});

test("audit file evidence excludes paths outside the workspace and private runtime state", () => {
  const { root } = fixture();
  expect(() => fingerprintAuditFile(root, "../outside.txt")).toThrow();
  expect(() =>
    fingerprintAuditFile(root, ".paw/settings.local.json"),
  ).toThrow();
  expect(fingerprintAuditFile(root, "file.txt").hash).toMatch(/^[a-f0-9]{64}$/);
});
