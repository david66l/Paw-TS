import path from "node:path";

import type {
  ToolBatchOptions,
  ToolExecutor,
  ToolSettlement,
} from "@paw/agent-loop";
import type { ToolDefinition } from "@paw/core";
import type { ToolRunResult } from "@paw/harness";
import type { MemoryEntry } from "@paw/memory/longterm";
import type { JsonValue } from "@paw/protocol";
import {
  type RuntimeToolCallV1,
  type RuntimeToolPluginEntryV1,
  type RuntimeToolPluginV1,
  canonicalRuntimeResourcePathV1,
} from "@paw/runtime";

import {
  canonicalJsonStringifyV1,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import type {
  MemoryContextResolverV1,
  MemoryResolvedContextPacketV1,
} from "./context-resolver.js";
import type { MemoryEvidenceLedgerV1 } from "./evidence-ledger.js";
import type { PawNextMemoryPluginProfileV1 } from "./profile.js";
import { memoryScopeFingerprintV1 } from "./profile.js";
import type { MemoryRawEvidenceArchiveV1 } from "./raw-evidence-archive.js";
import {
  type MemoryProviderQueryV1,
  type MemoryProviderV1,
  createMemorySearchTextsV1,
} from "./retrieval-input-port.js";
import type { MemoryTopicDossierStoreV1 } from "./topic-dossier-store.js";
import type {
  MemoryTopicDossierStateV1,
  MemoryTopicDossierV1,
} from "./topic-dossier.js";
import type { MemoryTopicEvidenceCatalogItemV1 } from "./topic-evidence-planner.js";
import type { MemoryTopicEvidenceStoreV1 } from "./topic-evidence-store.js";

export const PAW_MEMORY_TOOL_PLUGIN_ID_V1 = "paw.memory-tools" as const;
export const PAW_MEMORY_TOOL_PLUGIN_VERSION_V1 =
  "paw.memory-tools.v1:staged-resolver:support-roles:c9:b24000" as const;

export const MEMORY_RESOLVE_CONTEXT_V1 = "memory.resolve_context" as const;
export const MEMORY_SEARCH_ATOMS_V1 = "memory.search_atoms" as const;
export const MEMORY_LIST_TOPICS_V1 = "memory.list_topics" as const;
export const MEMORY_READ_TOPIC_V1 = "memory.read_topic" as const;
export const MEMORY_SEARCH_CONVERSATION_V1 =
  "memory.search_conversation" as const;
export const MEMORY_READ_EVIDENCE_V1 = "memory.read_evidence" as const;

const MEMORY_TOOL_NAMES = Object.freeze([
  MEMORY_RESOLVE_CONTEXT_V1,
  MEMORY_SEARCH_ATOMS_V1,
  MEMORY_LIST_TOPICS_V1,
  MEMORY_READ_TOPIC_V1,
  MEMORY_SEARCH_CONVERSATION_V1,
  MEMORY_READ_EVIDENCE_V1,
]);

export interface MemoryToolEventV1 {
  readonly schemaVersion: "paw.memory-tool-event.v1";
  readonly tool: (typeof MEMORY_TOOL_NAMES)[number];
  readonly status: "completed" | "failed" | "limited";
  readonly cacheHit: boolean;
  readonly callIndex: number;
  readonly resultChars: number;
  readonly durationMs: number;
  readonly scopeFingerprint: string;
  readonly reasonCode?: string;
}

export interface MemoryToolExecutorOptionsV1 {
  readonly delegate: ToolExecutor<
    RuntimeToolCallV1,
    ToolSettlement<ToolRunResult>
  >;
  readonly profile: PawNextMemoryPluginProfileV1;
  readonly provider?: MemoryProviderV1;
  readonly topicStore?: MemoryTopicEvidenceStoreV1;
  readonly dossierStore?: MemoryTopicDossierStoreV1;
  readonly rawEvidenceArchive?: MemoryRawEvidenceArchiveV1;
  readonly contextResolver?: MemoryContextResolverV1;
  readonly maxCalls?: number;
  readonly maxTotalChars?: number;
  /** Experimental session delta projection; omitted by the product default. */
  readonly evidenceLedger?: MemoryEvidenceLedgerV1;
  readonly now?: () => number;
  readonly onEvent?: (event: MemoryToolEventV1) => void;
}

/**
 * Model-visible definitions only. Execution stays in the memory plugin's
 * executor decorator, so Runtime and Harness remain unaware of memory.
 */
export function createPawNextMemoryToolPluginV1(
  profile: PawNextMemoryPluginProfileV1,
): RuntimeToolPluginV1 {
  if (profile.mode === "off") {
    throw new Error("Disabled memory cannot expose read tools");
  }
  const scopeFingerprint = memoryScopeFingerprintV1(profile.scope);
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: PAW_MEMORY_TOOL_PLUGIN_ID_V1,
    pluginVersion: PAW_MEMORY_TOOL_PLUGIN_VERSION_V1,
    entries: Object.freeze([
      entry(
        MEMORY_RESOLVE_CONTEXT_V1,
        "memory_resolve_context",
        "Resolve one complete question into a bounded, source-grounded evidence packet across L1, L2 topic dossiers, and exact L0 spans. Call this first. If stop is sufficient, answer without more memory calls; use the lower-level tools only when stop is partial or missing.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 8192 },
          },
          required: ["query"],
        },
        validateResolveContext,
        scopeFingerprint,
      ),
      entry(
        MEMORY_SEARCH_ATOMS_V1,
        "memory_search_atoms",
        "Search L1 long-term memory for user preferences, stable facts, decisions, outcomes, or prior experiences. Use focused queries and inspect source references before relying on a causal claim.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 8192 },
            max_results: { type: "integer", minimum: 1, maximum: 8 },
          },
          required: ["query"],
        },
        validateSearchAtoms,
        scopeFingerprint,
      ),
      entry(
        MEMORY_LIST_TOPICS_V1,
        "memory_list_topics",
        "List the stable L2 memory topic index. Use this as navigation before reading a detailed topic; it returns summaries and IDs, not every memory body.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            max_results: { type: "integer", minimum: 1, maximum: 64 },
          },
        },
        validateListTopics,
        scopeFingerprint,
      ),
      entry(
        MEMORY_READ_TOPIC_V1,
        "memory_read_topic",
        "Read one evidence-grounded L2 topic dossier. It returns current conclusions, explicit changes, conflicts, and source references; older flat trajectory states are used only when no dossier exists.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            topic_id: { type: "string", minLength: 1, maxLength: 256 },
            max_states: { type: "integer", minimum: 1, maximum: 24 },
          },
          required: ["topic_id"],
        },
        validateReadTopic,
        scopeFingerprint,
      ),
      entry(
        MEMORY_SEARCH_CONVERSATION_V1,
        "memory_search_conversation",
        "Search source-grounded L0 conversation evidence. Use when L1/L2 is incomplete, for exact history, or to verify the reason behind a prior decision.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 512 },
            max_results: { type: "integer", minimum: 1, maximum: 8 },
            max_chars: { type: "integer", minimum: 256, maximum: 8000 },
          },
          required: ["query"],
        },
        validateSearchConversation,
        scopeFingerprint,
      ),
      entry(
        MEMORY_READ_EVIDENCE_V1,
        "memory_read_evidence",
        "Read exact L0 evidence references returned by memory search or topic tools. This is the strongest way to ground a final factual claim.",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            evidence_refs: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: { type: "string", minLength: 1, maxLength: 1024 },
            },
            memory_ids: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: { type: "string", minLength: 1, maxLength: 256 },
            },
            max_chars: { type: "integer", minimum: 256, maximum: 8000 },
          },
          required: ["evidence_refs", "memory_ids"],
        },
        validateReadEvidence,
        scopeFingerprint,
      ),
    ]),
  });
}

