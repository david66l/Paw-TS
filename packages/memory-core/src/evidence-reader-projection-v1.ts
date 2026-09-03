import { hashCanonicalJsonV1 } from "./canonical.js";
import type {
  MemoryEvidenceExecutionCoverageCertificateV1,
  MemoryEvidenceExecutionCoverageCompilationInputV1,
} from "./evidence-execution-coverage-v1.js";
import {
  type MemoryEvidenceExecutionProgramV1,
  compileMemoryEvidenceExecutionProgramV1,
} from "./evidence-execution-program-v1.js";
import {
  type MemoryEvidenceDurationEndpointBindingCertificateV1,
  type MemoryEvidenceExecutionAggregateValueV1,
  type MemoryEvidenceExecutionDurationValueV1,
  type MemoryEvidenceExecutionNodeResultV1,
  type MemoryEvidenceExecutionObservationValueV1,
  type MemoryEvidenceExecutionPersonalizationValueV1,
  type MemoryEvidenceExecutionResultV1,
  type MemoryEvidenceExecutionValueV1,
  type MemoryEvidencePersonalizationCoverageCertificateV1,
  executeMemoryEvidenceProgramV1,
} from "./evidence-execution-runtime-v1.js";
import { compileMemoryQueryAnswerOriginV1 } from "./query-answer-origin.js";
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./query-plan-contracts.js";
import type { MemorySelectorExecutionSnapshotV1 } from "./selector-execution-snapshot-v1.js";
import type {
  MemoryStateBindingCertificateV1,
  MemoryStateBindingCertificateValidationInputV1,
  MemoryStateValidatedObservationV1,
} from "./state-binding-certificate-v1.js";
import {
  type MemoryResolvedStateFrameV2,
  type MemoryStateEventTimeIntervalV2,
  type MemoryStateSlotSpecV2,
  type MemoryStateSourceLockV2,
  compileMemoryStateSlotsV2,
  compileMemoryStateSourceLockV2,
  resolveMemoryStateFrameV2,
} from "./state-frame-v2.js";

export const PAW_MEMORY_EVIDENCE_READER_PROJECTION_POLICY_V1 =
  "paw.memory-evidence-reader-projection.v1:root-reachable-certified-only" as const;

export type MemoryEvidenceReaderProjectionRejectedReasonV1 =
  | "invalid_input"
  | "program_mismatch"
  | "selector_uncommitted"
  | "source_lock_mismatch"
  | "frame_mismatch"
  | "execution_mismatch"
  | "root_incomplete"
  | "reachable_node_incomplete"
  | "dangling_value"
  | "certificate_scope_invalid"
  | "profile_unsafe"
  | "unsupported_answer_operation";

export interface MemoryEvidenceReaderProjectedClaimV1 {
  readonly valueId: string;
  readonly valueText: string;
  readonly supportSpan: MemoryStateBindingCertificateV1["claimBinding"]["supportSpan"];
  readonly valueSpans: MemoryStateBindingCertificateV1["claimBinding"]["value"]["exactSpans"];
  readonly predicateKind: MemoryEvidenceExecutionObservationValueV1["predicateKind"];
  readonly polarity: MemoryEvidenceExecutionObservationValueV1["polarity"];
  readonly modality: MemoryEvidenceExecutionObservationValueV1["modality"];
  readonly role: "user" | "assistant";
  readonly authority: MemoryStateBindingCertificateV1["evidenceBinding"]["authority"];
  readonly eventTimeBasis: MemoryEvidenceExecutionObservationValueV1["eventTimeBasis"];
  readonly eventTimeInterval?: MemoryStateEventTimeIntervalV2;
  readonly stateBindingCertificateId: string;
}

