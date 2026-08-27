import type {
  LoopInputPort,
  LoopSafeBoundary,
  Session,
  SessionInputSnapshot,
} from "@paw/agent-loop";
import { materializeModelRequestMessagesV1 } from "@paw/core";
import {
  type DerivedDecisionV1,
  type InputFactV1,
  type JsonValue,
  MEMORY_RETRIEVAL_POLICY_VERSION_V1,
  type MemoryCardV1,
  type MemoryRetrievalSettledFactV1,
} from "@paw/protocol";
import type {
  ContextTokenEstimatorV1,
  JournalContextRuntimeV1,
} from "@paw/runtime";

import { hashCanonicalJsonV1 } from "./canonical.js";
import { createMemoryContextSectionV1 } from "./memory-section.js";
import {
  type PawNextMemoryPluginProfileV1,
  type PawNextMemoryScopeV1,
  freezePawNextMemoryPluginProfileV1,
  memoryScopeFingerprintV1,
} from "./profile.js";

export const PAW_MEMORY_SEARCH_PLAN_VERSION_V2 =
  "paw.memory-search-plan.v2:lexical-anchors" as const;

export interface MemoryProviderQueryV1 {
  readonly queryId: string;
  readonly trigger: "task_start" | "work_segment_start";
  readonly text: string;
  /** Deterministic query plan. Older/manual callers may omit it and use text. */
  readonly searchTexts?: readonly MemorySearchTextV1[];
  readonly inputId: string;
  readonly inputContentHash: string;
  readonly scope: PawNextMemoryScopeV1;
  readonly maxCards: number;
  readonly maxInjectedTokens: number;
}

export interface MemorySearchTextV1 {
  readonly kind:
    | "current_input"
    | "initial_goal"
    | "goal_and_input"
    | "lexical_anchor";
  readonly text: string;
  /** Relative RRF contribution; it is policy, not a model-produced score. */
  readonly weight: number;
}

export interface MemoryProviderResultV1 {
  readonly status: "completed" | "degraded";
  readonly cards: readonly MemoryCardV1[];
  readonly reasonCode?: string;
}

export interface MemoryProviderV1 {
  readonly providerVersion: string;
  retrieve(
    query: MemoryProviderQueryV1,
    signal: AbortSignal,
  ): Promise<MemoryProviderResultV1>;
}

export interface MemoryPluginDiagnosticV1 {
  readonly phase: "retrieve" | "commit";
  readonly queryId?: string;
  readonly code: string;
}

export interface MemoryRetrievalInputPortOptionsV1 {
  readonly baseInput: LoopInputPort;
  readonly session: Pick<
    Session<InputFactV1, DerivedDecisionV1>,
    "readInputSnapshot" | "commitInputFacts"
  >;
  readonly context: JournalContextRuntimeV1;
  readonly estimator: ContextTokenEstimatorV1;
  readonly profile: PawNextMemoryPluginProfileV1;
  readonly provider?: MemoryProviderV1;
  readonly signal: AbortSignal;
  readonly onDiagnostic?: (diagnostic: MemoryPluginDiagnosticV1) => void;
}

/** Safe-boundary middleware: retrieval I/O settles durably before Context reads it. */
export function createMemoryRetrievalInputPortV1(
  options: MemoryRetrievalInputPortOptionsV1,
): LoopInputPort {
  const base = captureInput(options.baseInput);
  const profile = freezePawNextMemoryPluginProfileV1(options.profile);
  const readSnapshot = options.session.readInputSnapshot.bind(options.session);
  const commitFacts = options.session.commitInputFacts.bind(options.session);
  const planContext = options.context.plan.bind(options.context);
  const buildContext = options.context.build.bind(options.context);
  const provider = options.provider;
  if (!options.signal || typeof options.signal.aborted !== "boolean") {
    throw new Error("Memory plugin signal is invalid");
  }
  if (
    (profile.mode === "read_only" || profile.mode === "read_write") &&
    (!provider || provider.providerVersion !== profile.providerVersion)
  ) {
    throw new Error("Memory plugin provider does not match the frozen profile");
  }

  return Object.freeze({
    async reportSafeBoundary(boundary: LoopSafeBoundary) {
      if (!options.signal.aborted) {
        try {
          const snapshot = await readSnapshot();
          const query = projectCurrentMemoryQueryV1(snapshot, profile);
          if (query && !hasReceipt(snapshot, query.queryId)) {
            const fact = await settleRetrieval({
              snapshot,
              query,
              profile,
              provider,
              context: planContext,
              buildContext,
              estimator: options.estimator,
              signal: options.signal,
            });
            if (fact && !options.signal.aborted) {
              await commitReceiptBestEffort({
                initialSnapshot: snapshot,
                fact,
                readSnapshot,
                commitFacts,
                onDiagnostic: options.onDiagnostic,
              });
            }
          }
        } catch (error) {
          options.onDiagnostic?.({
            phase: "retrieve",
            code: stableErrorCode(error),
          });
        }
      }
      await base.reportSafeBoundary(boundary);
    },
    consumePromotedInputIds: base.consumePromotedInputIds,
  });
}

