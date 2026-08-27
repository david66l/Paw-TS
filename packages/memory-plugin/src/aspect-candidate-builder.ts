import type { JsonValue } from "@paw/protocol";

import {
  DEFAULT_MEMORY_ASPECT_CONTEXT_KEY_V1,
  type MemoryAspectGraphSnapshotV1,
  type MemoryAspectV1,
  type MemoryClaimAspectMembershipV1,
  defaultMemoryAspectSubjectKeyV1,
  measureMemoryAspectGraphV1,
  resolveMemoryAspectIdsV1,
} from "./aspect-graph.js";
import {
  type MemoryAspectLinkCandidateV1,
  type MemoryAspectLinkClaimV1,
  type MemoryAspectLinkRelationCandidatesV1,
  type MemoryAspectLinkRepresentativeV1,
  type MemoryAspectLinkingInputV1,
  PAW_MEMORY_ASPECT_LINKER_MAX_CANDIDATE_ASPECTS_V1,
  PAW_MEMORY_ASPECT_LINKER_MAX_CLAIMS_V1,
  PAW_MEMORY_ASPECT_LINKER_MAX_RELATION_TARGETS_V1,
  PAW_MEMORY_ASPECT_LINKER_MAX_REPRESENTATIVES_V1,
  buildMemoryAspectLinkerRequestV1,
  deriveMemoryAspectLinkStatementHashV1,
} from "./aspect-linker.js";
import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";

export const PAW_MEMORY_ASPECT_CANDIDATE_BUILDER_VERSION_V1 =
  "paw.memory-aspect-candidate-builder.v1:lexical" as const;

export interface MemoryAspectCandidateEvidenceV1 {
  readonly claimId: string;
  readonly statement: string;
  readonly statementHash: string;
}

export interface MemoryAspectCandidateBuilderInputV1 {
  readonly scope: PawNextMemoryScopeV1;
  readonly snapshot: MemoryAspectGraphSnapshotV1;
  readonly observedAt: string;
  readonly claims: readonly MemoryAspectLinkClaimV1[];
  /** Authoritative text receipts for existing graph claims. */
  readonly catalog: readonly MemoryAspectCandidateEvidenceV1[];
  readonly maxNewAspects: number;
  /** Membership phase can disable relation evidence and link edges later. */
  readonly includeRelations?: boolean;
  /** Consolidation pass may expose only Aspects not already assigned. */
  readonly excludeExistingMemberships?: boolean;
}

export interface MemoryAspectCandidateBuilderMetricsV1 {
  readonly catalogClaimCount: number;
  readonly eligibleAspectCount: number;
  readonly positivelyScoredAspectCount: number;
  readonly candidateAspectCount: number;
  readonly representativeCount: number;
  readonly relationEvidenceCount: number;
  readonly relationTargetCount: number;
  readonly truncatedAspectCount: number;
  readonly truncatedRepresentativeCount: number;
  readonly truncatedRelationTargetCount: number;
  readonly promptChars: number;
}

export interface MemoryAspectCandidateBuildV1 {
  readonly builderVersion: typeof PAW_MEMORY_ASPECT_CANDIDATE_BUILDER_VERSION_V1;
  readonly sourceGraphRevision: string;
  readonly candidateRevision: string;
  readonly linkingInput: MemoryAspectLinkingInputV1;
  readonly metrics: MemoryAspectCandidateBuilderMetricsV1;
}

interface RankedRepresentativeV1 {
  readonly evidence: MemoryAspectCandidateEvidenceV1;
  readonly score: number;
}

interface RankedAspectV1 {
  readonly aspect: MemoryAspectV1;
  readonly score: number;
  readonly eligible: boolean;
  readonly representatives: readonly RankedRepresentativeV1[];
}

/**
 * Builds the complete bounded linker packet without an LLM. Candidate ranking
 * is deterministic and scope-local; zero-overlap aspects are not hydrated.
 */
