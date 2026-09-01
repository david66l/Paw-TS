import { describe, expect, test } from "bun:test";
import type {
  MemoryStateBoundObservationV2,
  MemoryStateObservationVerificationInputV2,
  MemoryStateObservationVerifierV2,
  MemoryWriterModelV1,
} from "@paw/memory-plugin";
import { compileMemoryQueryAnswerOriginV1 } from "../../packages/memory-core/src/query-answer-origin.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "../../packages/memory-core/src/query-plan-contracts.js";
import {
  bindMemoryStateObservationV2,
  compileMemoryStateSlotsV2,
  compileMemoryStateSourceLockV2,
} from "../../packages/memory-core/src/state-frame-v2.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "../../packages/memory-core/src/temporal-constraint.js";
import { observeAmbStateSemanticAuditV1 } from "./state-semantic-audit-observer.js";

const query = "What is the latest city?";
const intent: MemoryEvidenceQueryIntentV3 = {
  answerShape: "lookup",
  temporalMode: "latest",
  roleConstraint: "user",
  needsPlanning: true,
};
const requirement: MemoryEvidenceRequirementV3 = {
  requirementId: "city",
  label: "current city",
  searchText: "latest city",
  temporalMode: "latest",
  roleConstraint: "user",
  relation: "direct",
  coverageMode: "latest",
  minimumEvidence: 1,
  dependencyRelation: "independent",
  dependsOnRequirementIds: [],
};

function fixture(
  temporalMode: "any" | "latest" = "latest",
): Readonly<MemoryStateObservationVerificationInputV2> {
  const fixtureQuery =
    temporalMode === "latest" ? query : "What city did I mention?";
  const fixtureIntent: MemoryEvidenceQueryIntentV3 = {
    ...intent,
    temporalMode,
  };
  const fixtureRequirement: MemoryEvidenceRequirementV3 = {
    ...requirement,
    temporalMode,
    coverageMode: temporalMode === "latest" ? "latest" : "any",
  };
  const slots = compileMemoryStateSlotsV2({
    query: fixtureQuery,
    intent: fixtureIntent,
    requirements: [fixtureRequirement],
    origin: compileMemoryQueryAnswerOriginV1(fixtureQuery),
    temporalConstraints: new Map([
      [
        fixtureRequirement.requirementId,
        bindMemoryEvidenceTemporalConstraintV1({
          query: fixtureQuery,
          queryEnvelopeMode: fixtureIntent.temporalMode,
          leafMode: fixtureRequirement.temporalMode,
        }),
      ],
    ]),
  });
  const sourceLock = compileMemoryStateSourceLockV2([
    {
      sourceId: "s1",
      evidenceRef: "evidence-1",
      content: "I moved to Paris.",
      authority: "user_asserted",
      role: "user",
      observedAt: "2025-01-01T00:00:00.000Z",
      episodeOrder: 1,
      turnOrder: 1,
    },
  ]);
  const slot = slots[0];
  if (!slot) throw new Error("StateSemanticAuditTestSlotMissing");
  const observation = bindMemoryStateObservationV2({
    slot,
    sourceLock,
    proposal: {
      slotId: slot.slotId,
      evidenceRef: "evidence-1",
      valueSpans: [{ start: 11, end: 16 }],
      predicateKind: "update",
      polarity: "positive",
      modality: "observed",
    },
  });
  return Object.freeze({
    query: fixtureQuery,
    slots,
    sourceLock,
    proposedObservations: Object.freeze([observation]),
  });
}

function verifier(accept: boolean): MemoryStateObservationVerifierV2 {
  return Object.freeze({
    verifierVersion: "test.verifier.v1",
    async verify(input: Readonly<MemoryStateObservationVerificationInputV2>) {
      const ids = input.proposedObservations.map(
        (observation: { readonly observationId: string }) =>
          observation.observationId,
      );
      return Object.freeze({
        verifierVersion: "test.verifier.v1",
        verificationRevision: "test-revision",
        acceptedObservationIds: Object.freeze(accept ? ids : []),
        rejectedObservationIds: Object.freeze(accept ? [] : ids),
      });
    },
  });
}

