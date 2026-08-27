import { describe, expect, test } from "bun:test";

import {
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  TASK_CHECKPOINT_SCHEMA_VERSION_V1,
  isTaskCheckpointV1,
  parseRunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
  parseTaskCheckpointV1,
} from "../src/index.js";

function checkpoint(sourceSeqs: readonly number[] = [1, 2]) {
  return {
    schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION_V1,
    goal: { statement: "修复当前回归", sourceSeqs: [1] },
    confirmedFacts: [{ statement: "失败由边界条件触发", sourceSeqs }],
    currentHypotheses: [],
    ruledOut: [],
    changedFiles: [],
    verification: [],
    unresolved: [],
    nextAction: { statement: "补最小反例", sourceSeqs: [2] },
  };
}

function factEnvelope(fact: unknown, seq: number): unknown {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq,
    ts: 1_750_000_000_000 + seq,
    record: { kind: "input_fact", fact },
  };
}

function promoted(seq: number): unknown {
  return factEnvelope(
    {
      type: "input.promoted",
      inputId: `input-${seq}`,
      delivery: "initial",
      content: `input ${seq}`,
      contentHash: `input-hash-${seq}`,
    },
    seq,
  );
}

function recordedCheckpoint(
  seq = 3,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return factEnvelope(
    {
      type: "context.checkpoint_recorded",
      checkpointId: "checkpoint-1",
      policyVersion: "checkpoint-policy-v1",
      sourceFromSeq: 1,
      sourceThroughSeq: 2,
      sourceInputHash: "source-input-hash",
      checkpoint: {
        kind: "inline",
        value: checkpoint(),
        hash: "checkpoint-hash",
      },
      ...overrides,
    },
    seq,
  );
}

function distillationClaim(seq = 3): unknown {
  return factEnvelope(
    {
      type: "context.checkpoint_distillation_claimed",
      claimId: "checkpoint-claim-1",
      checkpointId: "checkpoint-distilled-1",
      boundary: "after_model_turn_without_tool_calls",
      policyVersion: "checkpoint-policy-v1",
      sourceFromSeq: 1,
      sourceThroughSeq: 2,
      sourceInputHash: "source-input-hash",
    },
    seq,
  );
}

function distillationSettlement(
  seq = 4,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return factEnvelope(
    {
      type: "context.checkpoint_distillation_settled",
      claimId: "checkpoint-claim-1",
      status: "completed",
      checkpoint: {
        kind: "inline",
        value: checkpoint(),
        hash: "checkpoint-hash",
      },
      ...overrides,
    },
    seq,
  );
}

function distilledCheckpoint(seq = 5): unknown {
  return factEnvelope(
    {
      type: "context.checkpoint_recorded",
      checkpointId: "checkpoint-distilled-1",
      distillationClaimId: "checkpoint-claim-1",
      policyVersion: "checkpoint-policy-v1",
      sourceFromSeq: 1,
      sourceThroughSeq: 2,
      sourceInputHash: "source-input-hash",
      checkpoint: {
        kind: "inline",
        value: checkpoint(),
        hash: "checkpoint-hash",
      },
    },
    seq,
  );
}

