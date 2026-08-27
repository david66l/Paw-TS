import { createHash } from "node:crypto";

import type {
  DurableJsonPayloadV1,
  InputFactV1,
  JsonValue,
  ModelResponseV1,
  ModelSettledFactV1,
  RunJournalEnvelopeV1,
} from "@paw/protocol";
import {
  parseModelResponseV1,
  parseRunJournalPrefixV1,
  parseTaskCheckpointV1,
} from "@paw/protocol";

import {
  canonicalJsonStringifyV1,
  immutableCanonicalJsonCloneV1,
} from "../context/canonical-json.js";
import {
  type CanonicalDurableJsonPayloadLocationV1,
  type DurableJsonPayloadBindingV1,
  projectCanonicalDurableJsonPayloadBindingsV1,
} from "./canonical-payload-binding.js";
import type { CanonicalPayloadIdentityV1 } from "./canonical-payload-identity.js";

export const VERIFIED_CANONICAL_PAYLOAD_INDEX_VERSION_V1 =
  "paw.verified-canonical-payload-index.v1" as const;
export const VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1 =
  "paw.verified-canonical-payload-budget.v1" as const;

const issuedVerifiedIndexes = new WeakSet<object>();

export interface VerifiedCanonicalPayloadBudgetV1 {
  readonly policyVersion: typeof VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1;
  readonly maxTotalBytes: number;
}

export interface CanonicalDurableJsonPayloadResolverV1 {
  readCanonicalPayloadIdentity(): CanonicalPayloadIdentityV1;
  resolve(
    payload: DurableJsonPayloadV1,
    expectedBinding: DurableJsonPayloadBindingV1,
    signal?: AbortSignal,
  ): JsonValue | Promise<JsonValue>;
  hash(value: JsonValue): string | Promise<string>;
}

export interface VerifiedCanonicalPayloadOccurrenceV1 {
  readonly location: CanonicalDurableJsonPayloadLocationV1;
  readonly binding: DurableJsonPayloadBindingV1;
  readonly payload: DurableJsonPayloadV1;
  readonly value: JsonValue;
}

export interface VerifiedCanonicalPayloadOccurrenceLookupV1 {
  readonly location: CanonicalDurableJsonPayloadLocationV1;
  readonly payload: DurableJsonPayloadV1;
}

export interface VerifiedCanonicalModelResponseLookupV1 {
  readonly carrierSeq: number;
  readonly modelCallId: string;
  readonly payload: DurableJsonPayloadV1;
}

export interface VerifiedCanonicalPayloadIndexV1 {
  readonly indexVersion: typeof VERIFIED_CANONICAL_PAYLOAD_INDEX_VERSION_V1;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly tailSeq: number;
  /** sha256 of the canonical JSON encoding of the exact full prefix. */
  readonly prefixDigest: string;
  readonly budget: VerifiedCanonicalPayloadBudgetV1;
  readonly totalBytes: number;
  readonly occurrences: readonly VerifiedCanonicalPayloadOccurrenceV1[];
  findOccurrence(
    lookup: VerifiedCanonicalPayloadOccurrenceLookupV1,
  ): VerifiedCanonicalPayloadOccurrenceV1 | undefined;
  requireOccurrence(
    lookup: VerifiedCanonicalPayloadOccurrenceLookupV1,
  ): VerifiedCanonicalPayloadOccurrenceV1;
  findModelResponse(
    lookup: VerifiedCanonicalModelResponseLookupV1,
  ): ModelResponseV1 | undefined;
  requireModelResponse(
    lookup: VerifiedCanonicalModelResponseLookupV1,
  ): ModelResponseV1;
}

export interface BuildVerifiedCanonicalPayloadIndexOptionsV1 {
  readonly fullPrefix: readonly RunJournalEnvelopeV1[];
  readonly resolver: CanonicalDurableJsonPayloadResolverV1;
  readonly budget: VerifiedCanonicalPayloadBudgetV1;
  readonly signal?: AbortSignal;
}

export interface AssertVerifiedCanonicalPayloadIndexMatchesOptionsV1 {
  readonly fullPrefix: readonly RunJournalEnvelopeV1[];
  readonly identity: CanonicalPayloadIdentityV1;
  readonly budget: VerifiedCanonicalPayloadBudgetV1;
}