/** Scope-bound, read-only executor with a combined call/character budget. */
export function createPawNextMemoryToolExecutorV1(
  input: MemoryToolExecutorOptionsV1,
): ToolExecutor<RuntimeToolCallV1, ToolSettlement<ToolRunResult>> {
  const plugin = createPawNextMemoryToolPluginV1(input.profile);
  const entries = new Map<string, RuntimeToolPluginEntryV1>();
  for (const item of plugin.entries) {
    entries.set(item.internalName, item);
    entries.set(item.providerName, item);
  }
  assertScope(input.topicStore?.scope, input.profile, "topic store");
  assertScope(input.dossierStore?.scope, input.profile, "dossier store");
  assertScope(
    input.rawEvidenceArchive?.scope,
    input.profile,
    "raw evidence archive",
  );
  const maxCalls = boundedInteger(input.maxCalls ?? 6, 1, 16, "call budget");
  const maxTotalChars = boundedInteger(
    input.maxTotalChars ?? 24_000,
    1_024,
    64_000,
    "character budget",
  );
  const now = input.now ?? Date.now;
  const scopeFingerprint = memoryScopeFingerprintV1(input.profile.scope);
  const cache = new Map<string, ToolRunResult>();
  const evidenceLedger = input.evidenceLedger;
  let callCount = 0;
  let returnedChars = 0;
  let resolverStop: "unresolved" | "sufficient" | "partial" | "missing" =
    "unresolved";
  let topicCache:
    | Awaited<ReturnType<MemoryTopicEvidenceStoreV1["load"]>>
    | undefined;

  return Object.freeze({
    async executeSettled(
      calls: readonly RuntimeToolCallV1[],
      options: ToolBatchOptions,
    ) {
      // The base executor remains the sole owner of registry validation,
      // permission facts and resource locks. Harness does not know memory and
      // will return a non-success settlement for these read-only plugin names;
      // replace only those settlements after the common lifecycle completes.
      const output = [...(await input.delegate.executeSettled(calls, options))];
      const resolverIndex = calls.findIndex(
        (call) =>
          entries.get(call.name)?.internalName === MEMORY_RESOLVE_CONTEXT_V1,
      );
      if (resolverIndex >= 0) {
        const resolverCall = calls[resolverIndex];
        const resolverEntry = resolverCall
          ? entries.get(resolverCall.name)
          : undefined;
        if (resolverCall && resolverEntry) {
          output[resolverIndex] = await executeMemoryCall(
            resolverCall,
            resolverEntry,
            options.signal,
          );
        }
      }
      for (const [index, call] of calls.entries()) {
        const toolEntry = entries.get(call.name);
        if (!toolEntry) continue;
        if (index === resolverIndex) continue;
        if (
          resolverIndex >= 0 &&
          resolverStop !== "unresolved" &&
          toolEntry.internalName !== MEMORY_RESOLVE_CONTEXT_V1
        ) {
          output[index] = failureSettlement(
            call.id,
            "MemoryContextResolverMustSettleFirst",
          );
          continue;
        }
        output[index] = await executeMemoryCall(
          call,
          toolEntry,
          options.signal,
        );
      }
      return output.map((value, index) => {
        if (value) return value;
        const call = calls[index];
        if (!call) throw namedError("MemoryToolBatchShapeInvalid");
        return failureSettlement(call.id, "MemoryToolUnsettled");
      });
    },
  });

  async function executeMemoryCall(
    call: RuntimeToolCallV1,
    toolEntry: RuntimeToolPluginEntryV1,
    signal: AbortSignal,
  ): Promise<ToolSettlement<ToolRunResult>> {
    const started = now();
    const tool = toolEntry.internalName as MemoryToolEventV1["tool"];
    callCount += 1;
    if (signal.aborted) {
      return { status: "cancelled", callId: call.id, reason: "aborted" };
    }
    if (callCount > maxCalls) {
      emit(input.onEvent, {
        schemaVersion: "paw.memory-tool-event.v1",
        tool,
        status: "limited",
        cacheHit: false,
        callIndex: callCount,
        resultChars: 0,
        durationMs: Math.max(0, now() - started),
        scopeFingerprint,
        reasonCode: "MemoryToolCallBudgetExceeded",
      });
      return failureSettlement(call.id, "MemoryToolCallBudgetExceeded");
    }
    if (
      input.contextResolver &&
      tool !== MEMORY_RESOLVE_CONTEXT_V1 &&
      resolverStop === "sufficient"
    ) {
      const reasonCode = "MemoryContextAlreadySufficient";
      emit(input.onEvent, {
        schemaVersion: "paw.memory-tool-event.v1",
        tool,
        status: "limited",
        cacheHit: false,
        callIndex: callCount,
        resultChars: 0,
        durationMs: Math.max(0, now() - started),
        scopeFingerprint,
        reasonCode,
      });
      return failureSettlement(call.id, reasonCode);
    }
    const validated = toolEntry.validate(call.arguments);
    if (!validated.ok) {
      return {
        status: "failed",
        callId: call.id,
        error: {
          name: "MemoryToolSchemaInvalid",
          message: validated.result.summary,
        },
        evidence: validated.result,
      };
    }
    const remainingChars = maxTotalChars - returnedChars;
    if (remainingChars < 256) {
      return failureSettlement(call.id, "MemoryToolCharacterBudgetExceeded");
    }
    const key = hashCanonicalJsonV1({
      schemaVersion: "paw.memory-tool-cache-key.v1",
      tool,
      args: validated.args,
      providerVersion: input.profile.providerVersion,
      scopeFingerprint,
    } as unknown as JsonValue);
    const cached = cache.get(key);
    if (cached) {
      const result = withCacheHit(projectThroughEvidenceLedger(cached));
      const chars = JSON.stringify(result.payload).length;
      if (chars > remainingChars) {
        return failureSettlement(call.id, "MemoryToolCharacterBudgetExceeded");
      }
      returnedChars += chars;
      emit(input.onEvent, {
        schemaVersion: "paw.memory-tool-event.v1",
        tool,
        status: "completed",
        cacheHit: true,
        callIndex: callCount,
        resultChars: chars,
        durationMs: Math.max(0, now() - started),
        scopeFingerprint,
      });
      return { status: "success", callId: call.id, result };
    }
    try {
      const rawResult = await runTool(
        tool,
        validated.args,
        remainingChars,
        signal,
      );
      const result = projectThroughEvidenceLedger(rawResult);
      const chars = JSON.stringify(result.payload).length;
      if (chars > remainingChars) {
        throw namedError("MemoryToolCharacterBudgetExceeded");
      }
      cache.set(key, rawResult);
      returnedChars += chars;
      emit(input.onEvent, {
        schemaVersion: "paw.memory-tool-event.v1",
        tool,
        status: "completed",
        cacheHit: false,
        callIndex: callCount,
        resultChars: chars,
        durationMs: Math.max(0, now() - started),
        scopeFingerprint,
      });
      return { status: "success", callId: call.id, result };
    } catch (error) {
      const reasonCode = stableErrorCode(error);
      emit(input.onEvent, {
        schemaVersion: "paw.memory-tool-event.v1",
        tool,
        status: "failed",
        cacheHit: false,
        callIndex: callCount,
        resultChars: 0,
        durationMs: Math.max(0, now() - started),
        scopeFingerprint,
        reasonCode,
      });
      return failureSettlement(call.id, reasonCode);
    }
  }

  function projectThroughEvidenceLedger(result: ToolRunResult): ToolRunResult {
    if (!evidenceLedger) return result;
    const payload = result.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return result;
    }
    const projection = evidenceLedger.project(
      String((payload as Record<string, unknown>).tool ?? "memory"),
      payload as Readonly<Record<string, unknown>>,
    );
    return Object.freeze({ ...result, payload: projection.payload });
  }

  async function runTool(
    tool: MemoryToolEventV1["tool"],
    args: Readonly<Record<string, unknown>>,
    remainingChars: number,
    signal: AbortSignal,
  ): Promise<ToolRunResult> {
    if (tool === MEMORY_RESOLVE_CONTEXT_V1) {
      if (!input.contextResolver) {
        throw namedError("MemoryContextResolverUnavailable");
      }
      const packet = await input.contextResolver.resolve(
        String(args.query),
        signal,
      );
      resolverStop = packet.stop;
      return success(
        tool,
        projectMemoryResolvedContextToolV1(
          packet,
          Math.min(remainingChars, 8_000),
        ),
      );
    }
    if (tool === MEMORY_SEARCH_ATOMS_V1) {
      if (!input.provider) throw namedError("MemoryAtomProviderUnavailable");
      const queryText = String(args.query);
      const maxResults = Number(args.max_results);
      const query = toolQuery(queryText, maxResults, input.profile);
      const result = await input.provider.retrieve(query, signal);
      const evidence = fitItems(
        result.cards.slice(0, maxResults).map((card) => ({
          memoryId: card.id,
          kind: card.kind,
          statement: card.statement,
          confidence: card.confidence,
          sources: card.sources.map((source) => source.ref),
        })),
        Math.min(remainingChars, 8_000),
      );
      return success(tool, {
        query: queryText,
        status: result.status,
        evidence,
        reasonCode: result.reasonCode ?? null,
      });
    }
    if (tool === MEMORY_LIST_TOPICS_V1) {
      const catalog = await loadTopics(signal);
      const topics = catalog.slice(0, Number(args.max_results)).map((item) => ({
        topicId: item.projection.topic.id,
        name: item.projection.topic.canonicalName,
        family: item.projection.topic.family,
        memberCount: item.projection.snapshot.memberMemoryIds.length,
        trajectoryCount: item.projection.snapshot.trajectories.length,
        projectionHash: item.projection.topic.projectionHash,
      }));
      return success(tool, { topics });
    }
    if (tool === MEMORY_READ_TOPIC_V1) {
      const catalog = await loadTopics(signal);
      const topicId = resolveMemoryTopicIdV1(
        String(args.topic_id),
        catalog.map((candidate) => candidate.projection.topic.id),
      );
      if (!topicId) throw namedError("MemoryTopicNotFound");
      const item = catalog.find(
        (candidate) => candidate.projection.topic.id === topicId,
      );
      if (!item) throw namedError("MemoryTopicNotFound");
      const dossier = await input.dossierStore?.getCurrent(topicId, signal);
      if (dossier) {
        if (
          dossier.topicId !== topicId ||
          dossier.projectionHash !== item.projection.topic.projectionHash ||
          dossier.scopeFingerprint !== item.projection.snapshot.scopeFingerprint
        ) {
          throw namedError("MemoryTopicDossierProjectionMismatch");
        }
        return success(tool, {
          topic: {
            topicId,
            name: item.projection.topic.canonicalName,
            family: item.projection.topic.family,
          },
          dossier: projectMemoryTopicDossierToolV1(
            dossier,
            Number(args.max_states),
            Math.min(remainingChars, 8_000),
          ),
        });
      }
      const states = projectMemoryTopicToolStatesV1(
        item,
        Number(args.max_states),
      );
      return success(tool, {
        topic: {
          topicId,
          name: item.projection.topic.canonicalName,
          family: item.projection.topic.family,
        },
        states: fitItems(states, Math.min(remainingChars, 8_000)),
      });
    }
    if (tool === MEMORY_SEARCH_CONVERSATION_V1) {
      if (!input.rawEvidenceArchive?.search) {
        throw namedError("MemoryConversationSearchUnavailable");
      }
      const spans = await input.rawEvidenceArchive.search(
        {
          query: String(args.query),
          maxSpans: Number(args.max_results),
          maxChars: Math.min(Number(args.max_chars), remainingChars, 8_000),
        },
        signal,
      );
      return success(tool, { query: String(args.query), spans });
    }
    if (!input.rawEvidenceArchive) {
      throw namedError("MemoryRawEvidenceUnavailable");
    }
    const refs = args.evidence_refs as readonly string[];
    const memoryIds = args.memory_ids as readonly string[];
    const spans = await input.rawEvidenceArchive.resolve(
      refs.map((evidenceRef) => ({ evidenceRef, memoryIds })),
      signal,
    );
    return success(tool, {
      spans: fitItems(
        spans,
        Math.min(Number(args.max_chars), remainingChars, 8_000),
      ),
    });
  }

  async function loadTopics(signal: AbortSignal) {
    if (!input.topicStore) throw namedError("MemoryTopicStoreUnavailable");
    topicCache ??= await input.topicStore.load(signal);
    return topicCache;
  }
}

