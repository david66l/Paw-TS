import type { Session } from "@paw/agent-loop";
import {
  type DerivedDecisionV1,
  type DurableJsonPayloadV1,
  type InputFactV1,
  type JsonValue,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  assertRunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
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
import {
  type CanonicalDurableJsonPayloadResolverV1,
  type VerifiedCanonicalPayloadBudgetV1,
  buildVerifiedCanonicalPayloadIndexV1,
  freezeVerifiedCanonicalPayloadBudgetV1,
} from "./verified-canonical-payload-index.js";

export const LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1 =
  "paw.location-aware-payload-session.v1" as const;
export const LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1 =
  "paw.location-aware-payload-materializer.v1" as const;

export interface LocationAwarePayloadMaterializerV1 {
  readCanonicalPayloadIdentity(): CanonicalPayloadIdentityV1;
  resolve(
    payload: DurableJsonPayloadV1,
    expectedBinding: DurableJsonPayloadBindingV1,
    signal?: AbortSignal,
  ): JsonValue | Promise<JsonValue>;
  prepare(
    value: JsonValue,
    binding: DurableJsonPayloadBindingV1,
    signal?: AbortSignal,
  ): DurableJsonPayloadV1 | Promise<DurableJsonPayloadV1>;
  hash(value: JsonValue): string | Promise<string>;
}

export interface LocationAwarePayloadSessionSourceV1
  extends Session<InputFactV1, DerivedDecisionV1> {
  readCanonicalJournalIdentity(): CanonicalPayloadIdentityV1;
  readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]>;
  readCoordinatorOwnershipIdentity?(): string;
}

export interface LocationAwarePayloadSessionV1
  extends Session<InputFactV1, DerivedDecisionV1> {
  readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]>;
  readCoordinatorOwnershipIdentity?(): string;
}

export interface CreateLocationAwarePayloadSessionOptionsV1 {
  readonly source: LocationAwarePayloadSessionSourceV1;
  /** Required to bind an empty prefix before its first envelope exists. */
  readonly sessionId: string;
  readonly runId: string;
  readonly materializer: LocationAwarePayloadMaterializerV1;
  /** Exact full-prefix value budget enforced before and after materialization. */
  readonly budget: VerifiedCanonicalPayloadBudgetV1;
  readonly signal?: AbortSignal;
}

/**
 * Validate and materialize payloads at their final journal locations without
 * adding state or another fact schema. The raw source is captured privately
 * and is never returned to product components.
 */
