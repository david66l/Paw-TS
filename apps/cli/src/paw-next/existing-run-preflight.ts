import { createHash } from "node:crypto";

import {
  type AttemptStartedFactV1,
  type DurableJsonPayloadV1,
  type InputAttachmentV1,
  type InputPromotedFactV1,
  type JsonValue,
  type ModelResponseV1,
  type RunJournalEnvelopeV1,
  parseModelResponseV1,
  parseRunJournalPrefixV1,
  parseTaskCheckpointV1,
} from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./product-manifest.js";

export interface PawNextExistingIdentityV1 {
  readonly inputId: string;
  readonly goal: string;
  readonly configHash: string;
  readonly providerProtocol: "openai-compatible" | "anthropic-compatible";
}

export interface PawNextExistingBootstrapIdentityV1 {
  readonly inputId: string;
  readonly goal: string;
  readonly configHash: string;
}

/** Read the only product bootstrap identity accepted by profile resolution. */
export function readPawNextExistingBootstrapIdentityV1(
  prefix: readonly RunJournalEnvelopeV1[],
): PawNextExistingBootstrapIdentityV1 {
  const canonical = parseRunJournalPrefixV1(prefix);
  const { first, second } = assertUniqueBootstrapFacts(canonical);
  const goal = second.content;
  const goalHash = hashText(goal);
  if (
    first.goalHash !== goalHash ||
    second.contentHash !== goalHash ||
    second.attachments !== undefined
  ) {
    throw new Error("Existing Paw Next bootstrap identity is inconsistent");
  }
  return Object.freeze({
    inputId: second.inputId,
    goal,
    configHash: first.configHash,
  });
}

/** Product identity is stronger than the provider-neutral Protocol shape. */
export function assertPawNextExistingIdentityV1(
  prefix: readonly RunJournalEnvelopeV1[],
  expected: PawNextExistingIdentityV1,
): readonly RunJournalEnvelopeV1[] {
  const canonical = parseRunJournalPrefixV1(prefix);
  const { first, second } = assertUniqueBootstrapFacts(canonical);
  const bootstrap = readPawNextExistingBootstrapIdentityV1(canonical);
  const goalHash = hashText(expected.goal);
  if (
    bootstrap.inputId !== expected.inputId ||
    bootstrap.goal !== expected.goal ||
    bootstrap.configHash !== expected.configHash ||
    first.goalHash !== goalHash ||
    second.contentHash !== goalHash
  ) {
    throw new Error(
      "Existing Paw Next attempt identity or configHash mismatch",
    );
  }
  return canonical;
}

function assertUniqueBootstrapFacts(
  canonical: readonly RunJournalEnvelopeV1[],
): {
  readonly first: AttemptStartedFactV1;
  readonly second: InputPromotedFactV1;
} {
  const first = canonical[0];
  const second = canonical[1];
  if (
    !first ||
    first.seq !== 1 ||
    first.record.kind !== "input_fact" ||
    first.record.fact.type !== "attempt.started"
  ) {
    throw new Error("Existing Paw Next run must start with attempt.started");
  }
  if (
    !second ||
    second.seq !== 2 ||
    second.record.kind !== "input_fact" ||
    second.record.fact.type !== "input.promoted" ||
    second.record.fact.delivery !== "initial"
  ) {
    throw new Error(
      "Existing Paw Next run must contain one initial input immediately after its attempt",
    );
  }
  const attempts = canonical.filter(
    (item) =>
      item.record.kind === "input_fact" &&
      item.record.fact.type === "attempt.started",
  );
  const initials = canonical.filter(
    (item) =>
      item.record.kind === "input_fact" &&
      item.record.fact.type === "input.promoted" &&
      item.record.fact.delivery === "initial",
  );
  if (attempts.length !== 1 || initials.length !== 1) {
    throw new Error("Existing Paw Next run identity facts are not unique");
  }
  return { first: first.record.fact, second: second.record.fact };
}

/**
 * Current product codec is inline-only. Validate every durable payload before
 * repair or any model/tool/input side effect, including historical evidence.
 */