function entry(
  internalName: MemoryToolEventV1["tool"],
  providerName: string,
  description: string,
  parameters: Readonly<Record<string, unknown>>,
  validate: RuntimeToolPluginEntryV1["validate"],
  scopeFingerprint: string,
): RuntimeToolPluginEntryV1 {
  const definition: ToolDefinition = {
    type: "function",
    function: { name: providerName, description, parameters },
  };
  return Object.freeze({
    internalName,
    providerName,
    definition,
    deferred: false,
    resultPolicy: "bounded_json",
    executionKind: "harness",
    validate,
    classify(_args: Readonly<Record<string, unknown>>, workspaceRoot: string) {
      const root = canonicalRuntimeResourcePathV1(workspaceRoot);
      return Object.freeze({
        lockDomain: root,
        effectClass: "read" as const,
        permissionCategory: "read" as const,
        concurrencyMode: "parallel" as const,
        resources: Object.freeze([
          Object.freeze({
            key: path.join(root, ".paw-memory", scopeFingerprint, "*"),
            access: "read" as const,
          }),
        ]),
      });
    },
  });
}

function validateSearchAtoms(args: unknown) {
  const record = exactArgs(args, ["query", "max_results"]);
  if (!record.ok) return record;
  const query = textArg(record.args.query, 8_192);
  const maxResults = intArg(record.args.max_results ?? 5, 1, 8);
  if (!query || maxResults === undefined)
    return invalid("memory.search_atoms arguments are invalid");
  return valid({ query, max_results: maxResults });
}

