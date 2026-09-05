import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import {
  type MemoryDialogueOrdinalCohortV1,
  validateMemoryDialogueOrdinalCohortV1,
} from "./dialogue-ordinal-transaction.js";
import {
  type MemoryDialogueOrdinalConstraintV1,
  isMemoryDialogueOrdinalConstraintV1,
} from "./dialogue-ordinal.js";
import {
  type MemoryConversationTurnKindV1,
  type MemoryEvidenceNotebookHitV1,
  buildMemoryConversationTurnBundleV1,
} from "./evidence-first.js";
import type { MemoryEvidenceRequirementV3 } from "./evidence-query-planner.js";
import { evidenceSourceIdV1 } from "./evidence-ref.js";
import {
  type MemoryQueryAnswerOriginAuthorizationV1,
  validateMemoryQueryAnswerOriginAuthorizationV1,
} from "./query-answer-origin.js";
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceTemporalIntervalV2,
} from "./query-plan-contracts.js";
import {
  assertMemoryEvidenceTemporalConstraintIdentityV1,
  bindMemoryEvidenceTemporalConstraintV1,
} from "./temporal-constraint.js";

export const PAW_MEMORY_SOURCE_LOCAL_EVIDENCE_LOCATOR_PORT_VERSION_V1 =
  "paw.memory-source-local-evidence-locator-port.v1" as const;
export const PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1 =
  "paw.memory-temporal-evidence-frontier.v1:locked-round-exact-enumeration" as const;

export interface MemoryTemporalEvidenceFrontierRequestV1 {
  readonly frontierVersion: typeof PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1;
  /** Immutable original query; its hash is already bound by `temporalBinding`. */
  readonly originalQuery: string;
  /** Host-bound authority. A locator may consume it but can never author it. */
  readonly temporalBinding: MemoryEvidenceBoundTemporalConstraintV1;
  readonly lanePolicy: "original_and_requirement";
  /** Exact pre-frontier candidates that must not be silently displaced. */
  readonly baselineEvidenceRefs: readonly string[];
}

export type MemoryTemporalRoundTimeBasisV1 =
  | "explicit_event_interval"
  | "source_observed_at"
  | "unbound";

/** Content-free posting for every exact role-eligible round in the lock. */
export interface MemoryTemporalRoundPostingV1 {
  readonly sourceId: string;
  readonly evidenceRef: string;
  readonly role: MemoryConversationTurnKindV1;
  readonly contentDigest: string;
  readonly observedAt?: string;
  readonly episodeOrder?: number;
  readonly turnOrder: number;
  readonly timeBasis: MemoryTemporalRoundTimeBasisV1;
  readonly eventInterval?: MemoryEvidenceTemporalIntervalV2;
  readonly postingRevision: string;
}

export type MemoryTemporalEvidencePartitionV1 =
  | "event_inside_window"
  | "event_outside_window"
  | "source_clock_hint_inside"
  | "source_clock_hint_outside"
  | "time_unbound";

export interface MemoryTemporalEvidenceOmissionV1 {
  readonly evidenceRef: string;
  readonly reason: "rank_budget";
}

/**
 * Exact, content-free receipt for an adapter-enumerated locked frontier. The
 * status never claims semantic support, exhaustive proof, or evidence closure.
 */
export interface MemoryTemporalEvidenceFrontierSnapshotV1 {
  readonly frontierVersion: typeof PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1;
  readonly frontierRevision: string;
  readonly temporalBindingRevision: string;
  readonly sourceAcquisitionRevision: string;
  readonly lockedSourceSetRevision: string;
  readonly lockedSourceOrderRevision: string;
  readonly roleApertureRevision: string;
  readonly requirementRevision: string;
  readonly baselineEvidenceRevision: string;
  readonly budgetRevision: string;
  readonly indexRevision: string;
  /** Adapter enumeration receipt only; never evidence-closure authority. */
  readonly status: "adapter_enumerated" | "adapter_enumerated_empty";
  readonly postings: readonly MemoryTemporalRoundPostingV1[];
  readonly partitions: Readonly<{
    eventInsideWindowEvidenceRefs: readonly string[];
    eventOutsideWindowEvidenceRefs: readonly string[];
    sourceClockHintInsideEvidenceRefs: readonly string[];
    sourceClockHintOutsideEvidenceRefs: readonly string[];
    timeUnboundEvidenceRefs: readonly string[];
  }>;
  readonly returnedEvidenceRefs: readonly string[];
  /** Returned solely because of frontier lanes; baseline addresses excluded. */
  readonly introducedEvidenceRefs: readonly string[];
  readonly omitted: readonly MemoryTemporalEvidenceOmissionV1[];
}

export interface MemorySourceLocalEvidenceBudgetV1 {
  readonly maxAnchors: number;
  readonly maxAnchorsPerSource: number;
  readonly neighborRadius: number;
  readonly maxCandidatesPerChannel: number;
  readonly maxChars: number;
}

export interface MemorySourceLocalEvidenceRequestV1 {
  readonly requirement: MemoryEvidenceRequirementV3;
  /** Optional only for legacy/non-temporal callers. */
  readonly temporalFrontier?: MemoryTemporalEvidenceFrontierRequestV1;
  /**
   * A user-shaped question explicitly asking for a prior assistant response.
   * The original user role remains intact; this flag only opens certified
   * assistant anchors inside the already bounded source aperture.
   */
  readonly assistantDialogueCandidate?: boolean;
  /** Query-compiled only; opens a complete, one-session assistant-pair manifest. */
  readonly dialogueOrdinal?: MemoryDialogueOrdinalConstraintV1;
  /** Full immutable lock retained while this request reads one active source. */
  readonly dialogueOrdinalFullLockedSourceIds?: readonly string[];
  /**
   * Bounded prompt-side discovery for a provenance-unresolved answer slot.
   * Adapters may retrieve user prompts with both texts, but may return only
   * strict adjacent assistant successors from the existing source lock.
   */
  readonly respondingAssistantMaterialization?: Readonly<{
    readonly originalQuery: string;
    /** Ordered primary-fusion sources; every item must remain inside the lock. */
    readonly sourcePriorityIds: readonly string[];
    readonly maxPromptAnchorsPerSource: 1 | 2;
    /** Query-owned capability; provenance only, never semantic support. */
    readonly authorization: MemoryQueryAnswerOriginAuthorizationV1;
  }>;
  /**
   * Immutable, bounded source aperture. It may include source-only discovery
   * addresses, but never unselected evidence text.
   */
  readonly lockedSourceIds: readonly string[];
  /** Content-free identity of the pre-lock acquisition that created the lock. */
  readonly sourceAcquisitionRevision?: string;
  /** Evidence newer than this instant must never be observed. */
  readonly evidenceTimeUpperBound?: string;
  readonly budget: MemorySourceLocalEvidenceBudgetV1;
}

export type MemorySourceLocalAnchorKindV1 = "user_input" | "assistant_output";

/** Code-owned role aperture shared by every locator adapter. */
export function memorySourceLocalAnchorKindsV1(
  request: MemorySourceLocalEvidenceRequestV1,
): readonly MemorySourceLocalAnchorKindV1[] {
  if (request.requirement.roleConstraint === "assistant") {
    return Object.freeze(["assistant_output"]);
  }
  if (
    request.requirement.roleConstraint === "any" ||
    request.assistantDialogueCandidate === true
  ) {
    return Object.freeze(["user_input", "assistant_output"]);
  }
  return Object.freeze(["user_input"]);
}

export interface MemorySourceLocalIncludedTurnV1 {
  readonly evidenceRef: string;
  readonly sourceKind: MemoryConversationTurnKindV1;
  readonly turnOrder: number;
  readonly observedAt?: string;
}

export interface MemorySourceLocalEvidenceHitV1
  extends MemoryEvidenceNotebookHitV1 {
  readonly sourceKind: "user_input" | "assistant_output";
  readonly anchorEvidenceRef: string;
  readonly includedTurns: readonly MemorySourceLocalIncludedTurnV1[];
}

export interface MemorySourceLocalEvidenceTelemetryV1 {
  readonly lexicalCandidates: number;
  readonly denseCandidates: number;
  readonly anchorCount: number;
  readonly includedTurnCount: number;
  readonly renderedChars: number;
  readonly cacheHit: boolean;
  readonly durationMs: number;
}

