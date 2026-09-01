import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import type { MemoryStateValidatedObservationV1 } from "./state-binding-certificate-v1.js";
import type {
  MemoryResolvedStateFrameV2,
  MemoryStateExactSpanV2,
  MemoryStateSlotOperationV2,
  MemoryStateSlotSpecV2,
  MemoryStateSourceLockV2,
} from "./state-frame-v2.js";

export const PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1 =
  "paw.memory-state-mechanical-binding-profile.v1:deterministic-nonsemantic" as const;

export interface MemoryStateMechanicalBindingProfileV1 {
  readonly policyVersion: typeof PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1;
  /** Internal join key. Callers must not expose it in telemetry. */
  readonly observationId: string;
  readonly profileDigest: string;
  readonly proofs: Readonly<{
    sourceLockExact: boolean;
    supportingScopeExact: boolean;
    slotRevisionExact: boolean;
    originRevisionExact: boolean;
    temporalBindingRevisionExact: boolean;
    evidenceIdentityExact: boolean;
    contentDigestExact: boolean;
    valueSpanExact: boolean;
    valueOccurrenceUnique: boolean;
    valueEventTimeDisjoint: boolean;
    roleExact: boolean;
    authorityExact: boolean;
    dialogueCertificateExact: boolean;
    cutoffExact: boolean;
  }>;
  readonly metrics: Readonly<{
    operation: MemoryStateSlotOperationV2;
    temporalMode: MemoryStateSlotSpecV2["temporalMode"];
    valueSpanCardinality: "single" | "multi";
    valueLengthBucket: "short" | "medium" | "long";
    occurrenceCountBucket: "one" | "multiple";
    slotCandidateCardinality: "single" | "multi";
    evidenceClauseCountBucket: "one" | "multiple";
    frameStatus: "complete" | "partial" | "missing" | "conflict";
  }>;
  /** These require an independent semantic judge; host code cannot prove them. */
  readonly unresolvedSemanticClaims: Readonly<{
    subjectBinding: true;
    slotAttributeBinding: true;
    clauseAttachment: true;
    entailment: true;
  }>;
}

export type MemoryStateMechanicalProofNameV1 =
  keyof MemoryStateMechanicalBindingProfileV1["proofs"];

export interface MemoryStateMechanicalBindingSummaryV1 {
  readonly policyVersion: typeof PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1;
  readonly profileCount: number;
  readonly mechanicallyCompleteCount: number;
  readonly mechanicallyIncompleteCount: number;
  readonly proofFailureCounts: Readonly<
    Record<MemoryStateMechanicalProofNameV1, number>
  >;
  readonly summaryRevision: string;
}

