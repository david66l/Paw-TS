import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import type { MemoryEvidenceAuthorityV2 } from "./evidence-contracts.js";
import {
  type MemoryStateBoundObservationV2,
  type MemoryStateEventTimeIntervalV2,
  type MemoryStateExactSpanV2,
  type MemoryStateObservationProposalV2,
  type MemoryStateSlotSpecV2,
  type MemoryStateSourceLockV2,
  bindMemoryStateObservationV2,
  classifyMemoryStateValueCompositionV2,
} from "./state-frame-v2.js";
import type { MemoryStateObservationVerificationV2 } from "./state-observation-verifier-v2.js";

export const PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1 =
  "paw.memory-state-binding-certificate.v1:host-compiled-source-relative-event-time" as const;

export interface MemoryStateBindingCertificateV1 {
  readonly policyVersion: typeof PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1;
  readonly certificateId: string;
  readonly observationId: string;
  readonly bindingRevision: string;
  readonly slotBinding: Readonly<{
    slotId: string;
    slotRevision: string;
    requirementId: string;
    groupId: string;
    necessity: "required" | "contextual";
    semanticDescriptorDigest: string;
    queryAnchorDigest: string;
    roleConstraint: "user" | "assistant";
    authorityMode:
      | "user_fact"
      | "explicit_assistant_report"
      | "certified_dialogue_artifact";
    originRevision: string;
    temporalBindingRevision: string;
  }>;
  readonly evidenceBinding: Readonly<{
    sourceLockDigest: string;
    sourceId: string;
    evidenceRef: string;
    contentDigest: string;
    role: "user" | "assistant";
    authority: MemoryEvidenceAuthorityV2;
    dialogueCertificateRevision?: string;
  }>;
  readonly claimBinding: Readonly<{
    /** Deterministic local evidence window containing every exact value span. */
    supportSpan: MemoryStateExactSpanV2;
    subject: Readonly<{
      referent: "query_user" | "assistant";
      basis: "speaker_deictic" | "certified_dialogue_pair";
    }>;
    predicate: Readonly<{
      kind: MemoryStateObservationProposalV2["predicateKind"];
      polarity: MemoryStateObservationProposalV2["polarity"];
      modality: MemoryStateObservationProposalV2["modality"];
    }>;
    value: Readonly<{
      exactSpans: readonly MemoryStateExactSpanV2[];
      composition: "single" | "contiguous_composite" | "ordered_tuple";
      surfaceDigest: string;
    }>;
    eventTime: Readonly<{
      exactSpans: readonly MemoryStateExactSpanV2[];
      basis: MemoryStateBoundObservationV2["eventTimeBasis"];
      interval?: MemoryStateEventTimeIntervalV2;
      cutoffStatus?: "within" | "straddles";
      sourceSessionAnchor?: Readonly<{
        sourceTimestamp: string;
        sourceTimestampRevision: string;
      }>;
    }>;
    readonly durationEndpointRole: MemoryStateBoundObservationV2["durationEndpointRole"];
    readonly lifecycle: Readonly<{
      relation: MemoryStateBoundObservationV2["lifecycleRelation"];
      targetEvidenceRef?: string;
      target?: Readonly<{
        observationId: string;
        bindingRevision: string;
        slotId: string;
        evidenceRef: string;
        sourceId: string;
        predicateKind: MemoryStateBoundObservationV2["predicateKind"];
        polarity: MemoryStateBoundObservationV2["polarity"];
        modality: MemoryStateBoundObservationV2["modality"];
        valueSpans: readonly MemoryStateExactSpanV2[];
        eventTimeSpans: readonly MemoryStateExactSpanV2[];
        eventTimeBasis: MemoryStateBoundObservationV2["eventTimeBasis"];
        observedAt?: string;
      }>;
    }>;
  }>;
  readonly semanticAttestation: Readonly<{
    verifierVersion: string;
    verificationRevision: string;
    verificationInputDigest: string;
    decision: "accepted";
  }>;
}

