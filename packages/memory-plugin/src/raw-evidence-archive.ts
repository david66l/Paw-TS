import { getSql } from "@paw/memory/db";
import { scanForSecrets } from "@paw/memory/longterm";
import type { MemoryRawEvidenceSpanV1 } from "@paw/protocol";

import { hashCanonicalJsonV1, hashTextV1 } from "./canonical.js";
import {
  PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1,
  buildMemoryConversationTurnBundleV1,
} from "./evidence-first.js";
import type { PawNextMemoryScopeV1 } from "./profile.js";

export type MemoryRawEvidenceSourceKindV1 =
  | "user_input"
  | "assistant_output"
  | "tool_observation"
  | "verification"
  | "outcome"
  | "source_document";

export interface MemoryRawEvidenceArchiveInputV1 {
  readonly evidenceRef: string;
  readonly sourceKind: MemoryRawEvidenceSourceKindV1;
  readonly sourceSeq: number;
  readonly content: string;
  readonly createdAt: string;
}

export interface MemoryRawEvidenceRequestV1 {
  readonly evidenceRef: string;
  readonly memoryIds: readonly string[];
}

export interface MemoryConversationEvidenceV1 {
  readonly evidenceRef: string;
  readonly sourceKind: MemoryRawEvidenceSourceKindV1;
  readonly sourceSeq: number;
  readonly authority:
    | "user_asserted"
    | "user_confirmed_dialogue"
    | "context_only";
  readonly content: string;
  readonly contentHash: string;
  /** Query-focused text from the matched turn itself, excluding neighbors. */
  readonly hitContent: string;
  readonly hitContentHash: string;
  readonly createdAt: string;
}

export interface MemoryConversationSearchV1 {
  readonly query: string;
  readonly maxSpans: number;
  readonly maxChars: number;
}

export interface MemoryRawEvidenceArchiveV1 {
  readonly scope: PawNextMemoryScopeV1;
  put(
    spans: readonly MemoryRawEvidenceArchiveInputV1[],
    signal: AbortSignal,
  ): Promise<void>;
  resolve(
    requests: readonly MemoryRawEvidenceRequestV1[],
    signal: AbortSignal,
  ): Promise<readonly MemoryRawEvidenceSpanV1[]>;
  /** Optional L0 search aperture used by the read-only memory tool plugin. */
  search?(
    query: MemoryConversationSearchV1,
    signal: AbortSignal,
  ): Promise<readonly MemoryConversationEvidenceV1[]>;
}

export interface MemoryRawEvidenceArchiveEventV1 {
  readonly schemaVersion: "paw.memory-raw-evidence-archive-event.v1";
  readonly type: "put" | "resolve" | "search";
  readonly requestedCount: number;
  readonly returnedCount: number;
  readonly durationMs: number;
}

