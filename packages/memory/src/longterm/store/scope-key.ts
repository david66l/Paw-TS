import { createHash } from "node:crypto";

/** Commercial memory isolation boundary. Every field is part of identity. */
export interface MemoryScopeKey {
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
}

function normalizePart(name: keyof MemoryScopeKey, value: string): string {
  const normalized = value.trim();
  const containsControl = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (normalized.length === 0 || normalized.length > 256 || containsControl) {
    throw new Error(`Invalid memory scope ${name}`);
  }
  return normalized;
}

export function createMemoryScopeKey(input: MemoryScopeKey): MemoryScopeKey {
  return Object.freeze({
    tenantId: normalizePart("tenantId", input.tenantId),
    userId: normalizePart("userId", input.userId),
    workspaceId: normalizePart("workspaceId", input.workspaceId),
    repositoryId: normalizePart("repositoryId", input.repositoryId),
  });
}

export function sameMemoryScope(a: MemoryScopeKey, b: MemoryScopeKey): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.userId === b.userId &&
    a.workspaceId === b.workspaceId &&
    a.repositoryId === b.repositoryId
  );
}

/** Stable namespace for IDs, workers, and metrics; never used as authorization alone. */
export function memoryScopeFingerprint(scope: MemoryScopeKey): string {
  return createHash("sha256")
    .update(
      `${scope.tenantId}\n${scope.userId}\n${scope.workspaceId}\n${scope.repositoryId}`,
    )
    .digest("hex")
    .slice(0, 20);
}
