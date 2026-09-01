import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import type { MemoryEvidenceAuthorityV2 } from "./evidence-contracts.js";
import {
  PAW_MEMORY_EVIDENCE_SELECTOR_GROUP_POLICY_V1,
  compileMemoryEvidenceSelectorGroupsV1,
} from "./evidence-selector-groups.js";
import {
  type MemoryQueryAnswerOriginV1,
  compileMemoryQueryAnswerOriginV1,
} from "./query-answer-origin.js";
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./query-plan-contracts.js";

export const PAW_MEMORY_STATE_SLOT_COMPILER_VERSION_V2 =
  "paw.memory-state-slot-compiler.v2:query-bound-obligations" as const;
export const PAW_MEMORY_STATE_BINDER_VERSION_V2 =
  "paw.memory-state-binder.v2:locked-exact-spans-value-composition" as const;
export const PAW_MEMORY_STATE_REDUCER_VERSION_V2 =
  "paw.memory-state-reducer.v2:slot-isolated-proof-carrying" as const;
export const PAW_MEMORY_STATE_AUTHORITY_POLICY_VERSION_V2 =
  "paw.memory-state-authority.v2:origin-role-certificate" as const;

export type MemoryStateSlotOperationV2 =
  "lookup" | "collect" | "resolve_latest" | "preserve_history";

export type MemoryStateDerivedOperationKindV2 =
  "compare" | "aggregate" | "infer_preference" | "dependency_join";

export interface MemoryStateQueryAnchorV2 {
  readonly start: number;
  readonly end: number;
  readonly textDigest: string;
}

export interface MemoryStateSlotSpecV2 {
  readonly compilerVersion: typeof PAW_MEMORY_STATE_SLOT_COMPILER_VERSION_V2;
  readonly slotId: string;
  readonly requirementId: string;
  readonly groupId: string;
  readonly necessity: "required" | "contextual";
  readonly operation: MemoryStateSlotOperationV2;
  /** Answer/group operation is separate from this slot's temporal leaf. */
  readonly derivedAnswerOperation:
    "none" | "compare" | "aggregate" | "infer_preference";
  readonly queryAnchor: MemoryStateQueryAnchorV2;
  /** Planner semantics are immutable hints, never a model-authored state key. */
  readonly semanticDescriptor: Readonly<{
    label: string;
    searchText: string;
    descriptorRevision: string;
  }>;
  readonly roleConstraint: "user" | "assistant";
  readonly authorityMode:
    "user_fact" | "explicit_assistant_report" | "certified_dialogue_artifact";
  readonly temporalMode: MemoryEvidenceBoundTemporalConstraintV1["mode"];
  readonly evidenceTimeUpperBound: string | null;
  readonly durationEndpointContractKind:
    | "distinct_evidence_pair"
    | "evidence_to_host_anchor"
    | null;
  readonly coverageMode: "any" | "all" | "latest" | "convergent";
  readonly minimumIndependentEvidence: number;
  readonly dependencySlotIds: readonly string[];
  readonly dependencyRelation:
    "independent" | "depends_on" | "responds_to" | "supersedes";
  readonly originRevision: string;
  readonly temporalBindingRevision: string;
  readonly authorityPolicyRevision: typeof PAW_MEMORY_STATE_AUTHORITY_POLICY_VERSION_V2;
  readonly slotRevision: string;
}

export interface MemoryStateSourceLockItemV2 {
  readonly sourceId: string;
  readonly evidenceRef: string;
  readonly content: string;
  readonly authority: MemoryEvidenceAuthorityV2;
  readonly role: "user" | "assistant";
  readonly observedAt?: string;
  readonly episodeOrder?: number;
  readonly turnOrder?: number;
  readonly eventKey?: string;
  readonly certificateRevision?: string;
}

export interface MemoryStateSourceLockV2 {
  readonly items: readonly MemoryStateSourceLockItemV2[];
  readonly sourceLockDigest: string;
}

export interface MemoryStateExactSpanV2 {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly textDigest: string;
}

export interface MemoryStateEventTimeIntervalV2 {
  /** Inclusive UTC lower bound. */
  readonly lower: string;
  /** Exclusive UTC upper bound. */
  readonly upper: string;
  readonly precision: "instant" | "day" | "year";
}

export type MemoryStateEventTimeBasisV2 =
  | "explicit_span"
  | "source_session_contemporaneous"
  | "unbound";

export type MemoryStateDurationEndpointRoleV2 =
  | "start"
  | "end"
  | "evidence"
  | "not_applicable";

export type MemoryStateClaimLifecycleRelationV2 =
  | "none"
  | "retracts"
  | "supersedes"
  | "confirms";

export interface MemoryStateObservationProposalV2 {
  readonly slotId: string;
  readonly evidenceRef: string;
  readonly valueSpans: readonly Readonly<{ start: number; end: number }>[];
  readonly eventTimeSpans?: readonly Readonly<{ start: number; end: number }>[];
  /**
   * The model may select a temporal basis, but never supplies the timestamp.
   * `source_session_contemporaneous` is materialized only from immutable source
   * metadata and still requires semantic-verifier acceptance.
   */
  readonly eventTimeBasis?: MemoryStateEventTimeBasisV2;
  /** Query-relative semantic endpoint role; never an opaque model event id. */
  readonly durationEndpointRole?: MemoryStateDurationEndpointRoleV2;
  readonly lifecycleRelation?: MemoryStateClaimLifecycleRelationV2;
  readonly lifecycleTargetEvidenceRef?: string;
  readonly predicateKind:
    "assert" | "update" | "retract" | "confirm" | "prefer" | "disprefer";
  readonly polarity: "positive" | "negative";
  readonly modality: "observed" | "goal" | "plan" | "forecast";
}

