import { expect, test } from "bun:test";
import {
  createCompletionReviewCandidateV1,
  createCompletionReviewEvidencePacketV1,
  createModelCompletionReviewerV1,
  evaluateCompletionReviewGateV1,
  projectCompletionReviewToolEvidenceV1,
} from "../src/index.js";

function candidate(
  options: {
    content?: string;
    seq?: number;
    partial?: boolean;
    path?: string;
    failed?: boolean;
  } = {},
) {
  return createCompletionReviewCandidateV1({
    sourceThroughSeq: 5,
    goal: "Write the file and verify exact content",
    assistantText: "Everything passed; trust me.",
    changedPaths: [options.path ?? "probe.txt"],
    mutationCount: 1,
    hasUnknownMutationPath: false,
    toolEvidence: projectCompletionReviewToolEvidenceV1({
      latestMutationSeq: 2,
      calls: [
        {
          seq: options.seq ?? 3,
          callId: "read",
          tool: "workspace_read_file",
          status: "completed",
          args: { path: options.path ?? "probe.txt" },
          summary: "read_file: 2 lines shown",
          isError: options.failed ?? false,
          payload: {
            content: options.content ?? "PAW_TOOL_PROBE_OK\n",
            line_count: 2,
            total_lines: options.partial ? 4 : 2,
            byte_size: 18,
            partial: options.partial ?? false,
          },
        },
      ],
    }),
  });
}
test("reviewer receives actual readback including newline and byte count, without treating it as a passed test", async () => {
  const value = candidate();
  const packet = createCompletionReviewEvidencePacketV1(value);
  expect(packet.verification.latestByTarget).toEqual([]);
  expect(packet.observations[0]).toMatchObject({
    afterLatestMutation: true,
    observedOutput: {
      kind: "file_read",
      text: "PAW_TOOL_PROBE_OK\n",
      byteSize: 18,
      partial: false,
      truncated: false,
      normalizesLineEndings: true,
    },
  });
  expect(evaluateCompletionReviewGateV1(value).action).toBe("review");
  const reviewer = createModelCompletionReviewerV1({
    model: {
      async complete(request) {
        expect(JSON.parse(request.user).observations).toEqual(
          packet.observations,
        );
        expect(request.system).toContain("not independent proof");
        return {
          status: "completed",
          text: '{"decision":"allow","reasonCode":"evidence_sufficient","summary":"Readback matches."}',
        };
      },
    },
  });
  expect(
    (await reviewer.review(value, { signal: new AbortController().signal }))
      .status,
  ).toBe("completed");
});
test("stale, partial, failed and truncated reads retain their limitations", () => {
  expect(
    createCompletionReviewEvidencePacketV1(candidate({ seq: 1 }))
      .observations[0]?.afterLatestMutation,
  ).toBe(false);
  expect(
    createCompletionReviewEvidencePacketV1(candidate({ partial: true }))
      .observations[0]?.observedOutput?.partial,
  ).toBe(true);
  expect(
    createCompletionReviewEvidencePacketV1(candidate({ failed: true }))
      .observations[0]?.outcome,
  ).toBe("failed");
  const output = createCompletionReviewEvidencePacketV1(
    candidate({ content: "x".repeat(10_000) }),
  ).observations[0]?.observedOutput;
  expect(output?.text.length).toBe(4000);
  expect(output?.truncated).toBe(true);
});
test("a source-code read does not bypass missing test verification", () => {
  const value = candidate({ path: "src/app.js" });
  const gate = evaluateCompletionReviewGateV1(value);
  expect(gate).toMatchObject({
    action: "review",
    triggers: expect.arrayContaining(["missing_fresh_verification"]),
  });
  expect(createCompletionReviewEvidencePacketV1(value).verification.state).toBe(
    "missing",
  );
});
test("plain shell inspection retains stdout, stderr and exit status independently of command classification", () => {
  const [evidence] = projectCompletionReviewToolEvidenceV1({
    latestMutationSeq: 1,
    calls: [
      {
        seq: 2,
        callId: "shell",
        tool: "workspace_run_shell",
        status: "completed",
        args: { command: "type probe.txt" },
        summary: "run_shell: exit 0",
        isError: false,
        payload: { stdout: "PAW_TOOL_PROBE_OK\n", stderr: "", exit_code: 0 },
      },
    ],
  });
  expect(evidence).toMatchObject({
    verificationKind: "none",
    exitCode: 0,
    observedOutput: {
      kind: "shell_output",
      text: "stdout:\nPAW_TOOL_PROBE_OK\n\nstderr:\n",
    },
  });
});