/** Strict, detached policy value shared by every full-prefix verifier. */
export function freezeVerifiedCanonicalPayloadBudgetV1(
  value: VerifiedCanonicalPayloadBudgetV1,
): VerifiedCanonicalPayloadBudgetV1 {
  return parseBudget(value);
}

/**
 * Build invocation-scoped evidence for one exact authoritative prefix.
 *
 * The index is detached and immutable. It is neither durable authority nor a
 * cache: callers must discard it after any successful journal mutation.
 */
export async function buildVerifiedCanonicalPayloadIndexV1(
  options: BuildVerifiedCanonicalPayloadIndexOptionsV1,
): Promise<VerifiedCanonicalPayloadIndexV1> {
  const budget = parseBudget(options.budget);
  const prefix = freezePrefix(parseRunJournalPrefixV1(options.fullPrefix));
  const first = prefix[0];
  if (!first) {
    throw new Error(
      "Verified canonical payload index requires a non-empty identity-bound prefix",
    );
  }
  const resolver = captureResolver(options.resolver);
  const identity = parseCanonicalPayloadIdentity(
    resolver.readCanonicalPayloadIdentity(),
  );
  if (
    identity.sessionId !== first.sessionId ||
    identity.runId !== first.runId
  ) {
    throw new Error("Canonical payload resolver journal identity mismatch");
  }
  const projected = projectCanonicalDurableJsonPayloadBindingsV1(prefix);
  const resolvedByBinding = new Map<string, JsonValue>();
  const payloadByBinding = new Map<string, string>();
  const verified: VerifiedCanonicalPayloadOccurrenceV1[] = [];
  let totalBytes = 0;

  for (const occurrence of projected) {
    throwIfAborted(options.signal);
    const bindingKey = canonicalJsonStringifyV1(
      occurrence.binding as unknown as JsonValue,
    );
    const payloadKey = canonicalJsonStringifyV1(
      occurrence.payload as unknown as JsonValue,
    );
    const earlierPayload = payloadByBinding.get(bindingKey);
    if (earlierPayload !== undefined && earlierPayload !== payloadKey) {
      throw new Error(
        "Canonical durable JSON payload binding has conflicting carriers",
      );
    }
    payloadByBinding.set(bindingKey, payloadKey);

    let value = resolvedByBinding.get(bindingKey);
    if (value === undefined) {
      const resolved =
        occurrence.payload.kind === "inline"
          ? occurrence.payload.value
          : await resolver.resolve(
              occurrence.payload,
              occurrence.binding,
              options.signal,
            );
      throwIfAborted(options.signal);
      value = immutableCanonicalJsonCloneV1(resolved);
      const actualHash = await resolver.hash(value);
      throwIfAborted(options.signal);
      if (actualHash !== occurrence.payload.hash) {
        throw new Error("Canonical durable JSON payload hash mismatch");
      }
      const byteLength = canonicalUtf8ByteLength(value);
      if (
        byteLength > budget.maxTotalBytes ||
        totalBytes > budget.maxTotalBytes - byteLength
      ) {
        throw new Error(
          "Canonical durable JSON payload total byte budget exceeded",
        );
      }
      totalBytes += byteLength;
      resolvedByBinding.set(bindingKey, value);
    }

    assertOccurrenceValue(occurrence.location, value, prefix);
    verified.push(
      Object.freeze({
        location: occurrence.location,
        binding: occurrence.binding,
        payload: occurrence.payload,
        value,
      }),
    );
  }
  assertModelResponseObservationIdentity(prefix, verified);

  const occurrences = Object.freeze(verified);
  const byLocation = new Map<string, VerifiedCanonicalPayloadOccurrenceV1>();
  const modelResponses = new Map<string, ModelResponseV1>();
  for (const occurrence of occurrences) {
    const locationKey = canonicalJsonStringifyV1(
      occurrence.location as unknown as JsonValue,
    );
    if (byLocation.has(locationKey)) {
      throw new Error("Duplicate canonical durable JSON payload location");
    }
    byLocation.set(locationKey, occurrence);
    if (occurrence.location.kind === "model_response") {
      const response = immutableCanonicalJsonCloneV1(
        parseModelResponseV1(occurrence.value) as unknown as JsonValue,
      ) as unknown as ModelResponseV1;
      const modelKey = modelResponseKey({
        carrierSeq: occurrence.location.carrierSeq,
        modelCallId: occurrence.location.modelCallId,
        payload: occurrence.payload,
      });
      if (modelResponses.has(modelKey)) {
        throw new Error("Duplicate verified model response identity");
      }
      modelResponses.set(modelKey, response);
    }
  }

  const prefixDigest = digestPrefix(prefix);
  const index: VerifiedCanonicalPayloadIndexV1 = {
    indexVersion: VERIFIED_CANONICAL_PAYLOAD_INDEX_VERSION_V1,
    workspaceRoot: identity.workspaceRoot,
    sessionId: first.sessionId,
    runId: first.runId,
    tailSeq: prefix.length,
    prefixDigest,
    budget,
    totalBytes,
    occurrences,
    findOccurrence(lookup) {
      return findExactOccurrence(byLocation, lookup);
    },
    requireOccurrence(lookup) {
      const occurrence = findExactOccurrence(byLocation, lookup);
      if (!occurrence) {
        throw new Error("Verified canonical payload occurrence is missing");
      }
      return occurrence;
    },
    findModelResponse(lookup) {
      return modelResponses.get(modelResponseKey(lookup));
    },
    requireModelResponse(lookup) {
      const response = modelResponses.get(modelResponseKey(lookup));
      if (!response) {
        throw new Error("Verified canonical model response is missing");
      }
      return response;
    },
  };
  issuedVerifiedIndexes.add(index);
  return Object.freeze(index);
}