export function createPostgresMemoryRawEvidenceArchiveV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    onEvent?: (event: MemoryRawEvidenceArchiveEventV1) => void;
  }>,
): MemoryRawEvidenceArchiveV1 {
  const scope = Object.freeze({ ...input.scope });
  return Object.freeze({
    scope,
    async put(
      spans: readonly MemoryRawEvidenceArchiveInputV1[],
      signal: AbortSignal,
    ) {
      const started = Date.now();
      const sql = getSql();
      const unique = uniqueArchiveInputs(spans);
      for (const span of unique) {
        if (signal.aborted) throw abortError();
        assertArchiveInput(span);
        const scan = scanForSecrets(span.content.slice(0, 8_192));
        const content =
          scan.action === "reject"
            ? "[SECRET_BLOCKED]"
            : scan.action === "redact"
              ? scan.text
              : span.content.slice(0, 8_192);
        const contentHash = hashTextV1(content);
        const id = hashCanonicalJsonV1({
          schemaVersion: "paw.memory-raw-evidence-span-identity.v1",
          scope,
          evidenceRef: span.evidenceRef,
        });
        await sql`
          INSERT INTO memory_raw_evidence_spans (
            id, schema_version, scope, evidence_ref, source_kind,
            source_seq, content, content_hash, created_at
          ) VALUES (
            ${id}, 'paw.memory-raw-evidence-span.v1', ${sql.json(scope)},
            ${span.evidenceRef}, ${span.sourceKind}, ${span.sourceSeq},
            ${content}, ${contentHash}, ${span.createdAt}
          )
          ON CONFLICT (id) DO NOTHING
        `;
        const rows = await sql`
          SELECT content_hash
          FROM memory_raw_evidence_spans
          WHERE id = ${id}
            AND scope->>'tenantId' = ${scope.tenantId}
            AND scope->>'userId' = ${scope.userId}
            AND scope->>'workspaceId' = ${scope.workspaceId}
            AND scope->>'repositoryId' = ${scope.repositoryId}
          LIMIT 1
        `;
        if (rows[0]?.content_hash !== contentHash) {
          throw namedError("MemoryRawEvidenceImmutableConflict");
        }
      }
      emit(input.onEvent, {
        schemaVersion: "paw.memory-raw-evidence-archive-event.v1",
        type: "put",
        requestedCount: spans.length,
        returnedCount: unique.length,
        durationMs: Date.now() - started,
      });
    },
    async resolve(
      requests: readonly MemoryRawEvidenceRequestV1[],
      signal: AbortSignal,
    ) {
      const started = Date.now();
      const sql = getSql();
      const unique = uniqueRequests(requests).slice(0, 16);
      const spans: MemoryRawEvidenceSpanV1[] = [];
      for (const request of unique) {
        if (signal.aborted) throw abortError();
        assertRequest(request);
        const rows = await sql`
          SELECT content, content_hash
          FROM memory_raw_evidence_spans
          WHERE scope->>'tenantId' = ${scope.tenantId}
            AND scope->>'userId' = ${scope.userId}
            AND scope->>'workspaceId' = ${scope.workspaceId}
            AND scope->>'repositoryId' = ${scope.repositoryId}
            AND evidence_ref = ${request.evidenceRef}
          LIMIT 1
        `;
        const row = rows[0];
        if (!row || typeof row.content !== "string") continue;
        if (hashTextV1(row.content) !== row.content_hash) {
          throw namedError("MemoryRawEvidenceContentHashMismatch");
        }
        spans.push(
          Object.freeze({
            evidenceRef: request.evidenceRef,
            memoryIds: Object.freeze([...request.memoryIds]),
            content: row.content,
            contentHash: row.content_hash as string,
          }),
        );
      }
      emit(input.onEvent, {
        schemaVersion: "paw.memory-raw-evidence-archive-event.v1",
        type: "resolve",
        requestedCount: requests.length,
        returnedCount: spans.length,
        durationMs: Date.now() - started,
      });
      return Object.freeze(spans);
    },
    async search(query: MemoryConversationSearchV1, signal: AbortSignal) {
      const started = Date.now();
      const sql = getSql();
      const normalized = query.query.trim().replace(/\s+/g, " ");
      if (
        !normalized ||
        normalized.length > 512 ||
        !Number.isSafeInteger(query.maxSpans) ||
        query.maxSpans < 1 ||
        query.maxSpans > 16 ||
        !Number.isSafeInteger(query.maxChars) ||
        query.maxChars < 256 ||
        query.maxChars > 16_384
      ) {
        throw namedError("MemoryConversationSearchInvalid");
      }
      if (signal.aborted) throw abortError();
      const queryTerms = searchableTerms(normalized);
      const lexicalTerms = [...queryTerms]
        .sort(
          (left, right) =>
            right.length - left.length || left.localeCompare(right),
        )
        .slice(0, 8);
      // Combine a recent window with an old-evidence aperture. A pure recent
      // LIMIT silently loses long-lived facts; exact terms must be able to
      // bring an older dialogue back into the bounded candidate set.
      const recentRows = await sql`
        SELECT evidence_ref, source_kind, source_seq, content, content_hash,
               created_at
        FROM memory_raw_evidence_spans
        WHERE scope->>'tenantId' = ${scope.tenantId}
          AND scope->>'userId' = ${scope.userId}
          AND scope->>'workspaceId' = ${scope.workspaceId}
          AND scope->>'repositoryId' = ${scope.repositoryId}
        ORDER BY source_seq DESC, created_at DESC, id ASC
        LIMIT 512
      `;
      const lexicalRows =
        lexicalTerms.length === 0
          ? []
          : await sql`
              SELECT evidence_ref, source_kind, source_seq, content,
                     content_hash, created_at
              FROM memory_raw_evidence_spans
              WHERE scope->>'tenantId' = ${scope.tenantId}
                AND scope->>'userId' = ${scope.userId}
                AND scope->>'workspaceId' = ${scope.workspaceId}
                AND scope->>'repositoryId' = ${scope.repositoryId}
                AND EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements_text(${sql.json(lexicalTerms)}) AS term(value)
                  WHERE position(term.value IN lower(content)) > 0
                )
              ORDER BY source_seq DESC, created_at DESC, id ASC
              LIMIT 512
            `;
      const rows = [
        ...new Map(
          [...recentRows, ...lexicalRows].map((row) => [
            String(row.evidence_ref),
            row,
          ]),
        ).values(),
      ];
      const candidates = rows.flatMap((row) => {
        if (
          typeof row.evidence_ref !== "string" ||
          typeof row.content !== "string" ||
          typeof row.content_hash !== "string" ||
          hashTextV1(row.content) !== row.content_hash
        ) {
          return [];
        }
        return [
          {
            row,
            terms: searchableTerms(row.content),
            normalized: searchableText(row.content),
          },
        ];
      });
      const documentFrequency = termDocumentFrequency(
        queryTerms,
        candidates.map((candidate) => candidate.terms),
      );
      const ranked = candidates
        .flatMap((row) => {
          const score = conversationRelevanceScore({
            query: searchableText(normalized),
            queryTerms,
            candidate: row.normalized,
            candidateTerms: row.terms,
            documentFrequency,
            documentCount: candidates.length,
          });
          if (score <= 0) return [];
          return [{ row: row.row, score }];
        })
        .sort(
          (left, right) =>
            right.score - left.score ||
            Number(right.row.source_seq) - Number(left.row.source_seq) ||
            String(left.row.evidence_ref).localeCompare(
              String(right.row.evidence_ref),
            ),
        );
      const result: MemoryConversationEvidenceV1[] = [];
      let usedChars = 0;
      for (const { row } of ranked) {
        if (result.length >= query.maxSpans) break;
        const remaining = query.maxChars - usedChars;
        if (remaining < 256) break;
        const bundle = conversationSearchExcerpt(
          rows as readonly Record<string, unknown>[],
          row as Record<string, unknown>,
          queryTerms,
          Math.min(2_400, remaining),
          normalized,
        );
        const hitContent = focusedSearchExcerpt(
          String(row.content),
          queryTerms,
          Math.min(2_400, remaining),
        );
        result.push(
          Object.freeze({
            evidenceRef: String(row.evidence_ref),
            sourceKind: sourceKind(row.source_kind),
            sourceSeq: Number(row.source_seq),
            authority: bundle.authority,
            content: bundle.text,
            contentHash: hashTextV1(bundle.text),
            hitContent,
            hitContentHash: hashTextV1(hitContent),
            createdAt: toIso(row.created_at),
          }),
        );
        usedChars += bundle.text.length;
      }
      emit(input.onEvent, {
        schemaVersion: "paw.memory-raw-evidence-archive-event.v1",
        type: "search",
        requestedCount: query.maxSpans,
        returnedCount: result.length,
        durationMs: Date.now() - started,
      });
      return Object.freeze(result);
    },
  });
}

