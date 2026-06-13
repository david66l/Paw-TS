import type { MemoryRecord } from "./memory-record.js";
import type { MemoryRetrievalResult, RetrievalQuery } from "./memory-retriever.js";

export const DEFAULT_CASCADE_CONFIG: Required<CascadeFallbackConfig> = {
  lowConfidenceScore: 25,
  weakSeparationGap: 5,
  weakSeparationMaxTop: 40,
  maxManifestEntries: 200,
};

export interface CascadeFallbackConfig {
  /** Escalate when top keyword score is below this (default 25). */
  readonly lowConfidenceScore?: number;
  /** Escalate when top1 - top2 is below this and top is weak (default 5). */
  readonly weakSeparationGap?: number;
  /** Max top score treated as "weak" for separation check (default 40). */
  readonly weakSeparationMaxTop?: number;
  /** Cap manifest size sent to LLM selector (default 200). */
  readonly maxManifestEntries?: number;
}

export interface LlmMemorySelectInput {
  readonly query: RetrievalQuery;
  readonly manifest: string;
  readonly candidateIds: readonly string[];
}

export type LlmMemorySelectFn = (
  input: LlmMemorySelectInput,
) => Promise<readonly string[]>;

/** Score assigned to LLM-selected memories without a keyword hit. */
export const LLM_FALLBACK_SCORE = 50;

export function formatMemoryManifest(records: readonly MemoryRecord[]): string {
  return records
    .map((record) => {
      const tags =
        record.tags.length > 0 ? ` (tags: ${record.tags.join(", ")})` : "";
      const summary = record.summary.trim() || record.content.slice(0, 120);
      return `[${record.id}] [${record.source}] ${record.title} — ${summary}${tags}`;
    })
    .join("\n");
}

export function shouldEscalateToLlmFallback(
  keywordResult: MemoryRetrievalResult,
  ranked: readonly { record: MemoryRecord; score: number }[],
  poolSize: number,
  config?: CascadeFallbackConfig,
): boolean {
  const cfg = { ...DEFAULT_CASCADE_CONFIG, ...config };
  if (keywordResult.usedMetaFallback) return false;
  if (poolSize === 0) return false;

  if (keywordResult.records.length === 0) return true;

  const top = ranked[0]?.score ?? 0;
  const second = ranked[1]?.score ?? 0;

  if (top < cfg.lowConfidenceScore) return true;
  if (
    ranked.length >= 2 &&
    top < cfg.weakSeparationMaxTop &&
    top - second < cfg.weakSeparationGap
  ) {
    return true;
  }

  return false;
}