export function createLocationAwarePayloadSessionV1(
  options: CreateLocationAwarePayloadSessionOptionsV1,
): LocationAwarePayloadSessionV1 {
  assertStableId(options.sessionId, "sessionId");
  assertStableId(options.runId, "runId");
  const budget = freezeVerifiedCanonicalPayloadBudgetV1(options.budget);
  const source = captureSource(options.source);
  const materializer = captureMaterializer(options.materializer);
  assertBoundOwnerIdentities(
    source,
    materializer,
    options.sessionId,
    options.runId,
  );
  const signal = options.signal ?? new AbortController().signal;

  const wrapper: LocationAwarePayloadSessionV1 = {
    readInputSnapshot: () => source.readInputSnapshot(),
    readCanonicalPrefix: async () =>
      freezePrefix(await readAndValidateSourcePrefix()),
    appendInputFacts(facts): Promise<void> {
      const frozenFacts = cloneFactsSynchronously(facts);
      if (frozenFacts.length === 0) return Promise.resolve();
      return appendPreparedFacts(frozenFacts);
    },
    commitInputFacts(expectedTailSeq, facts) {
      assertExpectedTailSeq(expectedTailSeq);
      const frozenFacts = cloneFactsSynchronously(facts);
      if (frozenFacts.length === 0) {
        throw new Error("Input fact CAS commit requires at least one fact");
      }
      return commitPreparedFacts({
        expectedTailSeq,
        facts: frozenFacts,
        decision: undefined,
      });
    },
    commitDerivedDecision(expectedTailSeq, decision) {
      assertExpectedTailSeq(expectedTailSeq);
      const frozenDecision = cloneDecisionSynchronously(decision);
      return source.commitDerivedDecision(expectedTailSeq, frozenDecision);
    },
    commitDecisionAndInputFacts(expectedTailSeq, decision, facts) {
      assertExpectedTailSeq(expectedTailSeq);
      const frozenDecision = cloneDecisionSynchronously(decision);
      const frozenFacts = cloneFactsSynchronously(facts);
      if (frozenFacts.length === 0) {
        throw new Error(
          "Decision-and-input commit requires at least one input fact",
        );
      }
      return commitPreparedFacts({
        expectedTailSeq,
        facts: frozenFacts,
        decision: frozenDecision,
      });
    },
  };

  if (source.readCoordinatorOwnershipIdentity) {
    const readIdentity = source.readCoordinatorOwnershipIdentity.bind(source);
    wrapper.readCoordinatorOwnershipIdentity = () => readIdentity();
  }
  return Object.freeze(wrapper);

  async function appendPreparedFacts(
    facts: readonly InputFactV1[],
  ): Promise<void> {
    while (true) {
      const prefix = await readAndValidateSourcePrefix();
      const status = await prepareAndCommit(prefix, prefix.length, facts);
      if (status === "committed") return;
    }
  }

  async function commitPreparedFacts(input: {
    readonly expectedTailSeq: number;
    readonly facts: readonly InputFactV1[];
    readonly decision?: DerivedDecisionV1;
  }): Promise<"committed" | "conflict"> {
    const prefix = await readAndValidateSourcePrefix();
    if (prefix.length !== input.expectedTailSeq) return "conflict";
    return prepareAndCommit(
      prefix,
      input.expectedTailSeq,
      input.facts,
      input.decision,
    );
  }

  async function prepareAndCommit(
    existingPrefix: readonly RunJournalEnvelopeV1[],
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
    decision?: DerivedDecisionV1,
  ): Promise<"committed" | "conflict"> {
    throwIfAborted(signal);
    const candidate = freezePrefix(
      appendCandidateEnvelopes(
        existingPrefix,
        options.sessionId,
        options.runId,
        facts,
        decision,
      ),
    );

    // Hard gate: all existing artifacts and all inline draft semantics are
    // validated before the first prepare can create an orphan.
    await validateCanonicalDurableJsonPayloadPrefixV1({
      fullPrefix: candidate,
      materializer,
      budget,
      signal,
    });
    throwIfAborted(signal);

    const materialized = await materializeNewInlineOccurrences(
      candidate,
      expectedTailSeq,
      materializer,
      signal,
    );
    const canonicalMaterialized = freezePrefix(
      parseRunJournalPrefixV1(materialized),
    );
    await validateCanonicalDurableJsonPayloadPrefixV1({
      fullPrefix: canonicalMaterialized,
      materializer,
      budget,
      signal,
    });
    throwIfAborted(signal);

    const committedFacts = canonicalMaterialized
      .filter(
        (envelope) =>
          envelope.seq > expectedTailSeq &&
          envelope.record.kind === "input_fact",
      )
      .map((envelope) => {
        if (envelope.record.kind !== "input_fact") {
          throw new Error("Materialized candidate fact projection is invalid");
        }
        return envelope.record.fact;
      });
    if (decision === undefined) {
      return source.commitInputFacts(expectedTailSeq, committedFacts);
    }
    return source.commitDecisionAndInputFacts(
      expectedTailSeq,
      decision,
      committedFacts,
    );
  }

  async function readAndValidateSourcePrefix(): Promise<
    readonly RunJournalEnvelopeV1[]
  > {
    const prefix = freezePrefix(
      parseRunJournalPrefixV1(await source.readCanonicalPrefix()),
    );
    assertBoundOwnerIdentities(
      source,
      materializer,
      options.sessionId,
      options.runId,
    );
    const first = prefix[0];
    if (
      first &&
      (first.sessionId !== options.sessionId || first.runId !== options.runId)
    ) {
      throw new Error("Location-aware payload Session identity mismatch");
    }
    return prefix;
  }
}

