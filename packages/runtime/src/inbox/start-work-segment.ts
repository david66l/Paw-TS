import {
  INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
  type VerifiedModelResponseEvidenceV1,
  type WorkSegmentStartVerificationV1,
  assertReplayEquivalentV1,
  createInteractiveControlReducerV2,
  inspectAgentLoopContinueCursorV1,
  planWorkSegmentStartV1,
} from "@paw/agent-loop";
import {
  type DerivedDecisionV1,
  type InputAcceptedFactV1,
  type InputFactV1,
  type RunJournalEnvelopeV1,
  WORK_SEGMENT_POLICY_VERSION_V1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";

import { immutableCanonicalJsonCloneV1 } from "../context/canonical-json.js";
import { projectCanonicalSessionInputSnapshotV1 } from "../payload/verified-model-response-evidence.js";
import { createInputPromotionFactV1 } from "./durable-input-inbox.js";

export interface WorkSegmentStartSessionV1 {
  readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]>;
  commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict">;
  commitDecisionAndInputFacts(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict">;
}

export interface StartWorkSegmentOptionsV1 {
  readonly session: WorkSegmentStartSessionV1;
  readonly inputId: string;
  readonly verification: WorkSegmentStartVerificationV1;
  readonly preflight: (
    prospectiveFullPrefix: readonly RunJournalEnvelopeV1[],
    signal: AbortSignal,
  ) =>
    | VerifiedModelResponseEvidenceV1
    | undefined
    | Promise<VerifiedModelResponseEvidenceV1 | undefined>;
  readonly signal: AbortSignal;
}

export type StartWorkSegmentResultV1 = Readonly<{
  status: "started" | "already_started";
  inputId: string;
  segmentIndex: number;
}>;

/**
 * 在调用方已持有的 fenced Session 上开启一个工作段。
 *
 * 该事务不拥有租约、不做恢复，也不把 abort 伪装成 journal fact。CAS 冲突
 * 只会重读同一 canonical inputId 并重建纯规划与证据。
 */
export async function startWorkSegmentV1(
  options: StartWorkSegmentOptionsV1,
): Promise<StartWorkSegmentResultV1> {
  const inputId = options.inputId;
  const signal = options.signal;
  assertNonEmptyString(inputId, "inputId");
  if (typeof options.preflight !== "function") {
    throw new Error("Work segment preflight must be a function");
  }
  if (!signal || typeof signal.aborted !== "boolean") {
    throw new Error("Work segment AbortSignal is invalid");
  }
  const session = captureSession(options.session);
  const preflight = options.preflight.bind(options);
  const verification = captureVerification(options.verification);

  while (true) {
    throwIfAborted(signal);
    const prefix = detachedPrefix(await session.readCanonicalPrefix());
    throwIfAborted(signal);

    const alreadyStarted = inspectAlreadyStarted(prefix, inputId, verification);
    if (alreadyStarted !== undefined) {
      throwIfAborted(signal);
      const evidence = await preflight(prefix, signal);
      throwIfAborted(signal);
      evidence?.assertSnapshot(projectCanonicalSessionInputSnapshotV1(prefix));
      throwIfAborted(signal);
      return Object.freeze({
        status: "already_started",
        inputId,
        segmentIndex: alreadyStarted,
      });
    }

    const accepted = findPendingAcceptedInput(prefix, inputId);
    const promotion = createInputPromotionFactV1(accepted);
    const plan = planWorkSegmentStartV1({
      fullPrefix: prefix,
      inputId,
      promotion,
      verification,
    });

    throwIfAborted(signal);
    const evidence = await preflight(plan.prospectivePrefix, signal);
    throwIfAborted(signal);
    const cursor = inspectAgentLoopContinueCursorV1(
      plan.prospectiveSnapshot,
      evidence === undefined ? {} : { modelResponses: evidence },
    );
    if (
      cursor.lastModelTurn !== plan.cursor.lastModelTurn ||
      cursor.nextBoundary !== plan.cursor.nextBoundary
    ) {
      throw new Error("Work segment preflight changed the prospective cursor");
    }
    throwIfAborted(signal);

    const committed = plan.decisionToCommit
      ? await session.commitDecisionAndInputFacts(
          plan.expectedTailSeq,
          plan.decisionToCommit,
          plan.facts,
        )
      : await session.commitInputFacts(plan.expectedTailSeq, plan.facts);
    if (committed === "committed") {
      return Object.freeze({
        status: "started",
        inputId,
        segmentIndex: plan.segmentIndex,
      });
    }
  }
}

function captureSession(
  session: WorkSegmentStartSessionV1,
): WorkSegmentStartSessionV1 {
  if (
    !session ||
    typeof session.readCanonicalPrefix !== "function" ||
    typeof session.commitInputFacts !== "function" ||
    typeof session.commitDecisionAndInputFacts !== "function"
  ) {
    throw new Error("Work segment Session port is invalid");
  }
  return Object.freeze({
    readCanonicalPrefix: session.readCanonicalPrefix.bind(session),
    commitInputFacts: session.commitInputFacts.bind(session),
    commitDecisionAndInputFacts:
      session.commitDecisionAndInputFacts.bind(session),
  });
}

function captureVerification(
  verification: WorkSegmentStartVerificationV1,
): WorkSegmentStartVerificationV1 {
  if (
    !verification ||
    !verification.runConfig ||
    !verification.stateHasher ||
    typeof verification.stateHasher.hash !== "function" ||
    typeof verification.derivedDecision !== "function"
  ) {
    throw new Error("Work segment verification is invalid");
  }
  const runConfig = Object.freeze({
    mode: verification.runConfig.mode,
    maxModelTurns: verification.runConfig.maxModelTurns,
    naturalStop: verification.runConfig.naturalStop,
    maxSegments: verification.runConfig.maxSegments,
    maxTotalModelTurns: verification.runConfig.maxTotalModelTurns,
  });
  return Object.freeze({
    runConfig,
    stateHasher: Object.freeze({
      hash: verification.stateHasher.hash.bind(verification.stateHasher),
    }),
    derivedDecision: verification.derivedDecision.bind(verification),
  });
}

function inspectAlreadyStarted(
  prefix: readonly RunJournalEnvelopeV1[],
  inputId: string,
  verification: WorkSegmentStartVerificationV1,
): number | undefined {
  const markerEntry = prefix.find(
    (envelope) =>
      envelope.record.kind === "input_fact" &&
      envelope.record.fact.type === "work.segment_started" &&
      envelope.record.fact.inputId === inputId,
  );
  if (!markerEntry || markerEntry.record.kind !== "input_fact") {
    return undefined;
  }
  const marker = markerEntry.record.fact;
  if (
    marker.type !== "work.segment_started" ||
    marker.reducerVersion !== INTERACTIVE_CONTROL_REDUCER_VERSION_V2 ||
    marker.policyVersion !== WORK_SEGMENT_POLICY_VERSION_V1
  ) {
    throw new Error(
      "Existing work segment does not match the requested policy",
    );
  }
  assertReplayEquivalentV1(prefix, {
    ...verification,
    reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
    reducer: createInteractiveControlReducerV2(),
  });
  const accepted = findAcceptedInput(prefix, inputId);
  if (accepted.delivery !== "queue") {
    throw new Error("Existing work segment input is not a queue delivery");
  }
  const next = prefix[markerEntry.seq];
  if (
    !next ||
    next.record.kind !== "input_fact" ||
    next.record.fact.type !== "input.promoted" ||
    next.record.fact.inputId !== accepted.inputId
  ) {
    throw new Error("Existing work segment promotion identity drifted");
  }
  return marker.segmentIndex;
}

function findPendingAcceptedInput(
  prefix: readonly RunJournalEnvelopeV1[],
  inputId: string,
): InputAcceptedFactV1 {
  const accepted = findAcceptedInput(prefix, inputId);
  const promoted = prefix.some(
    (envelope) =>
      envelope.record.kind === "input_fact" &&
      envelope.record.fact.type === "input.promoted" &&
      envelope.record.fact.inputId === inputId,
  );
  if (promoted) {
    throw new Error("Work segment input is no longer pending");
  }
  return accepted;
}

function findAcceptedInput(
  prefix: readonly RunJournalEnvelopeV1[],
  inputId: string,
): InputAcceptedFactV1 {
  const matches = prefix.flatMap((envelope) =>
    envelope.record.kind === "input_fact" &&
    envelope.record.fact.type === "input.accepted" &&
    envelope.record.fact.inputId === inputId
      ? [envelope.record.fact]
      : [],
  );
  if (matches.length !== 1) {
    throw new Error("Work segment inputId has no exact accepted input");
  }
  return matches[0] as InputAcceptedFactV1;
}

function detachedPrefix(
  prefix: readonly RunJournalEnvelopeV1[],
): readonly RunJournalEnvelopeV1[] {
  const parsed = parseRunJournalPrefixV1(prefix);
  const clone = immutableCanonicalJsonCloneV1(
    parsed as never,
  ) as unknown as readonly RunJournalEnvelopeV1[];
  return parseRunJournalPrefixV1(clone);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "Work segment start aborted"));
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
