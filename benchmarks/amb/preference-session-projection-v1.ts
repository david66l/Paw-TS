import { createHash } from "node:crypto";

export const RECOMMENDATION_USER_AUTHORITY_POLICY_V1 =
  "paw.recommend-user-authority-projection.v1";

export interface RecommendationUserAuthorityTurnV1 {
  readonly sourceId: string;
  readonly evidenceRef: string;
  readonly sessionOrder: number;
  readonly turnOrder: number;
  readonly observedAt: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface RecommendationUserAuthorityProjectionV1 {
  readonly status: "projected" | "fallback";
  readonly reason: string;
  readonly sourceIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly content: string | undefined;
  readonly rawChars: number;
  readonly renderedChars: number;
  readonly packetRevision: string | undefined;
}

export function projectRecommendationUserAuthorityV1(input: {
  readonly query: string;
  readonly queryCutoff: string;
  readonly sourceLock: readonly string[];
  readonly turns: readonly RecommendationUserAuthorityTurnV1[];
  readonly legacyChars: number;
}): RecommendationUserAuthorityProjectionV1 {
  const lock = unique(input.sourceLock);
  const cutoff = Date.parse(input.queryCutoff);
  if (
    lock.length === 0 ||
    lock.length > 8 ||
    lock.length !== input.sourceLock.length ||
    input.legacyChars < 0 ||
    !Number.isFinite(cutoff)
  )
    return fallback("invalid_input");
  const bySource = new Map<string, RecommendationUserAuthorityTurnV1[]>();
  for (const turn of input.turns) {
    const evidenceAddress = /^(.+)#source-(\d+)$/u.exec(turn.evidenceRef);
    const observedAt = Date.parse(turn.observedAt);
    if (
      !lock.includes(turn.sourceId) ||
      evidenceAddress?.[1] !== turn.sourceId ||
      Number(evidenceAddress[2]) !== turn.turnOrder ||
      !Number.isSafeInteger(turn.sessionOrder) ||
      turn.sessionOrder < 0 ||
      !Number.isSafeInteger(turn.turnOrder) ||
      turn.turnOrder < 1 ||
      !turn.content.trim() ||
      hash(turn.content) !== turn.contentHash ||
      !Number.isFinite(observedAt) ||
      observedAt > cutoff
    ) {
      return fallback("invalid_turn");
    }
    const values = bySource.get(turn.sourceId) ?? [];
    values.push(turn);
    bySource.set(turn.sourceId, values);
  }
  if (bySource.size !== lock.length) return fallback("missing_locked_session");
  for (const sourceId of lock) {
    const turns = bySource.get(sourceId);
    if (turns === undefined) return fallback("missing_locked_session");
    if (new Set(turns.map((turn) => turn.evidenceRef)).size !== turns.length) {
      return fallback("duplicate_evidence_ref");
    }
    if (
      new Set(turns.map((turn) => turn.turnOrder)).size !== turns.length ||
      new Set(turns.map((turn) => turn.sessionOrder)).size !== 1 ||
      new Set(turns.map((turn) => turn.observedAt)).size !== 1
    ) {
      return fallback("invalid_session_closure");
    }
    turns.sort(
      (left, right) =>
        left.turnOrder - right.turnOrder ||
        left.evidenceRef.localeCompare(right.evidenceRef),
    );
  }
  const baseline = lock.slice(0, 4);
  const ranked = rankSessionsBm25(input.query, lock, bySource).slice(0, 2);
  const selected = [
    ...baseline,
    ...ranked.filter((sourceId) => !baseline.includes(sourceId)),
  ];
  const rendered = render(selected, bySource);
  // Projection is atomic: any selected complete session that does not fit
  // rejects the entire replacement instead of silently dropping a session.
  if (rendered.length > input.legacyChars) return fallback("budget_exceeded");
  const selectedTurns = selected.flatMap(
    (sourceId) => bySource.get(sourceId) ?? [],
  );
  const rawChars = selectedTurns.reduce(
    (total, turn) => total + turn.content.length,
    0,
  );
  const packetRevision = hash(
    JSON.stringify({
      policy: RECOMMENDATION_USER_AUTHORITY_POLICY_V1,
      lock,
      selected,
      refs: selectedTurns.map((turn) => [turn.evidenceRef, turn.contentHash]),
      renderedHash: hash(rendered),
    }),
  );
  return Object.freeze({
    status: "projected",
    reason: "ok",
    sourceIds: Object.freeze(selected),
    evidenceRefs: Object.freeze(selectedTurns.map((turn) => turn.evidenceRef)),
    content: rendered,
    rawChars,
    renderedChars: rendered.length,
    packetRevision,
  });
}

function render(
  sourceIds: readonly string[],
  bySource: ReadonlyMap<string, readonly RecommendationUserAuthorityTurnV1[]>,
): string {
  return [
    "USER_AUTHORED_MEMORY",
    "Memory only constrains user facts. Use common knowledge for advice; do not refuse merely because a ready-made recommendation is absent. Use only the relevant domain, treat branch-out or avoid as negative constraints, preserve entity-attribute relations, and do not make one experience a permanent preference.",
    ...sourceIds.flatMap((sourceId, index) => [
      `[User memory source ${index + 1}]`,
      ...(bySource.get(sourceId) ?? []).map((turn) => turn.content),
    ]),
  ].join("\n");
}

function rankSessionsBm25(
  query: string,
  sourceIds: readonly string[],
  bySource: ReadonlyMap<string, readonly RecommendationUserAuthorityTurnV1[]>,
): string[] {
  const queryTerms = tokens(query);
  const queryFrequency = new Map(
    queryTerms.map((term) => [
      term,
      queryTerms.filter((value) => value === term).length,
    ]),
  );
  const documents = sourceIds.map((sourceId) =>
    tokens(
      (bySource.get(sourceId) ?? []).map((turn) => turn.content).join("\n"),
    ),
  );
  const averageLength =
    documents.reduce((total, document) => total + document.length, 0) /
    documents.length;
  const documentFrequency = new Map<string, number>();
  for (const document of documents)
    for (const term of new Set(document))
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  return sourceIds
    .map((sourceId, index) => ({
      sourceId,
      observedAt: bySource.get(sourceId)?.[0]?.observedAt ?? "",
      sessionOrder: bySource.get(sourceId)?.[0]?.sessionOrder ?? 0,
      score: [...queryFrequency].reduce((total, [term, queryCount]) => {
        const document = documents[index] ?? [];
        const count = document.filter((value) => value === term).length;
        if (count === 0) return total;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        return (
          total +
          (queryCount * idf * count * 2.2) /
            (count +
              1.2 *
                (0.25 + (0.75 * document.length) / Math.max(1, averageLength)))
        );
      }, 0),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.observedAt.localeCompare(right.observedAt) ||
        left.sessionOrder - right.sessionOrder ||
        left.sourceId.localeCompare(right.sourceId),
    )
    .map((item) => item.sourceId);
}

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
}
function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function fallback(reason: string): RecommendationUserAuthorityProjectionV1 {
  return Object.freeze({
    status: "fallback",
    reason,
    sourceIds: Object.freeze([]),
    evidenceRefs: Object.freeze([]),
    content: undefined,
    rawChars: 0,
    renderedChars: 0,
    packetRevision: undefined,
  });
}
