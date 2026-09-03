import { describe, expect, test } from "bun:test";
import { hashCanonicalJsonV1 } from "../src/canonical.js";
import { PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1 } from "../src/evidence-contracts.js";
import { compileMemoryEvidenceExecutionCoverageCertificateV1 } from "../src/evidence-execution-coverage-v1.js";
import {
  compileMemoryEvidenceExecutionProgramV1,
  validateMemoryEvidenceExecutionProgramV1,
} from "../src/evidence-execution-program-v1.js";
import { executeMemoryEvidenceProgramV1 } from "../src/evidence-execution-runtime-v1.js";
import { memoryEvidenceIndependenceIdentityRevisionV1 } from "../src/evidence-independence.js";
import { buildMemoryEvidenceReaderProjectionV1 } from "../src/evidence-reader-projection-v1.js";
import { compileMemoryEvidenceSelectorGroupsV1 } from "../src/evidence-selector-groups.js";
import { compileMemoryQueryAnswerOriginV1 } from "../src/query-answer-origin.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "../src/query-plan-contracts.js";
import { compileMemorySelectorExecutionSnapshotV1 } from "../src/selector-execution-snapshot-v1.js";
import { compileMemoryStateBindingCertificatesV1 } from "../src/state-binding-certificate-v1.js";
import {
  bindMemoryStateObservationV2,
  compileMemoryStateSlotsV2,
  compileMemoryStateSourceLockV2,
  resolveMemoryStateFrameV2,
} from "../src/state-frame-v2.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "../src/temporal-constraint.js";

type ObservationFixture = Readonly<{
  requirementId: string;
  evidenceRef: string;
  value: string;
  content?: string;
  valueSpans?: readonly Readonly<{ start: number; end: number }>[];
  eventTime?: string;
  eventTimeBasis?:
    | "explicit_span"
    | "source_session_contemporaneous"
    | "unbound";
  durationEndpointRole?: "start" | "end" | "evidence" | "not_applicable";
  lifecycleRelation?: "none" | "retracts" | "supersedes" | "confirms";
  lifecycleTargetEvidenceRef?: string;
  observedAt: string;
  eventKey?: string;
  sourceId?: string;
  episodeOrder?: number;
  turnOrder?: number;
  predicateKind?:
    | "assert"
    | "update"
    | "retract"
    | "confirm"
    | "prefer"
    | "disprefer";
  polarity?: "positive" | "negative";
  modality?: "observed" | "goal" | "plan" | "forecast";
  bind?: boolean;
}>;

function executeFixture(input: {
  query: string;
  intent: MemoryEvidenceQueryIntentV3;
  requirements: readonly MemoryEvidenceRequirementV3[];
  observations: readonly ObservationFixture[];
  failedRequirementIds?: ReadonlySet<string>;
  historicalEvidenceRefs?: ReadonlySet<string>;
  closedWorld?: boolean;
}) {
  const temporalConstraints = input.requirements.map((requirement) =>
    bindMemoryEvidenceTemporalConstraintV1({
      query: input.query,
      queryEnvelopeMode: input.intent.temporalMode,
      leafMode: requirement.temporalMode,
      evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
    }),
  );
  const candidateScopes = input.requirements.map((requirement) => ({
    requirementId: requirement.requirementId,
    evidenceRefs: input.observations
      .filter((item) => item.requirementId === requirement.requirementId)
      .map((item) => item.evidenceRef),
  }));
  const groups = compileMemoryEvidenceSelectorGroupsV1({
    intent: input.intent,
    requirements: input.requirements,
  });
  const lockedSourceIds = [
    ...new Set(
      input.observations.map(
        (item) => item.sourceId ?? `source-${item.evidenceRef}`,
      ),
    ),
  ];
  const snapshot = compileMemorySelectorExecutionSnapshotV1({
    query: input.query,
    intent: input.intent,
    requirements: input.requirements,
    temporalConstraints,
    candidateScopes,
    lockedSourceIds,
    originRevision: compileMemoryQueryAnswerOriginV1(input.query)
      .originRevision,
    selectorVersion: "selector-test",
    selectionRevision: "selection-test",
    committedAttempt: "baseline",
    attemptCount: 1,
    groups: groups.map((group) => {
      const failed = group.requirementIds.some((requirementId) =>
        input.failedRequirementIds?.has(requirementId),
      );
      return {
        groupId: group.groupId,
        requirementIds: group.requirementIds,
        status: failed ? ("failed" as const) : ("committed" as const),
        assessments: failed
          ? []
          : group.requirementIds.map((requirementId) => {
              const refs = candidateScopes.find(
                (scope) => scope.requirementId === requirementId,
              )?.evidenceRefs;
              return {
                requirementId,
                supportingEvidenceRefs: refs ?? [],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
                evidenceDispositions: (refs ?? []).map((evidenceRef) => ({
                  requirementId,
                  evidenceRef,
                  disposition: "supporting" as const,
                  resolvedRole: "user" as const,
                  evidenceUse: "user_fact" as const,
                  contextEvidenceRefs: [],
                })),
              };
            }),
        ...(failed ? { failureCodes: ["SelectorGroupFailed"] } : {}),
      };
    }),
  });
  const program = compileMemoryEvidenceExecutionProgramV1({
    query: input.query,
    intent: input.intent,
    requirements: input.requirements,
    temporalConstraints,
    selectorSnapshot: snapshot,
  });
  const slots = compileMemoryStateSlotsV2({
    query: input.query,
    intent: input.intent,
    requirements: input.requirements,
    origin: compileMemoryQueryAnswerOriginV1(input.query),
    temporalConstraints: new Map(
      input.requirements.map((requirement, index) => [
        requirement.requirementId,
        temporalConstraints[index] as (typeof temporalConstraints)[number],
      ]),
    ),
  });
  const sourceLock = compileMemoryStateSourceLockV2([
    ...new Map(
      input.observations.map((item, index) => [
        item.evidenceRef,
        {
          sourceId: item.sourceId ?? `source-${item.evidenceRef}`,
          evidenceRef: item.evidenceRef,
          content:
            item.content ??
            [item.value, item.eventTime].filter(Boolean).join(" on "),
          authority: "user_asserted" as const,
          role: "user" as const,
          observedAt: item.observedAt,
          episodeOrder: item.episodeOrder ?? index,
          turnOrder: item.turnOrder ?? 1,
          ...(item.eventKey === undefined ? {} : { eventKey: item.eventKey }),
        },
      ]),
    ).values(),
  ]);
  const slotByRequirement = new Map(
    slots.map((slot) => [slot.requirementId, slot]),
  );
  const observations = input.observations.flatMap((item, observationIndex) => {
    if (item.bind === false) return [];
    const slot = slotByRequirement.get(item.requirementId);
    const source = sourceLock.items.find(
      (candidate) => candidate.evidenceRef === item.evidenceRef,
    );
    if (!slot || !source) throw new Error("fixture invalid");
    const eventStart = item.eventTime
      ? source.content.indexOf(item.eventTime)
      : -1;
    const eventLength = item.eventTime?.length ?? 0;
    return [
      bindMemoryStateObservationV2({
        slot,
        sourceLock,
        proposal: {
          slotId: slot.slotId,
          evidenceRef: item.evidenceRef,
          valueSpans: item.valueSpans ?? [{ start: 0, end: item.value.length }],
          eventTimeSpans:
            eventStart < 0
              ? []
              : [{ start: eventStart, end: eventStart + eventLength }],
          eventTimeBasis:
            item.eventTimeBasis ??
            (eventStart < 0 ? "unbound" : "explicit_span"),
          durationEndpointRole:
            item.durationEndpointRole ??
            (slot.durationEndpointContractKind === "evidence_to_host_anchor"
              ? "evidence"
              : slot.durationEndpointContractKind === "distinct_evidence_pair"
                ? input.observations
                    .slice(0, observationIndex)
                    .filter((candidate) => candidate.bind !== false).length ===
                  0
                  ? "start"
                  : "end"
                : "not_applicable"),
          lifecycleRelation: item.lifecycleRelation ?? "none",
          ...(item.lifecycleTargetEvidenceRef === undefined
            ? {}
            : {
                lifecycleTargetEvidenceRef: item.lifecycleTargetEvidenceRef,
              }),
          predicateKind: item.predicateKind ?? "assert",
          polarity: item.polarity ?? "positive",
          modality: item.modality ?? "observed",
        },
      }),
    ];
  });
  const frame = resolveMemoryStateFrameV2({ slots, observations, sourceLock });
  const verification = {
    verifierVersion: "test-verifier",
    verificationRevision: "test-verification",
    acceptedObservationIds: observations.map(
      (observation) => observation.observationId,
    ),
    rejectedObservationIds: [],
  };
  const bindingCertificateValidationContext = {
    query: input.query,
    slots,
    sourceLock,
    proposedObservations: observations,
    verification,
  };
  const validatedObservations = compileMemoryStateBindingCertificatesV1(
    bindingCertificateValidationContext,
  );
  const coverageValidationContext =
    input.closedWorld === false
      ? undefined
      : ({
          intent: input.intent,
          requirements: input.requirements,
          temporalConstraints,
          selectorSnapshot: snapshot,
          notebook: {
            policyVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
            sources: [],
            coverage: input.requirements.map((requirement) => {
              const refs =
                candidateScopes.find(
                  (scope) => scope.requirementId === requirement.requirementId,
                )?.evidenceRefs ?? [];
              const historicalEvidenceRefs = refs.filter((evidenceRef) =>
                input.historicalEvidenceRefs?.has(evidenceRef),
              );
              const selectedEvidenceRefs = refs.filter(
                (evidenceRef) =>
                  !input.historicalEvidenceRefs?.has(evidenceRef),
              );
              const independentEvidenceCount = new Set(
                selectedEvidenceRefs.map((evidenceRef) => {
                  const source = sourceLock.items.find(
                    (item) => item.evidenceRef === evidenceRef,
                  );
                  if (!source) throw new Error("fixture invalid");
                  return memoryEvidenceIndependenceIdentityRevisionV1(source);
                }),
              ).size;
              const closureEvidenceCount =
                requirement.coverageMode === "convergent"
                  ? independentEvidenceCount
                  : selectedEvidenceRefs.length;
              const minimumEvidence = requirement.minimumEvidence ?? 1;
              return {
                requirementId: requirement.requirementId,
                status:
                  closureEvidenceCount >= minimumEvidence
                    ? ("covered" as const)
                    : selectedEvidenceRefs.length > 0
                      ? ("partial" as const)
                      : ("missing" as const),
                selectedHitCount: selectedEvidenceRefs.length,
                independentEvidenceCount,
                closureEvidenceCount,
                selectedEvidenceRefs,
                historicalEvidenceRefs,
                unresolvedEvidenceRefs: [],
                inputEvidenceRefs: refs,
                budgetOmittedEvidenceRefs: [],
                admission: refs.map((evidenceRef) => ({
                  evidenceRef,
                  disposition: input.historicalEvidenceRefs?.has(evidenceRef)
                    ? ("historical" as const)
                    : ("selected" as const),
                  independenceIdentityRevision: (() => {
                    const source = sourceLock.items.find(
                      (item) => item.evidenceRef === evidenceRef,
                    );
                    if (!source) throw new Error("fixture invalid");
                    return memoryEvidenceIndependenceIdentityRevisionV1(source);
                  })(),
                })),
                budgetOmittedHitCount: 0,
              };
            }),
            inputHitCount: candidateScopes.reduce(
              (count, scope) => count + scope.evidenceRefs.length,
              0,
            ),
            budgetOmittedHitCount: 0,
            selectedHitCount: candidateScopes.reduce(
              (count, scope) =>
                count +
                scope.evidenceRefs.filter(
                  (evidenceRef) =>
                    !input.historicalEvidenceRefs?.has(evidenceRef),
                ).length,
              0,
            ),
            chars: 64,
          },
          closureAuditStatus: "completed",
          closureVerdict: "pass",
          closureAuditRevision: "closure-test",
        } as const);
  const coverageCertificate = coverageValidationContext
    ? compileMemoryEvidenceExecutionCoverageCertificateV1(
        coverageValidationContext,
      )
    : undefined;
  return {
    query: input.query,
    intent: input.intent,
    requirements: input.requirements,
    temporalConstraints,
    selectorSnapshot: snapshot,
    lockedSourceIds,
    sourceLock,
    program,
    slots,
    frame,
    coverageCertificate,
    coverageValidationContext,
    validatedObservations,
    bindingCertificateValidationContext,
    result: executeMemoryEvidenceProgramV1({
      program,
      slots,
      frame,
      validatedObservations,
      bindingCertificateValidationContexts: [
        bindingCertificateValidationContext,
      ],
      ...(coverageCertificate === undefined
        ? {}
        : { coverageCertificate, coverageValidationContext }),
    }),
  };
}

