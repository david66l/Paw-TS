import type {
  JournalContextPlanV1,
  JournalContextTimelineUnitPlanV1,
} from "@paw/runtime";

import {
  type ContextCompactionPolicyV1,
  DEFAULT_CONTEXT_COMPACTION_POLICY_V1,
  evaluateContextCompactionTriggerV1,
  freezeContextCompactionPolicyV1,
} from "./policy.js";

export interface SemanticCheckpointRangePlanV1 {
  readonly sourceFromSeq: number;
  readonly sourceThroughSeq: number;
  readonly newUnitSourceSeqs: readonly number[];
  readonly supersedesCheckpointId?: string;
}

export type ContextCompactionPlanV1 =
  | Readonly<{
      action: "skip";
      reason: "below_trigger" | "no_stable_range" | "range_too_small";
      usageRatioBasisPoints: number;
    }>
  | Readonly<{
      action: "distill";
      reason: "near_soft_limit" | "fallback_omission_active";
      usageRatioBasisPoints: number;
      range: SemanticCheckpointRangePlanV1;
    }>;

/** Pure, read-only L2 decision. It never invokes a model or writes Journal. */
export function planContextCompactionV1(
  context: JournalContextPlanV1,
  policy: ContextCompactionPolicyV1 = DEFAULT_CONTEXT_COMPACTION_POLICY_V1,
): ContextCompactionPlanV1 {
  const frozen = freezeContextCompactionPolicyV1(policy);
  const trigger = evaluateContextCompactionTriggerV1(context, frozen);
  if (!trigger.shouldDistill) {
    return Object.freeze({
      action: "skip",
      reason: "below_trigger",
      usageRatioBasisPoints: trigger.usageRatioBasisPoints,
    });
  }
  const candidate = planSemanticCheckpointRangeV1(context, frozen);
  if (!candidate) {
    return Object.freeze({
      action: "skip",
      reason: "no_stable_range",
      usageRatioBasisPoints: trigger.usageRatioBasisPoints,
    });
  }
  if (candidate.newUnitSourceSeqs.length < frozen.minimumNewTimelineUnits) {
    return Object.freeze({
      action: "skip",
      reason: "range_too_small",
      usageRatioBasisPoints: trigger.usageRatioBasisPoints,
    });
  }
  return Object.freeze({
    action: "distill",
    reason: trigger.reason,
    usageRatioBasisPoints: trigger.usageRatioBasisPoints,
    range: candidate,
  });
}

/** Selects the oldest complete range without crossing a protected/live unit. */
export function planSemanticCheckpointRangeV1(
  context: JournalContextPlanV1,
  policy: ContextCompactionPolicyV1 = DEFAULT_CONTEXT_COMPACTION_POLICY_V1,
): SemanticCheckpointRangePlanV1 | undefined {
  const frozen = freezeContextCompactionPolicyV1(policy);
  const units = [...context.selection.eligibleUnits].sort(
    (left, right) => left.sourceFromSeq - right.sourceFromSeq,
  );
  assertTimelineUnits(units);
  const checkpoint = context.checkpoint;
  const afterCheckpoint = checkpoint
    ? units.filter((unit) => unit.sourceFromSeq > checkpoint.sourceThroughSeq)
    : units;
  const unprotected = afterCheckpoint.filter((unit) => !unit.protected);
  const retained = new Set(
    (frozen.retainNewestUnprotectedUnits === 0
      ? []
      : unprotected.slice(-frozen.retainNewestUnprotectedUnits)
    ).map((unit) => unit.sourceFromSeq),
  );
  const firstEligibleIndex = checkpoint
    ? afterCheckpoint.findIndex(
        (unit) => !unit.protected && !retained.has(unit.sourceFromSeq),
      )
    : units.findIndex(
        (unit) => !unit.protected && !retained.has(unit.sourceFromSeq),
      );
  const source = checkpoint ? afterCheckpoint : units;
  if (firstEligibleIndex < 0) return undefined;

  if (checkpoint) {
    const preceding = source.slice(0, firstEligibleIndex);
    if (
      preceding.some(
        (unit) => unit.protected || retained.has(unit.sourceFromSeq),
      )
    ) {
      return undefined;
    }
  }

  const block: JournalContextTimelineUnitPlanV1[] = [];
  for (let index = firstEligibleIndex; index < source.length; index += 1) {
    const unit = source[index];
    if (!unit) break;
    if (unit.protected || retained.has(unit.sourceFromSeq)) break;
    block.push(unit);
  }
  const first = block[0];
  const last = block.at(-1);
  if (!first || !last) return undefined;
  return Object.freeze({
    sourceFromSeq: checkpoint?.sourceFromSeq ?? first.sourceFromSeq,
    sourceThroughSeq: last.sourceThroughSeq,
    newUnitSourceSeqs: Object.freeze(block.map((unit) => unit.sourceFromSeq)),
    ...(checkpoint === undefined
      ? {}
      : { supersedesCheckpointId: checkpoint.checkpointId }),
  });
}

function assertTimelineUnits(
  units: readonly JournalContextTimelineUnitPlanV1[],
): void {
  let previousThroughSeq = 0;
  for (const unit of units) {
    if (
      !Number.isSafeInteger(unit.sourceFromSeq) ||
      unit.sourceFromSeq <= previousThroughSeq ||
      !Number.isSafeInteger(unit.sourceThroughSeq) ||
      unit.sourceThroughSeq < unit.sourceFromSeq
    ) {
      throw new Error("Context compaction timeline plan is invalid");
    }
    previousThroughSeq = unit.sourceThroughSeq;
  }
}
