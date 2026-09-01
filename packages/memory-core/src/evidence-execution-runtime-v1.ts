import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type MemoryEvidenceExecutionCoverageCertificateV1,
  type MemoryEvidenceExecutionRequirementCoverageV1,
  validateMemoryEvidenceExecutionCoverageCertificateV1,
} from "./evidence-execution-coverage-v1.js";
import type {
  MemoryEvidenceExecutionNodeV1,
  MemoryEvidenceExecutionProgramV1,
} from "./evidence-execution-program-v1.js";
import { validateMemoryEvidenceExecutionProgramV1 } from "./evidence-execution-program-v1.js";
import { compileMemoryQueryAnswerOriginV1 } from "./query-answer-origin.js";
import type {
  MemoryResolvedStateFrameV2,
  MemoryStateBoundObservationV2,
  MemoryStateEventTimeIntervalV2,
  MemoryStateSlotSpecV2,
} from "./state-frame-v2.js";
import type {
  MemoryStateBindingCertificateValidationInputV1,
  MemoryStateBindingCertificateV1,
  MemoryStateValidatedObservationV1,
} from "./state-binding-certificate-v1.js";
import { validateMemoryStateBindingCertificateV1 } from "./state-binding-certificate-v1.js";

export const PAW_MEMORY_EVIDENCE_EXECUTION_RUNTIME_VERSION_V1 =
  "paw.memory-evidence-execution-runtime.v1:proof-carrying-fail-closed" as const;

export type MemoryEvidenceExecutionNodeResultStatusV1 =
  "complete" | "partial" | "missing" | "conflict" | "unsupported";

export type MemoryEvidenceExecutionResultReasonV1 =
  | "plan_node_blocked"
  | "state_slot_missing"
  | "minimum_evidence_unsatisfied"
  | "mixed_clock"
  | "clock_incomplete"
  | "temporal_interval_straddles_cutoff"
  | "temporal_anchor_unbound"
  | "temporal_window_empty"
  | "duration_endpoint_ambiguous"
  | "duration_precision_insufficient"
  | "duration_end_before_start"
  | "closed_world_unproven"
  | "operand_incomplete"
  | "aggregate_event_conflict"
  | "aggregate_materialization_incomplete"
  | "aggregate_member_unsupported"
  | "aggregate_unit_unproven"
  | "aggregate_count_basis_unproven"
  | "aggregate_quantity_unbound"
  | "aggregate_operand_roles_unbound"
  | "opaque_aggregate_unsupported"
  | "preference_signal_missing"
  | "preference_signal_conflict"
  | "personalization_contract_missing"
  | "personalization_constraint_missing"
  | "retract_target_unbound";

export interface MemoryEvidenceExecutionObservationValueV1 {
  readonly kind: "observation";
  readonly valueId: string;
  /** Requirement-independent identity of the exact bound source claim. */
  readonly claimIdentity: string;
  /** Requirement-independent identity of the event-time endpoint. */
  readonly eventIdentity?: string;
  readonly eventIdentityBasis?: "stable_event_key" | "typed_role_interval";
  readonly eventTimeBasis: MemoryStateBoundObservationV2["eventTimeBasis"];
  readonly durationEndpointRole: MemoryStateBoundObservationV2["durationEndpointRole"];
  readonly lifecycleRelation: MemoryStateBoundObservationV2["lifecycleRelation"];
  readonly lifecycleTargetEvidenceRef?: string;
  readonly requirementId: string;
  readonly slotId: string;
  readonly valueText: string;
  readonly valueKey: string;
  readonly valueComposition:
    "single" | "contiguous_composite" | "ordered_tuple";
  readonly predicateKind: MemoryStateBoundObservationV2["predicateKind"];
  readonly polarity: MemoryStateBoundObservationV2["polarity"];
  readonly modality: MemoryStateBoundObservationV2["modality"];
  readonly evidenceRef: string;
  readonly sourceId: string;
  readonly eventKey?: string;
  readonly eventTimeInterval?: MemoryStateEventTimeIntervalV2;
  readonly eventTimeCutoffStatus?: "within" | "straddles";
  readonly observedAt?: string;
  readonly episodeOrder?: number;
  readonly turnOrder?: number;
  readonly bindingRevision: string;
  readonly stateBindingCertificateId: string;
}

export interface MemoryEvidenceExecutionCollectionValueV1 {
  readonly kind: "collection";
  readonly valueId: string;
  readonly memberValueIds: readonly string[];
}

export interface MemoryEvidenceExecutionDependencyValueV1 {
  readonly kind: "dependency_record";
  readonly valueId: string;
  readonly relation: "depends_on" | "responds_to" | "supersedes";
  readonly operandResultRevisions: readonly string[];
  readonly memberValueIds: readonly string[];
}

export interface MemoryEvidenceExecutionComparisonValueV1 {
  readonly kind: "comparison";
  readonly valueId: string;
  readonly sides: readonly Readonly<{
    operandRole: "left" | "right" | "criterion";
    valueIds: readonly string[];
  }>[];
  readonly relation?: "equal" | "different";
}

export interface MemoryEvidenceExecutionAggregateValueV1 {
  readonly kind: "aggregate";
  readonly valueId: string;
  readonly operator:
    "collect_unique" | "count" | "sum" | "difference" | "ratio_percent";
  readonly aggregationUnit:
    "event" | "semantic_value" | "entity" | "numeric_quantity";
  readonly countBasis: "enumerated_members" | "stated_cardinality" | null;
  readonly memberValueIds: readonly string[];
  readonly lowerBoundCount: number;
  readonly closedWorld: boolean;
  readonly materializationExact: boolean;
  readonly numericValue?: number;
  /** Canonical base-10 result; authoritative for sums and large integers. */
  readonly numericDecimal?: string;
  readonly numericUnit?: string;
}

export interface MemoryEvidenceExecutionDurationValueV1 {
  readonly kind: "temporal_duration";
  readonly valueId: string;
  readonly precision: "exact" | "interval";
  readonly unit: "day" | "week" | "month" | "year";
  readonly value?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly endpointValueIds: readonly string[];
  readonly endpointPolicy: "between_evidence" | "evidence_to_query_anchor";
  readonly queryAnchor?: string;
  readonly endpointCertificateRevision: string;
  readonly endpointCertificate: MemoryEvidenceDurationEndpointBindingCertificateV1;
}

export interface MemoryEvidenceDurationEndpointBindingCertificateV1 {
  readonly certificateVersion: "paw.memory-duration-endpoint-binding-certificate.v1";
  readonly requestRevision: string;
  readonly programRevision: string;
  readonly selectorSnapshotRevision: string;
  readonly stateProgramRevision: string;
  readonly resolvedStateFrameRevision: string;
  readonly sourceLockDigest: string;
  readonly endpointContractKind:
    "distinct_evidence_pair" | "evidence_to_host_anchor";
  readonly endpointValueIds: readonly string[];
  readonly endpointClaimIdentities: readonly string[];
  readonly endpointEventIdentities: readonly string[];
  readonly endpointIdentityBases: readonly (
    | "stable_event_key"
    | "typed_role_interval"
  )[];
  readonly endpointTimeBases: readonly MemoryStateBoundObservationV2["eventTimeBasis"][];
  readonly endpointRoles: readonly MemoryStateBoundObservationV2["durationEndpointRole"][];
  readonly endpointRequirementIds: readonly string[];
  readonly endpointSlotIds: readonly string[];
  readonly endpointBindingRevisions: readonly string[];
  readonly endpointStateBindingCertificateIds: readonly string[];
  readonly endpointIntervals: readonly MemoryStateEventTimeIntervalV2[];
  readonly anchorRevision?: string;
  readonly closureBasis: "closed_endpoint_set";
  readonly certificateRevision: string;
}

export interface MemoryEvidenceExecutionPreferenceValueV1 {
  readonly kind: "preference_profile";
  readonly valueId: string;
  readonly positiveValueIds: readonly string[];
  readonly negativeValueIds: readonly string[];
  readonly goalValueIds: readonly string[];
  readonly oneOffValueIds: readonly string[];
}

export interface MemoryEvidenceExecutionPersonalizationValueV1 {
  readonly kind: "personalization_profile";
  readonly valueId: string;
  readonly explicitPositiveValueIds: readonly string[];
  readonly explicitNegativeValueIds: readonly string[];
  readonly goalValueIds: readonly string[];
  readonly contextualConstraintValueIds: readonly string[];
  readonly oneOffValueIds: readonly string[];
  /** This profile constrains one answer; it is not a persistent preference claim. */
  readonly scope: "answer_personalization";
  readonly coverageCertificateRevision?: string;
  readonly coverageCertificate?: MemoryEvidencePersonalizationCoverageCertificateV1;
}

export interface MemoryEvidencePersonalizationClaimLifecycleCertificateV1 {
  readonly certificateVersion: "paw.memory-personalization-claim-lifecycle-certificate.v1";
  readonly relation: "retracts" | "supersedes" | "confirms";
  readonly sourceClaimIdentity: string;
  readonly targetClaimIdentity: string;
  readonly sourceValueId: string;
  readonly targetValueId: string;
  readonly slotId: string;
  readonly sourceEvidenceRef: string;
  readonly targetEvidenceRef: string;
  readonly sourceBindingRevision: string;
  readonly targetBindingRevision: string;
  readonly sourceStateBindingCertificateId: string;
  readonly targetStateBindingCertificateId: string;
  readonly sourceObservedAt: string;
  readonly targetObservedAt: string;
  readonly temporalProof: "source_observed_at_strict_order";
  readonly programRevision: string;
  readonly resolvedStateFrameRevision: string;
  readonly sourceLockDigest: string;
  readonly certificateRevision: string;
}

export interface MemoryEvidencePersonalizationCoverageCertificateV1 {
  readonly certificateVersion: "paw.memory-personalization-coverage-certificate.v1";
  readonly requestRevision: string;
  readonly programRevision: string;
  readonly selectorSnapshotRevision: string;
  readonly lockedSourceRevision: string;
  readonly stateProgramRevision: string;
  readonly resolvedStateFrameRevision: string;
  readonly sourceLockDigest: string;
  readonly answerNodeRevision: string;
  readonly originRevision: string;
  readonly obligationRevision: string;
  readonly scope: "answer_personalization";
  readonly completionBasis: "bounded_context";
  readonly answerOperands: readonly Readonly<{
    nodeId: string;
    nodeResultRevision: string;
    status: "complete";
  }>[];
  readonly admittedClaimSetRevision: string;
  readonly lifecycleCertificateSetRevision: string;
  readonly lifecycleCertificates: readonly MemoryEvidencePersonalizationClaimLifecycleCertificateV1[];
  readonly claims: readonly Readonly<{
    claimIdentityRevision: string;
    valueId: string;
    requirementId: string;
    slotId: string;
    evidenceRef: string;
    bindingRevision: string;
    disposition:
      | "explicit_positive"
      | "explicit_negative"
      | "goal"
      | "contextual"
      | "excluded_inactive";
  }>[];
  readonly usableClaimCount: number;
  readonly minimumUsableClaimCount: 1;
  readonly coverageBasis: "all_answer_operands_complete";
  readonly certificateRevision: string;
}

export interface MemoryEvidenceExecutionRenderContractValueV1 {
  readonly kind: "render_contract";
  readonly valueId: string;
  readonly sourceNodeId: string;
}

export type MemoryEvidenceExecutionValueV1 =
  | MemoryEvidenceExecutionObservationValueV1
  | MemoryEvidenceExecutionCollectionValueV1
  | MemoryEvidenceExecutionDependencyValueV1
  | MemoryEvidenceExecutionComparisonValueV1
  | MemoryEvidenceExecutionAggregateValueV1
  | MemoryEvidenceExecutionDurationValueV1
  | MemoryEvidenceExecutionPreferenceValueV1
  | MemoryEvidenceExecutionPersonalizationValueV1
  | MemoryEvidenceExecutionRenderContractValueV1;

export interface MemoryEvidenceExecutionNodeResultV1 {
  readonly nodeId: string;
  readonly operation: MemoryEvidenceExecutionNodeV1["operation"];
  readonly status: MemoryEvidenceExecutionNodeResultStatusV1;
  readonly reason?: MemoryEvidenceExecutionResultReasonV1;
  readonly values: readonly MemoryEvidenceExecutionValueV1[];
  readonly history: readonly MemoryEvidenceExecutionObservationValueV1[];
  readonly conflicts: readonly MemoryEvidenceExecutionObservationValueV1[];
  readonly provenanceEvidenceRefs: readonly string[];
  readonly completionProofRevisions: readonly string[];
  readonly resultRevision: string;
}