export type MemoryEvidenceReaderProjectionPayloadV1 =
  | Readonly<{
      kind: "temporal_duration";
      precision: "exact";
      unit: MemoryEvidenceExecutionDurationValueV1["unit"];
      value: number;
      endpointPolicy: MemoryEvidenceExecutionDurationValueV1["endpointPolicy"];
      queryAnchor?: string;
      endpoints: readonly MemoryEvidenceReaderProjectedClaimV1[];
      endpointCertificateRevision: string;
    }>
  | Readonly<{
      kind: "aggregate";
      operator: MemoryEvidenceExecutionAggregateValueV1["operator"];
      aggregationUnit: MemoryEvidenceExecutionAggregateValueV1["aggregationUnit"];
      countBasis: MemoryEvidenceExecutionAggregateValueV1["countBasis"];
      numericValue?: number;
      numericDecimal?: string;
      numericUnit?: string;
      members: readonly MemoryEvidenceReaderProjectedClaimV1[];
    }>
  | Readonly<{
      kind: "personalization";
      constraints: readonly Readonly<{
        disposition:
          | "explicit_positive"
          | "explicit_negative"
          | "goal"
          | "contextual";
        claim: MemoryEvidenceReaderProjectedClaimV1;
      }>[];
      coverageCertificateRevision: string;
    }>
  | Readonly<{
      kind: "evidence_groups";
      operation: MemoryEvidenceExecutionNodeResultV1["operation"];
      groups: readonly Readonly<{
        groupKey: string;
        operandNodeId: string;
        requirementId: string;
        slotId: string;
        necessity: "required" | "contextual";
        temporalBindingRevision: string;
        values: readonly MemoryEvidenceReaderProjectedClaimV1[];
      }>[];
      comparison?: Readonly<{
        relation?: "equal" | "different";
        sides: readonly Readonly<{
          operandRole: "left" | "right" | "criterion";
          operandNodeId: string;
          groupKeys: readonly string[];
        }>[];
      }>;
    }>;

export interface MemoryEvidenceReaderProjectionV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_READER_PROJECTION_POLICY_V1;
  readonly programRevision: string;
  readonly executionRevision: string;
  readonly stateBindingCertificateRegistryRevision: string;
  readonly rootNodeResultRevision: string;
  readonly answerNodeResultRevision: string;
  readonly stateBindingCertificateIds: readonly string[];
  readonly payload: MemoryEvidenceReaderProjectionPayloadV1;
  readonly proof: Readonly<{
    readonly stateBindingCertificates: readonly MemoryStateBindingCertificateV1[];
    readonly durationEndpointCertificate?: MemoryEvidenceDurationEndpointBindingCertificateV1;
    readonly personalizationCoverageCertificate?: MemoryEvidencePersonalizationCoverageCertificateV1;
    readonly executionCoverageCertificate?: MemoryEvidenceExecutionCoverageCertificateV1;
  }>;
  readonly packetRevision: string;
}

export type MemoryEvidenceReaderProjectionBuildResultV1 =
  | Readonly<{
      status: "projected";
      projection: MemoryEvidenceReaderProjectionV1;
    }>
  | Readonly<{
      status: "rejected";
      rejectedReason: MemoryEvidenceReaderProjectionRejectedReasonV1;
    }>;

export interface MemoryEvidenceReaderProjectionInputV1 {
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly selectorSnapshot: MemorySelectorExecutionSnapshotV1;
  readonly lockedSourceIds: readonly string[];
  readonly sourceLock: MemoryStateSourceLockV2;
  readonly program: MemoryEvidenceExecutionProgramV1;
  readonly slots: readonly MemoryStateSlotSpecV2[];
  readonly frame: MemoryResolvedStateFrameV2;
  readonly validatedObservations: readonly MemoryStateValidatedObservationV1[];
  readonly bindingCertificateValidationContexts: readonly MemoryStateBindingCertificateValidationInputV1[];
  readonly coverageCertificate?: MemoryEvidenceExecutionCoverageCertificateV1;
  readonly coverageValidationContext?: MemoryEvidenceExecutionCoverageCompilationInputV1;
  readonly executionResult: MemoryEvidenceExecutionResultV1;
}

/**
 * Rebuilds every host-owned identity before producing a bounded reader packet.
 * A rejection is atomic: no partial projection is returned.
 */
export function buildMemoryEvidenceReaderProjectionV1(
  input: MemoryEvidenceReaderProjectionInputV1,
): MemoryEvidenceReaderProjectionBuildResultV1 {
  try {
    return Object.freeze({
      status: "projected" as const,
      projection: buildProjection(input),
    });
  } catch (error) {
    return Object.freeze({
      status: "rejected" as const,
      rejectedReason: rejectionReason(error),
    });
  }
}

