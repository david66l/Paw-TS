import type { MemoryEntry } from "@paw/memory/longterm";
import {
  type JsonValue,
  MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
  type MemoryTopicEvidenceStateV1,
  type MemoryTopicIndexEntryV1,
} from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";
import type { MemoryTopicProjectionV1 } from "./topic-trajectory.js";

export const PAW_MEMORY_TOPIC_EVIDENCE_PLANNER_VERSION_V1 =
  MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1;

export interface MemoryTopicEvidenceCatalogItemV1 {
  readonly projection: MemoryTopicProjectionV1;
  readonly entries: readonly MemoryEntry[];
}

export interface MemoryTopicEvidencePlanV1 {
  readonly plannerVersion: typeof PAW_MEMORY_TOPIC_EVIDENCE_PLANNER_VERSION_V1;
  readonly scopeFingerprint: string;
  readonly indexRevision: string;
  readonly indexEntries: readonly MemoryTopicIndexEntryV1[];
  readonly evidenceStates: readonly MemoryTopicEvidenceStateV1[];
}

/**
 * Deterministic evidence selection. There are no benchmark/task categories:
 * topics and states are ranked only by query overlap, currentness and recency.
 */
export function planMemoryTopicEvidenceV1(
  input: Readonly<{
    query: string;
    scopeFingerprint: string;
    catalog: readonly MemoryTopicEvidenceCatalogItemV1[];
    maxIndexTopics?: number;
    maxSelectedTopics?: number;
    maxStates?: number;
    maxEvidenceChars?: number;
  }>,
): MemoryTopicEvidencePlanV1 {
  const query = boundedText(
    input.query,
    8_192,
    "MemoryTopicEvidenceQueryInvalid",
  );
  const scopeFingerprint = boundedText(
    input.scopeFingerprint,
    512,
    "MemoryTopicEvidenceScopeInvalid",
  );
  const maxIndexTopics = boundedInteger(
    input.maxIndexTopics ?? 96,
    1,
    128,
    "MemoryTopicIndexBudgetInvalid",
  );
  const maxSelectedTopics = boundedInteger(
    input.maxSelectedTopics ?? 3,
    1,
    8,
    "MemoryTopicSelectionBudgetInvalid",
  );
  const maxStates = boundedInteger(
    input.maxStates ?? 16,
    1,
    32,
    "MemoryTopicStateBudgetInvalid",
  );
  const maxEvidenceChars = boundedInteger(
    input.maxEvidenceChars ?? 8_000,
    1_024,
    32_768,
    "MemoryTopicEvidenceCharBudgetInvalid",
  );
  const topicIds = new Set<string>();
  const normalizedCatalog = input.catalog.map((item) => {
    const { topic, snapshot } = item.projection;
    if (
      topic.scope.tenantId === undefined ||
      snapshot.scopeFingerprint !== scopeFingerprint ||
      topicIds.has(topic.id)
    ) {
      throw namedError("MemoryTopicEvidenceCatalogInvalid");
    }
    topicIds.add(topic.id);
    const entries = new Map<string, MemoryEntry>();
    for (const entry of item.entries) {
      if (!entry.id.trim() || entries.has(entry.id)) {
        throw namedError("MemoryTopicEvidenceEntryInvalid");
      }
      entries.set(entry.id, entry);
    }
    if (snapshot.memberMemoryIds.some((id) => !entries.has(id))) {
      throw namedError("MemoryTopicEvidenceEntrySetIncomplete");
    }
    return Object.freeze({ item, entries });
  });
  const indexEntries = Object.freeze(
    normalizedCatalog
      .map(({ item }) => toIndexEntry(item.projection))
      .sort(
        (left, right) =>
          left.normalizedName.localeCompare(right.normalizedName) ||
          left.topicId.localeCompare(right.topicId),
      )
      .slice(0, maxIndexTopics),
  );
  const visibleTopicIds = new Set(indexEntries.map((entry) => entry.topicId));
  const queryTerms = terms(query);
  const selected = normalizedCatalog
    .filter(({ item }) => visibleTopicIds.has(item.projection.topic.id))
    .map(({ item, entries }) => ({
      item,
      entries,
      score: topicScore(item, entries, queryTerms),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.item.projection.topic.createdAt.localeCompare(
          left.item.projection.topic.createdAt,
        ) ||
        left.item.projection.topic.id.localeCompare(
          right.item.projection.topic.id,
        ),
    )
    .slice(0, maxSelectedTopics);
  const candidates: Array<{
    state: MemoryTopicEvidenceStateV1;
    score: number;
  }> = [];
  for (const selectedTopic of selected) {
    const { topic, snapshot } = selectedTopic.item.projection;
    for (const trajectory of snapshot.trajectories) {
      for (const state of trajectory.states) {
        const entry = selectedTopic.entries.get(state.memoryId);
        if (!entry || entry.kind === "vault_ref") continue;
        const statement = renderEntry(entry).slice(0, 2_048);
        const evidenceRefs = Object.freeze(
          state.evidenceRefs.slice(0, 8).map((ref) => ref.slice(0, 256)),
        );
        candidates.push({
          state: Object.freeze({
            topicId: topic.id,
            snapshotId: snapshot.id,
            trajectoryId: trajectory.trajectoryId,
            memoryId: state.memoryId,
            state: state.status,
            statement,
            validFrom: state.validFrom,
            ...(state.validTo === null ? {} : { validTo: state.validTo }),
            evidenceRefs,
          }),
          score:
            selectedTopic.score * 100 +
            overlapScore(queryTerms, terms(statement)) * 10 +
            (state.status === "current" ? 2 : 0) +
            recencyScore(state.validFrom),
        });
      }
    }
  }
  const evidenceStates: MemoryTopicEvidenceStateV1[] = [];
  let evidenceChars = 0;
  for (const candidate of candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.state.validFrom.localeCompare(left.state.validFrom) ||
      left.state.memoryId.localeCompare(right.state.memoryId),
  )) {
    if (evidenceStates.length >= maxStates) break;
    const fixedChars =
      256 +
      candidate.state.topicId.length +
      candidate.state.snapshotId.length +
      candidate.state.trajectoryId.length +
      candidate.state.memoryId.length +
      candidate.state.evidenceRefs.reduce((sum, ref) => sum + ref.length, 0);
    const remaining = maxEvidenceChars - evidenceChars - fixedChars;
    if (remaining < 32) continue;
    const statement = candidate.state.statement.slice(0, remaining);
    evidenceStates.push(Object.freeze({ ...candidate.state, statement }));
    evidenceChars += fixedChars + statement.length;
  }
  const indexRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-topic-index.v1",
    scopeFingerprint,
    entries: indexEntries,
  } as unknown as JsonValue);
  return Object.freeze({
    plannerVersion: PAW_MEMORY_TOPIC_EVIDENCE_PLANNER_VERSION_V1,
    scopeFingerprint,
    indexRevision,
    indexEntries,
    evidenceStates: Object.freeze(evidenceStates),
  });
}