export interface MemoryEvidenceExecutionResultV1 {
  readonly runtimeVersion: typeof PAW_MEMORY_EVIDENCE_EXECUTION_RUNTIME_VERSION_V1;
  readonly programRevision: string;
  readonly stateProgramRevision: string;
  readonly resolvedStateFrameRevision: string;
  readonly coverageCertificateRevision?: string;
  /** Host-compiled identity of the fully revalidated certificate contexts. */
  readonly stateBindingCertificateRegistryRevision: string;
  /** Certificates for executable frame observations only; reducer-excluded certificates stay registry-bound. */
  readonly stateBindingCertificates: readonly MemoryStateBindingCertificateV1[];
  readonly status: MemoryEvidenceExecutionNodeResultStatusV1;
  readonly rootNodeId: string;
  readonly nodes: readonly MemoryEvidenceExecutionNodeResultV1[];
  readonly completeNodeCount: number;
  readonly partialNodeCount: number;
  readonly missingNodeCount: number;
  readonly conflictNodeCount: number;
  readonly unsupportedNodeCount: number;
  readonly executionRevision: string;
}

/**
 * Executes only semantics that can be proven from exact state observations.
 * Free-text comparison, closed-world aggregation, unbound as-of/range anchors,
 * and inferred persistent preference deliberately remain partial/unsupported.
 */
export function executeMemoryEvidenceProgramV1(input: {
  readonly program: MemoryEvidenceExecutionProgramV1;
  readonly slots: readonly MemoryStateSlotSpecV2[];
  readonly frame: MemoryResolvedStateFrameV2;
  readonly validatedObservations: readonly MemoryStateValidatedObservationV1[];
  readonly bindingCertificateValidationContexts: readonly MemoryStateBindingCertificateValidationInputV1[];
  readonly coverageCertificate?: MemoryEvidenceExecutionCoverageCertificateV1;
}): MemoryEvidenceExecutionResultV1 {
  validateMemoryEvidenceExecutionProgramV1(input.program);
  const { frameRevision, ...resolvedFrameIdentity } = input.frame;
  if (
    !frameRevision.trim() ||
    hashCanonicalJsonV1(resolvedFrameIdentity as never) !== frameRevision
  ) {
    throw namedError("MemoryEvidenceExecutionRuntimeFrameInvalid");
  }
  const readNodes = input.program.nodes.filter(
    (node) => node.operation === "read_requirement",
  );
  const readyReadNodes = readNodes.filter((node) => node.status === "ready");
  const readNodeByRequirement = new Map(
    readNodes.flatMap((node) =>
      node.requirementId ? [[node.requirementId, node] as const] : [],
    ),
  );
  const slotByRequirement = new Map(
    input.slots.map((slot) => [slot.requirementId, slot]),
  );
  const stateSlotById = new Map(
    input.frame.slots.map((slot) => [slot.slotId, slot]),
  );
  const certificateRegistry = validateExecutionBindingCertificates(
    input.program,
    input.slots,
    input.frame,
    input.validatedObservations,
    input.bindingCertificateValidationContexts,
  );
  const certificateByObservationId =
    certificateRegistry.certificateByObservationId;
  if (
    !input.program.programRevision.trim() ||
    !input.frame.programRevision.trim() ||
    slotByRequirement.size !== input.slots.length ||
    stateSlotById.size !== input.frame.slots.length ||
    input.slots.some(
      (slot) => !readNodeByRequirement.has(slot.requirementId),
    ) ||
    readyReadNodes.some(
      (node) =>
        !node.requirementId || !slotByRequirement.has(node.requirementId),
    )
  ) {
    throw namedError("MemoryEvidenceExecutionRuntimeInputInvalid");
  }
  if (
    input.coverageCertificate &&
    (input.coverageCertificate.selectorSnapshotRevision !==
      input.program.selectorSnapshotRevision ||
      input.coverageCertificate.requirements.length !== readNodes.length ||
      input.coverageCertificate.requirements.some((coverage) => {
        const readNode = readNodeByRequirement.get(coverage.requirementId);
        return (
          !readNode ||
          (readNode.status === "ready" &&
            !slotByRequirement.has(coverage.requirementId)) ||
          coverage.requirementRevision !== readNode.requirementRevision ||
          coverage.temporalBindingRevision !==
            readNode.temporalBindingRevision ||
          coverage.supportingEvidenceSetRevision !==
            hashCanonicalJsonV1({
              schemaVersion: "paw.memory-supporting-evidence-set.v1",
              evidenceRefs: Object.freeze(
                [...(readNode.supportingEvidenceRefs ?? [])].sort(),
              ),
            } as never)
        );
      }))
  ) {
    throw namedError("MemoryEvidenceExecutionRuntimeCoverageInvalid");
  }
  if (input.coverageCertificate) {
    validateMemoryEvidenceExecutionCoverageCertificateV1(
      input.coverageCertificate,
    );
  }
  const closedRequirementIds = new Set(
    input.coverageCertificate?.requirements.flatMap((coverage) =>
      coverage.status === "closed" ? [coverage.requirementId] : [],
    ) ?? [],
  );
  const coverageByRequirement = new Map(
    input.coverageCertificate?.requirements.map(
      (coverage) => [coverage.requirementId, coverage] as const,
    ) ?? [],
  );

  const results = new Map<string, MemoryEvidenceExecutionNodeResultV1>();
  for (const node of input.program.nodes) {
    const operands = node.operandNodeIds.map((nodeId) => {
      const result = results.get(nodeId);
      if (!result)
        throw namedError("MemoryEvidenceExecutionRuntimeGraphInvalid");
      return result;
    });
    const result =
      node.operation === "read_requirement"
        ? executeReadNode(
            node,
            slotByRequirement,
            stateSlotById,
            certificateByObservationId,
          )
        : executeDerivedNode(
            node,
            operands,
            closedRequirementIds,
            coverageByRequirement,
            {
              program: input.program,
              programRevision: input.program.programRevision,
              selectorSnapshotRevision: input.program.selectorSnapshotRevision,
              stateProgramRevision: input.frame.programRevision,
              resolvedStateFrameRevision: input.frame.frameRevision,
              sourceLockDigest: input.frame.sourceLockDigest,
            },
          );
    results.set(node.nodeId, result);
  }
  const root = results.get(input.program.rootNodeId);
  if (!root) throw namedError("MemoryEvidenceExecutionRuntimeGraphInvalid");
  const nodes = Object.freeze(
    input.program.nodes.map((node) => {
      const result = results.get(node.nodeId);
      if (!result)
        throw namedError("MemoryEvidenceExecutionRuntimeGraphInvalid");
      return result;
    }),
  );
  const counts = countStatuses(nodes);
  const identity = {
    runtimeVersion: PAW_MEMORY_EVIDENCE_EXECUTION_RUNTIME_VERSION_V1,
    programRevision: input.program.programRevision,
    stateProgramRevision: input.frame.programRevision,
    resolvedStateFrameRevision: input.frame.frameRevision,
    ...(input.coverageCertificate === undefined
      ? {}
      : {
          coverageCertificateRevision:
            input.coverageCertificate.certificateRevision,
        }),
    stateBindingCertificateRegistryRevision:
      certificateRegistry.registryRevision,
    stateBindingCertificates: certificateRegistry.frameCertificates,
    status: root.status,
    rootNodeId: input.program.rootNodeId,
    nodes,
    ...counts,
  };
  return Object.freeze({
    ...identity,
    executionRevision: hashCanonicalJsonV1(identity as never),
  });
}

function executeReadNode(
  node: MemoryEvidenceExecutionNodeV1,
  slotByRequirement: ReadonlyMap<string, MemoryStateSlotSpecV2>,
  stateSlotById: ReadonlyMap<
    string,
    MemoryResolvedStateFrameV2["slots"][number]
  >,
  certificateByObservationId: ReadonlyMap<
    string,
    MemoryStateBindingCertificateV1
  >,
): MemoryEvidenceExecutionNodeResultV1 {
  if (node.status !== "ready") {
    return result(node, "missing", [], [], [], "plan_node_blocked", []);
  }
  const requirementId = node.requirementId as string;
  const slot = slotByRequirement.get(requirementId);
  const state = slot ? stateSlotById.get(slot.slotId) : undefined;
  if (!slot || !state) {
    return result(node, "missing", [], [], [], "state_slot_missing", []);
  }
  const allowedRefs = new Set(node.supportingEvidenceRefs ?? []);
  const observations = uniqueObservations([
    ...state.current,
    ...state.history,
    ...state.conflicts,
  ]).filter(
    (observation) =>
      observation.slotId === slot.slotId &&
      observation.role === node.resolvedRole &&
      allowedRefs.has(observation.evidenceRef),
  );
  const values = observations.map((observation) =>
    observationValue(
      requirementId,
      observation,
      certificateByObservationId.get(observation.observationId),
    ),
  );
  const conflicts = state.conflicts
    .filter((observation) => allowedRefs.has(observation.evidenceRef))
    .map((observation) =>
      observationValue(
        requirementId,
        observation,
        certificateByObservationId.get(observation.observationId),
      ),
    );
  const history = state.history
    .filter((observation) => allowedRefs.has(observation.evidenceRef))
    .map((observation) =>
      observationValue(
        requirementId,
        observation,
        certificateByObservationId.get(observation.observationId),
      ),
    );
  // Temporal leaves must expose every admitted observation to the temporal
  // executor. The state reducer's conflict is an intermediate diagnosis; only
  // the typed clock policy may decide mixed-clock partial vs real conflict.
  if (
    slot.operation !== "resolve_latest" &&
    (conflicts.length > 0 || state.status === "conflict")
  ) {
    return result(node, "conflict", values, history, conflicts, undefined, [
      ...state.coverageProof,
    ]);
  }
  if (values.length === 0) {
    return result(node, "missing", [], [], [], "state_slot_missing", []);
  }
  const independent = new Set(observations.map(independenceKey));
  const minimum = node.minimumIndependentEvidence ?? 1;
  if (independent.size < minimum) {
    return result(
      node,
      "partial",
      values,
      history,
      [],
      "minimum_evidence_unsatisfied",
      [...state.coverageProof],
    );
  }
  return result(node, "complete", values, history, [], undefined, [
    ...state.coverageProof,
  ]);
}