export function assertVerifiedCanonicalPayloadIndexMatchesV1(
  index: VerifiedCanonicalPayloadIndexV1,
  options: AssertVerifiedCanonicalPayloadIndexMatchesOptionsV1,
): void {
  if (
    !index ||
    typeof index !== "object" ||
    !issuedVerifiedIndexes.has(index)
  ) {
    throw new Error("Verified canonical payload index was not issued here");
  }
  const prefix = freezePrefix(parseRunJournalPrefixV1(options.fullPrefix));
  const first = prefix[0];
  const identity = parseCanonicalPayloadIdentity(options.identity);
  const budget = parseBudget(options.budget);
  if (
    !first ||
    index.indexVersion !== VERIFIED_CANONICAL_PAYLOAD_INDEX_VERSION_V1 ||
    index.workspaceRoot !== identity.workspaceRoot ||
    index.sessionId !== first.sessionId ||
    index.runId !== first.runId ||
    index.sessionId !== identity.sessionId ||
    index.runId !== identity.runId ||
    index.tailSeq !== prefix.length ||
    index.prefixDigest !== digestPrefix(prefix) ||
    index.budget.policyVersion !== budget.policyVersion ||
    index.budget.maxTotalBytes !== budget.maxTotalBytes
  ) {
    throw new Error("Verified canonical payload index prefix mismatch");
  }
}

function captureResolver(
  value: CanonicalDurableJsonPayloadResolverV1,
): CanonicalDurableJsonPayloadResolverV1 {
  if (
    !value ||
    typeof value.readCanonicalPayloadIdentity !== "function" ||
    typeof value.resolve !== "function" ||
    typeof value.hash !== "function"
  ) {
    throw new Error("Canonical durable JSON payload resolver is invalid");
  }
  return Object.freeze({
    readCanonicalPayloadIdentity:
      value.readCanonicalPayloadIdentity.bind(value),
    resolve: value.resolve.bind(value),
    hash: value.hash.bind(value),
  });
}