function validateResolveContext(args: unknown) {
  const record = exactArgs(args, ["query"]);
  if (!record.ok) return record;
  const query = textArg(record.args.query, 8_192);
  return !query
    ? invalid("memory.resolve_context arguments are invalid")
    : valid({ query });
}

function validateListTopics(args: unknown) {
  const record = exactArgs(args, ["max_results"]);
  if (!record.ok) return record;
  const maxResults = intArg(record.args.max_results ?? 32, 1, 64);
  return maxResults === undefined
    ? invalid("memory.list_topics arguments are invalid")
    : valid({ max_results: maxResults });
}

function validateReadTopic(args: unknown) {
  const record = exactArgs(args, ["topic_id", "max_states"]);
  if (!record.ok) return record;
  const topicId = textArg(record.args.topic_id, 256);
  const maxStates = intArg(record.args.max_states ?? 16, 1, 24);
  return !topicId || maxStates === undefined
    ? invalid("memory.read_topic arguments are invalid")
    : valid({ topic_id: topicId, max_states: maxStates });
}

function validateSearchConversation(args: unknown) {
  const record = exactArgs(args, ["query", "max_results", "max_chars"]);
  if (!record.ok) return record;
  const query = textArg(record.args.query, 512);
  const maxResults = intArg(record.args.max_results ?? 5, 1, 8);
  const maxChars = intArg(record.args.max_chars ?? 4_000, 256, 8_000);
  return !query || maxResults === undefined || maxChars === undefined
    ? invalid("memory.search_conversation arguments are invalid")
    : valid({ query, max_results: maxResults, max_chars: maxChars });
}

