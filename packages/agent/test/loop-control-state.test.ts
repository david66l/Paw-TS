import { describe, expect, test } from "bun:test";
import { stripLegacyContextProjectionsV1 } from "../src/context-assembler.js";
import { advanceRepeatToolReminder } from "../src/lifecycle/repeat-tool-reminder.js";
import {
  formatRecoveryHints,
  recoveryHintForToolResult,
} from "../src/lifecycle/tool-recovery.js";
import { checkVerification } from "../src/lifecycle/verification-gate.js";
import {
  checkpointLoopControlV1,
  consumeSelectedPendingControlV1,
  parseLoopControlCheckpointV1,
  resetLoopControlForRewindV1,
  restoreLoopControlFlagsV1,
} from "../src/loop-control-state.js";
import { TaskStateManager } from "../src/task-state.js";

const READINESS_KEY = "a".repeat(64);

describe("Loop control checkpoint v1", () => {
  test("consumes pending only when the exact candidate won selection", () => {
    const pending = {
      kind: "tool_guidance" as const,
      topic: "repeat_tool" as const,
      text: "change the call",
    };
    const flags = {
      autoContinueNudges: 0,
      lastTurnHadToolCall: true,
      hasEverUsedTools: true,
      pendingControl: pending,
    };
    expect(
      consumeSelectedPendingControlV1(flags, {
        kind: "test_warden",
        text: "tests failed",
      }).pendingControl,
    ).toBe(pending);
    expect(
      consumeSelectedPendingControlV1(flags, { ...pending }).pendingControl,
    ).toBe(pending);
    expect(consumeSelectedPendingControlV1(flags, pending)).not.toHaveProperty(
      "pendingControl",
    );
  });

  test("round-trips bounded tool-loop state and one pending guidance", () => {
    const checkpoint = checkpointLoopControlV1({
      autoContinueNudges: 0,
      lastTurnHadToolCall: true,
      hasEverUsedTools: true,
      failureSignatures: ["workspace.edit_file|12345678|abcdef12|87654321"],
      idleFuseTrips: 1,
      repeatTool: {
        key: "a".repeat(64),
        tool: "workspace.read_file",
        count: 2,
      },
      codingPhase: {
        navigationCalls: 9,
        successfulEdits: 0,
        postEditNavigationCalls: 0,
        verificationCalls: 0,
        locateNudged: false,
        verifyNudged: false,
      },
      codingPhaseViolationTurns: 1,
      pendingControl: {
        kind: "tool_guidance",
        topic: "tool_recovery",
        text: "recover once",
      },
    });
    expect(parseLoopControlCheckpointV1(checkpoint)).toEqual(checkpoint);
    expect(
      restoreLoopControlFlagsV1({
        runId: "tool-loop",
        startTurn: 2,
        value: checkpoint,
        legacyMessages: [],
      }),
    ).toMatchObject({
      failureSignatures: ["workspace.edit_file|12345678|abcdef12|87654321"],
      idleFuseTrips: 1,
      repeatTool: { count: 2 },
      codingPhase: { navigationCalls: 9 },
      codingPhaseViolationTurns: 1,
      pendingControl: {
        kind: "tool_guidance",
        topic: "tool_recovery",
      },
    });

    for (const toolLoop of [
      { failureSignatures: Array.from({ length: 9 }, () => "x") },
      { repeatTool: { key: "bad", tool: "read", count: 1 } },
      {
        repeatTool: { key: "a".repeat(64), tool: "read", count: 0 },
      },
      {
        codingPhase: {
          navigationCalls: -1,
          successfulEdits: 0,
          postEditNavigationCalls: 0,
          verificationCalls: 0,
          locateNudged: false,
          verifyNudged: false,
        },
      },
      { codingPhaseViolationTurns: 3 },
    ]) {
      expect(
        parseLoopControlCheckpointV1({
          schemaVersion: "paw.loop-control.v1",
          toolLoop,
        }),
      ).toBeUndefined();
    }
    expect(
      parseLoopControlCheckpointV1({
        schemaVersion: "paw.loop-control.v1",
        pendingControl: {
          kind: "tool_guidance",
          topic: "unknown",
          text: "bad",
        },
      }),
    ).toBeUndefined();
  });

  test("migrates only exact unconsumed legacy tool guidance", () => {
    const idle =
      "[Recovery:idle_fuse] The same tool failure repeated. Stop retrying identically — re-read current state, make a smaller exact edit, try a different test command, or output final_answer / abort with an honest status.";
    let repeated: ReturnType<typeof advanceRepeatToolReminder> | undefined;
    const repeatedCall = {
      type: "tool_call" as const,
      tool: "workspace.read_file",
      args: { path: `a-${"x".repeat(700)}.ts` },
    };
    for (let count = 1; count <= 8; count += 1) {
      repeated = advanceRepeatToolReminder(repeated?.state, [repeatedCall]);
    }
    const realTruncatedRepeat = repeated?.reminders.at(-1);
    expect(realTruncatedRepeat).toBeTruthy();
    let mcpRepeated: ReturnType<typeof advanceRepeatToolReminder> | undefined;
    for (let count = 1; count <= 5; count += 1) {
      mcpRepeated = advanceRepeatToolReminder(mcpRepeated?.state, [
        {
          type: "tool_call",
          tool: "mcp:github/search_code",
          args: { q: "x" },
        },
      ]);
    }
    const realMcpRepeat = mcpRepeated?.reminders.at(-1);
    const mcpRecovery = recoveryHintForToolResult("mcp:github/search_code", {
      ok: false,
      summary: "boom",
      payload: { code: "E_FAIL" },
    });
    const embeddedRecovery = recoveryHintForToolResult(
      "mcp:github/search_code",
      {
        ok: false,
        summary: "boom\n[Recovery] repository output, not a host branch",
        payload: { code: "E_FAIL" },
      },
    );
    expect(realMcpRepeat).toBeTruthy();
    expect(mcpRecovery).toBeTruthy();
    expect(embeddedRecovery).toBeTruthy();
    const fixtures = [
      "[Recovery] workspace.run_shell was blocked by policy. Use a safer workspace command, or ensure AutonomyProfile allows it. Do not treat this as a fatal crash.",
      "[Recovery] edit_file failed to match old_string. Re-read the file for exact current text, add more surrounding context for uniqueness, or set replace_all=true if every match should change.",
      "[Recovery] workspace.run_shell timed out or is retryable. Retry with a tighter scope or longer timeout_sec; avoid repeating the identical failing command blindly.",
      "[Recovery] workspace.edit_file was denied/blocked. Choose an available read-only probe or a smaller exact edit.",
      "[Recovery] workspace.run_shell failed (line one\nline two). Inspect the error, re-read relevant files, then try a different tool or smaller change.",
      "[Recovery] edit_file failed to match old_string. Re-read the file for exact current text, add more surrounding context for uniqueness, or set replace_all=true if every match should change.\n[Recovery] workspace.run_shell timed out or is retryable. Retry with a tighter scope or longer timeout_sec; avoid repeating the identical failing command blindly.",
      `[Recovery] workspace.edit_file failed (no match). Inspect the error, re-read relevant files, then try a different tool or smaller change.\n${idle}`,
      "[Loop reminder] You have made the exact same tool call with identical arguments three consecutive times. Re-read the latest result and use materially different arguments or a different approach if more evidence is needed. The call was not blocked.",
      '[Loop reminder] Exact tool call repeated 5 consecutive times:\n- tool: workspace.read_file\n- arguments: {"path":"a.ts"}\nThe call was not blocked. Inspect the latest result, then change the action or finish if the task is complete.',
      realTruncatedRepeat ?? "",
      realMcpRepeat ?? "",
      formatRecoveryHints(mcpRecovery ? [mcpRecovery] : []) ?? "",
      formatRecoveryHints(embeddedRecovery ? [embeddedRecovery] : []) ?? "",
      "[CodingPhase:verify] A source edit now exists. Preserve the remaining budget: run the narrowest relevant test next, fix exact failures, then final_answer after a passing verification.",
      "[CodingPhase:locate] 10 repository navigation calls have produced no source edit. Consolidate the evidence into one likely cause and make a minimal candidate edit before the hard limit at 14.",
      "[CodingPhase:locate] 14 repository navigation calls have produced no source edit. Consolidate the evidence into one likely cause and make a minimal candidate edit before the hard limit at 14.",
    ];
    for (const marker of fixtures) {
      const restored = restoreLoopControlFlagsV1({
        runId: "legacy-tool",
        startTurn: 1,
        value: undefined,
        legacyMessages: [
          { role: "assistant", content: "tool call" },
          { role: "user", content: marker },
        ],
      });
      expect(restored.pendingControl).toMatchObject({
        kind: "tool_guidance",
        text: marker,
      });
      expect(
        stripLegacyContextProjectionsV1([
          { role: "assistant", content: "tool call" },
          { role: "user", content: marker },
        ]).map((message) => message.content),
      ).toEqual(["tool call"]);
      expect(
        restoreLoopControlFlagsV1({
          runId: "legacy-tool",
          startTurn: 1,
          value: undefined,
          legacyMessages: [
            { role: "user", content: marker },
            { role: "assistant", content: "already consumed" },
          ],
        }).pendingControl,
      ).toBeUndefined();
    }

    for (const collision of [
      "[Recovery] please explain this title",
      `${fixtures[0]} extra`,
      "[Loop reminder] Exact tool call repeated 5 consecutive times:\n- tool: explain this request\n- arguments: please keep my text\nThe call was not blocked. Inspect the latest result, then change the action or finish if the task is complete.",
      '[Loop reminder] Exact tool call repeated 5 consecutive times:\n- tool: workspace.read_file\n- arguments: {"z":1,"a":2}\nThe call was not blocked. Inspect the latest result, then change the action or finish if the task is complete.',
      "[Loop reminder] Exact tool call repeated 4 consecutive times:\n- tool: workspace.read_file\n- arguments: {}\nThe call was not blocked. Inspect the latest result, then change the action or finish if the task is complete.",
      "[CodingPhase:locate] 9 repository navigation calls have produced no source edit. Consolidate the evidence into one likely cause and make a minimal candidate edit before the hard limit at 14.",
      "[CodingPhase:locate] 15 repository navigation calls have produced no source edit. Consolidate the evidence into one likely cause and make a minimal candidate edit before the hard limit at 14.",
    ]) {
      expect(
        stripLegacyContextProjectionsV1([{ role: "user", content: collision }]),
      ).toHaveLength(1);
    }
    const snapshotWins = restoreLoopControlFlagsV1({
      runId: "legacy-tool",
      startTurn: 1,
      value: {
        schemaVersion: "paw.loop-control.v1",
        pendingControl: { kind: "protocol_recovery", text: "retry protocol" },
      },
      legacyMessages: [{ role: "user", content: fixtures[0] ?? "" }],
    });
    expect(snapshotWins.pendingControl).toEqual({
      kind: "protocol_recovery",
      text: "retry protocol",
    });

    const priorityRestored = restoreLoopControlFlagsV1({
      runId: "legacy-tool-priority",
      startTurn: 1,
      value: undefined,
      legacyMessages: [
        { role: "assistant", content: "tool call" },
        { role: "user", content: `${fixtures[4]}\n${idle}` },
        { role: "user", content: fixtures[8] ?? "" },
      ],
    });
    expect(priorityRestored.pendingControl).toMatchObject({
      kind: "tool_guidance",
      topic: "idle_fuse",
    });
    const recoveryPriority = restoreLoopControlFlagsV1({
      runId: "legacy-tool-recovery-priority",
      startTurn: 1,
      value: undefined,
      legacyMessages: [
        { role: "assistant", content: "tool call" },
        { role: "user", content: fixtures[0] ?? "" },
        { role: "user", content: fixtures[8] ?? "" },
      ],
    });
    expect(recoveryPriority.pendingControl).toMatchObject({
      kind: "tool_guidance",
      topic: "tool_recovery",
    });

    const newToolLoopWins = restoreLoopControlFlagsV1({
      runId: "legacy-tool-new-wins",
      startTurn: 1,
      value: {
        schemaVersion: "paw.loop-control.v1",
        toolLoop: {
          repeatTool: {
            key: "b".repeat(64),
            tool: "workspace.read_file",
            count: 4,
          },
        },
      },
      legacyMessages: [{ role: "user", content: fixtures[7] ?? "" }],
    });
    expect(newToolLoopWins).not.toHaveProperty("pendingControl");
  });

  test("round-trips bounded late-guidance delivery receipts", () => {
    const checkpoint = checkpointLoopControlV1({
      autoContinueNudges: 0,
      lastTurnHadToolCall: false,
      hasEverUsedTools: false,
      _budgetGuardWarned: true,
      _implementationWarned: true,
      _convergenceEvidenceKey: "r2:passed:current",
      _maxStepsWarned: true,
    });

    expect(parseLoopControlCheckpointV1(checkpoint)).toEqual(checkpoint);
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-guidance",
        startTurn: 0,
        value: checkpoint,
        legacyMessages: [],
      }),
    ).toMatchObject({
      _budgetGuardWarned: true,
      _implementationWarned: true,
      _convergenceEvidenceKey: "r2:passed:current",
      _maxStepsWarned: true,
    });
    expect(
      parseLoopControlCheckpointV1({
        schemaVersion: "paw.loop-control.v1",
        lateGuidance: { convergenceEvidenceKey: "r2:unknown:current" },
      }),
    ).toBeUndefined();
    expect(resetLoopControlForRewindV1("run-guidance", 1)).not.toHaveProperty(
      "lateGuidance",
    );
  });

  test("round-trips provider cursor, readiness budget, and one pending control", () => {
    const checkpoint = checkpointLoopControlV1({
      autoContinueNudges: 0,
      lastTurnHadToolCall: false,
      hasEverUsedTools: true,
      formatErrorNudges: 2,
      noActionNudges: 3,
      providerTerminal: {
        runId: "run-1",
        lastTurn: 3,
        pendingProtocolIssue: "empty_response",
      },
      loopV2ReadinessFeedbackKey: READINESS_KEY,
      loopV2ReadinessNudges: 1,
      pendingControl: {
        kind: "readiness",
        text: "repair the missing verification",
      },
    });

    expect(parseLoopControlCheckpointV1(checkpoint)).toEqual(checkpoint);
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 3,
        value: checkpoint,
        legacyMessages: [],
      }),
    ).toEqual({
      providerTerminal: {
        runId: "run-1",
        lastTurn: 3,
        pendingProtocolIssue: "empty_response",
      },
      loopV2ReadinessFeedbackKey: READINESS_KEY,
      loopV2ReadinessNudges: 1,
      formatErrorNudges: 2,
      noActionNudges: 3,
      hasEverUsedTools: true,
      pendingControl: {
        kind: "readiness",
        text: "repair the missing verification",
      },
    });
  });

  test("rejects corrupt untyped JSON instead of trusting persisted control", () => {
    for (const value of [
      null,
      {},
      { schemaVersion: "paw.loop-control.v1" },
      {
        schemaVersion: "paw.loop-control.v1",
        providerTerminal: { runId: "run-1", lastTurn: -1 },
      },
      {
        schemaVersion: "paw.loop-control.v1",
        readiness: { key: "not-a-hash", nudges: 1 },
      },
      {
        schemaVersion: "paw.loop-control.v1",
        pendingControl: { kind: "readiness", text: "" },
      },
      {
        schemaVersion: "paw.loop-control.v1",
        protocolRecovery: { formatErrorNudges: 0 },
      },
      {
        schemaVersion: "paw.loop-control.v1",
        protocolRecovery: { noActionNudges: 10_001 },
      },
      {
        schemaVersion: "paw.loop-control.v1",
        protocolRecovery: { hasEverUsedTools: false },
      },
    ]) {
      expect(parseLoopControlCheckpointV1(value)).toBeUndefined();
    }
    expect(() =>
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 0,
        value: { schemaVersion: "paw.loop-control.v1" },
        legacyMessages: [],
      }),
    ).toThrow("Invalid loop-control checkpoint");
    expect(() =>
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 2,
        value: {
          schemaVersion: "paw.loop-control.v1",
          providerTerminal: { runId: "run-1", lastTurn: 1 },
        },
        legacyMessages: [],
      }),
    ).toThrow("does not match AppState");
  });

  test("uses a legacy readiness marker only when no v1 checkpoint exists", () => {
    const legacyMessages = [
      {
        role: "user" as const,
        content: `[LoopV2Readiness:needs_work key=${READINESS_KEY}]\nrepair`,
      },
    ];
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 0,
        value: undefined,
        legacyMessages,
      }),
    ).toEqual({
      loopV2ReadinessFeedbackKey: READINESS_KEY,
      loopV2ReadinessNudges: 1,
    });

    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 0,
        value: {
          schemaVersion: "paw.loop-control.v1",
          pendingControl: {
            kind: "protocol_recovery",
            text: "retry once",
          },
        },
        legacyMessages,
      }),
    ).toEqual({
      pendingControl: {
        kind: "protocol_recovery",
        text: "retry once",
      },
    });

    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 0,
        value: resetLoopControlForRewindV1("run-1", 0),
        legacyMessages,
      }),
    ).toEqual({
      providerTerminal: { runId: "run-1", lastTurn: 0 },
    });
  });

  test("migrates only an unconsumed exact legacy protocol recovery tail", () => {
    const marker =
      '[You stopped without a final_answer action. If you have completed the task, output: {"action":"final_answer","summary":"<your complete findings here>"}. If not done, continue — call the next tool or take the next action.]';
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 1,
        value: undefined,
        legacyMessages: [
          { role: "user", content: "goal" },
          { role: "user", content: marker },
        ],
        allowLegacyReadiness: false,
      }),
    ).toEqual({
      pendingControl: { kind: "protocol_recovery", text: marker },
      noActionNudges: 1,
      hasEverUsedTools: true,
    });

    for (const legacyMessages of [
      [
        { role: "user" as const, content: marker },
        { role: "assistant" as const, content: "already consumed" },
      ],
      [
        {
          role: "user" as const,
          content:
            "[You stopped without a final_answer action.] explain this label",
        },
      ],
    ]) {
      expect(
        restoreLoopControlFlagsV1({
          runId: "run-1",
          startTurn: 1,
          value: undefined,
          legacyMessages,
          allowLegacyReadiness: false,
        }),
      ).toEqual({});
    }
  });

  test("round-trips bounded completion gate counters and candidate identity", () => {
    const fingerprint = "b".repeat(64);
    const checkpoint = checkpointLoopControlV1({
      autoContinueNudges: 3,
      verifyNudges: 2,
      acceptanceNudges: 1,
      candidateReviewRevision: 4,
      candidateReviewNudges: 2,
      candidateReviewSummaryFingerprint: fingerprint,
      lastTurnHadToolCall: false,
      hasEverUsedTools: true,
      pendingControl: {
        kind: "completion_gate",
        gate: "candidate_review",
        text: "revise the unsupported report",
      },
    });
    expect(parseLoopControlCheckpointV1(checkpoint)).toEqual(checkpoint);
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 2,
        value: checkpoint,
        legacyMessages: [],
      }),
    ).toMatchObject({
      autoContinueNudges: 3,
      verifyNudges: 2,
      acceptanceNudges: 1,
      candidateReviewRevision: 4,
      candidateReviewNudges: 2,
      candidateReviewSummaryFingerprint: fingerprint,
      pendingControl: {
        kind: "completion_gate",
        gate: "candidate_review",
      },
    });

    for (const completionGates of [
      { autoContinueNudges: 4 },
      { verifyNudges: 3 },
      { acceptanceNudges: 0 },
      { candidateReview: { revision: -1, nudges: 1 } },
      { candidateReview: { revision: 1, nudges: 3 } },
      {
        candidateReview: {
          revision: 1,
          nudges: 1,
          summaryFingerprint: "not-a-hash",
        },
      },
    ]) {
      expect(
        parseLoopControlCheckpointV1({
          schemaVersion: "paw.loop-control.v1",
          completionGates,
        }),
      ).toBeUndefined();
    }
    expect(
      parseLoopControlCheckpointV1({
        schemaVersion: "paw.loop-control.v1",
        pendingControl: {
          kind: "completion_gate",
          gate: "unknown",
          text: "bad",
        },
      }),
    ).toBeUndefined();
  });

  test("migrates eight exact legacy completion-gate tails and preserves collisions", () => {
    const hash = "c".repeat(64);
    const fixtures = [
      {
        gate: "managed_jobs",
        marker:
          "[Managed jobs are unfinished: 1 running, 0 stopping, 0 awaiting commit. Wait for the host to settle and commit every terminal result before outputting final_answer.]",
      },
      {
        gate: "pending_work",
        marker:
          "[You have pending work: 2 plan item(s), 1 todo(s). Continue from where you left off — do not summarize or apologize, just take the next action.]",
      },
      {
        gate: "verification",
        marker:
          "[VerificationGate] This task requires file changes ([require_mutation]) but none were recorded. Use an available workspace mutation tool, then continue — do not final_answer yet.",
      },
      {
        gate: "repair_obligation",
        marker:
          "[LoopControl:repair_required id=repair-0123456789abcdef] Run a direct pytest verification for revision 2, covering src/a.ts. Prose, repeated reads, unrelated tools, or another final_answer do not satisfy this durable obligation.",
      },
      {
        gate: "semantic_review",
        marker: `[LoopV2SemanticReview:fail key=${hash}]\nIndependent semantic review returned fail for the persisted candidate.\n1. blocking invariant=x: observed Risk: broken\nFix the bound issue, produce a real source mutation, re-run relevant verification, and then submit a new candidate. Resubmitting identical code is pointless: this review is bound to the exact candidate, and an identical resubmission replays the same verdict. Only a real code change produces a new candidate and a fresh review.`,
      },
      {
        gate: "verification_probe",
        marker: `[LoopV2Probe:fail key=probe:${hash}]\nAn adversarial verification probe executed against the current candidate diff and FAILED. The candidate is not certified.\nFailed probe(s):\n1. command: test\n   output: failed\nFix the code so the failing behavior is corrected, then propose a new final answer. Resubmitting the same code is pointless: the failed probe is bound to this exact candidate, so an identical resubmission will replay the same failure. Only a real code change produces a new candidate and a fresh probe.`,
      },
      {
        gate: "candidate_review",
        marker:
          "[IndependentReview:FAIL r2] wrong behavior\nFix the concrete issue, re-run relevant verification, inspect the new diff, and then try final_answer again. The semantic reviewer will run again only after a real source mutation.",
      },
      {
        gate: "acceptance",
        marker:
          "[AcceptanceGate] Before final_answer, resolve acceptance-001 [pending] output is correct. Verify each observable condition against the current code revision, then use acceptance_update with concrete evidence. Do not mark an item satisfied from memory or intention.",
      },
    ] as const;

    for (const fixture of fixtures) {
      const restored = restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 1,
        value: undefined,
        legacyMessages: [
          { role: "user", content: "goal" },
          { role: "user", content: fixture.marker },
        ],
      });
      expect(restored.pendingControl).toMatchObject({
        kind: "completion_gate",
        gate: fixture.gate,
        text: fixture.marker,
      });
      expect(
        stripLegacyContextProjectionsV1([
          { role: "user", content: fixture.marker },
          { role: "user", content: `${fixture.marker} please explain` },
        ]),
      ).toEqual([
        { role: "user", content: `${fixture.marker} please explain` },
      ]);
      expect(
        restoreLoopControlFlagsV1({
          runId: "run-1",
          startTurn: 1,
          value: undefined,
          legacyMessages: [
            { role: "user", content: fixture.marker },
            { role: "assistant", content: "already consumed" },
          ],
        }),
      ).toEqual({});
    }
  });

  test("preserves near-collision completion prose and restores report identity only from TaskState", () => {
    const hash = "d".repeat(64);
    const collisions = [
      "[VerificationGate] The current edit introduced 1 syntax diagnostic error(s) please explain what counts as required test verification.",
      "[VerificationGate] The last passing verification predates the latest file change — please explain this label before final_answer.",
      `[LoopV2SemanticReview:fail key=${hash}]\nIndependent semantic review returned fail for the persisted candidate.\nplease explain why Only a real code change produces a new candidate and a fresh review.`,
    ];
    for (const content of collisions) {
      const messages = [{ role: "user" as const, content }];
      expect(stripLegacyContextProjectionsV1(messages)).toEqual(messages);
      expect(
        restoreLoopControlFlagsV1({
          runId: "run-1",
          startTurn: 1,
          value: undefined,
          legacyMessages: messages,
        }),
      ).toEqual({});
    }

    const fingerprint = "e".repeat(64);
    const reportMarker =
      "[IndependentReview:REPORT_GROUNDING_FAIL r4] claims exceed evidence\nRevise only the proposed final summary so every verification, baseline, and pass/fail claim matches the host-recorded evidence. Do not mutate source merely to satisfy this reporting gate. A materially revised summary will be reviewed again on the same source revision.";
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 1,
        value: undefined,
        legacyMessages: [{ role: "user", content: reportMarker }],
        legacyCandidateReview: {
          mutationRevision: 4,
          summaryFingerprint: fingerprint,
        },
      }),
    ).toMatchObject({
      pendingControl: {
        kind: "completion_gate",
        gate: "candidate_review",
      },
      candidateReviewRevision: 4,
      candidateReviewNudges: 1,
      candidateReviewSummaryFingerprint: fingerprint,
    });
  });

  test("merges an unconsumed legacy completion tail into older v1 and v2 checkpoints", () => {
    const marker =
      "[You have pending work: 1 plan item(s). Continue from where you left off — do not summarize or apologize, just take the next action.]";
    const legacyMessages = [{ role: "user" as const, content: marker }];
    const v1 = restoreLoopControlFlagsV1({
      runId: "run-1",
      startTurn: 2,
      value: {
        schemaVersion: "paw.loop-control.v1",
        protocolRecovery: { hasEverUsedTools: true },
      },
      legacyMessages,
    });
    expect(v1).toMatchObject({
      hasEverUsedTools: true,
      autoContinueNudges: 1,
      pendingControl: { kind: "completion_gate", gate: "pending_work" },
    });

    const v2 = restoreLoopControlFlagsV1({
      runId: "run-1",
      startTurn: 2,
      value: {
        schemaVersion: "paw.loop-control.v1",
        providerTerminal: { runId: "run-1", lastTurn: 2 },
      },
      legacyMessages,
    });
    expect(v2).toMatchObject({
      providerTerminal: { runId: "run-1", lastTurn: 2 },
      autoContinueNudges: 1,
      pendingControl: { kind: "completion_gate", gate: "pending_work" },
    });

    const newSnapshotWins = restoreLoopControlFlagsV1({
      runId: "run-1",
      startTurn: 2,
      value: {
        schemaVersion: "paw.loop-control.v1",
        providerTerminal: { runId: "run-1", lastTurn: 2 },
        pendingControl: { kind: "protocol_recovery", text: "retry" },
      },
      legacyMessages,
    });
    expect(newSnapshotWins.pendingControl).toEqual({
      kind: "protocol_recovery",
      text: "retry",
    });
    expect(newSnapshotWins.autoContinueNudges).toBeUndefined();
  });

  test("round-trips a producer-generated multiline verification marker", () => {
    const state = new TaskStateManager("fix the implementation");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.write_file",
        args: { path: "src/a.ts", content: "changed" },
      },
      {
        ok: true,
        summary: "write_file: src/a.ts",
        payload: { path: "src/a.ts", changed: true, linesAdded: 1 },
      },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "npm test\necho later" },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: { stdout: "FAIL" },
      },
    );
    const verification = checkVerification(state.snapshot());
    expect(verification.ok).toBe(false);
    if (verification.ok) throw new Error("expected verification feedback");
    const marker = `[VerificationGate] ${verification.nudge}`;
    expect(marker).toContain("npm test\necho later");
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 1,
        value: undefined,
        legacyMessages: [{ role: "user", content: marker }],
      }).pendingControl,
    ).toMatchObject({
      kind: "completion_gate",
      gate: "verification",
      text: marker,
    });
    expect(
      stripLegacyContextProjectionsV1([{ role: "user", content: marker }]),
    ).toEqual([]);
  });

  test("round-trips a producer-generated multiline diagnostic marker", () => {
    const state = new TaskStateManager("fix the syntax error");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.write_file",
        args: { path: "src/a.ts", content: "broken" },
      },
      {
        ok: true,
        summary: "write_file: src/a.ts",
        payload: {
          path: "src/a.ts",
          changed: true,
          linesAdded: 1,
          diagnostics: {
            schemaVersion: "paw.post-edit-diagnostics.v1",
            status: "issues",
            issueCount: 1,
            files: [
              {
                path: "src/a.ts",
                status: "issues",
                issues: [{ message: "Unexpected token\nat line 2" }],
              },
            ],
          },
        },
      },
    );
    const verification = checkVerification(state.snapshot());
    expect(verification.ok).toBe(false);
    if (verification.ok) throw new Error("expected verification feedback");
    const marker = `[VerificationGate] ${verification.nudge}`;
    expect(marker).toContain("Unexpected token\nat line 2");
    expect(
      restoreLoopControlFlagsV1({
        runId: "run-1",
        startTurn: 1,
        value: undefined,
        legacyMessages: [{ role: "user", content: marker }],
      }).pendingControl,
    ).toMatchObject({
      kind: "completion_gate",
      gate: "verification",
      text: marker,
    });
    expect(
      stripLegacyContextProjectionsV1([{ role: "user", content: marker }]),
    ).toEqual([]);
  });
});
