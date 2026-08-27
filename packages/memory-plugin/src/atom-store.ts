import {
  type MemoryEntry,
  type MemorySource,
  type MemoryStoreEngine,
  PostgresMemoryStoreEngine,
  deriveEntryId,
} from "@paw/memory/longterm";
import type { MemoryAtomProposalV1 } from "@paw/protocol";

import type { MemoryConflictCandidateV1 } from "./atom-extractor.js";
import type { PawNextMemoryScopeV1 } from "./profile.js";
import { freezePawNextMemoryPluginProfileV1 } from "./profile.js";
import {
  type MemoryTemporalGraphEventV1,
  type MemoryTemporalGraphStoreV1,
  createMemoryTemporalRelationV1,
  createPostgresMemoryTemporalGraphStoreV1,
} from "./temporal-graph.js";

export interface MemoryAtomStoreApplyInputV1 {
  readonly writeId: string;
  readonly runId: string;
  readonly repositoryId: string;
  readonly claimedAt: number;
  readonly atoms: readonly MemoryAtomProposalV1[];
}

export interface MemoryAtomStoreApplyResultV1 {
  readonly storedIds: readonly string[];
  readonly invalidatedIds: readonly string[];
  readonly skippedAtomIds: readonly string[];
}

export interface MemoryAtomWriterStoreV1 {
  recall(
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly MemoryConflictCandidateV1[]>;
  apply(
    input: MemoryAtomStoreApplyInputV1,
    signal: AbortSignal,
  ): Promise<MemoryAtomStoreApplyResultV1>;
}

export interface MemoryAtomSourceRefInputV1 {
  readonly runId: string;
  readonly atomId: string;
  readonly sourceSeq: number;
}

export function createPawNextPostgresMemoryAtomWriterStoreV1(
  profile: import("./profile.js").PawNextMemoryPluginProfileV1,
  options: Readonly<{
    onTemporalGraphEvent?: (event: MemoryTemporalGraphEventV1) => void;
  }> = {},
): MemoryAtomWriterStoreV1 {
  const frozen = freezePawNextMemoryPluginProfileV1(profile);
  if (frozen.mode !== "read_write" || !frozen.writer) {
    throw new Error("Postgres memory atom writer requires read-write mode");
  }
  return createMemoryAtomWriterStoreV1({
    engine: new PostgresMemoryStoreEngine(frozen.scope),
    scope: frozen.scope,
    temporalGraph: createPostgresMemoryTemporalGraphStoreV1({
      scope: frozen.scope,
      ...(options.onTemporalGraphEvent
        ? { onEvent: options.onTemporalGraphEvent }
        : {}),
    }),
  });
}

export function createMemoryAtomWriterStoreV1(input: {
  readonly engine: MemoryStoreEngine;
  readonly scope: PawNextMemoryScopeV1;
  readonly sourceRef?: (input: MemoryAtomSourceRefInputV1) => string;
  readonly temporalGraph?: MemoryTemporalGraphStoreV1;
}): MemoryAtomWriterStoreV1 {
  assertScopedEngine(input.engine, input.scope);
  if (input.temporalGraph) {
    assertExactScope(input.temporalGraph.scope, input.scope);
  }
  return Object.freeze({
    async recall(
      query: string,
      limit: number,
      signal: AbortSignal,
    ): Promise<readonly MemoryConflictCandidateV1[]> {
      if (signal.aborted) throw abortError();
      const boundedLimit = Math.max(1, Math.min(limit, 32));
      const boundedQuery = query.slice(0, 8_192);
      const [lexical, vector] = await Promise.all([
        input.engine
          .searchText(boundedQuery, boundedLimit, input.scope.repositoryId)
          .catch(() => []),
        input.engine
          .searchVector(boundedQuery, boundedLimit, input.scope.repositoryId)
          .catch(() => []),
      ]);
      const fused = new Map<string, number>();
      for (const [weight, ranked] of [
        [1, lexical] as const,
        [1, vector] as const,
      ]) {
        ranked.forEach((item, index) => {
          fused.set(
            item.id,
            (fused.get(item.id) ?? 0) + weight / (60 + index + 1),
          );
        });
      }
      const ids = [...fused.entries()]
        .sort(
          ([leftId, leftScore], [rightId, rightScore]) =>
            rightScore - leftScore || leftId.localeCompare(rightId),
        )
        .slice(0, boundedLimit)
        .map(([id, score]) => ({ id, score }));
      if (signal.aborted) throw abortError();
      const rows = await Promise.all(
        ids.map((item) => input.engine.get(item.id)),
      );
      const candidates = rows.flatMap((entry) => {
        if (
          !entry ||
          entry.tInvalid !== null ||
          (entry.kind !== "semantic" &&
            entry.kind !== "episodic" &&
            entry.kind !== "profile")
        ) {
          return [];
        }
        return [
          Object.freeze({
            id: entry.id,
            kind: entry.kind,
            statement: renderEntry(entry).slice(0, 4_096),
            source: entry.source,
            confidence: clamp(entry.confidence),
            validFrom: entry.tValid,
            ...(entry.tInvalid === null ? {} : { validTo: entry.tInvalid }),
          }),
        ];
      });
      return Object.freeze(candidates);
    },
    async apply(
      applyInput: MemoryAtomStoreApplyInputV1,
      signal: AbortSignal,
    ): Promise<MemoryAtomStoreApplyResultV1> {
      if (applyInput.repositoryId !== input.scope.repositoryId) {
        throw new Error("Memory atom write repository scope mismatch");
      }
      const storedIds: string[] = [];
      const invalidatedIds: string[] = [];
      const skippedAtomIds: string[] = [];
      const writtenAt = new Date(applyInput.claimedAt).toISOString();
      for (const atom of applyInput.atoms) {
        if (signal.aborted) throw abortError();
        if (atom.action === "skip") {
          skippedAtomIds.push(atom.atomId);
          continue;
        }
        const entry = atomToEntry(atom, {
          runId: applyInput.runId,
          repositoryId: applyInput.repositoryId,
          writtenAt,
          scope: input.scope,
          ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        });
        const id = entry.id;
        const existing = await input.engine.get(id);
        if (!existing) await input.engine.put(entry);
        storedIds.push(id);

        // Put replacement first. A crash can leave both active, but never loses the
        // old evidence; replay then deterministically completes invalidation.
        for (const targetId of atom.targetIds) {
          if (targetId === id) continue;
          const target = await input.engine.get(targetId);
          if (!target) {
            throw new Error(
              "Memory atom target is missing from the scoped store",
            );
          }
          await input.engine.invalidate(targetId, writtenAt);
          invalidatedIds.push(targetId);
        }
        if (input.temporalGraph) {
          const relations = atom.targetIds
            .filter((targetId) => targetId !== id)
            .map((targetId) =>
              createMemoryTemporalRelationV1({
                scope: input.scope,
                fromMemoryId: id,
                toMemoryId: targetId,
                relationType: "supersedes",
                sourceRefs: [
                  `write:${applyInput.writeId}`,
                  `run:${applyInput.runId}`,
                  `atom:${atom.atomId}`,
                ],
                evidenceRefs: entry.evidence,
                createdAt: writtenAt,
              }),
            );
          if (relations.length > 0) {
            // The relation write is deterministic. If it fails after invalidation,
            // the journal keeps the write unsettled and replay repairs the graph.
            await input.temporalGraph.put(relations, signal);
          }
        }
      }
      return Object.freeze({
        storedIds: Object.freeze([...new Set(storedIds)]),
        invalidatedIds: Object.freeze([...new Set(invalidatedIds)]),
        skippedAtomIds: Object.freeze([...new Set(skippedAtomIds)]),
      });
    },
  });
}

function atomToEntry(
  atom: MemoryAtomProposalV1,
  context: Readonly<{
    runId: string;
    repositoryId: string;
    writtenAt: string;
    scope: PawNextMemoryScopeV1;
    sourceRef?: (input: MemoryAtomSourceRefInputV1) => string;
  }>,
): MemoryEntry {
  const evidence = atom.sourceSeqs.map((seq) =>
    context.sourceRef
      ? context.sourceRef({
          runId: context.runId,
          atomId: atom.atomId,
          sourceSeq: seq,
        })
      : `journal:${context.runId}#input-fact-${seq}`,
  );
  const common = {
    id: "",
    repo: context.repositoryId,
    created: context.writtenAt,
    tValid: atom.validFrom ?? context.writtenAt,
    tInvalid: atom.validTo ?? null,
    source: authorityToSource(atom.authority),
    confidence: clamp(atom.confidence),
    evidence,
    freq: 0,
    utility: 0,
  } as const;
  let entry: MemoryEntry;
  if (atom.kind === "profile") {
    entry = {
      ...common,
      kind: "profile",
      insight: atom.statement,
      supportCount: evidence.length,
    };
  } else if (atom.kind === "episodic") {
    entry = {
      ...common,
      kind: "episodic",
      whenToUse: `When prior work relates to: ${atom.keywords.join(", ") || atom.statement.slice(0, 160)}`,
      perspective: atom.statement,
      modification: [],
      issueType: "memory_atom",
      taskId: context.runId,
    };
  } else {
    const keywords =
      atom.kind === "instruction"
        ? [...new Set(["instruction", ...atom.keywords])]
        : [...atom.keywords];
    entry = {
      ...common,
      kind: "semantic",
      fact: atom.statement,
      keywords,
      embeddingKey: [atom.statement, ...keywords].join(" "),
    };
  }
  return Object.freeze({
    ...entry,
    id: deriveEntryId(entry, context.scope),
  }) as MemoryEntry;
}

function authorityToSource(
  authority: MemoryAtomProposalV1["authority"],
): MemorySource {
  if (authority === "user_asserted") return "user_statement";
  if (authority === "agent_verified") return "agent_verified";
  return "agent_inferred";
}

function renderEntry(
  entry: Extract<MemoryEntry, { kind: "semantic" | "episodic" | "profile" }>,
): string {
  if (entry.kind === "semantic") return entry.fact;
  if (entry.kind === "profile") return entry.insight;
  return [entry.whenToUse, entry.perspective, ...entry.modification].join("\n");
}

function assertScopedEngine(
  engine: MemoryStoreEngine,
  scope: PawNextMemoryScopeV1,
): void {
  if (!engine.scope || !sameScope(engine.scope, scope)) {
    throw new Error("Memory atom writer requires an exactly scoped engine");
  }
}

function assertExactScope(
  actual: PawNextMemoryScopeV1,
  expected: PawNextMemoryScopeV1,
): void {
  if (!sameScope(actual, expected)) {
    throw new Error("Memory temporal graph requires an exactly scoped store");
  }
}

function sameScope(
  left: PawNextMemoryScopeV1,
  right: PawNextMemoryScopeV1,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.workspaceId === right.workspaceId &&
    left.repositoryId === right.repositoryId
  );
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function abortError(): Error {
  const error = new Error("Memory atom store operation aborted");
  error.name = "AbortError";
  return error;
}