function validateReadEvidence(args: unknown) {
  const record = exactArgs(args, ["evidence_refs", "memory_ids", "max_chars"]);
  if (!record.ok) return record;
  const refs = stringArrayArg(record.args.evidence_refs, 8, 1_024);
  const memoryIds = stringArrayArg(record.args.memory_ids, 16, 256);
  const maxChars = intArg(record.args.max_chars ?? 4_000, 256, 8_000);
  return !refs || !memoryIds || maxChars === undefined
    ? invalid("memory.read_evidence arguments are invalid")
    : valid({
        evidence_refs: refs,
        memory_ids: memoryIds,
        max_chars: maxChars,
      });
}

/**
 * Canonicalize a model-returned topic reference only when it identifies one
 * exact catalog entry. Harmless quoting is accepted; invented or ambiguous
 * topic identities remain rejected.
 */
export function resolveMemoryTopicIdV1(
  candidate: string,
  knownTopicIds: readonly string[],
): string | undefined {
  const normalized = candidate.trim();
  if (!normalized) return undefined;
  if (knownTopicIds.includes(normalized)) return normalized;
  const embedded = knownTopicIds.filter((topicId) =>
    normalized.includes(topicId),
  );
  return embedded.length === 1 ? embedded[0] : undefined;
}

/**
 * Compact model-facing projection of the durable trajectory graph. Storage
 * keeps full relation IDs; the model receives stable ordinals and only the
 * fields needed to reason or request exact source evidence.
 */