export function projectCurrentMemoryQueryV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  inputProfile: PawNextMemoryPluginProfileV1,
): MemoryProviderQueryV1 | undefined {
  const profile = freezePawNextMemoryPluginProfileV1(inputProfile);
  const lastSegment = [...snapshot.entries]
    .reverse()
    .find((entry) => entry.fact.type === "work.segment_started");
  const trigger = lastSegment ? "work_segment_start" : "task_start";
  const targetInputId =
    lastSegment?.fact.type === "work.segment_started"
      ? lastSegment.fact.inputId
      : undefined;
  const promoted = [...snapshot.entries]
    .reverse()
    .find(
      (entry) =>
        entry.fact.type === "input.promoted" &&
        (targetInputId === undefined
          ? entry.fact.delivery === "initial"
          : entry.fact.inputId === targetInputId),
    );
  if (!promoted || promoted.fact.type !== "input.promoted") return undefined;
  const initial = snapshot.entries.find(
    (entry) =>
      entry.fact.type === "input.promoted" && entry.fact.delivery === "initial",
  );
  const searchTexts = createMemorySearchTextsV1(
    initial?.fact.type === "input.promoted" ? initial.fact.content : undefined,
    promoted.fact.content,
  );
  const identity = {
    schemaVersion: "paw.memory-query.v1",
    trigger,
    inputId: promoted.fact.inputId,
    inputContentHash: promoted.fact.contentHash,
    providerVersion: profile.providerVersion,
    policyVersion: MEMORY_RETRIEVAL_POLICY_VERSION_V1,
    scopeFingerprint: memoryScopeFingerprintV1(profile.scope),
    searchPlanHash: hashCanonicalJsonV1(searchTexts as unknown as JsonValue),
  } as const;
  return Object.freeze({
    queryId: hashCanonicalJsonV1(identity as unknown as JsonValue),
    trigger,
    text: promoted.fact.content,
    searchTexts,
    inputId: promoted.fact.inputId,
    inputContentHash: promoted.fact.contentHash,
    scope: profile.scope,
    maxCards: profile.maxCards,
    maxInjectedTokens: profile.maxInjectedTokens,
  });
}

export function createMemorySearchTextsV1(
  initialGoal: string | undefined,
  currentInput: string,
): readonly MemorySearchTextV1[] {
  const current = boundedSearchText(currentInput);
  if (!current) return Object.freeze([]);
  const goal = boundedSearchText(initialGoal ?? "");
  const variants: MemorySearchTextV1[] = [
    Object.freeze({ kind: "current_input", text: current, weight: 1 }),
  ];
  const seen = new Set([current.toLocaleLowerCase("en-US")]);
  for (const anchor of lexicalAnchorTextsV1(current, 2)) {
    const normalized = anchor.toLocaleLowerCase("en-US");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    variants.push(
      Object.freeze({ kind: "lexical_anchor", text: anchor, weight: 0.9 }),
    );
  }
  if (goal && goal !== current) {
    variants.push(
      Object.freeze({ kind: "initial_goal", text: goal, weight: 0.65 }),
    );
    for (const anchor of lexicalAnchorTextsV1(goal, 1)) {
      const normalized = anchor.toLocaleLowerCase("en-US");
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      variants.push(
        Object.freeze({ kind: "lexical_anchor", text: anchor, weight: 0.55 }),
      );
    }
    variants.push(
      Object.freeze({
        kind: "goal_and_input",
        text: boundedSearchText(`Goal: ${goal}\nCurrent request: ${current}`),
        weight: 0.85,
      }),
    );
  }
  return Object.freeze(variants);
}

const MEMORY_QUERY_STOPWORDS_V1 = new Set([
  "about",
  "after",
  "again",
  "also",
  "among",
  "another",
  "any",
  "are",
  "been",
  "before",
  "can",
  "could",
  "did",
  "does",
  "doing",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "into",
  "just",
  "like",
  "more",
  "much",
  "need",
  "please",
  "should",
  "some",
  "soon",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "i'm",
  "i’ve",
  "ive",
]);

/**
 * Keep BM25 useful for natural-language questions whose full plainto_tsquery
 * is too restrictive. Anchors are deterministic retrieval keys, never facts.
 */
