import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { scanForSecrets } from "@paw/memory/longterm";

export const ATOM_INGEST_CHECKPOINT_SCHEMA_VERSION_V1 =
  "paw.amb-atom-ingest-checkpoint.v1" as const;

export interface AmbIndexWriterIdentityV1 {
  readonly model: string;
  readonly baseUrl: string;
  readonly overrideActive: boolean;
}

export function resolveAmbIndexWriterIdentityV1(input: {
  readonly activeModel?: string;
  readonly activeBaseUrl?: string;
  readonly frozenWriterModel?: string;
  readonly frozenWriterBaseUrl?: string;
}): AmbIndexWriterIdentityV1 {
  const frozenWriterModel = input.frozenWriterModel?.trim() || undefined;
  const frozenWriterBaseUrl = input.frozenWriterBaseUrl?.trim() || undefined;
  if (Boolean(frozenWriterModel) !== Boolean(frozenWriterBaseUrl)) {
    throw new Error(
      "PAW_AMB_INDEX_WRITER_MODEL and PAW_AMB_INDEX_WRITER_BASE_URL must be configured together",
    );
  }
  return Object.freeze({
    model:
      frozenWriterModel || input.activeModel?.trim() || "deepseek-v4-flash",
    baseUrl: (
      frozenWriterBaseUrl ||
      input.activeBaseUrl?.trim() ||
      "https://api.deepseek.com"
    ).replace(/\/+$/, ""),
    overrideActive: Boolean(frozenWriterModel),
  });
}

export interface AtomIngestLimitsV1 {
  readonly maxRemoteCalls: number;
  readonly maxPromptTokens: number;
  readonly maxCompletionTokens: number;
  readonly concurrency: number;
}

export interface AtomIngestBudgetSnapshotV1 extends AtomIngestLimitsV1 {
  readonly remoteCalls: number;
  readonly cacheHits: number;
  readonly cacheHitsWithOriginUsage: number;
  readonly cacheHitsWithoutOriginUsage: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly providerCacheHitTokens: number;
  readonly providerCacheMissTokens: number;
  readonly cachedOriginPromptTokens: number;
  readonly cachedOriginCompletionTokens: number;
  readonly cachedOriginProviderCacheHitTokens: number;
  readonly cachedOriginProviderCacheMissTokens: number;
  readonly workloadPromptTokens: number;
  readonly workloadCompletionTokens: number;
  readonly workloadTotalTokens: number;
  readonly costEvidenceComplete: boolean;
  readonly reservedPromptTokens: number;
  readonly reservedCompletionTokens: number;
}

interface AtomIngestReservationV1 {
  readonly id: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface AtomIngestBudgetV1 {
  reserveRemoteCall(input: {
    readonly promptTokenUpperBound: number;
    readonly completionTokenUpperBound: number;
  }): AtomIngestReservationV1;
  settleRemoteCall(
    reservation: AtomIngestReservationV1,
    usage: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly providerCacheHitTokens?: number;
      readonly providerCacheMissTokens?: number;
    },
  ): void;
  releaseRemoteCall(reservation: AtomIngestReservationV1): void;
  recordCacheHit(usage?: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly providerCacheHitTokens: number;
    readonly providerCacheMissTokens: number;
  }): void;
  snapshot(): AtomIngestBudgetSnapshotV1;
}

export const AMB_MEMORY_LLM_PURPOSES_V1 = [
  "memory-write",
  "query-plan",
  "evidence-support",
  "state-binding",
  "state-verification",
  "state-semantic-audit-a",
  "state-semantic-audit-b",
  "closure-audit",
] as const;

export type AmbMemoryLlmPurposeV1 = (typeof AMB_MEMORY_LLM_PURPOSES_V1)[number];

export type AmbMemoryLlmBudgetLimitsV1 = Readonly<
  Record<AmbMemoryLlmPurposeV1, AtomIngestLimitsV1>
>;

export interface AmbMemoryLlmBudgetPortfolioSnapshotV1 {
  readonly schemaVersion: "paw.amb-memory-llm-budget-portfolio.v1";
  readonly aggregate: AtomIngestBudgetSnapshotV1;
  readonly byPurpose: Readonly<
    Record<AmbMemoryLlmPurposeV1, AtomIngestBudgetSnapshotV1>
  >;
}