function buildProjection(
  input: MemoryEvidenceReaderProjectionInputV1,
): MemoryEvidenceReaderProjectionV1 {
  validateSourceAndSelector(input);
  const expectedProgram = compileMemoryEvidenceExecutionProgramV1({
    query: input.query,
    intent: input.intent,
    requirements: input.requirements,
    temporalConstraints: input.temporalConstraints,
    selectorSnapshot: input.selectorSnapshot,
  });
  if (!same(expectedProgram, input.program)) reject("program_mismatch");
  const origin = compileMemoryQueryAnswerOriginV1(input.query);
  const executionByRequirement = new Map(
    input.selectorSnapshot.groups.flatMap((group) =>
      group.requirements.map(
        (requirement) => [requirement.requirementId, requirement] as const,
      ),
    ),
  );
  const slotRequirements = input.requirements
    .map((requirement) => {
      const execution = executionByRequirement.get(requirement.requirementId);
      return requirement.roleConstraint === "any" && execution?.resolvedRole
        ? Object.freeze({
            ...requirement,
            roleConstraint: execution.resolvedRole,
          })
        : requirement;
    })
    .filter((requirement) => requirement.roleConstraint !== "any");
  const expectedSlots =
    slotRequirements.length === 0
      ? Object.freeze([])
      : compileMemoryStateSlotsV2({
          query: input.query,
          intent: input.intent,
          requirements: slotRequirements,
          origin,
          temporalConstraints: new Map(
            input.requirements.map((requirement, index) => [
              requirement.requirementId,
              input.temporalConstraints[
                index
              ] as MemoryEvidenceBoundTemporalConstraintV1,
            ]),
          ),
        });
  if (!same(expectedSlots, input.slots)) reject("program_mismatch");
  const expectedFrame = resolveMemoryStateFrameV2({
    slots: input.slots,
    observations: input.validatedObservations.map((item) => item.observation),
    sourceLock: input.sourceLock,
  });
  if (!same(expectedFrame, input.frame)) reject("frame_mismatch");
  const expectedExecution = executeMemoryEvidenceProgramV1({
    program: input.program,
    slots: input.slots,
    frame: input.frame,
    validatedObservations: input.validatedObservations,
    bindingCertificateValidationContexts:
      input.bindingCertificateValidationContexts,
    ...(input.coverageCertificate === undefined
      ? {}
      : {
          coverageCertificate: input.coverageCertificate,
          coverageValidationContext: input.coverageValidationContext,
        }),
  });
  if (!same(expectedExecution, input.executionResult)) {
    reject("execution_mismatch");
  }
  if (expectedExecution.status !== "complete") reject("root_incomplete");
  const nodeById = new Map(
    input.program.nodes.map((node) => [node.nodeId, node]),
  );
  const resultById = new Map(
    expectedExecution.nodes.map((node) => [node.nodeId, node]),
  );
  const reachableNodeIds = collectReachableNodeIds(
    input.program.rootNodeId,
    nodeById,
  );
  for (const nodeId of reachableNodeIds) {
    const node = nodeById.get(nodeId);
    const result = resultById.get(nodeId);
    if (!node || !result) reject("dangling_value");
    if (result.status !== "complete") reject("reachable_node_incomplete");
    if (node.operation === "read_requirement") {
      validateReachableReadNode(node, input.selectorSnapshot, input.sourceLock);
    }
  }
  const rootResult = resultById.get(input.program.rootNodeId);
  const answerResult = resultById.get(input.program.answerNodeId);
  if (!rootResult || !answerResult || answerResult.status !== "complete") {
    reject("root_incomplete");
  }
  const valueById = validateValueGraph(expectedExecution.nodes);
  const reachableValueIds = new Set(
    [...reachableNodeIds].flatMap(
      (nodeId) =>
        resultById.get(nodeId)?.values.map((value) => value.valueId) ?? [],
    ),
  );
  const reachableValueById = new Map(
    [...valueById].filter(([valueId]) => reachableValueIds.has(valueId)),
  );
  const certificateById = new Map(
    expectedExecution.stateBindingCertificates.map((certificate) => [
      certificate.certificateId,
      certificate,
    ]),
  );
  const payload = projectAnswer(
    answerResult,
    reachableValueById,
    certificateById,
    input.program,
    resultById,
  );
  const stateBindingCertificateIds = Object.freeze(
    [...collectPayloadCertificateIds(payload)].sort(),
  );
  if (
    stateBindingCertificateIds.some(
      (certificateId) => !certificateById.has(certificateId),
    )
  ) {
    reject("certificate_scope_invalid");
  }
  const stateBindingCertificates = Object.freeze(
    stateBindingCertificateIds.map((certificateId) => {
      const certificate = certificateById.get(certificateId);
      if (!certificate) reject("certificate_scope_invalid");
      return certificate;
    }),
  );
  const durationValue = answerResult.values.find(
    (value): value is MemoryEvidenceExecutionDurationValueV1 =>
      value.kind === "temporal_duration",
  );
  const personalizationValue = answerResult.values.find(
    (value): value is MemoryEvidenceExecutionPersonalizationValueV1 =>
      value.kind === "personalization_profile",
  );
  const proof = Object.freeze({
    stateBindingCertificates,
    ...(payload.kind !== "temporal_duration" || durationValue === undefined
      ? {}
      : { durationEndpointCertificate: durationValue.endpointCertificate }),
    ...(payload.kind !== "personalization" ||
    personalizationValue?.coverageCertificate === undefined
      ? {}
      : {
          personalizationCoverageCertificate:
            personalizationValue.coverageCertificate,
        }),
    ...(input.coverageCertificate === undefined
      ? {}
      : { executionCoverageCertificate: input.coverageCertificate }),
  });
  const identity = {
    policyVersion: PAW_MEMORY_EVIDENCE_READER_PROJECTION_POLICY_V1,
    programRevision: input.program.programRevision,
    executionRevision: expectedExecution.executionRevision,
    stateBindingCertificateRegistryRevision:
      expectedExecution.stateBindingCertificateRegistryRevision,
    rootNodeResultRevision: rootResult.resultRevision,
    answerNodeResultRevision: answerResult.resultRevision,
    stateBindingCertificateIds,
    payload,
    proof,
  };
  return Object.freeze({
    ...identity,
    packetRevision: hashCanonicalJsonV1(identity as never),
  });
}