function executeDerivedNode(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
  closedRequirementIds: ReadonlySet<string>,
  coverageByRequirement: ReadonlyMap<
    string,
    MemoryEvidenceExecutionRequirementCoverageV1
  >,
  executionIdentity: Readonly<{
    program: MemoryEvidenceExecutionProgramV1;
    programRevision: string;
    selectorSnapshotRevision: string;
    stateProgramRevision: string;
    resolvedStateFrameRevision: string;
    sourceLockDigest: string;
  }>,
): MemoryEvidenceExecutionNodeResultV1 {
  if (node.status !== "ready") {
    return result(node, "missing", [], [], [], "plan_node_blocked", []);
  }
  if (node.operation === "resolve_latest")
    return executeLatest(node, operands, closedRequirementIds);
  if (node.operation === "resolve_as_of")
    return executeAsOf(node, operands, closedRequirementIds);
  if (node.operation === "restrict_range")
    return executeRange(node, operands, closedRequirementIds);
  if (node.operation === "preserve_history") {
    const observations = observationValues(operands);
    if (observations.length === 0)
      return incompleteFromOperands(node, operands);
    const ordered = orderHistory(observations);
    const closed = observations.every((value) =>
      closedRequirementIds.has(value.requirementId),
    );
    const hasMixedClock =
      observations.some((value) => value.eventTimeInterval) &&
      observations.some((value) => !value.eventTimeInterval);
    return result(
      node,
      closed && !hasMixedClock ? "complete" : "partial",
      ordered,
      ordered,
      [],
      closed
        ? hasMixedClock
          ? "mixed_clock"
          : undefined
        : "closed_world_unproven",
      flattenProofs(operands),
    );
  }
  if (node.operation === "dependency_join") {
    const incomplete = firstIncomplete(operands);
    if (incomplete) return incompleteFromOperands(node, operands);
    const members = flattenValues(operands);
    const dependency = dependencyValue(node, operands, members);
    return result(
      node,
      "complete",
      [dependency, ...members],
      flattenHistory(operands),
      [],
      undefined,
      flattenProofs(operands),
    );
  }
  if (node.operation === "collect_operands") {
    const incomplete = firstIncomplete(operands);
    if (incomplete) return incompleteFromOperands(node, operands);
    const members = flattenValues(operands);
    const collection = collectionValue(node, members);
    return result(
      node,
      "complete",
      [collection, ...members],
      flattenHistory(operands),
      [],
      undefined,
      flattenProofs(operands),
    );
  }
  if (node.operation === "compare_operands") {
    if (firstIncomplete(operands))
      return incompleteFromOperands(node, operands);
    const comparison = comparisonValue(node, operands);
    return result(
      node,
      "complete",
      [comparison, ...flattenValues(operands)],
      flattenHistory(operands),
      [],
      undefined,
      flattenProofs(operands),
    );
  }
  if (node.operation === "aggregate_operands") {
    if (firstIncomplete(operands))
      return incompleteFromOperands(node, operands);
    const request = node.aggregateRequest;
    if (!request) {
      return result(
        node,
        "unsupported",
        flattenValues(operands),
        flattenHistory(operands),
        flattenConflicts(operands),
        "aggregate_operand_roles_unbound",
        flattenProofs(operands),
      );
    }
    const aggregateInput = dedupeAggregateObservations(
      observationValues(operands),
      request.aggregationUnit,
    );
    if (aggregateInput.excluded.length > 0) {
      return result(
        node,
        "unsupported",
        aggregateInput.members,
        flattenHistory(operands),
        aggregateInput.excluded,
        "aggregate_member_unsupported",
        flattenProofs(operands),
      );
    }
    const members = aggregateInput.members;
    const coverageClosed =
      aggregateInput.eligible.length > 0 &&
      aggregateInput.eligible.every((value) =>
        closedRequirementIds.has(value.requirementId),
      );
    const materializationExact = aggregateMaterializationExactV1(
      aggregateInput.eligible,
      coverageByRequirement,
    );
    const closed = coverageClosed && materializationExact;
    if (coverageClosed && !materializationExact) {
      const aggregate = aggregateValue(node, members, false, false, request);
      return result(
        node,
        "partial",
        [aggregate, ...members],
        flattenHistory(operands),
        [],
        "aggregate_materialization_incomplete",
        flattenProofs(operands),
      );
    }
    if (
      request.operator === "difference" ||
      request.operator === "ratio_percent"
    ) {
      return result(
        node,
        "unsupported",
        members,
        flattenHistory(operands),
        [],
        "aggregate_operand_roles_unbound",
        flattenProofs(operands),
      );
    }
    if (
      request.operator === "count" &&
      request.countBasis !== "enumerated_members"
    ) {
      return result(
        node,
        "unsupported",
        members,
        flattenHistory(operands),
        [],
        "aggregate_count_basis_unproven",
        flattenProofs(operands),
      );
    }
    if (!aggregateInput.unitProofExact) {
      const aggregate = aggregateValue(
        node,
        members,
        closed,
        materializationExact,
        request,
      );
      return result(
        node,
        "partial",
        [aggregate, ...members],
        flattenHistory(operands),
        [],
        "aggregate_unit_unproven",
        flattenProofs(operands),
      );
    }
    const quantities = members.map(parseNumericQuantityV1);
    if (
      request.operator === "sum" &&
      (quantities.some((quantity) => quantity === null) ||
        new Set(quantities.map((quantity) => quantity?.unit).filter(Boolean))
          .size !== 1)
    ) {
      return result(
        node,
        "unsupported",
        members,
        flattenHistory(operands),
        [],
        "aggregate_quantity_unbound",
        flattenProofs(operands),
      );
    }
    const numeric =
      request.operator === "sum"
        ? sumExactQuantitiesV1(
            quantities.filter(
              (quantity): quantity is NonNullable<typeof quantity> =>
                quantity !== null,
            ),
          )
        : request.operator === "count"
          ? {
              decimal: String(members.length),
              safeIntegerValue: members.length,
              unit: "count",
            }
          : undefined;
    const aggregate = aggregateValue(
      node,
      members,
      closed,
      materializationExact,
      request,
      numeric,
    );
    return result(
      node,
      closed ? "complete" : "partial",
      [aggregate, ...members],
      flattenHistory(operands),
      flattenConflicts(operands),
      closed ? undefined : "closed_world_unproven",
      flattenProofs(operands),
    );
  }
  if (node.operation === "measure_duration") {
    return executeDuration(node, operands, executionIdentity);
  }
  if (node.operation === "infer_preference") {
    return executePreference(node, operands);
  }
  if (node.operation === "compile_personalization_profile") {
    return executePersonalization(node, operands, executionIdentity);
  }
  if (node.operation === "render_answer") {
    if (firstIncomplete(operands))
      return incompleteFromOperands(node, operands);
    const source = operands[0];
    if (!source) return incompleteFromOperands(node, operands);
    const value = Object.freeze({
      kind: "render_contract" as const,
      valueId: hashCanonicalJsonV1({
        nodeId: node.nodeId,
        source: source.nodeId,
      }),
      sourceNodeId: source.nodeId,
    });
    return result(node, "complete", [value], [], [], undefined, [
      source.resultRevision,
    ]);
  }
  return result(
    node,
    "unsupported",
    flattenValues(operands),
    flattenHistory(operands),
    flattenConflicts(operands),
    "opaque_aggregate_unsupported",
    flattenProofs(operands),
  );
}

function executeLatest(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
  closedRequirementIds: ReadonlySet<string>,
): MemoryEvidenceExecutionNodeResultV1 {
  const observations = observationValues(operands).filter(
    (value) => value.modality === "observed",
  );
  return executeLatestObservations(
    node,
    operands,
    observations,
    closedRequirementIds,
  );
}

function executeAsOf(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
  closedRequirementIds: ReadonlySet<string>,
): MemoryEvidenceExecutionNodeResultV1 {
  const window = node.temporalWindow;
  if (window?.kind !== "as_of" || !window.anchor) {
    return result(
      node,
      "unsupported",
      flattenValues(operands),
      flattenHistory(operands),
      flattenConflicts(operands),
      "temporal_anchor_unbound",
      flattenProofs(operands),
    );
  }
  const anchor = window.anchor;
  const observations = observationValues(operands).filter(
    (value) => value.modality === "observed",
  );
  const clock = temporalClock(observations);
  if (clock === "mixed") {
    return result(
      node,
      "partial",
      observations,
      observations,
      [],
      "mixed_clock",
      flattenProofs(operands),
    );
  }
  const filtered = observations.filter((observation) => {
    const interval = executionInterval(observation, clock);
    return interval ? interval.lower < anchor.upper : false;
  });
  if (filtered.length === 0) {
    return result(
      node,
      "missing",
      [],
      observations,
      [],
      "temporal_window_empty",
      flattenProofs(operands),
    );
  }
  return executeLatestObservations(
    node,
    operands,
    filtered,
    closedRequirementIds,
  );
}

function executeRange(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
  closedRequirementIds: ReadonlySet<string>,
): MemoryEvidenceExecutionNodeResultV1 {
  const window = node.temporalWindow;
  if (window?.kind !== "range" || !window.interval) {
    return result(
      node,
      "unsupported",
      flattenValues(operands),
      flattenHistory(operands),
      flattenConflicts(operands),
      "temporal_anchor_unbound",
      flattenProofs(operands),
    );
  }
  const range = window.interval;
  const observations = observationValues(operands);
  const clock = temporalClock(observations);
  if (clock === "mixed") {
    return result(
      node,
      "partial",
      observations,
      observations,
      [],
      "mixed_clock",
      flattenProofs(operands),
    );
  }
  const filtered = observations.filter((observation) => {
    const interval = executionInterval(observation, clock);
    return interval
      ? interval.lower < range.upper && range.lower < interval.upper
      : false;
  });
  if (filtered.length === 0) {
    return result(
      node,
      "missing",
      [],
      observations,
      [],
      "temporal_window_empty",
      flattenProofs(operands),
    );
  }
  const closed = filtered.every((observation) =>
    closedRequirementIds.has(observation.requirementId),
  );
  return result(
    node,
    closed ? "complete" : "partial",
    orderHistory(filtered),
    observations.filter((observation) => !filtered.includes(observation)),
    [],
    closed ? undefined : "closed_world_unproven",
    flattenProofs(operands),
  );
}

function executeLatestObservations(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
  observations: readonly MemoryEvidenceExecutionObservationValueV1[],
  closedRequirementIds: ReadonlySet<string>,
): MemoryEvidenceExecutionNodeResultV1 {
  if (observations.length === 0) return incompleteFromOperands(node, operands);
  if (
    observations.some(
      (observation) => !closedRequirementIds.has(observation.requirementId),
    )
  ) {
    return result(
      node,
      "partial",
      observations,
      observations,
      [],
      "closed_world_unproven",
      flattenProofs(operands),
    );
  }
  if (
    observations.some((value) => value.eventTimeCutoffStatus === "straddles")
  ) {
    return result(
      node,
      "partial",
      observations,
      observations,
      [],
      "temporal_interval_straddles_cutoff",
      flattenProofs(operands),
    );
  }
  const eventTimed = observations.filter((value) => value.eventTimeInterval);
  if (eventTimed.length > 0 && eventTimed.length !== observations.length) {
    return result(
      node,
      "partial",
      observations,
      observations,
      [],
      "mixed_clock",
      flattenProofs(operands),
    );
  }
  const maxima =
    eventTimed.length > 0
      ? eventMaxima(observations)
      : observedMaxima(observations);
  if (maxima.length === 0) {
    return result(
      node,
      "partial",
      observations,
      observations,
      [],
      "clock_incomplete",
      flattenProofs(operands),
    );
  }
  const identities = new Set(maxima.map(semanticObservationKey));
  if (identities.size > 1) {
    return result(
      node,
      "conflict",
      maxima,
      observations,
      maxima,
      undefined,
      flattenProofs(operands),
    );
  }
  const winner = maxima[0] as MemoryEvidenceExecutionObservationValueV1;
  if (winner.predicateKind === "retract") {
    return result(
      node,
      "partial",
      [],
      observations,
      [],
      "retract_target_unbound",
      flattenProofs(operands),
    );
  }
  if (!new Set(["assert", "update", "confirm"]).has(winner.predicateKind)) {
    return result(
      node,
      "partial",
      maxima,
      observations,
      [],
      "clock_incomplete",
      [...flattenProofs(operands)],
    );
  }
  return result(
    node,
    "complete",
    maxima,
    observations.filter((value) => !maxima.includes(value)),
    [],
    undefined,
    [...new Set(maxima.map((value) => value.bindingRevision))],
  );
}

function executePreference(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): MemoryEvidenceExecutionNodeResultV1 {
  const observations = observationValues(operands);
  const positive = observations.filter(
    (value) =>
      value.predicateKind === "prefer" && value.polarity === "positive",
  );
  const negative = observations.filter(
    (value) =>
      value.predicateKind === "disprefer" || value.polarity === "negative",
  );
  const goals = observations.filter((value) => value.modality === "goal");
  const explicit = new Set(
    [...positive, ...negative, ...goals].map((value) => value.valueId),
  );
  const oneOff = observations.filter((value) => !explicit.has(value.valueId));
  const positiveKeys = new Set(positive.map((value) => value.valueKey));
  const conflicts = negative.filter((value) =>
    positiveKeys.has(value.valueKey),
  );
  const profile = preferenceValue(node, positive, negative, goals, oneOff);
  if (conflicts.length > 0) {
    return result(
      node,
      "conflict",
      [profile, ...observations],
      [],
      conflicts,
      "preference_signal_conflict",
      flattenProofs(operands),
    );
  }
  if (positive.length + negative.length === 0) {
    return result(
      node,
      "partial",
      [profile, ...observations],
      [],
      [],
      "preference_signal_missing",
      flattenProofs(operands),
    );
  }
  return result(
    node,
    "complete",
    [profile, ...positive, ...negative, ...goals],
    [],
    [],
    undefined,
    flattenProofs(operands),
  );
}