function focusedSearchExcerpt(
  content: string,
  queryTerms: ReadonlySet<string>,
  maxChars: number,
): string {
  if (content.length <= maxChars) return content;
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  const starts = new Set([0]);
  for (const term of queryTerms) {
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(term, offset);
      if (index < 0) break;
      starts.add(Math.max(0, Math.min(content.length - maxChars, index - 320)));
      offset = index + Math.max(1, term.length);
    }
  }
  let bestStart = 0;
  let bestScore = -1;
  for (const start of starts) {
    const window = normalized.slice(start, start + maxChars);
    let score = 0;
    for (const term of queryTerms) {
      if (window.includes(term)) score += Math.max(1, term.length ** 2);
    }
    if (score > bestScore || (score === bestScore && start < bestStart)) {
      bestStart = start;
      bestScore = score;
    }
  }
  const prefix = bestStart > 0 ? "[…]\n" : "";
  const available = Math.max(1, maxChars - prefix.length);
  return `${prefix}${content.slice(bestStart, bestStart + available)}`;
}

function conversationSearchExcerpt(
  rows: readonly Record<string, unknown>[],
  hit: Record<string, unknown>,
  queryTerms: ReadonlySet<string>,
  maxChars: number,
  query: string,
): ReturnType<typeof buildMemoryConversationTurnBundleV1> {
  const hitRef = String(hit.evidence_ref ?? "");
  const hitSeq = Number(hit.source_seq);
  const family = evidenceRefFamily(hitRef);
  const neighbors = rows
    .filter((row) => {
      const seq = Number(row.source_seq);
      return (
        evidenceRefFamily(String(row.evidence_ref ?? "")) === family &&
        Number.isSafeInteger(seq) &&
        Math.abs(seq - hitSeq) <= 1
      );
    })
    .sort(
      (left, right) =>
        Number(left.source_seq) - Number(right.source_seq) ||
        String(left.evidence_ref).localeCompare(String(right.evidence_ref)),
    );
  if (neighbors.length <= 1) {
    const text = focusedSearchExcerpt(
      String(hit.content ?? ""),
      queryTerms,
      maxChars,
    );
    return Object.freeze({
      policyVersion: PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1,
      text,
      hitSeq,
      authority:
        hit.source_kind === "user_input" ? "user_asserted" : "context_only",
      includedTurns: 1,
      chars: text.length,
    });
  }
  return buildMemoryConversationTurnBundleV1({
    turns: neighbors.map((row) => ({
      sourceSeq: Number(row.source_seq),
      sourceKind: sourceKind(row.source_kind),
      content: String(row.content ?? ""),
      hit: String(row.evidence_ref) === hitRef,
    })),
    query,
    maxChars,
  });
}