function assertBoundOwnerIdentities(
  source: LocationAwarePayloadSessionSourceV1,
  materializer: LocationAwarePayloadMaterializerV1,
  sessionId: string,
  runId: string,
): void {
  const sourceIdentity = parseCanonicalIdentity(
    source.readCanonicalJournalIdentity(),
    "Session",
  );
  const payloadIdentity = parseCanonicalIdentity(
    materializer.readCanonicalPayloadIdentity(),
    "payload materializer",
  );
  if (
    sourceIdentity.sessionId !== sessionId ||
    sourceIdentity.runId !== runId ||
    payloadIdentity.sessionId !== sessionId ||
    payloadIdentity.runId !== runId ||
    sourceIdentity.workspaceRoot !== payloadIdentity.workspaceRoot
  ) {
    throw new Error("Location-aware payload owner identity mismatch");
  }
}

function parseCanonicalIdentity(
  identity: CanonicalPayloadIdentityV1,
  label: string,
): CanonicalPayloadIdentityV1 {
  if (
    !identity ||
    typeof identity !== "object" ||
    Array.isArray(identity) ||
    Object.keys(identity).sort().join("\0") !==
      "runId\0sessionId\0workspaceRoot"
  ) {
    throw new Error(`${label} canonical identity is invalid`);
  }
  assertStableId(identity.sessionId, `${label} sessionId`);
  assertStableId(identity.runId, `${label} runId`);
  if (
    typeof identity.workspaceRoot !== "string" ||
    identity.workspaceRoot.length === 0
  ) {
    throw new Error(`${label} canonical workspace identity is invalid`);
  }
  return Object.freeze({ ...identity });
}

/** Shared BU-B/BU-C full-prefix payload and semantic validation gate. */
export async function validateCanonicalDurableJsonPayloadPrefixV1(options: {
  readonly fullPrefix: readonly RunJournalEnvelopeV1[];
  readonly materializer: CanonicalDurableJsonPayloadResolverV1;
  readonly budget: VerifiedCanonicalPayloadBudgetV1;
  readonly signal?: AbortSignal;
}): Promise<void> {
  await buildVerifiedCanonicalPayloadIndexV1({
    fullPrefix: options.fullPrefix,
    resolver: options.materializer,
    budget: options.budget,
    signal: options.signal,
  });
}

function appendCandidateEnvelopes(
  prefix: readonly RunJournalEnvelopeV1[],
  sessionId: string,
  runId: string,
  facts: readonly InputFactV1[],
  decision?: DerivedDecisionV1,
): readonly RunJournalEnvelopeV1[] {
  const appended: RunJournalEnvelopeV1[] = [...prefix];
  let seq = prefix.length;
  const ts = prefix.at(-1)?.ts ?? 0;
  if (decision !== undefined) {
    seq += 1;
    appended.push(
      envelope(sessionId, runId, seq, ts, {
        kind: "derived_decision",
        decision,
      }),
    );
  }
  for (const fact of facts) {
    seq += 1;
    appended.push(
      envelope(sessionId, runId, seq, ts, { kind: "input_fact", fact }),
    );
  }
  return parseRunJournalPrefixV1(appended);
}

function envelope(
  sessionId: string,
  runId: string,
  seq: number,
  ts: number,
  record: RunJournalEnvelopeV1["record"],
): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId,
    runId,
    seq,
    ts,
    record,
  };
}