export function compileMemoryStateMechanicalBindingProfilesV1(input: {
  readonly slots: readonly MemoryStateSlotSpecV2[];
  readonly sourceLock: MemoryStateSourceLockV2;
  readonly slotScopes: readonly Readonly<{
    slotId: string;
    evidenceRefs: readonly string[];
  }>[];
  readonly validatedObservations: readonly MemoryStateValidatedObservationV1[];
  readonly frame: MemoryResolvedStateFrameV2;
}): readonly MemoryStateMechanicalBindingProfileV1[] {
  const slotById = uniqueMap(input.slots, (slot) => slot.slotId);
  const itemByRef = uniqueMap(
    input.sourceLock.items,
    (item) => item.evidenceRef,
  );
  const scopeBySlot = uniqueMap(input.slotScopes, (scope) => scope.slotId);
  const frameBySlot = uniqueMap(input.frame.slots, (slot) => slot.slotId);
  const candidateCounts = new Map<string, number>();
  for (const item of input.validatedObservations) {
    candidateCounts.set(
      item.observation.slotId,
      (candidateCounts.get(item.observation.slotId) ?? 0) + 1,
    );
  }
  return Object.freeze(
    input.validatedObservations.map((validated) => {
      const { observation, certificate } = validated;
      const slot = slotById.get(observation.slotId);
      const item = itemByRef.get(observation.evidenceRef);
      const scope = scopeBySlot.get(observation.slotId);
      const resolved = frameBySlot.get(observation.slotId);
      if (!slot || !item || !scope || !resolved) {
        throw namedError("MemoryStateMechanicalBindingProfileInputInvalid");
      }
      const occurrenceCounts = observation.valueSpans.map((span) =>
        countExactOccurrences(item.content, span.text),
      );
      const proofs = Object.freeze({
        sourceLockExact:
          observation.sourceLockDigest === input.sourceLock.sourceLockDigest &&
          certificate.evidenceBinding.sourceLockDigest ===
            input.sourceLock.sourceLockDigest &&
          input.frame.sourceLockDigest === input.sourceLock.sourceLockDigest,
        supportingScopeExact: scope.evidenceRefs.includes(
          observation.evidenceRef,
        ),
        slotRevisionExact:
          certificate.slotBinding.slotRevision === slot.slotRevision,
        originRevisionExact:
          certificate.slotBinding.originRevision === slot.originRevision,
        temporalBindingRevisionExact:
          certificate.slotBinding.temporalBindingRevision ===
          slot.temporalBindingRevision,
        evidenceIdentityExact:
          observation.evidenceRef === item.evidenceRef &&
          observation.sourceId === item.sourceId &&
          certificate.evidenceBinding.evidenceRef === item.evidenceRef &&
          certificate.evidenceBinding.sourceId === item.sourceId,
        contentDigestExact:
          observation.contentDigest === hashTextV1(item.content) &&
          certificate.evidenceBinding.contentDigest ===
            hashTextV1(item.content),
        valueSpanExact:
          exactSpanListsEqual(
            observation.valueSpans,
            certificate.claimBinding.value.exactSpans,
          ) &&
          observation.valueSpans.every((span) =>
            exactSpanMatchesContent(span, item.content),
          ),
        valueOccurrenceUnique: occurrenceCounts.every((count) => count === 1),
        valueEventTimeDisjoint: observation.valueSpans.every((value) =>
          observation.eventTimeSpans.every(
            (eventTime) =>
              value.end <= eventTime.start || eventTime.end <= value.start,
          ),
        ),
        roleExact:
          observation.role === item.role &&
          certificate.evidenceBinding.role === item.role &&
          certificate.slotBinding.roleConstraint === item.role,
        authorityExact:
          observation.authority === item.authority &&
          certificate.evidenceBinding.authority === item.authority,
        dialogueCertificateExact:
          item.role === "user" ||
          (item.certificateRevision !== undefined &&
            observation.certificateRevision === item.certificateRevision &&
            certificate.evidenceBinding.dialogueCertificateRevision ===
              item.certificateRevision),
        cutoffExact: cutoffMatches(slot, item.observedAt, observation),
      });
      const valueLength = observation.valueSpans.reduce(
        (total, span) => total + span.text.length,
        0,
      );
      const metrics = Object.freeze({
        operation: slot.operation,
        temporalMode: slot.temporalMode,
        valueSpanCardinality:
          observation.valueSpans.length === 1
            ? ("single" as const)
            : ("multi" as const),
        valueLengthBucket:
          valueLength <= 32
            ? ("short" as const)
            : valueLength <= 128
              ? ("medium" as const)
              : ("long" as const),
        occurrenceCountBucket: occurrenceCounts.every((count) => count === 1)
          ? ("one" as const)
          : ("multiple" as const),
        slotCandidateCardinality:
          (candidateCounts.get(slot.slotId) ?? 0) === 1
            ? ("single" as const)
            : ("multi" as const),
        evidenceClauseCountBucket:
          countClauses(certificate.claimBinding.supportSpan.text) === 1
            ? ("one" as const)
            : ("multiple" as const),
        frameStatus: resolved.status,
      });
      const unresolvedSemanticClaims = Object.freeze({
        subjectBinding: true as const,
        slotAttributeBinding: true as const,
        clauseAttachment: true as const,
        entailment: true as const,
      });
      const identity = {
        policyVersion: PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1,
        observationId: observation.observationId,
        proofs,
        metrics,
        unresolvedSemanticClaims,
      };
      return Object.freeze({
        ...identity,
        profileDigest: hashCanonicalJsonV1(identity as unknown as JsonValue),
      });
    }),
  );
}