export function assertPawNextInlinePayloadPreflightV1(
  prefix: readonly RunJournalEnvelopeV1[],
  providerProtocol: PawNextExistingIdentityV1["providerProtocol"],
): void {
  const canonical = parseRunJournalPrefixV1(prefix);
  const observations = new Map<
    string,
    Array<{
      readonly callId: string;
      readonly tool: string;
      readonly order: number;
      readonly args: JsonValue;
    }>
  >();
  for (const envelope of canonical) {
    if (envelope.record.kind !== "input_fact") continue;
    const fact = envelope.record.fact;
    switch (fact.type) {
      case "input.accepted":
      case "input.promoted":
        assertAttachmentsInline(fact.attachments, envelope.seq);
        break;
      case "model.settled": {
        if (!fact.response) break;
        const value = assertInlinePayload(fact.response, "model response");
        const response = parseModelResponseV1(value);
        if (response.providerProtocol !== providerProtocol) {
          throw new Error(
            `Existing model response protocol mismatch at journal seq ${envelope.seq}`,
          );
        }
        break;
      }
      case "tool.call_observed": {
        const values = observations.get(fact.modelCallId) ?? [];
        values.push({
          callId: fact.callId,
          tool: fact.tool,
          order: fact.order,
          args: fact.args,
        });
        observations.set(fact.modelCallId, values);
        break;
      }
      case "tool.settled":
        if (fact.result !== undefined || fact.resultHash !== undefined) {
          throw new Error(
            "Existing Paw Next run contains unsupported legacy tool result evidence",
          );
        }
        if (fact.observation?.payload) {
          assertInlinePayload(fact.observation.payload, "tool observation");
        }
        break;
      case "context.checkpoint_distillation_settled":
        if (fact.checkpoint) {
          parseTaskCheckpointV1(
            assertInlinePayload(fact.checkpoint, "distilled checkpoint"),
          );
        }
        break;
      case "context.checkpoint_recorded":
        parseTaskCheckpointV1(
          assertInlinePayload(fact.checkpoint, "context checkpoint"),
        );
        break;
    }
  }
  // Observations are logged after model.settled, so validate a second pass.
  for (const envelope of canonical) {
    if (
      envelope.record.kind !== "input_fact" ||
      envelope.record.fact.type !== "model.settled" ||
      !envelope.record.fact.response
    ) {
      continue;
    }
    const response = parseModelResponseV1(
      assertInlinePayload(envelope.record.fact.response, "model response"),
    );
    assertModelObservations(
      response,
      observations.get(envelope.record.fact.modelCallId) ?? [],
      envelope.seq,
      envelope.record.fact.status,
    );
  }
}

function assertAttachmentsInline(
  attachments: readonly InputAttachmentV1[] | undefined,
  seq: number,
): void {
  for (const attachment of attachments ?? []) {
    const content = assertInlinePayload(
      attachment.content,
      `attachment ${attachment.attachmentId}`,
    );
    if (typeof content !== "string") {
      throw new Error(`Existing attachment at journal seq ${seq} is not text`);
    }
  }
}

function assertInlinePayload(
  payload: DurableJsonPayloadV1,
  label: string,
): JsonValue {
  if (payload.kind !== "inline") {
    throw new Error(`Existing Paw Next ${label} requires an artifact resolver`);
  }
  if (hashCanonicalJsonV1(payload.value) !== payload.hash) {
    throw new Error(`Existing Paw Next ${label} hash mismatch`);
  }
  return payload.value;
}

function assertModelObservations(
  response: ModelResponseV1,
  observed: readonly {
    readonly callId: string;
    readonly tool: string;
    readonly order: number;
    readonly args: JsonValue;
  }[],
  seq: number,
  status:
    | "completed"
    | "truncated"
    | "failed"
    | "cancelled"
    | "unknown"
    | "rejected",
): void {
  if (status === "truncated") {
    if (observed.length !== 0) {
      throw new Error(
        `Truncated native calls cannot have observations at journal seq ${seq}`,
      );
    }
    return;
  }
  const invalid = response.toolCalls.some((call) => !call.argumentsValid);
  if (invalid) {
    if (observed.length !== 0) {
      throw new Error(
        `Invalid native calls cannot have observations at journal seq ${seq}`,
      );
    }
    return;
  }
  if (response.toolCalls.length !== observed.length) {
    throw new Error(
      `Model response/observation count mismatch at journal seq ${seq}`,
    );
  }
  for (const [index, call] of response.toolCalls.entries()) {
    const item = observed[index];
    if (
      !item ||
      item.callId !== call.callId ||
      item.tool !== call.name ||
      item.order !== call.sourceIndex ||
      hashCanonicalJsonV1(item.args) !== hashCanonicalJsonV1(call.args)
    ) {
      throw new Error(
        `Model response/observation identity mismatch at journal seq ${seq}`,
      );
    }
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