async function materializeNewInlineOccurrences(
  candidate: readonly RunJournalEnvelopeV1[],
  previousTailSeq: number,
  materializer: LocationAwarePayloadMaterializerV1,
  signal: AbortSignal,
): Promise<readonly RunJournalEnvelopeV1[]> {
  const mutable = JSON.parse(
    canonicalJsonStringifyV1(candidate as unknown as JsonValue),
  ) as unknown as RunJournalEnvelopeV1[];
  const occurrences = projectCanonicalDurableJsonPayloadBindingsV1(candidate);
  for (const occurrence of occurrences) {
    if (
      occurrence.location.carrierSeq <= previousTailSeq ||
      occurrence.payload.kind !== "inline"
    ) {
      continue;
    }
    throwIfAborted(signal);
    const preparedValue = await materializer.prepare(
      occurrence.payload.value,
      occurrence.binding,
      signal,
    );
    const prepared = immutableCanonicalJsonCloneV1(
      preparedValue as unknown as JsonValue,
    ) as unknown as DurableJsonPayloadV1;
    assertPreparedArtifactPayload(prepared);
    if (prepared.hash !== occurrence.payload.hash) {
      throw new Error("Prepared payload changed the canonical content hash");
    }
    const resolvedPrepared = immutableCanonicalJsonCloneV1(
      await materializer.resolve(prepared, occurrence.binding, signal),
    );
    const resolvedHash = await materializer.hash(resolvedPrepared);
    if (
      resolvedHash !== prepared.hash ||
      canonicalJsonStringifyV1(resolvedPrepared) !==
        canonicalJsonStringifyV1(occurrence.payload.value)
    ) {
      throw new Error("Prepared payload changed the canonical JSON value");
    }
    replacePayloadAtLocation(mutable, occurrence.location, prepared);
  }
  return mutable;
}