export interface MemoryStateBoundObservationV2 {
  readonly binderVersion: typeof PAW_MEMORY_STATE_BINDER_VERSION_V2;
  readonly observationId: string;
  readonly slotId: string;
  readonly evidenceRef: string;
  readonly sourceId: string;
  readonly contentDigest: string;
  readonly valueSpans: readonly MemoryStateExactSpanV2[];
  readonly valueComposition:
    "single" | "contiguous_composite" | "ordered_tuple";
  /** Exact source envelope for contiguous values; tuple text remains display-only. */
  readonly valueText: string;
  readonly eventTimeSpans: readonly MemoryStateExactSpanV2[];
  readonly eventTimeBasis: MemoryStateEventTimeBasisV2;
  readonly eventTime?: string;
  readonly eventTimePrecision?: "instant" | "day" | "year";
  readonly eventTimeInterval?: MemoryStateEventTimeIntervalV2;
  readonly eventTimeCutoffStatus?: "within" | "straddles";
  readonly durationEndpointRole: MemoryStateDurationEndpointRoleV2;
  readonly lifecycleRelation: MemoryStateClaimLifecycleRelationV2;
  readonly lifecycleTargetEvidenceRef?: string;
  readonly predicateKind: MemoryStateObservationProposalV2["predicateKind"];
  readonly polarity: MemoryStateObservationProposalV2["polarity"];
  readonly modality: MemoryStateObservationProposalV2["modality"];
  readonly authority: MemoryEvidenceAuthorityV2;
  readonly role: "user" | "assistant";
  readonly observedAt?: string;
  readonly episodeOrder?: number;
  readonly turnOrder?: number;
  readonly eventKey?: string;
  readonly certificateRevision?: string;
  readonly sourceLockDigest: string;
  readonly bindingRevision: string;
}

export interface MemoryStateResolvedSlotV2 {
  readonly slotId: string;
  readonly status: "complete" | "partial" | "missing" | "conflict";
  readonly current: readonly MemoryStateBoundObservationV2[];
  readonly history: readonly MemoryStateBoundObservationV2[];
  readonly conflicts: readonly MemoryStateBoundObservationV2[];
  readonly coverageProof: readonly string[];
}

export interface MemoryResolvedStateFrameV2 {
  readonly reducerVersion: typeof PAW_MEMORY_STATE_REDUCER_VERSION_V2;
  readonly sourceLockDigest: string;
  readonly programRevision: string;
  readonly slots: readonly MemoryStateResolvedSlotV2[];
  readonly derivedOperations: readonly MemoryStateDerivedOperationV2[];
  /** Binds the resolved observation/current/history/conflict contents. */
  readonly frameRevision: string;
}

export interface MemoryStateDerivedOperationV2 {
  readonly operationId: string;
  readonly kind: MemoryStateDerivedOperationKindV2;
  readonly operandSlotIds: readonly string[];
  /** Fail closed until a typed executor exists for this operation. */
  readonly status: "unsupported";
  readonly operationRevision: string;
}

export function compileMemoryStateSlotsV2(input: {
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly origin: MemoryQueryAnswerOriginV1;
  readonly temporalConstraints: ReadonlyMap<
    string,
    MemoryEvidenceBoundTemporalConstraintV1
  >;
}): readonly MemoryStateSlotSpecV2[] {
  const query = boundedText(input.query, 512, "MemoryStateSlotQueryInvalid");
  const expectedOrigin = compileMemoryQueryAnswerOriginV1(query);
  if (
    !input.origin.originRevision.trim() ||
    input.origin.originRevision !== expectedOrigin.originRevision ||
    input.origin.originKind !== expectedOrigin.originKind
  ) {
    throw namedError("MemoryStateSlotOriginInvalid");
  }
  const groups = compileMemoryEvidenceSelectorGroupsV1(input);
  const orderedRequirements = topologicalRequirements(input.requirements);
  const groupByRequirement = new Map(
    groups.flatMap((group) =>
      group.requirementIds.map(
        (requirementId) => [requirementId, group.groupId] as const,
      ),
    ),
  );
  const slotIdByRequirement = new Map(
    input.requirements.map(
      (requirement) =>
        [
          requirement.requirementId,
          hashCanonicalJsonV1({
            compilerVersion: PAW_MEMORY_STATE_SLOT_COMPILER_VERSION_V2,
            requirementId: requirement.requirementId,
            originRevision: input.origin.originRevision,
          }),
        ] as const,
    ),
  );
  const queryAnchor = Object.freeze({
    start: 0,
    end: query.length,
    textDigest: hashTextV1(query),
  });
  return Object.freeze(
    orderedRequirements.map((requirement) => {
      const temporal = input.temporalConstraints.get(requirement.requirementId);
      const groupId = groupByRequirement.get(requirement.requirementId);
      const slotId = slotIdByRequirement.get(requirement.requirementId);
      if (!temporal || !groupId || !slotId) {
        throw namedError("MemoryStateSlotBindingInvalid");
      }
      const descriptorIdentity = {
        queryRevision: queryAnchor.textDigest,
        requirementId: requirement.requirementId,
        label: boundedText(
          requirement.label,
          192,
          "MemoryStateSlotDescriptorInvalid",
        ),
        searchText: boundedText(
          requirement.searchText,
          192,
          "MemoryStateSlotDescriptorInvalid",
        ),
      };
      const semanticDescriptor = Object.freeze({
        label: descriptorIdentity.label,
        searchText: descriptorIdentity.searchText,
        descriptorRevision: hashCanonicalJsonV1(
          descriptorIdentity as unknown as JsonValue,
        ),
      });
      const identity = {
        compilerVersion: PAW_MEMORY_STATE_SLOT_COMPILER_VERSION_V2,
        slotId,
        requirementId: requirement.requirementId,
        groupId,
        necessity: "required" as const,
        operation: slotOperation(requirement),
        derivedAnswerOperation: derivedAnswerOperation(input.intent),
        queryAnchor,
        semanticDescriptor,
        roleConstraint: concreteRole(requirement.roleConstraint),
        authorityMode: stateAuthorityMode(
          concreteRole(requirement.roleConstraint),
          input.origin,
        ),
        temporalMode: temporal.mode,
        evidenceTimeUpperBound: temporal.evidenceTimeUpperBound,
        durationEndpointContractKind:
          temporal.durationRequest?.endpointContract.kind ?? null,
        coverageMode:
          requirement.coverageMode ??
          (requirement.temporalMode === "latest" ? "latest" : "any"),
        minimumIndependentEvidence: requirement.minimumEvidence ?? 1,
        dependencySlotIds: Object.freeze(
          (requirement.dependsOnRequirementIds ?? []).map((requirementId) => {
            const dependency = slotIdByRequirement.get(requirementId);
            if (!dependency)
              throw namedError("MemoryStateSlotDependencyInvalid");
            return dependency;
          }),
        ),
        dependencyRelation: requirement.dependencyRelation ?? "independent",
        originRevision: input.origin.originRevision,
        temporalBindingRevision: temporal.bindingRevision,
        authorityPolicyRevision: PAW_MEMORY_STATE_AUTHORITY_POLICY_VERSION_V2,
      };
      return Object.freeze({
        ...identity,
        slotRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
      });
    }),
  );
}

