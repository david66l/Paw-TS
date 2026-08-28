import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import type {
  MemoryConversationTurnKindV1,
  MemoryEvidenceNotebookHitV1,
} from "./evidence-first.js";
import type { MemoryEvidenceRequirementV3 } from "./evidence-query-planner.js";
import { evidenceSourceIdV1 } from "./evidence-ref.js";

export const PAW_MEMORY_SOURCE_LOCAL_EVIDENCE_LOCATOR_PORT_VERSION_V1 =
  "paw.memory-source-local-evidence-locator-port.v1" as const;

export interface MemorySourceLocalEvidenceBudgetV1 {
  readonly maxAnchors: number;
  readonly maxAnchorsPerSource: number;
  readonly neighborRadius: number;
  readonly maxCandidatesPerChannel: number;
  readonly maxChars: number;
}

export interface MemorySourceLocalEvidenceRequestV1 {
  readonly requirement: MemoryEvidenceRequirementV3;
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

export type MemorySourceLocalizationStatusV1 =
  | "not_needed"
  | "not_configured"
  | "completed"
  | "completed_empty"
  | "fallback"
  | "invalid_result";

export interface MemorySourceLocalizationReportV1 {
  readonly status: MemorySourceLocalizationStatusV1;
  readonly reasonCode: string;
  readonly locatorVersion?: string;
  readonly locatorRevision?: string;
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
 * First release gate. It deliberately excludes temporal, comparative and
 * convergent requests until those capabilities have their own evidence.
 */
export function isMemorySourceLocalEvidenceEligibleV1(input: {
  readonly answerShape: string;
  readonly temporalMode: string;
  readonly roleConstraint: string;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly supportSelectorConfigured: boolean;
}): boolean {
  if (
    input.roleConstraint !== "assistant" ||
    input.answerShape !== "lookup" ||
    input.temporalMode !== "any" ||
    input.requirements.length !== 1 ||
    !input.supportSelectorConfigured
  ) {
    return false;
  }
  const requirement = input.requirements[0];
  return (
    requirement !== undefined &&
    requirement.roleConstraint === "assistant" &&
    requirement.temporalMode === "any" &&
    (requirement.relation === undefined || requirement.relation === "direct") &&
    (requirement.coverageMode === undefined ||
      requirement.coverageMode === "any") &&
    (requirement.minimumEvidence === undefined ||
      requirement.minimumEvidence === 1)
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
    schemaVersion: "paw.memory-source-local-evidence-cache-key.v1",
    locatorVersion: input.locatorVersion,
    scopeFingerprint: input.scopeFingerprint,
    turnIndexRevision: input.turnIndexRevision,
    embeddingIdentity: input.embeddingIdentity ?? "none",
    searchTextHash: hashCanonicalJsonV1(normalizedSearchText as JsonValue),
    lockedSourceIds: [...input.request.lockedSourceIds].sort(),
    roleConstraint: input.request.requirement.roleConstraint,
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