export function lexicalAnchorTextsV1(
  value: string,
  limit = 2,
): readonly string[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 4) {
    throw new Error("Memory lexical anchor limit is invalid");
  }
  const candidates = [...value.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)]
    .map((match, index) => {
      const text = match[0]?.replace(/^['’_-]+|['’_-]+$/gu, "") ?? "";
      const normalized = text.toLocaleLowerCase("en-US");
      const first = text.codePointAt(0);
      const capitalized =
        first !== undefined &&
        String.fromCodePoint(first) ===
          String.fromCodePoint(first).toUpperCase() &&
        String.fromCodePoint(first) !==
          String.fromCodePoint(first).toLowerCase();
      const numeric = /\p{N}/u.test(text);
      const score =
        (capitalized ? 8 : 0) +
        (numeric ? 7 : 0) +
        (normalized.length >= 8 ? 3 : normalized.length >= 5 ? 1 : 0);
      return { text, normalized, index, score, strong: capitalized || numeric };
    })
    .filter(
      (item) =>
        item.normalized.length >= 3 &&
        item.strong &&
        !MEMORY_QUERY_STOPWORDS_V1.has(item.normalized),
    )
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.normalized)) continue;
    seen.add(candidate.normalized);
    selected.push(candidate.text);
    if (selected.length >= limit) break;
  }
  return Object.freeze(selected);
}

function boundedSearchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 8_192);
}

async function settleRetrieval(input: {
  readonly snapshot: SessionInputSnapshot<InputFactV1>;
  readonly query: MemoryProviderQueryV1;
  readonly profile: PawNextMemoryPluginProfileV1;
  readonly provider?: MemoryProviderV1;
  readonly context: JournalContextRuntimeV1["plan"];
  readonly buildContext: JournalContextRuntimeV1["build"];
  readonly estimator: ContextTokenEstimatorV1;
  readonly signal: AbortSignal;
}): Promise<MemoryRetrievalSettledFactV1 | undefined> {
  if (input.profile.mode === "off") {
    return receipt(
      input.query,
      input.profile.providerVersion,
      "disabled",
      [],
      "memory_disabled_by_profile",
    );
  }
  if (!input.provider) return undefined;
  try {
    const result = await input.provider.retrieve(input.query, input.signal);
    if (input.signal.aborted) return undefined;
    if (result.status !== "completed" && result.status !== "degraded") {
      throw new Error("Memory provider returned an invalid status");
    }
    const cards = freezeProviderCards(result.cards, input.query);
    const contextPlan = await input.context(input.snapshot, {
      signal: input.signal,
    });
    if (input.signal.aborted) return undefined;
    const actualRequest = await input.buildContext(input.snapshot, {
      signal: input.signal,
    });
    if (input.signal.aborted) return undefined;
    const plannedTokens = input.estimator.countMessages(
      materializeModelRequestMessagesV1(contextPlan.request),
    );
    const actualTokens = input.estimator.countMessages(
      materializeModelRequestMessagesV1(actualRequest),
    );
    // Leave a small deterministic guard for receipt-seq growth across a CAS retry.
    const actualHeadroom = Math.max(
      0,
      contextPlan.tokens.hardHeadroomTokens -
        Math.max(0, actualTokens - plannedTokens) -
        16,
    );
    const fitted = fitCardsToRequestBudget(
      cards,
      input.query,
      result.status,
      input.snapshot.tailSeq + 1,
      actualHeadroom,
      input.profile.maxInjectedTokens,
      input.estimator,
    );
    return receipt(
      input.query,
      input.provider.providerVersion,
      result.status,
      fitted,
      result.reasonCode,
    );
  } catch (error) {
    if (input.signal.aborted) return undefined;
    return receipt(
      input.query,
      input.provider.providerVersion,
      "failed",
      [],
      stableErrorCode(error),
    );
  }
}

function fitCardsToRequestBudget(
  cards: readonly MemoryCardV1[],
  query: MemoryProviderQueryV1,
  status: "completed" | "degraded",
  receiptSeq: number,
  hardHeadroomTokens: number,
  maxInjectedTokens: number,
  estimator: ContextTokenEstimatorV1,
): readonly MemoryCardV1[] {
  for (
    let count = Math.min(cards.length, query.maxCards);
    count > 0;
    count -= 1
  ) {
    const candidate = cards.slice(0, count);
    const fact = receipt(query, "budget-probe", status, candidate);
    const section = createMemoryContextSectionV1(fact, receiptSeq);
    if (!section) continue;
    const tokens = estimator.countMessages(
      materializeModelRequestMessagesV1({
        messages: [],
        contextSections: [section],
      }),
    );
    if (tokens <= hardHeadroomTokens && tokens <= maxInjectedTokens) {
      return Object.freeze(candidate);
    }
  }
  return Object.freeze([]);
}