function validateSourceAndSelector(
  input: MemoryEvidenceReaderProjectionInputV1,
): void {
  if (
    !input.query.trim() ||
    input.requirements.length < 1 ||
    input.requirements.length > 4 ||
    input.requirements.length !== input.temporalConstraints.length ||
    new Set(input.lockedSourceIds).size !== input.lockedSourceIds.length
  ) {
    reject("invalid_input");
  }
  const { snapshotRevision, ...snapshotIdentity } = input.selectorSnapshot;
  if (
    hashCanonicalJsonV1(snapshotIdentity as never) !== snapshotRevision ||
    input.program.selectorSnapshotRevision !== snapshotRevision ||
    input.program.originRevision !== input.selectorSnapshot.originRevision ||
    input.program.lockedSourceRevision !==
      input.selectorSnapshot.lockedSourceRevision ||
    input.selectorSnapshot.lockedSourceRevision !==
      hashCanonicalJsonV1({
        schemaVersion: "paw.memory-locked-source-set.v1",
        lockedSourceIds: Object.freeze([...input.lockedSourceIds]),
      } as never)
  ) {
    reject("program_mismatch");
  }
  const expectedLock = compileMemoryStateSourceLockV2(input.sourceLock.items);
  const lockedSourceIds = new Set(input.lockedSourceIds);
  if (
    !same(expectedLock, input.sourceLock) ||
    input.sourceLock.items.some(
      (item) => !lockedSourceIds.has(item.sourceId),
    ) ||
    input.bindingCertificateValidationContexts.some(
      (context) =>
        context.query !== input.query ||
        !same(context.sourceLock, input.sourceLock),
    )
  ) {
    reject("source_lock_mismatch");
  }
}

function validateReachableReadNode(
  node: MemoryEvidenceExecutionProgramV1["nodes"][number],
  selectorSnapshot: MemorySelectorExecutionSnapshotV1,
  sourceLock: MemoryStateSourceLockV2,
): void {
  const group = selectorSnapshot.groups.find(
    (candidate) => candidate.groupId === node.groupId,
  );
  const requirement = group?.requirements.find(
    (candidate) => candidate.requirementId === node.requirementId,
  );
  if (
    !group ||
    group.status !== "committed" ||
    !requirement ||
    requirement.status !== "assessed"
  ) {
    reject("selector_uncommitted");
  }
  const itemByRef = new Map(
    sourceLock.items.map((item) => [item.evidenceRef, item]),
  );
  for (const evidenceRef of node.supportingEvidenceRefs ?? []) {
    const item = itemByRef.get(evidenceRef);
    if (!item) reject("source_lock_mismatch");
    if (
      node.resolvedRole === "assistant" &&
      (item.role !== "assistant" || !item.certificateRevision?.trim())
    ) {
      reject("certificate_scope_invalid");
    }
  }
}

