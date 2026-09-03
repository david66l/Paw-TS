import { describe, expect, test } from "bun:test";
import { hashTextV1 } from "../src/canonical.js";
import { compileMemoryDialogueCertificateRegistryV1 } from "../src/dialogue-certificate.js";
import { projectEvidenceFirstMemoryContextPacketV1 } from "../src/evidence-context-adapter.js";
import { createMemoryEvidenceResolverV1 } from "../src/evidence-resolver.js";
import { compileMemoryEvidenceSelectorGroupsV1 } from "../src/evidence-selector-groups.js";
import type { MemoryEvidenceTriageAssessmentV1 } from "../src/evidence-support-selector.js";
import { compileMemoryQueryAnswerOriginV1 } from "../src/query-answer-origin.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "../src/query-plan-contracts.js";
import { compileMemorySelectorExecutionSnapshotV1 } from "../src/selector-execution-snapshot-v1.js";
import { buildMemoryStateFrameShadowV2 } from "../src/state-frame-shadow-v2.js";
import {
  type MemoryStateSlotSpecV2,
  bindMemoryStateObservationV2,
  compileMemoryStateSlotsV2,
  compileMemoryStateSourceLockV2,
  resolveMemoryStateFrameV2,
} from "../src/state-frame-v2.js";
import {
  buildMemoryStateObservationBindingRequestV2,
  createJsonMemoryStateObservationBinderV2,
  parseMemoryStateObservationBindingV2,
} from "../src/state-observation-binder-v2.js";
import { createJsonMemoryStateObservationVerifierV2 } from "../src/state-observation-verifier-v2.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "../src/temporal-constraint.js";

const query = "What are the latest values for the two tracked settings?";
const baseIntent: MemoryEvidenceQueryIntentV3 = {
  answerShape: "compare",
  temporalMode: "latest",
  roleConstraint: "user",
  needsPlanning: true,
};

function requirement(
  requirementId: string,
  overrides: Partial<MemoryEvidenceRequirementV3> = {},
): MemoryEvidenceRequirementV3 {
  return {
    requirementId,
    label: requirementId,
    searchText: requirementId,
    temporalMode: "latest",
    roleConstraint: "user",
    relation: "comparative",
    coverageMode: "latest",
    minimumEvidence: 1,
    dependencyRelation: "independent",
    dependsOnRequirementIds: [],
    ...overrides,
  };
}

function slotsFor(
  requirements: readonly MemoryEvidenceRequirementV3[],
  intent: MemoryEvidenceQueryIntentV3 = baseIntent,
): readonly MemoryStateSlotSpecV2[] {
  return compileMemoryStateSlotsV2({
    query,
    intent,
    requirements,
    origin: compileMemoryQueryAnswerOriginV1(query),
    temporalConstraints: new Map(
      requirements.map((item) => [
        item.requirementId,
        bindMemoryEvidenceTemporalConstraintV1({
          query,
          queryEnvelopeMode: intent.temporalMode,
          leafMode: item.temporalMode,
          constraint: item.temporalConstraint,
        }),
      ]),
    ),
  });
}

function acceptingVerifier() {
  return createJsonMemoryStateObservationVerifierV2({
    model: {
      async complete(request) {
        const payload = JSON.parse(request.user) as {
          observations: readonly Readonly<{ observationId: string }>[];
        };
        return {
          status: "completed" as const,
          text: JSON.stringify({
            acceptedObservationIds: payload.observations.map(
              (observation) => observation.observationId,
            ),
            rejectedObservationIds: [],
          }),
        };
      },
    },
  });
}

function emptyDialogueRegistry(
  lockedSourceIds: readonly string[],
  originRevision: string,
) {
  return compileMemoryDialogueCertificateRegistryV1({
    lockedSourceIds,
    proofs: [],
    verifierVersion: null,
    verificationRevision: null,
    originRevision,
  });
}

function selectorSnapshotForShadow(input: {
  query: string;
  intent: MemoryEvidenceQueryIntentV3;
  requirements: readonly MemoryEvidenceRequirementV3[];
  temporalConstraints: readonly ReturnType<
    typeof bindMemoryEvidenceTemporalConstraintV1
  >[];
  lockedSourceIds: readonly string[];
  assessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
}) {
  const groups = compileMemoryEvidenceSelectorGroupsV1({
    intent: input.intent,
    requirements: input.requirements,
  });
  return compileMemorySelectorExecutionSnapshotV1({
    query: input.query,
    intent: input.intent,
    requirements: input.requirements,
    temporalConstraints: input.temporalConstraints,
    candidateScopes: input.requirements.map((requirement) => {
      const assessment = input.assessments.find(
        (item) => item.requirementId === requirement.requirementId,
      );
      return {
        requirementId: requirement.requirementId,
        evidenceRefs: [
          ...(assessment?.supportingEvidenceRefs ?? []),
          ...(assessment?.contradictingEvidenceRefs ?? []),
          ...(assessment?.unknownEvidenceRefs ?? []),
        ],
      };
    }),
    lockedSourceIds: input.lockedSourceIds,
    originRevision: compileMemoryQueryAnswerOriginV1(input.query)
      .originRevision,
    selectorVersion: "test-selector",
    selectionRevision: "test-selection",
    committedAttempt: "baseline",
    attemptCount: 1,
    groups: groups.map((group) => ({
      groupId: group.groupId,
      requirementIds: group.requirementIds,
      status: "committed",
      assessments: input.assessments.filter((assessment) =>
        group.requirementIds.includes(assessment.requirementId),
      ),
      failureCodes: [],
    })),
  });
}