export interface MemoryStateValidatedObservationV1 {
  readonly observation: MemoryStateBoundObservationV2;
  readonly certificate: MemoryStateBindingCertificateV1;
}

export interface MemoryStateBindingCertificateValidationInputV1 {
  readonly query: string;
  readonly slots: readonly MemoryStateSlotSpecV2[];
  readonly sourceLock: MemoryStateSourceLockV2;
  readonly proposedObservations: readonly MemoryStateBoundObservationV2[];
  readonly verification: MemoryStateObservationVerificationV2;
}

export function compileMemoryStateBindingCertificatesV1(
  input: MemoryStateBindingCertificateValidationInputV1,
): readonly MemoryStateValidatedObservationV1[] {
  const slotById = new Map(input.slots.map((slot) => [slot.slotId, slot]));
  const itemByRef = new Map(
    input.sourceLock.items.map((item) => [item.evidenceRef, item]),
  );
  const observationById = new Map(
    input.proposedObservations.map((observation) => [
      observation.observationId,
      observation,
    ]),
  );
  if (
    slotById.size !== input.slots.length ||
    itemByRef.size !== input.sourceLock.items.length ||
    observationById.size !== input.proposedObservations.length ||
    !input.verification.verifierVersion.trim() ||
    !input.verification.verificationRevision.trim()
  ) {
    throw namedError("MemoryStateBindingCertificateInputInvalid");
  }
  const accepted = new Set(input.verification.acceptedObservationIds);
  const rejected = new Set(input.verification.rejectedObservationIds);
  if (
    accepted.size !== input.verification.acceptedObservationIds.length ||
    rejected.size !== input.verification.rejectedObservationIds.length ||
    [...accepted].some((id) => rejected.has(id) || !observationById.has(id)) ||
    [...rejected].some((id) => !observationById.has(id)) ||
    accepted.size + rejected.size !== observationById.size
  ) {
    throw namedError("MemoryStateBindingCertificatePartitionInvalid");
  }
  const verificationInputDigest = hashCanonicalJsonV1({
    policyVersion: PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1,
    queryDigest: hashTextV1(input.query),
    sourceLockDigest: input.sourceLock.sourceLockDigest,
    slotRevisions: input.slots.map((slot) => slot.slotRevision),
    proposedBindings: input.proposedObservations.map((observation) => ({
      observationId: observation.observationId,
      bindingRevision: observation.bindingRevision,
    })),
  } as JsonValue);

  return Object.freeze(
    input.verification.acceptedObservationIds.map((observationId) => {
      const observation = observationById.get(observationId);
      const slot = observation ? slotById.get(observation.slotId) : undefined;
      const item = observation
        ? itemByRef.get(observation.evidenceRef)
        : undefined;
      if (!observation || !slot || !item) {
        throw namedError("MemoryStateBindingCertificateInputInvalid");
      }
      const lifecycleTargetCandidates =
        observation.lifecycleRelation === "none" ||
        observation.lifecycleTargetEvidenceRef === undefined
          ? []
          : input.proposedObservations.filter(
              (candidate) =>
                candidate.slotId === observation.slotId &&
                candidate.evidenceRef ===
                  observation.lifecycleTargetEvidenceRef,
            );
      if (
        (observation.lifecycleRelation === "none" &&
          lifecycleTargetCandidates.length !== 0) ||
        (observation.lifecycleRelation !== "none" &&
          lifecycleTargetCandidates.length !== 1)
      ) {
        throw namedError("MemoryStateBindingCertificateLifecycleInvalid");
      }
      const lifecycleTarget = lifecycleTargetCandidates[0];
      const rebound = bindMemoryStateObservationV2({
        slot,
        sourceLock: input.sourceLock,
        proposal: {
          slotId: observation.slotId,
          evidenceRef: observation.evidenceRef,
          valueSpans: observation.valueSpans.map(({ start, end }) => ({
            start,
            end,
          })),
          eventTimeSpans: observation.eventTimeSpans.map(({ start, end }) => ({
            start,
            end,
          })),
          eventTimeBasis: observation.eventTimeBasis,
          durationEndpointRole: observation.durationEndpointRole,
          lifecycleRelation: observation.lifecycleRelation,
          ...(observation.lifecycleTargetEvidenceRef === undefined
            ? {}
            : {
                lifecycleTargetEvidenceRef:
                  observation.lifecycleTargetEvidenceRef,
              }),
          predicateKind: observation.predicateKind,
          polarity: observation.polarity,
          modality: observation.modality,
        },
      });
      if (
        hashCanonicalJsonV1(rebound as unknown as JsonValue) !==
        hashCanonicalJsonV1(observation as unknown as JsonValue)
      ) {
        throw namedError("MemoryStateBindingCertificateObservationInvalid");
      }
      const supportSpan = compileSupportSpan(
        item.content,
        observation.valueSpans,
      );
      const valueComposition = classifyMemoryStateValueCompositionV2(
        item.content,
        observation.valueSpans,
      );
      const identity = {
        policyVersion: PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1,
        observationId: observation.observationId,
        bindingRevision: observation.bindingRevision,
        slotBinding: {
          slotId: slot.slotId,
          slotRevision: slot.slotRevision,
          requirementId: slot.requirementId,
          groupId: slot.groupId,
          necessity: slot.necessity,
          semanticDescriptorDigest: slot.semanticDescriptor.descriptorRevision,
          queryAnchorDigest: slot.queryAnchor.textDigest,
          roleConstraint: slot.roleConstraint,
          authorityMode: slot.authorityMode,
          originRevision: slot.originRevision,
          temporalBindingRevision: slot.temporalBindingRevision,
        },
        evidenceBinding: {
          sourceLockDigest: input.sourceLock.sourceLockDigest,
          sourceId: item.sourceId,
          evidenceRef: item.evidenceRef,
          contentDigest: hashTextV1(item.content),
          role: item.role,
          authority: item.authority,
          ...(item.certificateRevision === undefined
            ? {}
            : { dialogueCertificateRevision: item.certificateRevision }),
        },
        claimBinding: {
          supportSpan,
          subject: {
            referent:
              item.role === "user"
                ? ("query_user" as const)
                : ("assistant" as const),
            basis:
              item.role === "assistant" && item.certificateRevision
                ? ("certified_dialogue_pair" as const)
                : ("speaker_deictic" as const),
          },
          predicate: {
            kind: observation.predicateKind,
            polarity: observation.polarity,
            modality: observation.modality,
          },
          value: {
            exactSpans: observation.valueSpans,
            composition: valueComposition,
            surfaceDigest: hashCanonicalJsonV1(
              observation.valueSpans.map(
                (span) => span.textDigest,
              ) as JsonValue,
            ),
          },
          eventTime: {
            exactSpans: observation.eventTimeSpans,
            basis: observation.eventTimeBasis,
            ...(observation.eventTimeInterval === undefined
              ? {}
              : { interval: observation.eventTimeInterval }),
            ...(observation.eventTimeCutoffStatus === undefined
              ? {}
              : { cutoffStatus: observation.eventTimeCutoffStatus }),
            ...((observation.eventTimeBasis !==
              "source_session_contemporaneous" &&
              observation.eventTimeBasis !== "source_session_relative_span") ||
            item.observedAt === undefined
              ? {}
              : {
                  sourceSessionAnchor: {
                    sourceTimestamp: item.observedAt,
                    sourceTimestampRevision: hashCanonicalJsonV1({
                      schemaVersion:
                        "paw.memory-source-session-timestamp-anchor.v1",
                      sourceLockDigest: input.sourceLock.sourceLockDigest,
                      sourceId: item.sourceId,
                      evidenceRef: item.evidenceRef,
                      contentDigest: hashTextV1(item.content),
                      sourceTimestamp: item.observedAt,
                    } as JsonValue),
                  },
                }),
          },
          durationEndpointRole: observation.durationEndpointRole,
          lifecycle: {
            relation: observation.lifecycleRelation,
            ...(observation.lifecycleTargetEvidenceRef === undefined
              ? {}
              : {
                  targetEvidenceRef:
                    observation.lifecycleTargetEvidenceRef,
                }),
            ...(lifecycleTarget === undefined
              ? {}
              : {
                  target: {
                    observationId: lifecycleTarget.observationId,
                    bindingRevision: lifecycleTarget.bindingRevision,
                    slotId: lifecycleTarget.slotId,
                    evidenceRef: lifecycleTarget.evidenceRef,
                    sourceId: lifecycleTarget.sourceId,
                    predicateKind: lifecycleTarget.predicateKind,
                    polarity: lifecycleTarget.polarity,
                    modality: lifecycleTarget.modality,
                    valueSpans: lifecycleTarget.valueSpans,
                    eventTimeSpans: lifecycleTarget.eventTimeSpans,
                    eventTimeBasis: lifecycleTarget.eventTimeBasis,
                    ...(lifecycleTarget.observedAt === undefined
                      ? {}
                      : { observedAt: lifecycleTarget.observedAt }),
                  },
                }),
          },
        },
        semanticAttestation: {
          verifierVersion: input.verification.verifierVersion,
          verificationRevision: input.verification.verificationRevision,
          verificationInputDigest,
          decision: "accepted" as const,
        },
      };
      const certificate = Object.freeze({
        ...identity,
        certificateId: hashCanonicalJsonV1(identity as unknown as JsonValue),
      });
      return Object.freeze({ observation, certificate });
    }),
  );
}