function fixtureWithObservationCount(
  count: number,
  temporalMode: "any" | "latest" = "any",
): Readonly<MemoryStateObservationVerificationInputV2> {
  const input = fixture(temporalMode);
  const observation = input.proposedObservations[0];
  if (!observation) throw new Error("StateSemanticAuditTestObservationMissing");
  const proposedObservations = Array.from({ length: count }, (_, index) =>
    Object.freeze({
      ...observation,
      observationId: `test-observation-${index}`,
    }),
  ) satisfies MemoryStateBoundObservationV2[];
  return Object.freeze({
    ...input,
    proposedObservations: Object.freeze(proposedObservations),
  });
}

function judge(verdict: "pass" | "fail"): MemoryWriterModelV1 {
  return Object.freeze({
    async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
      return completedAuditResponse(request, verdict);
    },
  });
}

function completedAuditResponse(
  request: Readonly<{ system: string; user: string }>,
  verdict: "pass" | "fail",
) {
  const payload = JSON.parse(request.user) as {
    observations: readonly Readonly<{
      observationId: string;
      requestedAxes?: readonly string[];
    }>[];
  };
  if (request.system.includes("audit only currentness")) {
    const groupIds = (
      JSON.parse(request.user) as {
        groups: readonly Readonly<{ groupId: string }>[];
      }
    ).groups.map((group) => group.groupId);
    return {
      status: "completed" as const,
      text: JSON.stringify({
        pass: verdict === "pass" ? groupIds : [],
        fail: verdict === "fail" ? groupIds : [],
        indeterminate: [],
      }),
    };
  }
  if (request.system.includes("classify one typed value binding")) {
    return {
      status: "completed" as const,
      text: JSON.stringify({
        classifications: payload.observations.map((observation) => ({
          observationId: observation.observationId,
          reason:
            verdict === "pass" ? "correct_binding" : "wrong_slot_attribute",
        })),
      }),
    };
  }
  return {
    status: "completed" as const,
    text: JSON.stringify({
      observations: payload.observations.map((observation) => ({
        observationId: observation.observationId,
        axes: Object.fromEntries(
          (observation.requestedAxes ?? []).map((axis) => [axis, verdict]),
        ),
      })),
    }),
  };
}

