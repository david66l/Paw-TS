import type { SessionInputSnapshot } from "@paw/agent-loop";
import type {
  InputAcceptedFactV1,
  InputAttachmentV1,
  InputFactV1,
  JsonValue,
  RunJournalEnvelopeV1,
} from "@paw/protocol";
import {
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";

import {
  hashCanonicalJsonV1,
  immutableCanonicalJsonCloneV1,
} from "../context/canonical-json.js";
import type { VerifiedCanonicalPayloadEvidenceV1 } from "../payload/verified-model-response-evidence.js";
import { projectCanonicalSessionInputSnapshotV1 } from "../payload/verified-model-response-evidence.js";
import {
  type AcceptInputRequestV1,
  type AcceptInputResultV1,
  createInputAcceptedFactV1,
  projectDurableInputInboxStateV1,
} from "./durable-input-inbox.js";

export interface WorkSegmentInputAdmissionSessionV1 {
  readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]>;
  commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict">;
}

export interface InspectQueuedWorkSegmentInputOptionsV1 {
  readonly fullPrefix: readonly RunJournalEnvelopeV1[];
  readonly request: AcceptInputRequestV1;
  readonly payloadEvidence?: VerifiedCanonicalPayloadEvidenceV1;
}

export type QueuedWorkSegmentInputInspectionV1 = Readonly<{
  status: "new" | "already_accepted";
  inputId: string;
}>;

export interface AcceptQueuedWorkSegmentInputOptionsV1 {
  readonly session: WorkSegmentInputAdmissionSessionV1;
  readonly request: AcceptInputRequestV1;
  readonly preflight: (
    fullPrefix: readonly RunJournalEnvelopeV1[],
    signal: AbortSignal,
  ) =>
    | VerifiedCanonicalPayloadEvidenceV1
    | undefined
    | Promise<VerifiedCanonicalPayloadEvidenceV1 | undefined>;
  /** Pure product feasibility over current + the inline accepted draft. */
  readonly validateProspective: (
    prospectiveFullPrefix: readonly RunJournalEnvelopeV1[],
    signal: AbortSignal,
  ) => void | Promise<void>;
  readonly signal: AbortSignal;
}

/** Strict synchronous request hard gate for product entrypoints. */
export function freezeQueuedWorkSegmentInputRequestV1(
  request: AcceptInputRequestV1,
): AcceptInputRequestV1 {
  assertExactKeys(
    request,
    ["inputId", "delivery", "content", "callerId"],
    ["attachments"],
    "Work segment input request",
  );
  if (request.delivery !== "queue") {
    throw new Error("Work segment input delivery must be queue");
  }
  if (request.attachments !== undefined && request.attachments.length === 0) {
    throw new Error("Work segment attachments must be a non-empty array");
  }
  const attachmentIds = new Set<string>();
  for (const [index, attachment] of (request.attachments ?? []).entries()) {
    assertExactKeys(
      attachment,
      ["attachmentId", "type", "name", "content"],
      ["mimeType"],
      `Work segment attachment ${index}`,
    );
    assertStableId(attachment.attachmentId, `Work segment attachment ${index}`);
    if (attachmentIds.has(attachment.attachmentId)) {
      throw new Error("Work segment attachments contain a duplicate id");
    }
    attachmentIds.add(attachment.attachmentId);
    if (attachment.type !== "image" && attachment.type !== "file") {
      throw new Error("Work segment attachment type is invalid");
    }
    if (typeof attachment.name !== "string" || !attachment.name.trim()) {
      throw new Error("Work segment attachment name must be non-empty");
    }
    if (
      attachment.mimeType !== undefined &&
      (typeof attachment.mimeType !== "string" || !attachment.mimeType.trim())
    ) {
      throw new Error("Work segment attachment mimeType must be non-empty");
    }
    if (
      attachment.content.kind !== "inline" ||
      typeof attachment.content.value !== "string"
    ) {
      throw new Error("Work segment attachment content must be inline string");
    }
    assertExactKeys(
      attachment.content,
      ["kind", "value", "hash"],
      [],
      `Work segment attachment ${index} content`,
    );
    const expectedHash = hashCanonicalJsonV1(attachment.content.value);
    if (attachment.content.hash !== expectedHash) {
      throw new Error("Work segment attachment content hash mismatch");
    }
  }
  const fact = createInputAcceptedFactV1(request);
  return Object.freeze({
    inputId: fact.inputId,
    delivery: "queue",
    content: fact.content,
    callerId: fact.callerId,
    ...(fact.attachments === undefined
      ? {}
      : { attachments: fact.attachments }),
  });
}