const userIntent = (
  answerShape: MemoryEvidenceQueryIntentV3["answerShape"],
  temporalMode: MemoryEvidenceQueryIntentV3["temporalMode"],
): MemoryEvidenceQueryIntentV3 => ({
  answerShape,
  temporalMode,
  roleConstraint: "user",
  needsPlanning: true,
});

const requirement = (
  requirementId: string,
  temporalMode: MemoryEvidenceRequirementV3["temporalMode"] = "any",
  extra: Partial<MemoryEvidenceRequirementV3> = {},
): MemoryEvidenceRequirementV3 => ({
  requirementId,
  label: requirementId,
  searchText: requirementId,
  temporalMode,
  roleConstraint: "user",
  dependencyRelation: "independent",
  dependsOnRequirementIds: [],
  ...extra,
});

function nodeStatus(
  execution: ReturnType<typeof executeFixture>["result"],
  operation: string,
) {
  return execution.nodes.find((node) => node.operation === operation);
}

function run(input: Parameters<typeof executeFixture>[0]) {
  return executeFixture(input);
}

function project(
  output: ReturnType<typeof executeFixture>,
  executionResult = output.result,
) {
  return buildMemoryEvidenceReaderProjectionV1({
    query: output.query,
    intent: output.intent,
    requirements: output.requirements,
    temporalConstraints: output.temporalConstraints,
    selectorSnapshot: output.selectorSnapshot,
    lockedSourceIds: output.lockedSourceIds,
    sourceLock: output.sourceLock,
    program: output.program,
    slots: output.slots,
    frame: output.frame,
    validatedObservations: output.validatedObservations,
    bindingCertificateValidationContexts: [
      output.bindingCertificateValidationContext,
    ],
    ...(output.coverageCertificate === undefined
      ? {}
      : {
          coverageCertificate: output.coverageCertificate,
          coverageValidationContext: output.coverageValidationContext,
        }),
    executionResult,
  });
}