function projectAnswer(
  answer: MemoryEvidenceExecutionNodeResultV1,
  valueById: ReadonlyMap<string, MemoryEvidenceExecutionValueV1>,
  certificateById: ReadonlyMap<string, MemoryStateBindingCertificateV1>,
  program: MemoryEvidenceExecutionProgramV1,
  resultById: ReadonlyMap<string, MemoryEvidenceExecutionNodeResultV1>,
): MemoryEvidenceReaderProjectionPayloadV1 {
  if (answer.operation === "measure_duration") {
    const durations = answer.values.filter(
      (value): value is MemoryEvidenceExecutionDurationValueV1 =>
        value.kind === "temporal_duration",
    );
    const duration = durations[0];
    if (
      durations.length !== 1 ||
      !duration ||
      duration.precision !== "exact" ||
      duration.value === undefined ||
      !Number.isFinite(duration.value)
    ) {
      reject("dangling_value");
    }
    const { certificateRevision, ...certificateIdentity } =
      duration.endpointCertificate;
    if (
      hashCanonicalJsonV1(certificateIdentity as never) !==
        certificateRevision ||
      certificateRevision !== duration.endpointCertificateRevision
    ) {
      reject("certificate_scope_invalid");
    }
    const endpoints = duration.endpointValueIds.map((valueId) =>
      projectedClaim(valueById.get(valueId), certificateById),
    );
    return Object.freeze({
      kind: "temporal_duration" as const,
      precision: "exact" as const,
      unit: duration.unit,
      value: duration.value,
      endpointPolicy: duration.endpointPolicy,
      ...(duration.queryAnchor === undefined
        ? {}
        : { queryAnchor: duration.queryAnchor }),
      endpoints: Object.freeze(endpoints),
      endpointCertificateRevision: certificateRevision,
    });
  }
  if (answer.operation === "aggregate_operands") {
    const aggregates = answer.values.filter(
      (value): value is MemoryEvidenceExecutionAggregateValueV1 =>
        value.kind === "aggregate",
    );
    const aggregate = aggregates[0];
    if (
      aggregates.length !== 1 ||
      !aggregate ||
      !aggregate.closedWorld ||
      !aggregate.materializationExact ||
      (aggregate.operator !== "collect_unique" &&
        aggregate.numericDecimal === undefined &&
        aggregate.numericValue === undefined)
    ) {
      reject("dangling_value");
    }
    return Object.freeze({
      kind: "aggregate" as const,
      operator: aggregate.operator,
      aggregationUnit: aggregate.aggregationUnit,
      countBasis: aggregate.countBasis,
      ...(aggregate.numericValue === undefined
        ? {}
        : { numericValue: aggregate.numericValue }),
      ...(aggregate.numericDecimal === undefined
        ? {}
        : { numericDecimal: aggregate.numericDecimal }),
      ...(aggregate.numericUnit === undefined
        ? {}
        : { numericUnit: aggregate.numericUnit }),
      members: Object.freeze(
        aggregate.memberValueIds.map((valueId) =>
          projectedClaim(valueById.get(valueId), certificateById),
        ),
      ),
    });
  }
  if (answer.operation === "compile_personalization_profile") {
    return projectPersonalization(answer, valueById, certificateById);
  }
  return projectEvidenceGroups(
    answer,
    valueById,
    certificateById,
    program,
    resultById,
  );
}

