import { createHash } from "node:crypto";

export const AMB_DIALOGUE_PAIR_SCHEMA_VERSION_V1 = "dialogue-pair-v1";
export const AMB_DIALOGUE_PAIR_PROMPT_ISSUE_TYPE_V1 =
  "AmbDialoguePairPromptV1";
export const AMB_DIALOGUE_PAIR_RESPONSE_ISSUE_TYPE_V1 =
  "AmbDialoguePairResponseV1";

export type AmbDialoguePairFaceV1 = "prompt" | "response";

export interface AmbDialoguePairTurnV1 {
  readonly seq: number;
  readonly kind: "user_input" | "assistant_output" | "verification";
  readonly content: string;
}

export interface AmbCompiledDialoguePairFacetV1 {
  readonly id: string;
  readonly pairId: string;
  readonly face: AmbDialoguePairFaceV1;
  readonly issueType:
    | typeof AMB_DIALOGUE_PAIR_PROMPT_ISSUE_TYPE_V1
    | typeof AMB_DIALOGUE_PAIR_RESPONSE_ISSUE_TYPE_V1;
  readonly documentId: string;
  readonly userSeq: number;
  readonly assistantSeq: number;
  readonly userEvidenceRef: string;
  readonly assistantEvidenceRef: string;
  readonly content: string;
}

export interface AmbDialoguePairCandidateV1 {
  readonly pairId: string;
  readonly documentId: string;
  readonly userSeq: number;
  readonly assistantSeq: number;
  readonly userEvidenceRef: string;
  readonly assistantEvidenceRef: string;
}

export interface AmbDialoguePairRankingV1 {
  readonly lane:
    | "requirement_prompt"
    | "requirement_response"
    | "original_query_prompt"
    | "original_query_response";
  readonly pairs: readonly AmbDialoguePairCandidateV1[];
}

export interface AmbDialoguePairSearchLaneV1 {
  readonly lane: "requirement" | "original_query";
  readonly face: AmbDialoguePairFaceV1;
  readonly sourceKind: "user_input" | "assistant_output";
  readonly text: string;
}

const RRF_K = 60;

/** Build independent DB-filtered prompt/response lanes before SQL LIMIT. */
export function buildAmbDialoguePairSearchPlanV1(input: {
  readonly requirementText: string;
  readonly originalQuery: string;
}): readonly AmbDialoguePairSearchLaneV1[] {
  const texts = [
    { lane: "requirement" as const, text: input.requirementText },
    { lane: "original_query" as const, text: input.originalQuery },
  ]
    .map((item) => ({ ...item, text: item.text.replace(/\s+/gu, " ").trim() }))
    .filter(
      (item, index, items) =>
        item.text.length > 0 &&
        items.findIndex((candidate) => candidate.text === item.text) === index,
    );
  return Object.freeze(
    texts.flatMap(({ lane, text }) =>
      (["prompt", "response"] as const).map((face) =>
        Object.freeze({
          lane,
          face,
          sourceKind:
            face === "prompt"
              ? ("user_input" as const)
              : ("assistant_output" as const),
          text,
        }),
      ),
    ),
  );
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function ambDialoguePairIdentityV1(input: {
  readonly runKey: string;
  readonly userId: string;
  readonly documentId: string;
  readonly user: Pick<AmbDialoguePairTurnV1, "seq" | "content">;
  readonly assistant: Pick<AmbDialoguePairTurnV1, "seq" | "content">;
}): string {
  return sha(
    [
      AMB_DIALOGUE_PAIR_SCHEMA_VERSION_V1,
      input.runKey,
      input.userId,
      input.documentId,
      input.user.seq,
      input.assistant.seq,
      sha(input.user.content),
      sha(input.assistant.content),
    ].join("\n"),
  );
}

export function ambDialoguePairFacetIdV1(
  pairId: string,
  face: AmbDialoguePairFaceV1,
): string {
  return `episodic-dialogue-pair-${sha(
    `${AMB_DIALOGUE_PAIR_SCHEMA_VERSION_V1}\n${pairId}\n${face}`,
  ).slice(0, 24)}`;
}

/**
 * Compile only immutable, exactly adjacent user -> assistant turns. The
 * sidecar describes provenance, never semantic support or answer authority.
 */
export function compileAmbDialoguePairFacetsV1(input: {
  readonly runKey: string;
  readonly userId: string;
  readonly documentId: string;
  readonly turns: readonly AmbDialoguePairTurnV1[];
}): readonly AmbCompiledDialoguePairFacetV1[] {
  const facets: AmbCompiledDialoguePairFacetV1[] = [];
  const bySeq = new Map<number, AmbDialoguePairTurnV1>();
  for (const turn of input.turns) {
    const current = bySeq.get(turn.seq);
    if (
      current &&
      (current.kind !== turn.kind || current.content !== turn.content)
    ) {
      return Object.freeze([]);
    }
    if (!current) bySeq.set(turn.seq, turn);
  }
  const ordered = [...bySeq.values()].sort(
    (left, right) => left.seq - right.seq,
  );
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const user = ordered[index];
    const assistant = ordered[index + 1];
    if (
      !user ||
      !assistant ||
      user.kind !== "user_input" ||
      assistant.kind !== "assistant_output" ||
      assistant.seq !== user.seq + 1 ||
      !user.content.trim() ||
      !assistant.content.trim()
    ) {
      continue;
    }
    const pairId = ambDialoguePairIdentityV1({
      runKey: input.runKey,
      userId: input.userId,
      documentId: input.documentId,
      user,
      assistant,
    });
    const common = {
      pairId,
      documentId: input.documentId,
      userSeq: user.seq,
      assistantSeq: assistant.seq,
      userEvidenceRef: `amb:document/${input.documentId}#source-${user.seq}`,
      assistantEvidenceRef: `amb:document/${input.documentId}#source-${assistant.seq}`,
    } as const;
    facets.push(
      Object.freeze({
        ...common,
        id: ambDialoguePairFacetIdV1(pairId, "prompt"),
        face: "prompt" as const,
        issueType: AMB_DIALOGUE_PAIR_PROMPT_ISSUE_TYPE_V1,
        content: user.content,
      }),
      Object.freeze({
        ...common,
        id: ambDialoguePairFacetIdV1(pairId, "response"),
        face: "response" as const,
        issueType: AMB_DIALOGUE_PAIR_RESPONSE_ISSUE_TYPE_V1,
        content: assistant.content,
      }),
    );
  }
  return Object.freeze(facets);
}