export interface AmbMemoryLlmBudgetPortfolioV1 {
  budgetFor(purpose: AmbMemoryLlmPurposeV1): AtomIngestBudgetV1;
  snapshot(): AmbMemoryLlmBudgetPortfolioSnapshotV1;
}

export type AmbCachedMemoryUsageV1 = Readonly<{
  promptTokens: number;
  completionTokens: number;
  providerCacheHitTokens: number;
  providerCacheMissTokens: number;
}>;

export function parseAmbCachedMemoryUsageV1(
  value: unknown,
): AmbCachedMemoryUsageV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = [
    "promptTokens",
    "completionTokens",
    "providerCacheHitTokens",
    "providerCacheMissTokens",
  ] as const;
  if (
    keys.some(
      (key) =>
        !Number.isSafeInteger(record[key]) || (record[key] as number) < 0,
    )
  ) {
    return null;
  }
  return Object.freeze({
    promptTokens: record.promptTokens as number,
    completionTokens: record.completionTokens as number,
    providerCacheHitTokens: record.providerCacheHitTokens as number,
    providerCacheMissTokens: record.providerCacheMissTokens as number,
  });
}

export function readAtomIngestLimitsV1(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AtomIngestLimitsV1 {
  return Object.freeze({
    maxRemoteCalls: boundedEnvInteger(
      env.PAW_AMB_ATOM_MAX_REMOTE_CALLS,
      256,
      0,
      100_000,
      "PAW_AMB_ATOM_MAX_REMOTE_CALLS",
    ),
    maxPromptTokens: boundedEnvInteger(
      env.PAW_AMB_ATOM_MAX_PROMPT_TOKENS,
      300_000,
      0,
      100_000_000,
      "PAW_AMB_ATOM_MAX_PROMPT_TOKENS",
    ),
    maxCompletionTokens: boundedEnvInteger(
      env.PAW_AMB_ATOM_MAX_COMPLETION_TOKENS,
      150_000,
      0,
      100_000_000,
      "PAW_AMB_ATOM_MAX_COMPLETION_TOKENS",
    ),
    concurrency: boundedEnvInteger(
      env.PAW_AMB_ATOM_CONCURRENCY,
      2,
      1,
      8,
      "PAW_AMB_ATOM_CONCURRENCY",
    ),
  });
}

/**
 * Keeps offline memory writing and online evidence work on independent quotas.
 * A full benchmark may legitimately spend its entire ingest allowance before
 * the first query, so sharing that allowance with query planning starves later
 * queries based solely on their position in the run.
 */
export function readAmbMemoryLlmBudgetLimitsV1(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AmbMemoryLlmBudgetLimitsV1 {
  return Object.freeze({
    "memory-write": readAtomIngestLimitsV1(env),
    "query-plan": readPurposeLimitsV1({
      env,
      prefix: "PAW_AMB_QUERY_PLAN",
      defaults: {
        maxRemoteCalls: 600,
        maxPromptTokens: 750_000,
        maxCompletionTokens: 150_000,
        concurrency: 2,
      },
    }),
    "evidence-support": readPurposeLimitsV1({
      env,
      prefix: "PAW_AMB_EVIDENCE_SUPPORT",
      defaults: {
        maxRemoteCalls: 600,
        maxPromptTokens: 4_000_000,
        maxCompletionTokens: 200_000,
        concurrency: 2,
      },
    }),
    "state-binding": readPurposeLimitsV1({
      env,
      prefix: "PAW_AMB_STATE_BINDING",
      defaults: {
        maxRemoteCalls: 120,
        maxPromptTokens: 1_000_000,
        maxCompletionTokens: 120_000,
        concurrency: 2,
      },
    }),
    "state-verification": readPurposeLimitsV1({
      env,
      prefix: "PAW_AMB_STATE_VERIFICATION",
      defaults: {
        maxRemoteCalls: 120,
        maxPromptTokens: 1_000_000,
        maxCompletionTokens: 120_000,
        concurrency: 2,
      },
    }),
    "state-semantic-audit-a": readPurposeLimitsV1({
      env,
      prefix: "PAW_AMB_STATE_SEMANTIC_AUDIT_A",
      defaults: {
        maxRemoteCalls: 120,
        maxPromptTokens: 1_500_000,
        maxCompletionTokens: 120_000,
        concurrency: 2,
      },
    }),
    "state-semantic-audit-b": readPurposeLimitsV1({
      env,
      prefix: "PAW_AMB_STATE_SEMANTIC_AUDIT_B",
      defaults: {
        maxRemoteCalls: 120,
        maxPromptTokens: 1_500_000,
        maxCompletionTokens: 120_000,
        concurrency: 2,
      },
    }),
    "closure-audit": readPurposeLimitsV1({
      env,
      prefix: "PAW_AMB_CLOSURE_AUDIT",
      defaults: {
        maxRemoteCalls: 180,
        maxPromptTokens: 450_000,
        maxCompletionTokens: 90_000,
        concurrency: 2,
      },
    }),
  });
}

export function createAmbMemoryLlmBudgetPortfolioV1(
  limits: AmbMemoryLlmBudgetLimitsV1,
): AmbMemoryLlmBudgetPortfolioV1 {
  const budgets: Record<AmbMemoryLlmPurposeV1, AtomIngestBudgetV1> = {
    "memory-write": createAtomIngestBudgetV1(limits["memory-write"]),
    "query-plan": createAtomIngestBudgetV1(limits["query-plan"]),
    "evidence-support": createAtomIngestBudgetV1(limits["evidence-support"]),
    "state-binding": createAtomIngestBudgetV1(limits["state-binding"]),
    "state-verification": createAtomIngestBudgetV1(
      limits["state-verification"],
    ),
    "state-semantic-audit-a": createAtomIngestBudgetV1(
      limits["state-semantic-audit-a"],
    ),
    "state-semantic-audit-b": createAtomIngestBudgetV1(
      limits["state-semantic-audit-b"],
    ),
    "closure-audit": createAtomIngestBudgetV1(limits["closure-audit"]),
  };
  return Object.freeze({
    budgetFor(purpose: AmbMemoryLlmPurposeV1) {
      return budgets[purpose];
    },
    snapshot() {
      const byPurpose = Object.freeze({
        "memory-write": budgets["memory-write"].snapshot(),
        "query-plan": budgets["query-plan"].snapshot(),
        "evidence-support": budgets["evidence-support"].snapshot(),
        "state-binding": budgets["state-binding"].snapshot(),
        "state-verification": budgets["state-verification"].snapshot(),
        "state-semantic-audit-a": budgets["state-semantic-audit-a"].snapshot(),
        "state-semantic-audit-b": budgets["state-semantic-audit-b"].snapshot(),
        "closure-audit": budgets["closure-audit"].snapshot(),
      });
      return Object.freeze({
        schemaVersion: "paw.amb-memory-llm-budget-portfolio.v1" as const,
        aggregate: aggregateBudgetSnapshotsV1(Object.values(byPurpose)),
        byPurpose,
      });
    },
  });
}

function readPurposeLimitsV1(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly prefix: string;
  readonly defaults: AtomIngestLimitsV1;
}): AtomIngestLimitsV1 {
  return Object.freeze({
    maxRemoteCalls: boundedEnvInteger(
      input.env[`${input.prefix}_MAX_REMOTE_CALLS`],
      input.defaults.maxRemoteCalls,
      0,
      100_000,
      `${input.prefix}_MAX_REMOTE_CALLS`,
    ),
    maxPromptTokens: boundedEnvInteger(
      input.env[`${input.prefix}_MAX_PROMPT_TOKENS`],
      input.defaults.maxPromptTokens,
      0,
      100_000_000,
      `${input.prefix}_MAX_PROMPT_TOKENS`,
    ),
    maxCompletionTokens: boundedEnvInteger(
      input.env[`${input.prefix}_MAX_COMPLETION_TOKENS`],
      input.defaults.maxCompletionTokens,
      0,
      100_000_000,
      `${input.prefix}_MAX_COMPLETION_TOKENS`,
    ),
    concurrency: boundedEnvInteger(
      input.env[`${input.prefix}_CONCURRENCY`],
      input.defaults.concurrency,
      1,
      8,
      `${input.prefix}_CONCURRENCY`,
    ),
  });
}

function aggregateBudgetSnapshotsV1(
  snapshots: readonly AtomIngestBudgetSnapshotV1[],
): AtomIngestBudgetSnapshotV1 {
  const sum = (key: keyof AtomIngestBudgetSnapshotV1): number =>
    snapshots.reduce((total, snapshot) => {
      const value = snapshot[key];
      return total + (typeof value === "number" ? value : 0);
    }, 0);
  return Object.freeze({
    maxRemoteCalls: sum("maxRemoteCalls"),
    maxPromptTokens: sum("maxPromptTokens"),
    maxCompletionTokens: sum("maxCompletionTokens"),
    concurrency: sum("concurrency"),
    remoteCalls: sum("remoteCalls"),
    cacheHits: sum("cacheHits"),
    cacheHitsWithOriginUsage: sum("cacheHitsWithOriginUsage"),
    cacheHitsWithoutOriginUsage: sum("cacheHitsWithoutOriginUsage"),
    promptTokens: sum("promptTokens"),
    completionTokens: sum("completionTokens"),
    providerCacheHitTokens: sum("providerCacheHitTokens"),
    providerCacheMissTokens: sum("providerCacheMissTokens"),
    cachedOriginPromptTokens: sum("cachedOriginPromptTokens"),
    cachedOriginCompletionTokens: sum("cachedOriginCompletionTokens"),
    cachedOriginProviderCacheHitTokens: sum(
      "cachedOriginProviderCacheHitTokens",
    ),
    cachedOriginProviderCacheMissTokens: sum(
      "cachedOriginProviderCacheMissTokens",
    ),
    workloadPromptTokens: sum("workloadPromptTokens"),
    workloadCompletionTokens: sum("workloadCompletionTokens"),
    workloadTotalTokens: sum("workloadTotalTokens"),
    costEvidenceComplete: snapshots.every(
      (snapshot) => snapshot.costEvidenceComplete,
    ),
    reservedPromptTokens: sum("reservedPromptTokens"),
    reservedCompletionTokens: sum("reservedCompletionTokens"),
  });
}

export function createAtomIngestBudgetV1(
  limits: AtomIngestLimitsV1,
): AtomIngestBudgetV1 {
  let nextReservationId = 0;
  let remoteCalls = 0;
  let cacheHits = 0;
  let cacheHitsWithOriginUsage = 0;
  let cacheHitsWithoutOriginUsage = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let providerCacheHitTokens = 0;
  let providerCacheMissTokens = 0;
  let cachedOriginPromptTokens = 0;
  let cachedOriginCompletionTokens = 0;
  let cachedOriginProviderCacheHitTokens = 0;
  let cachedOriginProviderCacheMissTokens = 0;
  const reservations = new Map<number, AtomIngestReservationV1>();

  function reserved(kind: "promptTokens" | "completionTokens"): number {
    let total = 0;
    for (const reservation of reservations.values()) total += reservation[kind];
    return total;
  }

  function snapshot(): AtomIngestBudgetSnapshotV1 {
    return Object.freeze({
      ...limits,
      remoteCalls,
      cacheHits,
      cacheHitsWithOriginUsage,
      cacheHitsWithoutOriginUsage,
      promptTokens,
      completionTokens,
      providerCacheHitTokens,
      providerCacheMissTokens,
      cachedOriginPromptTokens,
      cachedOriginCompletionTokens,
      cachedOriginProviderCacheHitTokens,
      cachedOriginProviderCacheMissTokens,
      workloadPromptTokens: promptTokens + cachedOriginPromptTokens,
      workloadCompletionTokens: completionTokens + cachedOriginCompletionTokens,
      workloadTotalTokens:
        promptTokens +
        completionTokens +
        cachedOriginPromptTokens +
        cachedOriginCompletionTokens,
      costEvidenceComplete: cacheHitsWithoutOriginUsage === 0,
      reservedPromptTokens: reserved("promptTokens"),
      reservedCompletionTokens: reserved("completionTokens"),
    });
  }

  return Object.freeze({
    reserveRemoteCall(input: {
      readonly promptTokenUpperBound: number;
      readonly completionTokenUpperBound: number;
    }) {
      const promptUpper = nonNegativeInteger(
        input.promptTokenUpperBound,
        "prompt token reservation",
      );
      const completionUpper = nonNegativeInteger(
        input.completionTokenUpperBound,
        "completion token reservation",
      );
      const current = snapshot();
      if (remoteCalls + 1 > limits.maxRemoteCalls) {
        throw namedError("AtomIngestRemoteCallBudgetExceeded");
      }
      if (
        current.promptTokens + current.reservedPromptTokens + promptUpper >
        limits.maxPromptTokens
      ) {
        throw namedError("AtomIngestPromptTokenBudgetExceeded");
      }
      if (
        current.completionTokens +
          current.reservedCompletionTokens +
          completionUpper >
        limits.maxCompletionTokens
      ) {
        throw namedError("AtomIngestCompletionTokenBudgetExceeded");
      }
      const reservation = Object.freeze({
        id: ++nextReservationId,
        promptTokens: promptUpper,
        completionTokens: completionUpper,
      });
      reservations.set(reservation.id, reservation);
      remoteCalls += 1;
      return reservation;
    },
    settleRemoteCall(
      reservation: AtomIngestReservationV1,
      usage: {
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly providerCacheHitTokens?: number;
        readonly providerCacheMissTokens?: number;
      },
    ) {
      requireReservation(reservations, reservation);
      promptTokens += nonNegativeInteger(usage.promptTokens, "prompt tokens");
      completionTokens += nonNegativeInteger(
        usage.completionTokens,
        "completion tokens",
      );
      providerCacheHitTokens += nonNegativeInteger(
        usage.providerCacheHitTokens ?? 0,
        "provider cache hit tokens",
      );
      providerCacheMissTokens += nonNegativeInteger(
        usage.providerCacheMissTokens ?? 0,
        "provider cache miss tokens",
      );
      reservations.delete(reservation.id);
    },
    releaseRemoteCall(reservation: AtomIngestReservationV1) {
      requireReservation(reservations, reservation);
      reservations.delete(reservation.id);
    },
    recordCacheHit(usage?: {
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly providerCacheHitTokens: number;
      readonly providerCacheMissTokens: number;
    }) {
      cacheHits += 1;
      if (!usage) {
        cacheHitsWithoutOriginUsage += 1;
        return;
      }
      cacheHitsWithOriginUsage += 1;
      cachedOriginPromptTokens += nonNegativeInteger(
        usage.promptTokens,
        "cached origin prompt tokens",
      );
      cachedOriginCompletionTokens += nonNegativeInteger(
        usage.completionTokens,
        "cached origin completion tokens",
      );
      cachedOriginProviderCacheHitTokens += nonNegativeInteger(
        usage.providerCacheHitTokens,
        "cached origin provider cache hit tokens",
      );
      cachedOriginProviderCacheMissTokens += nonNegativeInteger(
        usage.providerCacheMissTokens,
        "cached origin provider cache miss tokens",
      );
    },
    snapshot,
  });
}

export interface AtomIngestCheckpointStoreV1 {
  readonly resumed: boolean;
  has(key: string): boolean;
  markCompleted(key: string): void;
  snapshot(): Readonly<{
    schemaVersion: typeof ATOM_INGEST_CHECKPOINT_SCHEMA_VERSION_V1;
    runKey: string;
    identityHash: string;
    completedCount: number;
  }>;
}

export interface AmbMemoryEvidenceWindowV1 {
  readonly source: readonly Readonly<{
    seq: number;
    kind: "user_input" | "assistant_output" | "verification";
    content: string;
  }>[];
  readonly archiveSource: readonly Readonly<{
    seq: number;
    kind: "user_input" | "assistant_output" | "verification";
    content: string;
  }>[];
  readonly text: string;
}

type AmbMemoryEvidenceBlockV1 = Readonly<{
  kind: "user_input" | "assistant_output" | "verification";
  content: string;
}>;

function structuredConversationBlocksV1(
  content: string,
): readonly AmbMemoryEvidenceBlockV1[] {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[")) return [];
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const blocks: AmbMemoryEvidenceBlockV1[] = [];
  for (const turn of value) {
    if (!turn || typeof turn !== "object" || Array.isArray(turn)) return [];
    const role = Reflect.get(turn, "role");
    const text = Reflect.get(turn, "content");
    if (
      typeof role !== "string" ||
      typeof text !== "string" ||
      !new Set(["system", "user", "assistant"]).has(role.toLowerCase())
    ) {
      return [];
    }
    const sanitized = sanitizedEvidenceContent(text.trim());
    if (!sanitized) continue;
    blocks.push(
      Object.freeze({
        kind:
          role.toLowerCase() === "system"
            ? "verification"
            : role.toLowerCase() === "assistant"
              ? "assistant_output"
              : "user_input",
        content: sanitized,
      }),
    );
  }
  return Object.freeze(blocks);
}

export function projectAmbMemoryEvidenceV1(
  content: string,
  maxWindowChars = 24_000,
): readonly AmbMemoryEvidenceWindowV1[] {
  if (!Number.isSafeInteger(maxWindowChars) || maxWindowChars < 1_024) {
    throw namedError("AmbMemoryEvidenceWindowInvalid");
  }
  const marker = /^\[(SYSTEM|USER|ASSISTANT)\]\s*/gim;
  const matches = [...content.matchAll(marker)];
  const blocks: AmbMemoryEvidenceBlockV1[] = [
    ...structuredConversationBlocksV1(content),
  ];
  for (const [index, match] of blocks.length === 0 ? matches.entries() : []) {
    const role = match[1]?.toUpperCase();
    if (role !== "SYSTEM" && role !== "USER" && role !== "ASSISTANT") continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const text = sanitizedEvidenceContent(content.slice(start, end).trim());
    if (!text) continue;
    blocks.push(
      Object.freeze({
        kind:
          role === "SYSTEM"
            ? "verification"
            : role === "ASSISTANT"
              ? "assistant_output"
              : "user_input",
        content: text.replace(/^(?:System|User):\s*/i, ""),
      }),
    );
  }
  if (blocks.length === 0 && content.trim()) {
    blocks.push(Object.freeze({ kind: "user_input", content: content.trim() }));
  }

  const pieces: typeof blocks = [];
  for (const block of blocks) {
    for (let start = 0; start < block.content.length; start += maxWindowChars) {
      pieces.push(
        Object.freeze({
          kind: block.kind,
          content: block.content.slice(start, start + maxWindowChars),
        }),
      );
    }
  }

  const windows: AmbMemoryEvidenceWindowV1[] = [];
  let nextSeq = 1;
  let current: Array<{
    seq: number;
    kind: "user_input" | "assistant_output" | "verification";
    content: string;
  }> = [];
  let currentChars = 0;
  function flush(): void {
    if (current.length === 0) return;
    windows.push(
      Object.freeze({
        archiveSource: Object.freeze(
          current.map((item) => Object.freeze(item)),
        ),
        source: Object.freeze(
          current.map((item) =>
            Object.freeze({
              ...item,
              content:
                item.kind === "assistant_output"
                  ? compactAssistantContext(item.content, 1_600)
                  : item.content,
            }),
          ),
        ),
        text: current
          .map((item) =>
            item.kind === "assistant_output"
              ? compactAssistantContext(item.content, 1_600)
              : item.content,
          )
          .join("\n"),
      }),
    );
    current = [];
    currentChars = 0;
  }
  for (const piece of pieces) {
    const separatorChars = current.length > 0 ? 1 : 0;
    if (
      current.length > 0 &&
      currentChars + separatorChars + piece.content.length > maxWindowChars
    ) {
      flush();
    }
    current.push({ seq: nextSeq++, kind: piece.kind, content: piece.content });
    currentChars += (current.length > 1 ? 1 : 0) + piece.content.length;
  }
  flush();
  return Object.freeze(windows);
}

function sanitizedEvidenceContent(content: string): string {
  const scan = scanForSecrets(content);
  if (scan.action === "reject") return "[SECRET_BLOCKED]";
  return scan.action === "redact" ? scan.text : content;
}

function compactAssistantContext(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = "\n[… assistant context omitted …]\n";
  const headChars = Math.min(256, Math.floor((maxChars - marker.length) / 3));
  const tailChars = maxChars - marker.length - headChars;
  return `${content.slice(0, headChars)}${marker}${content.slice(-tailChars)}`;
}

const AMB_EVIDENCE_STOP_WORDS_V1 = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "could",
  "from",
  "have",
  "into",
  "just",
  "more",
  "question",
  "should",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "user",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

/**
 * Selects a bounded L0 excerpt after L1 atoms have identified a source.
 * The operation is deterministic and local: no model call and no raw text log.
 */
export function selectAmbSourceEvidenceV1(input: {
  readonly sourceTexts: readonly string[];
  readonly query: string;
  readonly atomStatements?: readonly string[];
  readonly maxChars: number;
}): string {
  if (!Number.isSafeInteger(input.maxChars) || input.maxChars < 256) {
    throw namedError("AmbSourceEvidenceBudgetInvalid");
  }
  const segments = input.sourceTexts.flatMap((text) => evidenceSegments(text));
  if (segments.length === 0) return "";
  const queryTerms = evidenceTerms(input.query);
  const atomTerms = evidenceTerms((input.atomStatements ?? []).join("\n"));
  const ranked = segments
    .map((text, index) => {
      const terms = new Set(evidenceTerms(text));
      let score = 0;
      for (const term of queryTerms) if (terms.has(term)) score += 6;
      for (const term of atomTerms) if (terms.has(term)) score += 1;
      return { text, index, score };
    })
    .sort(
      (left, right) => right.score - left.score || left.index - right.index,
    );

  const selected: Array<{ text: string; index: number }> = [];
  let used = 0;
  for (const candidate of ranked) {
    const separator = selected.length > 0 ? 1 : 0;
    const remaining = input.maxChars - used - separator;
    if (remaining <= 0) break;
    if (candidate.text.length <= remaining) {
      selected.push(candidate);
      used += separator + candidate.text.length;
      continue;
    }
    if (selected.length === 0) {
      selected.push({ ...candidate, text: candidate.text.slice(0, remaining) });
      used += candidate.text.slice(0, remaining).length;
    }
  }
  return selected
    .sort((left, right) => left.index - right.index)
    .map((item) => item.text)
    .join("\n");
}

export interface AmbSourceChunkV1 {
  readonly documentId: string;
  readonly index: number;
  readonly text: string;
}

/** Selects whole contiguous L0 chunks, preserving evidence continuity. */
export function selectAmbSourceChunksV1(input: {
  readonly chunks: readonly AmbSourceChunkV1[];
  readonly query: string;
  readonly atomStatements?: readonly string[];
  readonly maxChars: number;
}): readonly AmbSourceChunkV1[] {
  if (!Number.isSafeInteger(input.maxChars) || input.maxChars < 256) {
    throw namedError("AmbSourceChunkBudgetInvalid");
  }
  const queryTerms = evidenceTerms(input.query);
  const atomTerms = evidenceTerms((input.atomStatements ?? []).join("\n"));
  const ranked = input.chunks
    .filter((chunk) => chunk.text.trim())
    .map((chunk, order) => {
      const terms = evidenceTerms(chunk.text);
      let score = 0;
      for (const term of queryTerms) if (terms.has(term)) score += 6;
      for (const term of atomTerms) if (terms.has(term)) score += 1;
      return { chunk, order, score };
    })
    .sort(
      (left, right) => right.score - left.score || left.order - right.order,
    );
  const selected: AmbSourceChunkV1[] = [];
  let used = 0;
  for (const candidate of ranked) {
    const separator = selected.length > 0 ? 1 : 0;
    if (used + separator + candidate.chunk.text.length > input.maxChars)
      continue;
    selected.push(candidate.chunk);
    used += separator + candidate.chunk.text.length;
  }
  return Object.freeze(selected);
}

function evidenceSegments(text: string, targetChars = 720): string[] {
  const sentences = text
    .split(/\n+/u)
    .flatMap((line) => line.match(/[^.!?。！？]+[.!?。！？]?/gu) ?? [])
    .map((item) => item.trim())
    .filter(Boolean);
  const output: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    for (let start = 0; start < sentence.length; start += targetChars) {
      const piece = sentence.slice(start, start + targetChars);
      if (current && current.length + 1 + piece.length > targetChars) {
        output.push(current);
        current = "";
      }
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) output.push(current);
  return output;
}

function evidenceTerms(text: string): Set<string> {
  const terms =
    text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [];
  return new Set(
    terms.filter(
      (term) => term.length > 1 && !AMB_EVIDENCE_STOP_WORDS_V1.has(term),
    ),
  );
}

export function createAtomIngestCheckpointStoreV1(input: {
  readonly path: string;
  readonly runKey: string;
  readonly identityHash: string;
  readonly resume: boolean;
}): AtomIngestCheckpointStoreV1 {
  const path = resolve(input.path);
  let resumed = false;
  let completed = new Set<string>();
  if (input.resume && existsSync(path)) {
    const parsed = parseCheckpoint(readFileSync(path, "utf8"));
    if (
      parsed.runKey !== input.runKey ||
      parsed.identityHash !== input.identityHash
    ) {
      throw namedError("AtomIngestCheckpointIdentityMismatch");
    }
    completed = new Set(parsed.completedKeys);
    resumed = true;
  } else {
    persistCheckpoint(path, input.runKey, input.identityHash, completed);
  }
  return Object.freeze({
    resumed,
    has(key: string) {
      return completed.has(validHash(key, "checkpoint key"));
    },
    markCompleted(key: string) {
      const normalized = validHash(key, "checkpoint key");
      if (completed.has(normalized)) return;
      completed.add(normalized);
      persistCheckpoint(path, input.runKey, input.identityHash, completed);
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: ATOM_INGEST_CHECKPOINT_SCHEMA_VERSION_V1,
        runKey: input.runKey,
        identityHash: input.identityHash,
        completedCount: completed.size,
      });
    },
  });
}

