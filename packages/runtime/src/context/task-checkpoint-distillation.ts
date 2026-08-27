import { createHash } from "node:crypto";
import type { Session, SessionInputSnapshot } from "@paw/agent-loop";
import {
  type ContextCheckpointDistillationClaimedFactV1,
  type ContextCheckpointDistillationSettledFactV1,
  type ContextCheckpointRecordedFactV1,
  type DurableJsonPayloadV1,
  type InputFactV1,
  type JsonValue,
  type TaskCheckpointDistillationStatusV1,
  type TaskCheckpointV1,
  parseTaskCheckpointV1,
} from "@paw/protocol";
import type { VerifiedCanonicalPayloadEvidenceV1 } from "../payload/verified-model-response-evidence.js";
import {
  canonicalJsonStringifyV1,
  immutableCanonicalJsonCloneV1,
} from "./canonical-json.js";
import { assertTaskCheckpointStableBoundaryV1 } from "./journal-context.js";
import {
  type TaskCheckpointPayloadCodecV1,
  type TaskCheckpointSourceInputV1,
  bindTaskCheckpointSourceV1,
  createAndCommitTaskCheckpointFromSnapshotV1,
} from "./task-checkpoint.js";

export type TaskCheckpointDistillationBoundaryV1 =
  | "after_model_turn_without_tool_calls"
  | "after_tool_batch_settled";

export type TaskCheckpointDistillerResultV1 =
  | Readonly<{ status: "completed"; checkpoint: TaskCheckpointV1 }>
  | Readonly<{
      status: Exclude<TaskCheckpointDistillationStatusV1, "completed">;
      errorCode: string;
    }>;

/** A semantic worker only: it cannot write Session or decide run control. */
export interface TaskCheckpointDistillerV1 {
  distill(
    input: Readonly<{
      claimId: string;
      checkpointId: string;
      boundary: TaskCheckpointDistillationBoundaryV1;
      policyVersion: string;
      sourceFromSeq: number;
      sourceThroughSeq: number;
      sourceInputHash: string;
      sourceEntries: readonly {
        readonly seq: number;
        readonly fact: InputFactV1;
      }[];
    }>,
    options: Readonly<{ signal: AbortSignal }>,
  ): Promise<TaskCheckpointDistillerResultV1>;
}

export interface TaskCheckpointDistillationCodecV1
  extends TaskCheckpointPayloadCodecV1 {
  resolve(
    payload: DurableJsonPayloadV1,
    signal: AbortSignal,
  ): JsonValue | Promise<JsonValue>;
}

export interface RunTaskCheckpointDistillationInputV1
  extends TaskCheckpointSourceInputV1 {
  readonly boundary: TaskCheckpointDistillationBoundaryV1;
}

export interface RunTaskCheckpointDistillationOptionsV1 {
  readonly loadPayloadEvidence?: (
    snapshot: SessionInputSnapshot<InputFactV1>,
    signal: AbortSignal,
  ) =>
    | VerifiedCanonicalPayloadEvidenceV1
    | Promise<VerifiedCanonicalPayloadEvidenceV1>;
}

type TaskCheckpointPayloadEvidenceLoaderV1 = NonNullable<
  RunTaskCheckpointDistillationOptionsV1["loadPayloadEvidence"]
>;

export type TaskCheckpointDistillationRunResultV1 = Readonly<{
  status:
    | "committed"
    | "reused"
    | "conflict"
    | "busy"
    | "interrupted"
    | "settled_without_checkpoint"
    | "invalid_settlement";
  claimId: string;
  checkpointId: string;
  distillerCalls: 0 | 1;
  settlementStatus?: TaskCheckpointDistillationStatusV1;
}>;

/**
 * Crash-safe, at-most-once orchestration for one explicit stable-boundary range.
 * Automatic range selection belongs to the Context budget planner, not here.
 */