function evidenceRefFamily(ref: string): string {
  const fragment = ref.lastIndexOf("#");
  return fragment < 0 ? ref : ref.slice(0, fragment);
}

function searchableTerms(value: string): ReadonlySet<string> {
  const normalized = searchableText(value);
  const result = new Set(
    (normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(
      (term) => !ENGLISH_SEARCH_STOP_WORDS.has(term),
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

function searchableText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ");
}

function termDocumentFrequency(
  queryTerms: ReadonlySet<string>,
  documents: readonly ReadonlySet<string>[],
): ReadonlyMap<string, number> {
  const frequencies = new Map<string, number>();
  for (const term of queryTerms) {
    frequencies.set(
      term,
      documents.reduce(
        (count, document) => count + Number(document.has(term)),
        0,
      ),
    );
  }
  return frequencies;
}

function conversationRelevanceScore(
  input: Readonly<{
    query: string;
    queryTerms: ReadonlySet<string>;
    candidate: string;
    candidateTerms: ReadonlySet<string>;
    documentFrequency: ReadonlyMap<string, number>;
    documentCount: number;
  }>,
): number {
  let score = 0;
  const matched: string[] = [];
  for (const term of input.queryTerms) {
    if (!input.candidateTerms.has(term)) continue;
    matched.push(term);
    const frequency = input.documentFrequency.get(term) ?? input.documentCount;
    const inverseFrequency = Math.log(
      1 + (input.documentCount + 1) / (frequency + 1),
    );
    score += inverseFrequency * (1 + Math.min(12, term.length) / 12);
  }
  // Exact multi-word discriminants such as "author signing" outweigh a
  // paragraph that merely repeats persona names and generic event language.
  const ordered = [...input.queryTerms].filter((term) =>
    input.query.includes(term),
  );
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const phrase = `${ordered[index]} ${ordered[index + 1]}`;
    if (input.candidate.includes(phrase)) score += 6;
  }
  if (matched.length >= 2) score += matched.length ** 2 * 0.15;
  return score;
}

const ENGLISH_SEARCH_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "before",
  "been",
  "being",
  "did",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "into",
  "its",
  "that",
  "the",
  "their",
  "them",
  "this",
  "user",
  "was",
  "were",
  "with",
]);