export function projectMemoryTopicToolStatesV1(
  item: MemoryTopicEvidenceCatalogItemV1,
  maxStates: number,
): readonly Readonly<Record<string, unknown>>[] {
  const limit = boundedInteger(maxStates, 1, 24, "topic state budget");
  const entries = new Map(item.entries.map((entry) => [entry.id, entry]));
  return Object.freeze(
    item.projection.snapshot.trajectories
      .flatMap((trajectory, trajectoryIndex) =>
        trajectory.states.map((state, stateIndex) =>
          Object.freeze({
            trajectory: trajectoryIndex + 1,
            position: stateIndex + 1,
            stateCount: trajectory.states.length,
            memoryId: state.memoryId,
            status: state.status,
            statement: renderEntry(entries.get(state.memoryId)),
            validFrom: state.validFrom,
            ...(state.validTo === null ? {} : { validTo: state.validTo }),
            evidenceRefs: state.evidenceRefs,
          }),
        ),
      )
      .slice(0, limit),
  );
}

/** Bounded read projection; durable dossier bodies remain unchanged. */
export function projectMemoryTopicDossierToolV1(
  dossier: MemoryTopicDossierV1,
  maxItems: number,
  maxChars: number,
): Readonly<Record<string, unknown>> {
  const itemLimit = boundedInteger(
    maxItems,
    1,
    24,
    "topic dossier item budget",
  );
  const charLimit = boundedInteger(
    maxChars,
    1_024,
    8_000,
    "topic dossier char budget",
  );
  const currentConclusions: unknown[] = [];
  const evolutions: unknown[] = [];
  const conflicts: unknown[] = [];
  let accepted = 0;
  const base = {
    dossierId: dossier.id,
    coverage: dossier.coverage,
    currentConclusions,
    evolutions,
    conflicts,
  };
  const tryPush = (target: unknown[], candidate: unknown): void => {
    if (accepted >= itemLimit) return;
    target.push(candidate);
    if (canonicalJsonStringifyV1(base as never).length > charLimit) {
      target.pop();
      return;
    }
    accepted += 1;
  };
  for (const state of dossier.currentConclusions) {
    tryPush(currentConclusions, compactDossierState(state, 1_200));
  }
  for (const evolution of dossier.evolutions) {
    tryPush(evolutions, {
      relationId: evolution.relationId,
      previous: compactDossierState(evolution.previous, 700),
      current: compactDossierState(evolution.current, 700),
      evidenceRefs: evolution.evidenceRefs.slice(0, 8),
    });
  }
  for (const conflict of dossier.conflicts) {
    tryPush(conflicts, {
      relationId: conflict.relationId,
      left: compactDossierState(conflict.left, 700),
      right: compactDossierState(conflict.right, 700),
      resolutionStatus: conflict.resolutionStatus,
      evidenceRefs: conflict.evidenceRefs.slice(0, 8),
    });
  }
  return Object.freeze({
    ...base,
    currentConclusions: Object.freeze(currentConclusions),
    evolutions: Object.freeze(evolutions),
    conflicts: Object.freeze(conflicts),
    truncated:
      currentConclusions.length !== dossier.currentConclusions.length ||
      evolutions.length !== dossier.evolutions.length ||
      conflicts.length !== dossier.conflicts.length,
  });
}

