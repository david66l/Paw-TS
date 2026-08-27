import { describe, expect, test } from "bun:test";
import type {
  JournalContextCheckpointPlanV1,
  JournalContextPlanV1,
  JournalContextTimelineUnitPlanV1,
} from "@paw/runtime";

import {
  type ContextCompactionPolicyV1,
  createContextCompactionInputPortV1,
  evaluateContextCompactionSavingsV1,
  evaluateContextCompactionTriggerV1,
  freezeContextCompactionPolicyV1,
  planContextCompactionV1,
  planSemanticCheckpointRangeV1,
  projectContextCompactionHealthV1,
} from "../src/index.js";

const policy: ContextCompactionPolicyV1 = Object.freeze({
  triggerRatioBasisPoints: 8_000,
  minimumNewTimelineUnits: 2,
  retainNewestUnprotectedUnits: 1,
});

describe("context compaction policy", () => {
  test("stays deterministic below the L2 trigger", () => {
    const plan = contextPlan({ fullInputTokens: 79 });

    expect(evaluateContextCompactionTriggerV1(plan, policy)).toEqual({
      shouldDistill: false,
      reason: "below_trigger",
      usageRatioBasisPoints: 7_900,
    });
    expect(planContextCompactionV1(plan, policy)).toEqual({
      action: "skip",
      reason: "below_trigger",
      usageRatioBasisPoints: 7_900,
    });
  });

  test("selects complete old units and retains the newest live unit", () => {
    const result = planContextCompactionV1(
      contextPlan({ fullInputTokens: 80 }),
      policy,
    );

    expect(result).toEqual({
      action: "distill",
      reason: "near_soft_limit",
      usageRatioBasisPoints: 8_000,
      range: {
        sourceFromSeq: 2,
        sourceThroughSeq: 7,
        newUnitSourceSeqs: [2, 3],
      },
    });
  });

  test("treats active fallback omission as an immediate L2 signal", () => {
    const result = planContextCompactionV1(
      contextPlan({
        fullInputTokens: 50,
        omittedUnitSourceSeqs: [2],
      }),
      { ...policy, retainNewestUnprotectedUnits: 0 },
    );

    expect(result).toMatchObject({
      action: "distill",
      reason: "fallback_omission_active",
      usageRatioBasisPoints: 5_000,
    });
  });

  test("extends an active checkpoint without crossing a protected unit", () => {
    const checkpoint: JournalContextCheckpointPlanV1 = {
      checkpointId: "checkpoint-1",
      policyVersion: "policy-1",
      sourceFromSeq: 2,
      sourceThroughSeq: 7,
    };
    const extendable = contextPlan({
      fullInputTokens: 90,
      checkpoint,
      units: [
        unit("input", 1, 1, true),
        unit("input", 8, 8, false),
        unit("model", 9, 12, false),
        unit("input", 13, 13, true),
      ],
    });

    expect(
      planSemanticCheckpointRangeV1(extendable, {
        ...policy,
        retainNewestUnprotectedUnits: 0,
      }),
    ).toEqual({
      sourceFromSeq: 2,
      sourceThroughSeq: 12,
      newUnitSourceSeqs: [8, 9],
      supersedesCheckpointId: "checkpoint-1",
    });

    const blocked = contextPlan({
      fullInputTokens: 90,
      checkpoint,
      units: [
        unit("input", 1, 1, true),
        unit("input", 8, 8, true),
        unit("model", 9, 12, false),
        unit("input", 13, 13, true),
      ],
    });
    expect(
      planSemanticCheckpointRangeV1(blocked, {
        ...policy,
        retainNewestUnprotectedUnits: 0,
      }),
    ).toBeUndefined();
  });

  test("rejects invalid policy instead of silently changing thresholds", () => {
    expect(() =>
      freezeContextCompactionPolicyV1({
        ...policy,
        triggerRatioBasisPoints: 10_001,
      }),
    ).toThrow("Context compaction policy is invalid");
  });
});

describe("context compaction safe-boundary input port", () => {
  test("plans before the canonical inbox handles a settled boundary", async () => {
    const events: string[] = [];
    const plan = contextPlan({ fullInputTokens: 80 });
    const port = createContextCompactionInputPortV1({
      baseInput: {
        async reportSafeBoundary() {
          events.push("base");
        },
        async consumePromotedInputIds() {
          return ["promoted-1"];
        },
      },
      snapshots: {
        async readInputSnapshot() {
          events.push("snapshot");
          return { entries: [], tailSeq: 0, latestInputSeq: 0 };
        },
      },
      context: {
        async plan() {
          events.push("plan");
          return plan;
        },
      },
      signal: new AbortController().signal,
      policy,
      async onDecision(decision) {
        events.push("decision");
        expect(decision.boundary).toBe("after_tool_batch_settled");
        expect(decision.compaction.action).toBe("distill");
      },
    });

    await port.reportSafeBoundary("after_tool_batch_settled");

    expect(events).toEqual(["snapshot", "plan", "decision", "base"]);
    expect(await port.consumePromotedInputIds()).toEqual(["promoted-1"]);
  });

  test("skips startup planning and never blocks base input on extension failure", async () => {
    const events: string[] = [];
    const port = createContextCompactionInputPortV1({
      baseInput: {
        async reportSafeBoundary(boundary) {
          events.push(`base:${boundary}`);
        },
        async consumePromotedInputIds() {
          return [];
        },
      },
      snapshots: {
        async readInputSnapshot() {
          events.push("snapshot");
          return { entries: [], tailSeq: 0, latestInputSeq: 0 };
        },
      },
      context: {
        async plan() {
          events.push("plan");
          throw new Error("simulated planner failure");
        },
      },
      signal: new AbortController().signal,
      policy,
      async onDecision() {
        events.push("unexpected-decision");
      },
      async onError(error, boundary) {
        events.push(`error:${boundary}:${String(error)}`);
      },
    });

    await port.reportSafeBoundary("before_first_model_request");
    await port.reportSafeBoundary("after_model_turn_without_tool_calls");

    expect(events).toEqual([
      "base:before_first_model_request",
      "snapshot",
      "plan",
      "error:after_model_turn_without_tool_calls:Error: simulated planner failure",
      "base:after_model_turn_without_tool_calls",
    ]);
  });
});