export function compileMemoryStateSourceLockV2(
  items: readonly MemoryStateSourceLockItemV2[],
): MemoryStateSourceLockV2 {
  // An empty admitted set is a valid, fail-closed execution state: the
  // selector may have committed a group whose supporting hit cannot be bound
  // to one immutable, role-addressed turn.  Preserve that state as an empty
  // lock so the affected slots resolve to `missing` instead of losing the
  // whole execution frame to a structural exception.
  if (items.length > 32) {
    throw namedError("MemoryStateSourceLockInvalid");
  }
  const refs = new Set<string>();
  const frozen = items.map((item) => {
    if (
      !item.sourceId.trim() ||
      !item.evidenceRef.trim() ||
      refs.has(item.evidenceRef) ||
      !item.content.trim() ||
      item.content.length > 65_536 ||
      (item.observedAt !== undefined &&
        !Number.isFinite(Date.parse(item.observedAt))) ||
      !validOrder(item.episodeOrder) ||
      !validOrder(item.turnOrder)
    ) {
      throw namedError("MemoryStateSourceLockInvalid");
    }
    refs.add(item.evidenceRef);
    return Object.freeze({ ...item });
  });
  const identity = frozen.map((item) => ({
    ...item,
    contentDigest: hashTextV1(item.content),
  }));
  return Object.freeze({
    items: Object.freeze(frozen),
    sourceLockDigest: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
}

export function bindMemoryStateObservationV2(input: {
  readonly slot: MemoryStateSlotSpecV2;
  readonly sourceLock: MemoryStateSourceLockV2;
  readonly proposal: MemoryStateObservationProposalV2;
}): MemoryStateBoundObservationV2 {
  assertStateSlot(input.slot);
  if (input.proposal.slotId !== input.slot.slotId) {
    throw namedError("MemoryStateObservationSlotInvalid");
  }
  const expectedLock = compileMemoryStateSourceLockV2(input.sourceLock.items);
  if (expectedLock.sourceLockDigest !== input.sourceLock.sourceLockDigest) {
    throw namedError("MemoryStateSourceLockInvalid");
  }
  const item = input.sourceLock.items.find(
    (candidate) => candidate.evidenceRef === input.proposal.evidenceRef,
  );
  if (!item || item.role !== input.slot.roleConstraint) {
    throw namedError("MemoryStateObservationAuthorityInvalid");
  }
  if (
    (item.role === "user" &&
      !new Set<MemoryEvidenceAuthorityV2>([
        "user_asserted",
        "user_confirmed_dialogue",
      ]).has(item.authority)) ||
    (input.slot.authorityMode === "certified_dialogue_artifact" &&
      !item.certificateRevision?.trim())
  ) {
    throw namedError("MemoryStateObservationAuthorityInvalid");
  }
  if (
    input.slot.evidenceTimeUpperBound !== null &&
    (item.observedAt === undefined ||
      Date.parse(item.observedAt) >
        Date.parse(input.slot.evidenceTimeUpperBound))
  ) {
    throw namedError("MemoryStateObservationTemporalInvalid");
  }
  if (
    input.proposal.valueSpans.length < 1 ||
    input.proposal.valueSpans.length > 4
  ) {
    throw namedError("MemoryStateObservationSpanInvalid");
  }
  const exactSpans = (
    spans: readonly Readonly<{ start: number; end: number }>[],
  ): readonly MemoryStateExactSpanV2[] =>
    spans.map((span) => {
      if (
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        span.end > item.content.length
      ) {
        throw namedError("MemoryStateObservationSpanInvalid");
      }
      return Object.freeze({
        start: span.start,
        end: span.end,
        text: item.content.slice(span.start, span.end),
        textDigest: hashTextV1(item.content.slice(span.start, span.end)),
      });
    });
  const valueSpans = Object.freeze(
    [...exactSpans(input.proposal.valueSpans)].sort(
      (left, right) => left.start - right.start || left.end - right.end,
    ),
  );
  if (
    valueSpans.some(
      (span, index) =>
        index > 0 && (valueSpans[index - 1]?.end ?? 0) > span.start,
    )
  ) {
    throw namedError("MemoryStateObservationSpanInvalid");
  }
  const valueComposition = classifyMemoryStateValueCompositionV2(
    item.content,
    valueSpans,
  );
  const firstValueSpan = valueSpans[0] as MemoryStateExactSpanV2;
  const lastValueSpan = valueSpans.at(-1) as MemoryStateExactSpanV2;
  const valueText =
    valueComposition === "ordered_tuple"
      ? valueSpans.map((span) => span.text).join(" ")
      : item.content.slice(firstValueSpan.start, lastValueSpan.end);
  const eventTimeProposals = input.proposal.eventTimeSpans ?? [];
  if (eventTimeProposals.length > 4) {
    throw namedError("MemoryStateObservationSpanInvalid");
  }
  const eventTimeSpans = exactSpans(eventTimeProposals);
  const proposedEventTimeBasis = input.proposal.eventTimeBasis;
  const eventTimeBasis =
    proposedEventTimeBasis ??
    (eventTimeSpans.length > 0 ? "explicit_span" : "unbound");
  if (
    proposedEventTimeBasis !== undefined &&
    ((eventTimeBasis === "explicit_span" && eventTimeSpans.length === 0) ||
      (eventTimeBasis !== "explicit_span" && eventTimeSpans.length > 0))
  ) {
    throw namedError("MemoryStateObservationTemporalBasisInvalid");
  }
  const normalizedEventTime =
    eventTimeBasis === "explicit_span"
      ? normalizeEventTime(eventTimeSpans)
      : eventTimeBasis === "source_session_contemporaneous"
        ? normalizeSourceSessionTime(item.observedAt)
        : undefined;
  if (
    proposedEventTimeBasis !== undefined &&
    eventTimeBasis !== "unbound" &&
    normalizedEventTime === undefined
  ) {
    throw namedError("MemoryStateObservationTemporalBasisInvalid");
  }
  const durationEndpointRole =
    input.proposal.durationEndpointRole ?? "not_applicable";
  if (
    !new Set<MemoryStateDurationEndpointRoleV2>([
      "start",
      "end",
      "evidence",
      "not_applicable",
    ]).has(durationEndpointRole)
  ) {
    throw namedError("MemoryStateObservationEndpointRoleInvalid");
  }
  const lifecycleRelation = input.proposal.lifecycleRelation ?? "none";
  const lifecycleTargetEvidenceRef =
    input.proposal.lifecycleTargetEvidenceRef?.trim();
  const lifecycleTarget = lifecycleTargetEvidenceRef
    ? input.sourceLock.items.find(
        (candidate) => candidate.evidenceRef === lifecycleTargetEvidenceRef,
      )
    : undefined;
  if (
    (input.proposal.predicateKind === "prefer" &&
      input.proposal.polarity !== "positive") ||
    (input.proposal.predicateKind === "disprefer" &&
      input.proposal.polarity !== "negative") ||
    !new Set<MemoryStateClaimLifecycleRelationV2>([
      "none",
      "retracts",
      "supersedes",
      "confirms",
    ]).has(lifecycleRelation) ||
    (lifecycleRelation === "none" && lifecycleTargetEvidenceRef !== undefined) ||
    (lifecycleRelation !== "none" &&
      (!lifecycleTarget ||
        lifecycleTarget.evidenceRef === item.evidenceRef ||
        lifecycleTarget.role !== item.role)) ||
    (lifecycleRelation === "retracts" &&
      input.proposal.predicateKind !== "retract") ||
    (lifecycleRelation === "supersedes" &&
      input.proposal.predicateKind !== "update") ||
    (lifecycleRelation === "confirms" &&
      input.proposal.predicateKind !== "confirm") ||
    (lifecycleTarget?.observedAt !== undefined &&
      item.observedAt !== undefined &&
      Date.parse(lifecycleTarget.observedAt) >= Date.parse(item.observedAt))
  ) {
    throw namedError("MemoryStateObservationLifecycleInvalid");
  }
  if (
    (input.slot.durationEndpointContractKind === null &&
      durationEndpointRole !== "not_applicable") ||
    (input.slot.durationEndpointContractKind === "distinct_evidence_pair" &&
      durationEndpointRole !== "start" &&
      durationEndpointRole !== "end") ||
    (input.slot.durationEndpointContractKind === "evidence_to_host_anchor" &&
      durationEndpointRole !== "evidence")
  ) {
    throw namedError("MemoryStateObservationEndpointRoleInvalid");
  }
  if (
    input.slot.evidenceTimeUpperBound !== null &&
    normalizedEventTime !== undefined &&
    normalizedEventTime.eventTimeInterval.lower >
      input.slot.evidenceTimeUpperBound
  ) {
    throw namedError("MemoryStateObservationTemporalInvalid");
  }
  const eventTimeCutoffStatus =
    input.slot.evidenceTimeUpperBound === null ||
    normalizedEventTime === undefined
      ? undefined
      : normalizedEventTime.eventTimeInterval.upper >
          input.slot.evidenceTimeUpperBound
        ? ("straddles" as const)
        : ("within" as const);
  const identity = {
    binderVersion: PAW_MEMORY_STATE_BINDER_VERSION_V2,
    slotId: input.slot.slotId,
    evidenceRef: item.evidenceRef,
    sourceId: item.sourceId,
    contentDigest: hashTextV1(item.content),
    valueSpans,
    valueComposition,
    valueText,
    eventTimeSpans,
    eventTimeBasis,
    ...(normalizedEventTime === undefined ? {} : normalizedEventTime),
    ...(eventTimeCutoffStatus === undefined ? {} : { eventTimeCutoffStatus }),
    durationEndpointRole,
    lifecycleRelation,
    ...(lifecycleTargetEvidenceRef === undefined
      ? {}
      : { lifecycleTargetEvidenceRef }),
    predicateKind: input.proposal.predicateKind,
    polarity: input.proposal.polarity,
    modality: input.proposal.modality,
    authority: item.authority,
    role: item.role,
    ...(item.observedAt === undefined ? {} : { observedAt: item.observedAt }),
    ...(item.episodeOrder === undefined
      ? {}
      : { episodeOrder: item.episodeOrder }),
    ...(item.turnOrder === undefined ? {} : { turnOrder: item.turnOrder }),
    ...(item.eventKey === undefined ? {} : { eventKey: item.eventKey }),
    ...(item.certificateRevision === undefined
      ? {}
      : { certificateRevision: item.certificateRevision }),
    sourceLockDigest: input.sourceLock.sourceLockDigest,
  };
  const bindingRevision = hashCanonicalJsonV1(identity as unknown as JsonValue);
  return Object.freeze({
    ...identity,
    observationId: hashCanonicalJsonV1({
      bindingRevision,
      slotRevision: input.slot.slotRevision,
    }),
    bindingRevision,
  });
}

/** Host-derived composition. Only source-adjacent inline whitespace may join spans. */
export function classifyMemoryStateValueCompositionV2(
  content: string,
  spans: readonly Readonly<{ start: number; end: number }>[],
): "single" | "contiguous_composite" | "ordered_tuple" {
  if (!content || spans.length < 1 || spans.length > 4) {
    throw namedError("MemoryStateObservationSpanInvalid");
  }
  const ordered = [...spans].sort(
    (left, right) => left.start - right.start || left.end - right.end,
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
    throw namedError("MemoryStateObservationSpanInvalid");
  }
  if (ordered.length === 1) return "single";
  return ordered.every((span, index) => {
    if (index === 0) return true;
    const previous = ordered[index - 1] as Readonly<{
      start: number;
      end: number;
    }>;
    return /^[^\S\r\n]*$/u.test(content.slice(previous.end, span.start));
  })
    ? "contiguous_composite"
    : "ordered_tuple";
}

export function resolveMemoryStateFrameV2(input: {
  readonly slots: readonly MemoryStateSlotSpecV2[];
  readonly observations: readonly MemoryStateBoundObservationV2[];
  readonly sourceLock: MemoryStateSourceLockV2;
}): MemoryResolvedStateFrameV2 {
  const expectedLock = compileMemoryStateSourceLockV2(input.sourceLock.items);
  if (expectedLock.sourceLockDigest !== input.sourceLock.sourceLockDigest) {
    throw namedError("MemoryStateSourceLockInvalid");
  }
  const slotById = new Map(input.slots.map((slot) => [slot.slotId, slot]));
  input.slots.forEach(assertStateSlot);
  if (slotById.size !== input.slots.length) {
    throw namedError("MemoryStateFrameSlotInvalid");
  }
  for (const observation of input.observations) {
    if (
      observation.sourceLockDigest !== input.sourceLock.sourceLockDigest ||
      !slotById.has(observation.slotId)
    ) {
      throw namedError("MemoryStateFrameObservationInvalid");
    }
  }
  const resolved = new Map<string, MemoryStateResolvedSlotV2>();
  for (const slot of input.slots) {
    const observations = input.observations.filter(
      (observation) => observation.slotId === slot.slotId,
    );
    const base = resolveSlot(slot, observations);
    const dependenciesComplete = slot.dependencySlotIds.every(
      (dependencyId) => resolved.get(dependencyId)?.status === "complete",
    );
    resolved.set(
      slot.slotId,
      dependenciesComplete || base.status === "missing"
        ? base
        : Object.freeze({ ...base, status: "partial" as const }),
    );
  }
  const slots = Object.freeze(
    input.slots.map(
      (slot) => resolved.get(slot.slotId) as MemoryStateResolvedSlotV2,
    ),
  );
  const derivedOperations = compileDerivedOperations(input.slots);
  const identity = {
    reducerVersion: PAW_MEMORY_STATE_REDUCER_VERSION_V2,
    sourceLockDigest: input.sourceLock.sourceLockDigest,
    programRevision: hashCanonicalJsonV1({
      reducerVersion: PAW_MEMORY_STATE_REDUCER_VERSION_V2,
      selectorGroupPolicy: PAW_MEMORY_EVIDENCE_SELECTOR_GROUP_POLICY_V1,
      sourceLockDigest: input.sourceLock.sourceLockDigest,
      slotRevisions: input.slots.map((slot) => slot.slotRevision),
      derivedOperationRevisions: derivedOperations.map(
        (operation) => operation.operationRevision,
      ),
    }),
    slots,
    derivedOperations,
  };
  return Object.freeze({
    ...identity,
    frameRevision: hashCanonicalJsonV1(identity as never),
  });
}

function compileDerivedOperations(
  slots: readonly MemoryStateSlotSpecV2[],
): readonly MemoryStateDerivedOperationV2[] {
  const operations: MemoryStateDerivedOperationV2[] = [];
  const answerKinds = [
    ...new Set(
      slots
        .map((slot) => slot.derivedAnswerOperation)
        .filter((kind) => kind !== "none"),
    ),
  ];
  if (answerKinds.length > 1) {
    throw namedError("MemoryStateDerivedOperationInvalid");
  }
  const compile = (
    kind: MemoryStateDerivedOperationKindV2,
    operandSlotIds: readonly string[],
  ): MemoryStateDerivedOperationV2 => {
    const identity = {
      kind,
      operandSlotIds: Object.freeze([...operandSlotIds]),
      status: "unsupported" as const,
    };
    const operationRevision = hashCanonicalJsonV1(
      identity as unknown as JsonValue,
    );
    return Object.freeze({
      operationId: hashCanonicalJsonV1({
        kind,
        operandSlotIds: identity.operandSlotIds,
      } as unknown as JsonValue),
      ...identity,
      operationRevision,
    });
  };
  const answerKind = answerKinds[0];
  if (answerKind) {
    operations.push(
      compile(
        answerKind,
        slots.map((slot) => slot.slotId),
      ),
    );
  }
  for (const slot of slots) {
    if (
      slot.dependencyRelation !== "independent" ||
      slot.dependencySlotIds.length > 0
    ) {
      operations.push(
        compile("dependency_join", [...slot.dependencySlotIds, slot.slotId]),
      );
    }
  }
  return Object.freeze(operations);
}

function resolveSlot(
  slot: MemoryStateSlotSpecV2,
  observations: readonly MemoryStateBoundObservationV2[],
): MemoryStateResolvedSlotV2 {
  const ordered = [...observations].sort(compareObservation);
  if (slot.operation === "resolve_latest") {
    // As-of needs a deterministically compiled query anchor. Until that exists,
    // evidence may be retained but cannot claim operation completion.
    if (slot.temporalMode !== "latest") {
      return resolvedSlot(
        slot.slotId,
        observations.length > 0 ? "partial" : "missing",
        [],
        ordered,
        [],
        [],
      );
    }
    const eligible = ordered.filter(
      (observation) => observation.modality === "observed",
    );
    if (eligible.length === 0) {
      return resolvedSlot(slot.slotId, "missing", [], ordered, [], []);
    }
    if (
      eligible.some(
        (observation) => observation.eventTimeCutoffStatus === "straddles",
      )
    ) {
      return resolvedSlot(
        slot.slotId,
        "partial",
        [],
        ordered,
        [],
        eligible.map((observation) => observation.bindingRevision),
      );
    }
    const maxima = eligible.filter((candidate) =>
      eligible.every((other) => {
        const comparison = comparePosition(candidate, other);
        return comparison !== null && comparison >= 0;
      }),
    );
    if (maxima.length === 0) {
      const identities = new Set(
        eligible.map(
          (observation) =>
            `${spanIdentity(observation)}\0${observation.predicateKind}\0${observation.polarity}`,
        ),
      );
      return resolvedSlot(
        slot.slotId,
        identities.size > 1 ? "conflict" : "partial",
        [],
        identities.size > 1
          ? ordered.filter((observation) => !eligible.includes(observation))
          : ordered,
        identities.size > 1 ? eligible : [],
        eligible.map((observation) => observation.bindingRevision),
      );
    }
    const winner = [...maxima].sort((left, right) =>
      left.evidenceRef.localeCompare(right.evidenceRef),
    )[0] as MemoryStateBoundObservationV2;
    const conflicts = maxima.filter(
      (observation) =>
        observation !== winner &&
        (spanIdentity(observation) !== spanIdentity(winner) ||
          observation.predicateKind !== winner.predicateKind ||
          observation.polarity !== winner.polarity),
    );
    if (winner.predicateKind === "retract") {
      return resolvedSlot(
        slot.slotId,
        conflicts.length > 0 ? "conflict" : "partial",
        [],
        ordered.filter((observation) => !conflicts.includes(observation)),
        conflicts,
        maxima.map((observation) => observation.bindingRevision),
      );
    }
    if (!new Set(["assert", "update", "confirm"]).has(winner.predicateKind)) {
      return resolvedSlot(
        slot.slotId,
        "partial",
        [],
        ordered,
        [],
        [winner.bindingRevision],
      );
    }
    return resolvedSlot(
      slot.slotId,
      conflicts.length > 0 ? "conflict" : "complete",
      [winner],
      ordered.filter(
        (observation) =>
          observation !== winner && !conflicts.includes(observation),
      ),
      conflicts,
      [winner, ...conflicts].map((observation) => observation.bindingRevision),
    );
  }
  const eligible = ordered.filter(
    (observation) =>
      observation.modality === "observed" &&
      new Set(["assert", "update", "confirm"]).has(observation.predicateKind),
  );
  const independent = new Map<string, MemoryStateBoundObservationV2>();
  for (const observation of eligible) {
    const key = observation.eventKey?.trim()
      ? `event:${observation.eventKey}`
      : `source:${observation.sourceId}\0episode:${observation.episodeOrder ?? "unknown"}`;
    if (!independent.has(key)) independent.set(key, observation);
  }
  const proof = [...independent.values()].map(
    (observation) => observation.bindingRevision,
  );
  const values = new Set(
    [...independent.values()].map((observation) => spanIdentity(observation)),
  );
  if (slot.operation === "lookup") {
    const conflict = values.size > 1;
    return resolvedSlot(
      slot.slotId,
      conflict
        ? "conflict"
        : proof.length >= slot.minimumIndependentEvidence
          ? "complete"
          : observations.length > 0
            ? "partial"
            : "missing",
      conflict ? [] : [...independent.values()],
      ordered.filter(
        (observation) => !independent.has(independenceKey(observation)),
      ),
      conflict ? [...independent.values()] : [],
      proof,
    );
  }
  if (slot.operation === "collect" && slot.coverageMode === "convergent") {
    const conflict = values.size > 1;
    return resolvedSlot(
      slot.slotId,
      conflict
        ? "conflict"
        : proof.length >= slot.minimumIndependentEvidence
          ? "complete"
          : observations.length > 0
            ? "partial"
            : "missing",
      conflict ? [] : [...independent.values()],
      [],
      conflict ? [...independent.values()] : [],
      proof,
    );
  }
  // `all`, history/range, compare, aggregate, and preference inference need a
  // typed operand/window contract. A raw proof count is never completion.
  return resolvedSlot(
    slot.slotId,
    observations.length > 0 ? "partial" : "missing",
    [],
    ordered,
    [],
    proof,
  );
}

function independenceKey(observation: MemoryStateBoundObservationV2): string {
  return observation.eventKey?.trim()
    ? `event:${observation.eventKey}`
    : `source:${observation.sourceId}\0episode:${observation.episodeOrder ?? "unknown"}`;
}

function resolvedSlot(
  slotId: string,
  status: MemoryStateResolvedSlotV2["status"],
  current: readonly MemoryStateBoundObservationV2[],
  history: readonly MemoryStateBoundObservationV2[],
  conflicts: readonly MemoryStateBoundObservationV2[],
  coverageProof: readonly string[],
): MemoryStateResolvedSlotV2 {
  return Object.freeze({
    slotId,
    status,
    current: Object.freeze([...current]),
    history: Object.freeze([...history]),
    conflicts: Object.freeze([...conflicts]),
    coverageProof: Object.freeze([...coverageProof]),
  });
}

function slotOperation(
  requirement: MemoryEvidenceRequirementV3,
): MemoryStateSlotOperationV2 {
  if (
    requirement.temporalMode === "latest" ||
    requirement.temporalMode === "as_of"
  ) {
    return "resolve_latest";
  }
  if (
    requirement.temporalMode === "history" ||
    requirement.temporalMode === "range"
  ) {
    return "preserve_history";
  }
  if (
    requirement.coverageMode === "all" ||
    requirement.coverageMode === "convergent"
  ) {
    return "collect";
  }
  return "lookup";
}

function derivedAnswerOperation(
  intent: MemoryEvidenceQueryIntentV3,
): MemoryStateSlotSpecV2["derivedAnswerOperation"] {
  switch (intent.answerShape) {
    case "lookup":
      return "none";
    case "compare":
      return "compare";
    case "aggregate":
      return "aggregate";
    case "recommend":
      return "infer_preference";
  }
}

function topologicalRequirements(
  requirements: readonly MemoryEvidenceRequirementV3[],
): readonly MemoryEvidenceRequirementV3[] {
  const byId = new Map(
    requirements.map((requirement, index) => [
      requirement.requirementId,
      { requirement, index },
    ]),
  );
  const indegree = new Map(
    requirements.map((requirement) => [requirement.requirementId, 0]),
  );
  const dependents = new Map<string, string[]>();
  for (const requirement of requirements) {
    for (const dependency of requirement.dependsOnRequirementIds ?? []) {
      if (!byId.has(dependency))
        throw namedError("MemoryStateSlotDependencyInvalid");
      indegree.set(
        requirement.requirementId,
        (indegree.get(requirement.requirementId) ?? 0) + 1,
      );
      const values = dependents.get(dependency) ?? [];
      values.push(requirement.requirementId);
      dependents.set(dependency, values);
    }
  }
  const ready = requirements
    .filter((requirement) => indegree.get(requirement.requirementId) === 0)
    .sort(
      (left, right) =>
        (byId.get(left.requirementId)?.index ?? 0) -
        (byId.get(right.requirementId)?.index ?? 0),
    );
  const ordered: MemoryEvidenceRequirementV3[] = [];
  while (ready.length > 0) {
    const next = ready.shift() as MemoryEvidenceRequirementV3;
    ordered.push(next);
    for (const dependentId of dependents.get(next.requirementId) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(
          byId.get(dependentId)?.requirement as MemoryEvidenceRequirementV3,
        );
        ready.sort(
          (left, right) =>
            (byId.get(left.requirementId)?.index ?? 0) -
            (byId.get(right.requirementId)?.index ?? 0),
        );
      }
    }
  }
  if (ordered.length !== requirements.length) {
    throw namedError("MemoryStateSlotDependencyInvalid");
  }
  return Object.freeze(ordered);
}

function concreteRole(
  role: "user" | "assistant" | "any",
): "user" | "assistant" {
  if (role === "any") throw namedError("MemoryStateSlotRoleInvalid");
  return role;
}

function stateAuthorityMode(
  role: "user" | "assistant",
  origin: MemoryQueryAnswerOriginV1,
): MemoryStateSlotSpecV2["authorityMode"] {
  if (role === "user") return "user_fact";
  if (origin.originKind === "dialogue_artifact_unowned") {
    return "certified_dialogue_artifact";
  }
  if (
    origin.originKind === "explicit_assistant" ||
    origin.originKind === "explicit_shared"
  ) {
    return "explicit_assistant_report";
  }
  throw namedError("MemoryStateSlotOriginInvalid");
}

function assertStateSlot(slot: MemoryStateSlotSpecV2): void {
  const { slotRevision, ...identity } = slot;
  if (
    !slot.slotId.trim() ||
    !slot.requirementId.trim() ||
    !slot.groupId.trim() ||
    !slot.originRevision.trim() ||
    hashCanonicalJsonV1(identity as unknown as JsonValue) !== slotRevision
  ) {
    throw namedError("MemoryStateSlotIdentityInvalid");
  }
}

function compareObservation(
  left: MemoryStateBoundObservationV2,
  right: MemoryStateBoundObservationV2,
): number {
  return (
    (comparePosition(right, left) ?? 0) ||
    left.evidenceRef.localeCompare(right.evidenceRef)
  );
}

function comparePosition(
  left: MemoryStateBoundObservationV2,
  right: MemoryStateBoundObservationV2,
): number | null {
  const temporal = compareEventIntervals(
    left.eventTimeInterval,
    right.eventTimeInterval,
  );
  if (temporal !== undefined) return temporal;
  if (left.eventTimeInterval || right.eventTimeInterval) return null;
  return (
    (left.observedAt ?? "").localeCompare(right.observedAt ?? "") ||
    (left.episodeOrder ?? Number.MIN_SAFE_INTEGER) -
      (right.episodeOrder ?? Number.MIN_SAFE_INTEGER) ||
    (left.turnOrder ?? Number.MIN_SAFE_INTEGER) -
      (right.turnOrder ?? Number.MIN_SAFE_INTEGER)
  );
}

function normalizeEventTime(spans: readonly MemoryStateExactSpanV2[]):
  | Readonly<{
      eventTime: string;
      eventTimePrecision: "day" | "year";
      eventTimeInterval: MemoryStateEventTimeIntervalV2;
    }>
  | undefined {
  for (const span of spans) {
    const iso = /(?:^|\D)(\d{4})-(\d{2})-(\d{2})(?:\D|$)/u.exec(span.text);
    if (iso) {
      const interval = strictUtcDay(
        Number(iso[1]),
        Number(iso[2]),
        Number(iso[3]),
      );
      return interval ? normalizedInterval(interval) : undefined;
    }
    const named =
      /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+\d{4}\b/iu.exec(
        span.text,
      );
    if (named) {
      const parts =
        /^(\p{L}+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})$/iu.exec(
          named[0],
        );
      const month = parts ? monthNumber(parts[1] ?? "") : undefined;
      const interval =
        parts && month
          ? strictUtcDay(Number(parts[3]), month, Number(parts[2]))
          : undefined;
      return interval ? normalizedInterval(interval) : undefined;
    }
    const year = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/u.exec(span.text);
    if (year) {
      const numericYear = Number(year[1]);
      const lower = new Date(Date.UTC(numericYear, 0, 1)).toISOString();
      const upper = new Date(Date.UTC(numericYear + 1, 0, 1)).toISOString();
      return Object.freeze({
        eventTime: lower,
        eventTimePrecision: "year" as const,
        eventTimeInterval: Object.freeze({
          lower,
          upper,
          precision: "year" as const,
        }),
      });
    }
  }
  return undefined;
}