export async function runTaskCheckpointDistillationV1(
  session: Session<InputFactV1, unknown>,
  input: RunTaskCheckpointDistillationInputV1,
  distiller: TaskCheckpointDistillerV1,
  codec: TaskCheckpointDistillationCodecV1,
  signal: AbortSignal,
  options: RunTaskCheckpointDistillationOptionsV1 = {},
): Promise<TaskCheckpointDistillationRunResultV1> {
  throwIfAborted(signal);
  if (
    options.loadPayloadEvidence !== undefined &&
    typeof options.loadPayloadEvidence !== "function"
  ) {
    throw new Error("Task checkpoint payload evidence loader is invalid");
  }
  const loadPayloadEvidence = options.loadPayloadEvidence?.bind(options);
  const snapshot = await session.readInputSnapshot();
  const priorClaim = snapshot.entries.find(
    (entry) =>
      entry.fact.type === "context.checkpoint_distillation_claimed" &&
      entry.fact.checkpointId === input.checkpointId,
  )?.fact;
  if (priorClaim?.type === "context.checkpoint_distillation_claimed") {
    assertClaimMatches(priorClaim, input, priorClaim.sourceInputHash);
    return resumeDistillation(
      session,
      input,
      priorClaim.claimId,
      findDistillationState(snapshot.entries, priorClaim.claimId),
      codec,
      signal,
      loadPayloadEvidence,
    );
  }
  assertTaskCheckpointStableBoundaryV1(snapshot, input.boundary);
  const binding = await bindTaskCheckpointSourceV1(
    snapshot,
    input,
    codec,
    signal,
  );
  const claimId = checkpointClaimId({
    checkpointId: input.checkpointId,
    boundary: input.boundary,
    policyVersion: input.policyVersion,
    sourceFromSeq: input.sourceFromSeq,
    sourceThroughSeq: input.sourceThroughSeq,
    sourceInputHash: binding.sourceInputHash,
    ...(binding.supersedesCheckpointId === undefined
      ? {}
      : { supersedesCheckpointId: binding.supersedesCheckpointId }),
  });
  const existing = findDistillationState(snapshot.entries, claimId);
  if (existing.otherPending) {
    return result("busy", claimId, input.checkpointId, 0);
  }
  if (existing.claim) {
    assertClaimMatches(existing.claim, input, binding.sourceInputHash);
    return resumeDistillation(
      session,
      input,
      claimId,
      existing,
      codec,
      signal,
      loadPayloadEvidence,
    );
  }

  const claim: ContextCheckpointDistillationClaimedFactV1 = {
    type: "context.checkpoint_distillation_claimed",
    claimId,
    checkpointId: input.checkpointId,
    boundary: input.boundary,
    ...(binding.supersedesCheckpointId === undefined
      ? {}
      : { supersedesCheckpointId: binding.supersedesCheckpointId }),
    policyVersion: input.policyVersion,
    sourceFromSeq: input.sourceFromSeq,
    sourceThroughSeq: input.sourceThroughSeq,
    sourceInputHash: binding.sourceInputHash,
  };
  if (
    (await session.commitInputFacts(binding.expectedTailSeq, [claim])) !==
    "committed"
  ) {
    return result("conflict", claimId, input.checkpointId, 0);
  }

  let distillerResult: TaskCheckpointDistillerResultV1;
  try {
    distillerResult = await distiller.distill(
      Object.freeze({
        claimId,
        checkpointId: input.checkpointId,
        boundary: input.boundary,
        policyVersion: input.policyVersion,
        sourceFromSeq: input.sourceFromSeq,
        sourceThroughSeq: input.sourceThroughSeq,
        sourceInputHash: binding.sourceInputHash,
        sourceEntries: binding.sourceEntries,
      }),
      { signal },
    );
  } catch (error) {
    distillerResult = signal.aborted
      ? { status: "cancelled", errorCode: "DistillationCancelled" }
      : { status: "unknown", errorCode: errorCode(error) };
  }

  const settlement = await settleDistillation(
    session,
    claimId,
    distillerResult,
    codec,
    signal,
    input.sourceFromSeq,
    input.sourceThroughSeq,
  );
  if (
    settlement.status !== "completed" ||
    settlement.checkpoint === undefined
  ) {
    return result(
      "settled_without_checkpoint",
      claimId,
      input.checkpointId,
      1,
      settlement.status,
    );
  }
  return finalizeSettledCheckpoint(
    session,
    input,
    claimId,
    codec,
    signal,
    1,
    loadPayloadEvidence,
  );
}

