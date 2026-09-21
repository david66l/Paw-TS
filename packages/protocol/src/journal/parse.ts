/** The public parse/assert/is surface for journal wire values. */
import type { RunJournalEnvelopeV1 } from "./facts.js";
import { assertLifecycleIdentities, assertRecord } from "./validate-lifecycle.js";
import {
  assertExact,
  assertExactKeys,
  assertId,
  assertNonNegativeInteger,
  assertPositiveInteger,
  expectObject,
} from "./validate-primitives.js";
import {
  assertModelResponse,
  assertTaskCheckpoint,
  assertToolObservation,
} from "./validate-wire.js";
import { RUN_JOURNAL_SCHEMA_VERSION_V1 } from "./versions.js";
import type { ModelResponseV1 } from "./wire-model-response.js";
import type { TaskCheckpointV1 } from "./wire-task-checkpoint.js";
import type { ToolObservationV1 } from "./wire-tool.js";

/** Parse a durable model response without importing a provider or runtime. */
export function parseModelResponseV1(value: unknown): ModelResponseV1 {
  assertModelResponse(value);
  return value as ModelResponseV1;
}

export function assertModelResponseV1(value: unknown): asserts value is ModelResponseV1 {
  assertModelResponse(value);
}

export function isModelResponseV1(value: unknown): value is ModelResponseV1 {
  try {
    parseModelResponseV1(value);
    return true;
  } catch {
    return false;
  }
}

export function parseToolObservationV1(value: unknown): ToolObservationV1 {
  assertToolObservation(value, "tool observation");
  return value as ToolObservationV1;
}

export function assertToolObservationV1(value: unknown): asserts value is ToolObservationV1 {
  assertToolObservation(value, "tool observation");
}

export function isToolObservationV1(value: unknown): value is ToolObservationV1 {
  try {
    parseToolObservationV1(value);
    return true;
  } catch {
    return false;
  }
}

export function parseTaskCheckpointV1(value: unknown): TaskCheckpointV1 {
  assertTaskCheckpoint(value, "task checkpoint");
  return value;
}

export function assertTaskCheckpointV1(value: unknown): asserts value is TaskCheckpointV1 {
  assertTaskCheckpoint(value, "task checkpoint");
}

export function isTaskCheckpointV1(value: unknown): value is TaskCheckpointV1 {
  try {
    parseTaskCheckpointV1(value);
    return true;
  } catch {
    return false;
  }
}

/** Parse and strictly validate an untrusted Paw Next journal value. */
export function parseRunJournalEnvelopeV1(value: unknown): RunJournalEnvelopeV1 {
  const envelope = expectObject(value, "journal envelope");
  assertExactKeys(
    envelope,
    ["schemaVersion", "sessionId", "runId", "seq", "ts", "record"],
    [],
    "journal envelope",
  );
  assertExact(envelope.schemaVersion, RUN_JOURNAL_SCHEMA_VERSION_V1, "schemaVersion");
  assertId(envelope.sessionId, "sessionId");
  assertId(envelope.runId, "runId");
  assertPositiveInteger(envelope.seq, "seq");
  assertNonNegativeInteger(envelope.ts, "ts");
  assertRecord(envelope.record);

  const record = envelope.record;
  if (
    record.kind === "derived_decision" &&
    record.decision.inputThroughSeq >= (envelope.seq as number)
  ) {
    throw new Error("inputThroughSeq must precede the decision envelope");
  }
  return value as RunJournalEnvelopeV1;
}

export function assertRunJournalEnvelopeV1(value: unknown): asserts value is RunJournalEnvelopeV1 {
  parseRunJournalEnvelopeV1(value);
}

/** Validate that two canonical envelopes form one contiguous run prefix. */
export function assertRunJournalEnvelopeCanFollowV1(
  previous: RunJournalEnvelopeV1,
  next: RunJournalEnvelopeV1,
): void {
  parseRunJournalEnvelopeV1(previous);
  parseRunJournalEnvelopeV1(next);
  if (next.sessionId !== previous.sessionId) {
    throw new Error("journal sessionId changed within one run");
  }
  if (next.runId !== previous.runId) {
    throw new Error("journal runId changed within one run");
  }
  if (next.seq !== previous.seq + 1) {
    throw new Error("journal seq must be contiguous");
  }
  if (next.record.kind === "derived_decision") {
    if (previous.record.kind !== "input_fact") {
      throw new Error("derived decision must immediately follow an input fact");
    }
    if (next.record.decision.inputThroughSeq !== previous.seq) {
      throw new Error("derived decision inputThroughSeq is stale");
    }
  }
}

/** Parse a complete authoritative prefix and validate its ordering invariants. */
export function parseRunJournalPrefixV1(
  values: readonly unknown[],
): readonly RunJournalEnvelopeV1[] {
  const envelopes = values.map(parseRunJournalEnvelopeV1);
  const first = envelopes[0];
  if (first && first.seq !== 1) {
    throw new Error("journal prefix must start at seq 1");
  }
  for (let index = 1; index < envelopes.length; index += 1) {
    assertRunJournalEnvelopeCanFollowV1(
      envelopes[index - 1] as RunJournalEnvelopeV1,
      envelopes[index] as RunJournalEnvelopeV1,
    );
  }
  assertLifecycleIdentities(envelopes);
  return envelopes;
}

export function isRunJournalEnvelopeV1(value: unknown): value is RunJournalEnvelopeV1 {
  try {
    parseRunJournalEnvelopeV1(value);
    return true;
  } catch {
    return false;
  }
}