/** Inspect one queue-only request against canonical, exact-location evidence. */
export function inspectQueuedWorkSegmentInputV1(
  options: InspectQueuedWorkSegmentInputOptionsV1,
): QueuedWorkSegmentInputInspectionV1 {
  const requestFact = createQueueFact(options.request);
  const prefix = detachedPrefix(options.fullPrefix);
  const snapshot = projectCanonicalSessionInputSnapshotV1(prefix);
  const evidence = options.payloadEvidence;
  evidence?.assertSnapshot(snapshot);
  const acceptedEntries = prefix.flatMap((envelope) =>
    envelope.record.kind === "input_fact" &&
    envelope.record.fact.type === "input.accepted" &&
    envelope.record.fact.inputId === requestFact.inputId
      ? [{ seq: envelope.seq, fact: envelope.record.fact }]
      : [],
  );
  if (acceptedEntries.length > 1) {
    throw new Error(`Duplicate inbox input: ${requestFact.inputId}`);
  }
  const accepted = acceptedEntries[0];
  if (accepted) {
    assertLogicalAcceptedInput(
      accepted.fact,
      accepted.seq,
      requestFact,
      snapshot,
      evidence,
    );
    return Object.freeze({
      status: "already_accepted",
      inputId: requestFact.inputId,
    });
  }
  const collidingPromotion = prefix.some(
    (envelope) =>
      envelope.record.kind === "input_fact" &&
      envelope.record.fact.type === "input.promoted" &&
      envelope.record.fact.inputId === requestFact.inputId,
  );
  if (collidingPromotion) {
    throw new Error(`Input idempotency conflict: ${requestFact.inputId}`);
  }
  const firstQueued =
    projectDurableInputInboxStateV1(snapshot).pendingQueueIds[0];
  if (firstQueued !== undefined && firstQueued !== requestFact.inputId) {
    throw new Error(`Work segment queue is blocked by input: ${firstQueued}`);
  }
  return Object.freeze({ status: "new", inputId: requestFact.inputId });
}

/** Queue admission with logical idempotency and expected-tail CAS. */
export async function acceptQueuedWorkSegmentInputV1(
  options: AcceptQueuedWorkSegmentInputOptionsV1,
): Promise<AcceptInputResultV1> {
  const request = freezeQueuedWorkSegmentInputRequestV1(options.request);
  const fact = createInputAcceptedFactV1(request);
  const signal = options.signal;
  if (!signal || typeof signal.aborted !== "boolean") {
    throw new Error("Work segment input AbortSignal is invalid");
  }
  if (typeof options.preflight !== "function") {
    throw new Error("Work segment input preflight must be a function");
  }
  if (typeof options.validateProspective !== "function") {
    throw new Error("Work segment input prospective validator is invalid");
  }
  const session = captureSession(options.session);
  const preflight = options.preflight.bind(options);
  const validateProspective = options.validateProspective.bind(options);
  while (true) {
    throwIfAborted(signal);
    const prefix = detachedPrefix(await session.readCanonicalPrefix());
    throwIfAborted(signal);
    const evidence = await preflight(prefix, signal);
    throwIfAborted(signal);
    const inspected = inspectQueuedWorkSegmentInputV1({
      fullPrefix: prefix,
      request,
      ...(evidence === undefined ? {} : { payloadEvidence: evidence }),
    });
    if (inspected.status === "already_accepted") {
      return Object.freeze({
        status: "already_accepted",
        inputId: fact.inputId,
      });
    }
    throwIfAborted(signal);
    const prospective = appendAcceptedCandidate(prefix, fact);
    await validateProspective(prospective, signal);
    throwIfAborted(signal);
    const committed = await session.commitInputFacts(prefix.length, [fact]);
    if (committed === "committed") {
      return Object.freeze({ status: "accepted", inputId: fact.inputId });
    }
  }
}