describe("context compaction lifecycle policy", () => {
  test("keeps the useful old savings floor without treating every large saving as corruption", () => {
    expect(evaluateContextCompactionSavingsV1(100, 85)).toEqual({
      savingsBasisPoints: 1_500,
      classification: "low",
    });
    expect(evaluateContextCompactionSavingsV1(100, 20)).toEqual({
      savingsBasisPoints: 8_000,
      classification: "acceptable",
    });
    expect(evaluateContextCompactionSavingsV1(100, 4)).toEqual({
      savingsBasisPoints: 9_600,
      classification: "suspiciously_high",
    });
  });

  test("reconstructs cooldown, low-savings backoff, and breaker from attempts", () => {
    expect(
      projectContextCompactionHealthV1(
        [{ modelTurn: 10, fullInputTokens: 100, outcome: "committed" }],
        12,
        110,
      ),
    ).toMatchObject({ canAttempt: false, reason: "cooldown" });
    expect(
      projectContextCompactionHealthV1(
        [
          { modelTurn: 2, fullInputTokens: 100, outcome: "low_savings" },
          { modelTurn: 8, fullInputTokens: 110, outcome: "low_savings" },
        ],
        20,
        130,
      ),
    ).toMatchObject({
      canAttempt: false,
      reason: "low_savings_backoff",
      consecutiveLowSavings: 2,
    });
    expect(
      projectContextCompactionHealthV1(
        [
          { modelTurn: 1, fullInputTokens: 100, outcome: "error" },
          { modelTurn: 2, fullInputTokens: 110, outcome: "unknown" },
          {
            modelTurn: 3,
            fullInputTokens: 120,
            outcome: "quality_rejected",
          },
        ],
        20,
        200,
      ),
    ).toMatchObject({
      canAttempt: false,
      reason: "circuit_open",
      consecutiveFailures: 3,
    });
  });

  test("allows retry after real history growth or a durable success reset", () => {
    expect(
      projectContextCompactionHealthV1(
        [
          { modelTurn: 2, fullInputTokens: 100, outcome: "low_savings" },
          { modelTurn: 8, fullInputTokens: 110, outcome: "low_savings" },
        ],
        20,
        133,
      ),
    ).toMatchObject({ canAttempt: true, reason: "ready" });
    expect(
      projectContextCompactionHealthV1(
        [
          { modelTurn: 1, fullInputTokens: 100, outcome: "error" },
          { modelTurn: 2, fullInputTokens: 110, outcome: "error" },
          { modelTurn: 3, fullInputTokens: 120, outcome: "committed" },
        ],
        8,
        150,
      ),
    ).toMatchObject({
      canAttempt: true,
      reason: "ready",
      consecutiveFailures: 0,
    });
  });
});

function contextPlan(input: {
  readonly fullInputTokens: number;
  readonly omittedUnitSourceSeqs?: readonly number[];
  readonly checkpoint?: JournalContextCheckpointPlanV1;
  readonly units?: readonly JournalContextTimelineUnitPlanV1[];
}): JournalContextPlanV1 {
  const units = input.units ?? [
    unit("input", 1, 1, true),
    unit("input", 2, 2, false),
    unit("model", 3, 7, false),
    unit("input", 8, 8, false),
    unit("input", 9, 9, true),
  ];
  const omitted = input.omittedUnitSourceSeqs ?? [];
  return {
    request: { messages: [] },
    level:
      omitted.length > 0
        ? "fallback_omission"
        : input.checkpoint
          ? "semantic_checkpoint"
          : "lossless_projection",
    tokens: {
      contextWindowTokens: 120,
      reservedOutputTokens: 10,
      hardInputLimitTokens: 110,
      softTargetTokens: 100,
      fixedInputTokens: 10,
      protectedInputTokens: 20,
      fullInputTokens: input.fullInputTokens,
      selectedInputTokens: Math.min(input.fullInputTokens, 100),
      estimatedOmittedInputTokens: Math.max(0, input.fullInputTokens - 100),
      hardHeadroomTokens: 10,
      softHeadroomTokens: 0,
      estimatorId: "test",
      estimatorVersion: "1",
    },
    selection: {
      eligibleUnits: units,
      eligibleUnitSourceSeqs: units.map((item) => item.sourceFromSeq),
      protectedUnitSourceSeqs: units
        .filter((item) => item.protected)
        .map((item) => item.sourceFromSeq),
      selectedUnitSourceSeqs: units
        .filter((item) => item.selected)
        .map((item) => item.sourceFromSeq),
      omittedUnitSourceSeqs: omitted,
      checkpointCoveredUnitSourceSeqs: [],
    },
    ...(input.checkpoint === undefined ? {} : { checkpoint: input.checkpoint }),
  };
}

function unit(
  kind: JournalContextTimelineUnitPlanV1["kind"],
  sourceFromSeq: number,
  sourceThroughSeq: number,
  protectedUnit: boolean,
): JournalContextTimelineUnitPlanV1 {
  return {
    kind,
    sourceFromSeq,
    sourceThroughSeq,
    protected: protectedUnit,
    selected: true,
  };
}