function executePersonalization(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
  executionIdentity: Readonly<{
    program: MemoryEvidenceExecutionProgramV1;
    programRevision: string;
    selectorSnapshotRevision: string;
    stateProgramRevision: string;
    resolvedStateFrameRevision: string;
    sourceLockDigest: string;
  }>,
): MemoryEvidenceExecutionNodeResultV1 {
  if (firstIncomplete(operands)) return incompleteFromOperands(node, operands);
  const request = node.personalizationRequest;
  if (!request) {
    return result(
      node,
      "unsupported",
      flattenValues(operands),
      [],
      [],
      "personalization_contract_missing",
      flattenProofs(operands),
    );
  }
  const observations = observationValues(operands);
  if (observations.length === 0) {
    return result(
      node,
      "missing",
      [],
      [],
      [],
      "personalization_constraint_missing",
      flattenProofs(operands),
    );
  }
  const lifecycleCertificates =
    compilePersonalizationClaimLifecycleCertificatesV1({
      observations,
      programRevision: executionIdentity.programRevision,
      resolvedStateFrameRevision:
        executionIdentity.resolvedStateFrameRevision,
      sourceLockDigest: executionIdentity.sourceLockDigest,
    });
  if (!lifecycleCertificates) {
    return result(
      node,
      "partial",
      observations,
      [],
      [],
      "retract_target_unbound",
      flattenProofs(operands),
    );
  }
  const inactiveClaimIdentities = inactivePersonalizationClaimIdentities(
    observations,
    lifecycleCertificates,
  );
  const readRoleByRequirement = new Map(
    executionIdentity.program.nodes.flatMap((candidate) =>
      candidate.operation === "read_requirement" &&
      candidate.requirementId &&
      candidate.resolvedRole
        ? [[candidate.requirementId, candidate.resolvedRole] as const]
        : [],
    ),
  );
  const activeUserObservations = observations.filter(
    (value) =>
      !inactiveClaimIdentities.has(value.claimIdentity) &&
      readRoleByRequirement.get(value.requirementId) === "user",
  );
  const goals = activeUserObservations.filter(
    (value) => value.modality === "goal",
  );
  const goalIds = new Set(goals.map((value) => value.valueId));
  const explicitPositive = activeUserObservations.filter(
    (value) =>
      !goalIds.has(value.valueId) &&
      value.predicateKind === "prefer" &&
      value.polarity === "positive",
  );
  const explicitNegative = activeUserObservations.filter(
    (value) =>
      !goalIds.has(value.valueId) && value.predicateKind === "disprefer",
  );
  const explicitOrGoal = new Set(
    [...explicitPositive, ...explicitNegative, ...goals].map(
      (value) => value.valueId,
    ),
  );
  const contextual = activeUserObservations.filter(
    (value) =>
      !explicitOrGoal.has(value.valueId) &&
      value.modality === "observed" &&
      new Set(["assert", "update", "confirm"]).has(value.predicateKind),
  );
  const contextualIds = new Set(contextual.map((value) => value.valueId));
  const oneOff = observations.filter(
    (value) =>
      !explicitOrGoal.has(value.valueId) && !contextualIds.has(value.valueId),
  );
  const positiveKeys = new Set(explicitPositive.map((value) => value.valueKey));
  const conflicts = explicitNegative.filter((value) =>
    positiveKeys.has(value.valueKey),
  );
  if (conflicts.length > 0) {
    const profile = personalizationValue(
      node,
      explicitPositive,
      explicitNegative,
      goals,
      contextual,
      oneOff,
    );
    return result(
      node,
      "conflict",
      [profile, ...observations],
      [],
      conflicts,
      "preference_signal_conflict",
      flattenProofs(operands),
    );
  }
  const usableConstraintIds = new Set(
    [...explicitPositive, ...explicitNegative, ...goals, ...contextual].map(
      (value) => value.valueId,
    ),
  );
  if (usableConstraintIds.size < request.minimumContextObservations) {
    const profile = personalizationValue(
      node,
      explicitPositive,
      explicitNegative,
      goals,
      contextual,
      oneOff,
    );
    return result(
      node,
      "partial",
      [profile, ...observations],
      [],
      [],
      "personalization_constraint_missing",
      [...flattenProofs(operands), request.requestRevision],
    );
  }
  const coverageCertificate = compilePersonalizationCoverageCertificateV1({
    request,
    operands,
    constraints: [
      ...explicitPositive.map((value) => ({
        value,
        kind: "explicit_positive" as const,
      })),
      ...explicitNegative.map((value) => ({
        value,
        kind: "explicit_negative" as const,
      })),
      ...goals.map((value) => ({ value, kind: "goal" as const })),
      ...contextual.map((value) => ({
        value,
        kind: "contextual" as const,
      })),
    ],
    admittedObservations: observations,
    inactiveClaimIdentities,
    lifecycleCertificates,
    ...executionIdentity,
    answerNodeRevision: node.nodeRevision,
  });
  if (!coverageCertificate) {
    const profile = personalizationValue(
      node,
      explicitPositive,
      explicitNegative,
      goals,
      contextual,
      oneOff,
    );
    return result(
      node,
      "partial",
      [profile, ...observations],
      [],
      [],
      "personalization_contract_missing",
      [...flattenProofs(operands), request.requestRevision],
    );
  }
  const profile = personalizationValue(
    node,
    explicitPositive,
    explicitNegative,
    goals,
    contextual,
    [],
    coverageCertificate,
  );
  return result(
    node,
    "complete",
    [
      profile,
      ...explicitPositive,
      ...explicitNegative,
      ...goals,
      ...contextual,
    ],
    [],
    [],
    undefined,
    [
      ...flattenProofs(operands),
      request.requestRevision,
      coverageCertificate.certificateRevision,
    ],
  );
}

function inactivePersonalizationClaimIdentities(
  observations: readonly MemoryEvidenceExecutionObservationValueV1[],
  lifecycleCertificates: readonly MemoryEvidencePersonalizationClaimLifecycleCertificateV1[],
): ReadonlySet<string> {
  const inactive = new Set(
    observations.flatMap((value) =>
      value.predicateKind === "retract" ||
      value.modality === "plan" ||
      value.modality === "forecast"
        ? [value.claimIdentity]
        : [],
    ),
  );
  for (const certificate of lifecycleCertificates) {
    if (
      certificate.relation === "retracts" ||
      certificate.relation === "supersedes"
    ) {
      inactive.add(certificate.targetClaimIdentity);
    }
  }
  return inactive;
}

function compilePersonalizationClaimLifecycleCertificatesV1(input: {
  observations: readonly MemoryEvidenceExecutionObservationValueV1[];
  programRevision: string;
  resolvedStateFrameRevision: string;
  sourceLockDigest: string;
}): readonly MemoryEvidencePersonalizationClaimLifecycleCertificateV1[] | null {
  const bySlotAndEvidence = new Map(
    input.observations.map((value) => [
      `${value.slotId}\0${value.evidenceRef}`,
      value,
    ]),
  );
  if (
    bySlotAndEvidence.size !== input.observations.length ||
    !input.programRevision.trim() ||
    !input.resolvedStateFrameRevision.trim() ||
    !input.sourceLockDigest.trim()
  ) {
    return null;
  }
  const lifecycleSources = input.observations.filter((value) =>
    new Set(["update", "retract", "confirm"]).has(value.predicateKind),
  );
  const certificates: MemoryEvidencePersonalizationClaimLifecycleCertificateV1[] = [];
  for (const source of lifecycleSources) {
    const expectedRelation =
      source.predicateKind === "retract"
        ? ("retracts" as const)
        : source.predicateKind === "update"
          ? ("supersedes" as const)
          : ("confirms" as const);
    const target = source.lifecycleTargetEvidenceRef
      ? bySlotAndEvidence.get(
          `${source.slotId}\0${source.lifecycleTargetEvidenceRef}`,
        )
      : undefined;
    if (
      source.lifecycleRelation !== expectedRelation ||
      !target ||
      !source.observedAt ||
      !target.observedAt ||
      !Number.isFinite(Date.parse(source.observedAt)) ||
      !Number.isFinite(Date.parse(target.observedAt)) ||
      Date.parse(target.observedAt) >= Date.parse(source.observedAt) ||
      !source.stateBindingCertificateId.trim() ||
      !target.stateBindingCertificateId.trim()
    ) {
      return null;
    }
    const identity = {
      certificateVersion:
        "paw.memory-personalization-claim-lifecycle-certificate.v1" as const,
      relation: expectedRelation,
      sourceClaimIdentity: source.claimIdentity,
      targetClaimIdentity: target.claimIdentity,
      sourceValueId: source.valueId,
      targetValueId: target.valueId,
      slotId: source.slotId,
      sourceEvidenceRef: source.evidenceRef,
      targetEvidenceRef: target.evidenceRef,
      sourceBindingRevision: source.bindingRevision,
      targetBindingRevision: target.bindingRevision,
      sourceStateBindingCertificateId: source.stateBindingCertificateId,
      targetStateBindingCertificateId: target.stateBindingCertificateId,
      sourceObservedAt: source.observedAt,
      targetObservedAt: target.observedAt,
      temporalProof: "source_observed_at_strict_order" as const,
      programRevision: input.programRevision,
      resolvedStateFrameRevision: input.resolvedStateFrameRevision,
      sourceLockDigest: input.sourceLockDigest,
    };
    certificates.push(
      Object.freeze({
        ...identity,
        certificateRevision: hashCanonicalJsonV1(identity as never),
      }),
    );
  }
  return Object.freeze(certificates);
}

function compilePersonalizationCoverageCertificateV1(input: {
  request: NonNullable<MemoryEvidenceExecutionNodeV1["personalizationRequest"]>;
  operands: readonly MemoryEvidenceExecutionNodeResultV1[];
  admittedObservations: readonly MemoryEvidenceExecutionObservationValueV1[];
  inactiveClaimIdentities: ReadonlySet<string>;
  lifecycleCertificates: readonly MemoryEvidencePersonalizationClaimLifecycleCertificateV1[];
  constraints: readonly Readonly<{
    value: MemoryEvidenceExecutionObservationValueV1;
    kind: "explicit_positive" | "explicit_negative" | "goal" | "contextual";
  }>[];
  program: MemoryEvidenceExecutionProgramV1;
  programRevision: string;
  selectorSnapshotRevision: string;
  stateProgramRevision: string;
  resolvedStateFrameRevision: string;
  sourceLockDigest: string;
  answerNodeRevision: string;
}): MemoryEvidencePersonalizationCoverageCertificateV1 | null {
  const answerNode = input.program.nodes.find(
    (node) => node.nodeId === input.program.answerNodeId,
  );
  const readNodeByRequirement = new Map(
    input.program.nodes.flatMap((node) =>
      node.operation === "read_requirement" && node.requirementId
        ? [[node.requirementId, node] as const]
        : [],
    ),
  );
  if (
    input.request.scope !== "answer_personalization" ||
    input.request.completionBasis !== "bounded_context" ||
    input.program.obligationKind !== "personalization_context" ||
    !answerNode ||
    answerNode.operation !== "compile_personalization_profile" ||
    answerNode.nodeRevision !== input.answerNodeRevision ||
    input.program.answerOperandNodeIds.length !== input.operands.length ||
    input.program.answerOperandNodeIds.some(
      (nodeId, index) => nodeId !== input.operands[index]?.nodeId,
    ) ||
    input.operands.length < 1 ||
    input.operands.some(
      (operand) =>
        operand.status !== "complete" ||
        operand.conflicts.length > 0 ||
        !operand.resultRevision.trim(),
    ) ||
    input.constraints.length < input.request.minimumContextObservations ||
    input.constraints.some(
      ({ value }) =>
        !value.claimIdentity.trim() ||
        !value.evidenceRef.trim() ||
        !value.bindingRevision.trim(),
    ) ||
    !input.programRevision.trim() ||
    input.programRevision !== input.program.programRevision ||
    !input.selectorSnapshotRevision.trim() ||
    input.selectorSnapshotRevision !== input.program.selectorSnapshotRevision ||
    !input.stateProgramRevision.trim() ||
    !input.resolvedStateFrameRevision.trim() ||
    !input.sourceLockDigest.trim()
  ) {
    return null;
  }
  const uniqueAdmitted = [
    ...new Map(
      input.admittedObservations.map((value) => [value.valueId, value]),
    ).values(),
  ];
  const admittedClaimIdentities = new Set(
    uniqueAdmitted.map((value) => value.claimIdentity),
  );
  if (
    input.lifecycleCertificates.some((certificate) => {
      const { certificateRevision, ...identity } = certificate;
      return (
        hashCanonicalJsonV1(identity as never) !== certificateRevision ||
        certificate.programRevision !== input.programRevision ||
        certificate.resolvedStateFrameRevision !==
          input.resolvedStateFrameRevision ||
        certificate.sourceLockDigest !== input.sourceLockDigest ||
        !admittedClaimIdentities.has(certificate.sourceClaimIdentity) ||
        !admittedClaimIdentities.has(certificate.targetClaimIdentity)
      );
    })
  ) {
    return null;
  }
  const constraintByValue = new Map(
    input.constraints.map((constraint) => [
      constraint.value.valueId,
      constraint,
    ]),
  );
  if (
    constraintByValue.size < input.request.minimumContextObservations ||
    input.constraints.some(
      (constraint) =>
        !uniqueAdmitted.some(
          (value) => value.valueId === constraint.value.valueId,
        ),
    )
  ) {
    return null;
  }
  const claims = Object.freeze(
    uniqueAdmitted.map((value) => {
      const constraint = constraintByValue.get(value.valueId);
      const readNode = readNodeByRequirement.get(value.requirementId);
      const usable =
        constraint !== undefined &&
        !input.inactiveClaimIdentities.has(value.claimIdentity) &&
        readNode?.resolvedRole === "user";
      return Object.freeze({
        claimIdentityRevision: value.claimIdentity,
        valueId: value.valueId,
        requirementId: value.requirementId,
        slotId: value.slotId,
        evidenceRef: value.evidenceRef,
        bindingRevision: value.bindingRevision,
        disposition: usable ? constraint.kind : ("excluded_inactive" as const),
      });
    }),
  );
  const usableClaims = claims.filter(
    (claim) => claim.disposition !== "excluded_inactive",
  );
  if (
    usableClaims.length < input.request.minimumContextObservations ||
    claims.some((claim) => {
      const readNode = readNodeByRequirement.get(claim.requirementId);
      return (
        !readNode ||
        !readNode.supportingEvidenceRefs?.includes(claim.evidenceRef) ||
        (claim.disposition !== "excluded_inactive" &&
          readNode.resolvedRole !== "user")
      );
    })
  ) {
    return null;
  }
  const admittedClaimSetRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-personalization-admitted-claim-set.v1",
    claims,
  } as never);
  const lifecycleCertificateSetRevision = hashCanonicalJsonV1({
    schemaVersion:
      "paw.memory-personalization-lifecycle-certificate-set.v1",
    certificateRevisions: input.lifecycleCertificates.map(
      (certificate) => certificate.certificateRevision,
    ),
  } as never);
  const identity = {
    certificateVersion:
      "paw.memory-personalization-coverage-certificate.v1" as const,
    requestRevision: input.request.requestRevision,
    programRevision: input.programRevision,
    answerNodeRevision: input.answerNodeRevision,
    selectorSnapshotRevision: input.selectorSnapshotRevision,
    lockedSourceRevision: input.program.lockedSourceRevision,
    stateProgramRevision: input.stateProgramRevision,
    resolvedStateFrameRevision: input.resolvedStateFrameRevision,
    sourceLockDigest: input.sourceLockDigest,
    originRevision: input.program.originRevision,
    obligationRevision: input.program.obligationRevision,
    scope: "answer_personalization" as const,
    completionBasis: "bounded_context" as const,
    answerOperands: Object.freeze(
      input.operands.map((operand) =>
        Object.freeze({
          nodeId: operand.nodeId,
          nodeResultRevision: operand.resultRevision,
          status: "complete" as const,
        }),
      ),
    ),
    admittedClaimSetRevision,
    lifecycleCertificateSetRevision,
    lifecycleCertificates: Object.freeze([...input.lifecycleCertificates]),
    claims,
    usableClaimCount: new Set(
      usableClaims.map((claim) => claim.claimIdentityRevision),
    ).size,
    minimumUsableClaimCount: 1 as const,
    coverageBasis: "all_answer_operands_complete" as const,
  };
  return Object.freeze({
    ...identity,
    certificateRevision: hashCanonicalJsonV1(identity as never),
  });
}

