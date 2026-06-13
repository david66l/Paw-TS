/**
 * Memory retriever — lightweight keyword + path relevance scoring.
 *
 * Zero embedding, zero external dependencies.
 * Scoring dimensions: keyword match, path match, error match, recency, source.
 */

import { MEMORY_INJECTION_DETAIL_TOKENS } from "./context-budget.js";
import {
  isArchitectureQuery,
  isMemoryMetaQuery,
  isReferenceMemory,
  type MemoryRecord,
} from "./memory-record.js";
import { ApproximateEstimator } from "./token-estimator.js";
import type { UnifiedMemoryStore } from "./unified-memory-store.js";

const _tokenEstimator = new ApproximateEstimator();

export interface RetrievalConfig {
  readonly maxSessionInTopK?: number;
  readonly maxSessionTokens?: number;
  readonly sessionRecencyHalfLifeDays?: number;
}

export const DEFAULT_RETRIEVAL_CONFIG: Required<RetrievalConfig> = {
  maxSessionInTopK: 2,
  maxSessionTokens: 800,
  sessionRecencyHalfLifeDays: 7,
};

export interface RetrievalQuery {
  readonly goal: string;
  readonly currentFile?: string;
  readonly recentFiles?: readonly string[];
  readonly recentToolNames?: readonly string[];
  readonly errorMessage?: string;
  readonly workspaceRoot: string;
  readonly limit?: number;
  readonly maxTokens?: number;
  readonly minScore?: number;
  readonly config?: RetrievalConfig;
}

export interface MemoryRetrievalResult {
  readonly records: readonly MemoryRecord[];
  readonly totalCandidates: number;
  readonly scores: readonly number[];
  readonly injectedTokens: number;
  /** True when meta-intent fallback selected memories. */
  readonly usedMetaFallback?: boolean;
  readonly retrievalMode?: "keyword" | "cascade";
  readonly embeddingCacheHits?: number;
  readonly embeddingCacheMisses?: number;
  /** True when cascade mode escalated to LLM manifest selection. */
  readonly usedLlmFallback?: boolean;
}

export interface MemoryRetriever {
  retrieve(query: RetrievalQuery): MemoryRetrievalResult;
}

export class KeywordMemoryRetriever implements MemoryRetriever {
  private readonly store: UnifiedMemoryStore;
  private readonly config: Required<RetrievalConfig>;

  constructor(
    store: UnifiedMemoryStore,
    config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
  ) {
    this.store = store;
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  }

  retrieve(query: RetrievalQuery): MemoryRetrievalResult {
    const sorted = this.rankRecords(query);
    return this.buildResult(sorted, query);
  }

  /** Score every memory and return candidates above minScore, sorted descending. */
  rankRecords(
    query: RetrievalQuery,
  ): readonly { record: MemoryRecord; score: number }[] {
    const all = this.store.listExcludingCurrent();
    const scored = all.map((m) => ({
      record: m,
      score: this.score(m, query),
    }));
    const minScore = query.minScore ?? 15;
    return scored
      .filter((s) => s.score > minScore)
      .sort((a, b) => b.score - a.score);
  }

  /** Score every memory without minScore filtering. */
  scoreAllRecords(
    query: RetrievalQuery,
  ): readonly { record: MemoryRecord; score: number }[] {
    const all = this.store.listExcludingCurrent();
    return all.map((m) => ({
      record: m,
      score: this.score(m, query),
    }));
  }

  buildResult(
    sorted: readonly { record: MemoryRecord; score: number }[],
    query: RetrievalQuery,
    options?: { totalCandidates?: number },
  ): MemoryRetrievalResult {
    const cfg = { ...this.config, ...query.config };
    const limit = query.limit ?? 5;
    const maxTokens = query.maxTokens ?? 1500;
    const all = this.store.listExcludingCurrent();

    let selected = this.selectRecords(sorted, limit, maxTokens, cfg);
    let totalCandidates = options?.totalCandidates ?? sorted.length;
    let usedMetaFallback = false;

    if (selected.records.length === 0 && isMemoryMetaQuery(query.goal)) {
      const fallback = this.selectMetaFallback(all, limit, maxTokens, cfg);
      selected = fallback;
      totalCandidates = fallback.candidateCount;
      usedMetaFallback = true;
    }

    return {
      records: selected.records,
      totalCandidates,
      scores: selected.scores,
      injectedTokens: selected.injectedTokens,
      ...(usedMetaFallback ? { usedMetaFallback: true } : {}),
    };
  }

