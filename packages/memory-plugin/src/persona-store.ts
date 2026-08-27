import {
  type MemoryEntry,
  type MemoryStoreEngine,
  PostgresMemoryStoreEngine,
} from "@paw/memory/longterm";

import type { PawNextMemoryScopeV1 } from "./profile.js";

export interface MemoryPersonaStoreV1 {
  readonly scope: PawNextMemoryScopeV1;
  load(signal: AbortSignal): Promise<readonly MemoryEntry[]>;
}

export interface MemoryPersonaStoreEventV1 {
  readonly schemaVersion: "paw.memory-persona-store-event.v1";
  readonly type: "load";
  readonly entryCount: number;
  readonly durationMs: number;
}

export function createPostgresMemoryPersonaStoreV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    engine?: MemoryStoreEngine;
    onEvent?: (event: MemoryPersonaStoreEventV1) => void;
  }>,
): MemoryPersonaStoreV1 {
  const scope = Object.freeze({ ...input.scope });
  const engine = input.engine ?? new PostgresMemoryStoreEngine(scope);
  assertScopedEngine(engine, scope);
  return Object.freeze({
    scope,
    async load(signal: AbortSignal) {
      const started = Date.now();
      if (signal.aborted) throw abortError();
      const profiles = await engine.query({
        kind: "profile",
        repo: scope.repositoryId,
        includeInvalidated: false,
        includeDegraded: false,
        limit: 256,
      });
      if (signal.aborted) throw abortError();
      const entries = profiles.filter(
        (entry) =>
          entry.repo === scope.repositoryId &&
          entry.tInvalid === null &&
          entry.kind === "profile",
      );
      emit(input.onEvent, {
        schemaVersion: "paw.memory-persona-store-event.v1",
        type: "load",
        entryCount: entries.length,
        durationMs: Date.now() - started,
      });
      return Object.freeze(entries);
    },
  });
}

function assertScopedEngine(
  engine: MemoryStoreEngine,
  scope: PawNextMemoryScopeV1,
): void {
  if (
    !engine.scope ||
    engine.scope.tenantId !== scope.tenantId ||
    engine.scope.userId !== scope.userId ||
    engine.scope.workspaceId !== scope.workspaceId ||
    engine.scope.repositoryId !== scope.repositoryId
  ) {
    throw namedError("MemoryPersonaEngineScopeMismatch");
  }
}

function emit(
  observer: ((event: MemoryPersonaStoreEventV1) => void) | undefined,
  event: MemoryPersonaStoreEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Content-free observability cannot affect evidence loading.
  }
}

function abortError(): Error {
  const error = new Error("Memory persona store operation aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