export function buildMemoryAspectLinkCandidatesV1(
  input: MemoryAspectCandidateBuilderInputV1,
): MemoryAspectCandidateBuildV1 {
  validateInput(input);
  const inputClaimIds = new Set(input.claims.map((claim) => claim.claimId));
  const catalog = new Map(input.catalog.map((item) => [item.claimId, item]));
  const queryTerms = input.claims.map((claim) => terms(claim.statement));
  const termWeights = inverseDocumentWeights(
    [...catalog.values()].map((item) => terms(item.statement)),
  );
  const activeMemberships = eligibleMemberships(input);
  const existingAspectIds = new Set(
    activeMemberships
      .filter((membership) => inputClaimIds.has(membership.claimId))
      .flatMap((membership) => {
        const aspectId = candidateAspectId(input.snapshot, membership);
        return aspectId === null ? [] : [aspectId];
      }),
  );
  const memberships = activeMemberships.filter(
    (membership) => !inputClaimIds.has(membership.claimId),
  );
  const membersByAspect = new Map<string, MemoryClaimAspectMembershipV1[]>();
  for (const membership of memberships) {
    const resolvedAspectId = candidateAspectId(input.snapshot, membership);
    if (resolvedAspectId === null) continue;
    const group = membersByAspect.get(resolvedAspectId) ?? [];
    group.push(membership);
    membersByAspect.set(resolvedAspectId, group);
  }

  const ranked = input.snapshot.aspects
    .filter((aspect) => aspect.status === "active")
    .filter(
      (aspect) =>
        input.excludeExistingMemberships !== true ||
        !existingAspectIds.has(aspect.id),
    )
    .map((aspect) =>
      rankAspect(
        aspect,
        membersByAspect.get(aspect.id) ?? [],
        catalog,
        queryTerms,
        termWeights,
      ),
    )
    .filter((item) => item.eligible && item.representatives.length > 0)
    .sort(compareRankedAspects);
  const selected = ranked.slice(
    0,
    PAW_MEMORY_ASPECT_LINKER_MAX_CANDIDATE_ASPECTS_V1,
  );
  const aspectCandidates: readonly MemoryAspectLinkCandidateV1[] =
    Object.freeze(
      selected.map((item) =>
        Object.freeze({
          aspectId: item.aspect.id,
          representatives: Object.freeze(
            item.representatives
              .slice(0, PAW_MEMORY_ASPECT_LINKER_MAX_REPRESENTATIVES_V1)
              .map(({ evidence }) => Object.freeze({ ...evidence })),
          ),
        }),
      ),
    );
  const relationEvidence = new Map<string, MemoryAspectLinkRepresentativeV1>();
  let truncatedRelationTargetCount = 0;
  const relationCandidates: readonly MemoryAspectLinkRelationCandidatesV1[] =
    Object.freeze(
      input.claims.map((claim) => {
        if (input.includeRelations === false) {
          return Object.freeze({ claimId: claim.claimId, targetClaimIds: [] });
        }
        const claimTerms = terms(claim.statement);
        const rankedTargets = selected.flatMap((aspect, aspectIndex) => {
          const quota = RELATION_TARGET_QUOTAS[aspectIndex] ?? 0;
          truncatedRelationTargetCount += Math.max(
            0,
            aspect.representatives.length - quota,
          );
          if (quota === 0) return [];
          return aspect.representatives
            .map(({ evidence }) => ({
              evidence,
              score: lexicalScore(
                claimTerms,
                terms(evidence.statement),
                termWeights,
              ),
            }))
            .sort(
              (left, right) =>
                right.score - left.score ||
                left.evidence.claimId.localeCompare(right.evidence.claimId),
            )
            .slice(0, quota);
        });
        const uniqueTargets = [
          ...new Map(
            rankedTargets.map((target) => [target.evidence.claimId, target]),
          ).values(),
        ];
        for (const target of uniqueTargets) {
          relationEvidence.set(target.evidence.claimId, target.evidence);
        }
        if (
          uniqueTargets.length >
          PAW_MEMORY_ASPECT_LINKER_MAX_RELATION_TARGETS_V1
        ) {
          truncatedRelationTargetCount +=
            uniqueTargets.length -
            PAW_MEMORY_ASPECT_LINKER_MAX_RELATION_TARGETS_V1;
        }
        return Object.freeze({
          claimId: claim.claimId,
          targetClaimIds: Object.freeze(
            uniqueTargets
              .slice(0, PAW_MEMORY_ASPECT_LINKER_MAX_RELATION_TARGETS_V1)
              .map((target) => target.evidence.claimId),
          ),
        });
      }),
    );
  const relationEvidenceValues = Object.freeze(
    [...relationEvidence.values()]
      .sort((left, right) => left.claimId.localeCompare(right.claimId))
      .map((item) => Object.freeze({ ...item })),
  );
  const linkingInput: MemoryAspectLinkingInputV1 = Object.freeze({
    scope: input.scope,
    snapshot: input.snapshot,
    observedAt: input.observedAt,
    claims: Object.freeze(
      input.claims.map((claim) => Object.freeze({ ...claim })),
    ),
    aspectCandidates,
    relationEvidence: relationEvidenceValues,
    relationCandidates,
    maxNewAspects: input.maxNewAspects,
  });
  const request = buildMemoryAspectLinkerRequestV1(linkingInput);
  const selectedRepresentativeCount = aspectCandidates.reduce(
    (count, candidate) => count + candidate.representatives.length,
    0,
  );
  const metrics: MemoryAspectCandidateBuilderMetricsV1 = Object.freeze({
    catalogClaimCount: catalog.size,
    eligibleAspectCount: membersByAspect.size,
    positivelyScoredAspectCount: ranked.length,
    candidateAspectCount: aspectCandidates.length,
    representativeCount: selectedRepresentativeCount,
    relationEvidenceCount: relationEvidenceValues.length,
    relationTargetCount: relationCandidates.reduce(
      (count, item) => count + item.targetClaimIds.length,
      0,
    ),
    truncatedAspectCount: Math.max(
      0,
      ranked.length - PAW_MEMORY_ASPECT_LINKER_MAX_CANDIDATE_ASPECTS_V1,
    ),
    truncatedRepresentativeCount: selected.reduce(
      (count, item) =>
        count +
        Math.max(
          0,
          item.representatives.length -
            PAW_MEMORY_ASPECT_LINKER_MAX_REPRESENTATIVES_V1,
        ),
      0,
    ),
    truncatedRelationTargetCount,
    promptChars: request.system.length + request.user.length,
  });
  const candidateRevision = hashCanonicalJsonV1({
    schemaVersion: PAW_MEMORY_ASPECT_CANDIDATE_BUILDER_VERSION_V1,
    graphRevision: input.snapshot.revision,
    observedAt: input.observedAt,
    includeRelations: input.includeRelations !== false,
    excludeExistingMemberships: input.excludeExistingMemberships === true,
    claims: input.claims.map((claim) => ({
      claimId: claim.claimId,
      statementHash: claim.statementHash,
    })),
    aspectCandidates: aspectCandidates.map((candidate) => ({
      aspectId: candidate.aspectId,
      representatives: candidate.representatives.map((item) => ({
        claimId: item.claimId,
        statementHash: item.statementHash,
      })),
    })),
    relationEvidence: relationEvidenceValues.map((item) => ({
      claimId: item.claimId,
      statementHash: item.statementHash,
    })),
    relationCandidates: relationCandidates.map((candidate) => ({
      claimId: candidate.claimId,
      targetClaimIds: [...candidate.targetClaimIds],
    })),
    metrics: { ...metrics },
  } as JsonValue);
  return Object.freeze({
    builderVersion: PAW_MEMORY_ASPECT_CANDIDATE_BUILDER_VERSION_V1,
    sourceGraphRevision: input.snapshot.revision,
    candidateRevision,
    linkingInput,
    metrics,
  });
}