async function resumeDistillation(
  session: Session<InputFactV1, unknown>,
  input: RunTaskCheckpointDistillationInputV1,
  claimId: string,
  existing: ReturnType<typeof findDistillationState>,
  codec: TaskCheckpointDistillationCodecV1,
  signal: AbortSignal,
  loadPayloadEvidence:
    | RunTaskCheckpointDistillationOptionsV1["loadPayloadEvidence"]
    | undefined,
): Promise<TaskCheckpointDistillationRunResultV1> {
  if (!existing.claim || !existing.settlement) {
    return result("interrupted", claimId, input.checkpointId, 0);
  }
  if (existing.recorded) {
    return result("reused", claimId, input.checkpointId, 0, "completed");
  }
  if (
    existing.settlement.status !== "completed" ||
    existing.settlement.checkpoint === undefined
  ) {
    return result(
      "settled_without_checkpoint",
      claimId,
      input.checkpointId,
      0,
      existing.settlement.status,
    );
  }
  return finalizeSettledCheckpoint(
    session,
    input,
    claimId,
    codec,
    signal,
    0,
    loadPayloadEvidence,
  );
}

async function settleDistillation(
  session: Session<InputFactV1, unknown>,
  claimId: string,
  value: TaskCheckpointDistillerResultV1,
  codec: TaskCheckpointDistillationCodecV1,
  signal: AbortSignal,
  sourceFromSeq: number,
  sourceThroughSeq: number,
): Promise<ContextCheckpointDistillationSettledFactV1> {
  let settlement: ContextCheckpointDistillationSettledFactV1;
  if (isCompletedResult(value)) {
    try {
      const checkpoint = immutableCanonicalJsonCloneV1(
        parseTaskCheckpointV1(value.checkpoint) as unknown as JsonValue,
      );
      assertCheckpointSourcesInRange(
        checkpoint as unknown as TaskCheckpointV1,
        sourceFromSeq,
        sourceThroughSeq,
      );
      const payload = await codec.encode(checkpoint, signal);
      const expectedHash = await codec.hash(checkpoint);
      if (payload.hash !== expectedHash) {
        throw new Error("Distilled checkpoint payload hash mismatch");
      }
      settlement = {
        type: "context.checkpoint_distillation_settled",
        claimId,
        status: "completed",
        checkpoint: payload,
      };
    } catch (error) {
      settlement = {
        type: "context.checkpoint_distillation_settled",
        claimId,
        status: "unknown",
        errorCode: errorCode(error),
      };
    }
  } else if (isFailureResult(value)) {
    settlement = {
      type: "context.checkpoint_distillation_settled",
      claimId,
      status: value.status,
      errorCode: value.errorCode,
    };
  } else {
    settlement = {
      type: "context.checkpoint_distillation_settled",
      claimId,
      status: "unknown",
      errorCode: "InvalidDistillerResult",
    };
  }
  await session.appendInputFacts([settlement]);
  return settlement;
}