function normalizeSourceSessionTime(observedAt: string | undefined):
  | Readonly<{
      eventTime: string;
      eventTimePrecision: "instant";
      eventTimeInterval: MemoryStateEventTimeIntervalV2;
    }>
  | undefined {
  if (observedAt === undefined || !Number.isFinite(Date.parse(observedAt))) {
    return undefined;
  }
  const lowerDate = new Date(observedAt);
  const lower = lowerDate.toISOString();
  const upper = new Date(lowerDate.getTime() + 1).toISOString();
  return Object.freeze({
    eventTime: lower,
    eventTimePrecision: "instant" as const,
    eventTimeInterval: Object.freeze({
      lower,
      upper,
      precision: "instant" as const,
    }),
  });
}

function compareEventIntervals(
  left: MemoryStateEventTimeIntervalV2 | undefined,
  right: MemoryStateEventTimeIntervalV2 | undefined,
): number | undefined {
  // Event time is authoritative only when both observations carry it. When
  // either side lacks it, the explicit fallback clock is observedAt/order.
  if (!left || !right) return undefined;
  if (left.lower >= right.upper) return 1;
  if (right.lower >= left.upper) return -1;
  return 0;
}

function strictUtcDay(
  year: number,
  month: number,
  day: number,
):
  | Readonly<{
      lower: string;
      upper: string;
      precision: "day";
    }>
  | undefined {
  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(day) ||
    year < 1 ||
    year > 9998 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return undefined;
  }
  const lower = value.toISOString();
  const upper = new Date(Date.UTC(year, month - 1, day + 1)).toISOString();
  return Object.freeze({ lower, upper, precision: "day" as const });
}