async function commitReceiptBestEffort(input: {
  readonly initialSnapshot: SessionInputSnapshot<InputFactV1>;
  readonly fact: MemoryRetrievalSettledFactV1;
  readonly readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
  readonly commitFacts: (
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ) => Promise<"committed" | "conflict">;
  readonly onDiagnostic?: (diagnostic: MemoryPluginDiagnosticV1) => void;
}): Promise<void> {
  let snapshot = input.initialSnapshot;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (hasReceipt(snapshot, input.fact.queryId)) return;
    try {
      if (
        (await input.commitFacts(snapshot.tailSeq, [input.fact])) ===
        "committed"
      )
        return;
    } catch (error) {
      input.onDiagnostic?.({
        phase: "commit",
        queryId: input.fact.queryId,
        code: stableErrorCode(error),
      });
      return;
    }
    snapshot = await input.readSnapshot();
  }
  input.onDiagnostic?.({
    phase: "commit",
    queryId: input.fact.queryId,
    code: "MemoryReceiptCommitConflict",
  });
}

function receipt(
  query: MemoryProviderQueryV1,
  providerVersion: string,
  status: MemoryRetrievalSettledFactV1["status"],
  cards: readonly MemoryCardV1[],
  reasonCode?: string,
): MemoryRetrievalSettledFactV1 {
  return Object.freeze({
    type: "memory.retrieval_settled",
    queryId: query.queryId,
    trigger: query.trigger,
    providerVersion,
    policyVersion: MEMORY_RETRIEVAL_POLICY_VERSION_V1,
    status,
    cards: Object.freeze([...cards]),
    ...(reasonCode ? { reasonCode: stableReasonCode(reasonCode) } : {}),
  });
}

function freezeProviderCards(
  cards: readonly MemoryCardV1[],
  query: MemoryProviderQueryV1,
): readonly MemoryCardV1[] {
  if (!Array.isArray(cards) || cards.length > query.maxCards) {
    throw new Error("Memory provider returned an invalid card count");
  }
  const ids = new Set<string>();
  return Object.freeze(
    cards.map((card) => {
      if (
        !card ||
        typeof card !== "object" ||
        typeof card.id !== "string" ||
        !card.id ||
        ids.has(card.id) ||
        !Number.isSafeInteger(card.revision) ||
        card.revision <= 0 ||
        !["semantic", "episodic", "procedural", "profile", "trial"].includes(
          card.kind,
        ) ||
        typeof card.statement !== "string" ||
        !card.statement.trim() ||
        card.statement.length > 16_384 ||
        !["applicable", "reference", "trial"].includes(card.applicability) ||
        card.scope.repositoryId !== query.scope.repositoryId ||
        !Array.isArray(card.sources) ||
        card.sources.length === 0 ||
        card.sources.length > 32 ||
        !card.sources.every(
          (source: MemoryCardV1["sources"][number]) =>
            source.kind === "memory_store_evidence" &&
            typeof source.ref === "string" &&
            source.ref.length > 0,
        ) ||
        !Number.isFinite(card.confidence) ||
        card.confidence < 0 ||
        card.confidence > 1
      ) {
        throw new Error("Memory provider returned an invalid card");
      }
      const { contentHash: _contentHash, ...content } = card;
      if (
        hashCanonicalJsonV1(content as unknown as JsonValue) !==
        card.contentHash
      ) {
        throw new Error(
          "Memory provider returned a card with an invalid content hash",
        );
      }
      ids.add(card.id);
      return Object.freeze({
        ...card,
        scope: Object.freeze({ ...card.scope }),
        sources: Object.freeze(
          card.sources.map((source: MemoryCardV1["sources"][number]) =>
            Object.freeze({ ...source }),
          ),
        ),
      });
    }),
  );
}

function hasReceipt(
  snapshot: SessionInputSnapshot<InputFactV1>,
  queryId: string,
): boolean {
  return snapshot.entries.some(
    (entry) =>
      entry.fact.type === "memory.retrieval_settled" &&
      entry.fact.queryId === queryId,
  );
}

function captureInput(input: LoopInputPort): LoopInputPort {
  if (
    !input ||
    typeof input.reportSafeBoundary !== "function" ||
    typeof input.consumePromotedInputIds !== "function"
  ) {
    throw new Error("Memory plugin base input is invalid");
  }
  return Object.freeze({
    reportSafeBoundary: input.reportSafeBoundary.bind(input),
    consumePromotedInputIds: input.consumePromotedInputIds.bind(input),
  });
}

function stableErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return stableReasonCode(`MemoryProvider_${name}`);
}

function stableReasonCode(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);
  return normalized || "MemoryProvider_Unknown";
}