describe("proof-carrying evidence execution runtime v1", () => {
  test("uses event time instead of a later observation timestamp for latest", () => {
    const output = run({
      query: "What is the latest value?",
      intent: userIntent("lookup", "latest"),
      requirements: [requirement("value", "latest")],
      historicalEvidenceRefs: new Set(["old"]),
      observations: [
        {
          requirementId: "value",
          evidenceRef: "old",
          value: "old",
          eventTime: "2023-01-01",
          observedAt: "2024-12-01T00:00:00.000Z",
        },
        {
          requirementId: "value",
          evidenceRef: "new",
          value: "new",
          eventTime: "2024-01-01",
          observedAt: "2024-02-01T00:00:00.000Z",
        },
      ],
    });
    const latest = nodeStatus(output.result, "resolve_latest");
    expect(latest?.status).toBe("complete");
    expect(
      latest?.values.some(
        (value) => value.kind === "observation" && value.valueText === "new",
      ),
    ).toBe(true);
  });

  test("keeps latest partial when a retained historical ref was not materialized", () => {
    const output = run({
      query: "What is the latest value?",
      intent: userIntent("lookup", "latest"),
      requirements: [requirement("value", "latest")],
      historicalEvidenceRefs: new Set(["old"]),
      observations: [
        {
          requirementId: "value",
          evidenceRef: "old",
          value: "old",
          eventTime: "2023-01-01",
          observedAt: "2023-01-02T00:00:00.000Z",
          bind: false,
        },
        {
          requirementId: "value",
          evidenceRef: "current",
          value: "current",
          eventTime: "2024-01-01",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });

    expect(nodeStatus(output.result, "read_requirement")).toMatchObject({
      status: "partial",
      reason: "coverage_materialization_incomplete",
    });
    expect(nodeStatus(output.result, "resolve_latest")).toMatchObject({
      status: "partial",
      reason: "coverage_materialization_incomplete",
    });
  });

  test("rejects a self-hashed completion basis that disagrees with the program", () => {
    const output = run({
      query: "What is the latest value?",
      intent: userIntent("lookup", "latest"),
      requirements: [requirement("value", "latest")],
      observations: [
        {
          requirementId: "value",
          evidenceRef: "value-ref",
          value: "current",
          observedAt: "2024-12-01T00:00:00.000Z",
        },
      ],
    });
    const certificate = output.coverageCertificate;
    const coverage = certificate?.requirements[0];
    if (!certificate || !coverage) throw new Error("coverage fixture invalid");
    const { proofRevision: _proofRevision, ...coverageIdentity } = coverage;
    const forgedCoverageIdentity = {
      ...coverageIdentity,
      completionBasis: "bounded_window_lookup" as const,
    };
    const forgedCoverage = {
      ...forgedCoverageIdentity,
      proofRevision: hashCanonicalJsonV1(forgedCoverageIdentity as never),
    };
    const {
      certificateRevision: _certificateRevision,
      ...certificateIdentity
    } = certificate;
    const forgedCertificateIdentity = {
      ...certificateIdentity,
      requirements: [forgedCoverage],
    };
    const forgedCertificate = {
      ...forgedCertificateIdentity,
      certificateRevision: hashCanonicalJsonV1(
        forgedCertificateIdentity as never,
      ),
    };

    expect(() =>
      executeMemoryEvidenceProgramV1({
        program: output.program,
        slots: output.slots,
        frame: output.frame,
        validatedObservations: output.validatedObservations,
        bindingCertificateValidationContexts: [
          output.bindingCertificateValidationContext,
        ],
        coverageCertificate: forgedCertificate,
        coverageValidationContext: output.coverageValidationContext,
      }),
    ).toThrow("MemoryEvidenceExecutionRuntimeCoverageInvalid");
  });

  test("rejects a self-hashed closed certificate when its source predicates remain open", () => {
    const output = run({
      query: "What is the latest value?",
      intent: userIntent("lookup", "latest"),
      requirements: [requirement("value", "latest")],
      observations: [
        {
          requirementId: "value",
          evidenceRef: "value-ref",
          value: "current",
          observedAt: "2024-12-01T00:00:00.000Z",
        },
      ],
    });
    const context = output.coverageValidationContext;
    if (!context) throw new Error("coverage context fixture invalid");
    const {
      closureAuditRevision: _closureAuditRevision,
      ...contextWithoutAuditRevision
    } = context;
    const openContext = {
      ...contextWithoutAuditRevision,
      closureAuditStatus: "fallback" as const,
      closureVerdict: "insufficient" as const,
    };
    const openCertificate =
      compileMemoryEvidenceExecutionCoverageCertificateV1(openContext);
    const openCoverage = openCertificate.requirements[0];
    if (!openCoverage) throw new Error("open coverage fixture invalid");
    const { proofRevision: _proofRevision, ...openCoverageIdentity } =
      openCoverage;
    const forgedCoverageIdentity = {
      ...openCoverageIdentity,
      status: "closed" as const,
      reasonCodes: [] as const,
    };
    const forgedCoverage = {
      ...forgedCoverageIdentity,
      proofRevision: hashCanonicalJsonV1(forgedCoverageIdentity as never),
    };
    const {
      certificateRevision: _certificateRevision,
      ...openCertificateIdentity
    } = openCertificate;
    const forgedCertificateIdentity = {
      ...openCertificateIdentity,
      status: "closed" as const,
      requirements: [forgedCoverage],
    };
    const forgedCertificate = {
      ...forgedCertificateIdentity,
      certificateRevision: hashCanonicalJsonV1(
        forgedCertificateIdentity as never,
      ),
    };

    expect(() =>
      executeMemoryEvidenceProgramV1({
        program: output.program,
        slots: output.slots,
        frame: output.frame,
        validatedObservations: output.validatedObservations,
        bindingCertificateValidationContexts: [
          output.bindingCertificateValidationContext,
        ],
        coverageCertificate: forgedCertificate,
        coverageValidationContext: openContext,
      }),
    ).toThrow("MemoryEvidenceExecutionRuntimeCoverageInvalid");
  });

  test("revalidates notebook independence identities against the source lock", () => {
    const output = run({
      query: "What activity do I repeatedly prefer?",
      intent: userIntent("lookup", "any"),
      requirements: [
        requirement("preference", "any", {
          coverageMode: "convergent",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "restatement-one",
          value: "running",
          eventKey: "same-event",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "preference",
          evidenceRef: "restatement-two",
          value: "running",
          eventKey: "same-event",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });
    const context = output.coverageValidationContext;
    const row = context?.notebook.coverage[0];
    if (!context || !row || !row.admission) throw new Error("fixture invalid");
    const forgedContext = {
      ...context,
      notebook: {
        ...context.notebook,
        coverage: [
          {
            ...row,
            status: "covered" as const,
            independentEvidenceCount: 2,
            closureEvidenceCount: 2,
            admission: row.admission.map((item, index) =>
              index === 1
                ? {
                    ...item,
                    independenceIdentityRevision: hashCanonicalJsonV1(
                      "forged-independent-event",
                    ),
                  }
                : item,
            ),
          },
        ],
      },
    };
    const forgedCertificate =
      compileMemoryEvidenceExecutionCoverageCertificateV1(forgedContext);

    expect(() =>
      executeMemoryEvidenceProgramV1({
        program: output.program,
        slots: output.slots,
        frame: output.frame,
        validatedObservations: output.validatedObservations,
        bindingCertificateValidationContexts: [
          output.bindingCertificateValidationContext,
        ],
        coverageCertificate: forgedCertificate,
        coverageValidationContext: forgedContext,
      }),
    ).toThrow("MemoryEvidenceExecutionRuntimeCoverageInvalid");
  });

  test("keeps mixed event and observed clocks partial", () => {
    const output = run({
      query: "What is the latest value?",
      intent: userIntent("lookup", "latest"),
      requirements: [requirement("value", "latest")],
      observations: [
        {
          requirementId: "value",
          evidenceRef: "dated",
          value: "dated",
          eventTime: "2024-01-01",
          observedAt: "2024-02-01T00:00:00.000Z",
        },
        {
          requirementId: "value",
          evidenceRef: "undated",
          value: "undated",
          observedAt: "2024-03-01T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "resolve_latest")).toMatchObject({
      status: "partial",
      reason: "mixed_clock",
    });
  });

  test("marks overlapping event intervals with different values as conflict", () => {
    const output = run({
      query: "What is the latest value?",
      intent: userIntent("lookup", "latest"),
      requirements: [requirement("value", "latest")],
      observations: [
        {
          requirementId: "value",
          evidenceRef: "year",
          value: "red",
          eventTime: "2024",
          observedAt: "2024-02-01T00:00:00.000Z",
        },
        {
          requirementId: "value",
          evidenceRef: "day",
          value: "blue",
          eventTime: "2024-06-01",
          observedAt: "2024-07-01T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "resolve_latest")?.status).toBe(
      "conflict",
    );
  });

  test("executes as-of only after the host binds a deterministic anchor", () => {
    const output = run({
      query: "What was the value as of 2024?",
      intent: userIntent("lookup", "as_of"),
      requirements: [requirement("value", "as_of")],
      observations: [
        {
          requirementId: "value",
          evidenceRef: "v",
          value: "red",
          eventTime: "2023-01-01",
          observedAt: "2023-02-01T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "resolve_as_of")?.status).toBe("complete");

    const unbound = run({
      query: "What was the value at that time?",
      intent: userIntent("lookup", "as_of"),
      requirements: [requirement("value", "as_of")],
      observations: [
        {
          requirementId: "value",
          evidenceRef: "v",
          value: "red",
          eventTime: "2023-01-01",
          observedAt: "2023-02-01T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(unbound.result, "resolve_as_of")).toMatchObject({
      status: "unsupported",
      reason: "temporal_anchor_unbound",
    });
  });

  test("filters a relative range using a uniform session clock", () => {
    const output = run({
      query: "What happened last week?",
      intent: userIntent("lookup", "range"),
      requirements: [requirement("events", "range", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "events",
          evidenceRef: "inside",
          value: "inside",
          observedAt: "2024-12-28T00:00:00.000Z",
        },
        {
          requirementId: "events",
          evidenceRef: "outside",
          value: "outside",
          observedAt: "2024-12-10T00:00:00.000Z",
        },
      ],
    });
    const range = nodeStatus(output.result, "restrict_range");
    expect(range?.status).toBe("complete");
    expect(
      range?.values.filter((value) => value.kind === "observation"),
    ).toHaveLength(1);
  });

  test("keeps temporal results partial until every coverage-selected ref is materialized", () => {
    const cases = [
      {
        query: "What happened last week?",
        intent: userIntent("lookup", "range"),
        requirement: requirement("events", "range", {
          coverageMode: "all",
        }),
        operation: "restrict_range",
        observations: [
          {
            requirementId: "events",
            evidenceRef: "range-bound",
            value: "bound event",
            observedAt: "2024-12-28T00:00:00.000Z",
          },
          {
            requirementId: "events",
            evidenceRef: "range-unbound",
            value: "unbound event",
            observedAt: "2024-12-29T00:00:00.000Z",
            bind: false,
          },
        ],
      },
      {
        query: "Give me the complete history.",
        intent: userIntent("lookup", "history"),
        requirement: requirement("history", "history", {
          coverageMode: "all",
        }),
        operation: "preserve_history",
        observations: [
          {
            requirementId: "history",
            evidenceRef: "history-bound",
            value: "old state",
            eventTime: "2023-01-01",
            observedAt: "2023-01-02T00:00:00.000Z",
          },
          {
            requirementId: "history",
            evidenceRef: "history-unbound",
            value: "new state",
            eventTime: "2024-01-01",
            observedAt: "2024-01-02T00:00:00.000Z",
            bind: false,
          },
        ],
      },
      {
        query: "What is the latest value?",
        intent: userIntent("lookup", "latest"),
        requirement: requirement("latest", "latest"),
        operation: "resolve_latest",
        observations: [
          {
            requirementId: "latest",
            evidenceRef: "latest-bound",
            value: "old state",
            eventTime: "2023-01-01",
            observedAt: "2023-01-02T00:00:00.000Z",
          },
          {
            requirementId: "latest",
            evidenceRef: "latest-unbound",
            value: "new state",
            eventTime: "2024-01-01",
            observedAt: "2024-01-02T00:00:00.000Z",
            bind: false,
          },
        ],
      },
      {
        query: "What was the value as of 2024?",
        intent: userIntent("lookup", "as_of"),
        requirement: requirement("as-of", "as_of"),
        operation: "resolve_as_of",
        observations: [
          {
            requirementId: "as-of",
            evidenceRef: "as-of-bound",
            value: "old state",
            eventTime: "2023-01-01",
            observedAt: "2023-01-02T00:00:00.000Z",
          },
          {
            requirementId: "as-of",
            evidenceRef: "as-of-unbound",
            value: "new state",
            eventTime: "2024-01-01",
            observedAt: "2024-01-02T00:00:00.000Z",
            bind: false,
          },
        ],
      },
    ] as const;

    for (const item of cases) {
      const output = run({
        query: item.query,
        intent: item.intent,
        requirements: [item.requirement],
        observations: item.observations,
      });
      expect(nodeStatus(output.result, "read_requirement")).toMatchObject({
        status: "partial",
        reason: "coverage_materialization_incomplete",
      });
      expect(nodeStatus(output.result, item.operation)).toMatchObject({
        status: "partial",
        reason: "coverage_materialization_incomplete",
      });
    }
  });

  test("rechecks all-mode minimum evidence after range filtering", () => {
    const output = run({
      query: "What happened last week?",
      intent: userIntent("lookup", "range"),
      requirements: [
        requirement("events", "range", {
          coverageMode: "all",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "events",
          evidenceRef: "inside",
          value: "inside",
          observedAt: "2024-12-28T00:00:00.000Z",
        },
        {
          requirementId: "events",
          evidenceRef: "outside",
          value: "outside",
          observedAt: "2024-12-10T00:00:00.000Z",
        },
      ],
    });

    expect(nodeStatus(output.result, "restrict_range")).toMatchObject({
      status: "partial",
      reason: "minimum_evidence_unsatisfied",
    });
  });

  test("rechecks convergent independence after range filtering", () => {
    const output = run({
      query: "What happened last week?",
      intent: userIntent("lookup", "range"),
      requirements: [
        requirement("events", "range", {
          coverageMode: "convergent",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "events",
          evidenceRef: "event-a",
          value: "same",
          eventKey: "event-a",
          observedAt: "2024-12-28T00:00:00.000Z",
        },
        {
          requirementId: "events",
          evidenceRef: "event-b-outside",
          value: "same",
          eventKey: "event-b",
          observedAt: "2024-12-10T00:00:00.000Z",
        },
      ],
    });

    expect(nodeStatus(output.result, "restrict_range")).toMatchObject({
      status: "partial",
      reason: "minimum_evidence_unsatisfied",
    });
  });

  test("blocks range convergence when an in-window event is inconsistent", () => {
    const output = run({
      query: "What happened last week?",
      intent: userIntent("lookup", "range"),
      requirements: [
        requirement("events", "range", {
          coverageMode: "convergent",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "events",
          evidenceRef: "event-a-one",
          value: "alpha",
          eventKey: "event-a",
          observedAt: "2024-12-28T00:00:00.000Z",
        },
        {
          requirementId: "events",
          evidenceRef: "event-a-two",
          value: "beta",
          eventKey: "event-a",
          observedAt: "2024-12-28T00:00:00.000Z",
        },
        {
          requirementId: "events",
          evidenceRef: "event-b",
          value: "alpha",
          eventKey: "event-b",
          observedAt: "2024-12-29T00:00:00.000Z",
        },
      ],
    });

    expect(nodeStatus(output.result, "restrict_range")).toMatchObject({
      status: "conflict",
    });
  });

  test("measures an exact day duration without treating it as a range filter", () => {
    const output = run({
      query: "How many days elapsed between the start and the end?",
      intent: userIntent("lookup", "range"),
      closedWorld: false,
      requirements: [
        requirement("start", "range"),
        requirement("end", "range"),
      ],
      observations: [
        {
          requirementId: "start",
          evidenceRef: "start",
          value: "start",
          eventTime: "2024-01-01",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
        {
          requirementId: "end",
          evidenceRef: "end",
          value: "end",
          eventTime: "2024-01-11",
          observedAt: "2024-01-12T00:00:00.000Z",
        },
      ],
    });
    expect(
      output.program.nodes.some((node) => node.operation === "restrict_range"),
    ).toBe(false);
    const duration = nodeStatus(output.result, "measure_duration");
    expect(duration?.status).toBe("complete");
    expect(
      duration?.values.find((value) => value.kind === "temporal_duration"),
    ).toMatchObject({ precision: "exact", unit: "day", value: 10 });
    const projection = project(output);
    expect(projection).toMatchObject({
      status: "projected",
      projection: {
        payload: {
          kind: "temporal_duration",
          precision: "exact",
          unit: "day",
          value: 10,
        },
        stateBindingCertificateIds: [expect.any(String), expect.any(String)],
        packetRevision: expect.any(String),
      },
    });
  });

  test("rejects a recomputed but transaction-mismatched reader execution", () => {
    const output = run({
      query: "How many days elapsed between the start and the end?",
      intent: userIntent("lookup", "range"),
      closedWorld: false,
      requirements: [
        requirement("start", "range"),
        requirement("end", "range"),
      ],
      observations: [
        {
          requirementId: "start",
          evidenceRef: "start",
          value: "start",
          eventTime: "2024-01-01",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
        {
          requirementId: "end",
          evidenceRef: "end",
          value: "end",
          eventTime: "2024-01-11",
          observedAt: "2024-01-12T00:00:00.000Z",
        },
      ],
    });
    const forgedIdentity = {
      ...output.result,
      completeNodeCount: output.result.completeNodeCount + 1,
    };
    const { executionRevision: _executionRevision, ...withoutRevision } =
      forgedIdentity;
    const forged = {
      ...withoutRevision,
      executionRevision: hashCanonicalJsonV1(withoutRevision as never),
    };
    expect(project(output, forged)).toEqual({
      status: "rejected",
      rejectedReason: "execution_mismatch",
    });
  });

  test("closes two duration endpoints from the same source episode", () => {
    const output = run({
      query: "How many days elapsed between the two events?",
      intent: userIntent("lookup", "range"),
      requirements: [
        requirement("events", "range", {
          coverageMode: "all",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "events",
          evidenceRef: "first-event",
          value: "first event",
          eventTime: "2024-01-01",
          observedAt: "2024-01-01T00:00:00.000Z",
          sourceId: "shared-session",
          episodeOrder: 7,
          turnOrder: 1,
        },
        {
          requirementId: "events",
          evidenceRef: "second-event",
          value: "second event",
          eventTime: "2024-01-11",
          observedAt: "2024-01-11T00:00:00.000Z",
          sourceId: "shared-session",
          episodeOrder: 7,
          turnOrder: 2,
        },
      ],
    });
    expect(nodeStatus(output.result, "measure_duration")).toMatchObject({
      status: "complete",
    });
  });

  test("uses verifier-certified contemporaneous source-session anchors", () => {
    const output = run({
      query: "How many days elapsed between the start and the end?",
      intent: userIntent("lookup", "range"),
      closedWorld: false,
      requirements: [
        requirement("start", "range"),
        requirement("end", "range"),
      ],
      observations: [
        {
          requirementId: "start",
          evidenceRef: "start-session",
          value: "started",
          observedAt: "2024-01-01T00:00:00.000Z",
          eventTimeBasis: "source_session_contemporaneous",
          durationEndpointRole: "start",
        },
        {
          requirementId: "end",
          evidenceRef: "end-session",
          value: "finished",
          observedAt: "2024-01-11T00:00:00.000Z",
          eventTimeBasis: "source_session_contemporaneous",
          durationEndpointRole: "end",
        },
      ],
    });
    expect(nodeStatus(output.result, "measure_duration")).toMatchObject({
      status: "complete",
    });
    expect(output.result.stateBindingCertificates).toHaveLength(2);
    expect(
      output.result.stateBindingCertificates.every(
        (certificate) =>
          certificate.claimBinding.eventTime.sourceSessionAnchor !== undefined,
      ),
    ).toBe(true);
  });

  test("does not treat two occurrences with one stable event key as two endpoints", () => {
    const output = run({
      query: "How many days elapsed between the two events?",
      intent: userIntent("lookup", "range"),
      closedWorld: false,
      requirements: [
        requirement("start", "range"),
        requirement("end", "range"),
      ],
      observations: [
        {
          requirementId: "start",
          evidenceRef: "first-occurrence",
          value: "same event",
          eventTime: "2024-01-01",
          observedAt: "2024-01-01T00:00:00.000Z",
          eventKey: "stable-event",
          durationEndpointRole: "start",
        },
        {
          requirementId: "end",
          evidenceRef: "second-occurrence",
          value: "same event repeated",
          eventTime: "2024-01-11",
          observedAt: "2024-01-11T00:00:00.000Z",
          eventKey: "stable-event",
          durationEndpointRole: "end",
        },
      ],
    });
    expect(nodeStatus(output.result, "measure_duration")).toMatchObject({
      status: "partial",
      reason: "duration_endpoint_ambiguous",
    });
  });

  test("does not count one bound claim twice when requirements overlap", () => {
    const output = run({
      query: "How many days elapsed between the two events?",
      intent: userIntent("lookup", "range"),
      closedWorld: false,
      requirements: [
        requirement("first-view", "range"),
        requirement("second-view", "range"),
      ],
      observations: [
        {
          requirementId: "first-view",
          evidenceRef: "shared-event",
          value: "shared event",
          eventTime: "2024-01-01",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "second-view",
          evidenceRef: "shared-event",
          value: "shared event",
          eventTime: "2024-01-01",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    const duration = nodeStatus(output.result, "measure_duration");
    expect(duration).toMatchObject({
      status: "partial",
      reason: "duration_endpoint_ambiguous",
    });
    expect(
      duration?.values.filter((value) => value.kind === "observation"),
    ).toHaveLength(1);
  });

  test("measures one event against the trusted query anchor", () => {
    const output = run({
      query: "How many days ago did I visit that city?",
      intent: userIntent("aggregate", "range"),
      requirements: [requirement("visit", "range")],
      observations: [
        {
          requirementId: "visit",
          evidenceRef: "visit",
          value: "visit",
          eventTime: "2024-12-22",
          observedAt: "2024-12-23T00:00:00.000Z",
        },
      ],
    });
    const duration = nodeStatus(output.result, "measure_duration");
    expect(duration?.status).toBe("complete");
    expect(
      duration?.values.find((value) => value.kind === "temporal_duration"),
    ).toMatchObject({
      precision: "exact",
      unit: "day",
      value: 10,
      endpointPolicy: "evidence_to_query_anchor",
      queryAnchor: "2025-01-01T00:00:00.000Z",
    });
  });

  test("refuses observation time as a substitute for an event-to-query duration", () => {
    const output = run({
      query: "How long ago did that happen?",
      intent: userIntent("lookup", "range"),
      requirements: [requirement("event", "range")],
      observations: [
        {
          requirementId: "event",
          evidenceRef: "event",
          value: "event",
          observedAt: "2024-12-22T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "measure_duration")).toMatchObject({
      status: "partial",
      reason: "clock_incomplete",
    });
  });

  test("rejects surplus duration operands instead of ignoring them", () => {
    const output = run({
      query: "How many days elapsed between the events?",
      intent: userIntent("lookup", "range"),
      requirements: [
        requirement("first", "range"),
        requirement("second", "range"),
        requirement("third", "range"),
      ],
      observations: [
        {
          requirementId: "first",
          evidenceRef: "first",
          value: "first",
          eventTime: "2024-01-01",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "second",
          evidenceRef: "second",
          value: "second",
          eventTime: "2024-01-02",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
        {
          requirementId: "third",
          evidenceRef: "third",
          value: "third",
          eventTime: "2024-01-03",
          observedAt: "2024-01-03T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "measure_duration")).toMatchObject({
      status: "partial",
      reason: "duration_endpoint_ambiguous",
    });
  });

  test("binds duration identity to endpoint policy and query anchor", () => {
    const output = run({
      query: "How many days ago did the event happen?",
      intent: userIntent("aggregate", "range"),
      requirements: [requirement("event", "range")],
      observations: [
        {
          requirementId: "event",
          evidenceRef: "event",
          value: "event",
          eventTime: "2024-12-22",
          observedAt: "2024-12-22T00:00:00.000Z",
        },
      ],
    });
    const nodes = output.program.nodes.map((node) =>
      node.operation === "measure_duration" && node.durationRequest
        ? {
            ...node,
            durationRequest: { ...node.durationRequest, queryAnchor: null },
          }
        : node,
    );
    expect(() =>
      validateMemoryEvidenceExecutionProgramV1({
        ...output.program,
        nodes,
      }),
    ).toThrow("MemoryEvidenceExecutionProgramInvalid");
  });

  test("rejects a stale resolved frame revision before executing", () => {
    const output = run({
      query: "What do I prefer?",
      intent: userIntent("recommend", "any"),
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "preference",
          value: "quiet places",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
      ],
    });
    expect(() =>
      executeMemoryEvidenceProgramV1({
        program: output.program,
        slots: output.slots,
        frame: { ...output.frame, frameRevision: "stale-frame" },
        validatedObservations: output.validatedObservations,
        bindingCertificateValidationContexts: [
          output.bindingCertificateValidationContext,
        ],
        ...(output.coverageCertificate === undefined
          ? {}
          : {
              coverageCertificate: output.coverageCertificate,
              coverageValidationContext: output.coverageValidationContext,
            }),
      }),
    ).toThrow("MemoryEvidenceExecutionRuntimeFrameInvalid");
  });

  test("fully revalidates a self-hashed state binding certificate registry", () => {
    const output = run({
      query: "What do I prefer?",
      intent: userIntent("recommend", "any"),
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "preference",
          value: "quiet places",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
      ],
    });
    const original = output.validatedObservations[0];
    if (!original) throw new Error("fixture");
    const forgedIdentity = {
      ...original.certificate,
      semanticAttestation: {
        ...original.certificate.semanticAttestation,
        verifierVersion: "forged-verifier",
      },
    };
    const { certificateId: _certificateId, ...withoutId } = forgedIdentity;
    const forged = {
      ...original,
      certificate: {
        ...withoutId,
        certificateId: hashCanonicalJsonV1(withoutId as never),
      },
    };
    expect(() =>
      executeMemoryEvidenceProgramV1({
        program: output.program,
        slots: output.slots,
        frame: output.frame,
        validatedObservations: [forged],
        bindingCertificateValidationContexts: [
          output.bindingCertificateValidationContext,
        ],
        ...(output.coverageCertificate === undefined
          ? {}
          : {
              coverageCertificate: output.coverageCertificate,
              coverageValidationContext: output.coverageValidationContext,
            }),
      }),
    ).toThrow("MemoryEvidenceExecutionRuntimeCertificateInvalid");
  });

  test("revalidates certified observations omitted from the resolved frame", () => {
    const output = run({
      query: "What do I prefer now?",
      intent: userIntent("recommend", "latest"),
      requirements: [
        requirement("preference", "latest", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "old-preference",
          value: "busy places",
          eventTime: "2023-01-01",
          observedAt: "2023-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
        {
          requirementId: "preference",
          evidenceRef: "current-preference",
          value: "quiet places",
          eventTime: "2024-01-01",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "update",
        },
      ],
    });
    expect(output.validatedObservations.length).toBe(2);
    const retainedObservation = output.frame.slots
      .flatMap((slot) => [...slot.current, ...slot.history, ...slot.conflicts])
      .at(-1);
    if (!retainedObservation) throw new Error("fixture");
    const projectedSlots = output.frame.slots.map((slot) => ({
      ...slot,
      current: Object.freeze(
        slot.slotId === retainedObservation.slotId ? [retainedObservation] : [],
      ),
      history: Object.freeze([]),
      conflicts: Object.freeze([]),
    }));
    const { frameRevision: _frameRevision, ...frameIdentity } = output.frame;
    const projectedFrameIdentity = {
      ...frameIdentity,
      slots: Object.freeze(projectedSlots),
    };
    const projectedFrame = {
      ...projectedFrameIdentity,
      frameRevision: hashCanonicalJsonV1(projectedFrameIdentity as never),
    };
    const executeProjected = (
      validatedObservations: typeof output.validatedObservations,
    ) =>
      executeMemoryEvidenceProgramV1({
        program: output.program,
        slots: output.slots,
        frame: projectedFrame,
        validatedObservations,
        bindingCertificateValidationContexts: [
          output.bindingCertificateValidationContext,
        ],
        ...(output.coverageCertificate === undefined
          ? {}
          : {
              coverageCertificate: output.coverageCertificate,
              coverageValidationContext: output.coverageValidationContext,
            }),
      });
    const execution = executeProjected(output.validatedObservations);
    expect(execution.stateBindingCertificates).toHaveLength(1);
    expect(execution.stateBindingCertificates[0]?.observationId).toBe(
      retainedObservation.observationId,
    );

    const omitted = output.validatedObservations.find(
      (item) =>
        item.observation.observationId !== retainedObservation.observationId,
    );
    if (!omitted) throw new Error("fixture");
    expect(
      execution.nodes.flatMap((node) =>
        node.values.flatMap((value) =>
          value.kind === "observation" ? [value.stateBindingCertificateId] : [],
        ),
      ),
    ).not.toContain(omitted.certificate.certificateId);
    const reorderedExecution = executeProjected(
      Object.freeze([...output.validatedObservations].reverse()),
    );
    expect(reorderedExecution.stateBindingCertificateRegistryRevision).toBe(
      execution.stateBindingCertificateRegistryRevision,
    );
    const forgedIdentity = {
      ...omitted.certificate,
      semanticAttestation: {
        ...omitted.certificate.semanticAttestation,
        verifierVersion: "forged-omitted-verifier",
      },
    };
    const { certificateId: _certificateId, ...withoutId } = forgedIdentity;
    const forgedOmitted = {
      ...omitted,
      certificate: {
        ...withoutId,
        certificateId: hashCanonicalJsonV1(withoutId as never),
      },
    };
    expect(() =>
      executeMemoryEvidenceProgramV1({
        program: output.program,
        slots: output.slots,
        frame: projectedFrame,
        validatedObservations: output.validatedObservations.map((item) =>
          item.observation.observationId === omitted.observation.observationId
            ? forgedOmitted
            : item,
        ),
        bindingCertificateValidationContexts: [
          output.bindingCertificateValidationContext,
        ],
        ...(output.coverageCertificate === undefined
          ? {}
          : {
              coverageCertificate: output.coverageCertificate,
              coverageValidationContext: output.coverageValidationContext,
            }),
      }),
    ).toThrow("MemoryEvidenceExecutionRuntimeCertificateInvalid");
  });

  test("rejects an otherwise valid certificate from another transaction", () => {
    const local = run({
      query: "What do I prefer?",
      intent: userIntent("recommend", "any"),
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "local-preference",
          value: "quiet places",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
      ],
    });
    const foreign = run({
      query: "What should somebody else choose?",
      intent: userIntent("recommend", "any"),
      requirements: [
        requirement("foreign-preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "foreign-preference",
          evidenceRef: "foreign-preference",
          value: "busy places",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
      ],
    });
    expect(() =>
      executeMemoryEvidenceProgramV1({
        program: local.program,
        slots: local.slots,
        frame: local.frame,
        validatedObservations: Object.freeze([
          ...local.validatedObservations,
          ...foreign.validatedObservations,
        ]),
        bindingCertificateValidationContexts: Object.freeze([
          local.bindingCertificateValidationContext,
          foreign.bindingCertificateValidationContext,
        ]),
        ...(local.coverageCertificate === undefined
          ? {}
          : {
              coverageCertificate: local.coverageCertificate,
              coverageValidationContext: local.coverageValidationContext,
            }),
      }),
    ).toThrow("MemoryEvidenceExecutionRuntimeCertificateInvalid");
  });

  test("rejects one observation placed in two frame partitions", () => {
    const output = run({
      query: "What do I prefer?",
      intent: userIntent("recommend", "any"),
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "preference",
          value: "quiet places",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
      ],
    });
    const firstSlot = output.frame.slots[0];
    const observation = firstSlot?.current[0] ?? firstSlot?.history[0];
    if (!firstSlot || !observation) throw new Error("fixture");
    const duplicatedSlots = Object.freeze([
      {
        ...firstSlot,
        history: Object.freeze([...firstSlot.history, observation]),
      },
      ...output.frame.slots.slice(1),
    ]);
    const { frameRevision: _frameRevision, ...frameIdentity } = output.frame;
    const duplicatedIdentity = { ...frameIdentity, slots: duplicatedSlots };
    const duplicatedFrame = {
      ...duplicatedIdentity,
      frameRevision: hashCanonicalJsonV1(duplicatedIdentity as never),
    };
    expect(() =>
      executeMemoryEvidenceProgramV1({
        program: output.program,
        slots: output.slots,
        frame: duplicatedFrame,
        validatedObservations: output.validatedObservations,
        bindingCertificateValidationContexts: [
          output.bindingCertificateValidationContext,
        ],
        ...(output.coverageCertificate === undefined
          ? {}
          : {
              coverageCertificate: output.coverageCertificate,
              coverageValidationContext: output.coverageValidationContext,
            }),
      }),
    ).toThrow("MemoryEvidenceExecutionRuntimeCertificateInvalid");
  });

  test("preserves history but refuses to call it closed-world complete", () => {
    const output = run({
      query: "Give me the history.",
      intent: userIntent("lookup", "history"),
      closedWorld: false,
      requirements: [requirement("value", "history")],
      observations: [
        {
          requirementId: "value",
          evidenceRef: "a",
          value: "a",
          eventTime: "2023-01-01",
          observedAt: "2023-01-02T00:00:00.000Z",
        },
        {
          requirementId: "value",
          evidenceRef: "b",
          value: "b",
          eventTime: "2024-01-01",
          observedAt: "2024-01-02T00:00:00.000Z",
          predicateKind: "update",
        },
      ],
    });
    const history = nodeStatus(output.result, "preserve_history");
    expect(history).toMatchObject({
      status: "partial",
      reason: "closed_world_unproven",
    });
    expect(history?.history.map((value) => value.valueText)).toEqual([
      "a",
      "b",
    ]);
  });

  test("closes same-session history using retained facts instead of episode count", () => {
    const output = run({
      query: "Give me the complete history.",
      intent: userIntent("lookup", "history"),
      requirements: [
        requirement("value", "history", {
          coverageMode: "all",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "value",
          evidenceRef: "history-a",
          value: "a",
          eventTime: "2023-01-01",
          observedAt: "2023-01-02T00:00:00.000Z",
          sourceId: "history-session",
          episodeOrder: 4,
          turnOrder: 1,
        },
        {
          requirementId: "value",
          evidenceRef: "history-b",
          value: "b",
          eventTime: "2024-01-01",
          observedAt: "2024-01-02T00:00:00.000Z",
          sourceId: "history-session",
          episodeOrder: 4,
          turnOrder: 2,
          predicateKind: "update",
        },
      ],
    });
    const history = nodeStatus(output.result, "preserve_history");
    expect(history).toMatchObject({ status: "complete" });
    expect(history?.history.map((value) => value.valueText)).toEqual([
      "a",
      "b",
    ]);
  });

  test("blocks history convergence when one event contains conflicting claims", () => {
    const output = run({
      query: "Give me the complete history.",
      intent: userIntent("lookup", "history"),
      requirements: [
        requirement("value", "history", {
          coverageMode: "convergent",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "value",
          evidenceRef: "event-a-one",
          value: "alpha",
          eventKey: "event-a",
          eventTime: "2023-01-01",
          observedAt: "2023-01-02T00:00:00.000Z",
        },
        {
          requirementId: "value",
          evidenceRef: "event-a-two",
          value: "beta",
          eventKey: "event-a",
          eventTime: "2023-01-01",
          observedAt: "2023-01-02T00:00:00.000Z",
        },
        {
          requirementId: "value",
          evidenceRef: "event-b",
          value: "alpha",
          eventKey: "event-b",
          eventTime: "2024-01-01",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });

    expect(nodeStatus(output.result, "preserve_history")).toMatchObject({
      status: "conflict",
    });
  });

  test("compiles and executes dependency joins instead of flattening dependencies", () => {
    const output = run({
      query: "Combine the dependent facts.",
      intent: userIntent("lookup", "any"),
      requirements: [
        requirement("base"),
        requirement("dependent", "any", {
          dependencyRelation: "depends_on",
          dependsOnRequirementIds: ["base"],
        }),
      ],
      observations: [
        {
          requirementId: "base",
          evidenceRef: "base-ref",
          value: "base",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "dependent",
          evidenceRef: "dependent-ref",
          value: "dependent",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });
    expect(
      output.program.nodes.some((node) => node.operation === "dependency_join"),
    ).toBe(true);
    expect(nodeStatus(output.result, "dependency_join")?.status).toBe(
      "complete",
    );
    const dependencyNode = output.program.nodes.find(
      (node) => node.operation === "dependency_join",
    );
    if (!dependencyNode) throw new Error("fixture invalid");
    expect(output.program.answerOperandNodeIds).toEqual([
      dependencyNode.nodeId,
    ]);
    expect(
      nodeStatus(output.result, "dependency_join")?.values.some(
        (value) => value.kind === "dependency_record",
      ),
    ).toBe(true);
  });

  test("creates a side-keyed comparison and blocks it when one side is missing", () => {
    const complete = run({
      query: "Compare left and right.",
      intent: userIntent("compare", "any"),
      requirements: [requirement("left"), requirement("right")],
      observations: [
        {
          requirementId: "left",
          evidenceRef: "left-ref",
          value: "10",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "right",
          evidenceRef: "right-ref",
          value: "20",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(complete.result, "compare_operands")?.status).toBe(
      "complete",
    );
    const completeProjection = project(complete);
    expect(completeProjection.status).toBe("projected");
    if (completeProjection.status !== "projected") {
      throw new Error("projection");
    }
    expect(completeProjection.projection.payload).toMatchObject({
      kind: "evidence_groups",
      operation: "compare_operands",
      groups: [
        { requirementId: "left", values: [{ valueText: "10" }] },
        { requirementId: "right", values: [{ valueText: "20" }] },
      ],
      comparison: {
        relation: "different",
        sides: [
          { operandRole: "left", groupKeys: [expect.any(String)] },
          { operandRole: "right", groupKeys: [expect.any(String)] },
        ],
      },
    });
    const partial = run({
      query: "Compare left and right.",
      intent: userIntent("compare", "any"),
      requirements: [requirement("left"), requirement("right")],
      observations: [
        {
          requirementId: "left",
          evidenceRef: "left-ref",
          value: "10",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "right",
          evidenceRef: "right-ref",
          value: "20",
          observedAt: "2024-01-01T00:00:00.000Z",
          bind: false,
        },
      ],
    });
    expect(nodeStatus(partial.result, "compare_operands")?.status).toBe(
      "partial",
    );
  });

  test("deduplicates aggregate event keys but keeps the result a lower bound", () => {
    const output = run({
      query: "Count the unique events.",
      intent: userIntent("aggregate", "any"),
      closedWorld: false,
      requirements: [requirement("events", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "events",
          evidenceRef: "one",
          value: "event",
          eventKey: "same",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "events",
          evidenceRef: "two",
          value: "event",
          eventKey: "same",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });
    const aggregate = nodeStatus(output.result, "aggregate_operands");
    expect(aggregate).toMatchObject({
      status: "partial",
      reason: "closed_world_unproven",
    });
    expect(
      aggregate?.values.find((value) => value.kind === "aggregate"),
    ).toMatchObject({ lowerBoundCount: 1, closedWorld: false });
  });

  test("keeps distinct aggregate members from the same event", () => {
    const output = run({
      query: "Collect the unique events.",
      intent: userIntent("aggregate", "any"),
      requirements: [
        requirement("events", "any", {
          coverageMode: "all",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "events",
          evidenceRef: "one",
          value: "alpha",
          eventKey: "same",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "events",
          evidenceRef: "two",
          value: "beta",
          eventKey: "same",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "aggregate_operands")).toMatchObject({
      status: "complete",
    });
    const aggregate = nodeStatus(
      output.result,
      "aggregate_operands",
    )?.values.find((value) => value.kind === "aggregate");
    expect(aggregate).toMatchObject({ lowerBoundCount: 2, closedWorld: true });
  });

  test("keeps same-event convergent evidence below its independent minimum", () => {
    const output = run({
      query: "What activity do I repeatedly prefer?",
      intent: userIntent("lookup", "any"),
      requirements: [
        requirement("preference", "any", {
          coverageMode: "convergent",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "preference-one",
          value: "running",
          eventKey: "same-activity",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "preference",
          evidenceRef: "preference-two",
          value: "running",
          eventKey: "same-activity",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });

    expect(nodeStatus(output.result, "read_requirement")).toMatchObject({
      status: "partial",
      reason: "minimum_evidence_unsatisfied",
    });
  });

  test("blocks convergence when one independent event contains conflicting claims", () => {
    const output = run({
      query: "What activity do I repeatedly prefer?",
      intent: userIntent("lookup", "any"),
      requirements: [
        requirement("preference", "any", {
          coverageMode: "convergent",
          minimumEvidence: 2,
        }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "event-a-positive",
          value: "running",
          eventKey: "event-a",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "preference",
          evidenceRef: "event-a-conflict",
          value: "swimming",
          eventKey: "event-a",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "preference",
          evidenceRef: "event-b-positive",
          value: "running",
          eventKey: "event-b",
          observedAt: "2024-02-01T00:00:00.000Z",
        },
      ],
    });

    expect(nodeStatus(output.result, "read_requirement")).toMatchObject({
      status: "conflict",
    });
    expect(
      nodeStatus(output.result, "read_requirement")?.conflicts,
    ).toHaveLength(3);
  });

  test("counts one event once even when it has several bound values", () => {
    const output = run({
      query: "How many events happened?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("events", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "events",
          evidenceRef: "one",
          value: "alpha",
          eventKey: "same",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "events",
          evidenceRef: "two",
          value: "beta",
          eventKey: "same",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(
      nodeStatus(output.result, "aggregate_operands")?.values.find(
        (value) => value.kind === "aggregate",
      ),
    ).toMatchObject({
      operator: "count",
      aggregationUnit: "event",
      lowerBoundCount: 1,
      numericValue: 1,
      numericUnit: "count",
    });
  });

  test("sums compatible exact quantities only after closed coverage", () => {
    const output = run({
      query: "What was the total amount I spent?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("expenses", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "expenses",
          evidenceRef: "one",
          value: "$10",
          eventKey: "one",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "expenses",
          evidenceRef: "two",
          value: "$20",
          eventKey: "two",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });
    expect(
      nodeStatus(output.result, "aggregate_operands")?.values.find(
        (value) => value.kind === "aggregate",
      ),
    ).toMatchObject({
      operator: "sum",
      aggregationUnit: "numeric_quantity",
      numericValue: 30,
      numericUnit: "USD",
      closedWorld: true,
    });
  });

  test("keeps equal quantities from distinct observations as separate sum operands", () => {
    const output = run({
      query: "What was the total amount I spent?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("expenses", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "expenses",
          evidenceRef: "first-payment",
          value: "$10",
          eventKey: "first-payment",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "expenses",
          evidenceRef: "second-payment",
          value: "$10",
          eventKey: "second-payment",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });
    expect(
      nodeStatus(output.result, "aggregate_operands")?.values.find(
        (value) => value.kind === "aggregate",
      ),
    ).toMatchObject({
      numericValue: 20,
      numericUnit: "USD",
      materializationExact: true,
    });
  });

  test("sums decimal quantities in exact base ten", () => {
    const output = run({
      query: "What was the total amount I spent?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("expenses", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "expenses",
          evidenceRef: "one-tenth",
          value: "$0.10",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "expenses",
          evidenceRef: "two-tenths",
          value: "$0.20",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });
    expect(
      nodeStatus(output.result, "aggregate_operands")?.values.find(
        (value) => value.kind === "aggregate",
      ),
    ).toMatchObject({
      numericDecimal: "0.3",
      numericUnit: "USD",
      closedWorld: true,
    });
  });

  test("does not coerce an exact large integer sum through JavaScript number", () => {
    const output = run({
      query: "What was the total amount I spent?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("expenses", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "expenses",
          evidenceRef: "large",
          value: "$9007199254740993",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "expenses",
          evidenceRef: "one",
          value: "$1",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
      ],
    });
    const aggregate = nodeStatus(
      output.result,
      "aggregate_operands",
    )?.values.find((value) => value.kind === "aggregate");
    expect(aggregate).toMatchObject({
      numericDecimal: "9007199254740994",
      numericUnit: "USD",
    });
    expect(aggregate).not.toHaveProperty("numericValue");
  });

  test("does not turn an arbitrary number in one entity observation into a count", () => {
    const output = run({
      query: "How many fish do I have?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("fish", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "fish",
          evidenceRef: "tank-note",
          value: "3 fish in 2024",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "aggregate_operands")).toMatchObject({
      status: "unsupported",
      reason: "aggregate_count_basis_unproven",
    });
  });

  test("refuses complete aggregation when a selected evidence ref was not materialized", () => {
    const output = run({
      query: "What was the total amount I spent?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("expenses", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "expenses",
          evidenceRef: "one",
          value: "$10",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "expenses",
          evidenceRef: "two",
          value: "$20",
          observedAt: "2024-01-02T00:00:00.000Z",
        },
        {
          requirementId: "expenses",
          evidenceRef: "selected-but-unbound",
          value: "$30",
          observedAt: "2024-01-03T00:00:00.000Z",
          bind: false,
        },
      ],
    });
    const aggregate = nodeStatus(output.result, "aggregate_operands");
    expect(aggregate).toMatchObject({
      status: "partial",
      reason: "aggregate_materialization_incomplete",
    });
    expect(
      aggregate?.values.find((value) => value.kind === "aggregate"),
    ).toMatchObject({ materializationExact: false, closedWorld: false });
  });

  test("requires the entire observation span to be a typed quantity", () => {
    const output = run({
      query: "What was the total amount?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("amounts", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "amounts",
          evidenceRef: "year-note",
          value: "trip in 2024",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "aggregate_operands")).toMatchObject({
      status: "unsupported",
      reason: "aggregate_quantity_unbound",
    });
  });

  test("does not fabricate a quantity from distant source spans", () => {
    const content = "$ was the currency marker, while the amount later was 10";
    const output = run({
      query: "What was the total amount?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("amounts", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "amounts",
          evidenceRef: "distant-spans",
          value: "$ 10",
          content,
          valueSpans: [
            { start: content.indexOf("$"), end: content.indexOf("$") + 1 },
            { start: content.lastIndexOf("10"), end: content.length },
          ],
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "aggregate_operands")).toMatchObject({
      status: "unsupported",
      reason: "aggregate_quantity_unbound",
    });
  });

  test("accepts a quantity split only by source whitespace", () => {
    const output = run({
      query: "What was the total amount?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("amounts", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "amounts",
          evidenceRef: "adjacent-spans",
          value: "$ 10",
          content: "$ 10",
          valueSpans: [
            { start: 0, end: 1 },
            { start: 2, end: 4 },
          ],
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    const aggregate = nodeStatus(output.result, "aggregate_operands");
    expect(aggregate?.status).toBe("complete");
    expect(
      aggregate?.values.find((value) => value.kind === "aggregate"),
    ).toMatchObject({
      numericValue: 10,
      numericUnit: "USD",
      materializationExact: true,
    });
  });

  test("keeps event counts partial without a trusted event identity", () => {
    const output = run({
      query: "How many events happened?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("events", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "events",
          evidenceRef: "event-note",
          value: "event",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(nodeStatus(output.result, "aggregate_operands")).toMatchObject({
      status: "partial",
      reason: "aggregate_unit_unproven",
    });
  });

  test("keeps incompatible aggregate members out of complete results", () => {
    const output = run({
      query: "What was the total amount?",
      intent: userIntent("aggregate", "any"),
      requirements: [requirement("amounts", "any", { coverageMode: "all" })],
      observations: [
        {
          requirementId: "amounts",
          evidenceRef: "negative",
          value: "$10",
          eventKey: "one",
          observedAt: "2024-01-01T00:00:00.000Z",
          polarity: "negative",
        },
      ],
    });
    expect(nodeStatus(output.result, "aggregate_operands")?.status).not.toBe(
      "complete",
    );
  });

  test("completes explicit preference signals", () => {
    const output = run({
      query: "What do I prefer?",
      intent: userIntent("recommend", "any"),
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "like",
          value: "quiet hotels",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
      ],
    });
    expect(
      nodeStatus(output.result, "compile_personalization_profile")?.status,
    ).toBe("complete");
    expect(output.result.status).toBe("complete");
  });

  test("uses a goal for personalization without calling it a preference", () => {
    const output = run({
      query: "What do I prefer?",
      intent: userIntent("recommend", "any"),
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "goal",
          value: "try hiking",
          observedAt: "2024-01-01T00:00:00.000Z",
          modality: "goal",
        },
      ],
    });
    const personalization = nodeStatus(
      output.result,
      "compile_personalization_profile",
    );
    expect(personalization?.status).toBe("complete");
    expect(
      personalization?.values.find(
        (value) => value.kind === "personalization_profile",
      ),
    ).toMatchObject({
      explicitPositiveValueIds: [],
      explicitNegativeValueIds: [],
      scope: "answer_personalization",
    });
  });

  test("partitions a goal-shaped preference into exactly one reader disposition", () => {
    const output = run({
      query: "What would suit my goal?",
      intent: userIntent("recommend", "any"),
      requirements: [requirement("goal", "any", { relation: "inferred" })],
      observations: [
        {
          requirementId: "goal",
          evidenceRef: "goal",
          value: "quiet places",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
          modality: "goal",
        },
      ],
    });
    const projection = project(output);
    expect(projection.status).toBe("projected");
    if (projection.status !== "projected") throw new Error("projection");
    expect(projection.projection.payload).toMatchObject({
      kind: "personalization",
      constraints: [
        { disposition: "goal", claim: { valueText: "quiet places" } },
      ],
    });
  });

  test("keeps grounded user context as a recommendation constraint", () => {
    const output = run({
      query: "What would suit me?",
      intent: userIntent("recommend", "any"),
      requirements: [
        requirement("personal-context", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "personal-context",
          evidenceRef: "context",
          value: "travelling with a toddler",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    const personalization = nodeStatus(
      output.result,
      "compile_personalization_profile",
    );
    expect(personalization?.status).toBe("complete");
    expect(
      personalization?.values.find(
        (value) => value.kind === "personalization_profile",
      ),
    ).toMatchObject({
      contextualConstraintValueIds: [expect.any(String)],
      explicitPositiveValueIds: [],
    });
  });

  test("completes answer-scoped personalization without claiming closed-world profile coverage", () => {
    const output = run({
      query: "What would suit me?",
      intent: userIntent("recommend", "any"),
      closedWorld: false,
      requirements: [
        requirement("personal-context", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "personal-context",
          evidenceRef: "context",
          value: "travelling with a toddler",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
    });
    const personalization = nodeStatus(
      output.result,
      "compile_personalization_profile",
    );
    expect(personalization?.status).toBe("complete");
    expect(personalization?.reason).toBeUndefined();
    const profile = personalization?.values.find(
      (value) => value.kind === "personalization_profile",
    );
    expect(profile).toMatchObject({
      scope: "answer_personalization",
    });
    const coverageCertificateRevision =
      profile?.kind === "personalization_profile"
        ? profile.coverageCertificateRevision
        : undefined;
    expect(typeof coverageCertificateRevision).toBe("string");
    expect(coverageCertificateRevision).toBe(
      personalization?.completionProofRevisions.at(-1),
    );
  });

  test("keeps incomparable positive and negative preference signals conflicted", () => {
    const output = run({
      query: "What do I prefer?",
      intent: userIntent("recommend", "any"),
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "like",
          value: "crowds",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
        {
          requirementId: "preference",
          evidenceRef: "dislike",
          value: "crowds",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "disprefer",
          polarity: "negative",
        },
      ],
    });
    const personalization = nodeStatus(
      output.result,
      "compile_personalization_profile",
    );
    expect(personalization?.status).toBe("conflict");
    expect(
      personalization?.values.find(
        (value) => value.kind === "personalization_profile",
      ),
    ).not.toHaveProperty("coverageCertificateRevision");
  });

  test("does not count a retracted preference as usable personalization context", () => {
    const output = run({
      query: "What would suit me?",
      intent: userIntent("recommend", "any"),
      closedWorld: false,
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "old-preference",
          value: "crowds",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
        {
          requirementId: "preference",
          evidenceRef: "retraction",
          value: "not into busy places",
          observedAt: "2024-02-01T00:00:00.000Z",
          predicateKind: "retract",
          lifecycleRelation: "retracts",
          lifecycleTargetEvidenceRef: "old-preference",
        },
      ],
    });
    expect(
      nodeStatus(output.result, "compile_personalization_profile"),
    ).toMatchObject({
      status: "partial",
      reason: "personalization_constraint_missing",
    });
  });

  test("keeps inactive lifecycle claims out of a complete reader profile", () => {
    const output = run({
      query: "What would suit me now?",
      intent: userIntent("recommend", "any"),
      closedWorld: false,
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "old-preference",
          value: "crowded places",
          observedAt: "2024-01-01T00:00:00.000Z",
          predicateKind: "prefer",
        },
        {
          requirementId: "preference",
          evidenceRef: "new-context",
          value: "quiet places instead",
          observedAt: "2024-02-01T00:00:00.000Z",
          predicateKind: "update",
          lifecycleRelation: "supersedes",
          lifecycleTargetEvidenceRef: "old-preference",
        },
      ],
    });
    const personalization = nodeStatus(
      output.result,
      "compile_personalization_profile",
    );
    expect(personalization?.status).toBe("complete");
    const profile = personalization?.values.find(
      (value) => value.kind === "personalization_profile",
    );
    expect(profile).toMatchObject({
      oneOffValueIds: [],
      contextualConstraintValueIds: [expect.any(String)],
    });
    expect(
      personalization?.values.filter((value) => value.kind === "observation"),
    ).toHaveLength(1);
    const projection = project(output);
    expect(projection.status).toBe("projected");
    if (projection.status !== "projected") throw new Error("projection");
    expect(projection.projection.payload).toMatchObject({
      kind: "personalization",
      constraints: [
        {
          disposition: "contextual",
          claim: { valueText: "quiet places instead" },
        },
      ],
    });
    expect(JSON.stringify(projection.projection.payload)).not.toContain(
      "crowded places",
    );
    expect(output.result.stateBindingCertificates).toHaveLength(2);
    expect(projection.projection.proof.stateBindingCertificates).toHaveLength(
      1,
    );
  });

  test("keeps personalization partial when a lifecycle target is unbound", () => {
    const output = run({
      query: "What would suit me?",
      intent: userIntent("recommend", "any"),
      closedWorld: false,
      requirements: [
        requirement("preference", "any", { relation: "inferred" }),
      ],
      observations: [
        {
          requirementId: "preference",
          evidenceRef: "retraction",
          value: "not into busy places",
          observedAt: "2024-02-01T00:00:00.000Z",
          predicateKind: "retract",
        },
      ],
    });
    expect(
      nodeStatus(output.result, "compile_personalization_profile"),
    ).toMatchObject({
      status: "partial",
      reason: "retract_target_unbound",
    });
    expect(project(output)).toEqual({
      status: "rejected",
      rejectedReason: "root_incomplete",
    });
  });

  test("blocks the root when a required selector group was not assessed", () => {
    const output = run({
      query: "Compare left and right.",
      intent: userIntent("compare", "any"),
      requirements: [requirement("left"), requirement("right")],
      observations: [
        {
          requirementId: "left",
          evidenceRef: "left-ref",
          value: "10",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          requirementId: "right",
          evidenceRef: "right-ref",
          value: "20",
          observedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      failedRequirementIds: new Set(["right"]),
    });
    expect(output.result.status).not.toBe("complete");
    expect(
      output.result.nodes.some((node) => node.reason === "plan_node_blocked"),
    ).toBe(true);
  });
});