function assertOccurrenceValue(
  location: CanonicalDurableJsonPayloadLocationV1,
  value: JsonValue,
  prefix: readonly RunJournalEnvelopeV1[],
): void {
  switch (location.kind) {
    case "input_attachment":
      if (typeof value !== "string") {
        throw new Error("Canonical input attachment payload must be text");
      }
      return;
    case "model_response":
      parseModelResponseV1(value);
      return;
    case "tool_observation":
      return;
    case "task_checkpoint": {
      const checkpoint = parseTaskCheckpointV1(value);
      const envelope = prefix[location.carrierSeq - 1];
      if (!envelope || envelope.record.kind !== "input_fact") {
        throw new Error("Checkpoint payload carrier is missing");
      }
      const fact = envelope.record.fact;
      if (
        fact.type !== "context.checkpoint_distillation_settled" &&
        fact.type !== "context.checkpoint_recorded"
      ) {
        throw new Error("Checkpoint payload carrier is invalid");
      }
      const source =
        fact.type === "context.checkpoint_recorded"
          ? fact
          : findCheckpointClaim(prefix, fact.claimId);
      assertCheckpointSourceRange(
        checkpoint,
        source.sourceFromSeq,
        source.sourceThroughSeq,
      );
      return;
    }
  }
}

function assertModelResponseObservationIdentity(
  prefix: readonly RunJournalEnvelopeV1[],
  occurrences: readonly VerifiedCanonicalPayloadOccurrenceV1[],
): void {
  const observations = new Map<
    string,
    Array<{
      readonly callId: string;
      readonly tool: string;
      readonly order: number;
      readonly args: JsonValue;
    }>
  >();
  for (const envelope of prefix) {
    if (
      envelope.record.kind === "input_fact" &&
      envelope.record.fact.type === "tool.call_observed"
    ) {
      const fact = envelope.record.fact;
      const items = observations.get(fact.modelCallId) ?? [];
      items.push({
        callId: fact.callId,
        tool: fact.tool,
        order: fact.order,
        args: fact.args,
      });
      observations.set(fact.modelCallId, items);
    }
  }
  for (const occurrence of occurrences) {
    if (occurrence.location.kind !== "model_response") continue;
    const response = parseModelResponseV1(occurrence.value);
    const envelope = prefix[occurrence.location.carrierSeq - 1];
    if (
      !envelope ||
      envelope.record.kind !== "input_fact" ||
      envelope.record.fact.type !== "model.settled"
    ) {
      throw new Error("Model response carrier is missing");
    }
    const fact = envelope.record.fact;
    assertCanonicalModelResponseCarrierV1(fact, response);
    const observed = observations.get(fact.modelCallId) ?? [];
    if (
      fact.status === "truncated" ||
      response.toolCalls.some((call) => !call.argumentsValid)
    ) {
      if (observed.length !== 0) {
        throw new Error("Invalid or truncated model calls have observations");
      }
      continue;
    }
    if (response.toolCalls.length !== observed.length) {
      throw new Error("Model response/observation count mismatch");
    }
    response.toolCalls.forEach((call, callIndex) => {
      const item = observed[callIndex];
      if (
        !item ||
        item.callId !== call.callId ||
        item.tool !== call.name ||
        item.order !== call.sourceIndex ||
        canonicalJsonStringifyV1(item.args) !==
          canonicalJsonStringifyV1(call.args as unknown as JsonValue)
      ) {
        throw new Error("Model response/observation identity mismatch");
      }
    });
  }
}

/** Shared inline/artifact carrier metadata contract for every read path. */
export function assertCanonicalModelResponseCarrierV1(
  settlement: ModelSettledFactV1,
  response: ModelResponseV1,
): void {
  if (settlement.status !== "completed" && settlement.status !== "truncated") {
    throw new Error("Model response belongs to a non-response settlement");
  }
  if (settlement.hasToolCalls !== response.toolCalls.length > 0) {
    throw new Error("Model response tool-call flag mismatch");
  }
  if (
    settlement.hasVisibleOutput !==
    response.assistantContent.trim().length > 0
  ) {
    throw new Error("Model response visible-output flag mismatch");
  }
  if (settlement.finishReason !== response.finishReason) {
    throw new Error("Model response finishReason mismatch");
  }
}