function executeDuration(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
  executionIdentity: Readonly<{
    program: MemoryEvidenceExecutionProgramV1;
    programRevision: string;
    selectorSnapshotRevision: string;
    stateProgramRevision: string;
    resolvedStateFrameRevision: string;
    sourceLockDigest: string;
  }>,
): MemoryEvidenceExecutionNodeResultV1 {
  if (firstIncomplete(operands)) return incompleteFromOperands(node, operands);
  const request = node.durationRequest;
  if (
    !request ||
    request.endpointContract.groupPolicy !== "union_bound_operands" ||
    (request.endpointPolicy === "between_evidence") !==
      (request.endpointContract.kind === "distinct_evidence_pair") ||
    (request.endpointPolicy === "evidence_to_query_anchor") !==
      (request.endpointContract.kind === "evidence_to_host_anchor")
  ) {
    return result(
      node,
      "unsupported",
      flattenValues(operands),
      flattenHistory(operands),
      flattenConflicts(operands),
      "duration_endpoint_ambiguous",
      flattenProofs(operands),
    );
  }
  const eligible = operands.flatMap((operand) =>
    observationValues([operand]).filter(
      (value) =>
        value.modality === "observed" &&
        value.polarity === "positive" &&
        new Set(["assert", "update", "confirm"]).has(value.predicateKind),
    ),
  );
  const endpoints = orderDurationEndpoints(request, [
    ...new Map(eligible.map((value) => [value.claimIdentity, value])).values(),
  ]);
  if (endpoints.length !== request.endpointContract.evidenceEndpointCount) {
    return result(
      node,
      "partial",
      endpoints,
      endpoints,
      [],
      "duration_endpoint_ambiguous",
      flattenProofs(operands),
    );
  }
  if (
    endpoints.some(
      (value) =>
        !value.bindingRevision.trim() ||
        !value.eventTimeInterval ||
        !value.eventIdentity?.trim(),
    )
  ) {
    return result(
      node,
      "partial",
      endpoints,
      [],
      [],
      "clock_incomplete",
      flattenProofs(operands),
    );
  }
  if (
    request.endpointContract.kind === "distinct_evidence_pair" &&
    (new Set(endpoints.map((value) => value.eventIdentity)).size !== 2 ||
      endpoints[0]?.durationEndpointRole !== "start" ||
      endpoints[1]?.durationEndpointRole !== "end")
  ) {
    return result(
      node,
      "partial",
      endpoints,
      endpoints,
      [],
      "duration_endpoint_ambiguous",
      flattenProofs(operands),
    );
  }
  if (
    endpoints.some((endpoint) => endpoint.eventTimeCutoffStatus === "straddles")
  ) {
    return result(
      node,
      "partial",
      endpoints,
      [],
      [],
      "temporal_interval_straddles_cutoff",
      flattenProofs(operands),
    );
  }
  const clock = temporalClock(endpoints);
  if (clock === "mixed") {
    return result(
      node,
      "partial",
      endpoints,
      [],
      [],
      "mixed_clock",
      flattenProofs(operands),
    );
  }
  if (clock === "incomplete") {
    return result(
      node,
      "partial",
      endpoints,
      [],
      [],
      "clock_incomplete",
      flattenProofs(operands),
    );
  }
  if (
    request.endpointPolicy === "evidence_to_query_anchor" &&
    clock !== "event"
  ) {
    return result(
      node,
      "partial",
      endpoints,
      [],
      [],
      "clock_incomplete",
      flattenProofs(operands),
    );
  }
  if (
    request.endpointContract.kind === "distinct_evidence_pair" &&
    endpoints[0]?.eventTimeInterval &&
    endpoints[1]?.eventTimeInterval &&
    endpoints[0].eventTimeInterval.upper > endpoints[1].eventTimeInterval.lower
  ) {
    return result(
      node,
      "partial",
      endpoints,
      endpoints,
      [],
      "duration_endpoint_ambiguous",
      flattenProofs(operands),
    );
  }
  const endpointCertificate = compileDurationEndpointCertificateV1({
    request,
    endpoints,
    ...executionIdentity,
  });
  if (!endpointCertificate) {
    return result(
      node,
      "partial",
      endpoints,
      endpoints,
      [],
      "duration_endpoint_ambiguous",
      flattenProofs(operands),
    );
  }
  const start = executionInterval(
    endpoints[0] as MemoryEvidenceExecutionObservationValueV1,
    clock,
  );
  const end =
    request.endpointPolicy === "evidence_to_query_anchor"
      ? queryAnchorInterval(request.queryAnchor)
      : executionInterval(
          endpoints[1] as MemoryEvidenceExecutionObservationValueV1,
          clock,
        );
  if (request.endpointPolicy === "evidence_to_query_anchor" && end === null) {
    return result(
      node,
      "unsupported",
      endpoints,
      [],
      [],
      "temporal_anchor_unbound",
      flattenProofs(operands),
    );
  }
  if (!start || !end) return incompleteFromOperands(node, operands);
  if (end.upper <= start.lower) {
    return result(
      node,
      "conflict",
      endpoints,
      [],
      endpoints,
      "duration_end_before_start",
      flattenProofs(operands),
    );
  }
  const unit = request.unit === "auto" ? ("day" as const) : request.unit;
  const exact = start.precision !== "year" && end.precision !== "year";
  const duration = exact
    ? exactDurationValue(
        node,
        endpoints,
        start.lower,
        end.lower,
        unit,
        request,
        endpointCertificate,
      )
    : intervalDurationValue(
        node,
        endpoints,
        start,
        end,
        unit,
        request,
        endpointCertificate,
      );
  return result(
    node,
    exact ? "complete" : "partial",
    [duration, ...endpoints],
    [],
    [],
    exact ? undefined : "duration_precision_insufficient",
    [
      ...flattenProofs(operands),
      request.requestRevision,
      endpointCertificate.certificateRevision,
    ],
  );
}

function orderDurationEndpoints(
  request: NonNullable<MemoryEvidenceExecutionNodeV1["durationRequest"]>,
  endpoints: readonly MemoryEvidenceExecutionObservationValueV1[],
): readonly MemoryEvidenceExecutionObservationValueV1[] {
  if (request.endpointContract.kind === "evidence_to_host_anchor") {
    return Object.freeze([...endpoints]);
  }
  const roleOrder = new Map<
    MemoryStateBoundObservationV2["durationEndpointRole"],
    number
  >([
    ["start", 0],
    ["end", 1],
    ["evidence", 2],
    ["not_applicable", 3],
  ]);
  return Object.freeze(
    [...endpoints].sort(
      (left, right) =>
        (roleOrder.get(left.durationEndpointRole) ?? 4) -
          (roleOrder.get(right.durationEndpointRole) ?? 4) ||
        left.claimIdentity.localeCompare(right.claimIdentity),
    ),
  );
}

function compileDurationEndpointCertificateV1(input: {
  request: NonNullable<MemoryEvidenceExecutionNodeV1["durationRequest"]>;
  endpoints: readonly MemoryEvidenceExecutionObservationValueV1[];
  programRevision: string;
  selectorSnapshotRevision: string;
  stateProgramRevision: string;
  resolvedStateFrameRevision: string;
  sourceLockDigest: string;
}): MemoryEvidenceDurationEndpointBindingCertificateV1 | null {
  const { request, endpoints } = input;
  if (
    endpoints.length !== request.endpointContract.evidenceEndpointCount ||
    endpoints.some(
      (endpoint) =>
        !endpoint.eventIdentity ||
        !endpoint.eventIdentityBasis ||
        !endpoint.eventTimeInterval ||
        !endpoint.bindingRevision.trim(),
    ) ||
    !input.programRevision.trim() ||
    !input.selectorSnapshotRevision.trim() ||
    !input.stateProgramRevision.trim() ||
    !input.resolvedStateFrameRevision.trim() ||
    !input.sourceLockDigest.trim()
  ) {
    return null;
  }
  const expectedAnchorRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-duration-query-anchor.v1",
    queryAnchor: request.queryAnchor,
  } as never);
  if (
    request.endpointContract.kind === "evidence_to_host_anchor" &&
    request.endpointContract.anchorRevision !== expectedAnchorRevision
  ) {
    return null;
  }
  const identity = {
    certificateVersion:
      "paw.memory-duration-endpoint-binding-certificate.v1" as const,
    requestRevision: request.requestRevision,
    programRevision: input.programRevision,
    selectorSnapshotRevision: input.selectorSnapshotRevision,
    stateProgramRevision: input.stateProgramRevision,
    resolvedStateFrameRevision: input.resolvedStateFrameRevision,
    sourceLockDigest: input.sourceLockDigest,
    endpointContractKind: request.endpointContract.kind,
    endpointValueIds: Object.freeze(endpoints.map((item) => item.valueId)),
    endpointClaimIdentities: Object.freeze(
      endpoints.map((item) => item.claimIdentity),
    ),
    endpointEventIdentities: Object.freeze(
      endpoints.map((item) => item.eventIdentity as string),
    ),
    endpointIdentityBases: Object.freeze(
      endpoints.map((item) => item.eventIdentityBasis as
        | "stable_event_key"
        | "typed_role_interval"),
    ),
    endpointTimeBases: Object.freeze(
      endpoints.map((item) => item.eventTimeBasis),
    ),
    endpointRoles: Object.freeze(
      endpoints.map((item) => item.durationEndpointRole),
    ),
    endpointRequirementIds: Object.freeze(
      endpoints.map((item) => item.requirementId),
    ),
    endpointSlotIds: Object.freeze(endpoints.map((item) => item.slotId)),
    endpointBindingRevisions: Object.freeze(
      endpoints.map((item) => item.bindingRevision),
    ),
    endpointStateBindingCertificateIds: Object.freeze(
      endpoints.map((item) => item.stateBindingCertificateId),
    ),
    endpointIntervals: Object.freeze(
      endpoints.map(
        (item) => item.eventTimeInterval as MemoryStateEventTimeIntervalV2,
      ),
    ),
    ...(request.endpointContract.kind === "evidence_to_host_anchor"
      ? { anchorRevision: request.endpointContract.anchorRevision }
      : {}),
    closureBasis: "closed_endpoint_set" as const,
  };
  return Object.freeze({
    ...identity,
    certificateRevision: hashCanonicalJsonV1(identity as never),
  });
}