export async function runKeyedInOrderV1<T>(input: {
  readonly items: readonly T[];
  readonly concurrency: number;
  readonly key: (item: T) => string;
  readonly run: (item: T) => Promise<void>;
}): Promise<void> {
  const concurrency = nonNegativeInteger(input.concurrency, "concurrency");
  if (concurrency < 1 || concurrency > 8) {
    throw namedError("AtomIngestConcurrencyInvalid");
  }
  const groups = new Map<string, T[]>();
  for (const item of input.items) {
    const key = input.key(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const queue = [...groups.values()];
  let cursor = 0;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (failure === undefined) {
      const index = cursor++;
      const group = queue[index];
      if (!group) return;
      try {
        for (const item of group) {
          if (failure !== undefined) return;
          await input.run(item);
        }
      } catch (error) {
        failure = error;
        return;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()),
  );
  if (failure !== undefined) throw failure;
}

function persistCheckpoint(
  path: string,
  runKey: string,
  identityHash: string,
  completed: ReadonlySet<string>,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify({
    schemaVersion: ATOM_INGEST_CHECKPOINT_SCHEMA_VERSION_V1,
    runKey,
    identityHash,
    completedKeys: [...completed].sort(),
  });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, body, "utf8");
  renameSync(temporary, path);
}

function parseCheckpoint(text: string): Readonly<{
  runKey: string;
  identityHash: string;
  completedKeys: readonly string[];
}> {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value.schemaVersion !== ATOM_INGEST_CHECKPOINT_SCHEMA_VERSION_V1 ||
      typeof value.runKey !== "string" ||
      typeof value.identityHash !== "string" ||
      !Array.isArray(value.completedKeys) ||
      !value.completedKeys.every((key) => typeof key === "string")
    ) {
      throw new Error("invalid");
    }
    const completedKeys = value.completedKeys.map((key) =>
      validHash(key as string, "checkpoint key"),
    );
    if (new Set(completedKeys).size !== completedKeys.length) {
      throw new Error("duplicate");
    }
    return Object.freeze({
      runKey: value.runKey,
      identityHash: validHash(value.identityHash, "identity hash"),
      completedKeys: Object.freeze(completedKeys),
    });
  } catch {
    throw namedError("AtomIngestCheckpointInvalid");
  }
}

function boundedEnvInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || !value.trim()) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw namedError(`${name}Invalid`);
  }
  return number;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw namedError(`${label.replace(/\W+/g, "_")}Invalid`);
  }
  return value;
}

function validHash(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw namedError(`${label.replace(/\W+/g, "_")}Invalid`);
  }
  return value;
}

function requireReservation(
  reservations: ReadonlyMap<number, AtomIngestReservationV1>,
  reservation: AtomIngestReservationV1,
): void {
  if (reservations.get(reservation.id) !== reservation) {
    throw namedError("AtomIngestReservationInvalid");
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
