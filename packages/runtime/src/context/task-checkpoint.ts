import type { Session, SessionInputSnapshot } from "@paw/agent-loop";
import {
  type ContextCheckpointRecordedFactV1,
  type DurableJsonPayloadV1,
  type InputFactV1,
  type JsonValue,
  type TaskCheckpointItemV1,
  type TaskCheckpointV1,
  parseTaskCheckpointV1,
} from "@paw/protocol";
import { immutableCanonicalJsonCloneV1 } from "./canonical-json.js";
import { planTaskCheckpointReplacementV1 } from "./journal-context.js";

/** Storage choice is injected; generation never owns an artifact store. */
export interface TaskCheckpointPayloadCodecV1 {
  encode(
    value: JsonValue,
    signal: AbortSignal,
  ): DurableJsonPayloadV1 | Promise<DurableJsonPayloadV1>;
  hash(value: JsonValue): string | Promise<string>;
}

export interface TaskCheckpointSourceInputV1 {
  readonly checkpointId: string;
  readonly policyVersion: string;
  readonly sourceFromSeq: number;
  readonly sourceThroughSeq: number;
}

export interface CreateTaskCheckpointInputV1
  extends TaskCheckpointSourceInputV1 {
  readonly checkpoint: TaskCheckpointV1;
  readonly distillationClaimId?: string;
  readonly checkpointPayload?: DurableJsonPayloadV1;
}

export interface TaskCheckpointCommitResultV1 {
  readonly status: "committed" | "conflict";
  readonly fact?: ContextCheckpointRecordedFactV1;
}

export interface TaskCheckpointSourceBindingV1 {
  readonly expectedTailSeq: number;
  readonly sourceInputHash: string;
  readonly supersedesCheckpointId?: string;
  readonly sourceEntries: readonly {
    readonly seq: number;
    readonly fact: InputFactV1;
  }[];
}

/**
 * Generate and CAS-commit one structured checkpoint against one Session.
 * Reading and committing stay inside this function so a prepared checkpoint
 * cannot be moved to another run with the same tail sequence.
 */
export async function createAndCommitTaskCheckpointV1(
  session: Session<InputFactV1, unknown>,
  input: CreateTaskCheckpointInputV1,
  codec: TaskCheckpointPayloadCodecV1,
  signal: AbortSignal,
): Promise<TaskCheckpointCommitResultV1> {
  const snapshot = await session.readInputSnapshot();
  return createAndCommitTaskCheckpointFromSnapshotV1(
    session,
    snapshot,
    input,
    codec,
    signal,
  );
}

/** Commit against the exact snapshot already used by an evidence projection. */
export async function createAndCommitTaskCheckpointFromSnapshotV1(
  session: Session<InputFactV1, unknown>,
  snapshot: SessionInputSnapshot<InputFactV1>,
  input: CreateTaskCheckpointInputV1,
  codec: TaskCheckpointPayloadCodecV1,
  signal: AbortSignal,
): Promise<TaskCheckpointCommitResultV1> {
  const fact = await prepareTaskCheckpointFactV1(
    snapshot,
    input,
    codec,
    signal,
  );
  const status = await session.commitInputFacts(snapshot.tailSeq, [fact]);
  return status === "committed" ? { status, fact } : { status };
}

async function prepareTaskCheckpointFactV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  input: CreateTaskCheckpointInputV1,
  codec: TaskCheckpointPayloadCodecV1,
  signal: AbortSignal,
): Promise<ContextCheckpointRecordedFactV1> {
  const binding = await bindTaskCheckpointSourceV1(
    snapshot,
    input,
    codec,
    signal,
  );
  if (
    input.distillationClaimId !== undefined &&
    !isStableId(input.distillationClaimId)
  ) {
    throw new Error("Task checkpoint distillation claim id is invalid");
  }
  const checkpoint = parseTaskCheckpointV1(input.checkpoint);
  const sourceSeqs = new Set(binding.sourceEntries.map((entry) => entry.seq));
  for (const item of checkpointItems(checkpoint)) {
    for (const sourceSeq of item.sourceSeqs) {
      if (!sourceSeqs.has(sourceSeq)) {
        throw new Error(
          `Task checkpoint references missing input fact seq ${sourceSeq}`,
        );
      }
    }
  }

  const checkpointValue = immutableCanonicalJsonCloneV1(
    checkpoint as unknown as JsonValue,
  );
  parseTaskCheckpointV1(checkpointValue);
  const payload =
    input.checkpointPayload ?? (await codec.encode(checkpointValue, signal));
  throwIfAborted(signal);
  const checkpointHash = await codec.hash(checkpointValue);
  assertHash(checkpointHash, "checkpoint content");
  if (payload.hash !== checkpointHash) {
    throw new Error("Task checkpoint payload hash does not match its content");
  }

  return {
    type: "context.checkpoint_recorded",
    checkpointId: input.checkpointId,
    ...(input.distillationClaimId === undefined
      ? {}
      : { distillationClaimId: input.distillationClaimId }),
    ...(binding.supersedesCheckpointId === undefined
      ? {}
      : { supersedesCheckpointId: binding.supersedesCheckpointId }),
    policyVersion: input.policyVersion,
    sourceFromSeq: input.sourceFromSeq,
    sourceThroughSeq: input.sourceThroughSeq,
    sourceInputHash: binding.sourceInputHash,
    checkpoint: payload,
  };
}