function queryAnchorInterval(
  anchor: string | null | undefined,
): ExecutionTemporalIntervalV1 | null {
  if (!anchor || !Number.isFinite(Date.parse(anchor))) return null;
  const lower = new Date(anchor);
  const calendarDay = new Date(
    Date.UTC(lower.getUTCFullYear(), lower.getUTCMonth(), lower.getUTCDate()),
  );
  return Object.freeze({
    lower: calendarDay.toISOString(),
    upper: new Date(calendarDay.getTime() + 86_400_000).toISOString(),
    precision: "day" as const,
  });
}

function result(
  node: MemoryEvidenceExecutionNodeV1,
  status: MemoryEvidenceExecutionNodeResultStatusV1,
  values: readonly MemoryEvidenceExecutionValueV1[],
  history: readonly MemoryEvidenceExecutionObservationValueV1[],
  conflicts: readonly MemoryEvidenceExecutionObservationValueV1[],
  reason: MemoryEvidenceExecutionResultReasonV1 | undefined,
  proofs: readonly string[],
): MemoryEvidenceExecutionNodeResultV1 {
  const provenanceEvidenceRefs = Object.freeze([
    ...new Set(
      [...values, ...history, ...conflicts].flatMap((value) =>
        value.kind === "observation" ? [value.evidenceRef] : [],
      ),
    ),
  ]);
  const identity = {
    nodeId: node.nodeId,
    operation: node.operation,
    status,
    ...(reason === undefined ? {} : { reason }),
    values: Object.freeze([...values]),
    history: Object.freeze([...history]),
    conflicts: Object.freeze([...conflicts]),
    provenanceEvidenceRefs,
    completionProofRevisions: Object.freeze([...new Set(proofs)]),
  };
  return Object.freeze({
    ...identity,
    resultRevision: hashCanonicalJsonV1(identity as never),
  });
}

function incompleteFromOperands(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): MemoryEvidenceExecutionNodeResultV1 {
  const status = propagatedStatus(operands);
  return result(
    node,
    status,
    flattenValues(operands),
    flattenHistory(operands),
    flattenConflicts(operands),
    "operand_incomplete",
    flattenProofs(operands),
  );
}

function propagatedStatus(
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): MemoryEvidenceExecutionNodeResultStatusV1 {
  if (operands.some((operand) => operand.status === "conflict"))
    return "conflict";
  if (operands.some((operand) => operand.status === "unsupported"))
    return "unsupported";
  if (operands.every((operand) => operand.status === "missing"))
    return "missing";
  return "partial";
}

function firstIncomplete(
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): MemoryEvidenceExecutionNodeResultV1 | undefined {
  return operands.find((operand) => operand.status !== "complete");
}

function observationValue(
  requirementId: string,
  observation: MemoryStateBoundObservationV2,
  certificate: MemoryStateBindingCertificateV1 | undefined,
): MemoryEvidenceExecutionObservationValueV1 {
  if (
    !certificate ||
    certificate.observationId !== observation.observationId ||
    certificate.bindingRevision !== observation.bindingRevision
  ) {
    throw namedError("MemoryEvidenceExecutionRuntimeCertificateInvalid");
  }
  const valueText = observation.valueText;
  const exactValueSpans = Object.freeze(
    observation.valueSpans.map((span) => ({
      start: span.start,
      end: span.end,
      textDigest: span.textDigest,
    })),
  );
  const exactEventTimeSpans = Object.freeze(
    observation.eventTimeSpans.map((span) => ({
      start: span.start,
      end: span.end,
      textDigest: span.textDigest,
    })),
  );
  const claimIdentity = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-bound-claim-identity.v1",
    sourceId: observation.sourceId,
    evidenceRef: observation.evidenceRef,
    contentDigest: observation.contentDigest,
    valueSpans: exactValueSpans,
    eventTimeSpans: exactEventTimeSpans,
    predicateKind: observation.predicateKind,
    polarity: observation.polarity,
    modality: observation.modality,
  } as never);
  const eventIdentity =
    observation.eventTimeInterval &&
    (observation.eventKey?.trim() ||
      observation.durationEndpointRole !== "not_applicable")
      ? hashCanonicalJsonV1({
          schemaVersion: "paw.memory-semantic-event-endpoint-identity.v2",
          eventTimeBasis: observation.eventTimeBasis,
          ...(observation.eventKey?.trim()
            ? { stableEventKey: observation.eventKey.trim() }
            : {
                typedDurationEndpointRole:
                  observation.durationEndpointRole,
                eventTimeInterval: observation.eventTimeInterval,
              }),
        } as never)
      : undefined;
  const eventIdentityBasis =
    eventIdentity === undefined
      ? undefined
      : observation.eventKey?.trim()
        ? ("stable_event_key" as const)
        : ("typed_role_interval" as const);
  const identity = {
    requirementId,
    slotId: observation.slotId,
    claimIdentity,
    ...(eventIdentity === undefined ? {} : { eventIdentity }),
    ...(eventIdentityBasis === undefined ? {} : { eventIdentityBasis }),
    eventTimeBasis: observation.eventTimeBasis,
    durationEndpointRole: observation.durationEndpointRole,
    lifecycleRelation: observation.lifecycleRelation,
    ...(observation.lifecycleTargetEvidenceRef === undefined
      ? {}
      : {
          lifecycleTargetEvidenceRef:
            observation.lifecycleTargetEvidenceRef,
        }),
    valueText,
    valueKey: normalizeValue(valueText),
    valueComposition: observation.valueComposition,
    predicateKind: observation.predicateKind,
    polarity: observation.polarity,
    modality: observation.modality,
    evidenceRef: observation.evidenceRef,
    sourceId: observation.sourceId,
    ...(observation.eventKey === undefined
      ? {}
      : { eventKey: observation.eventKey }),
    ...(observation.eventTimeInterval === undefined
      ? {}
      : { eventTimeInterval: observation.eventTimeInterval }),
    ...(observation.eventTimeCutoffStatus === undefined
      ? {}
      : { eventTimeCutoffStatus: observation.eventTimeCutoffStatus }),
    ...(observation.observedAt === undefined
      ? {}
      : { observedAt: observation.observedAt }),
    ...(observation.episodeOrder === undefined
      ? {}
      : { episodeOrder: observation.episodeOrder }),
    ...(observation.turnOrder === undefined
      ? {}
      : { turnOrder: observation.turnOrder }),
    bindingRevision: observation.bindingRevision,
    stateBindingCertificateId: certificate.certificateId,
  };
  return Object.freeze({
    kind: "observation",
    valueId: hashCanonicalJsonV1(identity as never),
    ...identity,
  });
}

function validateExecutionBindingCertificates(
  program: MemoryEvidenceExecutionProgramV1,
  slots: readonly MemoryStateSlotSpecV2[],
  frame: MemoryResolvedStateFrameV2,
  validated: readonly MemoryStateValidatedObservationV1[],
  validationContexts: readonly MemoryStateBindingCertificateValidationInputV1[],
): Readonly<{
  certificateByObservationId: ReadonlyMap<
    string,
    MemoryStateBindingCertificateV1
  >;
  frameCertificates: readonly MemoryStateBindingCertificateV1[];
  registryRevision: string;
}> {
  const frameObservations = frame.slots.flatMap((slot) => [
      ...slot.current,
      ...slot.history,
      ...slot.conflicts,
    ]);
  const frameById = new Map(
    frameObservations.map((observation) => [
      observation.observationId,
      observation,
    ]),
  );
  const slotById = new Map(slots.map((slot) => [slot.slotId, slot]));
  const allCertificateByObservationId = new Map<
    string,
    MemoryStateBindingCertificateV1
  >();
  const contextByObservationId = new Map<
    string,
    MemoryStateBindingCertificateValidationInputV1
  >();
  for (const context of validationContexts) {
    for (const observation of context.proposedObservations) {
      if (contextByObservationId.has(observation.observationId)) {
        throw namedError("MemoryEvidenceExecutionRuntimeCertificateInvalid");
      }
      contextByObservationId.set(observation.observationId, context);
    }
  }
  if (
    frameById.size !== frameObservations.length ||
    slotById.size !== slots.length ||
    validated.length < frameObservations.length ||
    (validated.length > 0 && validationContexts.length < 1)
  ) {
    throw namedError("MemoryEvidenceExecutionRuntimeCertificateInvalid");
  }
  const usedContextIdentities = new Map<string, Readonly<Record<string, unknown>>>();
  let transactionQueryRevision: string | undefined;
  for (const item of validated) {
    const frameObservation = frameById.get(item.observation.observationId);
    const validationContext = contextByObservationId.get(
      item.observation.observationId,
    );
    const { certificateId, ...certificateIdentity } = item.certificate;
    if (
      !validationContext ||
      allCertificateByObservationId.has(item.observation.observationId) ||
      (frameObservation !== undefined &&
        hashCanonicalJsonV1(frameObservation as never) !==
          hashCanonicalJsonV1(item.observation as never)) ||
      item.certificate.observationId !== item.observation.observationId ||
      item.certificate.bindingRevision !== item.observation.bindingRevision ||
      !certificateId.trim() ||
      hashCanonicalJsonV1(certificateIdentity as never) !== certificateId
    ) {
      throw namedError("MemoryEvidenceExecutionRuntimeCertificateInvalid");
    }
    const contextSlotById = new Map(
      validationContext.slots.map((slot) => [slot.slotId, slot]),
    );
    const queryRevision = hashCanonicalJsonV1(validationContext.query as never);
    let contextOriginRevision: string;
    try {
      contextOriginRevision = compileMemoryQueryAnswerOriginV1(
        validationContext.query,
      ).originRevision;
    } catch {
      throw namedError("MemoryEvidenceExecutionRuntimeCertificateInvalid");
    }
    if (
      !validationContext.query.trim() ||
      validationContext.sourceLock.sourceLockDigest !== frame.sourceLockDigest ||
      contextOriginRevision !== program.originRevision ||
      contextSlotById.size !== validationContext.slots.length ||
      contextSlotById.size < 1 ||
      [...contextSlotById].some(([slotId, contextSlot]) => {
        const slot = slotById.get(slotId);
        return (
          !slot ||
          hashCanonicalJsonV1(contextSlot as never) !==
            hashCanonicalJsonV1(slot as never)
        );
      }) ||
      (transactionQueryRevision !== undefined &&
        transactionQueryRevision !== queryRevision)
    ) {
      throw namedError("MemoryEvidenceExecutionRuntimeCertificateInvalid");
    }
    transactionQueryRevision ??= queryRevision;
    try {
      validateMemoryStateBindingCertificateV1(item, validationContext);
    } catch {
      throw namedError("MemoryEvidenceExecutionRuntimeCertificateInvalid");
    }
    allCertificateByObservationId.set(
      item.observation.observationId,
      item.certificate,
    );
    const usedContextIdentity = {
      queryRevision,
      sourceLockDigest: validationContext.sourceLock.sourceLockDigest,
      slotRevisions: Object.freeze(
        [...validationContext.slots]
          .sort((left, right) => left.slotId.localeCompare(right.slotId))
          .map((slot) => slot.slotRevision),
      ),
      proposedBindingRevisions: Object.freeze(
        [...validationContext.proposedObservations]
          .sort((left, right) =>
            left.observationId.localeCompare(right.observationId),
          )
          .map((observation) => observation.bindingRevision),
      ),
      verificationRevision: validationContext.verification.verificationRevision,
    };
    const usedContextRevision = hashCanonicalJsonV1(
      usedContextIdentity as never,
    );
    usedContextIdentities.set(usedContextRevision, usedContextIdentity);
  }
  const frameCertificateByObservationId = new Map<
    string,
    MemoryStateBindingCertificateV1
  >();
  for (const observation of frameObservations) {
    const certificate = allCertificateByObservationId.get(
      observation.observationId,
    );
    if (!certificate) {
      throw namedError("MemoryEvidenceExecutionRuntimeCertificateInvalid");
    }
    frameCertificateByObservationId.set(observation.observationId, certificate);
  }
  const frameCertificateIds = Object.freeze(
    [...frameCertificateByObservationId.values()]
      .map((certificate) => certificate.certificateId)
      .sort(),
  );
  const reducerExcludedCertificateIds = Object.freeze(
    [...allCertificateByObservationId.entries()]
      .filter(([observationId]) => !frameById.has(observationId))
      .map(([, certificate]) => certificate.certificateId)
      .sort(),
  );
  const registryRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-state-binding-certificate-registry.v1",
    programRevision: program.programRevision,
    frameRevision: frame.frameRevision,
    transactionQueryRevision: transactionQueryRevision ?? null,
    contexts: Object.freeze(
      [...usedContextIdentities.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([contextRevision, context]) => ({
          contextRevision,
          ...context,
        })),
    ),
    frameCertificateIds,
    reducerExcludedCertificateIds,
  } as never);
  return Object.freeze({
    certificateByObservationId: frameCertificateByObservationId,
    frameCertificates: Object.freeze(
      frameCertificateIds.map((certificateId) => {
        const certificate = [...frameCertificateByObservationId.values()].find(
          (candidate) => candidate.certificateId === certificateId,
        );
        if (!certificate) {
          throw namedError("MemoryEvidenceExecutionRuntimeCertificateInvalid");
        }
        return certificate;
      }),
    ),
    registryRevision,
  });
}

