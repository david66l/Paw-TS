import { describe, expect, test } from "bun:test";
import type { InputFactV1, TaskCheckpointV1 } from "@paw/protocol";

import {
  projectCheckpointEvidenceV1,
  verifyTaskCheckpointEvidenceV1,
} from "../src/index.js";
import {
  item,
  sourceEntries,
  validCheckpoint,
} from "./support/checkpoint-fixture.js";

describe("checkpoint evidence projection and verification", () => {
  test("binds changed files and verification to completed tool lifecycles", () => {
    const evidence = projectCheckpointEvidenceV1(sourceEntries());
    const verification = verifyTaskCheckpointEvidenceV1(
      validCheckpoint(),
      evidence,
    );

    expect(verification).toEqual({ ok: true });
    expect(evidence.items[1]).toMatchObject({
      seq: 2,
      factType: "tool.call_observed",
      tool: "workspace.edit_file",
      paths: ["src/a.ts"],
    });
    expect(evidence.items[3]).toMatchObject({
      seq: 4,
      tool: "workspace.run_shell",
      command: "bun test",
    });
  });

  test("rejects a changed file without matching call, settlement, or path", () => {
    const evidence = projectCheckpointEvidenceV1(sourceEntries());
    const missingCall = validCheckpoint({
      changedFiles: [item("Changed src/a.ts", [3])],
    });
    expect(issueCodes(missingCall, evidence)).toContain(
      "changed_file_requires_successful_mutation",
    );

    const forgedPath = validCheckpoint({
      changedFiles: [item("Changed src/forged.ts", [2, 3])],
    });
    expect(issueCodes(forgedPath, evidence)).toContain(
      "changed_file_path_mismatch",
    );
  });

  test("rejects invented verification and omission of completed objective evidence", () => {
    const evidence = projectCheckpointEvidenceV1(sourceEntries());
    const wrongCommand = validCheckpoint({
      verification: [item("npm test completed successfully", [4, 5])],
    });
    expect(issueCodes(wrongCommand, evidence)).toContain(
      "verification_command_mismatch",
    );

    const omitted = validCheckpoint({ verification: [] });
    expect(issueCodes(omitted, evidence)).toContain(
      "verification_evidence_omitted",
    );
  });

  test("does not let completed model prose alone become a confirmed fact", () => {
    const entries = [
      ...sourceEntries(),
      {
        seq: 6,
        fact: {
          type: "model.settled",
          modelCallId: "model-2",
          turn: 2,
          status: "completed",
          hasToolCalls: false,
          hasVisibleOutput: true,
          finishReason: "stop",
        } satisfies InputFactV1,
      },
    ];
    const evidence = projectCheckpointEvidenceV1(entries);
    const checkpoint = validCheckpoint({
      confirmedFacts: [item("The issue is definitely fixed", [6])],
    });

    expect(issueCodes(checkpoint, evidence)).toContain(
      "confirmed_fact_requires_objective_evidence",
    );
  });
});

function issueCodes(
  checkpoint: TaskCheckpointV1,
  evidence: ReturnType<typeof projectCheckpointEvidenceV1>,
): readonly string[] {
  const result = verifyTaskCheckpointEvidenceV1(checkpoint, evidence);
  if (result.ok) return [];
  return result.issues.map((issue) => issue.code);
}
