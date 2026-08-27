import type {
  SessionInputSnapshot,
  VerifiedModelResponseEvidenceV1,
} from "@paw/agent-loop";
import type {
  DurableJsonPayloadV1,
  InputFactV1,
  JsonValue,
  RunJournalEnvelopeV1,
} from "@paw/protocol";
import { parseRunJournalPrefixV1 } from "@paw/protocol";

import {
  canonicalJsonStringifyV1,
  immutableCanonicalJsonCloneV1,
} from "../context/canonical-json.js";
import type { CanonicalDurableJsonPayloadLocationV1 } from "./canonical-payload-binding.js";
import type { CanonicalPayloadIdentityV1 } from "./canonical-payload-identity.js";
import {
  type VerifiedCanonicalPayloadBudgetV1,
  type VerifiedCanonicalPayloadIndexV1,
  assertVerifiedCanonicalPayloadIndexMatchesV1,
} from "./verified-canonical-payload-index.js";

export interface CreateVerifiedModelResponseEvidenceOptionsV1 {
  readonly index: VerifiedCanonicalPayloadIndexV1;
  readonly fullPrefix: readonly RunJournalEnvelopeV1[];
  readonly identity: CanonicalPayloadIdentityV1;
  readonly budget: VerifiedCanonicalPayloadBudgetV1;
}

export type CreateVerifiedCanonicalPayloadEvidenceOptionsV1 =
  CreateVerifiedModelResponseEvidenceOptionsV1;

export interface VerifiedCanonicalPayloadEvidenceV1
  extends VerifiedModelResponseEvidenceV1 {
  requirePayload(input: {
    readonly snapshot: SessionInputSnapshot<InputFactV1>;
    readonly location: CanonicalDurableJsonPayloadLocationV1;
    readonly payload: DurableJsonPayloadV1;
  }): JsonValue;
}

/** Adapt one issued Runtime payload index to Agent Loop's filesystem-free port. */
export function createVerifiedCanonicalPayloadEvidenceV1(
  options: CreateVerifiedCanonicalPayloadEvidenceOptionsV1,
): VerifiedCanonicalPayloadEvidenceV1 {
  const prefix = immutableCanonicalJsonCloneV1(
    parseRunJournalPrefixV1(options.fullPrefix) as unknown as JsonValue,
  ) as unknown as readonly RunJournalEnvelopeV1[];
  assertVerifiedCanonicalPayloadIndexMatchesV1(options.index, {
    fullPrefix: prefix,
    identity: options.identity,
    budget: options.budget,
  });
  const expectedSnapshot = projectCanonicalSessionInputSnapshotV1(prefix);
  const expectedSnapshotJson = canonicalJsonStringifyV1(
    expectedSnapshot as unknown as JsonValue,
  );
  const requireModelResponse = options.index.requireModelResponse.bind(
    options.index,
  );
  const requireOccurrence = options.index.requireOccurrence.bind(options.index);

  const assertSnapshot = (
    snapshot: SessionInputSnapshot<InputFactV1>,
  ): void => {
    let actual: JsonValue;
    try {
      actual = immutableCanonicalJsonCloneV1(snapshot as unknown as JsonValue);
    } catch {
      throw new Error("Verified model response snapshot is invalid");
    }
    if (canonicalJsonStringifyV1(actual) !== expectedSnapshotJson) {
      throw new Error("Verified model response evidence snapshot mismatch");
    }
  };

  return Object.freeze({
    assertSnapshot,
    requireModelResponse(
      input: Parameters<
        VerifiedModelResponseEvidenceV1["requireModelResponse"]
      >[0],
    ) {
      assertSnapshot(input.snapshot);
      return requireModelResponse({
        carrierSeq: input.carrierSeq,
        modelCallId: input.modelCallId,
        payload: input.payload,
      });
    },
    requirePayload(
      input: Parameters<
        VerifiedCanonicalPayloadEvidenceV1["requirePayload"]
      >[0],
    ) {
      assertSnapshot(input.snapshot);
      return requireOccurrence({
        location: input.location,
        payload: input.payload,
      }).value;
    },
  });
}

/** @deprecated Use the general canonical payload evidence factory. */
export function createVerifiedModelResponseEvidenceV1(
  options: CreateVerifiedModelResponseEvidenceOptionsV1,
): VerifiedCanonicalPayloadEvidenceV1 {
  return createVerifiedCanonicalPayloadEvidenceV1(options);
}

export function projectCanonicalSessionInputSnapshotV1(
  prefix: readonly RunJournalEnvelopeV1[],
): SessionInputSnapshot<InputFactV1> {
  const canonical = immutableCanonicalJsonCloneV1(
    parseRunJournalPrefixV1(prefix) as unknown as JsonValue,
  ) as unknown as readonly RunJournalEnvelopeV1[];
  const entries = canonical.flatMap((envelope) =>
    envelope.record.kind === "input_fact"
      ? [
          Object.freeze({
            seq: envelope.seq,
            fact: envelope.record.fact,
          }),
        ]
      : [],
  );
  return Object.freeze({
    entries: Object.freeze(entries),
    tailSeq: canonical.length,
    latestInputSeq: entries.at(-1)?.seq ?? 0,
  });
}