function findCheckpointClaim(
  prefix: readonly RunJournalEnvelopeV1[],
  claimId: string,
): Extract<InputFactV1, { type: "context.checkpoint_distillation_claimed" }> {
  const claim = prefix.find(
    (envelope) =>
      envelope.record.kind === "input_fact" &&
      envelope.record.fact.type === "context.checkpoint_distillation_claimed" &&
      envelope.record.fact.claimId === claimId,
  );
  if (
    !claim ||
    claim.record.kind !== "input_fact" ||
    claim.record.fact.type !== "context.checkpoint_distillation_claimed"
  ) {
    throw new Error("Checkpoint payload has no distillation claim");
  }
  return claim.record.fact;
}

function assertCheckpointSourceRange(
  checkpoint: ReturnType<typeof parseTaskCheckpointV1>,
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
  for (const item of items) {
    for (const seq of item.sourceSeqs) {
      if (seq < sourceFromSeq || seq > sourceThroughSeq) {
        throw new Error(
          "Task checkpoint cites a fact outside its source range",
        );
      }
    }
  }
}

function canonicalUtf8ByteLength(value: JsonValue): number {
  return new TextEncoder().encode(canonicalJsonStringifyV1(value)).byteLength;
}

function digestPrefix(prefix: readonly RunJournalEnvelopeV1[]): string {
  return createHash("sha256")
    .update(canonicalJsonStringifyV1(prefix as unknown as JsonValue))
    .digest("hex");
}

function locationKey(location: CanonicalDurableJsonPayloadLocationV1): string {
  return canonicalJsonStringifyV1(location as unknown as JsonValue);
}

function findExactOccurrence(
  byLocation: ReadonlyMap<string, VerifiedCanonicalPayloadOccurrenceV1>,
  lookup: VerifiedCanonicalPayloadOccurrenceLookupV1,
): VerifiedCanonicalPayloadOccurrenceV1 | undefined {
  const occurrence = byLocation.get(locationKey(lookup.location));
  if (
    !occurrence ||
    canonicalJsonStringifyV1(occurrence.payload as unknown as JsonValue) !==
      canonicalJsonStringifyV1(lookup.payload as unknown as JsonValue)
  ) {
    return undefined;
  }
  return occurrence;
}

function modelResponseKey(
  lookup: VerifiedCanonicalModelResponseLookupV1,
): string {
  if (!Number.isSafeInteger(lookup.carrierSeq) || lookup.carrierSeq <= 0) {
    throw new Error(
      "model response carrierSeq must be a positive safe integer",
    );
  }
  assertStableId(lookup.modelCallId, "modelCallId");
  return canonicalJsonStringifyV1({
    carrierSeq: lookup.carrierSeq,
    modelCallId: lookup.modelCallId,
    payload: lookup.payload,
  } as unknown as JsonValue);
}

function parseBudget(
  value: VerifiedCanonicalPayloadBudgetV1,
): VerifiedCanonicalPayloadBudgetV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "maxTotalBytes\0policyVersion" ||
    value.policyVersion !== VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1
  ) {
    throw new Error("Verified canonical payload budget is invalid");
  }
  assertPositiveSafeInteger(value.maxTotalBytes, "maxTotalBytes");
  return Object.freeze({
    policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
    maxTotalBytes: value.maxTotalBytes,
  });
}

function parseCanonicalPayloadIdentity(
  value: CanonicalPayloadIdentityV1,
): CanonicalPayloadIdentityV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      "runId\0sessionId\0workspaceRoot" ||
    typeof value.workspaceRoot !== "string" ||
    value.workspaceRoot.length === 0
  ) {
    throw new Error("Canonical payload resolver identity is invalid");
  }
  assertStableId(value.sessionId, "payload identity sessionId");
  assertStableId(value.runId, "payload identity runId");
  return Object.freeze({
    workspaceRoot: value.workspaceRoot,
    sessionId: value.sessionId,
    runId: value.runId,
  });
}

function freezePrefix(
  prefix: readonly RunJournalEnvelopeV1[],
): readonly RunJournalEnvelopeV1[] {
  return immutableCanonicalJsonCloneV1(
    prefix as unknown as JsonValue,
  ) as unknown as readonly RunJournalEnvelopeV1[];
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertStableId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value)) {
    throw new Error(`${label} must be a stable id`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(String(signal.reason ?? "Payload verification aborted"));
}