export function summarizeMemoryStateMechanicalBindingProfilesV1(
  profiles: readonly MemoryStateMechanicalBindingProfileV1[],
): MemoryStateMechanicalBindingSummaryV1 {
  const proofNames: readonly MemoryStateMechanicalProofNameV1[] = [
    "sourceLockExact",
    "supportingScopeExact",
    "slotRevisionExact",
    "originRevisionExact",
    "temporalBindingRevisionExact",
    "evidenceIdentityExact",
    "contentDigestExact",
    "valueSpanExact",
    "valueOccurrenceUnique",
    "valueEventTimeDisjoint",
    "roleExact",
    "authorityExact",
    "dialogueCertificateExact",
    "cutoffExact",
  ];
  const proofFailureCounts = Object.freeze(
    Object.fromEntries(
      proofNames.map((name) => [
        name,
        profiles.filter((profile) => profile.proofs[name] === false).length,
      ]),
    ) as unknown as Record<MemoryStateMechanicalProofNameV1, number>,
  );
  const mechanicallyCompleteCount = profiles.filter((profile) =>
    proofNames.every((name) => profile.proofs[name]),
  ).length;
  const identity = {
    policyVersion: PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1,
    profileCount: profiles.length,
    mechanicallyCompleteCount,
    mechanicallyIncompleteCount: profiles.length - mechanicallyCompleteCount,
    proofFailureCounts,
  };
  return Object.freeze({
    ...identity,
    summaryRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
}

function uniqueMap<T>(
  items: readonly T[],
  key: (item: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const value = key(item);
    if (!value.trim() || result.has(value)) {
      throw namedError("MemoryStateMechanicalBindingProfileInputInvalid");
    }
    result.set(value, item);
  }
  return result;
}

function exactSpanListsEqual(
  left: readonly MemoryStateExactSpanV2[],
  right: readonly MemoryStateExactSpanV2[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (span, index) =>
        span.start === right[index]?.start &&
        span.end === right[index]?.end &&
        span.text === right[index]?.text &&
        span.textDigest === right[index]?.textDigest,
    )
  );
}

function exactSpanMatchesContent(
  span: MemoryStateExactSpanV2,
  content: string,
): boolean {
  const text = content.slice(span.start, span.end);
  return span.text === text && span.textDigest === hashTextV1(text);
}

function countExactOccurrences(content: string, value: string): number {
  if (!value) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= content.length - value.length) {
    const index = content.indexOf(value, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(1, value.length);
  }
  return count;
}

function countClauses(text: string): number {
  return Math.max(
    1,
    text
      .split(/[\n\r.!?。！？;；]+/u)
      .map((part) => part.trim())
      .filter(Boolean).length,
  );
}

function cutoffMatches(
  slot: MemoryStateSlotSpecV2,
  observedAt: string | undefined,
  observation: MemoryStateValidatedObservationV1["observation"],
): boolean {
  if (slot.evidenceTimeUpperBound === null) {
    return observation.eventTimeCutoffStatus === undefined;
  }
  if (
    observedAt === undefined ||
    !Number.isFinite(Date.parse(observedAt)) ||
    Date.parse(observedAt) > Date.parse(slot.evidenceTimeUpperBound)
  ) {
    return false;
  }
  if (observation.eventTimeInterval === undefined) {
    return observation.eventTimeCutoffStatus === undefined;
  }
  const expected =
    observation.eventTimeInterval.upper > slot.evidenceTimeUpperBound
      ? "straddles"
      : "within";
  return observation.eventTimeCutoffStatus === expected;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
