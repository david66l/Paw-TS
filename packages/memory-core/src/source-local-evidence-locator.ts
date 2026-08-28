import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import {
  type MemoryConversationTurnKindV1,
  type MemoryEvidenceNotebookHitV1,
  buildMemoryConversationTurnBundleV1,
} from "./evidence-first.js";
import type { MemoryEvidenceRequirementV3 } from "./evidence-query-planner.js";
import { evidenceSourceIdV1 } from "./evidence-ref.js";

export const PAW_MEMORY_SOURCE_LOCAL_EVIDENCE_LOCATOR_PORT_VERSION_V1 =
  "paw.memory-source-local-evidence-locator-port.v2:assistant-origin-policy" as const;

export interface MemorySourceLocalEvidenceBudgetV1 {
  readonly maxAnchors: number;
  readonly maxAnchorsPerSource: number;
  readonly neighborRadius: number;
  readonly maxCandidatesPerChannel: number;
  readonly maxChars: number;
}

export type MemoryAssistantOriginPolicyV1 =
  | "addressed_reply_only"
  | "allow_session_opening_artifact";

export interface MemorySourceLocalEvidenceRequestV1 {
  readonly requirement: MemoryEvidenceRequirementV3;
  /** Code-owned authority aperture; a model may never widen this policy. */
  readonly assistantOriginPolicy: MemoryAssistantOriginPolicyV1;
  /** Immutable source set selected by the first-stage fusion. */
  readonly lockedSourceIds: readonly string[];
  /** Evidence newer than this instant must never be observed. */
  readonly evidenceTimeUpperBound?: string;
  readonly budget: MemorySourceLocalEvidenceBudgetV1;
}

export interface MemorySourceLocalIncludedTurnV1 {
  readonly evidenceRef: string;
  readonly sourceKind: MemoryConversationTurnKindV1;
  readonly turnOrder: number;
  readonly observedAt?: string;
}

export interface MemorySourceLocalEvidenceHitV1
  extends MemoryEvidenceNotebookHitV1 {
  readonly sourceKind: "assistant_output";
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
}

export interface MemorySourceLocalEvidenceLocatorV1 {
  readonly locatorVersion: string;
  locate(
    request: MemorySourceLocalEvidenceRequestV1,
    signal: AbortSignal,
  ): Promise<MemorySourceLocalEvidenceResultV1>;
}

export interface MemorySourceLocalAnchorCandidateV1 {
  readonly evidenceRef: string;
  readonly sourceId: string;
  readonly score: number;
}

/**
 * Identifies locked sources that need a bounded recall backfill before global
 * confidence ranking. This keeps a head source from monopolizing an adapter's
 * top-k retrieval window while leaving final evidence selection score-driven.
 */
export function memorySourceLocalBackfillSourceIdsV1(input: {
  readonly candidates: readonly MemorySourceLocalAnchorCandidateV1[];
  readonly lockedSourceIds: readonly string[];
  readonly minimumCandidatesPerSource: number;
}): readonly string[] {
  if (
    !Number.isSafeInteger(input.minimumCandidatesPerSource) ||
    input.minimumCandidatesPerSource < 1 ||
    input.minimumCandidatesPerSource > 8
  ) {
    throw namedError("MemorySourceLocalEvidenceBudgetInvalid");
  }
  const locked = new Set(input.lockedSourceIds);
  if (
    locked.size !== input.lockedSourceIds.length ||
    input.lockedSourceIds.some((sourceId) => !sourceId.trim())
  ) {
    throw namedError("MemorySourceLocalEvidenceSourcesInvalid");
  }
  const refsBySource = new Map<string, Set<string>>(
    input.lockedSourceIds.map((sourceId) => [sourceId, new Set<string>()]),
  );
  for (const candidate of input.candidates) {
    if (
      !candidate.evidenceRef.trim() ||
      !locked.has(candidate.sourceId) ||
      !Number.isFinite(candidate.score)
    ) {
      throw namedError("MemorySourceLocalEvidenceHitInvalid");
    }
    refsBySource.get(candidate.sourceId)?.add(candidate.evidenceRef);
  }
  return Object.freeze(
    input.lockedSourceIds.filter(
      (sourceId) =>
        (refsBySource.get(sourceId)?.size ?? 0) <
        input.minimumCandidatesPerSource,
    ),
  );
}

/**
 * Keeps one final anchor slot available to another locked source whenever the
 * request spans multiple sources. A single-source request retains its full
 * declared per-source budget.
 */