function projectPersonalization(
  answer: MemoryEvidenceExecutionNodeResultV1,
  valueById: ReadonlyMap<string, MemoryEvidenceExecutionValueV1>,
  certificateById: ReadonlyMap<string, MemoryStateBindingCertificateV1>,
): MemoryEvidenceReaderProjectionPayloadV1 {
  const profiles = answer.values.filter(
    (value): value is MemoryEvidenceExecutionPersonalizationValueV1 =>
      value.kind === "personalization_profile",
  );
  const profile = profiles[0];
  if (
    profiles.length !== 1 ||
    !profile ||
    profile.oneOffValueIds.length !== 0 ||
    !profile.coverageCertificate ||
    !profile.coverageCertificateRevision
  ) {
    reject("profile_unsafe");
  }
  const { certificateRevision, ...coverageIdentity } =
    profile.coverageCertificate;
  if (
    hashCanonicalJsonV1(coverageIdentity as never) !== certificateRevision ||
    certificateRevision !== profile.coverageCertificateRevision ||
    profile.coverageCertificate.claims.some(
      (claim) =>
        claim.disposition === "excluded_inactive" &&
        answer.values.some((value) => value.valueId === claim.valueId),
    )
  ) {
    reject("profile_unsafe");
  }
  const profilePartitions = new Map<
    "explicit_positive" | "explicit_negative" | "goal" | "contextual",
    readonly string[]
  >([
    ["explicit_positive", profile.explicitPositiveValueIds],
    ["explicit_negative", profile.explicitNegativeValueIds],
    ["goal", profile.goalValueIds],
    ["contextual", profile.contextualConstraintValueIds],
  ]);
  const flattenedProfileIds = [...profilePartitions.values()].flat();
  const usableCoverageClaims = profile.coverageCertificate.claims.filter(
    (claim) => claim.disposition !== "excluded_inactive",
  );
  if (
    new Set(flattenedProfileIds).size !== flattenedProfileIds.length ||
    new Set(usableCoverageClaims.map((claim) => claim.valueId)).size !==
      usableCoverageClaims.length ||
    flattenedProfileIds.length !== usableCoverageClaims.length ||
    usableCoverageClaims.some(
      (claim) =>
        claim.disposition === "excluded_inactive" ||
        !profilePartitions.get(claim.disposition)?.includes(claim.valueId),
    )
  ) {
    reject("profile_unsafe");
  }
  const constraints = [...usableCoverageClaims]
    .sort((left, right) => left.valueId.localeCompare(right.valueId))
    .map((coverageClaim) => {
      if (coverageClaim.disposition === "excluded_inactive") {
        reject("profile_unsafe");
      }
      return {
        disposition: coverageClaim.disposition,
        claim: projectedClaim(
          valueById.get(coverageClaim.valueId),
          certificateById,
        ),
      };
    });
  const projectedIds = new Set(constraints.map((item) => item.claim.valueId));
  const answerObservationIds = answer.values.flatMap((value) =>
    value.kind === "observation" ? [value.valueId] : [],
  );
  if (
    constraints.length < 1 ||
    projectedIds.size !== answerObservationIds.length ||
    answerObservationIds.some((valueId) => !projectedIds.has(valueId))
  ) {
    reject("profile_unsafe");
  }
  return Object.freeze({
    kind: "personalization" as const,
    constraints: Object.freeze(constraints),
    coverageCertificateRevision: certificateRevision,
  });
}