function collectionValue(
  node: MemoryEvidenceExecutionNodeV1,
  members: readonly MemoryEvidenceExecutionValueV1[],
): MemoryEvidenceExecutionCollectionValueV1 {
  const memberValueIds = Object.freeze(members.map((value) => value.valueId));
  return Object.freeze({
    kind: "collection",
    valueId: hashCanonicalJsonV1({ nodeId: node.nodeId, memberValueIds }),
    memberValueIds,
  });
}

function dependencyValue(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
  members: readonly MemoryEvidenceExecutionValueV1[],
): MemoryEvidenceExecutionDependencyValueV1 {
  const identity = {
    nodeId: node.nodeId,
    relation:
      node.dependencyRelation === "responds_to" ||
      node.dependencyRelation === "supersedes"
        ? node.dependencyRelation
        : ("depends_on" as const),
    operandResultRevisions: Object.freeze(
      operands.map((operand) => operand.resultRevision),
    ),
    memberValueIds: Object.freeze(members.map((value) => value.valueId)),
  };
  return Object.freeze({
    kind: "dependency_record",
    valueId: hashCanonicalJsonV1(identity as never),
    ...identity,
  });
}

function comparisonValue(
  node: MemoryEvidenceExecutionNodeV1,
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): MemoryEvidenceExecutionComparisonValueV1 {
  const sides = Object.freeze(
    operands.map((operand, index) =>
      Object.freeze({
        operandRole:
          index === 0
            ? ("left" as const)
            : index === 1
              ? ("right" as const)
              : ("criterion" as const),
        valueIds: Object.freeze(operand.values.map((value) => value.valueId)),
      }),
    ),
  );
  const left = observationValues(operands.slice(0, 1));
  const right = observationValues(operands.slice(1, 2));
  const relation =
    left.length === 1 && right.length === 1
      ? left[0]?.valueKey === right[0]?.valueKey
        ? ("equal" as const)
        : ("different" as const)
      : undefined;
  const identity = {
    nodeId: node.nodeId,
    sides,
    ...(relation ? { relation } : {}),
  };
  return Object.freeze({
    kind: "comparison",
    valueId: hashCanonicalJsonV1(identity as never),
    sides,
    ...(relation ? { relation } : {}),
  });
}

function aggregateValue(
  node: MemoryEvidenceExecutionNodeV1,
  members: readonly MemoryEvidenceExecutionObservationValueV1[],
  closedWorld: boolean,
  materializationExact: boolean,
  request: NonNullable<MemoryEvidenceExecutionNodeV1["aggregateRequest"]>,
  numeric?: Readonly<{
    decimal: string;
    safeIntegerValue?: number;
    unit: string;
  }>,
): MemoryEvidenceExecutionAggregateValueV1 {
  const memberValueIds = Object.freeze(members.map((value) => value.valueId));
  const identity = {
    nodeId: node.nodeId,
    operator: request.operator,
    aggregationUnit: request.aggregationUnit,
    countBasis: request.countBasis,
    memberValueIds,
    lowerBoundCount: members.length,
    closedWorld,
    materializationExact,
    ...(numeric === undefined
      ? {}
      : {
          numericDecimal: numeric.decimal,
          ...(numeric.safeIntegerValue === undefined
            ? {}
            : { numericValue: numeric.safeIntegerValue }),
          numericUnit: numeric.unit,
        }),
  };
  return Object.freeze({
    kind: "aggregate",
    valueId: hashCanonicalJsonV1(identity as never),
    ...identity,
  });
}

type ExecutionTemporalClockV1 = "event" | "observed" | "mixed" | "incomplete";

interface ExecutionTemporalIntervalV1 {
  readonly lower: string;
  readonly upper: string;
  readonly precision: "instant" | "day" | "year";
}

function temporalClock(
  values: readonly MemoryEvidenceExecutionObservationValueV1[],
): ExecutionTemporalClockV1 {
  const eventCount = values.filter((value) => value.eventTimeInterval).length;
  if (eventCount > 0 && eventCount < values.length) return "mixed";
  if (eventCount === values.length && values.length > 0) return "event";
  if (
    values.length > 0 &&
    values.every((value) => value.observedAt !== undefined)
  ) {
    return "observed";
  }
  return "incomplete";
}

function executionInterval(
  value: MemoryEvidenceExecutionObservationValueV1,
  clock: ExecutionTemporalClockV1,
): ExecutionTemporalIntervalV1 | null {
  if (clock === "event" && value.eventTimeInterval) {
    return value.eventTimeInterval;
  }
  if (clock === "observed" && value.observedAt) {
    const lower = new Date(value.observedAt);
    return Object.freeze({
      lower: lower.toISOString(),
      upper: new Date(lower.getTime() + 1).toISOString(),
      precision: "instant" as const,
    });
  }
  return null;
}

function exactDurationValue(
  node: MemoryEvidenceExecutionNodeV1,
  endpoints: readonly MemoryEvidenceExecutionObservationValueV1[],
  start: string,
  end: string,
  unit: "day" | "week" | "month" | "year",
  request: MemoryEvidenceExecutionNodeV1["durationRequest"],
  endpointCertificate: MemoryEvidenceDurationEndpointBindingCertificateV1,
): MemoryEvidenceExecutionDurationValueV1 {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const days = (endDate.getTime() - startDate.getTime()) / 86_400_000;
  const value =
    unit === "day"
      ? days
      : unit === "week"
        ? days / 7
        : unit === "month"
          ? completedCalendarMonths(startDate, endDate)
          : completedCalendarYears(startDate, endDate);
  const identity = {
    nodeId: node.nodeId,
    precision: "exact" as const,
    unit,
    value,
    endpointValueIds: Object.freeze(endpoints.map((item) => item.valueId)),
    endpointPolicy: request?.endpointPolicy ?? "between_evidence",
    endpointCertificateRevision: endpointCertificate.certificateRevision,
    endpointCertificate,
    ...(request?.queryAnchor ? { queryAnchor: request.queryAnchor } : {}),
  };
  return Object.freeze({
    kind: "temporal_duration",
    valueId: hashCanonicalJsonV1(identity as never),
    ...identity,
  });
}

function intervalDurationValue(
  node: MemoryEvidenceExecutionNodeV1,
  endpoints: readonly MemoryEvidenceExecutionObservationValueV1[],
  start: ExecutionTemporalIntervalV1,
  end: ExecutionTemporalIntervalV1,
  unit: "day" | "week" | "month" | "year",
  request: MemoryEvidenceExecutionNodeV1["durationRequest"],
  endpointCertificate: MemoryEvidenceDurationEndpointBindingCertificateV1,
): MemoryEvidenceExecutionDurationValueV1 {
  const minimumDays = Math.max(
    0,
    (Date.parse(end.lower) - Date.parse(start.upper)) / 86_400_000,
  );
  const maximumDays = Math.max(
    0,
    (Date.parse(end.upper) - Date.parse(start.lower)) / 86_400_000,
  );
  const [minimum, maximum] =
    unit === "day"
      ? [minimumDays, maximumDays]
      : unit === "week"
        ? [minimumDays / 7, maximumDays / 7]
        : unit === "month"
          ? [minimumDays / 31, maximumDays / 28]
          : [minimumDays / 366, maximumDays / 365];
  const identity = {
    nodeId: node.nodeId,
    precision: "interval" as const,
    unit,
    minimum,
    maximum,
    endpointValueIds: Object.freeze(endpoints.map((item) => item.valueId)),
    endpointPolicy: request?.endpointPolicy ?? "between_evidence",
    endpointCertificateRevision: endpointCertificate.certificateRevision,
    endpointCertificate,
    ...(request?.queryAnchor ? { queryAnchor: request.queryAnchor } : {}),
  };
  return Object.freeze({
    kind: "temporal_duration",
    valueId: hashCanonicalJsonV1(identity as never),
    ...identity,
  });
}

function completedCalendarMonths(start: Date, end: Date): number {
  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return months;
}

function completedCalendarYears(start: Date, end: Date): number {
  let years = end.getUTCFullYear() - start.getUTCFullYear();
  if (
    end.getUTCMonth() < start.getUTCMonth() ||
    (end.getUTCMonth() === start.getUTCMonth() &&
      end.getUTCDate() < start.getUTCDate())
  ) {
    years -= 1;
  }
  return years;
}

function preferenceValue(
  node: MemoryEvidenceExecutionNodeV1,
  positive: readonly MemoryEvidenceExecutionObservationValueV1[],
  negative: readonly MemoryEvidenceExecutionObservationValueV1[],
  goals: readonly MemoryEvidenceExecutionObservationValueV1[],
  oneOff: readonly MemoryEvidenceExecutionObservationValueV1[],
): MemoryEvidenceExecutionPreferenceValueV1 {
  const identity = {
    nodeId: node.nodeId,
    positiveValueIds: Object.freeze(positive.map((value) => value.valueId)),
    negativeValueIds: Object.freeze(negative.map((value) => value.valueId)),
    goalValueIds: Object.freeze(goals.map((value) => value.valueId)),
    oneOffValueIds: Object.freeze(oneOff.map((value) => value.valueId)),
  };
  return Object.freeze({
    kind: "preference_profile",
    valueId: hashCanonicalJsonV1(identity as never),
    ...identity,
  });
}

function personalizationValue(
  node: MemoryEvidenceExecutionNodeV1,
  explicitPositive: readonly MemoryEvidenceExecutionObservationValueV1[],
  explicitNegative: readonly MemoryEvidenceExecutionObservationValueV1[],
  goals: readonly MemoryEvidenceExecutionObservationValueV1[],
  contextual: readonly MemoryEvidenceExecutionObservationValueV1[],
  oneOff: readonly MemoryEvidenceExecutionObservationValueV1[],
  coverageCertificate?: MemoryEvidencePersonalizationCoverageCertificateV1,
): MemoryEvidenceExecutionPersonalizationValueV1 {
  const identity = {
    nodeId: node.nodeId,
    explicitPositiveValueIds: Object.freeze(
      explicitPositive.map((value) => value.valueId),
    ),
    explicitNegativeValueIds: Object.freeze(
      explicitNegative.map((value) => value.valueId),
    ),
    goalValueIds: Object.freeze(goals.map((value) => value.valueId)),
    contextualConstraintValueIds: Object.freeze(
      contextual.map((value) => value.valueId),
    ),
    oneOffValueIds: Object.freeze(oneOff.map((value) => value.valueId)),
    scope: "answer_personalization" as const,
    ...(coverageCertificate === undefined
      ? {}
      : {
          coverageCertificateRevision: coverageCertificate.certificateRevision,
          coverageCertificate,
        }),
  };
  return Object.freeze({
    kind: "personalization_profile",
    valueId: hashCanonicalJsonV1(identity as never),
    ...identity,
  });
}