export function validateMemoryStateBindingCertificateV1(
  candidate: MemoryStateValidatedObservationV1,
  input: MemoryStateBindingCertificateValidationInputV1,
): MemoryStateValidatedObservationV1 {
  const expected = compileMemoryStateBindingCertificatesV1(input).find(
    (item) =>
      item.observation.observationId === candidate.observation.observationId,
  );
  if (
    !expected ||
    hashCanonicalJsonV1(expected as unknown as JsonValue) !==
      hashCanonicalJsonV1(candidate as unknown as JsonValue)
  ) {
    throw namedError("MemoryStateBindingCertificateBoundaryInvalid");
  }
  return candidate;
}

export function compileMemoryStateClaimSupportSpanV1(
  content: string,
  valueSpans: readonly Readonly<{ start: number; end: number }>[],
): MemoryStateExactSpanV2 {
  return compileSupportSpan(content, valueSpans);
}

function compileSupportSpan(
  content: string,
  valueSpans: readonly Readonly<{ start: number; end: number }>[],
): MemoryStateExactSpanV2 {
  if (!content || valueSpans.length < 1 || valueSpans.length > 4) {
    throw namedError("MemoryStateBindingCertificateSpanInvalid");
  }
  const ordered = [...valueSpans].sort(
    (left, right) => left.start - right.start,
  );
  if (
    ordered.some(
      (span, index) =>
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        span.end > content.length ||
        (index > 0 && (ordered[index - 1]?.end ?? 0) > span.start),
    )
  ) {
    throw namedError("MemoryStateBindingCertificateSpanInvalid");
  }
  const first = ordered[0] as Readonly<{ start: number; end: number }>;
  const last = ordered.at(-1) as Readonly<{ start: number; end: number }>;
  const boundary = /[\n\r.!?。！？;；]/u;
  let start = first.start;
  while (start > 0 && !boundary.test(content[start - 1] ?? "")) start -= 1;
  while (start < first.start && /\s/u.test(content[start] ?? "")) start += 1;
  let end = last.end;
  while (end < content.length && !boundary.test(content[end] ?? "")) end += 1;
  if (end < content.length) end += 1;
  while (end > last.end && /\s/u.test(content[end - 1] ?? "")) end -= 1;
  if (end - start > 2_048) {
    if (last.end - first.start > 2_048) {
      throw namedError("MemoryStateBindingCertificateSupportSpanTooWide");
    }
    start = Math.max(0, first.start - 512);
    end = Math.min(content.length, Math.max(last.end, start + 2_048));
    start = Math.max(0, Math.min(start, end - 2_048));
  }
  const text = content.slice(start, end);
  return Object.freeze({ start, end, text, textDigest: hashTextV1(text) });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