function validateInput(input: MemoryAspectCandidateBuilderInputV1): void {
  measureMemoryAspectGraphV1(input.snapshot);
  if (
    input.snapshot.scopeFingerprint !== memoryScopeFingerprintV1(input.scope) ||
    canonicalIso(input.observedAt) !== input.observedAt ||
    input.claims.length < 1 ||
    input.claims.length > PAW_MEMORY_ASPECT_LINKER_MAX_CLAIMS_V1
  ) {
    throw namedError("MemoryAspectCandidateBuilderInputInvalid");
  }
  const graphClaims = new Set(input.snapshot.claims.map((claim) => claim.id));
  const inputIds = new Set<string>();
  for (const claim of input.claims) {
    if (
      !graphClaims.has(claim.claimId) ||
      inputIds.has(claim.claimId) ||
      deriveMemoryAspectLinkStatementHashV1(claim.statement) !==
        claim.statementHash
    ) {
      throw namedError("MemoryAspectCandidateBuilderClaimInvalid");
    }
    inputIds.add(claim.claimId);
  }
  const catalogIds = new Set<string>();
  for (const item of input.catalog) {
    if (
      !graphClaims.has(item.claimId) ||
      inputIds.has(item.claimId) ||
      catalogIds.has(item.claimId) ||
      deriveMemoryAspectLinkStatementHashV1(item.statement) !==
        item.statementHash
    ) {
      throw namedError("MemoryAspectCandidateBuilderCatalogInvalid");
    }
    catalogIds.add(item.claimId);
  }
}

function eligibleMemberships(
  input: MemoryAspectCandidateBuilderInputV1,
): readonly MemoryClaimAspectMembershipV1[] {
  const subjectKey = defaultMemoryAspectSubjectKeyV1(input.scope);
  const retracted = new Set(
    input.snapshot.lifecycleEvents
      .filter(
        (event) =>
          event.targetKind === "membership" &&
          Date.parse(event.occurredAt) <= Date.parse(input.observedAt),
      )
      .map((event) => event.targetId),
  );
  return input.snapshot.memberships.filter(
    (membership) =>
      membership.subjectKey === subjectKey &&
      membership.contextKey === DEFAULT_MEMORY_ASPECT_CONTEXT_KEY_V1 &&
      Date.parse(membership.createdAt) <= Date.parse(input.observedAt) &&
      !retracted.has(membership.id),
  );
}