function sourceKind(value: unknown): MemoryRawEvidenceSourceKindV1 {
  if (
    value === "user_input" ||
    value === "assistant_output" ||
    value === "tool_observation" ||
    value === "verification" ||
    value === "outcome" ||
    value === "source_document"
  ) {
    return value;
  }
  throw namedError("MemoryConversationSourceKindInvalid");
}

function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw namedError("MemoryConversationCreatedAtInvalid");
  }
  return date.toISOString();
}

function uniqueArchiveInputs(
  spans: readonly MemoryRawEvidenceArchiveInputV1[],
): readonly MemoryRawEvidenceArchiveInputV1[] {
  const byRef = new Map<string, MemoryRawEvidenceArchiveInputV1>();
  for (const span of spans) {
    const prior = byRef.get(span.evidenceRef);
    if (prior && prior.content !== span.content) {
      throw namedError("MemoryRawEvidenceDuplicateRefConflict");
    }
    byRef.set(span.evidenceRef, span);
  }
  return Object.freeze(
    [...byRef.values()].sort((a, b) =>
      a.evidenceRef.localeCompare(b.evidenceRef),
    ),
  );
}

function uniqueRequests(
  requests: readonly MemoryRawEvidenceRequestV1[],
): readonly MemoryRawEvidenceRequestV1[] {
  const byRef = new Map<string, Set<string>>();
  for (const request of requests) {
    const ids = byRef.get(request.evidenceRef) ?? new Set<string>();
    for (const id of request.memoryIds) ids.add(id);
    byRef.set(request.evidenceRef, ids);
  }
  return Object.freeze(
    [...byRef.entries()].map(([evidenceRef, ids]) =>
      Object.freeze({ evidenceRef, memoryIds: Object.freeze([...ids].sort()) }),
    ),
  );
}

function assertArchiveInput(span: MemoryRawEvidenceArchiveInputV1): void {
  if (
    !span.evidenceRef.trim() ||
    span.evidenceRef.length > 1_024 ||
    !span.content.trim() ||
    !Number.isSafeInteger(span.sourceSeq) ||
    span.sourceSeq < 0 ||
    Number.isNaN(Date.parse(span.createdAt))
  ) {
    throw namedError("MemoryRawEvidenceArchiveInputInvalid");
  }
}

function assertRequest(request: MemoryRawEvidenceRequestV1): void {
  if (
    !request.evidenceRef.trim() ||
    request.evidenceRef.length > 1_024 ||
    request.memoryIds.length === 0 ||
    request.memoryIds.length > 32
  ) {
    throw namedError("MemoryRawEvidenceRequestInvalid");
  }
}

function emit(
  observer: ((event: MemoryRawEvidenceArchiveEventV1) => void) | undefined,
  event: MemoryRawEvidenceArchiveEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Content-free observability cannot affect archive semantics.
  }
}

function abortError(): Error {
  const error = new Error("Memory raw evidence operation aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
