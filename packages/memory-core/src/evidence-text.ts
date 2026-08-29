/** Deterministic text scoring and bounded excerpt projection. */
export function conversationTerms(value: string): ReadonlySet<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
  );
}

const MEMORY_EVIDENCE_SUPPORT_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "between",
  "current",
  "clue",
  "evidence",
  "from",
  "latest",
  "most",
  "recent",
  "record",
  "records",
  "that",
  "the",
  "their",
  "this",
  "trip",
  "user",
  "visit",
  "with",
]);

const MEMORY_EVIDENCE_MEASUREMENT_TERMS = new Set([
  "amount",
  "balance",
  "count",
  "cost",
  "date",
  "dates",
  "day",
  "days",
  "duration",
  "earned",
  "earnings",
  "number",
  "percent",
  "percentage",
  "price",
  "spent",
  "stars",
  "total",
  "value",
  "views",
]);

/**
 * Cheap post-retrieval support ordering. Retrieval rank proposes candidates;
 * this scorer prevents a later but unrelated turn from becoming a state
 * winner merely because it shares a source document with the true evidence.
 */
export function memoryEvidenceSupportScoreV1(
  requirement: string,
  content: string,
): number {
  const terms = [...conversationTerms(requirement)].filter(
    (term) => !MEMORY_EVIDENCE_SUPPORT_STOP_WORDS.has(term),
  );
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += Math.max(1, term.length);
  }
  if (
    terms.some((term) => MEMORY_EVIDENCE_MEASUREMENT_TERMS.has(term)) &&
    /(?:\p{Sc}\s*)?\d/u.test(normalized)
  ) {
    score += 24;
  }
  return score;
}

export function focusedConversationExcerpt(
  content: string,
  queryTerms: ReadonlySet<string>,
  maxChars: number,
  preferredAnchors: readonly string[] = [],
): string {
  if (content.length <= maxChars) return content;
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  const starts = new Set([0]);
  const anchorStarts = new Set<number>();
  for (const anchor of preferredAnchors) {
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(anchor, offset);
      if (index < 0) break;
      const start = Math.max(
        0,
        Math.min(
          content.length - maxChars,
          index - Math.min(160, Math.floor(maxChars / 3)),
        ),
      );
      starts.add(start);
      anchorStarts.add(start);
      offset = index + Math.max(1, anchor.length);
    }
  }
  for (const term of queryTerms) {
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(term, offset);
      if (index < 0) break;
      starts.add(Math.max(0, Math.min(content.length - maxChars, index - 160)));
      offset = index + Math.max(1, term.length);
    }
  }
  let bestStart = 0;
  let bestScore = -1;
  for (const start of starts) {
    const window = normalized.slice(start, start + maxChars);
    let score = anchorStarts.has(start) ? 10_000_000 : 0;
    for (const anchor of preferredAnchors) {
      if (window.includes(anchor)) score += 1_000_000 + anchor.length ** 2;
    }
    for (const term of queryTerms) {
      if (window.includes(term)) score += Math.max(1, term.length ** 2);
    }
    if (score > bestScore || (score === bestScore && start < bestStart)) {
      bestStart = start;
      bestScore = score;
    }
  }
  const prefix = bestStart > 0 ? "[…]\n" : "";
  return `${prefix}${content.slice(bestStart, bestStart + Math.max(1, maxChars - prefix.length))}`;
}

/**
 * Project a bounded, query-focused view of immutable evidence. Numeric ordinal
 * aliases bridge natural-language questions such as "27th item" to enumerated
 * source forms such as "27." without changing or inventing source content.
 */
export function projectMemoryEvidenceExcerptV1(
  content: string,
  query: string,
  maxChars: number,
): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 128 || maxChars > 16_384) {
    throw namedError("MemoryEvidenceExcerptBudgetInvalid");
  }
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
  const anchors = memoryEvidenceOrdinalAnchorsV1(normalizedQuery);
  return focusedConversationExcerpt(
    content,
    conversationTerms(normalizedQuery),
    maxChars,
    anchors,
  );
}

/** Return a deterministic score only when source text contains the requested ordinal. */
export function memoryEvidenceOrdinalAnchorScoreV1(
  content: string,
  query: string,
): number {
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  return memoryEvidenceOrdinalAnchorsV1(query).reduce(
    (score, anchor) => score + (normalized.includes(anchor) ? 1 : 0),
    0,
  );
}

function memoryEvidenceOrdinalAnchorsV1(query: string): readonly string[] {
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
  const anchors = new Set<string>();
  for (const match of normalizedQuery.matchAll(
    /\b(\d{1,4})(?:st|nd|rd|th)\b/gu,
  )) {
    const value = match[1];
    if (!value) continue;
    anchors.add(`${value}.`);
    anchors.add(`${value})`);
    anchors.add(`#${value}`);
  }
  return Object.freeze([...anchors]);
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
