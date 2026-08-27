import type { MemoryEntry } from "@paw/memory/longterm";
import type { JsonValue, MemoryPersonaClaimV1 } from "@paw/protocol";

import { canonicalJsonStringifyV1, hashTextV1 } from "./canonical.js";

export interface MemoryPersonaEvidenceProjectionV1 {
  readonly projectionRevision: string;
  readonly projectionKey: string;
  readonly claims: readonly MemoryPersonaClaimV1[];
  readonly sourceCount: number;
}

export function projectMemoryPersonaEvidenceV1(
  input: Readonly<{
    entries: readonly MemoryEntry[];
    minimumConfidence: number;
    maxClaims: number;
    maxChars: number;
  }>,
): MemoryPersonaEvidenceProjectionV1 {
  assertBudget(input);
  const candidates = input.entries
    .flatMap((entry) => toCandidate(entry, input.minimumConfidence))
    .sort(compareCandidates);
  assertUniqueIds(candidates);
  const revisionPayload = candidates.map(({ claim, sourceKeys }) => ({
    ...claim,
    sourceKeys,
  }));
  const projectionRevision = hashCanonical(revisionPayload as JsonValue);
  const diverse: Candidate[] = [];
  const deferred: Candidate[] = [];
  const seenSources = new Set<string>();
  for (const candidate of candidates) {
    const unseen = candidate.sourceKeys.find(
      (source) => !seenSources.has(source),
    );
    if (unseen) {
      diverse.push(candidate);
      for (const source of candidate.sourceKeys) seenSources.add(source);
    } else {
      deferred.push(candidate);
    }
  }
  const selected: Candidate[] = [];
  let chars = 0;
  for (const candidate of [...diverse, ...deferred]) {
    if (selected.length >= input.maxClaims) break;
    const claimChars = canonicalJsonStringifyV1(
      candidate.claim as unknown as JsonValue,
    ).length;
    const nextChars = chars + claimChars;
    if (nextChars > input.maxChars) continue;
    selected.push(candidate);
    chars = nextChars;
  }
  const claims = Object.freeze(selected.map((candidate) => candidate.claim));
  const sources = new Set(
    selected.flatMap((candidate) => candidate.sourceKeys),
  );
  const projectionKey = hashCanonical({
    projectionRevision,
    claims,
  } as unknown as JsonValue);
  return Object.freeze({
    projectionRevision,
    projectionKey,
    claims,
    sourceCount: sources.size,
  });
}

interface Candidate {
  readonly claim: MemoryPersonaClaimV1;
  readonly sourceKeys: readonly string[];
  readonly evolution: boolean;
}

const EVOLUTION_SIGNALS = [
  /\b(?:abandon(?:ed|ing)?|changed?|evolv(?:ed|ing)|no longer|reconsider(?:ed|ing)?|re-?evaluat(?:ed|ing)?|resum(?:ed|ing)|shift(?:ed|ing)?|stopped?|switched?|used to)\b/iu,
  /放弃|改变|变化|不再|重新考虑|重新评估|恢复|转变|停止|曾经/u,
] as const;

function toCandidate(
  entry: MemoryEntry,
  minimumConfidence: number,
): readonly Candidate[] {
  if (
    entry.tInvalid !== null ||
    entry.confidence < minimumConfidence ||
    entry.kind !== "profile"
  ) {
    return [];
  }
  const statement = entry.insight;
  if (!statement.trim()) return [];
  const evidenceRefs = Object.freeze(
    [...new Set(entry.evidence.filter((ref) => ref.trim()))].sort(),
  );
  const sourceKeys = Object.freeze(
    [...new Set(evidenceRefs.map(sourceKey))].sort(),
  );
  return [
    Object.freeze({
      claim: Object.freeze({
        memoryId: entry.id,
        kind: "profile",
        statement: statement.slice(0, 4_096),
        confidence: clamp(entry.confidence),
        validFrom: entry.tValid,
        evidenceRefs,
      }),
      sourceKeys:
        sourceKeys.length > 0
          ? sourceKeys
          : Object.freeze([`authority:${entry.source}`]),
      evolution: EVOLUTION_SIGNALS.some((pattern) => pattern.test(statement)),
    }),
  ];
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.evolution !== right.evolution) return left.evolution ? -1 : 1;
  const confidence = right.claim.confidence - left.claim.confidence;
  if (confidence !== 0) return confidence;
  const validFrom =
    Date.parse(right.claim.validFrom) - Date.parse(left.claim.validFrom);
  if (Number.isFinite(validFrom) && validFrom !== 0) return validFrom;
  return left.claim.memoryId.localeCompare(right.claim.memoryId);
}

function sourceKey(ref: string): string {
  const hash = ref.indexOf("#");
  return (hash < 0 ? ref : ref.slice(0, hash)).slice(0, 1_024);
}

function assertUniqueIds(candidates: readonly Candidate[]): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.claim.memoryId)) {
      throw namedError("MemoryPersonaEntryDuplicate");
    }
    ids.add(candidate.claim.memoryId);
  }
}

function assertBudget(
  input: Readonly<{
    minimumConfidence: number;
    maxClaims: number;
    maxChars: number;
  }>,
): void {
  if (
    !Number.isFinite(input.minimumConfidence) ||
    input.minimumConfidence < 0 ||
    input.minimumConfidence > 1 ||
    !Number.isSafeInteger(input.maxClaims) ||
    input.maxClaims < 1 ||
    input.maxClaims > 64 ||
    !Number.isSafeInteger(input.maxChars) ||
    input.maxChars < 1 ||
    input.maxChars > 16_384
  ) {
    throw namedError("MemoryPersonaBudgetInvalid");
  }
}

function hashCanonical(value: JsonValue): string {
  return hashTextV1(canonicalJsonStringifyV1(value));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