describe("AMB sealed state semantic audit observer", () => {
  test("aggregates dual-judge accepted precision without exposing cells under five", async () => {
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: judge("pass"),
      judgeB: judge("pass"),
    });
    const request = fixture();
    const returned = await observer.verifier.verify(
      request,
      new AbortController().signal,
    );
    await observer.drain();
    expect(returned.acceptedObservationIds).toHaveLength(1);
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 1,
      failedAuditCalls: 0,
      acceptedObservationCount: 1,
      rejectedObservationCount: 0,
      acceptedSemanticObservations: { count: 1, jointPass: 1 },
      axes: {
        accepted: { valueEntailment: { count: 1, agreedPass: 1 } },
      },
      strata: [],
    });
    expect(observer.snapshot().suppressedStrata).toHaveLength(6);
  });

  test("counts a dual-judge semantic failure as support for rejection", async () => {
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(false),
      judgeA: judge("fail"),
      judgeB: judge("fail"),
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    expect(observer.snapshot().rejectedSemanticObservations).toEqual({
      count: 1,
      rejectionSupported: 1,
      suspectedFalseReject: 0,
      unresolved: 0,
    });
  });

  test("publishes only k-anonymous agreed value failure reasons", async () => {
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: judge("fail"),
      judgeB: judge("fail"),
    });
    await observer.verifier.verify(
      fixtureWithObservationCount(9),
      new AbortController().signal,
    );
    await observer.drain();
    expect(observer.snapshot().valueBindingReasonAudit).toEqual({
      auditedObservationCount: 9,
      failureCohortCount: 9,
      controlCohortCount: 0,
      excludedObservationCount: 0,
      failureAgreedReasons: [{ reason: "wrong_slot_attribute", count: 9 }],
      suppressedReasonCount: 0,
      suppressedObservationCount: 0,
      disagreementCount: 0,
      controlAgreedCorrectCount: 0,
      failureAgreedCorrectCount: 0,
      indeterminateObservationCount: 0,
    });
  });

  test("chunks more than eight observations without duplicating accumulation", async () => {
    const semanticChunkSizes: number[] = [];
    const recordingJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        const payload = JSON.parse(request.user) as {
          schemaVersion?: string;
          observations: readonly unknown[];
        };
        if (
          payload.schemaVersion ===
          "paw.amb-state-semantic-blind-audit-input.v3"
        )
          semanticChunkSizes.push(payload.observations.length);
        return completedAuditResponse(request, "pass");
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(false),
      judgeA: recordingJudge,
      judgeB: recordingJudge,
    });
    await observer.verifier.verify(
      fixtureWithObservationCount(9),
      new AbortController().signal,
    );
    await observer.drain();
    expect(semanticChunkSizes.sort((left, right) => right - left)).toEqual([
      8, 8, 1, 1,
    ]);
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 1,
      failedAuditCalls: 0,
      rejectedSemanticObservations: {
        count: 9,
        suspectedFalseReject: 9,
      },
      axes: { rejected: { valueEntailment: { count: 9 } } },
    });
  });

  test("audits fifteen latest observations as one complete currentness group", async () => {
    let groupObservationCount = 0;
    const recordingJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        if (request.system.includes("audit only currentness")) {
          const payload = JSON.parse(request.user) as {
            groups: readonly Readonly<{
              observations: readonly unknown[];
            }>[];
          };
          groupObservationCount = payload.groups[0]?.observations.length ?? 0;
        }
        return completedAuditResponse(request, "pass");
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: recordingJudge,
      judgeB: recordingJudge,
    });
    await observer.verifier.verify(
      fixtureWithObservationCount(15, "latest"),
      new AbortController().signal,
    );
    await observer.drain();
    expect(groupObservationCount).toBe(15);
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 1,
      failedAuditCalls: 0,
      acceptedSemanticObservations: { count: 15 },
      currentnessGroups: {
        count: 1,
        agreedPass: 1,
        affectedObservationCount: 15,
      },
    });
  });

  test("discards all partial statistics when a later semantic chunk fails", async () => {
    const failSmallChunkJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        const payload = JSON.parse(request.user) as {
          observations: readonly unknown[];
        };
        if (payload.observations.length === 1) {
          return { status: "failed" as const, errorCode: "InjectedFailure" };
        }
        return completedAuditResponse(request, "pass");
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(false),
      judgeA: failSmallChunkJudge,
      judgeB: judge("pass"),
    });
    await observer.verifier.verify(
      fixtureWithObservationCount(9),
      new AbortController().signal,
    );
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 0,
      failedAuditCalls: 1,
      acceptedObservationCount: 0,
      rejectedObservationCount: 0,
      axes: { all: { valueEntailment: { count: 0 } } },
    });
  });

  test("fails the query when a judge marks an applicable axis not applicable", async () => {
    const invalidApplicabilityJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        const response = completedAuditResponse(request, "pass");
        if (
          request.system.includes("audit only currentness") ||
          request.system.includes("classify one typed value binding")
        )
          return response;
        const parsed = JSON.parse(response.text) as {
          observations: Array<{
            axes: { valueEntailment: string };
          }>;
        };
        for (const observation of parsed.observations) {
          observation.axes.valueEntailment = "not_applicable";
        }
        return { ...response, text: JSON.stringify(parsed) };
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: invalidApplicabilityJudge,
      judgeB: invalidApplicabilityJudge,
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 0,
      failedAuditCalls: 1,
      failureCodes: {
        AmbStateSemanticAuditVerdictInvalid: 1,
      },
      axes: { all: { valueEntailment: { count: 0 } } },
    });
  });

  test("ignores a known non-applicable axis and records content-free telemetry", async () => {
    const extraAxisJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        const response = completedAuditResponse(request, "pass");
        if (
          request.system.includes("audit only currentness") ||
          request.system.includes("classify one typed value binding")
        )
          return response;
        const parsed = JSON.parse(response.text) as {
          observations: Array<{ axes: Record<string, string> }>;
        };
        for (const observation of parsed.observations) {
          observation.axes.eventTimeSpanValidity = "pass";
        }
        return { ...response, text: JSON.stringify(parsed) };
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: extraAxisJudge,
      judgeB: extraAxisJudge,
    });
    await observer.verifier.verify(
      fixture("any"),
      new AbortController().signal,
    );
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 1,
      failedAuditCalls: 0,
      extraKnownNonApplicableAxisCount: 2,
      acceptedSemanticObservations: { count: 1, jointPass: 1 },
      axes: { accepted: { eventTimeSpanValidity: { count: 0 } } },
    });
  });

  test("fails closed when an applicable axis is missing", async () => {
    const missingAxisJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        const response = completedAuditResponse(request, "pass");
        if (request.system.includes("audit only currentness")) return response;
        const parsed = JSON.parse(response.text) as {
          observations: Array<{ axes: Record<string, string> }>;
        };
        for (const observation of parsed.observations) {
          const { valueEntailment: _omitted, ...remaining } = observation.axes;
          observation.axes = remaining;
        }
        return { ...response, text: JSON.stringify(parsed) };
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: missingAxisJudge,
      judgeB: missingAxisJudge,
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 0,
      failedAuditCalls: 1,
      failureCodes: { AmbStateSemanticAuditApplicableAxisMissing: 1 },
      acceptedObservationCount: 0,
      axes: { all: { valueEntailment: { count: 0 } } },
    });
  });

  test("fails closed on an unknown semantic axis", async () => {
    const unknownAxisJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        const response = completedAuditResponse(request, "pass");
        if (request.system.includes("audit only currentness")) return response;
        const parsed = JSON.parse(response.text) as {
          observations: Array<{ axes: Record<string, string> }>;
        };
        for (const observation of parsed.observations) {
          observation.axes.inventedAxis = "pass";
        }
        return { ...response, text: JSON.stringify(parsed) };
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: unknownAxisJudge,
      judgeB: unknownAxisJudge,
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 0,
      failedAuditCalls: 1,
      failureCodes: { AmbStateSemanticAuditUnknownAxis: 1 },
      acceptedObservationCount: 0,
      axes: { all: { valueEntailment: { count: 0 } } },
    });
  });

  test("excludes non-applicable event-time axes from an ordinary lookup denominator", async () => {
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: judge("pass"),
      judgeB: judge("pass"),
    });
    await observer.verifier.verify(
      fixture("any"),
      new AbortController().signal,
    );
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 1,
      failedAuditCalls: 0,
      acceptedSemanticObservations: { count: 1, jointPass: 1 },
      axes: {
        accepted: {
          valueEntailment: { count: 1, agreedPass: 1 },
          eventTimeSpanValidity: { count: 0 },
          eventTimeOmissionSafety: { count: 0 },
        },
      },
    });
  });

  test("isolates audit model failure from the production verifier", async () => {
    const failingJudge: MemoryWriterModelV1 = Object.freeze({
      async complete() {
        return {
          status: "failed" as const,
          errorCode: "AuditUnavailable",
        };
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: judge("pass"),
      judgeB: failingJudge,
    });
    const returned = await observer.verifier.verify(
      fixture(),
      new AbortController().signal,
    );
    expect(returned.acceptedObservationIds).toHaveLength(1);
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 0,
      failedAuditCalls: 1,
      acceptedObservationCount: 0,
    });
  });

  test("reports a completed-response parse cause ahead of sibling cancellation", async () => {
    const failedJudge: MemoryWriterModelV1 = Object.freeze({
      async complete() {
        return { status: "failed" as const, errorCode: "InjectedFailure" };
      },
    });
    const malformedJudge: MemoryWriterModelV1 = Object.freeze({
      async complete() {
        return { status: "completed" as const, text: "{}" };
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: failedJudge,
      judgeB: malformedJudge,
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 0,
      failedAuditCalls: 1,
      failureCodes: { AmbStateSemanticAuditShapeInvalid: 1 },
    });
  });

  test("reports only bounded counts for a missing currentness partition", async () => {
    const missingCurrentnessJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        if (request.system.includes("audit only currentness")) {
          return {
            status: "completed" as const,
            text: JSON.stringify({ pass: [], fail: [], indeterminate: [] }),
          };
        }
        return completedAuditResponse(request, "pass");
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: missingCurrentnessJudge,
      judgeB: missingCurrentnessJudge,
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 0,
      failedAuditCalls: 1,
      failureCodes: {
        AmbStateCurrentnessAuditGroupPartitionMissing_E1_S0: 1,
      },
      acceptedObservationCount: 0,
    });
  });

  test("retries an identical currentness transport failure only once", async () => {
    const flakyCurrentnessJudge = (
      failureMode: "status" | "throw",
    ): MemoryWriterModelV1 => {
      let failedOnce = false;
      return Object.freeze({
        async complete(
          request: Parameters<MemoryWriterModelV1["complete"]>[0],
        ) {
          if (
            request.system.includes("audit only currentness") &&
            !failedOnce
          ) {
            failedOnce = true;
            if (failureMode === "throw") {
              throw new Error("InjectedTransportRejection");
            }
            return {
              status: "failed" as const,
              errorCode: "InjectedTransportFailure",
            };
          }
          return completedAuditResponse(request, "pass");
        },
      });
    };
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: flakyCurrentnessJudge("status"),
      judgeB: flakyCurrentnessJudge("throw"),
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    expect(observer.snapshot()).toMatchObject({
      auditedCalls: 1,
      failedAuditCalls: 0,
      currentnessTransportRetryCount: 2,
      currentnessGroups: {
        count: 1,
        agreedPass: 1,
        affectedObservationCount: 1,
      },
    });
  });

  test("returns the delegate result before background judges settle", async () => {
    const releases: Array<() => void> = [];
    const delayedJudge: MemoryWriterModelV1 = Object.freeze({
      complete(
        request: Parameters<MemoryWriterModelV1["complete"]>[0],
      ): ReturnType<MemoryWriterModelV1["complete"]> {
        return new Promise<
          Awaited<ReturnType<MemoryWriterModelV1["complete"]>>
        >((resolve) => {
          releases.push(() => resolve(completedAuditResponse(request, "pass")));
        });
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: delayedJudge,
      judgeB: delayedJudge,
    });
    const returned = await observer.verifier.verify(
      fixture(),
      new AbortController().signal,
    );
    expect(returned.acceptedObservationIds).toHaveLength(1);
    for (let wave = 0; wave < 3; wave += 1) {
      for (let attempt = 0; attempt < 10 && releases.length < 2; attempt += 1) {
        await Promise.resolve();
      }
      expect(releases).toHaveLength(2);
      for (const release of releases.splice(0)) release();
    }
    await observer.drain();
    expect(observer.snapshot().auditedCalls).toBe(1);
  });

  test("keeps verifier decisions out of the five-axis blind payload", async () => {
    const semanticPayloads: Array<Record<string, unknown>> = [];
    const recordingJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        const payload = JSON.parse(request.user) as {
          schemaVersion?: string;
        };
        if (
          payload.schemaVersion ===
          "paw.amb-state-semantic-blind-audit-input.v3"
        )
          semanticPayloads.push(payload);
        return completedAuditResponse(request, "pass");
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: recordingJudge,
      judgeB: recordingJudge,
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    expect(semanticPayloads).toHaveLength(2);
    const serialized = JSON.stringify(semanticPayloads);
    expect(serialized).not.toContain("reducerPosition");
    expect(serialized).not.toContain("frameStatus");
    expect(serialized).not.toContain("accepted");
    expect(serialized).not.toContain("rejected");
  });

  test("runs queued queries with bounded FIFO concurrency", async () => {
    let activeModelCalls = 0;
    let maximumActiveModelCalls = 0;
    const boundedJudge: MemoryWriterModelV1 = Object.freeze({
      async complete(request: Parameters<MemoryWriterModelV1["complete"]>[0]) {
        activeModelCalls += 1;
        maximumActiveModelCalls = Math.max(
          maximumActiveModelCalls,
          activeModelCalls,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        activeModelCalls -= 1;
        return completedAuditResponse(request, "pass");
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: boundedJudge,
      judgeB: boundedJudge,
      queueConcurrency: 1,
    });
    await Promise.all(
      Array.from({ length: 5 }, () =>
        observer.verifier.verify(fixture(), new AbortController().signal),
      ),
    );
    await observer.drain();
    expect(maximumActiveModelCalls).toBe(2);
    expect(observer.snapshot()).toMatchObject({
      verifierInvocationCount: 5,
      auditedCalls: 5,
      failedAuditCalls: 0,
      pendingAuditCount: 0,
      queueConcurrency: 1,
      maximumInFlightAuditCount: 1,
    });
  });

  test("aborts and settles the sibling judge before drain completes", async () => {
    let siblingObservedAbort = false;
    const failedJudge: MemoryWriterModelV1 = Object.freeze({
      async complete() {
        return { status: "failed" as const, errorCode: "InjectedFailure" };
      },
    });
    const blockedJudge: MemoryWriterModelV1 = Object.freeze({
      complete(
        _request: Parameters<MemoryWriterModelV1["complete"]>[0],
        options: Parameters<MemoryWriterModelV1["complete"]>[1],
      ): ReturnType<MemoryWriterModelV1["complete"]> {
        return new Promise<
          Awaited<ReturnType<MemoryWriterModelV1["complete"]>>
        >((resolve) => {
          const settle = () => {
            siblingObservedAbort = true;
            resolve({
              status: "cancelled" as const,
              errorCode: "InjectedAbort",
            });
          };
          if (options.signal.aborted) settle();
          else options.signal.addEventListener("abort", settle, { once: true });
        });
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: failedJudge,
      judgeB: blockedJudge,
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    expect(siblingObservedAbort).toBe(true);
    expect(observer.snapshot()).toMatchObject({
      verifierInvocationCount: 1,
      auditedCalls: 0,
      failedAuditCalls: 1,
      pendingAuditCount: 0,
    });
  });

  test("settles a timed-out judge pair once and preserves the queue invariant", async () => {
    let abortCount = 0;
    const blockedJudge: MemoryWriterModelV1 = Object.freeze({
      complete(
        _request: Parameters<MemoryWriterModelV1["complete"]>[0],
        options: Parameters<MemoryWriterModelV1["complete"]>[1],
      ): ReturnType<MemoryWriterModelV1["complete"]> {
        return new Promise<
          Awaited<ReturnType<MemoryWriterModelV1["complete"]>>
        >((resolve) => {
          const settle = () => {
            abortCount += 1;
            resolve({
              status: "cancelled" as const,
              errorCode: "InjectedTimeout",
            });
          };
          if (options.signal.aborted) settle();
          else options.signal.addEventListener("abort", settle, { once: true });
        });
      },
    });
    const observer = observeAmbStateSemanticAuditV1({
      verifier: verifier(true),
      judgeA: blockedJudge,
      judgeB: blockedJudge,
      auditTimeoutMs: 10,
    });
    await observer.verifier.verify(fixture(), new AbortController().signal);
    await observer.drain();
    const summary = observer.snapshot();
    expect(abortCount).toBe(2);
    expect(summary.auditedCalls + summary.failedAuditCalls).toBe(
      summary.verifierInvocationCount,
    );
    expect(summary).toMatchObject({
      verifierInvocationCount: 1,
      auditedCalls: 0,
      failedAuditCalls: 1,
      pendingAuditCount: 0,
    });
  });
});