function projectEvidenceGroups(
  answer: MemoryEvidenceExecutionNodeResultV1,
  valueById: ReadonlyMap<string, MemoryEvidenceExecutionValueV1>,
  certificateById: ReadonlyMap<string, MemoryStateBindingCertificateV1>,
  program: MemoryEvidenceExecutionProgramV1,
  resultById: ReadonlyMap<string, MemoryEvidenceExecutionNodeResultV1>,
): MemoryEvidenceReaderProjectionPayloadV1 {
  const allowed = new Set<MemoryEvidenceExecutionNodeResultV1["operation"]>([
    "read_requirement",
    "resolve_latest",
    "resolve_as_of",
    "preserve_history",
    "restrict_range",
    "dependency_join",
    "collect_operands",
    "compare_operands",
  ]);
  if (!allowed.has(answer.operation)) reject("unsupported_answer_operation");
  const programAnswer = program.nodes.find(
    (node) => node.nodeId === program.answerNodeId,
  );
  if (!programAnswer || programAnswer.operation !== answer.operation) {
    reject("program_mismatch");
  }
  const operandNodeIds =
    programAnswer.operandNodeIds.length > 0
      ? programAnswer.operandNodeIds
      : [programAnswer.nodeId];
  const readNodeByRequirement = new Map(
    program.nodes.flatMap((node) =>
      node.operation === "read_requirement" && node.requirementId
        ? [[node.requirementId, node] as const]
        : [],
    ),
  );
  const groups: Array<{
    groupKey: string;
    operandNodeId: string;
    requirementId: string;
    slotId: string;
    necessity: "required" | "contextual";
    temporalBindingRevision: string;
    values: readonly MemoryEvidenceReaderProjectedClaimV1[];
  }> = [];
  const membership = new Set<string>();
  for (const operandNodeId of operandNodeIds) {
    const operand = resultById.get(operandNodeId);
    if (!operand || operand.status !== "complete") {
      reject("reachable_node_incomplete");
    }
    const observations = operand.values.filter(
      (value): value is MemoryEvidenceExecutionObservationValueV1 =>
        value.kind === "observation",
    );
    const byRequirement = new Map<
      string,
      MemoryEvidenceExecutionObservationValueV1[]
    >();
    for (const observation of observations) {
      const values = byRequirement.get(observation.requirementId) ?? [];
      values.push(observation);
      byRequirement.set(observation.requirementId, values);
    }
    for (const [requirementId, values] of [...byRequirement].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const readNode = readNodeByRequirement.get(requirementId);
      const slotIds = new Set(values.map((value) => value.slotId));
      if (
        !readNode ||
        !readNode.temporalBindingRevision ||
        !readNode.necessity ||
        slotIds.size !== 1
      ) {
        reject("dangling_value");
      }
      const projectedValues = Object.freeze(
        [...values]
          .sort((left, right) => left.valueId.localeCompare(right.valueId))
          .map((value) => {
            if (membership.has(value.valueId)) reject("dangling_value");
            membership.add(value.valueId);
            return projectedClaim(
              valueById.get(value.valueId),
              certificateById,
            );
          }),
      );
      const slotId = values[0]?.slotId;
      if (!slotId) reject("dangling_value");
      const groupIdentity = {
        operandNodeId,
        requirementId,
        slotId,
        necessity: readNode.necessity,
        temporalBindingRevision: readNode.temporalBindingRevision,
      };
      groups.push({
        groupKey: hashCanonicalJsonV1(groupIdentity as never),
        ...groupIdentity,
        values: projectedValues,
      });
    }
  }
  const answerObservationIds = answer.values.flatMap((value) =>
    value.kind === "observation" ? [value.valueId] : [],
  );
  if (
    groups.length < 1 ||
    membership.size !== answerObservationIds.length ||
    answerObservationIds.some((valueId) => !membership.has(valueId))
  ) {
    reject("dangling_value");
  }
  const comparisons = answer.values.filter(
    (value) => value.kind === "comparison",
  );
  if (
    (answer.operation === "compare_operands" && comparisons.length !== 1) ||
    (answer.operation !== "compare_operands" && comparisons.length !== 0)
  ) {
    reject("dangling_value");
  }
  const comparison = comparisons[0];
  const sides =
    answer.operation !== "compare_operands" || comparison?.kind !== "comparison"
      ? undefined
      : Object.freeze(
          operandNodeIds.map((operandNodeId, index) => {
            const operandRole =
              index === 0
                ? ("left" as const)
                : index === 1
                  ? ("right" as const)
                  : ("criterion" as const);
            const comparisonSide = comparison.sides.find(
              (side) => side.operandRole === operandRole,
            );
            const operand = resultById.get(operandNodeId);
            if (
              !comparisonSide ||
              !operand ||
              !same(
                comparisonSide.valueIds,
                operand.values.map((value) => value.valueId),
              )
            ) {
              reject("dangling_value");
            }
            return Object.freeze({
              operandRole,
              operandNodeId,
              groupKeys: Object.freeze(
                groups
                  .filter((group) => group.operandNodeId === operandNodeId)
                  .map((group) => group.groupKey),
              ),
            });
          }),
        );
  return Object.freeze({
    kind: "evidence_groups" as const,
    operation: answer.operation,
    groups: Object.freeze(groups),
    ...(sides === undefined
      ? {}
      : {
          comparison: Object.freeze({
            ...(comparison?.kind !== "comparison" ||
            comparison.relation === undefined
              ? {}
              : { relation: comparison.relation }),
            sides,
          }),
        }),
  });
}

function projectedClaim(
  value: MemoryEvidenceExecutionValueV1 | undefined,
  certificateById: ReadonlyMap<string, MemoryStateBindingCertificateV1>,
): MemoryEvidenceReaderProjectedClaimV1 {
  if (!value || value.kind !== "observation") reject("dangling_value");
  const certificate = certificateById.get(value.stateBindingCertificateId);
  if (
    !certificate ||
    certificate.observationId.trim().length === 0 ||
    certificate.bindingRevision !== value.bindingRevision ||
    certificate.evidenceBinding.evidenceRef !== value.evidenceRef ||
    certificate.evidenceBinding.sourceId !== value.sourceId ||
    certificate.claimBinding.value.surfaceDigest.trim().length === 0
  ) {
    reject("certificate_scope_invalid");
  }
  return Object.freeze({
    valueId: value.valueId,
    valueText: value.valueText,
    supportSpan: certificate.claimBinding.supportSpan,
    valueSpans: certificate.claimBinding.value.exactSpans,
    predicateKind: value.predicateKind,
    polarity: value.polarity,
    modality: value.modality,
    role: certificate.evidenceBinding.role,
    authority: certificate.evidenceBinding.authority,
    eventTimeBasis: value.eventTimeBasis,
    ...(value.eventTimeInterval === undefined
      ? {}
      : { eventTimeInterval: value.eventTimeInterval }),
    stateBindingCertificateId: certificate.certificateId,
  });
}