function candidateAspectId(
  snapshot: MemoryAspectGraphSnapshotV1,
  membership: MemoryClaimAspectMembershipV1,
): string | null {
  const source = snapshot.aspects.find(
    (aspect) => aspect.id === membership.aspectId,
  );
  if (source?.status === "active") return source.id;
  if (source?.status !== "redirected") return null;
  const resolved = resolveMemoryAspectIdsV1(snapshot, source.id);
  return resolved.length === 1 ? (resolved[0] ?? null) : null;
}

function rankAspect(
  aspect: MemoryAspectV1,
  memberships: readonly MemoryClaimAspectMembershipV1[],
  catalog: ReadonlyMap<string, MemoryAspectCandidateEvidenceV1>,
  queryTerms: readonly ReadonlySet<string>[],
  termWeights: ReadonlyMap<string, number>,
): RankedAspectV1 {
  const identityTerms = terms(
    [aspect.displayName, ...aspect.aliases].join(" "),
  );
  const identityMatched = queryTerms.some(
    (query) => discriminantOverlapCount(query, identityTerms, termWeights) >= 1,
  );
  const identityScore = queryTerms.reduce(
    (score, query) =>
      Math.max(score, lexicalScore(query, identityTerms, termWeights) * 4),
    0,
  );
  const representatives = memberships
    .flatMap((membership) => {
      const evidence = catalog.get(membership.claimId);
      if (evidence === undefined) return [];
      const candidateTerms = terms(evidence.statement);
      const score = queryTerms.reduce(
        (best, query) =>
          Math.max(best, lexicalScore(query, candidateTerms, termWeights)),
        0,
      );
      return [{ evidence, score }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.evidence.claimId.localeCompare(right.evidence.claimId),
    );
  const memberMatched = representatives.some(({ evidence }) =>
    queryTerms.some(
      (query) =>
        discriminantOverlapCount(
          query,
          terms(evidence.statement),
          termWeights,
        ) >= 2,
    ),
  );
  return {
    aspect,
    score: identityScore + (representatives[0]?.score ?? 0),
    eligible: identityMatched || memberMatched,
    representatives,
  };
}

function compareRankedAspects(
  left: RankedAspectV1,
  right: RankedAspectV1,
): number {
  return (
    right.score - left.score || left.aspect.id.localeCompare(right.aspect.id)
  );
}

function lexicalScore(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  weights: ReadonlyMap<string, number>,
): number {
  let overlap = 0;
  for (const term of left) {
    if (!right.has(term)) continue;
    overlap += (weights.get(term) ?? 1) * (1 + Math.min(12, term.length) / 12);
  }
  if (overlap === 0) return 0;
  return overlap / Math.sqrt(Math.max(1, left.size) * Math.max(1, right.size));
}

function discriminantOverlapCount(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
  weights: ReadonlyMap<string, number>,
): number {
  let count = 0;
  for (const term of left) {
    if (right.has(term) && (weights.get(term) ?? 1) >= 0.25) count += 1;
  }
  return count;
}

function inverseDocumentWeights(
  documents: readonly ReadonlySet<string>[],
): ReadonlyMap<string, number> {
  const documentCount = documents.length;
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    for (const term of document) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
  }
  return new Map(
    [...frequencies].map(([term, frequency]) => [
      term,
      Math.log((documentCount + 1) / (frequency + 1)),
    ]),
  );
}

function terms(value: string): ReadonlySet<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const result = new Set(
    (normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(
      (term) => !ENGLISH_STOP_WORDS.has(term),
    ),
  );
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...match[0]];
    for (let index = 0; index + 1 < chars.length; index += 1) {
      result.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return result;
}

function canonicalIso(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw namedError("MemoryAspectCandidateBuilderTimeInvalid");
  }
  return parsed.toISOString();
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** Relation evidence follows Aspect rank; membership candidates 5-6 stay visible. */
const RELATION_TARGET_QUOTAS = Object.freeze([4, 3, 3, 2, 0, 0] as const);

const ENGLISH_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "been",
  "before",
  "but",
  "for",
  "from",
  "has",
  "have",
  "into",
  "its",
  "now",
  "that",
  "the",
  "their",
  "then",
  "they",
  "this",
  "uses",
  "was",
  "were",
  "will",
  "with",
]);