async function finalizeSettledCheckpoint(
  session: Session<InputFactV1, unknown>,
  input: RunTaskCheckpointDistillationInputV1,
  claimId: string,
  codec: TaskCheckpointDistillationCodecV1,
  signal: AbortSignal,
  distillerCalls: 0 | 1,
  loadPayloadEvidence: TaskCheckpointPayloadEvidenceLoaderV1 | undefined,
): Promise<TaskCheckpointDistillationRunResultV1> {
  for (;;) {
    throwIfAborted(signal);
    const snapshot = await session.readInputSnapshot();
    const state = findDistillationState(snapshot.entries, claimId);
    if (!state.claim) {
      throw new Error("Task checkpoint distillation claim disappeared");
    }
    assertClaimMatches(state.claim, input, state.claim.sourceInputHash);
    if (state.recorded) {
      return result(
        "reused",
        claimId,
        input.checkpointId,
        distillerCalls,
        "completed",
      );
    }
    const settlement = state.settlement;
    if (!settlement) {
      return result("interrupted", claimId, input.checkpointId, distillerCalls);
    }
    if (settlement.status !== "completed" || !settlement.checkpoint) {
      return result(
        "settled_without_checkpoint",
        claimId,
        input.checkpointId,
        distillerCalls,
        settlement.status,
      );
    }

    let checkpoint: TaskCheckpointV1 | undefined;
    try {
      let payloadEvidence: VerifiedCanonicalPayloadEvidenceV1 | undefined;
      if (settlement.checkpoint.kind === "artifact_ref") {
        if (!loadPayloadEvidence) {
          return result(
            "invalid_settlement",
            claimId,
            input.checkpointId,
            distillerCalls,
            "completed",
          );
        }
        payloadEvidence = capturePayloadEvidence(
          await loadPayloadEvidence(snapshot, signal),
        );
        payloadEvidence.assertSnapshot(snapshot);
      }
      checkpoint = await resolveCheckpoint(
        settlement.checkpoint,
        codec,
        signal,
        snapshot,
        state.settlementSeq,
        claimId,
        input.checkpointId,
        payloadEvidence,
      );
      if (!checkpoint) {
        return result(
          "invalid_settlement",
          claimId,
          input.checkpointId,
          distillerCalls,
          "completed",
        );
      }
    } catch {
      if (signal.aborted) throwIfAborted(signal);
      return result(
        "invalid_settlement",
        claimId,
        input.checkpointId,
        distillerCalls,
        "completed",
      );
    }

    const committed = await createAndCommitTaskCheckpointFromSnapshotV1(
      session,
      snapshot,
      {
        checkpointId: input.checkpointId,
        policyVersion: input.policyVersion,
        sourceFromSeq: input.sourceFromSeq,
        sourceThroughSeq: input.sourceThroughSeq,
        checkpoint,
        checkpointPayload: settlement.checkpoint,
        distillationClaimId: claimId,
      },
      codec,
      signal,
    );
    if (committed.status === "conflict") {
      return result(
        "conflict",
        claimId,
        input.checkpointId,
        distillerCalls,
        "completed",
      );
    }
    return result(
      "committed",
      claimId,
      input.checkpointId,
      distillerCalls,
      "completed",
    );
  }
}

async function resolveCheckpoint(
  payload: DurableJsonPayloadV1,
  codec: TaskCheckpointDistillationCodecV1,
  signal: AbortSignal,
  snapshot: SessionInputSnapshot<InputFactV1>,
  settlementSeq: number | undefined,
  claimId: string,
  checkpointId: string,
  payloadEvidence: VerifiedCanonicalPayloadEvidenceV1 | undefined,
): Promise<TaskCheckpointV1 | undefined> {
  try {
    const value =
      payload.kind === "inline"
        ? await codec.resolve(payload, signal)
        : payloadEvidence?.requirePayload({
            snapshot,
            location: {
              kind: "task_checkpoint",
              carrierType: "context.checkpoint_distillation_settled",
              carrierSeq: requiredSettlementSeq(settlementSeq),
              claimId,
              checkpointId,
            },
            payload,
          });
    if (value === undefined) return undefined;
    if ((await codec.hash(value)) !== payload.hash) return undefined;
    return parseTaskCheckpointV1(value);
  } catch {
    if (signal.aborted) throwIfAborted(signal);
    return undefined;
  }
}

function requiredSettlementSeq(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    throw new Error("Task checkpoint settlement carrier is missing");
  }
  return value as number;
}

function capturePayloadEvidence(
  evidence: VerifiedCanonicalPayloadEvidenceV1,
): VerifiedCanonicalPayloadEvidenceV1 {
  if (
    !evidence ||
    typeof evidence.assertSnapshot !== "function" ||
    typeof evidence.requireModelResponse !== "function" ||
    typeof evidence.requirePayload !== "function"
  ) {
    throw new Error("Task checkpoint payload evidence is invalid");
  }
  return Object.freeze({
    assertSnapshot: evidence.assertSnapshot.bind(evidence),
    requireModelResponse: evidence.requireModelResponse.bind(evidence),
    requirePayload: evidence.requirePayload.bind(evidence),
  });
}