export async function bindTaskCheckpointSourceV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  input: TaskCheckpointSourceInputV1,
  codec: Pick<TaskCheckpointPayloadCodecV1, "hash">,
  signal: AbortSignal,
): Promise<TaskCheckpointSourceBindingV1> {
  throwIfAborted(signal);
  assertSnapshotOrder(snapshot);
  if (
    !isStableId(input.checkpointId) ||
    !isStableId(input.policyVersion) ||
    !Number.isSafeInteger(input.sourceFromSeq) ||
    input.sourceFromSeq <= 0 ||
    !Number.isSafeInteger(input.sourceThroughSeq) ||
    input.sourceThroughSeq < input.sourceFromSeq ||
    input.sourceThroughSeq > snapshot.tailSeq
  ) {
    throw new Error("Task checkpoint generation input is invalid");
  }
  const priorCheckpoints = snapshot.entries.filter(
    (
      entry,
    ): entry is {
      readonly seq: number;
      readonly fact: ContextCheckpointRecordedFactV1;
    } => entry.fact.type === "context.checkpoint_recorded",
  );
  if (
    priorCheckpoints.some(
      (entry) => entry.fact.checkpointId === input.checkpointId,
    )
  ) {
    throw new Error("Task checkpoint id already exists in this run");
  }
  const latestCheckpoint = priorCheckpoints.at(-1)?.fact;
  if (
    latestCheckpoint &&
    (input.sourceFromSeq > latestCheckpoint.sourceFromSeq ||
      input.sourceThroughSeq < latestCheckpoint.sourceThroughSeq)
  ) {
    throw new Error("Task checkpoint source range must monotonically expand");
  }
  planTaskCheckpointReplacementV1(
    snapshot,
    input.sourceFromSeq,
    input.sourceThroughSeq,
  );
  const sourceEntries = snapshot.entries.filter(
    (entry) =>
      entry.seq >= input.sourceFromSeq && entry.seq <= input.sourceThroughSeq,
  );
  if (sourceEntries.length === 0) {
    throw new Error("Task checkpoint source range has no input facts");
  }
  const sourceValue = immutableCanonicalJsonCloneV1(
    sourceEntries.map((entry) => ({
      seq: entry.seq,
      fact: entry.fact,
    })) as unknown as JsonValue,
  );
  const sourceInputHash = await codec.hash(sourceValue);
  assertHash(sourceInputHash, "source input");
  throwIfAborted(signal);
  return {
    expectedTailSeq: snapshot.tailSeq,
    sourceInputHash,
    ...(latestCheckpoint
      ? { supersedesCheckpointId: latestCheckpoint.checkpointId }
      : {}),
    sourceEntries: sourceValue as unknown as readonly {
      readonly seq: number;
      readonly fact: InputFactV1;
    }[],
  };
}

function assertSnapshotOrder(
  snapshot: SessionInputSnapshot<InputFactV1>,
): void {
  let previousSeq = 0;
  for (const entry of snapshot.entries) {
    if (entry.seq <= previousSeq || entry.seq > snapshot.tailSeq) {
      throw new Error("Task checkpoint snapshot input seq order is invalid");
    }
    previousSeq = entry.seq;
  }
  if (
    snapshot.tailSeq < snapshot.latestInputSeq ||
    snapshot.latestInputSeq !== previousSeq
  ) {
    throw new Error("Task checkpoint snapshot metadata is inconsistent");
  }
}

function checkpointItems(
  checkpoint: TaskCheckpointV1,
): readonly TaskCheckpointItemV1[] {
  return [
    ...(checkpoint.goal ? [checkpoint.goal] : []),
    ...checkpoint.confirmedFacts,
    ...checkpoint.currentHypotheses,
    ...checkpoint.ruledOut,
    ...checkpoint.changedFiles,
    ...checkpoint.verification,
    ...checkpoint.unresolved,
    ...(checkpoint.nextAction ? [checkpoint.nextAction] : []),
  ];
}

function assertHash(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8_192 ||
    hasControlCharacter(value)
  ) {
    throw new Error(`Task checkpoint ${field} hash is invalid`);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

function isStableId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(
          String(signal.reason ?? "Task checkpoint generation aborted"),
        );
  }
}