/** Pair-level RRF followed by deterministic round-robin source allocation. */
export function selectAmbSourceFairDialoguePairsV1(input: {
  readonly sourcePriority: readonly string[];
  readonly rankingsBySource: ReadonlyMap<
    string,
    readonly AmbDialoguePairRankingV1[]
  >;
  readonly maxPairs: number;
  readonly maxPairsPerSource: 1 | 2;
}): readonly AmbDialoguePairCandidateV1[] {
  const rankedBySource = new Map<string, AmbDialoguePairCandidateV1[]>();
  for (const sourceId of input.sourcePriority) {
    const aggregated = new Map<
      string,
      { pair: AmbDialoguePairCandidateV1; ranks: number[] }
    >();
    for (const ranking of input.rankingsBySource.get(sourceId) ?? []) {
      const seenInLane = new Set<string>();
      ranking.pairs.forEach((pair, index) => {
        if (
          pair.documentId !== sourceId ||
          seenInLane.has(pair.pairId) ||
          !isWellFormedPair(pair)
        ) {
          return;
        }
        seenInLane.add(pair.pairId);
        const current = aggregated.get(pair.pairId);
        if (current) current.ranks.push(index + 1);
        else aggregated.set(pair.pairId, { pair, ranks: [index + 1] });
      });
    }
    rankedBySource.set(
      sourceId,
      [...aggregated.values()]
        .sort(
          (left, right) =>
            fused(right.ranks) - fused(left.ranks) ||
            strongest(right.ranks) - strongest(left.ranks) ||
            Math.min(...left.ranks) - Math.min(...right.ranks) ||
            left.pair.pairId.localeCompare(right.pair.pairId),
        )
        .map((candidate) => candidate.pair),
    );
  }

  const selected: AmbDialoguePairCandidateV1[] = [];
  const seen = new Set<string>();
  for (
    let depth = 0;
    depth < input.maxPairsPerSource && selected.length < input.maxPairs;
    depth += 1
  ) {
    let added = false;
    for (const sourceId of input.sourcePriority) {
      const pair = rankedBySource.get(sourceId)?.[depth];
      if (!pair || seen.has(pair.pairId)) continue;
      seen.add(pair.pairId);
      selected.push(pair);
      added = true;
      if (selected.length >= input.maxPairs) break;
    }
    if (!added) break;
  }
  return Object.freeze(selected);
}

function isWellFormedPair(pair: AmbDialoguePairCandidateV1): boolean {
  return (
    pair.pairId.length > 0 &&
    Number.isSafeInteger(pair.userSeq) &&
    pair.userSeq > 0 &&
    pair.assistantSeq === pair.userSeq + 1 &&
    pair.userEvidenceRef ===
      `amb:document/${pair.documentId}#source-${pair.userSeq}` &&
    pair.assistantEvidenceRef ===
      `amb:document/${pair.documentId}#source-${pair.assistantSeq}`
  );
}

function strongest(ranks: readonly number[]): number {
  return Math.max(...ranks.map((rank) => 1 / (RRF_K + rank)));
}

function fused(ranks: readonly number[]): number {
  return ranks.reduce((total, rank) => total + 1 / (RRF_K + rank), 0);
}
