import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCompletionReviewCandidateV1 } from "@paw/completion-review";
import type { InputFactV1, RunJournalEnvelopeV1 } from "@paw/protocol";
import { createEnvironmentCompletionReviewerV1 } from "../../../../packages/paw-next/src/environment-audit.js";

// Exact visible report from V32 response-26.sse. File-read evidence below is
// synthetic: this verifies parsing/grounding gates, not generated code quality.
const raw = fs.readFileSync(
  new URL("./fixtures/v32-audit-report.txt", import.meta.url),
  "utf8",
);
const paths = JSON.parse(raw.slice(raw.indexOf("{"))).evidencePaths as string[];

test.each([true, false])(
  "captured V32 CLI notation report requires actual read evidence (reads=%s)",
  async (read) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-captured-audit-"));
    try {
      for (const name of paths) {
        const target = path.resolve(root, name);
        if (!target.startsWith(`${root}${path.sep}`))
          throw new Error("Invalid fixture path");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, "synthetic evidence fixture");
      }
      const candidate = createCompletionReviewCandidateV1({
        sourceThroughSeq: 5,
        goal: "check the files",
        assistantText: "done",
        changedPaths: paths,
        mutationCount: paths.length,
        hasUnknownMutationPath: false,
        toolEvidence: [],
      });
      const reviewer = createEnvironmentCompletionReviewerV1({
        workspaceRoot: root,
        async run(_goal, _signal, observe) {
          const facts: InputFactV1[] = [];
          if (read)
            for (const [i, name] of paths.entries()) {
              const call: InputFactV1 = {
                type: "tool.call_observed",
                modelCallId: `model-${i}`,
                turn: i + 1,
                callId: `read-${i}`,
                tool: "workspace_read_file",
                args: { path: name },
                order: 0,
              };
              observe({
                runId: "child",
                record: { kind: "input_fact", fact: call },
              } as RunJournalEnvelopeV1);
              facts.push(call, {
                type: "tool.settled",
                callId: `read-${i}`,
                status: "completed",
                observation: {
                  schemaVersion: "paw.tool-observation.v1",
                  summary: "read fixture",
                  isError: false,
                },
              });
            }
          return {
            facts,
            result: {
              status: "completed",
              summary: raw,
              childRun: {
                runtime: "paw_next_v3",
                runId: `child-run-${"a".repeat(32)}`,
                sessionId: `child-session-${"a".repeat(32)}`,
                parentCallId: "audit",
                configHash: "b".repeat(64),
                tailSeq: 32,
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
      ).toBe(read ? "environment_verified" : "AuditEvidenceMissing");
      if (read)
        expect(result).toMatchObject({
          verdict: "allow",
          environmentAudit: { integrity: "clean" },
        });
    } finally {
      if (
        path.dirname(root) !== path.resolve(os.tmpdir()) ||
        !path.basename(root).startsWith("paw-captured-audit-")
      )
        throw new Error("Invalid cleanup path");
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