function appendAcceptedCandidate(
  prefix: readonly RunJournalEnvelopeV1[],
  fact: InputAcceptedFactV1,
): readonly RunJournalEnvelopeV1[] {
  const tail = prefix.at(-1);
  if (!tail) {
    throw new Error("Work segment input requires an identity-bound run");
  }
  return parseRunJournalPrefixV1([
    ...prefix,
    {
      schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
      sessionId: tail.sessionId,
      runId: tail.runId,
      seq: tail.seq + 1,
      ts: tail.ts,
      record: { kind: "input_fact", fact },
    },
  ]);
}

function createQueueFact(request: AcceptInputRequestV1): InputAcceptedFactV1 {
  return createInputAcceptedFactV1(
    freezeQueuedWorkSegmentInputRequestV1(request),
  );
}

function assertLogicalAcceptedInput(
  existing: InputAcceptedFactV1,
  carrierSeq: number,
  requested: InputAcceptedFactV1,
  snapshot: SessionInputSnapshot<InputFactV1>,
  evidence: VerifiedCanonicalPayloadEvidenceV1 | undefined,
): void {
  if (
    existing.delivery !== "queue" ||
    existing.content !== requested.content ||
    existing.contentHash !== requested.contentHash ||
    existing.callerId !== requested.callerId
  ) {
    throw new Error(`Input idempotency conflict: ${requested.inputId}`);
  }
  const left = existing.attachments ?? [];
  const right = requested.attachments ?? [];
  if (left.length !== right.length) {
    throw new Error(`Input idempotency conflict: ${requested.inputId}`);
  }
  for (const [index, existingAttachment] of left.entries()) {
    const requestedAttachment = right[index];
    if (
      !requestedAttachment ||
      !sameAttachmentMetadata(existingAttachment, requestedAttachment) ||
      requestedAttachment.content.kind !== "inline" ||
      typeof requestedAttachment.content.value !== "string"
    ) {
      throw new Error(`Input idempotency conflict: ${requested.inputId}`);
    }
    const existingValue =
      existingAttachment.content.kind === "inline"
        ? existingAttachment.content.value
        : evidence?.requirePayload({
            snapshot,
            location: {
              kind: "input_attachment",
              carrierType: "input.accepted",
              carrierSeq,
              attachmentIndex: index,
              inputId: existing.inputId,
              attachmentId: existingAttachment.attachmentId,
            },
            payload: existingAttachment.content,
          });
    if (
      typeof existingValue !== "string" ||
      existingValue !== requestedAttachment.content.value ||
      existingAttachment.content.hash !== requestedAttachment.content.hash
    ) {
      throw new Error(`Input idempotency conflict: ${requested.inputId}`);
    }
  }
}

function sameAttachmentMetadata(
  left: InputAttachmentV1,
  right: InputAttachmentV1,
): boolean {
  return (
    left.attachmentId === right.attachmentId &&
    left.type === right.type &&
    left.name === right.name &&
    left.mimeType === right.mimeType
  );
}

function captureSession(
  session: WorkSegmentInputAdmissionSessionV1,
): WorkSegmentInputAdmissionSessionV1 {
  if (
    !session ||
    typeof session.readCanonicalPrefix !== "function" ||
    typeof session.commitInputFacts !== "function"
  ) {
    throw new Error("Work segment input Session port is invalid");
  }
  return Object.freeze({
    readCanonicalPrefix: session.readCanonicalPrefix.bind(session),
    commitInputFacts: session.commitInputFacts.bind(session),
  });
}

function detachedPrefix(
  prefix: readonly RunJournalEnvelopeV1[],
): readonly RunJournalEnvelopeV1[] {
  return immutableCanonicalJsonCloneV1(
    parseRunJournalPrefixV1(prefix) as unknown as JsonValue,
  ) as unknown as readonly RunJournalEnvelopeV1[];
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function assertExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function assertStableId(
  value: unknown,
  label: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value)
  ) {
    throw new Error(`${label} must have a stable id`);
  }
}
