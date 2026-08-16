/**
 * Shared test fixtures for `@paw/core`.
 */

import type { LegacyMemoryRecordV1 } from "@paw/protocol";

export function makeRecord(
  overrides: Partial<LegacyMemoryRecordV1> = {},
): LegacyMemoryRecordV1 {
  return {
    id: "test",
    source: "auto",
    scope: "project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: "Test",
    summary: "Summary",
    content: "Content",
    tags: [],
    relatedFiles: [],
    relatedErrors: [],
    priority: "mid",
    toolsUsed: [],
    validUntil: 0,
    linkedMemories: [],
    ...overrides,
  };
}

export function fakeEmbedding(seed: number, dims = 64): number[] {
  const rng = (s: number) => {
    const x = Math.sin(s * 9301 + 49297) * 49297;
    return x - Math.floor(x);
  };
  return Array.from({ length: dims }, (_, i) => rng(seed + i * 0.1) * 2 - 1);
}