export function memorySourceLocalDiverseCandidateCapV1(input: {
  readonly lockedSourceCount: number;
  readonly maxAnchors: number;
  readonly maxAnchorsPerSource: number;
}): number {
  if (
    !Number.isSafeInteger(input.lockedSourceCount) ||
    input.lockedSourceCount < 1 ||
    !Number.isSafeInteger(input.maxAnchors) ||
    input.maxAnchors < 1 ||
    !Number.isSafeInteger(input.maxAnchorsPerSource) ||
    input.maxAnchorsPerSource < 1 ||
    input.maxAnchorsPerSource > input.maxAnchors
  ) {
    throw namedError("MemorySourceLocalEvidenceBudgetInvalid");
  }
  const diverseLimit =
    input.lockedSourceCount > 1
      ? Math.max(1, input.maxAnchors - 1)
      : input.maxAnchors;
  return Math.min(input.maxAnchorsPerSource, diverseLimit);
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
  "MemorySourceLocalEvidenceBudgetExceeded",
  "MemorySourceLocalEvidenceBudgetInvalid",
  "MemorySourceLocalEvidenceHitInvalid",
  "MemorySourceLocalEvidenceHydrationIncomplete",
  "MemorySourceLocalEvidenceHydrationInvalid",
  "MemorySourceLocalEvidenceHydrationTraceInvalid",
  "MemorySourceLocalEvidenceHydratorInvalid",
  "MemorySourceLocalEvidencePolicyInvalid",
  "MemorySourceLocalEvidenceProvenanceInvalid",
  "MemorySourceLocalEvidenceResultInvalid",
  "MemorySourceLocalEvidenceSourcesInvalid",
  "MemorySourceLocalEvidenceTelemetryInvalid",
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
  readonly selectedCandidateCount: number;
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
 * Proves only that an immutable assistant turn has a structurally valid origin:
 * either it answers the immediately preceding user request, or it is the first
 * turn of a session. It does not promote assistant prose to a user fact.
 */
export function hasMemorySourceLocalAssistantOriginCertificateV1(
  turns: readonly MemorySourceLocalIncludedTurnV1[],
  anchorTurnOrder: number,
  policy: MemoryAssistantOriginPolicyV1,
): boolean {
  if (!Number.isSafeInteger(anchorTurnOrder) || anchorTurnOrder < 1) {
    return false;
  }
  const hasAssistantAnchor = turns.some(
    (turn) =>
      turn.sourceKind === "assistant_output" &&
      turn.turnOrder === anchorTurnOrder,
  );
  return (
    hasAssistantAnchor &&
    ((policy === "allow_session_opening_artifact" && anchorTurnOrder === 1) ||
      hasMemorySourceLocalDialogueCertificateV1(turns, anchorTurnOrder))
  );
}

/**
 * Ranks exact anchors by evidence confidence inside the already-locked source
 * boundary. Source order is only a deterministic tie-break; a coarse source
 * rank must not hide a stronger exact turn. The per-source cap prevents one
 * conversation from consuming the whole candidate budget.
 */
export function rankMemorySourceLocalAnchorCandidatesV1<
  Candidate extends MemorySourceLocalAnchorCandidateV1,
>(input: {
  readonly candidates: readonly Candidate[];
  readonly lockedSourceIds: readonly string[];
  readonly maxCandidates: number;
  readonly maxCandidatesPerSource: number;
}): readonly Candidate[] {
  if (
    !Number.isSafeInteger(input.maxCandidates) ||
    input.maxCandidates < 1 ||
    !Number.isSafeInteger(input.maxCandidatesPerSource) ||
    input.maxCandidatesPerSource < 1
  ) {
    throw namedError("MemorySourceLocalEvidenceBudgetInvalid");
  }
  const sourcePriority = new Map(
    input.lockedSourceIds.map((sourceId, index) => [sourceId, index]),
  );
  if (
    sourcePriority.size !== input.lockedSourceIds.length ||
    input.lockedSourceIds.some((sourceId) => !sourceId.trim())
  ) {
    throw namedError("MemorySourceLocalEvidenceSourcesInvalid");
  }
  const bestByRef = new Map<string, Candidate>();
  for (const candidate of input.candidates) {
    if (
      !candidate.evidenceRef.trim() ||
      !sourcePriority.has(candidate.sourceId) ||
      !Number.isFinite(candidate.score)
    ) {
      throw namedError("MemorySourceLocalEvidenceHitInvalid");
    }
    const current = bestByRef.get(candidate.evidenceRef);
    if (current && current.sourceId !== candidate.sourceId) {
      throw namedError("MemorySourceLocalEvidenceHitInvalid");
    }
    if (!current || candidate.score > current.score) {
      bestByRef.set(candidate.evidenceRef, candidate);
    }
  }
  const candidates = [...bestByRef.values()].sort(
    (left, right) =>
      right.score - left.score ||
      (sourcePriority.get(left.sourceId) as number) -
        (sourcePriority.get(right.sourceId) as number) ||
      left.evidenceRef.localeCompare(right.evidenceRef),
  );
  const sourceCounts = new Map<string, number>();
  const ranked: Candidate[] = [];
  for (const candidate of candidates) {
    if (ranked.length >= input.maxCandidates) break;
    const sourceCount = sourceCounts.get(candidate.sourceId) ?? 0;
    if (sourceCount >= input.maxCandidatesPerSource) continue;
    sourceCounts.set(candidate.sourceId, sourceCount + 1);
    ranked.push(candidate);
  }
  return Object.freeze(ranked);
}

/**
 * First release gate. It deliberately excludes temporal, comparative and
 * convergent requests until those capabilities have their own evidence. A
 * lookup may contain several direct assistant-grounded requirements; the
 * resolver invokes the locator once per requirement and commits the local
 * supplement atomically.
 */
export function isMemorySourceLocalEvidenceEligibleV1(input: {
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
  if (
    (!new Set(["assistant", "any"]).has(input.roleConstraint) &&
      !certifiedUserCandidate) ||
    input.answerShape !== "lookup" ||
    input.temporalMode !== "any" ||
    input.requirements.length < 1 ||
    input.requirements.length > 4 ||
    (certifiedUserCandidate && input.requirements.length !== 1) ||
    !input.supportSelectorConfigured
  ) {
    return false;
  }
  return input.requirements.every(
    (requirement) =>
      requirement.roleConstraint === input.roleConstraint &&
      requirement.temporalMode === "any" &&
      (requirement.relation === undefined ||
        requirement.relation === "direct") &&
      (requirement.coverageMode === undefined ||
        requirement.coverageMode === "any") &&
      (requirement.minimumEvidence === undefined ||
        requirement.minimumEvidence === 1),
  );
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
  if (
    input.result.locatorVersion !== input.locator.locatorVersion ||
    !input.result.locatorRevision.trim() ||
    input.result.degradedChannels.length > 0 ||
    input.result.hits.length > input.request.budget.maxAnchors
  ) {
    throw namedError("MemorySourceLocalEvidenceResultInvalid");
  }
  const allowed = new Set(input.request.lockedSourceIds);
  if (
    input.request.assistantOriginPolicy !== "addressed_reply_only" &&
    input.request.assistantOriginPolicy !== "allow_session_opening_artifact"
  ) {
    throw namedError("MemorySourceLocalEvidencePolicyInvalid");
  }
  if (
    allowed.size === 0 ||
    allowed.size !== input.request.lockedSourceIds.length
  ) {
    throw namedError("MemorySourceLocalEvidenceSourcesInvalid");
  }
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
      hit.sourceKind !== "assistant_output" ||
      hit.anchorEvidenceRef !== hit.evidenceRef ||
      (hit.authority !== "context_only" &&
        hit.authority !== "user_confirmed_dialogue") ||
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
          turn.sourceKind !== "assistant_output" ||
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
      input.request.requirement.roleConstraint === "any" &&
      !hasMemorySourceLocalAssistantOriginCertificateV1(
        hit.includedTurns,
        anchorTurnOrder as number,
        input.request.assistantOriginPolicy,
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
  return Object.freeze([...input.result.hits]);
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
    ...new Set(
      input.result.hits.flatMap((hit) =>
        hit.includedTurns.map((turn) => turn.evidenceRef),
      ),
    ),
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
  const normalizedSearchText = input.request.requirement.searchText
    .replace(/\s+/gu, " ")
    .trim();
  return hashCanonicalJsonV1({
    schemaVersion: "paw.memory-source-local-evidence-cache-key.v2",
    locatorVersion: input.locatorVersion,
    scopeFingerprint: input.scopeFingerprint,
    turnIndexRevision: input.turnIndexRevision,
    embeddingIdentity: input.embeddingIdentity ?? "none",
    searchTextHash: hashCanonicalJsonV1(normalizedSearchText as JsonValue),
    lockedSourceIds: [...input.request.lockedSourceIds].sort(),
    roleConstraint: input.request.requirement.roleConstraint,
    assistantOriginPolicy: input.request.assistantOriginPolicy,
    temporalMode: input.request.requirement.temporalMode,
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
