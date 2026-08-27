import { createHash } from "node:crypto";

import type { MemoryEntry } from "@paw/memory/longterm";

import type { MemoryTemporalRelationV1 } from "./temporal-graph.js";

export const PAW_MEMORY_TRAJECTORY_PROJECTOR_VERSION_V1 =
  "paw.memory-trajectory-projector.v1" as const;

export interface MemoryTrajectoryStateV1 {
  readonly memoryId: string;
  readonly kind: MemoryEntry["kind"];
  readonly source: MemoryEntry["source"];
  readonly evidenceRefs: readonly string[];
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly status: "current" | "historical";
  readonly supersedesMemoryIds: readonly string[];
  readonly supersededByMemoryIds: readonly string[];
}

export interface MemoryTrajectoryV1 {
  readonly schemaVersion: typeof PAW_MEMORY_TRAJECTORY_PROJECTOR_VERSION_V1;
  readonly trajectoryId: string;
  readonly stateCount: number;
  readonly sourceCount: number;
  readonly truncated: boolean;
  /** Oldest to newest within the retained window. */
  readonly states: readonly MemoryTrajectoryStateV1[];
}

/**
 * Projects relation-grounded, cross-source version trajectories without an LLM.
 * The projector does not guess topic similarity: only explicit supersedes edges
 * can join otherwise independent memories into one trajectory.
 */
export function projectMemoryTrajectoriesV1(
  input: Readonly<{
    entries: readonly MemoryEntry[];
    relations: readonly MemoryTemporalRelationV1[];
    maxTrajectories?: number;
    maxStatesPerTrajectory?: number;
    includeSingletons?: boolean;
  }>,
): readonly MemoryTrajectoryV1[] {
  const maxTrajectories = bounded(
    input.maxTrajectories ?? 64,
    1,
    512,
    "MemoryTrajectoryCountInvalid",
  );
  const maxStates = bounded(
    input.maxStatesPerTrajectory ?? 32,
    2,
    256,
    "MemoryTrajectoryStateCountInvalid",
  );
  const entries = new Map<string, MemoryEntry>();
  for (const entry of input.entries) {
    if (
      !entry.id.trim() ||
      entries.has(entry.id) ||
      !validIso(entry.created) ||
      !validIso(entry.tValid) ||
      (entry.tInvalid !== null && !validIso(entry.tInvalid))
    ) {
      throw namedError("MemoryTrajectoryEntryInvalid");
    }
    entries.set(entry.id, entry);
  }

  const newerToOlder = new Map<string, Set<string>>();
  const olderToNewer = new Map<string, Set<string>>();
  const neighbors = new Map<string, Set<string>>();
  for (const relation of input.relations) {
    if (
      relation.status !== "active" ||
      relation.relationType !== "supersedes"
    ) {
      continue;
    }
    if (
      !entries.has(relation.fromMemoryId) ||
      !entries.has(relation.toMemoryId)
    ) {
      throw namedError("MemoryTrajectoryDanglingRelation");
    }
    add(newerToOlder, relation.fromMemoryId, relation.toMemoryId);
    add(olderToNewer, relation.toMemoryId, relation.fromMemoryId);
    add(neighbors, relation.fromMemoryId, relation.toMemoryId);
    add(neighbors, relation.toMemoryId, relation.fromMemoryId);
  }
  assertAcyclic(newerToOlder, entries.keys());

  if (input.includeSingletons) {
    for (const id of entries.keys()) {
      if (!neighbors.has(id)) neighbors.set(id, new Set());
    }
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const root of [...neighbors.keys()].sort()) {
    if (visited.has(root)) continue;
    const component: string[] = [];
    const pending = [root];
    visited.add(root);
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined) continue;
      component.push(id);
      for (const neighbor of [...(neighbors.get(id) ?? [])].sort().reverse()) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
    components.push(component);
  }

  return Object.freeze(
    components
      .map((ids) => {
        const ordered = ids.sort((left, right) =>
          compareEntries(
            requiredEntry(entries, left),
            requiredEntry(entries, right),
          ),
        );
        const retained = ordered.slice(Math.max(0, ordered.length - maxStates));
        const states = retained.map((id) => {
          const entry = requiredEntry(entries, id);
          return Object.freeze({
            memoryId: id,
            kind: entry.kind,
            source: entry.source,
            evidenceRefs: Object.freeze([...entry.evidence].sort()),
            validFrom: entry.tValid,
            validTo: entry.tInvalid,
            status: entry.tInvalid === null ? "current" : "historical",
            supersedesMemoryIds: frozenSorted(newerToOlder.get(id)),
            supersededByMemoryIds: frozenSorted(olderToNewer.get(id)),
          }) satisfies MemoryTrajectoryStateV1;
        });
        const sources = new Set(
          ordered.map((id) => requiredEntry(entries, id).source),
        );
        const trajectoryId = createHash("sha256")
          .update(PAW_MEMORY_TRAJECTORY_PROJECTOR_VERSION_V1)
          .update("\n")
          .update([...ordered].sort().join("\n"))
          .digest("hex");
        return Object.freeze({
          schemaVersion: PAW_MEMORY_TRAJECTORY_PROJECTOR_VERSION_V1,
          trajectoryId,
          stateCount: ordered.length,
          sourceCount: sources.size,
          truncated: retained.length !== ordered.length,
          states: Object.freeze(states),
        }) satisfies MemoryTrajectoryV1;
      })
      .sort((left, right) => {
        const leftTime = left.states.at(-1)?.validFrom ?? "";
        const rightTime = right.states.at(-1)?.validFrom ?? "";
        return (
          rightTime.localeCompare(leftTime) ||
          left.trajectoryId.localeCompare(right.trajectoryId)
        );
      })
      .slice(0, maxTrajectories),
  );
}

function validIso(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function requiredEntry(
  entries: ReadonlyMap<string, MemoryEntry>,
  id: string,
): MemoryEntry {
  const entry = entries.get(id);
  if (!entry) throw namedError("MemoryTrajectoryEntryMissing");
  return entry;
}

function assertAcyclic(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  ids: Iterable<string>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw namedError("MemoryTrajectoryCycleDetected");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of graph.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function frozenSorted(
  values: ReadonlySet<string> | undefined,
): readonly string[] {
  return Object.freeze([...(values ?? [])].sort());
}

function compareEntries(left: MemoryEntry, right: MemoryEntry): number {
  return (
    Date.parse(left.tValid) - Date.parse(right.tValid) ||
    Date.parse(left.created) - Date.parse(right.created) ||
    left.id.localeCompare(right.id)
  );
}

function bounded(
  value: number,
  min: number,
  max: number,
  error: string,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw namedError(error);
  }
  return value;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