function observationValues(
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): readonly MemoryEvidenceExecutionObservationValueV1[] {
  return uniqueObservationValues(
    operands.flatMap((operand) =>
      operand.values.filter(
        (value): value is MemoryEvidenceExecutionObservationValueV1 =>
          value.kind === "observation",
      ),
    ),
  );
}

function eventMaxima(
  values: readonly MemoryEvidenceExecutionObservationValueV1[],
): readonly MemoryEvidenceExecutionObservationValueV1[] {
  return values.filter((candidate) =>
    values.every((other) => {
      const comparison = compareIntervals(
        candidate.eventTimeInterval,
        other.eventTimeInterval,
      );
      return comparison !== null && comparison >= 0;
    }),
  );
}

function observedMaxima(
  values: readonly MemoryEvidenceExecutionObservationValueV1[],
): readonly MemoryEvidenceExecutionObservationValueV1[] {
  if (values.some((value) => value.observedAt === undefined))
    return Object.freeze([]);
  const ordered = [...values].sort(
    (left, right) =>
      (right.observedAt as string).localeCompare(left.observedAt as string) ||
      (right.episodeOrder ?? -1) - (left.episodeOrder ?? -1) ||
      (right.turnOrder ?? -1) - (left.turnOrder ?? -1),
  );
  const first = ordered[0];
  if (!first) return Object.freeze([]);
  return Object.freeze(
    ordered.filter(
      (value) =>
        value.observedAt === first.observedAt &&
        (value.episodeOrder ?? -1) === (first.episodeOrder ?? -1) &&
        (value.turnOrder ?? -1) === (first.turnOrder ?? -1),
    ),
  );
}

function compareIntervals(
  left: MemoryStateEventTimeIntervalV2 | undefined,
  right: MemoryStateEventTimeIntervalV2 | undefined,
): number | null {
  if (!left || !right) return null;
  if (left.lower >= right.upper) return 1;
  if (right.lower >= left.upper) return -1;
  return 0;
}

function orderHistory(
  values: readonly MemoryEvidenceExecutionObservationValueV1[],
): readonly MemoryEvidenceExecutionObservationValueV1[] {
  return Object.freeze(
    [...values].sort((left, right) => {
      if (left.eventTimeInterval && right.eventTimeInterval) {
        return left.eventTimeInterval.lower.localeCompare(
          right.eventTimeInterval.lower,
        );
      }
      if (left.eventTimeInterval || right.eventTimeInterval)
        return left.eventTimeInterval ? -1 : 1;
      return (
        (left.observedAt ?? "").localeCompare(right.observedAt ?? "") ||
        (left.episodeOrder ?? -1) - (right.episodeOrder ?? -1) ||
        (left.turnOrder ?? -1) - (right.turnOrder ?? -1)
      );
    }),
  );
}

function uniqueObservations(
  observations: readonly MemoryStateBoundObservationV2[],
): readonly MemoryStateBoundObservationV2[] {
  return [
    ...new Map(observations.map((item) => [item.observationId, item])).values(),
  ];
}

function uniqueObservationValues(
  values: readonly MemoryEvidenceExecutionObservationValueV1[],
): readonly MemoryEvidenceExecutionObservationValueV1[] {
  return [...new Map(values.map((value) => [value.valueId, value])).values()];
}

function dedupeAggregateObservations(
  values: readonly MemoryEvidenceExecutionObservationValueV1[],
  aggregationUnit: NonNullable<
    MemoryEvidenceExecutionNodeV1["aggregateRequest"]
  >["aggregationUnit"],
): Readonly<{
  eligible: readonly MemoryEvidenceExecutionObservationValueV1[];
  members: readonly MemoryEvidenceExecutionObservationValueV1[];
  conflicts: readonly MemoryEvidenceExecutionObservationValueV1[];
  excluded: readonly MemoryEvidenceExecutionObservationValueV1[];
  unitProofExact: boolean;
}> {
  const eligible = Object.freeze(
    uniqueObservationValues(
      values.filter(
        (value) =>
          value.modality === "observed" &&
          value.polarity === "positive" &&
          new Set(["assert", "update", "confirm"]).has(value.predicateKind),
      ),
    ),
  );
  const excluded = Object.freeze(
    values.filter((value) => !eligible.includes(value)),
  );
  const sorted = [...eligible].sort((left, right) =>
    left.valueId.localeCompare(right.valueId),
  );
  const unitKey = (value: MemoryEvidenceExecutionObservationValueV1): string =>
    aggregationUnit === "event"
      ? value.eventKey?.trim()
        ? `event:${value.eventKey}`
        : `observation:${value.valueId}`
      : aggregationUnit === "numeric_quantity"
        ? `observation:${value.valueId}`
        : value.valueKey;
  const members = Object.freeze([
    ...new Map(sorted.map((value) => [unitKey(value), value])).values(),
  ]);
  // Event identity establishes independence, not mutual exclusion. One event
  // can legitimately contribute several aggregate members; true state
  // contradictions arrive as conflict operand results before this operation.
  return Object.freeze({
    eligible,
    members,
    conflicts: Object.freeze([]),
    excluded,
    unitProofExact:
      aggregationUnit === "event"
        ? eligible.every((value) => Boolean(value.eventKey?.trim()))
        : aggregationUnit !== "entity",
  });
}

function aggregateMaterializationExactV1(
  values: readonly MemoryEvidenceExecutionObservationValueV1[],
  coverageByRequirement: ReadonlyMap<
    string,
    MemoryEvidenceExecutionRequirementCoverageV1
  >,
): boolean {
  if (values.length === 0) return false;
  const refsByRequirement = new Map<string, Set<string>>();
  for (const value of values) {
    const refs =
      refsByRequirement.get(value.requirementId) ?? new Set<string>();
    refs.add(value.evidenceRef);
    refsByRequirement.set(value.requirementId, refs);
  }
  return [...refsByRequirement].every(([requirementId, refs]) => {
    const coverage = coverageByRequirement.get(requirementId);
    if (!coverage || coverage.selectedEvidenceCount !== refs.size) return false;
    return (
      coverage.selectedEvidenceSetRevision ===
      hashCanonicalJsonV1({
        schemaVersion: "paw.memory-selected-evidence-set.v1",
        evidenceRefs: Object.freeze([...refs].sort()),
      } as never)
    );
  });
}

function parseNumericQuantityV1(
  observation: MemoryEvidenceExecutionObservationValueV1,
): Readonly<{ coefficient: bigint; scale: number; unit: string }> | null {
  if (observation.valueComposition === "ordered_tuple") return null;
  const value = observation.valueText.normalize("NFKC").trim();
  const match =
    /^(?:(USD|GBP|EUR|JPY|CNY|[$£€¥])\s*)?([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s*(%|percent(?:age)?|USD|dollars?|GBP|pounds?|EUR|euros?|JPY|yen|CNY|RMB|yuan|hours?|hrs?|minutes?|days?|weeks?|months?|years?|miles?|mi|kilometers?|km|pages?))?$/iu.exec(
      value,
    );
  if (!match) return null;
  const numericToken = (match[2] ?? "").replace(/,/gu, "");
  const numericMatch = /^([-+]?)(\d+)(?:\.(\d+))?$/u.exec(numericToken);
  if (!numericMatch) return null;
  const fraction = numericMatch[3] ?? "";
  const coefficient = BigInt(
    `${numericMatch[1] === "-" ? "-" : ""}${numericMatch[2]}${fraction}`,
  );
  const unitFor = (token: string | undefined): string | null => {
    const normalized = token?.toLocaleLowerCase("en-US");
    if (!normalized) return null;
    if (new Set(["$", "usd", "dollar", "dollars"]).has(normalized))
      return "USD";
    if (new Set(["£", "gbp", "pound", "pounds"]).has(normalized)) return "GBP";
    if (new Set(["€", "eur", "euro", "euros"]).has(normalized)) return "EUR";
    if (new Set(["¥", "jpy", "yen"]).has(normalized)) return "JPY";
    if (new Set(["cny", "rmb", "yuan"]).has(normalized)) return "CNY";
    if (new Set(["%", "percent", "percentage"]).has(normalized))
      return "percent";
    if (/^(?:hours?|hrs?)$/u.test(normalized)) return "hour";
    if (/^minutes?$/u.test(normalized)) return "minute";
    if (/^days?$/u.test(normalized)) return "day";
    if (/^weeks?$/u.test(normalized)) return "week";
    if (/^months?$/u.test(normalized)) return "month";
    if (/^years?$/u.test(normalized)) return "year";
    if (/^(?:miles?|mi)$/u.test(normalized)) return "mile";
    if (/^(?:kilometers?|km)$/u.test(normalized)) return "kilometer";
    if (/^pages?$/u.test(normalized)) return "page";
    return null;
  };
  const prefixUnit = unitFor(match[1]);
  const suffixUnit = unitFor(match[3]);
  if (!prefixUnit && !suffixUnit) return null;
  if (prefixUnit && suffixUnit && prefixUnit !== suffixUnit) return null;
  const unit = prefixUnit ?? suffixUnit;
  if (!unit) return null;
  return Object.freeze({ coefficient, scale: fraction.length, unit });
}

function sumExactQuantitiesV1(
  quantities: readonly Readonly<{
    coefficient: bigint;
    scale: number;
    unit: string;
  }>[],
): Readonly<{
  decimal: string;
  safeIntegerValue?: number;
  unit: string;
}> {
  if (quantities.length < 1) {
    throw namedError("MemoryEvidenceExecutionAggregateQuantityInvalid");
  }
  const scale = Math.max(...quantities.map((quantity) => quantity.scale));
  const coefficient = quantities.reduce(
    (total, quantity) =>
      total +
      quantity.coefficient * 10n ** BigInt(Math.max(0, scale - quantity.scale)),
    0n,
  );
  const decimal = formatExactDecimalV1(coefficient, scale);
  const numeric = Number(decimal);
  const safeIntegerValue =
    /^-?\d+$/u.test(decimal) && Number.isSafeInteger(numeric)
      ? numeric
      : undefined;
  return Object.freeze({
    decimal,
    ...(safeIntegerValue === undefined ? {} : { safeIntegerValue }),
    unit: quantities[0]?.unit ?? "unknown",
  });
}

function formatExactDecimalV1(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  const integer = digits.slice(0, -scale) || "0";
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  if (!fraction) return `${negative ? "-" : ""}${integer}`;
  return `${negative ? "-" : ""}${integer}.${fraction}`;
}

function semanticObservationKey(
  value: MemoryEvidenceExecutionObservationValueV1,
): string {
  return `${value.valueKey}\0${value.predicateKind}\0${value.polarity}`;
}

function independenceKey(observation: MemoryStateBoundObservationV2): string {
  return observation.eventKey?.trim()
    ? `event:${observation.eventKey}`
    : `source:${observation.sourceId}\0episode:${observation.episodeOrder ?? "unknown"}`;
}

function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function flattenValues(
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): readonly MemoryEvidenceExecutionValueV1[] {
  return Object.freeze(operands.flatMap((operand) => operand.values));
}

function flattenHistory(
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): readonly MemoryEvidenceExecutionObservationValueV1[] {
  return Object.freeze(
    uniqueObservationValues(operands.flatMap((operand) => operand.history)),
  );
}

function flattenConflicts(
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): readonly MemoryEvidenceExecutionObservationValueV1[] {
  return Object.freeze(
    uniqueObservationValues(operands.flatMap((operand) => operand.conflicts)),
  );
}

function flattenProofs(
  operands: readonly MemoryEvidenceExecutionNodeResultV1[],
): readonly string[] {
  return Object.freeze([
    ...new Set(
      operands.flatMap((operand) => [
        operand.resultRevision,
        ...operand.completionProofRevisions,
      ]),
    ),
  ]);
}

function countStatuses(nodes: readonly MemoryEvidenceExecutionNodeResultV1[]) {
  const count = (status: MemoryEvidenceExecutionNodeResultStatusV1) =>
    nodes.filter((node) => node.status === status).length;
  return Object.freeze({
    completeNodeCount: count("complete"),
    partialNodeCount: count("partial"),
    missingNodeCount: count("missing"),
    conflictNodeCount: count("conflict"),
    unsupportedNodeCount: count("unsupported"),
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
