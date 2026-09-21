import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCompletionReviewCandidateV1 } from "@paw/completion-review";
import type { InputFactV1, RunJournalEnvelopeV1 } from "@paw/protocol";
import { BROWSER_PROOF_PREFIX } from "../../../../packages/paw-next/src/browser-check.js";
import {
  createEnvironmentCompletionReviewerV1,
  fingerprintAuditFile,
} from "../../../../packages/paw-next/src/environment-audit.js";

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

test("audit accepts one report envelope but rejects ambiguity, truncation and ungrounded claims", async () => {
  const report = JSON.stringify({
    completion: "complete",
    summary: 'Checked braces { and quote " in content',
    evidencePaths: ["file.txt"],
    unmetCriteria: [],
  });
  for (const [raw, read, code] of [
    [report, true, "environment_verified"],
    [
      `Audit complete. I independently read the file.\n${report}`,
      true,
      "environment_verified",
    ],
    [
      `Audit complete.\n\`\`\`json\n${report}\n\`\`\``,
      true,
      "environment_verified",
    ],
    [`Audit complete.\n${report}`, false, "AuditEvidenceMissing"],
    [`Checked CLI \`add <JSON-payload> [priority]\` and \`list\`.\n${report}`, true, "environment_verified"],
    [`Checked CLI \`add <JSON-payload> [priority]\`.\n${report}`, false, "AuditEvidenceMissing"],
    [`Checked \`[priority]\`.\n${report.replace('"complete"', '"incomplete"')}`, true, "environment_unmet"],
    [`[${report}]`, true, "AuditReportInvalid"],
    [`[1,2]\n${report}`, true, "AuditReportInvalid"],
    [`Checked \`unclosed [priority].\n${report}`, true, "AuditReportInvalid"],
    [`Checked \`[priority]\`.\n${report}\n${report}`, true, "AuditReportInvalid"],
    [`Checked \`[priority]\`.\n${report}\nActually incomplete.`, true, "AuditReportInvalid"],
    [`\`{\"completion\":\"incomplete\"}\`\n${report}`, true, "AuditReportInvalid"],
    [`Checked constructor({maxAttempts=3}={}), snapshots {id,payload} and empty [].\n\`\`\`json\n${report}\n\`\`\``, true, "environment_verified"],
    [`${report}\n\`\`\`json\n${report}\n\`\`\``, true, "AuditReportInvalid"],
    [`{"completion":"incomplete"\n\`\`\`json\n${report}\n\`\`\``, true, "AuditReportInvalid"],
    [report.replace('["file.txt"]', '["file.txt","."]'), true, "AuditEvidencePathInvalid"],
    [report.replace('["file.txt"]', '["../outside.txt"]'), true, "AuditEvidencePathInvalid"],
    [JSON.stringify({ ...JSON.parse(report), notes: "Tests were checked from recorded evidence." }), true, "environment_verified"],
    [JSON.stringify({ ...JSON.parse(report), browserRequired: false, browserChecks: [] }), true, "environment_verified"],
    [JSON.stringify({ ...JSON.parse(report), browserRequired: true, browserChecks: [] }), true, "AuditReportInvalid"],
    [JSON.stringify({ ...JSON.parse(report), browserRequired: false, browserChecks: ["invented"] }), true, "AuditReportInvalid"],
    [`Audit complete.\n\`\`\`json\n${report}\n\`\`\`\nActually incomplete.`, true, "AuditReportInvalid"],
    [JSON.stringify({ ...JSON.parse(report), completion: "incomplete", unmetCriteria: ["Missing test"], notes: "Everything is fine" }), true, "environment_unmet"],
    [JSON.stringify({ ...JSON.parse(report), notes: "Verified without reading" }), false, "AuditEvidenceMissing"],
    [JSON.stringify({ ...JSON.parse(report), notes: { completion: "complete" } }), true, "AuditReportInvalid"],
    [JSON.stringify({ ...JSON.parse(report), notes: "x".repeat(2001) }), true, "environment_verified"],
    [JSON.stringify({ ...JSON.parse(report), summary: "x".repeat(2209) }), true, "environment_verified"],
    [JSON.stringify({ ...JSON.parse(report), summary: "x".repeat(2209), completion: "incomplete", unmetCriteria: ["Missing acceptance test"] }), true, "environment_unmet"],
    [JSON.stringify({ ...JSON.parse(report), summary: "x".repeat(2209), completion: "unknown" }), true, "AuditUncertain"],
    [JSON.stringify({ ...JSON.parse(report), summary: "x".repeat(2209) }), false, "AuditEvidenceMissing"],
    [JSON.stringify({ ...JSON.parse(report), summary: "x".repeat(96001) }), true, "AuditReportInvalid"],
    [JSON.stringify({ ...JSON.parse(report), notes: "x".repeat(96001) }), true, "AuditReportInvalid"],
    [JSON.stringify({ ...JSON.parse(report), override: "complete" }), true, "AuditReportInvalid"],
    [`${report}\n${report}`, true, "AuditReportInvalid"],
    [
      `\`\`\`json\n${report}\n\`\`\`\n\`\`\`json\n${report}\n\`\`\``,
      true,
      "AuditReportInvalid",
    ],
    [`Audit complete.\n${report.slice(0, -1)}`, true, "AuditReportInvalid"],
    [`[${report}]`, true, "AuditReportInvalid"],
    [`${report}\nActually incomplete.`, true, "AuditReportInvalid"],
    ['{"completion":"complete"}', true, "AuditReportInvalid"],
  ] as const) {
    const { root, candidate } = fixture();
    const reviewer = createEnvironmentCompletionReviewerV1({
      workspaceRoot: root,
      async run(_goal, _signal, observe) {
        if (read)
          observe({
            runId: "child",
            record: { kind: "input_fact", fact: call },
          } as RunJournalEnvelopeV1);
        return {
          facts: read ? [call, settled] : [],
          result: {
            status: "completed",
            summary: raw,
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
    expect(
      result.status === "completed" ? result.reasonCode : result.errorCode,
    ).toBe(code);
    expect(result.summary?.length ?? Infinity).toBeLessThanOrEqual(2000);
    if (raw.includes("Missing acceptance test")) {
      expect(result).toMatchObject({ verdict: "block", environmentAudit: { unmetCriteria: ["Missing acceptance test"] } });
    }
    if (code === "environment_verified")
      expect(result).toMatchObject({
        verdict: "allow",
        environmentAudit: { integrity: "clean" },
      });
    if (raw.includes("Tests were checked from recorded evidence.") && result.status === "completed")
      expect(result.summary).toContain("Tests were checked from recorded evidence.");
  }
});

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

test("browser claims require successful dispatched, scenario-bound assertions from the auditor", async () => {
  const scenario = {
    url: "http://127.0.0.1:3000/",
    steps: [{ action: "assert_visible", selector: "#result" }],
  };
  for (const variant of [
    "valid",
    "visual_missing",
    "failed",
    "wrong_hash",
    "no_assertions",
    "no_dispatch",
    "wrong_tool",
    "invented_ref",
  ] as const) {
    const { root, candidate } = fixture();
    const proof = {
      schemaVersion: "paw.browser-audit.v1",
      url: scenario.url,
      scenarioHash:
        variant === "wrong_hash"
          ? "f".repeat(64)
          : createHash("sha256").update(JSON.stringify(scenario)).digest("hex"),
      observationHash: "e".repeat(64),
      assertions: variant === "no_assertions" ? 0 : 1,
      checkedAt: 10,
      passed: true,
    };
    const browserCall: InputFactV1 = {
      ...call,
      callId: "browser1",
      tool:
        variant === "wrong_tool"
          ? "workspace_read_file"
          : "workspace_browser_check",
      args: scenario,
    };
    const facts: InputFactV1[] = [
      call,
      settled,
      browserCall,
      ...(variant === "no_dispatch"
        ? []
        : [
            {
              type: "tool.dispatch_recorded" as const,
              callId: "browser1",
              turn: 1,
              sourceIndex: 0,
              batchId: "batch",
              mode: "serial" as const,
            },
          ]),
      {
        type: "tool.settled",
        callId: "browser1",
        status: "completed",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          isError: variant === "failed",
          summary: BROWSER_PROOF_PREFIX + JSON.stringify(proof),
        },
      },
    ];
    const reviewer = createEnvironmentCompletionReviewerV1({
      workspaceRoot: root,
      browserAudit: true,
      ...(variant === "visual_missing" ? { visualAudit: true as const } : {}),
      async run(_goal, _signal, observe) {
        observe({
          runId: "child",
          record: { kind: "input_fact", fact: call },
        } as RunJournalEnvelopeV1);
        return {
          facts,
          result: {
            status: "completed",
            summary: JSON.stringify({
              completion: "complete",
              summary: "按钮通过",
              evidencePaths: ["file.txt"],
              unmetCriteria: [],
              browserRequired: true,
              browserChecks: [
                variant === "invented_ref" ? "invented" : "browser1",
              ],
            }),
            childRun: {
              runtime: "paw_next_v3",
              runId: `child-run-${"a".repeat(32)}`,
              sessionId: `child-session-${"a".repeat(32)}`,
              parentCallId: "audit",
              configHash: "b".repeat(64),
              tailSeq: 6,
            },
          },
        };
      },
    });
    const result = await reviewer.review(candidate, {
      signal: new AbortController().signal,
    });
    if (variant === "valid") {
      expect(result.status).toBe("completed");
      if (result.status === "completed") expect(result.verdict).toBe("allow");
      expect(result.environmentAudit?.browserChecks?.[0]?.callId).toBe(
        "browser1",
      );
    } else {
      expect(result.status).toBe("unknown");
      expect(result.environmentAudit?.integrity).toBe("suspect");
    }
  }
});