function compactDossierState(
  state: MemoryTopicDossierStateV1,
  maxStatementChars: number,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    memoryId: state.memoryId,
    kind: state.kind,
    statement: state.statement.slice(0, maxStatementChars),
    validFrom: state.validFrom,
    ...(state.validTo === undefined ? {} : { validTo: state.validTo }),
    status: state.status,
    evidenceRefs: state.evidenceRefs.slice(0, 8),
  });
}

/** Keep one resolver call inside the same model-visible bound as other tools. */
export function projectMemoryResolvedContextToolV1(
  packet: MemoryResolvedContextPacketV1,
  maxChars: number,
): Readonly<Record<string, unknown>> {
  const limit = boundedInteger(
    maxChars,
    1_024,
    8_000,
    "resolved context character budget",
  );
  const requirements = packet.requirements.map((item) => ({
    ...item,
    description: item.description.slice(0, 512),
  }));
  const evidence = [
    ...fitItems(
      packet.evidence.map((item) => ({
        ...item,
        statement: item.statement.slice(0, 1_200),
        evidenceRefs: item.evidenceRefs.slice(0, 6),
      })),
      Math.max(512, Math.floor(limit * 0.25)),
    ),
  ];
  const topics = [
    ...fitItems(
      packet.topics.map((topic) => ({
        topicId: topic.topicId,
        name: topic.name,
        family: topic.family,
        dossierId: topic.dossierId,
        currentConclusions: topic.currentConclusions
          .slice(0, 6)
          .map((state) => compactDossierState(state, 700)),
        evolutions: topic.evolutions.slice(0, 3).map((evolution) => ({
          relationId: evolution.relationId,
          previous: compactDossierState(evolution.previous, 400),
          current: compactDossierState(evolution.current, 400),
          evidenceRefs: evolution.evidenceRefs.slice(0, 6),
        })),
        conflicts: topic.conflicts.slice(0, 2).map((conflict) => ({
          relationId: conflict.relationId,
          left: compactDossierState(conflict.left, 350),
          right: compactDossierState(conflict.right, 350),
          resolutionStatus: conflict.resolutionStatus,
          evidenceRefs: conflict.evidenceRefs.slice(0, 6),
        })),
      })),
      Math.max(512, Math.floor(limit * 0.3)),
    ),
  ];
  const spans = [
    ...fitItems(
      packet.spans.map((span) => ({
        ...span,
        content: span.content.slice(0, 1_600),
      })),
      Math.max(512, Math.floor(limit * 0.32)),
    ),
  ];
  const result: Record<string, unknown> = {
    schemaVersion: packet.schemaVersion,
    resolverVersion: packet.resolverVersion,
    packetRevision: packet.packetRevision,
    mode: packet.mode,
    stop: packet.stop,
    instruction:
      packet.stop === "sufficient"
        ? "Coverage is sufficient. Answer from this packet without another memory call."
        : "Coverage is incomplete. Use one focused lower-level memory call only if the missing evidence is necessary.",
    requirements,
    evidence,
    topics,
    spans,
  };
  while (canonicalJsonStringifyV1(result as never).length > limit) {
    if (topics.length > 0) topics.pop();
    else if (evidence.length > 0) evidence.pop();
    else if (spans.length > 0) spans.pop();
    else break;
  }
  return Object.freeze({
    ...result,
    requirements: Object.freeze(requirements),
    evidence: Object.freeze(evidence),
    topics: Object.freeze(topics),
    spans: Object.freeze(spans),
    truncated:
      evidence.length !== packet.evidence.length ||
      topics.length !== packet.topics.length ||
      spans.length !== packet.spans.length,
  });
}

