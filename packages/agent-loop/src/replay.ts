import {
  type ControlDecisionActionV1,
  type DerivedDecisionV1,
  type InputFactV1,
  type RunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";
import type { LoopControlState } from "./contracts.js";
import type { ControlReducer, StateHasher } from "./ports.js";

/** 重放校验只依赖纯归约器、纯哈希器和派生决定映射，不接触任何外部端口。 */
export interface ReplayVerificationV1<
  TRunConfig,
  TControlState extends LoopControlState,
> {
  readonly runConfig: TRunConfig;
  readonly reducerVersion: string;
  readonly reducer: ControlReducer<InputFactV1, TRunConfig, TControlState>;
  readonly stateHasher: StateHasher<TControlState>;
  readonly derivedDecision: (input: {
    readonly state: TControlState;
    readonly inputThroughSeq: number;
    readonly stateHash: string;
    readonly reducerVersion: string;
  }) => DerivedDecisionV1;
}

/**
 * 逐点重放 canonical journal prefix，并核对其中每一条历史派生决定。
 *
 * DerivedDecision 永远不会回灌给归约器。此函数只验证已有日志，不写 Session，
 * 也不调用模型、工具、策略、上下文或输入端口。
 */
export function assertReplayEquivalentV1<
  TRunConfig,
  TControlState extends LoopControlState,
>(
  prefix: readonly RunJournalEnvelopeV1[],
  verification: ReplayVerificationV1<TRunConfig, TControlState>,
): void {
  let canonicalPrefix: readonly RunJournalEnvelopeV1[];
  try {
    canonicalPrefix = parseRunJournalPrefixV1(prefix);
  } catch (error) {
    const cursorSeq = firstCursorMismatchSeq(prefix);
    if (cursorSeq !== undefined) {
      divergence(cursorSeq, `invalid canonical prefix: ${errorMessage(error)}`);
    }
    throw error;
  }
  const inputFacts: InputFactV1[] = [];
  let latestInputSeq = 0;

  for (const envelope of canonicalPrefix) {
    if (envelope.record.kind === "input_fact") {
      inputFacts.push(envelope.record.fact);
      latestInputSeq = envelope.seq;
      continue;
    }

    const logged = envelope.record.decision;
    if (logged.reducerVersion !== verification.reducerVersion) {
      divergence(
        envelope.seq,
        `reducerVersion expected ${verification.reducerVersion}, got ${logged.reducerVersion}`,
      );
    }
    if (logged.inputThroughSeq !== latestInputSeq) {
      divergence(
        envelope.seq,
        `inputThroughSeq expected ${latestInputSeq}, got ${logged.inputThroughSeq}`,
      );
    }

    let state: TControlState;
    try {
      state = verification.reducer.reduce(inputFacts, verification.runConfig);
    } catch (error) {
      divergence(envelope.seq, `ControlReducer threw: ${errorMessage(error)}`);
    }

    let stateHash: string;
    try {
      stateHash = verification.stateHasher.hash(state);
    } catch (error) {
      divergence(envelope.seq, `StateHasher threw: ${errorMessage(error)}`);
    }
    if (!stateHash.trim()) {
      divergence(envelope.seq, "StateHasher returned an empty state hash");
    }
    if (logged.stateHash !== stateHash) {
      divergence(
        envelope.seq,
        `stateHash expected ${stateHash}, got ${logged.stateHash}`,
      );
    }

    const expected = verification.derivedDecision({
      state,
      inputThroughSeq: latestInputSeq,
      stateHash,
      reducerVersion: verification.reducerVersion,
    });
    if (expected.reducerVersion !== verification.reducerVersion) {
      divergence(envelope.seq, "decision mapper changed reducerVersion");
    }
    if (expected.inputThroughSeq !== latestInputSeq) {
      divergence(envelope.seq, "decision mapper changed inputThroughSeq");
    }
    if (expected.stateHash !== stateHash) {
      divergence(envelope.seq, "decision mapper changed stateHash");
    }
    if (!actionMatchesState(state, expected.action)) {
      divergence(
        envelope.seq,
        "decision mapper action does not match the replayed control state",
      );
    }
    if (!sameAction(expected.action, logged.action)) {
      divergence(
        envelope.seq,
        `action expected ${formatAction(expected.action)}, got ${formatAction(logged.action)}`,
      );
    }
  }
}

function actionMatchesState(
  state: LoopControlState,
  action: ControlDecisionActionV1,
): boolean {
  const decision = state.decision;
  return (
    (decision.kind === "continue" && action.kind === "continue") ||
    (decision.kind === "await_user" &&
      action.kind === "wait" &&
      action.waitFor === "user" &&
      action.reasonCode === decision.reason) ||
    (decision.kind === "await_external" &&
      action.kind === "wait" &&
      action.waitFor === "external" &&
      action.reasonCode === decision.reason) ||
    (decision.kind === "completed" &&
      action.kind === "complete" &&
      action.reasonCode === decision.reason) ||
    (decision.kind === "incomplete" &&
      action.kind === "incomplete" &&
      action.reasonCode === decision.reason) ||
    (decision.kind === "failed" &&
      action.kind === "failed" &&
      action.reasonCode === decision.reason) ||
    (decision.kind === "aborted" &&
      action.kind === "abort" &&
      action.reasonCode === decision.reason)
  );
}

function firstCursorMismatchSeq(
  prefix: readonly RunJournalEnvelopeV1[],
): number | undefined {
  let latestInputSeq = 0;
  for (const envelope of prefix) {
    if (envelope.record.kind === "input_fact") {
      latestInputSeq = envelope.seq;
    } else if (envelope.record.decision.inputThroughSeq !== latestInputSeq) {
      return envelope.seq;
    }
  }
  return undefined;
}

function sameAction(
  left: ControlDecisionActionV1,
  right: ControlDecisionActionV1,
): boolean {
  if (left.kind !== right.kind || left.reasonCode !== right.reasonCode) {
    return false;
  }
  if (left.kind === "wait" || right.kind === "wait") {
    return (
      left.kind === "wait" &&
      right.kind === "wait" &&
      left.waitFor === right.waitFor
    );
  }
  return true;
}

function formatAction(action: ControlDecisionActionV1): string {
  return JSON.stringify(action);
}

function divergence(seq: number, detail: string): never {
  throw new Error(`Replay divergence at journal seq ${seq}: ${detail}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