function validateValueGraph(
  nodes: readonly MemoryEvidenceExecutionNodeResultV1[],
): ReadonlyMap<string, MemoryEvidenceExecutionValueV1> {
  const valueById = new Map<string, MemoryEvidenceExecutionValueV1>();
  for (const value of nodes.flatMap((node) => node.values)) {
    const existing = valueById.get(value.valueId);
    if (existing && !same(existing, value)) reject("dangling_value");
    valueById.set(value.valueId, value);
  }
  for (const value of valueById.values()) {
    const refs = referencedValueIds(value);
    if (refs.some((valueId) => !valueById.has(valueId))) {
      reject("dangling_value");
    }
  }
  return valueById;
}

function referencedValueIds(
  value: MemoryEvidenceExecutionValueV1,
): readonly string[] {
  switch (value.kind) {
    case "observation":
    case "render_contract":
      return [];
    case "collection":
    case "dependency_record":
      return value.memberValueIds;
    case "comparison":
      return value.sides.flatMap((side) => side.valueIds);
    case "aggregate":
      return value.memberValueIds;
    case "temporal_duration":
      return value.endpointValueIds;
    case "preference_profile":
      return [
        ...value.positiveValueIds,
        ...value.negativeValueIds,
        ...value.goalValueIds,
        ...value.oneOffValueIds,
      ];
    case "personalization_profile":
      return [
        ...value.explicitPositiveValueIds,
        ...value.explicitNegativeValueIds,
        ...value.goalValueIds,
        ...value.contextualConstraintValueIds,
        ...value.oneOffValueIds,
      ];
    default:
      reject("dangling_value");
  }
}

function collectReachableNodeIds(
  rootNodeId: string,
  nodeById: ReadonlyMap<
    string,
    MemoryEvidenceExecutionProgramV1["nodes"][number]
  >,
): ReadonlySet<string> {
  const reachable = new Set<string>();
  const visit = (nodeId: string) => {
    if (reachable.has(nodeId)) return;
    const node = nodeById.get(nodeId);
    if (!node) reject("dangling_value");
    reachable.add(nodeId);
    for (const operandNodeId of node.operandNodeIds) visit(operandNodeId);
  };
  visit(rootNodeId);
  return reachable;
}

function collectPayloadCertificateIds(
  payload: MemoryEvidenceReaderProjectionPayloadV1,
): ReadonlySet<string> {
  const claims =
    payload.kind === "temporal_duration"
      ? payload.endpoints
      : payload.kind === "aggregate"
        ? payload.members
        : payload.kind === "personalization"
          ? payload.constraints.map((item) => item.claim)
          : payload.groups.flatMap((group) => group.values);
  return new Set(claims.map((claim) => claim.stateBindingCertificateId));
}

function same(left: unknown, right: unknown): boolean {
  return (
    hashCanonicalJsonV1(left as never) === hashCanonicalJsonV1(right as never)
  );
}

function reject(reason: MemoryEvidenceReaderProjectionRejectedReasonV1): never {
  const error = new Error(reason);
  error.name = "MemoryEvidenceReaderProjectionRejected";
  throw error;
}

function rejectionReason(
  error: unknown,
): MemoryEvidenceReaderProjectionRejectedReasonV1 {
  if (
    error instanceof Error &&
    error.name === "MemoryEvidenceReaderProjectionRejected" &&
    new Set<MemoryEvidenceReaderProjectionRejectedReasonV1>([
      "invalid_input",
      "program_mismatch",
      "selector_uncommitted",
      "source_lock_mismatch",
      "frame_mismatch",
      "execution_mismatch",
      "root_incomplete",
      "reachable_node_incomplete",
      "dangling_value",
      "certificate_scope_invalid",
      "profile_unsafe",
      "unsupported_answer_operation",
    ]).has(error.message as MemoryEvidenceReaderProjectionRejectedReasonV1)
  ) {
    return error.message as MemoryEvidenceReaderProjectionRejectedReasonV1;
  }
  return "invalid_input";
}