function toolQuery(
  text: string,
  maxCards: number,
  profile: PawNextMemoryPluginProfileV1,
): MemoryProviderQueryV1 {
  const inputContentHash = hashTextV1(text);
  const searchTexts = createMemorySearchTextsV1(undefined, text);
  const queryId = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-tool-query.v1",
    inputContentHash,
    providerVersion: profile.providerVersion,
    scopeFingerprint: memoryScopeFingerprintV1(profile.scope),
    maxCards,
    searchTexts,
  } as unknown as JsonValue);
  return Object.freeze({
    queryId,
    trigger: "task_start",
    text,
    searchTexts,
    inputId: `memory-tool:${queryId.slice(0, 24)}`,
    inputContentHash,
    scope: profile.scope,
    maxCards,
    maxInjectedTokens: profile.maxInjectedTokens,
  });
}

function renderEntry(entry: MemoryEntry | undefined): string {
  if (!entry) return "[memory body unavailable]";
  if (entry.kind === "semantic") return entry.fact;
  if (entry.kind === "profile") return entry.insight;
  if (entry.kind === "episodic") {
    return [entry.whenToUse, entry.perspective, ...entry.modification]
      .filter(Boolean)
      .join("\n");
  }
  return "[vault reference omitted]";
}

function success(
  tool: string,
  payload: Record<string, unknown>,
): ToolRunResult {
  return Object.freeze({
    ok: true,
    summary: `${tool}: completed`,
    payload: Object.freeze({
      schemaVersion: "paw.memory-tool-result.v1",
      tool,
      cacheHit: false,
      ...payload,
    }),
  });
}

function withCacheHit(result: ToolRunResult): ToolRunResult {
  const payload =
    result.payload &&
    typeof result.payload === "object" &&
    !Array.isArray(result.payload)
      ? { ...(result.payload as Record<string, unknown>), cacheHit: true }
      : result.payload;
  return Object.freeze({ ...result, payload: Object.freeze(payload) });
}

function fitItems<T>(items: readonly T[], maxChars: number): readonly T[] {
  const output: T[] = [];
  let used = 2;
  for (const item of items) {
    const chars =
      canonicalJsonStringifyV1(item as never).length +
      (output.length > 0 ? 1 : 0);
    if (used + chars > maxChars) break;
    output.push(item);
    used += chars;
  }
  return Object.freeze(output);
}

function exactArgs(
  value: unknown,
  allowed: readonly string[],
):
  | { readonly ok: true; readonly args: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly result: ToolRunResult } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("memory tool arguments must be an object");
  }
  const args = value as Record<string, unknown>;
  if (Object.keys(args).some((key) => !allowed.includes(key))) {
    return invalid("memory tool arguments contain unknown fields");
  }
  return { ok: true, args };
}

function valid(args: Record<string, unknown>) {
  return { ok: true as const, args: Object.freeze(args) };
}

function invalid(message: string) {
  return {
    ok: false as const,
    result: Object.freeze({
      ok: false,
      summary: message,
      payload: Object.freeze({ code: "E_SCHEMA_INVALID", executed: false }),
    }),
  };
}

function textArg(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function intArg(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
    ? Number(value)
    : undefined;
}

function stringArrayArg(
  value: unknown,
  maximumItems: number,
  maximumChars: number,
): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximumItems
  ) {
    return undefined;
  }
  const items = value.map((item) => textArg(item, maximumChars));
  if (items.some((item) => item === undefined)) return undefined;
  return Object.freeze([...new Set(items as string[])]);
}

function assertScope(
  actual: PawNextMemoryPluginProfileV1["scope"] | undefined,
  profile: PawNextMemoryPluginProfileV1,
  label: string,
): void {
  if (!actual) return;
  const expected = profile.scope;
  if (
    actual.tenantId !== expected.tenantId ||
    actual.userId !== expected.userId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId
  ) {
    throw new Error(`Memory ${label} scope mismatch`);
  }
}

function failureSettlement(
  callId: string,
  reasonCode: string,
): ToolSettlement<ToolRunResult> {
  const result = Object.freeze({
    ok: false,
    summary: reasonCode,
    payload: Object.freeze({ code: reasonCode, executed: false }),
  });
  return Object.freeze({
    status: "failed",
    callId,
    error: Object.freeze({ name: reasonCode, message: reasonCode }),
    evidence: result,
  });
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Memory tool ${label} is invalid`);
  }
  return value;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function stableErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return (
    `MemoryTool_${name}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160) ||
    "MemoryTool_Unknown"
  );
}

function emit(
  observer: ((event: MemoryToolEventV1) => void) | undefined,
  event: MemoryToolEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Content-free telemetry cannot affect memory evidence.
  }
}