function toIndexEntry(
  projection: MemoryTopicProjectionV1,
): MemoryTopicIndexEntryV1 {
  return Object.freeze({
    topicId: projection.topic.id,
    snapshotId: projection.snapshot.id,
    family: projection.topic.family,
    canonicalName: projection.topic.canonicalName,
    normalizedName: projection.topic.normalizedName,
    memberCount: projection.snapshot.memberMemoryIds.length,
    trajectoryCount: projection.snapshot.trajectories.length,
    projectionHash: projection.topic.projectionHash,
  });
}

function topicScore(
  item: MemoryTopicEvidenceCatalogItemV1,
  entries: ReadonlyMap<string, MemoryEntry>,
  queryTerms: ReadonlySet<string>,
): number {
  const topic = item.projection.topic;
  let score =
    overlapScore(
      queryTerms,
      terms(`${topic.canonicalName} ${topic.normalizedName} ${topic.family}`),
    ) * 4;
  for (const trajectory of item.projection.snapshot.trajectories) {
    for (const state of trajectory.states) {
      if (state.status !== "current") continue;
      const entry = entries.get(state.memoryId);
      if (entry && entry.kind !== "vault_ref") {
        score += overlapScore(queryTerms, terms(renderEntry(entry)));
      }
    }
  }
  return score;
}

function renderEntry(
  entry: Exclude<MemoryEntry, { kind: "vault_ref" }>,
): string {
  if (entry.kind === "semantic") return entry.fact;
  if (entry.kind === "profile") return entry.insight;
  return [entry.whenToUse, entry.perspective, ...entry.modification]
    .filter(Boolean)
    .join("\n");
}

function terms(value: string): ReadonlySet<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const result = new Set(normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? []);
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const characters = [...match[0]];
    for (let index = 0; index + 1 < characters.length; index += 1) {
      result.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return result;
}

function overlapScore(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let score = 0;
  for (const term of left) if (right.has(term)) score += 1;
  return score;
}

function recencyScore(validFrom: string): number {
  const milliseconds = Date.parse(validFrom);
  if (!Number.isFinite(milliseconds)) return 0;
  return Math.min(0.999, Math.max(0, milliseconds / 10_000_000_000_000));
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  errorName: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw namedError(errorName);
  }
  return value;
}

function boundedText(
  value: string,
  maximum: number,
  errorName: string,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw namedError(errorName);
  return normalized;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