export interface MemorySourceLocalEvidenceResultV1 {
  readonly locatorVersion: string;
  readonly locatorRevision: string;
  readonly hits: readonly MemorySourceLocalEvidenceHitV1[];
  readonly degradedChannels: readonly ("lexical" | "dense" | "hydrate")[];
  readonly telemetry: MemorySourceLocalEvidenceTelemetryV1;
  /** Complete immutable assistant pair cohort for exactly one source. */
  readonly dialogueOrdinalCohort?: MemoryDialogueOrdinalCohortV1;
  readonly temporalFrontier?: MemoryTemporalEvidenceFrontierSnapshotV1;
}

export interface MemorySourceLocalEvidenceLocatorV1 {
  readonly locatorVersion: string;
  locate(
    request: MemorySourceLocalEvidenceRequestV1,
    signal: AbortSignal,
  ): Promise<MemorySourceLocalEvidenceResultV1>;
}

export function createMemoryTemporalRoundPostingV1(
  input: Omit<MemoryTemporalRoundPostingV1, "postingRevision">,
): MemoryTemporalRoundPostingV1 {
  const identity = {
    sourceId: input.sourceId,
    evidenceRef: input.evidenceRef,
    role: input.role,
    contentDigest: input.contentDigest,
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt }),
    ...(input.episodeOrder === undefined
      ? {}
      : { episodeOrder: input.episodeOrder }),
    turnOrder: input.turnOrder,
    timeBasis: input.timeBasis,
    ...(input.eventInterval === undefined
      ? {}
      : { eventInterval: input.eventInterval }),
  } as const;
  const posting = Object.freeze({
    ...identity,
    postingRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
  assertTemporalRoundPosting(posting);
  return posting;
}

export function createMemoryTemporalEvidenceFrontierSnapshotV1(input: {
  readonly request: MemorySourceLocalEvidenceRequestV1;
  readonly indexRevision: string;
  readonly postings: readonly MemoryTemporalRoundPostingV1[];
  readonly returnedEvidenceRefs: readonly string[];
}): MemoryTemporalEvidenceFrontierSnapshotV1 {
  const frontier = assertTemporalFrontierRequest(input.request);
  if (!input.indexRevision.trim() || input.postings.length > 2_048) {
    throw namedError("MemorySourceLocalEvidenceTemporalFrontierInvalid");
  }
  const postingByRef = new Map<string, MemoryTemporalRoundPostingV1>();
  for (const posting of input.postings) {
    assertTemporalRoundPosting(posting);
    if (
      postingByRef.has(posting.evidenceRef) ||
      !input.request.lockedSourceIds.includes(posting.sourceId) ||
      evidenceRefFamily(posting.evidenceRef) !== posting.sourceId ||
      !isAllowedAnchorRole(input.request, posting.role)
    ) {
      throw namedError(
        "MemorySourceLocalEvidenceTemporalFrontierPostingInvalid",
      );
    }
    const effectiveUpper = temporalPostingEffectiveUpper(posting);
    const cutoff = frontier.temporalBinding.evidenceTimeUpperBound
      ? Date.parse(frontier.temporalBinding.evidenceTimeUpperBound)
      : undefined;
    if (
      cutoff !== undefined &&
      (effectiveUpper === undefined || effectiveUpper > cutoff)
    ) {
      throw namedError(
        "MemorySourceLocalEvidenceTemporalFrontierCutoffInvalid",
      );
    }
    postingByRef.set(posting.evidenceRef, posting);
  }
  const returnedEvidenceRefs = [...input.returnedEvidenceRefs];
  const baseline = new Set(frontier.baselineEvidenceRefs);
  const introducedEvidenceRefs = returnedEvidenceRefs.filter(
    (evidenceRef) => !baseline.has(evidenceRef),
  );
  if (
    new Set(returnedEvidenceRefs).size !== returnedEvidenceRefs.length ||
    returnedEvidenceRefs.some((evidenceRef) => !postingByRef.has(evidenceRef))
  ) {
    throw namedError(
      "MemorySourceLocalEvidenceTemporalFrontierReturnedInvalid",
    );
  }
  const partitions = {
    eventInsideWindowEvidenceRefs: [] as string[],
    eventOutsideWindowEvidenceRefs: [] as string[],
    sourceClockHintInsideEvidenceRefs: [] as string[],
    sourceClockHintOutsideEvidenceRefs: [] as string[],
    timeUnboundEvidenceRefs: [] as string[],
  };
  const partitionByRef = new Map<string, MemoryTemporalEvidencePartitionV1>();
  for (const posting of input.postings) {
    const partition = partitionTemporalPosting(
      posting,
      frontier.temporalBinding.queryScopeInterval,
    );
    partitionByRef.set(posting.evidenceRef, partition);
    if (partition === "event_inside_window")
      partitions.eventInsideWindowEvidenceRefs.push(posting.evidenceRef);
    else if (partition === "event_outside_window")
      partitions.eventOutsideWindowEvidenceRefs.push(posting.evidenceRef);
    else if (partition === "source_clock_hint_inside")
      partitions.sourceClockHintInsideEvidenceRefs.push(posting.evidenceRef);
    else if (partition === "source_clock_hint_outside")
      partitions.sourceClockHintOutsideEvidenceRefs.push(posting.evidenceRef);
    else partitions.timeUnboundEvidenceRefs.push(posting.evidenceRef);
  }
  const returned = new Set(returnedEvidenceRefs);
  const omitted = input.postings
    .filter((posting) => !returned.has(posting.evidenceRef))
    .map((posting) => {
      const partition = partitionByRef.get(posting.evidenceRef);
      if (!partition)
        throw namedError(
          "MemorySourceLocalEvidenceTemporalFrontierPartitionInvalid",
        );
      return Object.freeze({
        evidenceRef: posting.evidenceRef,
        reason: "rank_budget" as const,
      });
    });
  const identity = {
    frontierVersion: PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1,
    temporalBindingRevision: frontier.temporalBinding.bindingRevision,
    sourceAcquisitionRevision: input.request.sourceAcquisitionRevision ?? "",
    lockedSourceSetRevision: hashCanonicalJsonV1(
      [...input.request.lockedSourceIds].sort() as unknown as JsonValue,
    ),
    lockedSourceOrderRevision: hashCanonicalJsonV1(
      input.request.lockedSourceIds as unknown as JsonValue,
    ),
    roleApertureRevision: hashCanonicalJsonV1({
      anchorKinds: memorySourceLocalAnchorKindsV1(input.request),
      assistantDialogueCandidate:
        input.request.assistantDialogueCandidate === true,
      answerOriginAuthorizationRevision:
        input.request.respondingAssistantMaterialization?.authorization
          .authorizationRevision ?? "none",
    } as unknown as JsonValue),
    requirementRevision: memorySourceLocalRequirementRevisionV1(
      input.request.requirement,
    ),
    baselineEvidenceRevision: hashCanonicalJsonV1(
      frontier.baselineEvidenceRefs as unknown as JsonValue,
    ),
    budgetRevision: hashCanonicalJsonV1(
      input.request.budget as unknown as JsonValue,
    ),
    indexRevision: input.indexRevision,
    status:
      input.postings.length === 0
        ? ("adapter_enumerated_empty" as const)
        : ("adapter_enumerated" as const),
    postings: input.postings,
    partitions,
    returnedEvidenceRefs,
    introducedEvidenceRefs,
    omitted,
  } as const;
  return Object.freeze({
    ...identity,
    partitions: Object.freeze({
      eventInsideWindowEvidenceRefs: Object.freeze([
        ...partitions.eventInsideWindowEvidenceRefs,
      ]),
      eventOutsideWindowEvidenceRefs: Object.freeze([
        ...partitions.eventOutsideWindowEvidenceRefs,
      ]),
      sourceClockHintInsideEvidenceRefs: Object.freeze([
        ...partitions.sourceClockHintInsideEvidenceRefs,
      ]),
      sourceClockHintOutsideEvidenceRefs: Object.freeze([
        ...partitions.sourceClockHintOutsideEvidenceRefs,
      ]),
      timeUnboundEvidenceRefs: Object.freeze([
        ...partitions.timeUnboundEvidenceRefs,
      ]),
    }),
    omitted: Object.freeze(omitted),
    frontierRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
}

export function validateMemoryTemporalEvidenceFrontierSnapshotV1(input: {
  readonly request: MemorySourceLocalEvidenceRequestV1;
  readonly snapshot: MemoryTemporalEvidenceFrontierSnapshotV1;
  readonly returnedEvidenceRefs: readonly string[];
}): void {
  const rebuilt = createMemoryTemporalEvidenceFrontierSnapshotV1({
    request: input.request,
    indexRevision: input.snapshot.indexRevision,
    postings: input.snapshot.postings,
    returnedEvidenceRefs: input.returnedEvidenceRefs,
  });
  if (
    hashCanonicalJsonV1(rebuilt as unknown as JsonValue) !==
    hashCanonicalJsonV1(input.snapshot as unknown as JsonValue)
  ) {
    throw namedError("MemorySourceLocalEvidenceTemporalFrontierInvalid");
  }
}

export interface MemorySourceLocalHydratedEvidenceV1 {
  readonly evidenceRef: string;
  readonly sourceKind: MemoryConversationTurnKindV1;
  readonly turnOrder: number;
  readonly observedAt?: string;
  readonly content: string;
  readonly contentHash: string;
}

/** Exact immutable L0 read port, intentionally separate from the ranker. */
export interface MemorySourceLocalEvidenceHydratorV1 {
  readonly hydratorVersion: string;
  hydrate(
    evidenceRefs: readonly string[],
    signal: AbortSignal,
  ): Promise<readonly MemorySourceLocalHydratedEvidenceV1[]>;
}

export interface MemoryDialoguePredecessorTargetV1 {
  readonly sourceId: string;
  readonly evidenceRef: string;
}

export interface MemoryDialoguePredecessorProofV1 {
  readonly sourceId: string;
  /** The immutable exact candidate address supplied by the caller. */
  readonly assistant: MemorySourceLocalHydratedEvidenceV1;
  /** The immutable turn immediately preceding `assistant`. */
  readonly precedingUser: MemorySourceLocalHydratedEvidenceV1;
}

export interface MemoryDialoguePredecessorVerificationRequestV1 {
  /** Existing selector candidates only; this port never discovers candidates. */
  readonly targets: readonly MemoryDialoguePredecessorTargetV1[];
  readonly lockedSourceIds: readonly string[];
  readonly evidenceTimeUpperBound?: string;
}

export interface MemoryDialoguePredecessorVerificationResultV1 {
  readonly verifierVersion: string;
  readonly verificationRevision: string;
  readonly proofs: readonly MemoryDialoguePredecessorProofV1[];
}

/**
 * Exact-address provenance port. Adapters own their evidence-address schema and
 * read immutable L0; the core never derives a predecessor by string mutation.
 */
export interface MemoryDialoguePredecessorVerifierV1 {
  readonly verifierVersion: string;
  verify(
    request: MemoryDialoguePredecessorVerificationRequestV1,
    signal: AbortSignal,
  ): Promise<MemoryDialoguePredecessorVerificationResultV1>;
}

/**
 * Validates immutable predecessor proofs without promoting them to semantic
 * support. Missing proofs are allowed and leave the corresponding candidate
 * uncertified; malformed or forged proofs fail the whole proof batch closed.
 */
export function validateMemoryDialoguePredecessorVerificationV1(input: {
  readonly verifier: MemoryDialoguePredecessorVerifierV1;
  readonly request: MemoryDialoguePredecessorVerificationRequestV1;
  readonly result: MemoryDialoguePredecessorVerificationResultV1;
  readonly evidenceRefBelongsToSource?: (
    sourceId: string,
    evidenceRef: string,
  ) => boolean;
}): readonly MemoryDialoguePredecessorProofV1[] {
  const targets = new Map(
    input.request.targets.map(
      (target) => [target.evidenceRef, target] as const,
    ),
  );
  const locked = new Set(input.request.lockedSourceIds);
  const cutoff = parseOptionalTimestamp(input.request.evidenceTimeUpperBound);
  if (
    targets.size !== input.request.targets.length ||
    targets.size < 1 ||
    targets.size > 32 ||
    locked.size !== input.request.lockedSourceIds.length ||
    locked.size < 1 ||
    cutoff === "invalid" ||
    input.result.verifierVersion !== input.verifier.verifierVersion ||
    !input.result.verificationRevision.trim() ||
    !Array.isArray(input.result.proofs) ||
    input.result.proofs.length > targets.size
  ) {
    throw namedError("MemoryDialoguePredecessorVerificationInvalid");
  }
  const belongs =
    input.evidenceRefBelongsToSource ??
    ((sourceId: string, evidenceRef: string) =>
      evidenceRefFamily(evidenceRef) === sourceId);
  const certified: MemoryDialoguePredecessorProofV1[] = [];
  const seen = new Set<string>();
  for (const proof of input.result.proofs) {
    const target = targets.get(proof.assistant.evidenceRef);
    const assistantTime = parseOptionalTimestamp(proof.assistant.observedAt);
    const userTime = parseOptionalTimestamp(proof.precedingUser.observedAt);
    if (
      !target ||
      seen.has(proof.assistant.evidenceRef) ||
      proof.sourceId !== target.sourceId ||
      !locked.has(proof.sourceId) ||
      !belongs(proof.sourceId, proof.assistant.evidenceRef) ||
      !belongs(proof.sourceId, proof.precedingUser.evidenceRef) ||
      proof.assistant.sourceKind !== "assistant_output" ||
      proof.precedingUser.sourceKind !== "user_input" ||
      !Number.isSafeInteger(proof.assistant.turnOrder) ||
      !Number.isSafeInteger(proof.precedingUser.turnOrder) ||
      proof.assistant.turnOrder !== proof.precedingUser.turnOrder + 1 ||
      assistantTime === "invalid" ||
      userTime === "invalid" ||
      (cutoff !== undefined &&
        (assistantTime === undefined ||
          userTime === undefined ||
          assistantTime > cutoff ||
          userTime > cutoff)) ||
      !proof.assistant.content.trim() ||
      !proof.precedingUser.content.trim() ||
      hashTextV1(proof.assistant.content) !== proof.assistant.contentHash ||
      hashTextV1(proof.precedingUser.content) !==
        proof.precedingUser.contentHash
    ) {
      throw namedError("MemoryDialoguePredecessorVerificationInvalid");
    }
    seen.add(proof.assistant.evidenceRef);
    certified.push(proof);
  }
  return Object.freeze(certified);
}

export type MemorySourceLocalizationStatusV1 =
  | "not_needed"
  | "not_configured"
  | "completed"
  | "completed_empty"
  | "fallback"
  | "invalid_result";

const MEMORY_SOURCE_LOCAL_EVIDENCE_FAILURE_CODES_V1 = Object.freeze([
  "MemorySourceLocalEvidenceAnchorMissing",
  "MemorySourceLocalEvidenceAnchorRoleInvalid",
  "MemorySourceLocalEvidenceAnswerOriginInvalid",
  "MemorySourceLocalEvidenceBudgetExceeded",
  "MemorySourceLocalEvidenceBudgetInvalid",
  "MemorySourceLocalEvidenceHitInvalid",
  "MemorySourceLocalEvidenceHydrationIncomplete",
  "MemorySourceLocalEvidenceHydrationInvalid",
  "MemorySourceLocalEvidenceHydrationTraceInvalid",
  "MemorySourceLocalEvidenceHydratorInvalid",
  "MemorySourceLocalEvidenceProvenanceInvalid",
  "MemorySourceLocalEvidenceResultInvalid",
  "MemorySourceLocalEvidenceSourcesInvalid",
  "MemorySourceLocalEvidenceTelemetryInvalid",
  "MemorySourceLocalEvidenceTemporalFrontierCutoffInvalid",
  "MemorySourceLocalEvidenceTemporalFrontierInvalid",
  "MemorySourceLocalEvidenceTemporalFrontierPartitionInvalid",
  "MemorySourceLocalEvidenceTemporalFrontierPostingInvalid",
  "MemorySourceLocalEvidenceTemporalFrontierRequestInvalid",
  "MemorySourceLocalEvidenceTemporalFrontierReturnedInvalid",
  "MemorySourceLocalEvidenceTimeInvalid",
  "MemorySourceLocalEvidenceTraceInvalid",
] as const);

export type MemorySourceLocalEvidenceFailureCodeV1 =
  | (typeof MEMORY_SOURCE_LOCAL_EVIDENCE_FAILURE_CODES_V1)[number]
  | "MemorySourceLocalEvidenceBoundaryRejected";

const MEMORY_SOURCE_LOCAL_EVIDENCE_FAILURE_CODE_SET_V1 = new Set<string>(
  MEMORY_SOURCE_LOCAL_EVIDENCE_FAILURE_CODES_V1,
);

/** Maps untrusted plugin errors to a closed, content-free diagnostic code. */
export function memorySourceLocalEvidenceFailureCodeV1(
  error: unknown,
): MemorySourceLocalEvidenceFailureCodeV1 | undefined {
  if (
    !(error instanceof Error) ||
    !error.name.startsWith("MemorySourceLocalEvidence")
  ) {
    return undefined;
  }
  return MEMORY_SOURCE_LOCAL_EVIDENCE_FAILURE_CODE_SET_V1.has(error.name)
    ? (error.name as MemorySourceLocalEvidenceFailureCodeV1)
    : "MemorySourceLocalEvidenceBoundaryRejected";
}

export interface MemorySourceLocalizationReportV1 {
  readonly status: MemorySourceLocalizationStatusV1;
  readonly reasonCode: string;
  /** Content-free boundary failure name; present only for rejected plugin output. */
  readonly failureCode?: MemorySourceLocalEvidenceFailureCodeV1;
  readonly locatorVersion?: string;
  readonly locatorRevision?: string;
  readonly hydratorVersion?: string;
  readonly telemetry?: MemorySourceLocalEvidenceTelemetryV1;
  readonly addedCandidateCount: number;
  /** Structurally certified candidates kept as contextual, never supporting. */
  readonly retainedContextCandidateCount: number;
  readonly selectedCandidateCount: number;
  /** Query-level coordinator; the two transaction policies never mix. */
  readonly executor?: "per_leaf_v25" | "plan_scoped_v24" | "none";
  readonly executionRouteRevision?: string;
  readonly selectorAttempts?: 1 | 2;
  readonly selectorCommittedAttempt?: "augmented" | "baseline" | "none";
  /** Independent obligation-DAG groups settled after a structural batch failure. */
  readonly selectorGroupPolicy?: string;
  readonly selectorGroupCount?: number;
  readonly selectorCommittedGroupCount?: number;
  readonly selectorFailedGroupCount?: number;
  readonly selectorTotalAttemptCount?: number;
  /** Code-owned floor that bound lane-ranked candidates after selector abstention. */
  readonly deterministicSupportFloor?: Readonly<{
    policyVersion: string;
    flooredRequirementCount: number;
  }>;
  /** Content-free, requirement-scoped execution trace for the V2 aperture. */
  readonly leaves?: readonly MemorySourceLocalLeafExecutionReportV2[];
}

export const PAW_MEMORY_SOURCE_LOCAL_LEAF_ELIGIBILITY_VERSION_V2 =
  "paw.memory-source-local-leaf-eligibility.v2" as const;

export type MemorySourceLocalLeafEligibilityReasonV2 =
  | "eligible"
  | "route_ineligible"
  | "selector_missing"
  | "role_ineligible"
  | "temporal_binding_invalid"
  | "relation_ineligible"
  | "coverage_ineligible"
  | "minimum_evidence_invalid";

export interface MemorySourceLocalLeafEligibilityV2 {
  readonly requirementId: string;
  readonly eligible: boolean;
  readonly reasonCode: MemorySourceLocalLeafEligibilityReasonV2;
  readonly temporalBindingRevision: string;
  readonly roleConstraint: string;
  readonly relation: string;
  readonly coverageMode: string;
  readonly eligibilityRevision: string;
}

export interface MemorySourceLocalLeafExecutionReportV2 {
  readonly eligibility: MemorySourceLocalLeafEligibilityV2;
  readonly status:
    | "not_attempted"
    | "completed"
    | "completed_empty"
    | "fallback"
    | "invalid_result";
  readonly baselineHitCount: number;
  readonly localizedHitCount: number;
  readonly failureCode?: MemorySourceLocalEvidenceFailureCodeV1;
  readonly locatorRevision?: string;
  readonly temporalFrontierStatus?:
    | "adapter_enumerated"
    | "adapter_enumerated_empty";
  readonly temporalFrontierConsideredCount?: number;
  readonly temporalFrontierReturnedCount?: number;
  readonly temporalFrontierBudgetOmittedCount?: number;
}

export const DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1 = Object.freeze({
  maxAnchors: 4,
  maxAnchorsPerSource: 4,
  neighborRadius: 1,
  maxCandidatesPerChannel: 32,
  maxChars: 8_192,
}) satisfies MemorySourceLocalEvidenceBudgetV1;

/**
 * An assistant turn may answer a shared or provenance-unresolved dialogue
 * request only when the exact preceding turn is a user request. This proves
 * dialogue provenance, not the truth of the assistant prose; the semantic
 * selector remains authoritative.
 */
export function hasMemorySourceLocalDialogueCertificateV1(
  turns: readonly MemorySourceLocalIncludedTurnV1[],
  anchorTurnOrder: number,
): boolean {
  return (
    Number.isSafeInteger(anchorTurnOrder) &&
    turns.some(
      (turn) =>
        turn.sourceKind === "user_input" &&
        turn.turnOrder === anchorTurnOrder - 1,
    )
  );
}

/**
 * Opens the bounded dialogue-retrieval primitive. Answer semantics stay with
 * the evidence notebook and coverage policy; this gate only protects the
 * provenance aperture and rejects inference/convergence requests that cannot
 * be proven by one source-local anchor.
 */
export function isMemorySourceLocalEvidenceEligibleV1(input: {
  /** Retained for V1 caller compatibility; retrieval is shape-agnostic. */
  readonly answerShape: string;
  readonly temporalMode: string;
  readonly roleConstraint: string;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly supportSelectorConfigured: boolean;
  readonly certifiedAssistantDialogueCandidate?: boolean;
}): boolean {
  const certifiedUserCandidate =
    input.roleConstraint === "user" &&
    input.certifiedAssistantDialogueCandidate === true;
  const dialogueAnswerLeaf = input.requirements.some((requirement) =>
    new Set(["assistant", "any"]).has(requirement.roleConstraint),
  );
  const complexUserEvidence =
    input.roleConstraint === "user" &&
    input.answerShape !== "recommend" &&
    (input.answerShape === "aggregate" ||
      input.answerShape === "compare" ||
      input.temporalMode !== "any" ||
      input.requirements.length > 1);
  if (
    (!dialogueAnswerLeaf && !certifiedUserCandidate && !complexUserEvidence) ||
    input.requirements.length < 1 ||
    input.requirements.length > 4 ||
    (certifiedUserCandidate && input.requirements.length !== 1) ||
    !input.supportSelectorConfigured
  ) {
    return false;
  }
  return input.requirements.every((requirement) => {
    const relation = requirement.relation ?? "direct";
    const coverageMode =
      requirement.coverageMode ??
      (requirement.temporalMode === "latest" ? "latest" : "any");
    const minimumEvidence = requirement.minimumEvidence ?? 1;
    return (
      new Set(["user", "assistant", "any"]).has(requirement.roleConstraint) &&
      requirement.temporalMode === input.temporalMode &&
      relation !== "inferred" &&
      coverageMode !== "convergent" &&
      Number.isSafeInteger(minimumEvidence) &&
      minimumEvidence >= 1 &&
      minimumEvidence <=
        DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1.maxAnchors
    );
  });
}

/**
 * Opens a V2 source-local route without deciding every leaf as one batch.
 * This remains a source-aperture decision only: semantic support is still
 * owned by the selector and notebook downstream.
 */
export function isMemorySourceLocalEvidenceRouteEligibleV2(input: {
  readonly answerShape: string;
  readonly temporalMode: string;
  readonly roleConstraint: string;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly supportSelectorConfigured: boolean;
  readonly certifiedAssistantDialogueCandidate?: boolean;
}): boolean {
  if (
    !input.supportSelectorConfigured ||
    input.requirements.length < 1 ||
    input.requirements.length > 4
  ) {
    return false;
  }
  const certifiedUserCandidate =
    input.roleConstraint === "user" &&
    input.certifiedAssistantDialogueCandidate === true &&
    input.requirements.length === 1;
  const dialogueAnswerLeaf = input.requirements.some((requirement) =>
    new Set(["assistant", "any"]).has(requirement.roleConstraint),
  );
  const structuredUserEvidence =
    input.roleConstraint === "user" &&
    (new Set(["aggregate", "compare", "recommend"]).has(input.answerShape) ||
      input.temporalMode !== "any" ||
      input.requirements.length > 1 ||
      input.requirements.some(
        (requirement) =>
          (requirement.relation ?? "direct") !== "direct" ||
          (requirement.coverageMode ?? "any") !== "any" ||
          (requirement.minimumEvidence ?? 1) > 1,
      ));
  return certifiedUserCandidate || dialogueAnswerLeaf || structuredUserEvidence;
}

/**
 * Requirement-scoped V2 eligibility. A trusted, compiler-bound temporal leaf
 * is authoritative; it need not equal the broader query envelope. One
 * ineligible leaf therefore cannot close the aperture for its siblings.
 */
export function evaluateMemorySourceLocalLeafEligibilityV2(input: {
  readonly requirement: MemoryEvidenceRequirementV3;
  readonly temporalBindingRevision: string;
  readonly routeEligible: boolean;
  readonly supportSelectorConfigured: boolean;
}): MemorySourceLocalLeafEligibilityV2 {
  const relation = input.requirement.relation ?? "direct";
  const coverageMode =
    input.requirement.coverageMode ??
    (input.requirement.temporalMode === "latest" ? "latest" : "any");
  const minimumEvidence = input.requirement.minimumEvidence ?? 1;
  let reasonCode: MemorySourceLocalLeafEligibilityReasonV2 = "eligible";
  if (!input.supportSelectorConfigured) {
    reasonCode = "selector_missing";
  } else if (!input.routeEligible) {
    reasonCode = "route_ineligible";
  } else if (
    !new Set(["user", "assistant", "any"]).has(input.requirement.roleConstraint)
  ) {
    reasonCode = "role_ineligible";
  } else if (
    !input.temporalBindingRevision.trim() ||
    input.requirement.temporalConstraint === undefined ||
    input.requirement.temporalConstraint.mode !== input.requirement.temporalMode
  ) {
    reasonCode = "temporal_binding_invalid";
  } else {
    try {
      assertMemoryEvidenceTemporalConstraintIdentityV1(
        input.requirement.temporalConstraint,
      );
    } catch {
      reasonCode = "temporal_binding_invalid";
    }
  }
  if (reasonCode === "eligible" && relation === "inferred") {
    reasonCode = "relation_ineligible";
  }
  if (reasonCode === "eligible" && coverageMode === "convergent") {
    reasonCode = "coverage_ineligible";
  }
  if (
    reasonCode === "eligible" &&
    (!Number.isSafeInteger(minimumEvidence) ||
      minimumEvidence < 1 ||
      minimumEvidence >
        DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1.maxAnchors)
  ) {
    reasonCode = "minimum_evidence_invalid";
  }
  const identity = {
    eligibilityVersion: PAW_MEMORY_SOURCE_LOCAL_LEAF_ELIGIBILITY_VERSION_V2,
    requirementId: input.requirement.requirementId,
    temporalBindingRevision: input.temporalBindingRevision,
    roleConstraint: input.requirement.roleConstraint,
    relation,
    coverageMode,
    minimumEvidence,
    reasonCode,
  } as const;
  return Object.freeze({
    requirementId: input.requirement.requirementId,
    eligible: reasonCode === "eligible",
    reasonCode,
    temporalBindingRevision: input.temporalBindingRevision,
    roleConstraint: input.requirement.roleConstraint,
    relation,
    coverageMode,
    eligibilityRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
}

/**
 * Treat a locator as untrusted plugin output. Validation happens before a local
 * hit can reach the existing semantic selector or model-facing notebook.
 */
export function validateMemorySourceLocalEvidenceResultV1(input: {
  readonly locator: MemorySourceLocalEvidenceLocatorV1;
  readonly request: MemorySourceLocalEvidenceRequestV1;
  readonly result: MemorySourceLocalEvidenceResultV1;
}): readonly MemorySourceLocalEvidenceHitV1[] {
  assertBudget(input.request.budget);
  assertRespondingAssistantMaterialization(input.request);
  if (
    input.request.dialogueOrdinal !== undefined &&
    !isMemoryDialogueOrdinalConstraintV1(input.request.dialogueOrdinal)
  ) {
    throw namedError("MemoryDialogueOrdinalConstraintInvalid");
  }
  if (input.request.temporalFrontier) {
    assertTemporalFrontierRequest(input.request);
  }
  if (
    input.result.locatorVersion !== input.locator.locatorVersion ||
    !input.result.locatorRevision.trim() ||
    input.result.degradedChannels.length > 0 ||
    input.result.hits.length > input.request.budget.maxAnchors ||
    (input.request.temporalFrontier === undefined) !==
      (input.result.temporalFrontier === undefined)
  ) {
    throw namedError("MemorySourceLocalEvidenceResultInvalid");
  }
  const allowed = new Set(input.request.lockedSourceIds);
  if (
    allowed.size === 0 ||
    allowed.size !== input.request.lockedSourceIds.length
  ) {
    throw namedError("MemorySourceLocalEvidenceSourcesInvalid");
  }
  validateDialogueOrdinalCohortResultV1({
    request: input.request,
    cohort: input.result.dialogueOrdinalCohort,
    allowedSources: allowed,
  });
  const cutoff = input.request.evidenceTimeUpperBound
    ? Date.parse(input.request.evidenceTimeUpperBound)
    : undefined;
  if (cutoff !== undefined && !Number.isFinite(cutoff)) {
    throw namedError("MemorySourceLocalEvidenceTimeInvalid");
  }
  const refs = new Set<string>();
  const perSource = new Map<string, number>();
  let chars = 0;
  for (const hit of input.result.hits) {
    const anchorTurnOrder = hit.turnOrder;
    const hitObservedAt = parseOptionalTimestamp(hit.observedAt);
    if (
      !allowed.has(hit.sourceId) ||
      evidenceRefFamily(hit.evidenceRef) !== hit.sourceId ||
      evidenceRefFamily(hit.anchorEvidenceRef) !== hit.sourceId ||
      !isAllowedAnchorRole(input.request, hit.sourceKind) ||
      hit.anchorEvidenceRef !== hit.evidenceRef ||
      !isAllowedAnchorAuthority(hit.sourceKind, hit.authority) ||
      !hit.content.trim() ||
      refs.has(hit.evidenceRef) ||
      !Number.isSafeInteger(anchorTurnOrder) ||
      (anchorTurnOrder as number) < 1 ||
      hitObservedAt === "invalid" ||
      (cutoff !== undefined &&
        (hitObservedAt === undefined || hitObservedAt > cutoff))
    ) {
      throw namedError("MemorySourceLocalEvidenceHitInvalid");
    }
    refs.add(hit.evidenceRef);
    chars += hit.content.length;
    const sourceCount = (perSource.get(hit.sourceId) ?? 0) + 1;
    perSource.set(hit.sourceId, sourceCount);
    if (sourceCount > input.request.budget.maxAnchorsPerSource) {
      throw namedError("MemorySourceLocalEvidenceBudgetExceeded");
    }
    const includedRefs = new Set<string>();
    const anchorFamily = evidenceRefFamily(hit.anchorEvidenceRef);
    let anchorCount = 0;
    if (
      !Array.isArray(hit.contextEvidenceRefs) ||
      hit.contextEvidenceRefs.length !== hit.includedTurns.length ||
      hit.contextEvidenceRefs.some(
        (evidenceRef, index) =>
          evidenceRef !== hit.includedTurns[index]?.evidenceRef,
      )
    ) {
      throw namedError("MemorySourceLocalEvidenceTraceInvalid");
    }
    for (const turn of hit.includedTurns) {
      const turnObservedAt = parseOptionalTimestamp(turn.observedAt);
      if (
        !turn.evidenceRef.trim() ||
        evidenceRefFamily(turn.evidenceRef) !== anchorFamily ||
        includedRefs.has(turn.evidenceRef) ||
        !isConversationTurnKind(turn.sourceKind) ||
        !Number.isSafeInteger(turn.turnOrder) ||
        turn.turnOrder < 1 ||
        turnObservedAt === "invalid" ||
        (cutoff !== undefined &&
          (turnObservedAt === undefined || turnObservedAt > cutoff)) ||
        Math.abs(turn.turnOrder - (anchorTurnOrder as number)) >
          input.request.budget.neighborRadius
      ) {
        throw namedError("MemorySourceLocalEvidenceTraceInvalid");
      }
      includedRefs.add(turn.evidenceRef);
      if (turn.evidenceRef === hit.anchorEvidenceRef) {
        if (
          turn.sourceKind !== hit.sourceKind ||
          turn.turnOrder !== anchorTurnOrder ||
          turn.observedAt !== hit.observedAt
        ) {
          throw namedError("MemorySourceLocalEvidenceAnchorRoleInvalid");
        }
        anchorCount += 1;
      }
    }
    if (anchorCount !== 1) {
      throw namedError("MemorySourceLocalEvidenceAnchorMissing");
    }
    if (
      hit.sourceKind === "assistant_output" &&
      (input.request.requirement.roleConstraint === "any" ||
        input.request.assistantDialogueCandidate === true) &&
      !hasMemorySourceLocalDialogueCertificateV1(
        hit.includedTurns,
        anchorTurnOrder as number,
      )
    ) {
      throw namedError("MemorySourceLocalEvidenceProvenanceInvalid");
    }
  }
  if (
    chars > input.request.budget.maxChars ||
    input.result.telemetry.anchorCount !== input.result.hits.length ||
    input.result.telemetry.renderedChars !== chars ||
    input.result.telemetry.includedTurnCount !==
      input.result.hits.reduce(
        (total, hit) => total + hit.includedTurns.length,
        0,
      )
  ) {
    throw namedError("MemorySourceLocalEvidenceTelemetryInvalid");
  }
  if (input.result.temporalFrontier) {
    validateMemoryTemporalEvidenceFrontierSnapshotV1({
      request: input.request,
      snapshot: input.result.temporalFrontier,
      returnedEvidenceRefs: input.result.hits.map((hit) => hit.evidenceRef),
    });
  }
  if (input.request.dialogueOrdinal) {
    const cohort = input.result.dialogueOrdinalCohort;
    if (
      !cohort ||
      refs.size !== cohort.items.length ||
      cohort.items.some((item) => !refs.has(item.evidenceRef))
    ) {
      throw namedError("MemoryDialogueOrdinalCohortHitsIncomplete");
    }
  }
  return Object.freeze([...input.result.hits]);
}

/** The locator may return one and only one complete immutable source cohort. */
export function validateDialogueOrdinalCohortResultV1(input: {
  readonly request: MemorySourceLocalEvidenceRequestV1;
  readonly cohort: MemoryDialogueOrdinalCohortV1 | undefined;
  readonly allowedSources: ReadonlySet<string>;
}): void {
  const constraint = input.request.dialogueOrdinal;
  if (constraint === undefined) {
    if (input.cohort !== undefined) {
      throw namedError("MemoryDialogueOrdinalCohortUnexpected");
    }
    return;
  }
  const cohort = input.cohort;
  const fullLock = input.request.dialogueOrdinalFullLockedSourceIds;
  if (
    !cohort ||
    input.allowedSources.size !== 1 ||
    !fullLock ||
    fullLock.length < 1 ||
    fullLock.length > 8 ||
    new Set(fullLock).size !== fullLock.length ||
    cohort.activeSourceId !== input.request.lockedSourceIds[0] ||
    !input.allowedSources.has(cohort.activeSourceId) ||
    cohort.fullLockedSourceIds.length !== fullLock.length ||
    cohort.fullLockedSourceIds.some(
      (sourceId, index) => sourceId !== fullLock[index],
    ) ||
    cohort.sourceAcquisitionRevision !==
      (input.request.sourceAcquisitionRevision ?? "missing") ||
    cohort.evidenceTimeUpperBound !==
      (input.request.evidenceTimeUpperBound ?? null)
  ) {
    throw namedError("MemoryDialogueOrdinalCohortInvalid");
  }
  try {
    validateMemoryDialogueOrdinalCohortV1({ constraint, cohort });
  } catch {
    throw namedError("MemoryDialogueOrdinalCohortInvalid");
  }
  if (
    cohort.items.some(
      (item) =>
        evidenceRefFamily(item.evidenceRef) !== cohort.activeSourceId ||
        evidenceRefFamily(item.predecessorEvidenceRef) !==
          cohort.activeSourceId,
    )
  ) {
    throw namedError("MemoryDialogueOrdinalCohortInvalid");
  }
}

/**
 * Discard locator-authored prose and rebuild every bundle from exact immutable
 * L0 reads. The locator chooses bounded addresses; it never owns factual text.
 */
export async function hydrateMemorySourceLocalEvidenceResultV1(input: {
  readonly hydrator: MemorySourceLocalEvidenceHydratorV1;
  readonly request: MemorySourceLocalEvidenceRequestV1;
  readonly result: MemorySourceLocalEvidenceResultV1;
  readonly signal: AbortSignal;
}): Promise<MemorySourceLocalEvidenceResultV1> {
  if (!input.hydrator.hydratorVersion.trim()) {
    throw namedError("MemorySourceLocalEvidenceHydratorInvalid");
  }
  const requestedRefs = [
    ...new Set([
      ...input.result.hits.flatMap((hit) =>
        hit.includedTurns.map((turn) => turn.evidenceRef),
      ),
      ...(input.result.temporalFrontier?.postings.map(
        (posting) => posting.evidenceRef,
      ) ?? []),
    ]),
  ];
  if (requestedRefs.length === 0) return input.result;
  const hydrated = await input.hydrator.hydrate(requestedRefs, input.signal);
  if (input.signal.aborted) throw abortError();
  const byRef = new Map<string, MemorySourceLocalHydratedEvidenceV1>();
  for (const item of hydrated) {
    const observedAt = parseOptionalTimestamp(item.observedAt);
    if (
      !requestedRefs.includes(item.evidenceRef) ||
      byRef.has(item.evidenceRef) ||
      !isConversationTurnKind(item.sourceKind) ||
      !Number.isSafeInteger(item.turnOrder) ||
      item.turnOrder < 1 ||
      observedAt === "invalid" ||
      !item.content.trim() ||
      hashTextV1(item.content) !== item.contentHash
    ) {
      throw namedError("MemorySourceLocalEvidenceHydrationInvalid");
    }
    byRef.set(item.evidenceRef, item);
  }
  if (byRef.size !== requestedRefs.length) {
    throw namedError("MemorySourceLocalEvidenceHydrationIncomplete");
  }
  for (const posting of input.result.temporalFrontier?.postings ?? []) {
    const item = byRef.get(posting.evidenceRef);
    if (
      !item ||
      item.contentHash !== posting.contentDigest ||
      item.sourceKind !== posting.role ||
      item.turnOrder !== posting.turnOrder ||
      item.observedAt !== posting.observedAt
    ) {
      throw namedError(
        "MemorySourceLocalEvidenceTemporalFrontierPostingInvalid",
      );
    }
  }
  const hits: MemorySourceLocalEvidenceHitV1[] = [];
  let renderedChars = 0;
  for (const hit of input.result.hits) {
    const contextEvidenceRefs = hit.contextEvidenceRefs;
    if (!contextEvidenceRefs) {
      throw namedError("MemorySourceLocalEvidenceHydrationTraceInvalid");
    }
    const remaining = input.request.budget.maxChars - renderedChars;
    if (remaining < 256) {
      throw namedError("MemorySourceLocalEvidenceBudgetExceeded");
    }
    const turns = hit.includedTurns.map((turn) => {
      const item = byRef.get(turn.evidenceRef);
      if (!item)
        throw namedError("MemorySourceLocalEvidenceHydrationIncomplete");
      if (
        item.sourceKind !== turn.sourceKind ||
        item.turnOrder !== turn.turnOrder ||
        item.observedAt !== turn.observedAt
      ) {
        throw namedError("MemorySourceLocalEvidenceHydrationTraceInvalid");
      }
      return {
        evidenceRef: item.evidenceRef,
        sourceKind: item.sourceKind,
        sourceSeq: item.turnOrder,
        content: item.content,
        hit: item.evidenceRef === hit.anchorEvidenceRef,
      };
    });
    const bundle = buildMemoryConversationTurnBundleV1({
      turns,
      query: input.request.requirement.searchText,
      maxChars: Math.min(2_400, remaining),
    });
    if (
      bundle.hitSeq !== hit.turnOrder ||
      bundle.includedEvidence.length !== contextEvidenceRefs.length ||
      bundle.includedEvidence.some(
        (turn, index) =>
          turn.evidenceRef !== contextEvidenceRefs[index] ||
          turn.sourceKind !== hit.includedTurns[index]?.sourceKind ||
          turn.turnOrder !== hit.includedTurns[index]?.turnOrder,
      )
    ) {
      throw namedError("MemorySourceLocalEvidenceHydrationTraceInvalid");
    }
    hits.push(
      Object.freeze({
        ...hit,
        content: bundle.text,
        authority: bundle.authority,
      }),
    );
    renderedChars += bundle.text.length;
  }
  return Object.freeze({
    ...input.result,
    locatorRevision: hashCanonicalJsonV1({
      schemaVersion: "paw.memory-source-local-hydrated-result.v1",
      locatorRevision: input.result.locatorRevision,
      hydratorVersion: input.hydrator.hydratorVersion,
      evidence: requestedRefs.map((evidenceRef) => ({
        evidenceRef,
        contentHash: byRef.get(evidenceRef)?.contentHash ?? "missing",
        sourceKind: byRef.get(evidenceRef)?.sourceKind ?? "missing",
        turnOrder: byRef.get(evidenceRef)?.turnOrder ?? -1,
        observedAt: byRef.get(evidenceRef)?.observedAt ?? "unknown",
      })),
    }),
    hits: Object.freeze(hits),
    telemetry: Object.freeze({
      ...input.result.telemetry,
      renderedChars,
    }),
  });
}

export function memorySourceLocalEvidenceCacheKeyV1(input: {
  readonly locatorVersion: string;
  readonly scopeFingerprint: string;
  readonly turnIndexRevision: string;
  readonly embeddingIdentity?: string;
  readonly request: MemorySourceLocalEvidenceRequestV1;
  readonly adjacencyPolicyVersion: string;
  readonly rankerVersion: string;
}): string {
  assertBudget(input.request.budget);
  assertRespondingAssistantMaterialization(input.request);
  if (input.request.temporalFrontier) {
    assertTemporalFrontierRequest(input.request);
  }
  if (
    input.request.sourceAcquisitionRevision !== undefined &&
    input.request.sourceAcquisitionRevision.trim().length === 0
  ) {
    throw namedError("MemorySourceLocalEvidenceAcquisitionRevisionInvalid");
  }
  if (input.request.requirement.temporalConstraint) {
    assertMemoryEvidenceTemporalConstraintIdentityV1(
      input.request.requirement.temporalConstraint,
    );
  }
  const normalizedSearchText = input.request.requirement.searchText
    .replace(/\s+/gu, " ")
    .trim();
  const normalizedRequirementLabel = input.request.requirement.label
    .replace(/\s+/gu, " ")
    .trim();
  const normalizedOriginalQuery =
    input.request.respondingAssistantMaterialization?.originalQuery
      .replace(/\s+/gu, " ")
      .trim();
  return hashCanonicalJsonV1({
    schemaVersion: "paw.memory-source-local-evidence-cache-key.v1",
    locatorVersion: input.locatorVersion,
    scopeFingerprint: input.scopeFingerprint,
    turnIndexRevision: input.turnIndexRevision,
    embeddingIdentity: input.embeddingIdentity ?? "none",
    searchTextHash: hashCanonicalJsonV1(normalizedSearchText as JsonValue),
    requirementLabelHash: hashCanonicalJsonV1(
      normalizedRequirementLabel as JsonValue,
    ),
    requirementRevision: memorySourceLocalRequirementRevisionV1(
      input.request.requirement,
    ),
    lockedSourceIds: [...input.request.lockedSourceIds].sort(),
    lockedSourceOrder: [...input.request.lockedSourceIds],
    sourceAcquisitionRevision:
      input.request.sourceAcquisitionRevision?.trim() ?? "legacy",
    roleConstraint: input.request.requirement.roleConstraint,
    assistantDialogueCandidate:
      input.request.assistantDialogueCandidate === true,
    ...(input.request.dialogueOrdinal === undefined
      ? {}
      : {
          dialogueOrdinal: input.request.dialogueOrdinal.constraintRevision,
          dialogueOrdinalFullLockedSourceIds:
            input.request.dialogueOrdinalFullLockedSourceIds === undefined
              ? "missing"
              : [...input.request.dialogueOrdinalFullLockedSourceIds],
        }),
    respondingAssistantMaterialization: input.request
      .respondingAssistantMaterialization
      ? {
          originalQueryHash: hashCanonicalJsonV1(
            normalizedOriginalQuery as JsonValue,
          ),
          maxPromptAnchorsPerSource:
            input.request.respondingAssistantMaterialization
              .maxPromptAnchorsPerSource,
          // Source order is a ranking input for source-fair allocation.
          sourcePriority: [
            ...input.request.respondingAssistantMaterialization
              .sourcePriorityIds,
          ],
          authorization:
            input.request.respondingAssistantMaterialization.authorization,
        }
      : "disabled",
    temporalMode: input.request.requirement.temporalMode,
    temporalConstraintRevision:
      input.request.requirement.temporalConstraint?.constraintRevision ??
      "legacy",
    temporalFrontier: input.request.temporalFrontier
      ? {
          frontierVersion: input.request.temporalFrontier.frontierVersion,
          temporalBindingRevision:
            input.request.temporalFrontier.temporalBinding.bindingRevision,
          lanePolicy: input.request.temporalFrontier.lanePolicy,
          baselineEvidenceRefs: [
            ...input.request.temporalFrontier.baselineEvidenceRefs,
          ],
        }
      : "disabled",
    evidenceTimeUpperBound: input.request.evidenceTimeUpperBound ?? "latest",
    budget: input.request.budget,
    adjacencyPolicyVersion: input.adjacencyPolicyVersion,
    rankerVersion: input.rankerVersion,
  } as unknown as JsonValue);
}

function assertBudget(value: MemorySourceLocalEvidenceBudgetV1): void {
  if (
    !Number.isSafeInteger(value.maxAnchors) ||
    value.maxAnchors < 1 ||
    value.maxAnchors > 8 ||
    !Number.isSafeInteger(value.maxAnchorsPerSource) ||
    value.maxAnchorsPerSource < 1 ||
    value.maxAnchorsPerSource > value.maxAnchors ||
    !Number.isSafeInteger(value.neighborRadius) ||
    value.neighborRadius < 0 ||
    value.neighborRadius > 2 ||
    !Number.isSafeInteger(value.maxCandidatesPerChannel) ||
    value.maxCandidatesPerChannel < value.maxAnchors ||
    value.maxCandidatesPerChannel > 64 ||
    !Number.isSafeInteger(value.maxChars) ||
    value.maxChars < 256 ||
    value.maxChars > 16_384
  ) {
    throw namedError("MemorySourceLocalEvidenceBudgetInvalid");
  }
}

function assertRespondingAssistantMaterialization(
  request: MemorySourceLocalEvidenceRequestV1,
): void {
  const materialization = request.respondingAssistantMaterialization;
  if (!materialization) return;
  const originalQuery = materialization.originalQuery
    .replace(/\s+/gu, " ")
    .trim();
  const sourcePriority = materialization.sourcePriorityIds;
  const locked = new Set(request.lockedSourceIds);
  validateMemoryQueryAnswerOriginAuthorizationV1({
    query: originalQuery,
    authorization: materialization.authorization,
    requirement: request.requirement,
    assistantDialogueCandidate: request.assistantDialogueCandidate === true,
  });
  const requestedAnchors =
    sourcePriority.length * materialization.maxPromptAnchorsPerSource;
  const roleEligible =
    request.requirement.roleConstraint === "assistant" ||
    (request.requirement.roleConstraint === "any" &&
      request.assistantDialogueCandidate === true);
  if (
    !roleEligible ||
    !originalQuery ||
    originalQuery.length > 32_768 ||
    sourcePriority.length === 0 ||
    new Set(sourcePriority).size !== sourcePriority.length ||
    sourcePriority.some((sourceId) => !locked.has(sourceId)) ||
    !new Set([1, 2]).has(materialization.maxPromptAnchorsPerSource) ||
    requestedAnchors > request.budget.maxAnchors
  ) {
    throw namedError("MemorySourceLocalEvidenceMaterializationInvalid");
  }
}

function memorySourceLocalRequirementRevisionV1(
  requirement: MemoryEvidenceRequirementV3,
): string {
  return hashCanonicalJsonV1({
    ...requirement,
    label: requirement.label.replace(/\s+/gu, " ").trim(),
    searchText: requirement.searchText.replace(/\s+/gu, " ").trim(),
  } as unknown as JsonValue);
}

function assertTemporalFrontierRequest(
  request: MemorySourceLocalEvidenceRequestV1,
): MemoryTemporalEvidenceFrontierRequestV1 {
  const frontier = request.temporalFrontier;
  const constraint = request.requirement.temporalConstraint;
  if (
    !frontier ||
    frontier.frontierVersion !==
      PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1 ||
    frontier.lanePolicy !== "original_and_requirement" ||
    !frontier.originalQuery.trim() ||
    frontier.originalQuery.length > 32_768 ||
    !request.sourceAcquisitionRevision?.trim() ||
    !Array.isArray(frontier.baselineEvidenceRefs) ||
    frontier.baselineEvidenceRefs.length > 64 ||
    new Set(frontier.baselineEvidenceRefs).size !==
      frontier.baselineEvidenceRefs.length ||
    frontier.baselineEvidenceRefs.some(
      (evidenceRef) =>
        !evidenceRef.trim() ||
        !request.lockedSourceIds.includes(evidenceRefFamily(evidenceRef)),
    ) ||
    !constraint ||
    constraint.constraintRevision !==
      frontier.temporalBinding.constraintRevision ||
    request.evidenceTimeUpperBound !==
      (frontier.temporalBinding.evidenceTimeUpperBound ?? undefined)
  ) {
    throw namedError("MemorySourceLocalEvidenceTemporalFrontierRequestInvalid");
  }
  let rebound: MemoryEvidenceBoundTemporalConstraintV1;
  try {
    rebound = bindMemoryEvidenceTemporalConstraintV1({
      query: frontier.originalQuery,
      queryEnvelopeMode: frontier.temporalBinding.queryEnvelopeMode,
      leafMode: frontier.temporalBinding.mode,
      constraint,
      ...(request.evidenceTimeUpperBound === undefined
        ? {}
        : { evidenceTimeUpperBound: request.evidenceTimeUpperBound }),
      applyQueryScope:
        frontier.temporalBinding.mode === "any" &&
        frontier.temporalBinding.queryScopeInterval !== null,
    });
  } catch {
    throw namedError("MemorySourceLocalEvidenceTemporalFrontierRequestInvalid");
  }
  if (
    hashCanonicalJsonV1(rebound as unknown as JsonValue) !==
    hashCanonicalJsonV1(frontier.temporalBinding as unknown as JsonValue)
  ) {
    throw namedError("MemorySourceLocalEvidenceTemporalFrontierRequestInvalid");
  }
  return frontier;
}

function assertTemporalRoundPosting(
  posting: MemoryTemporalRoundPostingV1,
): void {
  const observedAt = parseOptionalTimestamp(posting.observedAt);
  const eventInterval = posting.eventInterval;
  const eventLower = eventInterval
    ? Date.parse(eventInterval.lower)
    : undefined;
  const eventUpper = eventInterval
    ? Date.parse(eventInterval.upper)
    : undefined;
  const expectedRevision = hashCanonicalJsonV1({
    sourceId: posting.sourceId,
    evidenceRef: posting.evidenceRef,
    role: posting.role,
    contentDigest: posting.contentDigest,
    ...(posting.observedAt === undefined
      ? {}
      : { observedAt: posting.observedAt }),
    ...(posting.episodeOrder === undefined
      ? {}
      : { episodeOrder: posting.episodeOrder }),
    turnOrder: posting.turnOrder,
    timeBasis: posting.timeBasis,
    ...(eventInterval === undefined ? {} : { eventInterval }),
  } as unknown as JsonValue);
  if (
    !posting.sourceId.trim() ||
    !posting.evidenceRef.trim() ||
    !/^[a-f0-9]{64}$/u.test(posting.contentDigest) ||
    !isConversationTurnKind(posting.role) ||
    !Number.isSafeInteger(posting.turnOrder) ||
    posting.turnOrder < 1 ||
    (posting.episodeOrder !== undefined &&
      (!Number.isSafeInteger(posting.episodeOrder) ||
        posting.episodeOrder < 0)) ||
    observedAt === "invalid" ||
    (eventInterval !== undefined &&
      (!Number.isFinite(eventLower) ||
        !Number.isFinite(eventUpper) ||
        (eventLower as number) >= (eventUpper as number))) ||
    (posting.timeBasis === "explicit_event_interval") !==
      (eventInterval !== undefined) ||
    (posting.timeBasis === "source_observed_at" && observedAt === undefined) ||
    (posting.timeBasis === "unbound" && eventInterval !== undefined) ||
    posting.postingRevision !== expectedRevision
  ) {
    throw namedError("MemorySourceLocalEvidenceTemporalFrontierPostingInvalid");
  }
}

function temporalPostingEffectiveUpper(
  posting: MemoryTemporalRoundPostingV1,
): number | undefined {
  return posting.observedAt === undefined
    ? undefined
    : Date.parse(posting.observedAt);
}

function partitionTemporalPosting(
  posting: MemoryTemporalRoundPostingV1,
  interval: MemoryEvidenceTemporalIntervalV2 | null,
): MemoryTemporalEvidencePartitionV1 {
  if (posting.timeBasis === "unbound") return "time_unbound";
  if (interval === null) {
    return posting.timeBasis === "explicit_event_interval"
      ? "event_inside_window"
      : "source_clock_hint_inside";
  }
  const lower = Date.parse(interval.lower);
  const upper = Date.parse(interval.upper);
  if (posting.eventInterval) {
    const eventLower = Date.parse(posting.eventInterval.lower);
    const eventUpper = Date.parse(posting.eventInterval.upper);
    return eventLower < upper && eventUpper > lower
      ? "event_inside_window"
      : "event_outside_window";
  }
  const observedAt = posting.observedAt
    ? Date.parse(posting.observedAt)
    : Number.NaN;
  if (!Number.isFinite(observedAt)) return "time_unbound";
  return observedAt >= lower && observedAt < upper
    ? "source_clock_hint_inside"
    : "source_clock_hint_outside";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function abortError(): Error {
  return namedError("AbortError");
}

function evidenceRefFamily(value: string): string {
  return value.trim() ? evidenceSourceIdV1(value) : "";
}

function parseOptionalTimestamp(
  value: string | undefined,
): number | "invalid" | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : "invalid";
}

function isConversationTurnKind(
  value: unknown,
): value is MemoryConversationTurnKindV1 {
  return (
    value === "user_input" ||
    value === "assistant_output" ||
    value === "tool_observation" ||
    value === "verification" ||
    value === "outcome" ||
    value === "source_document"
  );
}

function isAllowedAnchorRole(
  request: MemorySourceLocalEvidenceRequestV1,
  sourceKind: MemoryConversationTurnKindV1 | undefined,
): sourceKind is "user_input" | "assistant_output" {
  return (
    (sourceKind === "user_input" || sourceKind === "assistant_output") &&
    memorySourceLocalAnchorKindsV1(request).includes(sourceKind)
  );
}

function isAllowedAnchorAuthority(
  sourceKind: "user_input" | "assistant_output" | undefined,
  authority: MemoryEvidenceNotebookHitV1["authority"],
): boolean {
  return sourceKind === "user_input"
    ? authority === "user_asserted" || authority === "user_confirmed_dialogue"
    : sourceKind === "assistant_output" &&
        (authority === "context_only" ||
          authority === "user_confirmed_dialogue");
}
