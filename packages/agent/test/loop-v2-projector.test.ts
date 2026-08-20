import { describe, expect, test } from "bun:test";
import {
  LOOP_V2_SCHEMA_VERSION,
  type LoopV2Envelope,
  type LoopV2Event,
  createLoopV2Checkpoint,
  decisionStateHash,
  loopV2ReplayArtifactHash,
  parseLoopV2EventLog,
  replayLoopV2,
  resolveLoopKernelVersion,
} from "../src/loop-v2/index.js";

const RUN_ID = "loop-v2-replay";

function envelope(seq: number, event: LoopV2Event): LoopV2Envelope {
  return {
    schemaVersion: LOOP_V2_SCHEMA_VERSION,
    runId: RUN_ID,
    seq,
    ts: 1_000 + seq,
    event,
  };
}

function started(seq = 1): LoopV2Envelope {
  return envelope(seq, {
    type: "task.started",
    goal: "Fix the repository bug without changing unrelated behavior.",
    sourceHash: "goal-hash",
  });
}

describe("Loop Kernel v2 event projector", () => {
  test("R01 treats a new span in an already-read file as new evidence", () => {
    const result = replayLoopV2(RUN_ID, [
      started(),
      envelope(2, {
        type: "evidence.observed",
        observation: {
          kind: "read",
          path: "django/db/migrations/autodetector.py",
          start: 0,
          endExclusive: 130,
          contentHash: "file-r0",
          repositoryRevision: "r0",
        },
      }),
      envelope(3, {
        type: "evidence.observed",
        observation: {
          kind: "read",
          path: "django/db/migrations/autodetector.py",
          start: 1188,
          endExclusive: 1288,
          contentHash: "file-r0",
          repositoryRevision: "r0",
        },
      }),
    ]);

    expect(result.steps.map((step) => step.delta.meaningful)).toEqual([
      true,
      true,
      true,
    ]);
    const coverage = Object.values(result.state.readCoverage);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.intervals).toEqual([
      { start: 0, endExclusive: 130 },
      { start: 1188, endExclusive: 1288 },
    ]);
  });

  test("R02 successful exact repeated reads do not create progress", () => {
    const read = envelope(2, {
      type: "evidence.observed",
      observation: {
        kind: "read",
        path: "src/worker.ts",
        start: 10,
        endExclusive: 40,
        contentHash: "worker-r0",
        repositoryRevision: "r0",
      },
    });
    const result = replayLoopV2(RUN_ID, [
      started(),
      read,
      { ...read, seq: 3, ts: 1_003 },
      { ...read, seq: 4, ts: 1_004 },
    ]);

    expect(result.steps.map((step) => step.delta.meaningful)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    const evidence = Object.values(result.state.evidence);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.observationCount).toBe(3);
    expect(evidence[0]?.firstObservedSeq).toBe(2);
    expect(evidence[0]?.lastObservedSeq).toBe(4);
    expect(result.steps[1]?.decisionStateHash).toBe(
      result.steps[2]?.decisionStateHash,
    );
    expect(result.steps[2]?.decisionStateHash).toBe(
      result.steps[3]?.decisionStateHash,
    );
  });

  test("R03 the same search after a repository revision changes is new evidence", () => {
    const result = replayLoopV2(RUN_ID, [
      started(),
      envelope(2, {
        type: "evidence.observed",
        observation: {
          kind: "search",
          root: "src",
          query: "resolvePartial",
          options: { outputMode: "content" },
          resultHash: "matches-before",
          repositoryRevision: "r0",
        },
      }),
      envelope(3, {
        type: "evidence.observed",
        observation: {
          kind: "search",
          root: "src",
          query: "resolvePartial",
          options: { outputMode: "content" },
          resultHash: "matches-after",
          repositoryRevision: "r1",
        },
      }),
    ]);

    expect(result.steps[1]?.delta.meaningful).toBeTrue();
    expect(result.steps[2]?.delta.meaningful).toBeTrue();
    expect(Object.keys(result.state.evidence)).toHaveLength(2);
  });

  test("R13 compaction changes operational state without erasing decision state", () => {
    const before = replayLoopV2(RUN_ID, [
      started(),
      envelope(2, {
        type: "criterion.upserted",
        criterion: {
          id: "criterion-1",
          text: "Preserve the public return shape.",
          observable: "The public return shape is unchanged.",
          source: "user_explicit",
          authority: "agent",
          status: "pending",
          evidenceRefs: [],
          mutationRevision: 0,
        },
      }),
      envelope(3, {
        type: "hypothesis.upserted",
        hypothesis: {
          id: "hypothesis-1",
          statement: "The defect is limited to presentation.",
          status: "candidate",
          supports: [],
          contradicts: [],
          falsifier: "Compare public fields before and after the minimal fix.",
          proposedAtSeq: 3,
        },
      }),
      envelope(4, {
        type: "verification.recorded",
        verification: {
          id: "verify-r0",
          runner: "pytest",
          argv: ["pytest", "tests/test_public_api.py"],
          cwd: ".",
          scope: ["tests/test_public_api.py"],
          mutationRevision: 0,
          outcome: "passed",
          outputArtifactRef: "artifact://verify-r0",
          authoritative: true,
        },
      }),
    ]);
    const after = replayLoopV2(
      RUN_ID,
      [
        envelope(5, {
          type: "context.compacted",
          summarizedSeqThrough: 4,
          artifactRefs: ["artifact://old-tool-output"],
        }),
      ],
      createLoopV2Checkpoint(before.state),
    );

    expect(after.steps[0]?.delta.meaningful).toBeFalse();
    expect(decisionStateHash(after.state)).toBe(
      decisionStateHash(before.state),
    );
    expect(after.state.contextCompactions).toBe(1);
    expect(after.state.contextArtifactRefs).toEqual([
      "artifact://old-tool-output",
    ]);
  });

  test("R15 checkpoint resume is projection-identical to uninterrupted replay", () => {
    const events: LoopV2Envelope[] = [
      started(),
      envelope(2, {
        type: "evidence.observed",
        observation: {
          kind: "read",
          path: "src/index.ts",
          start: 0,
          endExclusive: 80,
          contentHash: "index-r0",
          repositoryRevision: "r0",
          artifactRef: "artifact://read-index",
        },
      }),
      envelope(3, {
        type: "mutation.recorded",
        mutation: {
          seq: 3,
          callId: "mutation-1",
          mutationRevision: 1,
          paths: ["src/index.ts"],
          beforeHashes: { "src/index.ts": "before-1" },
          afterHashes: { "src/index.ts": "after-1" },
          beforeContentRefs: {
            "src/index.ts": "artifact://content/index-before-1",
          },
          afterContentRefs: {
            "src/index.ts": "artifact://content/index-after-1",
          },
          patch: "diff --git a/src/index.ts b/src/index.ts",
          workspaceEffect: "product",
        },
      }),
      envelope(4, {
        type: "verification.recorded",
        verification: {
          id: "verify-r1",
          runner: "bun_test",
          argv: ["bun", "test", "test/index.test.ts"],
          cwd: ".",
          scope: ["test/index.test.ts"],
          mutationRevision: 1,
          outcome: "passed",
          outputArtifactRef: "artifact://verify-r1",
          authoritative: true,
        },
      }),
      envelope(5, {
        type: "candidate.proposed",
        candidate: {
          id: "candidate-r1",
          mutationRevision: 1,
          candidateInputHash: "candidate-input-r1",
          proposedAtSeq: 5,
        },
      }),
    ];
    const uninterrupted = replayLoopV2(RUN_ID, events);
    const prefix = replayLoopV2(RUN_ID, events.slice(0, 3));
    const resumed = replayLoopV2(
      RUN_ID,
      events.slice(3),
      createLoopV2Checkpoint(prefix.state),
    );

    expect(resumed.state).toEqual(uninterrupted.state);
    expect(resumed.decisionStateHash).toBe(uninterrupted.decisionStateHash);
    expect(resumed.projectionHash).toBe(uninterrupted.projectionHash);
    expect(loopV2ReplayArtifactHash(resumed)).not.toBeEmpty();
  });

  test("checkpoint corruption and duplicate sequence numbers fail closed", () => {
    const prefix = replayLoopV2(RUN_ID, [started()]);
    const checkpoint = createLoopV2Checkpoint(prefix.state);
    expect(() =>
      replayLoopV2(RUN_ID, [], {
        ...checkpoint,
        projectionHash: "tampered",
      }),
    ).toThrow("projection hash mismatch");
    expect(() => replayLoopV2(RUN_ID, [started()], checkpoint)).toThrow(
      "seq must be contiguous",
    );
    expect(() =>
      replayLoopV2(RUN_ID, [
        started(),
        envelope(3, {
          type: "context.compacted",
          summarizedSeqThrough: 1,
          artifactRefs: [],
        }),
      ]),
    ).toThrow("seq must be contiguous");
  });

  test("untrusted JSON and JSONL event logs are validated before replay", () => {
    const valid = [
      started(),
      envelope(2, {
        type: "context.compacted",
        summarizedSeqThrough: 1,
        artifactRefs: [],
      }),
    ];
    expect(parseLoopV2EventLog(JSON.stringify(valid))).toEqual(valid);
    expect(
      parseLoopV2EventLog(valid.map((item) => JSON.stringify(item)).join("\n")),
    ).toEqual(valid);
    expect(() =>
      parseLoopV2EventLog(JSON.stringify([{ ...started(), seq: 0 }])),
    ).toThrow("seq must be a safe integer");
    expect(() =>
      parseLoopV2EventLog(
        JSON.stringify([{ ...started(), event: { type: "invented" } }]),
      ),
    ).toThrow("Unsupported loop v2 event type");
    expect(() =>
      parseLoopV2EventLog(
        JSON.stringify([
          started(),
          envelope(2, {
            type: "readiness.evaluated",
            candidateId: "candidate-1",
            mutationRevision: 0,
            result: {
              kind: "repair_required",
              requirement: {
                kind: "direct_verification",
                revision: 0,
                runnerFamily: "any",
                scope: "not-an-array" as unknown as string[],
              },
            },
          }),
        ]),
      ),
    ).toThrow("event.result.requirement.scope must be an array");
    expect(
      parseLoopV2EventLog(
        JSON.stringify([
          envelope(1, {
            type: "verification_probe.recorded",
            candidateId: "candidate-1",
            mutationRevision: 1,
            probeKey: "probe-1",
            outcome: "inconclusive",
            semanticReviewNotRequired: true,
            externalVerification: "pending",
          }),
        ]),
      ),
    ).toHaveLength(1);
    expect(() =>
      parseLoopV2EventLog(
        JSON.stringify([
          envelope(1, {
            type: "verification_probe.recorded",
            candidateId: "candidate-1",
            mutationRevision: 1,
            probeKey: "probe-1",
            outcome: "invented" as "clear",
            semanticReviewNotRequired: true,
            externalVerification: "pending",
          }),
        ]),
      ),
    ).toThrow("event.outcome must be one of");
  });

  test("kernel version is explicit and defaults to v1", () => {
    expect(resolveLoopKernelVersion({})).toBe("v1");
    expect(
      resolveLoopKernelVersion({ PAW_LOOP_KERNEL_VERSION: "v2-shadow" }),
    ).toBe("v2-shadow");
    expect(() =>
      resolveLoopKernelVersion({ PAW_LOOP_KERNEL_VERSION: "benchmark-auto" }),
    ).toThrow("Unsupported PAW_LOOP_KERNEL_VERSION");
  });
});
