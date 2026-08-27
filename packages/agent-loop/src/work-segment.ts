import {
  type DerivedDecisionV1,
  type InputAcceptedFactV1,
  type InputFactV1,
  type InputPromotedFactV1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  WORK_SEGMENT_POLICY_VERSION_V1,
  type WorkSegmentStartedFactV1,
  isCrashRecoveryIncompleteActionV1,
  isCrashRecoveryIncompleteReasonV1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";

import {
  type AgentLoopContinueCursorV1,
  inspectAgentLoopContinueCursorV1,
} from "./agent-loop.js";
import {
  INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
  type InteractiveControlConfigV2,
  type InteractiveControlStateV2,
  createInteractiveControlReducerV2,
} from "./interactive-control.js";
import type { SessionInputSnapshot, StateHasher } from "./ports.js";
import { assertReplayEquivalentV1 } from "./replay.js";

export interface WorkSegmentStartVerificationV1 {
  readonly runConfig: InteractiveControlConfigV2;
  readonly stateHasher: StateHasher<InteractiveControlStateV2>;
  readonly derivedDecision: (input: {
    readonly state: InteractiveControlStateV2;
    readonly inputThroughSeq: number;
    readonly stateHash: string;
    readonly reducerVersion: string;
  }) => DerivedDecisionV1;
}

export interface PlanWorkSegmentStartOptionsV1 {
  readonly fullPrefix: readonly RunJournalEnvelopeV1[];
  readonly inputId: string;
  readonly promotion: InputPromotedFactV1;
  readonly verification: WorkSegmentStartVerificationV1;
}

export interface WorkSegmentStartPlanV1 {
  readonly expectedTailSeq: number;
  readonly inputId: string;
  readonly segmentIndex: number;
  readonly decisionToCommit?: DerivedDecisionV1;
  readonly facts: readonly [WorkSegmentStartedFactV1, InputPromotedFactV1];
  readonly prospectivePrefix: readonly RunJournalEnvelopeV1[];
  readonly prospectiveSnapshot: SessionInputSnapshot<InputFactV1>;
  readonly cursor: AgentLoopContinueCursorV1;
}

/**
 * 纯规划一次显式工作段开启事务。它只重放 canonical prefix，不读写端口，
 * 也不决定产品层是否允许开启新工作。
 */
export function planWorkSegmentStartV1(
  options: PlanWorkSegmentStartOptionsV1,
): WorkSegmentStartPlanV1 {
  assertNonEmptyId(options.inputId, "inputId");
  const prefix = detachedCanonicalPrefix(options.fullPrefix);
  if (prefix.length === 0) {
    throw new Error("A work segment requires an existing terminal run prefix");
  }
  const verification = captureVerification(options.verification);
  const reducer = createInteractiveControlReducerV2();
  assertReplayEquivalentV1(prefix, {
    ...verification,
    reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
    reducer,
  });

  const snapshot = projectSnapshot(prefix);
  const facts = snapshot.entries.map((entry) => entry.fact);
  const state = reducer.reduce(facts, verification.runConfig);
  if (
    state.decision.kind !== "completed" &&
    state.decision.kind !== "await_user" &&
    !(
      state.decision.kind === "incomplete" &&
      isCrashRecoveryIncompleteReasonV1(state.decision.reason)
    )
  ) {
    throw new Error(
      "A work segment can start only from completed, await_user, or crash-recovered incomplete state",
    );
  }
  const latestMarkerSeq = prefix.reduce(
    (latest, envelope) =>
      envelope.record.kind === "input_fact" &&
      envelope.record.fact.type === "work.segment_started"
        ? envelope.seq
        : latest,
    0,
  );
  const currentSegmentDecisions = prefix.filter(
    (envelope) =>
      envelope.seq > latestMarkerSeq &&
      envelope.record.kind === "derived_decision",
  );
  const latestCurrentSegmentDecision = currentSegmentDecisions.at(-1);
  if (
    !latestCurrentSegmentDecision ||
    latestCurrentSegmentDecision.record.kind !== "derived_decision" ||
    latestCurrentSegmentDecision.record.decision.reducerVersion !==
      INTERACTIVE_CONTROL_REDUCER_VERSION_V2 ||
    !isEligibleTerminalAction(
      latestCurrentSegmentDecision.record.decision.action,
    )
  ) {
    throw new Error(
      "A work segment requires the current segment's eligible interactive-v2 terminal decision",
    );
  }
  const factsAfterTerminal = prefix.slice(latestCurrentSegmentDecision.seq);
  if (
    factsAfterTerminal.some(
      (envelope) =>
        envelope.record.kind !== "input_fact" ||
        envelope.record.fact.type !== "input.accepted",
    )
  ) {
    throw new Error(
      "Only pending input.accepted facts may follow the current segment terminal decision",
    );
  }

  exactPendingQueueInput(facts, options.inputId);
  const promotion = detachedPromotion(options.promotion);
  if (promotion.inputId !== options.inputId || promotion.delivery !== "queue") {
    throw new Error(
      "Work segment promotion identity mismatch with the pending queue input",
    );
  }

  const stateHash = verification.stateHasher.hash(state);
  assertNonEmptyId(stateHash, "stateHash");
  const currentDecision = detachedDecision(
    verification.derivedDecision({
      state,
      inputThroughSeq: snapshot.latestInputSeq,
      stateHash,
      reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
    }),
  );
  assertDecisionMatchesCurrentState(
    currentDecision,
    state,
    snapshot.latestInputSeq,
    stateHash,
  );

  const tail = prefix.at(-1) as RunJournalEnvelopeV1;
  let decisionToCommit: DerivedDecisionV1 | undefined;
  if (tail.record.kind === "derived_decision") {
    if (!sameDecision(tail.record.decision, currentDecision)) {
      throw new Error(
        "Journal tail terminal decision does not match the current interactive-v2 state",
      );
    }
  } else {
    decisionToCommit = currentDecision;
  }

  const segmentIndex = state.segmentIndex + 1;
  if (!Number.isSafeInteger(segmentIndex) || segmentIndex < 1) {
    throw new Error("Next work segment index cannot advance safely");
  }
  const marker: WorkSegmentStartedFactV1 = deepFreeze({
    type: "work.segment_started",
    segmentIndex,
    inputId: options.inputId,
    reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
    previousDecisionStateHash: currentDecision.stateHash,
    previousAction: cloneJson(currentDecision.action),
    policyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
  });
  const prospectivePrefix = appendProspective(prefix, decisionToCommit, [
    marker,
    promotion,
  ]);
  const prospectiveSnapshot = projectSnapshot(prospectivePrefix);
  const prospectiveState = reducer.reduce(
    prospectiveSnapshot.entries.map((entry) => entry.fact),
    verification.runConfig,
  );
  if (
    prospectiveState.segmentIndex !== segmentIndex ||
    prospectiveState.decision.kind !== "continue"
  ) {
    throw new Error(
      "Prospective work segment does not reduce to one continuing segment",
    );
  }
  const cursor = deepFreeze(
    inspectAgentLoopContinueCursorV1(prospectiveSnapshot),
  );
  if (cursor.nextBoundary !== "before_first_model_request") {
    throw new Error("Prospective work segment has no initial safe cursor");
  }

  return deepFreeze({
    expectedTailSeq: prefix.length,
    inputId: options.inputId,
    segmentIndex,
    ...(decisionToCommit === undefined
      ? {}
      : { decisionToCommit: detachedDecision(decisionToCommit) }),
    facts: [marker, promotion] as const,
    prospectivePrefix,
    prospectiveSnapshot,
    cursor,
  });
}

function captureVerification(
  verification: WorkSegmentStartVerificationV1,
): WorkSegmentStartVerificationV1 {
  if (
    !verification ||
    !verification.runConfig ||
    typeof verification.derivedDecision !== "function" ||
    !verification.stateHasher ||
    typeof verification.stateHasher.hash !== "function"
  ) {
    throw new Error("Work segment replay verification is invalid");
  }
  const runConfig = deepFreeze({
    mode: verification.runConfig.mode,
    maxModelTurns: verification.runConfig.maxModelTurns,
    naturalStop: verification.runConfig.naturalStop,
    maxSegments: verification.runConfig.maxSegments,
    maxTotalModelTurns: verification.runConfig.maxTotalModelTurns,
  } satisfies InteractiveControlConfigV2);
  return Object.freeze({
    runConfig,
    stateHasher: Object.freeze({
      hash: verification.stateHasher.hash.bind(verification.stateHasher),
    }),
    derivedDecision: verification.derivedDecision.bind(verification),
  });
}

function exactPendingQueueInput(
  facts: readonly InputFactV1[],
  inputId: string,
): InputAcceptedFactV1 {
  const promoted = new Set(
    facts.flatMap((fact) =>
      fact.type === "input.promoted" ? [fact.inputId] : [],
    ),
  );
  const pendingQueues = facts.filter(
    (fact): fact is InputAcceptedFactV1 =>
      fact.type === "input.accepted" &&
      fact.delivery === "queue" &&
      !promoted.has(fact.inputId),
  );
  const first = pendingQueues[0];
  if (!first || first.inputId !== inputId) {
    throw new Error(
      "Work segment inputId must be the exact first pending queue input",
    );
  }
  return first;
}

function appendProspective(
  prefix: readonly RunJournalEnvelopeV1[],
  decision: DerivedDecisionV1 | undefined,
  facts: readonly InputFactV1[],
): readonly RunJournalEnvelopeV1[] {
  const first = prefix[0] as RunJournalEnvelopeV1;
  const appended: RunJournalEnvelopeV1[] = [...prefix];
  let seq = prefix.length;
  const ts = prefix.at(-1)?.ts ?? 0;
  if (decision) {
    seq += 1;
    appended.push({
      schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
      sessionId: first.sessionId,
      runId: first.runId,
      seq,
      ts,
      record: { kind: "derived_decision", decision },
    });
  }
  for (const fact of facts) {
    seq += 1;
    appended.push({
      schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
      sessionId: first.sessionId,
      runId: first.runId,
      seq,
      ts,
      record: { kind: "input_fact", fact },
    });
  }
  return detachedCanonicalPrefix(appended);
}

function projectSnapshot(
  prefix: readonly RunJournalEnvelopeV1[],
): SessionInputSnapshot<InputFactV1> {
  const entries = prefix.flatMap((envelope) =>
    envelope.record.kind === "input_fact"
      ? [{ seq: envelope.seq, fact: envelope.record.fact }]
      : [],
  );
  return deepFreeze({
    entries,
    tailSeq: prefix.length,
    latestInputSeq: entries.at(-1)?.seq ?? 0,
  });
}

function assertDecisionMatchesCurrentState(
  decision: DerivedDecisionV1,
  state: InteractiveControlStateV2,
  inputThroughSeq: number,
  stateHash: string,
): void {
  if (
    decision.type !== "control.decided" ||
    decision.reducerVersion !== INTERACTIVE_CONTROL_REDUCER_VERSION_V2 ||
    decision.inputThroughSeq !== inputThroughSeq ||
    decision.stateHash !== stateHash
  ) {
    throw new Error(
      "Derived terminal decision changed canonical replay identity",
    );
  }
  const action = decision.action;
  const matches =
    (state.decision.kind === "completed" && action.kind === "complete") ||
    (state.decision.kind === "await_user" &&
      action.kind === "wait" &&
      action.waitFor === "user") ||
    (state.decision.kind === "incomplete" &&
      isCrashRecoveryIncompleteActionV1(action));
  if (!matches || action.reasonCode !== state.decision.reason) {
    throw new Error("Derived terminal decision does not match reducer state");
  }
}

function isEligibleTerminalAction(
  action: DerivedDecisionV1["action"],
): boolean {
  return (
    action.kind === "complete" ||
    (action.kind === "wait" && action.waitFor === "user") ||
    isCrashRecoveryIncompleteActionV1(action)
  );
}

function sameDecision(
  left: DerivedDecisionV1,
  right: DerivedDecisionV1,
): boolean {
  return (
    left.type === right.type &&
    left.reducerVersion === right.reducerVersion &&
    left.inputThroughSeq === right.inputThroughSeq &&
    left.stateHash === right.stateHash &&
    sameAction(left.action, right.action)
  );
}

function sameAction(
  left: DerivedDecisionV1["action"],
  right: DerivedDecisionV1["action"],
): boolean {
  return (
    left.kind === right.kind &&
    left.reasonCode === right.reasonCode &&
    (left.kind !== "wait" ||
      (right.kind === "wait" && left.waitFor === right.waitFor))
  );
}

function detachedCanonicalPrefix(
  prefix: readonly RunJournalEnvelopeV1[],
): readonly RunJournalEnvelopeV1[] {
  const parsed = parseRunJournalPrefixV1(prefix);
  return deepFreeze(
    parseRunJournalPrefixV1(cloneJson(parsed)) as RunJournalEnvelopeV1[],
  );
}

function detachedPromotion(
  promotion: InputPromotedFactV1,
): InputPromotedFactV1 {
  return deepFreeze(cloneJson(promotion));
}

function detachedDecision(decision: DerivedDecisionV1): DerivedDecisionV1 {
  return deepFreeze(cloneJson(decision));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertNonEmptyId(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