function findDistillationState(
  entries: readonly { readonly seq: number; readonly fact: InputFactV1 }[],
  claimId: string,
): {
  claim?: ContextCheckpointDistillationClaimedFactV1;
  settlement?: ContextCheckpointDistillationSettledFactV1;
  settlementSeq?: number;
  recorded?: ContextCheckpointRecordedFactV1;
  otherPending: boolean;
} {
  const states = new Map<
    string,
    {
      claim?: ContextCheckpointDistillationClaimedFactV1;
      settlement?: ContextCheckpointDistillationSettledFactV1;
      settlementSeq?: number;
      recorded?: ContextCheckpointRecordedFactV1;
    }
  >();
  for (const entry of entries) {
    const fact = entry.fact;
    if (fact.type === "context.checkpoint_distillation_claimed") {
      states.set(fact.claimId, { claim: fact });
    } else if (fact.type === "context.checkpoint_distillation_settled") {
      const state = states.get(fact.claimId) ?? {};
      state.settlement = fact;
      state.settlementSeq = entry.seq;
      states.set(fact.claimId, state);
    } else if (
      fact.type === "context.checkpoint_recorded" &&
      fact.distillationClaimId
    ) {
      const state = states.get(fact.distillationClaimId) ?? {};
      state.recorded = fact;
      states.set(fact.distillationClaimId, state);
    }
  }
  const otherPending = [...states.entries()].some(
    ([id, state]) =>
      id !== claimId &&
      state.claim !== undefined &&
      (state.settlement === undefined ||
        (state.settlement.status === "completed" &&
          state.recorded === undefined)),
  );
  return { ...states.get(claimId), otherPending };
}

function assertClaimMatches(
  claim: ContextCheckpointDistillationClaimedFactV1,
  input: RunTaskCheckpointDistillationInputV1,
  sourceInputHash: string,
): void {
  if (
    claim.checkpointId !== input.checkpointId ||
    claim.boundary !== input.boundary ||
    claim.policyVersion !== input.policyVersion ||
    claim.sourceFromSeq !== input.sourceFromSeq ||
    claim.sourceThroughSeq !== input.sourceThroughSeq ||
    claim.sourceInputHash !== sourceInputHash
  ) {
    throw new Error("Task checkpoint distillation claim identity mismatch");
  }
}

function assertCheckpointSourcesInRange(
  checkpoint: TaskCheckpointV1,
  sourceFromSeq: number,
  sourceThroughSeq: number,
): void {
  const items = [
    ...(checkpoint.goal ? [checkpoint.goal] : []),
    ...checkpoint.confirmedFacts,
    ...checkpoint.currentHypotheses,
    ...checkpoint.ruledOut,
    ...checkpoint.changedFiles,
    ...checkpoint.verification,
    ...checkpoint.unresolved,
    ...(checkpoint.nextAction ? [checkpoint.nextAction] : []),
  ];
  if (
    items.some((item) =>
      item.sourceSeqs.some(
        (seq) => seq < sourceFromSeq || seq > sourceThroughSeq,
      ),
    )
  ) {
    throw new Error("Distilled checkpoint source is outside its claimed range");
  }
}

function checkpointClaimId(
  identity: Readonly<Record<string, JsonValue | undefined>>,
): string {
  const value = Object.fromEntries(
    Object.entries(identity).filter((entry) => entry[1] !== undefined),
  ) as JsonValue;
  return `checkpoint-claim-${createHash("sha256")
    .update(canonicalJsonStringifyV1(value))
    .digest("hex")}`;
}

function isCompletedResult(
  value: unknown,
): value is Extract<TaskCheckpointDistillerResultV1, { status: "completed" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "completed" &&
    "checkpoint" in value
  );
}

function isFailureResult(
  value: unknown,
): value is Exclude<TaskCheckpointDistillerResultV1, { status: "completed" }> {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { status?: unknown; errorCode?: unknown };
  return (
    (result.status === "failed" ||
      result.status === "cancelled" ||
      result.status === "unknown" ||
      result.status === "truncated") &&
    typeof result.errorCode === "string" &&
    result.errorCode.length > 0
  );
}

function result(
  status: TaskCheckpointDistillationRunResultV1["status"],
  claimId: string,
  checkpointId: string,
  distillerCalls: 0 | 1,
  settlementStatus?: TaskCheckpointDistillationStatusV1,
): TaskCheckpointDistillationRunResultV1 {
  return {
    status,
    claimId,
    checkpointId,
    distillerCalls,
    ...(settlementStatus === undefined ? {} : { settlementStatus }),
  };
}

function errorCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(error.name)
  ) {
    return error.name;
  }
  return "DistillationUnknown";
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(
          String(signal.reason ?? "Task checkpoint distillation aborted"),
        );
  }
}