function normalizedInterval<
  TInterval extends MemoryStateEventTimeIntervalV2,
>(
  interval: TInterval,
): Readonly<{
  eventTime: string;
  eventTimePrecision: TInterval["precision"];
  eventTimeInterval: MemoryStateEventTimeIntervalV2;
}> {
  return Object.freeze({
    eventTime: interval.lower,
    eventTimePrecision: interval.precision,
    eventTimeInterval: interval,
  });
}

function monthNumber(value: string): number | undefined {
  return new Map<string, number>([
    ["jan", 1],
    ["january", 1],
    ["feb", 2],
    ["february", 2],
    ["mar", 3],
    ["march", 3],
    ["apr", 4],
    ["april", 4],
    ["may", 5],
    ["jun", 6],
    ["june", 6],
    ["jul", 7],
    ["july", 7],
    ["aug", 8],
    ["august", 8],
    ["sep", 9],
    ["september", 9],
    ["oct", 10],
    ["october", 10],
    ["nov", 11],
    ["november", 11],
    ["dec", 12],
    ["december", 12],
  ]).get(value.toLowerCase());
}

function spanIdentity(observation: MemoryStateBoundObservationV2): string {
  return observation.valueSpans.map((span) => span.textDigest).join("\0");
}

function validOrder(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function boundedText(value: string, max: number, errorName: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > max) throw namedError(errorName);
  return normalized;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