describe("task checkpoint v1", () => {
  test("accepts a structured checkpoint and its canonical journal lifecycle", () => {
    const value = checkpoint();
    expect(parseTaskCheckpointV1(value) as unknown).toBe(value);
    expect(isTaskCheckpointV1(value)).toBe(true);

    const prefix = [promoted(1), promoted(2), recordedCheckpoint()];
    expect(parseRunJournalPrefixV1(prefix)).toHaveLength(3);
  });

  test("requires sourced, non-empty, strictly ordered evidence", () => {
    expect(
      isTaskCheckpointV1({
        schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION_V1,
        confirmedFacts: [],
        currentHypotheses: [],
        ruledOut: [],
        changedFiles: [],
        verification: [],
        unresolved: [],
      }),
    ).toBe(false);

    expect(() => parseTaskCheckpointV1(checkpoint([2, 2]))).toThrow(
      "strictly increasing",
    );
    expect(() =>
      parseTaskCheckpointV1({ ...checkpoint(), summary: "unversioned" }),
    ).toThrow("is not allowed");
  });

  test("rejects evidence outside the declared source range", () => {
    expect(() =>
      parseRunJournalEnvelopeV1(
        recordedCheckpoint(3, {
          checkpoint: {
            kind: "inline",
            value: checkpoint([1, 3]),
            hash: "checkpoint-hash",
          },
        }),
      ),
    ).toThrow("outside its covered range");
    expect(() =>
      parseRunJournalEnvelopeV1(
        recordedCheckpoint(3, {
          sourceFromSeq: 2,
          sourceThroughSeq: 1,
        }),
      ),
    ).toThrow("source range is invalid");
  });

  test("rejects line-breaking metadata before it can reach a model prompt", () => {
    expect(() =>
      parseRunJournalEnvelopeV1(
        recordedCheckpoint(3, {
          policyVersion: "v1\nINJECTED=system override",
        }),
      ),
    ).toThrow("stable non-empty id");
    expect(() =>
      parseRunJournalEnvelopeV1(
        recordedCheckpoint(3, {
          checkpoint: {
            kind: "inline",
            value: checkpoint(),
            hash: "hash\nINJECTED=system override",
          },
        }),
      ),
    ).toThrow("single-line");
  });

  test("requires an explicit monotonic supersession chain", () => {
    const first = recordedCheckpoint();
    const second = factEnvelope(
      {
        type: "context.checkpoint_recorded",
        checkpointId: "checkpoint-2",
        supersedesCheckpointId: "checkpoint-1",
        policyVersion: "checkpoint-policy-v1",
        sourceFromSeq: 1,
        sourceThroughSeq: 4,
        sourceInputHash: "source-input-hash-2",
        checkpoint: {
          kind: "inline",
          value: checkpoint(),
          hash: "checkpoint-hash-2",
        },
      },
      5,
    );
    const prefix = [promoted(1), promoted(2), first, promoted(4), second];
    expect(parseRunJournalPrefixV1(prefix)).toHaveLength(5);

    expect(() =>
      parseRunJournalPrefixV1([
        ...prefix,
        factEnvelope(
          {
            type: "context.checkpoint_recorded",
            checkpointId: "checkpoint-stale",
            supersedesCheckpointId: "checkpoint-1",
            policyVersion: "checkpoint-policy-v1",
            sourceFromSeq: 1,
            sourceThroughSeq: 2,
            sourceInputHash: "stale-source-hash",
            checkpoint: {
              kind: "inline",
              value: checkpoint(),
              hash: "stale-checkpoint-hash",
            },
          },
          6,
        ),
      ]),
    ).toThrow("supersession is stale");
  });

  test("rejects self/future coverage and duplicate checkpoint identity", () => {
    expect(() =>
      parseRunJournalPrefixV1([
        promoted(1),
        promoted(2),
        recordedCheckpoint(3, { sourceThroughSeq: 3 }),
      ]),
    ).toThrow("cannot cover itself or future facts");

    expect(() =>
      parseRunJournalPrefixV1([
        promoted(1),
        promoted(2),
        recordedCheckpoint(),
        factEnvelope(
          {
            type: "context.checkpoint_recorded",
            checkpointId: "checkpoint-1",
            policyVersion: "checkpoint-policy-v1",
            sourceFromSeq: 1,
            sourceThroughSeq: 2,
            sourceInputHash: "source-input-hash",
            checkpoint: {
              kind: "inline",
              value: checkpoint(),
              hash: "checkpoint-hash",
            },
          },
          4,
        ),
      ]),
    ).toThrow("duplicate context checkpoint");
  });

  test("binds one durable distillation claim, settlement, and checkpoint", () => {
    const prefix = [
      promoted(1),
      promoted(2),
      distillationClaim(),
      distillationSettlement(),
      distilledCheckpoint(),
    ];
    expect(parseRunJournalPrefixV1(prefix)).toHaveLength(5);
    expect(parseRunJournalPrefixV1(prefix.slice(0, 3))).toHaveLength(3);
  });

  test("rejects missing, duplicate, or malformed distillation settlements", () => {
    expect(() =>
      parseRunJournalPrefixV1([
        promoted(1),
        promoted(2),
        distillationSettlement(3),
      ]),
    ).toThrow("has no claim");
    expect(() =>
      parseRunJournalPrefixV1([
        promoted(1),
        promoted(2),
        distillationClaim(),
        distillationSettlement(),
        distillationSettlement(5),
      ]),
    ).toThrow("not active");
    expect(() =>
      parseRunJournalEnvelopeV1(
        factEnvelope(
          {
            type: "context.checkpoint_distillation_settled",
            claimId: "checkpoint-claim-1",
            status: "completed",
          },
          4,
        ),
      ),
    ).toThrow("requires checkpoint");
    expect(() =>
      parseRunJournalEnvelopeV1(
        distillationSettlement(4, {
          status: "unknown",
          errorCode: "Interrupted",
        }),
      ),
    ).toThrow("cannot persist checkpoint");

    expect(() =>
      parseRunJournalPrefixV1([
        promoted(1),
        promoted(2),
        distillationClaim(),
        distillationSettlement(4, {
          checkpoint: {
            kind: "inline",
            value: checkpoint([1, 99]),
            hash: "outside-range-hash",
          },
        }),
      ]),
    ).toThrow("outside its covered range");

    expect(() =>
      parseRunJournalPrefixV1([
        promoted(1),
        promoted(2),
        distillationClaim(),
        factEnvelope(
          {
            type: "context.checkpoint_distillation_claimed",
            claimId: "checkpoint-claim-2",
            checkpointId: "checkpoint-distilled-2",
            boundary: "after_tool_batch_settled",
            policyVersion: "checkpoint-policy-v1",
            sourceFromSeq: 1,
            sourceThroughSeq: 2,
            sourceInputHash: "source-input-hash",
          },
          4,
        ),
      ]),
    ).toThrow("already has pending work");
  });

  test("cannot bypass or mismatch a completed distillation", () => {
    expect(() =>
      parseRunJournalPrefixV1([
        promoted(1),
        promoted(2),
        distillationClaim(),
        recordedCheckpoint(4, { checkpointId: "manual-checkpoint" }),
      ]),
    ).toThrow("bypass active distillation");
    expect(() =>
      parseRunJournalPrefixV1([
        promoted(1),
        promoted(2),
        distillationClaim(),
        distillationSettlement(),
        factEnvelope(
          {
            ...(
              distilledCheckpoint() as {
                record: { fact: Record<string, unknown> };
              }
            ).record.fact,
            sourceInputHash: "different-source-hash",
          },
          5,
        ),
      ]),
    ).toThrow("binding mismatch");
  });
});