  private selectMetaFallback(
    all: readonly MemoryRecord[],
    limit: number,
    maxTokens: number,
    cfg: Required<RetrievalConfig>,
  ): {
    records: MemoryRecord[];
    scores: number[];
    injectedTokens: number;
    candidateCount: number;
  } {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const seen = new Set<string>();
    const pool: MemoryRecord[] = [];

    const references = [...all]
      .filter(isReferenceMemory)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const record of references) {
      if (seen.has(record.id)) continue;
      pool.push(record);
      seen.add(record.id);
    }

    for (const record of [...all].sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (
        record.source === "auto" &&
        record.updatedAt >= sevenDaysAgo &&
        !seen.has(record.id)
      ) {
        pool.push(record);
        seen.add(record.id);
      }
    }

    const selected = this.selectRecords(
      pool.map((record) => ({ record, score: 1 })),
      limit,
      maxTokens,
      cfg,
    );
    return { ...selected, candidateCount: pool.length };
  }

  private selectRecords(
    sorted: readonly { record: MemoryRecord; score: number }[],
    limit: number,
    maxTokens: number,
    cfg: Required<RetrievalConfig>,
  ): {
    records: MemoryRecord[];
    scores: number[];
    injectedTokens: number;
  } {
    const records: MemoryRecord[] = [];
    const scores: number[] = [];
    let totalTokens = 0;
    let sessionCount = 0;
    let sessionTokens = 0;

    for (const s of sorted) {
      if (records.length >= limit) break;

      const isSession = s.record.source === "session";
      const rankInSelection = records.length;
      const recordTokens = this.estimateRecordTokens(
        s.record,
        rankInSelection === 0,
      );

      if (isSession) {
        if (sessionCount >= cfg.maxSessionInTopK) continue;
        if (sessionTokens + recordTokens > cfg.maxSessionTokens) continue;
      }

      if (totalTokens + recordTokens > maxTokens && records.length > 0) break;

      records.push(s.record);
      scores.push(s.score);
      totalTokens += recordTokens;
      if (isSession) {
        sessionCount++;
        sessionTokens += recordTokens;
      }
    }

    return { records, scores, injectedTokens: totalTokens };
  }

  private score(m: MemoryRecord, query: RetrievalQuery): number {
    let score = 0;

    // 1. Keyword match — title/summary worth more than body content.
    const queryWords = this.tokenize(this.stripPathLikeText(query.goal));

    const headText = this.stripPathLikeText(
      [m.title, m.summary, ...m.tags].join(" "),
    );
    const headWords = this.tokenize(headText);
    const headMatches = queryWords.filter((w) => headWords.includes(w)).length;

    const bodyText = this.stripPathLikeText(m.content);
    const bodyWords = this.tokenize(bodyText);
    const bodyMatches = queryWords.filter((w) => bodyWords.includes(w)).length;

    score += headMatches * 15 + bodyMatches * 5;
    const keywordMatches = headMatches + bodyMatches;
    const hasTextSignal = keywordMatches >= 2;

    // 2. Path match (current file + recent files vs memory related files)
    const queryFiles = [query.currentFile, ...(query.recentFiles ?? [])].filter(
      (f): f is string => !!f,
    );
    for (const qf of queryFiles) {
      for (const relFile of m.relatedFiles) {
        score += this.pathMatchScore(qf, relFile, hasTextSignal);
      }
    }

    // 3. Error signature match
    if (query.errorMessage && m.relatedErrors.length > 0) {
      const errWords = this.tokenize(query.errorMessage);
      for (const sig of m.relatedErrors) {
        if (errWords.some((w) => sig.toLowerCase().includes(w))) {
          score += 40;
        }
      }
    }

    // 4. Recent tool names — match tags or memory text
    if (query.recentToolNames && query.recentToolNames.length > 0) {
      const haystack = [m.title, m.summary, m.content, ...m.tags]
        .join(" ")
        .toLowerCase();
      for (const toolName of query.recentToolNames) {
        if (m.tags.includes(toolName)) score += 5;
        const short = toolName.split(".").pop() ?? toolName;
        if (haystack.includes(toolName) || haystack.includes(short)) {
          score += 8;
        }
      }
    }

    // 5. Penalize memories that claim file relevance but share almost no
    //    path prefix with the query (e.g. packages/core vs packages/workspace).
    if (
      keywordMatches > 0 &&
      queryFiles.length > 0 &&
      m.relatedFiles.length > 0
    ) {
      let maxCommonDepth = 0;
      for (const qf of queryFiles) {
        for (const relFile of m.relatedFiles) {
          const curParts = qf.replace(/\\/g, "/").split("/");
          const relParts = relFile.replace(/\\/g, "/").split("/");
          let commonDepth = 0;
          for (let i = 0; i < Math.min(curParts.length, relParts.length); i++) {
            if (curParts[i] === relParts[i]) commonDepth++;
            else break;
          }
          if (commonDepth > maxCommonDepth) maxCommonDepth = commonDepth;
        }
      }
      if (maxCommonDepth < 2) {
        score -= 6;
      }
    }

    // 6. Recency decay — session memories decay faster (7d half-life)
    const ageDays = (Date.now() - m.updatedAt) / (1000 * 60 * 60 * 24);
    const halfLife =
      m.source === "session"
        ? (query.config?.sessionRecencyHalfLifeDays ??
          this.config.sessionRecencyHalfLifeDays)
        : 30;
    const recencyBoost = Math.max(0, 1 - ageDays / halfLife);
    score *= 1 + recencyBoost;

    // 7. Source weight
    if (m.source === "session") score *= 1.2;

    // 8. Session task keyword boost
    if (m.source === "session" && m.title.trim()) {
      const taskWords = this.tokenize(m.title);
      const taskMatches = queryWords.filter((w) => taskWords.includes(w)).length;
      if (taskMatches >= 2) score += 25;
    }

    // 9. Reference memory boost
    if (isReferenceMemory(m)) score *= 1.2;

    // 10. Architecture query + reference boost
    if (isArchitectureQuery(query.goal) && isReferenceMemory(m)) {
      score += 30;
    }

    return score;
  }

  private pathMatchScore(
    current: string,
    related: string,
    allowBroadPathMatch: boolean,
  ): number {
    const cur = current.replace(/\\/g, "/");
    const rel = related.replace(/\\/g, "/");

    if (cur === rel) return 40;

    const curFile = cur.slice(cur.lastIndexOf("/") + 1);
    const relFile = rel.slice(rel.lastIndexOf("/") + 1);
    if (curFile === relFile) return 20;

    if (!allowBroadPathMatch) return 0;

    const curDir = cur.slice(0, cur.lastIndexOf("/"));
    const relDir = rel.slice(0, rel.lastIndexOf("/"));
    if (curDir && curDir === relDir) return 30;

    const curParts = cur.split("/");
    const relParts = rel.split("/");
    let commonDepth = 0;
    for (let i = 0; i < Math.min(curParts.length, relParts.length); i++) {
      if (curParts[i] === relParts[i]) commonDepth++;
      else break;
    }
    if (commonDepth >= 2) return 15;

    return 0;
  }

  private tokenize(text: string): string[] {
    const normalized = text
      .toLowerCase()
      .replace(/[^\w\s\u4e00-\u9fff]/g, " ")
      .trim();
    if (!normalized) return [];

    const tokens = new Set<string>();
    for (const chunk of normalized.split(/\s+/)) {
      if (!chunk) continue;
      if (/^[\u4e00-\u9fff]+$/.test(chunk)) {
        if (chunk.length >= 2) tokens.add(chunk);
        for (let i = 0; i < chunk.length - 1; i++) {
          tokens.add(chunk.slice(i, i + 2));
        }
        continue;
      }
      if (chunk.length > 2) tokens.add(chunk);
    }
    return [...tokens];
  }

  private stripPathLikeText(text: string): string {
    return text.replace(
      /(?:^|\s)(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+(?:\.[A-Za-z0-9]+)?(?=\s|$|[),.;:])/g,
      (match) => {
        const trimmed = match.trim();
        const basename = trimmed.slice(trimmed.lastIndexOf("/") + 1);
        const stem = basename.replace(/\.[A-Za-z0-9]+$/, "");
        return ` ${stem.replace(/[-_.]+/g, " ")} `;
      },
    );
  }

  private estimateRecordTokens(
    m: MemoryRecord,
    includeTopDetail: boolean,
  ): number {
    const text = [m.title, m.summary, ...m.relatedFiles].join(" ");
    let tokens = _tokenEstimator.count(text);
    if (includeTopDetail && m.content.trim()) {
      tokens += MEMORY_INJECTION_DETAIL_TOKENS;
    }
    return tokens;
  }
}