function assertPreparedArtifactPayload(
  payload: DurableJsonPayloadV1,
): asserts payload is Extract<DurableJsonPayloadV1, { kind: "artifact_ref" }> {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join("\0") !== "artifactRef\0hash\0kind" ||
    payload.kind !== "artifact_ref" ||
    typeof payload.artifactRef !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(payload.artifactRef) ||
    typeof payload.hash !== "string" ||
    payload.hash.length === 0 ||
    payload.hash.length > 8192 ||
    hasControlCharacter(payload.hash)
  ) {
    throw new Error("Payload materializer prepare must return artifact_ref");
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

function replacePayloadAtLocation(
  prefix: RunJournalEnvelopeV1[],
  location: CanonicalDurableJsonPayloadLocationV1,
  payload: DurableJsonPayloadV1,
): void {
  const envelope = prefix[location.carrierSeq - 1];
  if (
    !envelope ||
    envelope.seq !== location.carrierSeq ||
    envelope.record.kind !== "input_fact"
  ) {
    throw new Error("Payload occurrence carrier is missing");
  }
  const fact = envelope.record.fact;
  switch (location.carrierType) {
    case "input.accepted":
    case "input.promoted": {
      if (fact.type !== location.carrierType) break;
      const attachment = fact.attachments?.[location.attachmentIndex];
      if (
        !attachment ||
        fact.inputId !== location.inputId ||
        attachment.attachmentId !== location.attachmentId
      ) {
        break;
      }
      (attachment as { content: DurableJsonPayloadV1 }).content = payload;
      return;
    }
    case "model.settled":
      if (
        fact.type === "model.settled" &&
        fact.modelCallId === location.modelCallId
      ) {
        (fact as { response?: DurableJsonPayloadV1 }).response = payload;
        return;
      }
      break;
    case "tool.settled":
      if (
        fact.type === "tool.settled" &&
        fact.callId === location.callId &&
        fact.observation
      ) {
        (fact.observation as { payload?: DurableJsonPayloadV1 }).payload =
          payload;
        return;
      }
      break;
    case "context.checkpoint_distillation_settled":
      if (
        fact.type === "context.checkpoint_distillation_settled" &&
        fact.claimId === location.claimId
      ) {
        (fact as { checkpoint?: DurableJsonPayloadV1 }).checkpoint = payload;
        return;
      }
      break;
    case "context.checkpoint_recorded":
      if (
        fact.type === "context.checkpoint_recorded" &&
        fact.checkpointId === location.checkpointId
      ) {
        (fact as { checkpoint: DurableJsonPayloadV1 }).checkpoint = payload;
        return;
      }
      break;
  }
  throw new Error("Payload occurrence location does not match its carrier");
}

function cloneFactsSynchronously(
  facts: readonly InputFactV1[],
): readonly InputFactV1[] {
  return Object.freeze(facts.map(cloneFactSynchronously));
}

function cloneFactSynchronously(fact: InputFactV1): InputFactV1 {
  assertRunJournalEnvelopeV1(
    envelope(
      "validation-session",
      "validation-run",
      Number.MAX_SAFE_INTEGER,
      0,
      {
        kind: "input_fact",
        fact,
      },
    ),
  );
  return immutableCanonicalJsonCloneV1(
    fact as unknown as JsonValue,
  ) as InputFactV1;
}

function cloneDecisionSynchronously(
  decision: DerivedDecisionV1,
): DerivedDecisionV1 {
  assertRunJournalEnvelopeV1(
    envelope(
      "validation-session",
      "validation-run",
      Number.MAX_SAFE_INTEGER,
      0,
      {
        kind: "derived_decision",
        decision,
      },
    ),
  );
  return immutableCanonicalJsonCloneV1(
    decision as unknown as JsonValue,
  ) as unknown as DerivedDecisionV1;
}

function captureMaterializer(
  value: LocationAwarePayloadMaterializerV1,
): LocationAwarePayloadMaterializerV1 {
  if (
    !value ||
    typeof value.resolve !== "function" ||
    typeof value.prepare !== "function" ||
    typeof value.hash !== "function" ||
    typeof value.readCanonicalPayloadIdentity !== "function"
  ) {
    throw new Error("Location-aware payload materializer is invalid");
  }
  return Object.freeze({
    resolve: value.resolve.bind(value),
    prepare: value.prepare.bind(value),
    hash: value.hash.bind(value),
    readCanonicalPayloadIdentity:
      value.readCanonicalPayloadIdentity.bind(value),
  });
}

function captureSource(
  value: LocationAwarePayloadSessionSourceV1,
): LocationAwarePayloadSessionSourceV1 {
  if (
    !value ||
    typeof value.readCanonicalPrefix !== "function" ||
    typeof value.readCanonicalJournalIdentity !== "function" ||
    typeof value.readInputSnapshot !== "function" ||
    typeof value.appendInputFacts !== "function" ||
    typeof value.commitInputFacts !== "function" ||
    typeof value.commitDerivedDecision !== "function" ||
    typeof value.commitDecisionAndInputFacts !== "function"
  ) {
    throw new Error("Location-aware payload Session source is invalid");
  }
  return Object.freeze({
    readInputSnapshot: value.readInputSnapshot.bind(value),
    appendInputFacts: value.appendInputFacts.bind(value),
    commitInputFacts: value.commitInputFacts.bind(value),
    commitDerivedDecision: value.commitDerivedDecision.bind(value),
    commitDecisionAndInputFacts: value.commitDecisionAndInputFacts.bind(value),
    readCanonicalPrefix: value.readCanonicalPrefix.bind(value),
    readCanonicalJournalIdentity:
      value.readCanonicalJournalIdentity.bind(value),
    ...(typeof value.readCoordinatorOwnershipIdentity === "function"
      ? {
          readCoordinatorOwnershipIdentity:
            value.readCoordinatorOwnershipIdentity.bind(value),
        }
      : {}),
  });
}

function freezePrefix(
  prefix: readonly RunJournalEnvelopeV1[],
): readonly RunJournalEnvelopeV1[] {
  return immutableCanonicalJsonCloneV1(
    prefix as unknown as JsonValue,
  ) as unknown as readonly RunJournalEnvelopeV1[];
}

function assertExpectedTailSeq(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "Session expectedTailSeq must be a non-negative safe integer",
    );
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
    : new Error(String(signal.reason ?? "Payload materialization aborted"));
}