describe("proof-carrying locked-source state frame v2", () => {
  test("compiles independent operands as isolated slots and recommendations atomically", () => {
    const requirements = [requirement("left"), requirement("right")];
    const slots = slotsFor(requirements);
    expect(slots).toHaveLength(2);
    expect(slots[0]?.groupId).not.toBe(slots[1]?.groupId);
    expect(slots.map((slot) => slot.operation)).toEqual([
      "resolve_latest",
      "resolve_latest",
    ]);
    expect(slots[0]?.queryAnchor).toEqual({
      start: 0,
      end: query.length,
      textDigest: expect.any(String),
    });
    expect(slots[0]?.semanticDescriptor).toEqual({
      label: "left",
      searchText: "left",
      descriptorRevision: expect.any(String),
    });

    const recommendationSlots = slotsFor(requirements, {
      ...baseIntent,
      answerShape: "recommend",
    });
    expect(recommendationSlots[0]?.groupId).toBe(
      recommendationSlots[1]?.groupId,
    );
  });

  test("validates exact spans against an immutable source lock", () => {
    const [slot] = slotsFor([requirement("home")]);
    const content = "The current home is Paris.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-1",
        evidenceRef: "ref-1",
        content,
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-01-02T00:00:00Z",
        episodeOrder: 1,
        turnOrder: 2,
      },
    ]);
    const start = content.indexOf("Paris");
    const bound = bindMemoryStateObservationV2({
      slot: slot as MemoryStateSlotSpecV2,
      sourceLock,
      proposal: {
        slotId: slot?.slotId as string,
        evidenceRef: "ref-1",
        valueSpans: [{ start, end: start + "Paris".length }],
        predicateKind: "update",
        polarity: "positive",
        modality: "observed",
      },
    });
    expect(bound.sourceLockDigest).toBe(sourceLock.sourceLockDigest);
    expect(bound.valueSpans[0]?.textDigest).toHaveLength(64);
    expect(() =>
      bindMemoryStateObservationV2({
        slot: slot as MemoryStateSlotSpecV2,
        sourceLock,
        proposal: {
          slotId: slot?.slotId as string,
          evidenceRef: "ref-1",
          valueSpans: [{ start, end: content.length + 1 }],
          predicateKind: "update",
          polarity: "positive",
          modality: "observed",
        },
      }),
    ).toThrow("MemoryStateObservationSpanInvalid");
  });

  test("requires a dialogue certificate for an origin-late-bound assistant slot", () => {
    const certifiedQuery = "Can you remember the earlier label for me?";
    const origin = compileMemoryQueryAnswerOriginV1(certifiedQuery);
    const assistantIntent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "assistant",
      needsPlanning: true,
    };
    const assistantRequirement = requirement("answer", {
      label: "earlier label",
      searchText: "earlier label",
      temporalMode: "any",
      roleConstraint: "assistant",
      relation: "direct",
      coverageMode: "any",
    });
    const [slot] = compileMemoryStateSlotsV2({
      query: certifiedQuery,
      intent: assistantIntent,
      requirements: [assistantRequirement],
      origin,
      temporalConstraints: new Map([
        [
          "answer",
          bindMemoryEvidenceTemporalConstraintV1({
            query: certifiedQuery,
            queryEnvelopeMode: "any",
            leafMode: "any",
          }),
        ],
      ]),
    });
    expect(slot?.authorityMode).toBe("certified_dialogue_artifact");
    const item = {
      sourceId: "source-assistant",
      evidenceRef: "assistant-ref",
      content: "The earlier label was amber.",
      authority: "context_only" as const,
      role: "assistant" as const,
    };
    const proposal = {
      slotId: slot?.slotId as string,
      evidenceRef: "assistant-ref",
      valueSpans: [{ start: 22, end: 27 }],
      predicateKind: "assert" as const,
      polarity: "positive" as const,
      modality: "observed" as const,
    };
    expect(() =>
      bindMemoryStateObservationV2({
        slot: slot as MemoryStateSlotSpecV2,
        sourceLock: compileMemoryStateSourceLockV2([item]),
        proposal,
      }),
    ).toThrow("MemoryStateObservationAuthorityInvalid");
    expect(
      bindMemoryStateObservationV2({
        slot: slot as MemoryStateSlotSpecV2,
        sourceLock: compileMemoryStateSourceLockV2([
          { ...item, certificateRevision: "certificate-revision" },
        ]),
        proposal,
      }).certificateRevision,
    ).toBe("certificate-revision");
  });

  test("rejects state observed after the trusted temporal cutoff", () => {
    const requirementItem = requirement("home");
    const [slot] = compileMemoryStateSlotsV2({
      query,
      intent: baseIntent,
      requirements: [requirementItem],
      origin: compileMemoryQueryAnswerOriginV1(query),
      temporalConstraints: new Map([
        [
          "home",
          bindMemoryEvidenceTemporalConstraintV1({
            query,
            queryEnvelopeMode: "latest",
            leafMode: "latest",
            evidenceTimeUpperBound: "2025-01-01T00:00:00Z",
          }),
        ],
      ]),
    });
    const content = "Home is Paris.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-late",
        evidenceRef: "ref-late",
        content,
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-01-02T00:00:00Z",
      },
    ]);
    expect(() =>
      bindMemoryStateObservationV2({
        slot: slot as MemoryStateSlotSpecV2,
        sourceLock,
        proposal: {
          slotId: slot?.slotId as string,
          evidenceRef: "ref-late",
          valueSpans: [{ start: 8, end: 13 }],
          predicateKind: "assert",
          polarity: "positive",
          modality: "observed",
        },
      }),
    ).toThrow("MemoryStateObservationTemporalInvalid");
  });

  test("lets later observed state win without allowing a later plan to overwrite it", () => {
    const [slot] = slotsFor([requirement("home")]);
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-old",
        evidenceRef: "ref-old",
        content: "Home was Rome.",
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-01-01T00:00:00Z",
        episodeOrder: 1,
      },
      {
        sourceId: "source-new",
        evidenceRef: "ref-new",
        content: "Home is Paris.",
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-02-01T00:00:00Z",
        episodeOrder: 2,
      },
      {
        sourceId: "source-plan",
        evidenceRef: "ref-plan",
        content: "I plan to move to Berlin.",
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-03-01T00:00:00Z",
        episodeOrder: 3,
      },
    ]);
    const bind = (
      evidenceRef: string,
      value: string,
      modality: "observed" | "plan",
    ) => {
      const item = sourceLock.items.find(
        (candidate) => candidate.evidenceRef === evidenceRef,
      );
      const start = item?.content.indexOf(value) ?? -1;
      return bindMemoryStateObservationV2({
        slot: slot as MemoryStateSlotSpecV2,
        sourceLock,
        proposal: {
          slotId: slot?.slotId as string,
          evidenceRef,
          valueSpans: [{ start, end: start + value.length }],
          predicateKind: modality === "plan" ? "assert" : "update",
          polarity: "positive",
          modality,
        },
      });
    };
    const frame = resolveMemoryStateFrameV2({
      slots: [slot as MemoryStateSlotSpecV2],
      sourceLock,
      observations: [
        bind("ref-old", "Rome", "observed"),
        bind("ref-new", "Paris", "observed"),
        bind("ref-plan", "Berlin", "plan"),
      ],
    });
    expect(frame.slots[0]?.status).toBe("complete");
    expect(frame.slots[0]?.current[0]?.evidenceRef).toBe("ref-new");
    expect(frame.slots[0]?.history.map((item) => item.evidenceRef)).toEqual([
      "ref-plan",
      "ref-old",
    ]);
  });

  test("orders explicit event dates ahead of later recollection timestamps", () => {
    const [slot] = slotsFor([requirement("home")]);
    const olderEvent = "On 2020-01-01, home was Rome.";
    const newerEvent = "On 2024-01-01, home became Paris.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-recalled-late",
        evidenceRef: "ref-older-event",
        content: olderEvent,
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-03-01T00:00:00Z",
      },
      {
        sourceId: "source-recalled-early",
        evidenceRef: "ref-newer-event",
        content: newerEvent,
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-02-01T00:00:00Z",
      },
    ]);
    const bind = (
      evidenceRef: string,
      content: string,
      value: string,
      date: string,
    ) =>
      bindMemoryStateObservationV2({
        slot: slot as MemoryStateSlotSpecV2,
        sourceLock,
        proposal: {
          slotId: slot?.slotId as string,
          evidenceRef,
          valueSpans: [
            {
              start: content.indexOf(value),
              end: content.indexOf(value) + value.length,
            },
          ],
          eventTimeSpans: [
            {
              start: content.indexOf(date),
              end: content.indexOf(date) + date.length,
            },
          ],
          predicateKind: "update",
          polarity: "positive",
          modality: "observed",
        },
      });
    const frame = resolveMemoryStateFrameV2({
      slots: [slot as MemoryStateSlotSpecV2],
      sourceLock,
      observations: [
        bind("ref-older-event", olderEvent, "Rome", "2020-01-01"),
        bind("ref-newer-event", newerEvent, "Paris", "2024-01-01"),
      ],
    });
    expect(frame.slots[0]?.current[0]).toMatchObject({
      evidenceRef: "ref-newer-event",
      eventTime: "2024-01-01T00:00:00.000Z",
      eventTimePrecision: "day",
    });
  });

  test("keeps overlapping year and day precision ambiguous", () => {
    const [slot] = slotsFor([requirement("home")]);
    const yearText = "In 2024, home was Rome.";
    const dayText = "On 2024-06-01, home became Paris.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-year",
        evidenceRef: "ref-year",
        content: yearText,
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-01-01T00:00:00Z",
      },
      {
        sourceId: "source-day",
        evidenceRef: "ref-day",
        content: dayText,
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-02-01T00:00:00Z",
      },
    ]);
    const bind = (
      evidenceRef: string,
      content: string,
      value: string,
      eventTime: string,
    ) =>
      bindMemoryStateObservationV2({
        slot: slot as MemoryStateSlotSpecV2,
        sourceLock,
        proposal: {
          slotId: slot?.slotId as string,
          evidenceRef,
          valueSpans: [
            {
              start: content.indexOf(value),
              end: content.indexOf(value) + value.length,
            },
          ],
          eventTimeSpans: [
            {
              start: content.indexOf(eventTime),
              end: content.indexOf(eventTime) + eventTime.length,
            },
          ],
          predicateKind: "update",
          polarity: "positive",
          modality: "observed",
        },
      });
    const frame = resolveMemoryStateFrameV2({
      slots: [slot as MemoryStateSlotSpecV2],
      sourceLock,
      observations: [
        bind("ref-year", yearText, "Rome", "2024"),
        bind("ref-day", dayText, "Paris", "2024-06-01"),
      ],
    });
    expect(frame.slots[0]?.status).toBe("conflict");
  });

  test("does not compare an event clock with an observation clock", () => {
    const [slot] = slotsFor([requirement("home")]);
    const eventText = "On 2020-01-01, home was Rome.";
    const observedText = "Home is Paris.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-event",
        evidenceRef: "ref-event",
        content: eventText,
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-03-01T00:00:00Z",
      },
      {
        sourceId: "source-observed",
        evidenceRef: "ref-observed",
        content: observedText,
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-02-01T00:00:00Z",
      },
    ]);
    const eventObservation = bindMemoryStateObservationV2({
      slot: slot as MemoryStateSlotSpecV2,
      sourceLock,
      proposal: {
        slotId: slot?.slotId as string,
        evidenceRef: "ref-event",
        valueSpans: [{ start: 24, end: 28 }],
        eventTimeSpans: [{ start: 3, end: 13 }],
        predicateKind: "update",
        polarity: "positive",
        modality: "observed",
      },
    });
    const observedObservation = bindMemoryStateObservationV2({
      slot: slot as MemoryStateSlotSpecV2,
      sourceLock,
      proposal: {
        slotId: slot?.slotId as string,
        evidenceRef: "ref-observed",
        valueSpans: [{ start: 8, end: 13 }],
        predicateKind: "update",
        polarity: "positive",
        modality: "observed",
      },
    });
    const frame = resolveMemoryStateFrameV2({
      slots: [slot as MemoryStateSlotSpecV2],
      sourceLock,
      observations: [eventObservation, observedObservation],
    });
    expect(frame.slots[0]?.status).toBe("conflict");
    expect(frame.slots[0]?.current).toHaveLength(0);
    expect(frame.slots[0]?.history).toHaveLength(0);
    expect(frame.slots[0]?.conflicts).toHaveLength(2);
    expect(
      new Set(
        frame.slots.flatMap((resolved) =>
          [...resolved.current, ...resolved.history, ...resolved.conflicts].map(
            (observation) => observation.observationId,
          ),
        ),
      ).size,
    ).toBe(2);
  });

  test("keeps an event interval that straddles the cutoff partial", () => {
    const item = requirement("home");
    const [slot] = compileMemoryStateSlotsV2({
      query,
      intent: baseIntent,
      requirements: [item],
      origin: compileMemoryQueryAnswerOriginV1(query),
      temporalConstraints: new Map([
        [
          "home",
          bindMemoryEvidenceTemporalConstraintV1({
            query,
            queryEnvelopeMode: "latest",
            leafMode: "latest",
            evidenceTimeUpperBound: "2024-06-01T00:00:00Z",
          }),
        ],
      ]),
    });
    const content = "In 2024, home was Rome.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-year",
        evidenceRef: "ref-year",
        content,
        authority: "user_asserted",
        role: "user",
        observedAt: "2024-05-01T00:00:00Z",
      },
    ]);
    const observation = bindMemoryStateObservationV2({
      slot: slot as MemoryStateSlotSpecV2,
      sourceLock,
      proposal: {
        slotId: slot?.slotId as string,
        evidenceRef: "ref-year",
        valueSpans: [{ start: 18, end: 22 }],
        eventTimeSpans: [{ start: 3, end: 7 }],
        predicateKind: "update",
        polarity: "positive",
        modality: "observed",
      },
    });
    expect(observation.eventTimeCutoffStatus).toBe("straddles");
    expect(
      resolveMemoryStateFrameV2({
        slots: [slot as MemoryStateSlotSpecV2],
        sourceLock,
        observations: [observation],
      }).slots[0]?.status,
    ).toBe("partial");
  });

  test("does not normalize an impossible calendar date", () => {
    const [slot] = slotsFor([requirement("home")]);
    const content = "On 2025-02-30, home became Paris.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-invalid-date",
        evidenceRef: "ref-invalid-date",
        content,
        authority: "user_asserted",
        role: "user",
      },
    ]);
    const observation = bindMemoryStateObservationV2({
      slot: slot as MemoryStateSlotSpecV2,
      sourceLock,
      proposal: {
        slotId: slot?.slotId as string,
        evidenceRef: "ref-invalid-date",
        valueSpans: [{ start: 27, end: 32 }],
        eventTimeSpans: [{ start: 3, end: 13 }],
        predicateKind: "update",
        polarity: "positive",
        modality: "observed",
      },
    });
    expect(observation.eventTimeInterval).toBeUndefined();
  });

  test("binds an exact relative-time span against only its source session", () => {
    const [slot] = slotsFor([requirement("art-event")]);
    const content = "I attended the gallery opening two weeks ago.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-relative",
        evidenceRef: "ref-relative",
        content,
        authority: "user_asserted",
        role: "user",
        observedAt: "2024-03-01T19:30:00Z",
      },
    ]);
    const observation = bindMemoryStateObservationV2({
      slot: slot as MemoryStateSlotSpecV2,
      sourceLock,
      proposal: {
        slotId: slot?.slotId as string,
        evidenceRef: "ref-relative",
        valueSpans: [{ start: 15, end: 30 }],
        eventTimeSpans: [{ start: 31, end: 44 }],
        eventTimeBasis: "source_session_relative_span",
        predicateKind: "assert",
        polarity: "positive",
        modality: "observed",
      },
    });
    expect(observation.eventTimeBasis).toBe("source_session_relative_span");
    expect(observation.eventTimeInterval).toEqual({
      lower: "2024-02-16T00:00:00.000Z",
      upper: "2024-02-17T00:00:00.000Z",
      precision: "day",
    });
  });

  test("rejects a source-relative basis without a resolvable quoted anchor", () => {
    const [slot] = slotsFor([requirement("art-event")]);
    const content = "I attended the gallery opening recently.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-relative-invalid",
        evidenceRef: "ref-relative-invalid",
        content,
        authority: "user_asserted",
        role: "user",
        observedAt: "2024-03-01T19:30:00Z",
      },
    ]);
    expect(() =>
      bindMemoryStateObservationV2({
        slot: slot as MemoryStateSlotSpecV2,
        sourceLock,
        proposal: {
          slotId: slot?.slotId as string,
          evidenceRef: "ref-relative-invalid",
          valueSpans: [{ start: 15, end: 30 }],
          eventTimeSpans: [{ start: 31, end: 39 }],
          eventTimeBasis: "source_session_relative_span",
          predicateKind: "assert",
          polarity: "positive",
          modality: "observed",
        },
      }),
    ).toThrow("MemoryStateObservationTemporalBasisInvalid");
  });

  test("separates compare from leaf lookup and keeps it unsupported", () => {
    const compareRequirement = requirement("operand", {
      temporalMode: "any",
      relation: "comparative",
      coverageMode: "any",
    });
    const [slot] = slotsFor([compareRequirement], {
      ...baseIntent,
      temporalMode: "any",
    });
    expect(slot?.operation).toBe("lookup");
    expect(slot?.derivedAnswerOperation).toBe("compare");
    const content = "The operand is alpha.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-operand",
        evidenceRef: "ref-operand",
        content,
        authority: "user_asserted",
        role: "user",
      },
    ]);
    const observation = bindMemoryStateObservationV2({
      slot: slot as MemoryStateSlotSpecV2,
      sourceLock,
      proposal: {
        slotId: slot?.slotId as string,
        evidenceRef: "ref-operand",
        valueSpans: [{ start: 15, end: 20 }],
        predicateKind: "assert",
        polarity: "positive",
        modality: "observed",
      },
    });
    const frame = resolveMemoryStateFrameV2({
      slots: [slot as MemoryStateSlotSpecV2],
      sourceLock,
      observations: [observation],
    });
    expect(frame.slots[0]?.status).toBe("complete");
    expect(frame.derivedOperations).toEqual([
      expect.objectContaining({ kind: "compare", status: "unsupported" }),
    ]);
  });

  test("keeps latest answer-level operators and dependency joins unsupported", () => {
    for (const answerShape of ["compare", "aggregate", "recommend"] as const) {
      const [slot] = slotsFor([requirement(`latest-${answerShape}`)], {
        ...baseIntent,
        answerShape,
      });
      expect(slot?.operation).toBe("resolve_latest");
      expect(slot?.derivedAnswerOperation).toBe(
        answerShape === "recommend" ? "infer_preference" : answerShape,
      );
      const frame = resolveMemoryStateFrameV2({
        slots: [slot as MemoryStateSlotSpecV2],
        sourceLock: compileMemoryStateSourceLockV2([
          {
            sourceId: `source-${answerShape}`,
            evidenceRef: `ref-${answerShape}`,
            content: "Value is alpha.",
            authority: "user_asserted",
            role: "user",
          },
        ]),
        observations: [],
      });
      expect(frame.derivedOperations).toEqual([
        expect.objectContaining({
          kind: answerShape === "recommend" ? "infer_preference" : answerShape,
          status: "unsupported",
        }),
      ]);
    }

    const dependentRequirements = [
      requirement("base"),
      requirement("derived", {
        dependencyRelation: "depends_on",
        dependsOnRequirementIds: ["base"],
      }),
    ];
    const dependentSlots = slotsFor(dependentRequirements, {
      ...baseIntent,
      answerShape: "lookup",
    });
    const dependencyFrame = resolveMemoryStateFrameV2({
      slots: dependentSlots,
      sourceLock: compileMemoryStateSourceLockV2([
        {
          sourceId: "source-dependency",
          evidenceRef: "ref-dependency",
          content: "Dependency evidence.",
          authority: "user_asserted",
          role: "user",
        },
      ]),
      observations: [],
    });
    expect(dependencyFrame.derivedOperations).toContainEqual(
      expect.objectContaining({
        kind: "dependency_join",
        status: "unsupported",
      }),
    );
  });

  test("does not expose a stale current value after a later retraction", () => {
    const [slot] = slotsFor([requirement("home")]);
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-old",
        evidenceRef: "ref-old",
        content: "Home is Paris.",
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-01-01T00:00:00Z",
      },
      {
        sourceId: "source-retract",
        evidenceRef: "ref-retract",
        content: "Paris is no longer my home.",
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-02-01T00:00:00Z",
      },
    ]);
    const bind = (
      evidenceRef: string,
      content: string,
      predicateKind: "assert" | "retract",
    ) => {
      const start = content.indexOf("Paris");
      return bindMemoryStateObservationV2({
        slot: slot as MemoryStateSlotSpecV2,
        sourceLock,
        proposal: {
          slotId: slot?.slotId as string,
          evidenceRef,
          valueSpans: [{ start, end: start + 5 }],
          predicateKind,
          polarity: "positive",
          modality: "observed",
        },
      });
    };
    const frame = resolveMemoryStateFrameV2({
      slots: [slot as MemoryStateSlotSpecV2],
      sourceLock,
      observations: [
        bind("ref-old", "Home is Paris.", "assert"),
        bind("ref-retract", "Paris is no longer my home.", "retract"),
      ],
    });
    expect(frame.slots[0]?.status).toBe("partial");
    expect(frame.slots[0]?.current).toHaveLength(0);
  });

  test("preserves equal-position value conflicts and dependency closure", () => {
    const requirements = [
      requirement("base"),
      requirement("derived", {
        dependencyRelation: "depends_on",
        dependsOnRequirementIds: ["base"],
      }),
    ];
    const [base, derived] = slotsFor(requirements);
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-a",
        evidenceRef: "ref-a",
        content: "Value is alpha.",
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-01-01T00:00:00Z",
        episodeOrder: 1,
        turnOrder: 1,
      },
      {
        sourceId: "source-b",
        evidenceRef: "ref-b",
        content: "Value is beta.",
        authority: "user_asserted",
        role: "user",
        observedAt: "2025-01-01T00:00:00Z",
        episodeOrder: 1,
        turnOrder: 1,
      },
    ]);
    const bind = (evidenceRef: string, value: string) => {
      const item = sourceLock.items.find(
        (candidate) => candidate.evidenceRef === evidenceRef,
      );
      const start = item?.content.indexOf(value) ?? -1;
      return bindMemoryStateObservationV2({
        slot: base as MemoryStateSlotSpecV2,
        sourceLock,
        proposal: {
          slotId: base?.slotId as string,
          evidenceRef,
          valueSpans: [{ start, end: start + value.length }],
          predicateKind: "assert",
          polarity: "positive",
          modality: "observed",
        },
      });
    };
    const frame = resolveMemoryStateFrameV2({
      slots: [base as MemoryStateSlotSpecV2, derived as MemoryStateSlotSpecV2],
      sourceLock,
      observations: [bind("ref-a", "alpha"), bind("ref-b", "beta")],
    });
    expect(frame.slots[0]?.status).toBe("conflict");
    expect(frame.slots[0]?.conflicts).toHaveLength(1);
    expect(frame.slots[1]?.status).toBe("missing");
  });

  test("binds independent groups from one response and closes only the invalid group", () => {
    const slots = slotsFor([requirement("left"), requirement("right")]);
    const leftContent = "Left value is alpha.";
    const rightContent = "Right value is beta.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-left",
        evidenceRef: "raw-left-ref",
        content: leftContent,
        authority: "user_asserted",
        role: "user",
      },
      {
        sourceId: "source-right",
        evidenceRef: "raw-right-ref",
        content: rightContent,
        authority: "user_asserted",
        role: "user",
      },
    ]);
    const bindingInput = {
      query,
      slots,
      sourceLock,
      slotScopes: [
        { slotId: slots[0]?.slotId as string, evidenceRefs: ["raw-left-ref"] },
        { slotId: slots[1]?.slotId as string, evidenceRefs: ["raw-right-ref"] },
      ],
    };
    const request = buildMemoryStateObservationBindingRequestV2(bindingInput);
    expect(request.user).not.toContain("raw-left-ref");
    const groups = parseMemoryStateObservationBindingV2(
      JSON.stringify({
        observations: [
          {
            slotId: slots[0]?.slotId,
            evidenceRef: "e0",
            valueSpans: [{ text: "alpha", occurrence: 0 }],
            eventTimeSpans: [],
            predicateKind: "assert",
            polarity: "positive",
            modality: "observed",
          },
          {
            slotId: slots[1]?.slotId,
            evidenceRef: "e1",
            valueSpans: [{ text: "not present", occurrence: 0 }],
            eventTimeSpans: [],
            predicateKind: "assert",
            polarity: "positive",
            modality: "observed",
          },
        ],
      }),
      bindingInput,
    );
    expect(groups.map((group) => group.status)).toEqual([
      "completed",
      "fallback",
    ]);
    expect(groups[0]?.observations).toHaveLength(1);
    expect(groups[1]?.observations).toHaveLength(0);
  });

  test("treats an unknown slot as a whole-response structural failure", () => {
    const slots = slotsFor([requirement("left")]);
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-left",
        evidenceRef: "raw-left-ref",
        content: "Left value is alpha.",
        authority: "user_asserted",
        role: "user",
      },
    ]);
    expect(() =>
      parseMemoryStateObservationBindingV2(
        JSON.stringify({
          observations: [
            {
              slotId: "unknown-slot",
              evidenceRef: "e0",
              valueSpans: [{ text: "alpha", occurrence: 0 }],
              eventTimeSpans: [],
              predicateKind: "assert",
              polarity: "positive",
              modality: "observed",
            },
          ],
        }),
        {
          query,
          slots,
          sourceLock,
          slotScopes: [
            {
              slotId: slots[0]?.slotId as string,
              evidenceRefs: ["raw-left-ref"],
            },
          ],
        },
      ),
    ).toThrow("MemoryStateObservationBindingStructuralInvalid");
  });

  test("derives Unicode-safe offsets from an exact quote occurrence", () => {
    const slots = slotsFor([requirement("left")]);
    const content = "😀 alpha 😀 alpha";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "source-left",
        evidenceRef: "raw-left-ref",
        content,
        authority: "user_asserted",
        role: "user",
      },
    ]);
    const groups = parseMemoryStateObservationBindingV2(
      JSON.stringify({
        observations: [
          {
            slotId: slots[0]?.slotId,
            evidenceRef: "e0",
            valueSpans: [{ text: "alpha", occurrence: 1 }],
            eventTimeSpans: [],
            predicateKind: "assert",
            polarity: "positive",
            modality: "observed",
          },
        ],
      }),
      {
        query,
        slots,
        sourceLock,
        slotScopes: [
          {
            slotId: slots[0]?.slotId as string,
            evidenceRefs: ["raw-left-ref"],
          },
        ],
      },
    );
    expect(groups[0]?.observations[0]?.valueSpans[0]).toEqual({
      start: content.lastIndexOf("alpha"),
      end: content.lastIndexOf("alpha") + "alpha".length,
      text: "alpha",
      textDigest: expect.any(String),
    });
  });

  test("builds a complete fair shadow frame with isolated group calls", async () => {
    const requirements = [requirement("left"), requirement("right")];
    const fairIntent: MemoryEvidenceQueryIntentV3 = {
      ...baseIntent,
      answerShape: "lookup",
    };
    let calls = 0;
    const binder = createJsonMemoryStateObservationBinderV2({
      model: {
        async complete(request) {
          calls += 1;
          const payload = JSON.parse(request.user) as {
            slots: readonly Readonly<{
              slotId: string;
              eligibleEvidenceRefs: readonly string[];
            }>[];
            evidence: readonly Readonly<{
              evidenceRef: string;
              content: string;
            }>[];
          };
          return {
            status: "completed" as const,
            text: JSON.stringify({
              observations: payload.slots.map((slot) => {
                const evidence = payload.evidence.find(
                  (item) => item.evidenceRef === slot.eligibleEvidenceRefs[0],
                );
                const value = evidence?.content.includes("alpha")
                  ? "alpha"
                  : "beta";
                return {
                  slotId: slot.slotId,
                  evidenceRef: evidence?.evidenceRef,
                  valueSpans: [{ text: value, occurrence: 0 }],
                  eventTimeSpans: [],
                  predicateKind: "assert",
                  polarity: "positive",
                  modality: "observed",
                };
              }),
            }),
          };
        },
      },
    });
    const temporalConstraints = requirements.map((item) =>
      bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: baseIntent.temporalMode,
        leafMode: item.temporalMode,
      }),
    );
    const supportAssessments = [
      {
        requirementId: "left",
        supportingEvidenceRefs: ["ref-left"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
      {
        requirementId: "right",
        supportingEvidenceRefs: ["ref-right"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
    ] as const;
    const shadowInput = {
      binder,
      verifier: acceptingVerifier(),
      query,
      intent: fairIntent,
      requirements,
      origin: compileMemoryQueryAnswerOriginV1(query),
      temporalConstraints,
      requirementHits: [
        [
          {
            sourceId: "source-left",
            evidenceRef: "ref-left",
            content: "Left value is alpha.",
            authority: "user_asserted",
            sourceKind: "user_input",
          },
        ],
        [
          {
            sourceId: "source-right",
            evidenceRef: "ref-right",
            content: "Right value is beta.",
            authority: "user_asserted",
            sourceKind: "user_input",
          },
        ],
      ],
      selectorExecutionSnapshot: selectorSnapshotForShadow({
        query,
        intent: fairIntent,
        requirements,
        temporalConstraints,
        lockedSourceIds: ["source-left", "source-right"],
        assessments: supportAssessments,
      }),
      lockedSourceIds: ["source-left", "source-right"],
      dialogueCertificateRegistry: emptyDialogueRegistry(
        ["source-left", "source-right"],
        compileMemoryQueryAnswerOriginV1(query).originRevision,
      ),
      signal: new AbortController().signal,
    } as const;
    const result = await buildMemoryStateFrameShadowV2(shadowInput);
    expect(calls).toBe(2);
    expect(result.status).toBe("completed");
    expect(result.completeSlotCount).toBe(2);
    expect(result.sourceLockItemCount).toBe(2);
    const derivedResult = await buildMemoryStateFrameShadowV2({
      ...shadowInput,
      intent: baseIntent,
      selectorExecutionSnapshot: selectorSnapshotForShadow({
        query,
        intent: baseIntent,
        requirements,
        temporalConstraints,
        lockedSourceIds: ["source-left", "source-right"],
        assessments: supportAssessments,
      }),
    });
    expect(calls).toBe(4);
    expect(derivedResult.completeSlotCount).toBe(2);
    expect(derivedResult.unsupportedDerivedOperationCount).toBe(1);
    expect(derivedResult.status).toBe("partial");
  });

  test("executes only committed selector groups and keeps failed refs out", async () => {
    const partialIntent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: true,
    };
    const requirements = [
      requirement("left", { temporalMode: "any" }),
      requirement("right", { temporalMode: "any" }),
    ];
    const temporalConstraints = requirements.map((item) =>
      bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: "any",
        leafMode: item.temporalMode,
      }),
    );
    const groups = compileMemoryEvidenceSelectorGroupsV1({
      intent: partialIntent,
      requirements,
    });
    const leftGroup = groups[0];
    const rightGroup = groups[1];
    if (!leftGroup || !rightGroup) throw new Error("fixture invalid");
    const leftAssessment = {
      requirementId: "left",
      supportingEvidenceRefs: ["ref-left"],
      contradictingEvidenceRefs: [],
      unknownEvidenceRefs: [],
    } as const;
    const origin = compileMemoryQueryAnswerOriginV1(query);
    const selectorExecutionSnapshot = compileMemorySelectorExecutionSnapshotV1({
      query,
      intent: partialIntent,
      requirements,
      temporalConstraints,
      candidateScopes: [
        { requirementId: "left", evidenceRefs: ["ref-left"] },
        { requirementId: "right", evidenceRefs: ["ref-right"] },
      ],
      lockedSourceIds: ["source-left", "source-right"],
      originRevision: origin.originRevision,
      selectorVersion: "test-selector",
      selectionRevision: "partial-selection",
      committedAttempt: "baseline",
      attemptCount: 1,
      groups: [
        {
          groupId: leftGroup.groupId,
          requirementIds: leftGroup.requirementIds,
          status: "committed",
          assessments: [leftAssessment],
        },
        {
          groupId: rightGroup.groupId,
          requirementIds: rightGroup.requirementIds,
          status: "failed",
          assessments: [],
          failureCodes: ["SelectorGroupFailed"],
        },
      ],
    });
    let binderCalls = 0;
    let visibleEvidenceCount = 0;
    const binder = createJsonMemoryStateObservationBinderV2({
      model: {
        async complete(request) {
          binderCalls += 1;
          const payload = JSON.parse(request.user) as {
            slots: readonly Readonly<{
              slotId: string;
              eligibleEvidenceRefs: readonly string[];
            }>[];
            evidence: readonly Readonly<{
              evidenceRef: string;
              content: string;
            }>[];
          };
          visibleEvidenceCount = payload.evidence.length;
          return {
            status: "completed" as const,
            text: JSON.stringify({
              observations: [
                {
                  slotId: payload.slots[0]?.slotId,
                  evidenceRef: payload.slots[0]?.eligibleEvidenceRefs[0],
                  valueSpans: [{ text: "alpha", occurrence: 0 }],
                  eventTimeSpans: [],
                  predicateKind: "assert",
                  polarity: "positive",
                  modality: "observed",
                },
              ],
            }),
          };
        },
      },
    });
    const result = await buildMemoryStateFrameShadowV2({
      binder,
      verifier: acceptingVerifier(),
      query,
      intent: partialIntent,
      requirements,
      origin,
      temporalConstraints,
      requirementHits: [
        [
          {
            sourceId: "source-left",
            evidenceRef: "ref-left",
            content: "Left value is alpha.",
            authority: "user_asserted",
            sourceKind: "user_input",
          },
        ],
        [
          {
            sourceId: "source-right",
            evidenceRef: "ref-right",
            content: "Right value is secret.",
            authority: "user_asserted",
            sourceKind: "user_input",
          },
        ],
      ],
      selectorExecutionSnapshot,
      lockedSourceIds: ["source-left", "source-right"],
      dialogueCertificateRegistry: emptyDialogueRegistry(
        ["source-left", "source-right"],
        origin.originRevision,
      ),
      signal: new AbortController().signal,
    });

    expect(binderCalls).toBe(1);
    expect(visibleEvidenceCount).toBe(1);
    expect(result.status).toBe("partial");
    expect(result.selectorGroupCount).toBe(2);
    expect(result.selectorCommittedGroupCount).toBe(1);
    expect(result.selectorFailedGroupCount).toBe(1);
    expect(result.unassessedRequirementCount).toBe(1);
    expect(result.sourceLockItemCount).toBe(1);
    expect(result.frame?.slots.map((slot) => slot.status)).toEqual([
      "complete",
      "missing",
    ]);
  });

  test("keeps rejected proposals out of reducer coverage", async () => {
    const requirements = [
      requirement("home", {
        temporalMode: "any",
        relation: "direct",
        coverageMode: "any",
      }),
    ];
    const intent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: true,
    };
    const binder = createJsonMemoryStateObservationBinderV2({
      model: {
        async complete(request) {
          const payload = JSON.parse(request.user) as {
            slots: readonly Readonly<{
              slotId: string;
              eligibleEvidenceRefs: readonly string[];
            }>[];
          };
          return {
            status: "completed" as const,
            text: JSON.stringify({
              observations: [
                {
                  slotId: payload.slots[0]?.slotId,
                  evidenceRef: payload.slots[0]?.eligibleEvidenceRefs[0],
                  valueSpans: [{ text: "Paris", occurrence: 0 }],
                  eventTimeSpans: [],
                  predicateKind: "assert",
                  polarity: "positive",
                  modality: "observed",
                },
              ],
            }),
          };
        },
      },
    });
    const verifier = createJsonMemoryStateObservationVerifierV2({
      model: {
        async complete(request) {
          const payload = JSON.parse(request.user) as {
            observations: readonly Readonly<{ observationId: string }>[];
          };
          return {
            status: "completed" as const,
            text: JSON.stringify({
              acceptedObservationIds: [],
              rejectedObservationIds: payload.observations.map(
                (observation) => observation.observationId,
              ),
            }),
          };
        },
      },
    });
    const origin = compileMemoryQueryAnswerOriginV1(query);
    const temporalConstraints = [
      bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: "any",
        leafMode: "any",
      }),
    ];
    const supportAssessments = [
      {
        requirementId: "home",
        supportingEvidenceRefs: ["ref-home"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
    ];
    const result = await buildMemoryStateFrameShadowV2({
      binder,
      verifier,
      query,
      intent,
      requirements,
      origin,
      temporalConstraints,
      requirementHits: [
        [
          {
            sourceId: "source-home",
            evidenceRef: "ref-home",
            content: "Home is Paris.",
            authority: "user_asserted",
            sourceKind: "user_input",
          },
        ],
      ],
      selectorExecutionSnapshot: selectorSnapshotForShadow({
        query,
        intent,
        requirements,
        temporalConstraints,
        lockedSourceIds: ["source-home"],
        assessments: supportAssessments,
      }),
      lockedSourceIds: ["source-home"],
      dialogueCertificateRegistry: emptyDialogueRegistry(
        ["source-home"],
        origin.originRevision,
      ),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("partial");
    expect(result.proposedObservationCount).toBe(1);
    expect(result.validatedObservationCount).toBe(0);
    expect(result.frame?.slots[0]?.status).toBe("missing");
  });

  test("rejects a forged custom binder envelope at the trust boundary", async () => {
    const requirements = [requirement("home")];
    const origin = compileMemoryQueryAnswerOriginV1(query);
    const temporalConstraints = [
      bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: "latest",
        leafMode: "latest",
      }),
    ];
    const supportAssessments = [
      {
        requirementId: "home",
        supportingEvidenceRefs: ["ref-home"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
    ];
    const result = await buildMemoryStateFrameShadowV2({
      binder: {
        binderVersion: "malicious-binder",
        async bind() {
          return {
            binderVersion: "malicious-binder",
            bindingRevision: "forged",
            groups: [],
          };
        },
      },
      verifier: acceptingVerifier(),
      query,
      intent: baseIntent,
      requirements,
      origin,
      temporalConstraints,
      requirementHits: [
        [
          {
            sourceId: "source-home",
            evidenceRef: "ref-home",
            content: "Home is Paris.",
            authority: "user_asserted",
            sourceKind: "user_input",
          },
        ],
      ],
      selectorExecutionSnapshot: selectorSnapshotForShadow({
        query,
        intent: baseIntent,
        requirements,
        temporalConstraints,
        lockedSourceIds: ["source-home"],
        assessments: supportAssessments,
      }),
      lockedSourceIds: ["source-home"],
      dialogueCertificateRegistry: emptyDialogueRegistry(
        ["source-home"],
        origin.originRevision,
      ),
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("fallback");
    expect(result.committedGroupCount).toBe(0);
  });

  test("keeps the state frame observational at the resolver packet boundary", async () => {
    const content = "I live in Paris.";
    const index = {
      indexVersion: "test-index",
      async search() {
        return {
          lists: [
            {
              channel: "l0" as const,
              retrieverId: "test",
              weight: 1,
              candidates: [
                {
                  candidateId: "candidate-1",
                  sourceId: "source-1",
                  evidenceRef: "ref-1",
                  sourceKind: "user_input" as const,
                  authority: "user_asserted" as const,
                },
              ],
            },
          ],
          hits: [
            {
              sourceId: "source-1",
              evidenceRef: "ref-1",
              content,
              authority: "user_asserted" as const,
              sourceKind: "user_input" as const,
            },
          ],
        };
      },
    };
    const supportSelector = {
      selectorVersion: "test-selector",
      async select(input: {
        requirements: readonly MemoryEvidenceRequirementV3[];
      }) {
        return {
          selectorVersion: "test-selector",
          selectionRevision: "selection-revision",
          assessments: input.requirements.map((item) => ({
            requirementId: item.requirementId,
            supportingEvidenceRefs: ["ref-1"],
            contradictingEvidenceRefs: [],
            unknownEvidenceRefs: [],
          })),
        };
      },
    };
    let binderCalls = 0;
    const stateObservationBinder = createJsonMemoryStateObservationBinderV2({
      model: {
        async complete(request) {
          binderCalls += 1;
          const payload = JSON.parse(request.user) as {
            slots: readonly Readonly<{
              slotId: string;
              eligibleEvidenceRefs: readonly string[];
            }>[];
          };
          return {
            status: "completed" as const,
            text: JSON.stringify({
              observations: [
                {
                  slotId: payload.slots[0]?.slotId,
                  evidenceRef: payload.slots[0]?.eligibleEvidenceRefs[0],
                  valueSpans: [{ text: "Paris", occurrence: 0 }],
                  eventTimeSpans: [],
                  predicateKind: "assert",
                  polarity: "positive",
                  modality: "observed",
                },
              ],
            }),
          };
        },
      },
    });
    const stateObservationVerifier = acceptingVerifier();
    const baseline = await createMemoryEvidenceResolverV1({
      index,
      supportSelector,
    }).resolve("Where do I live?", new AbortController().signal);
    const shadow = await createMemoryEvidenceResolverV1({
      index,
      supportSelector,
      stateObservationBinder,
      stateObservationVerifier,
    }).resolve("Where do I live?", new AbortController().signal);
    expect(binderCalls).toBe(1);
    expect(shadow.stateFrameStatus).toBe("completed");
    expect(shadow.stateFrameTelemetry?.completeSlotCount).toBe(1);
    expect(shadow.packetSources).toEqual(baseline.packetSources);
    expect(shadow.requirementEvidence).toEqual(baseline.requirementEvidence);
    expect(shadow.resolutionRevision).toBe(baseline.resolutionRevision);
    expect(projectEvidenceFirstMemoryContextPacketV1(shadow)).toEqual(
      projectEvidenceFirstMemoryContextPacketV1(baseline),
    );
    expect(shadow.stateShadowAuditRevision).toBeDefined();
  });

  test("refuses to inherit one anchor role across a mixed conversation bundle", async () => {
    const requirements = [requirement("dialogue")];
    let calls = 0;
    const binder = createJsonMemoryStateObservationBinderV2({
      model: {
        async complete() {
          calls += 1;
          return { status: "completed" as const, text: '{"observations":[]}' };
        },
      },
    });
    const temporalConstraints = requirements.map((item) =>
      bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: baseIntent.temporalMode,
        leafMode: item.temporalMode,
      }),
    );
    const supportAssessments = [
      {
        requirementId: "dialogue",
        supportingEvidenceRefs: ["assistant-anchor"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
    ];
    const shadow = await buildMemoryStateFrameShadowV2({
      binder,
      verifier: acceptingVerifier(),
      query,
      intent: baseIntent,
      requirements,
      origin: compileMemoryQueryAnswerOriginV1(query),
      temporalConstraints,
      requirementHits: [
        [
          {
            sourceId: "source-dialogue",
            evidenceRef: "assistant-anchor",
            content: "[user] request\n[assistant] answer",
            authority: "user_confirmed_dialogue",
            sourceKind: "assistant_output",
            contextEvidenceRefs: ["user-context", "assistant-anchor"],
          },
        ],
      ],
      selectorExecutionSnapshot: selectorSnapshotForShadow({
        query,
        intent: baseIntent,
        requirements,
        temporalConstraints,
        lockedSourceIds: ["source-dialogue"],
        assessments: supportAssessments,
      }),
      lockedSourceIds: ["source-dialogue"],
      dialogueCertificateRegistry: emptyDialogueRegistry(
        ["source-dialogue"],
        compileMemoryQueryAnswerOriginV1(query).originRevision,
      ),
      signal: new AbortController().signal,
    });
    expect(shadow.sourceLockItemCount).toBe(0);
    expect(shadow.failedGroupCount).toBe(1);
    expect(shadow.frame?.slots[0]?.status).toBe("missing");
    expect(shadow.executionResult?.status).toBe("missing");
    expect(calls).toBe(0);
  });

  test("keeps an unresolved any-role requirement as a blocked execution leaf", async () => {
    const requirements = [
      { ...requirement("unresolved-role"), roleConstraint: "any" as const },
    ];
    const temporalConstraints = requirements.map((item) =>
      bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: baseIntent.temporalMode,
        leafMode: item.temporalMode,
      }),
    );
    const assessments = [
      {
        requirementId: "unresolved-role",
        supportingEvidenceRefs: ["unresolved-ref"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
    ];
    let calls = 0;
    const shadow = await buildMemoryStateFrameShadowV2({
      binder: createJsonMemoryStateObservationBinderV2({
        model: {
          async complete() {
            calls += 1;
            return {
              status: "completed" as const,
              text: '{"observations":[]}',
            };
          },
        },
      }),
      verifier: acceptingVerifier(),
      query,
      intent: baseIntent,
      requirements,
      origin: compileMemoryQueryAnswerOriginV1(query),
      temporalConstraints,
      requirementHits: [
        [
          {
            sourceId: "source-unresolved",
            evidenceRef: "unresolved-ref",
            content: "A role-ambiguous statement.",
            authority: "user_asserted",
            sourceKind: "user_input",
          },
        ],
      ],
      selectorExecutionSnapshot: selectorSnapshotForShadow({
        query,
        intent: baseIntent,
        requirements,
        temporalConstraints,
        lockedSourceIds: ["source-unresolved"],
        assessments,
      }),
      lockedSourceIds: ["source-unresolved"],
      dialogueCertificateRegistry: emptyDialogueRegistry(
        ["source-unresolved"],
        compileMemoryQueryAnswerOriginV1(query).originRevision,
      ),
      signal: new AbortController().signal,
    });
    expect(shadow.frame?.slots).toHaveLength(0);
    expect(shadow.failedGroupCount).toBe(1);
    expect(shadow.executionResult?.status).toBe("missing");
    expect(calls).toBe(0);
  });

  test("keeps planner identity immutable after selector role late binding", async () => {
    const requirements = [
      { ...requirement("late-bound-role"), roleConstraint: "any" as const },
    ];
    const temporalConstraints = requirements.map((item) =>
      bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: baseIntent.temporalMode,
        leafMode: item.temporalMode,
      }),
    );
    const assessments: readonly MemoryEvidenceTriageAssessmentV1[] = [
      {
        requirementId: "late-bound-role",
        supportingEvidenceRefs: ["late-bound-ref"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
        evidenceDispositions: [
          {
            requirementId: "late-bound-role",
            evidenceRef: "late-bound-ref",
            disposition: "supporting",
            resolvedRole: "user",
            evidenceUse: "user_fact",
            contextEvidenceRefs: [],
          },
        ],
      },
    ];
    const shadow = await buildMemoryStateFrameShadowV2({
      binder: createJsonMemoryStateObservationBinderV2({
        model: {
          async complete(request) {
            const payload = JSON.parse(request.user) as {
              slots: readonly Readonly<{
                slotId: string;
                eligibleEvidenceRefs: readonly string[];
              }>[];
            };
            return {
              status: "completed" as const,
              text: JSON.stringify({
                observations: [
                  {
                    slotId: payload.slots[0]?.slotId,
                    evidenceRef: payload.slots[0]?.eligibleEvidenceRefs[0],
                    valueSpans: [{ text: "blue", occurrence: 0 }],
                    eventTimeSpans: [],
                    predicateKind: "assert",
                    polarity: "positive",
                    modality: "observed",
                  },
                ],
              }),
            };
          },
        },
      }),
      verifier: acceptingVerifier(),
      query,
      intent: baseIntent,
      requirements,
      origin: compileMemoryQueryAnswerOriginV1(query),
      temporalConstraints,
      requirementHits: [
        [
          {
            sourceId: "source-late-bound",
            evidenceRef: "late-bound-ref",
            content: "The selected value is blue.",
            authority: "user_asserted",
            sourceKind: "user_input",
          },
        ],
      ],
      selectorExecutionSnapshot: selectorSnapshotForShadow({
        query,
        intent: baseIntent,
        requirements,
        temporalConstraints,
        lockedSourceIds: ["source-late-bound"],
        assessments,
      }),
      lockedSourceIds: ["source-late-bound"],
      dialogueCertificateRegistry: emptyDialogueRegistry(
        ["source-late-bound"],
        compileMemoryQueryAnswerOriginV1(query).originRevision,
      ),
      signal: new AbortController().signal,
    });
    expect(
      shadow.executionProgram?.nodes.find(
        (node) => node.operation === "read_requirement",
      )?.resolvedRole,
    ).toBe("user");
    expect(shadow.executionResult?.status).toBe("partial");
  });

  test("materializes a certified assistant turn from the exact proof, not a mixed bundle", async () => {
    const assistantQuery = "Can you remember the earlier label for me?";
    const origin = compileMemoryQueryAnswerOriginV1(assistantQuery);
    const intent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "assistant",
      needsPlanning: true,
    };
    const assistantRequirement = requirement("answer", {
      label: "earlier label",
      searchText: "earlier label",
      temporalMode: "any",
      roleConstraint: "assistant",
      relation: "direct",
      coverageMode: "any",
    });
    const userContent = "Please choose an earlier label.";
    const assistantContent = "The earlier label was amber.";
    const registry = compileMemoryDialogueCertificateRegistryV1({
      lockedSourceIds: ["source-dialogue"],
      proofs: [
        {
          sourceId: "source-dialogue",
          precedingUser: {
            evidenceRef: "source-dialogue#turn-1",
            sourceKind: "user_input",
            turnOrder: 1,
            content: userContent,
            contentHash: hashTextV1(userContent),
          },
          assistant: {
            evidenceRef: "source-dialogue#turn-2",
            sourceKind: "assistant_output",
            turnOrder: 2,
            content: assistantContent,
            contentHash: hashTextV1(assistantContent),
          },
        },
      ],
      verifierVersion: "exact-dialogue-verifier",
      verificationRevision: "exact-dialogue-verification",
      originRevision: origin.originRevision,
    });
    let observedEvidenceContent = "";
    const binder = createJsonMemoryStateObservationBinderV2({
      model: {
        async complete(request) {
          const payload = JSON.parse(request.user) as {
            slots: readonly Readonly<{
              slotId: string;
              eligibleEvidenceRefs: readonly string[];
            }>[];
            evidence: readonly Readonly<{
              evidenceRef: string;
              content: string;
            }>[];
          };
          observedEvidenceContent = payload.evidence[0]?.content ?? "";
          return {
            status: "completed" as const,
            text: JSON.stringify({
              observations: [
                {
                  slotId: payload.slots[0]?.slotId,
                  evidenceRef: payload.slots[0]?.eligibleEvidenceRefs[0],
                  valueSpans: [{ text: "amber", occurrence: 0 }],
                  eventTimeSpans: [],
                  predicateKind: "assert",
                  polarity: "positive",
                  modality: "observed",
                },
              ],
            }),
          };
        },
      },
    });
    const temporalConstraints = [
      bindMemoryEvidenceTemporalConstraintV1({
        query: assistantQuery,
        queryEnvelopeMode: "any",
        leafMode: "any",
      }),
    ];
    const supportAssessments = [
      {
        requirementId: "answer",
        supportingEvidenceRefs: ["source-dialogue#turn-2"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
    ];
    const result = await buildMemoryStateFrameShadowV2({
      binder,
      verifier: acceptingVerifier(),
      query: assistantQuery,
      intent,
      requirements: [assistantRequirement],
      origin,
      temporalConstraints,
      requirementHits: [
        [
          {
            sourceId: "source-dialogue",
            evidenceRef: "source-dialogue#turn-2",
            content: `[user] ${userContent}\n[assistant] ${assistantContent}`,
            authority: "user_confirmed_dialogue",
            sourceKind: "assistant_output",
            contextEvidenceRefs: [
              "source-dialogue#turn-1",
              "source-dialogue#turn-2",
            ],
          },
        ],
      ],
      selectorExecutionSnapshot: selectorSnapshotForShadow({
        query: assistantQuery,
        intent,
        requirements: [assistantRequirement],
        temporalConstraints,
        lockedSourceIds: ["source-dialogue"],
        assessments: supportAssessments,
      }),
      lockedSourceIds: ["source-dialogue"],
      dialogueCertificateRegistry: registry,
      signal: new AbortController().signal,
    });
    expect(observedEvidenceContent).toBe(assistantContent);
    expect(result.status).toBe("completed");
    expect(result.frame?.slots[0]?.current[0]?.certificateRevision).toBe(
      registry.certificates[0]?.certificateRevision,
    );
  });
});
