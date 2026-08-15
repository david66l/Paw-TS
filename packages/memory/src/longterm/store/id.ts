/**
 * 内容哈希派生 id（spec v2 §4.2）
 *
 * id = `<kind>-<sha256(kind + 规范化正文 + repo) 前 16 位 hex>`。
 * 同内容（同 kind、同规范化正文、同 repo）重复写入得到同一 id，
 * 配合 put 的 upsert 语义实现天然幂等（Governor 裁决前的免费第一道去重）。
 */

import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryKind } from "./engine.js";
import {
  memoryScopeFingerprint,
  type MemoryScopeKey,
} from "./scope-key.js";

/** 正文规范化：小写 + 折叠空白 + trim，消除无意义差异 */
export function normalizeBody(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** 各 kind 参与哈希的正文（不含 id/时间戳/账本等派生字段） */
export function canonicalBody(entry: MemoryEntry): string {
  switch (entry.kind) {
    case "semantic":
      return entry.fact;
    case "episodic":
      return [entry.whenToUse, entry.perspective, ...entry.modification].join("\n");
    case "profile":
      return entry.insight;
    case "vault_ref":
      return entry.refDescription;
  }
}

export function deriveMemoryId(
  kind: MemoryKind,
  body: string,
  repo: string,
  scope?: MemoryScopeKey,
): string {
  const hex = createHash("sha256")
    .update(
      `${kind}\n${normalizeBody(body)}\n${normalizeBody(repo)}${scope ? `\n${memoryScopeFingerprint(scope)}` : ""}`,
    )
    .digest("hex")
    .slice(0, 16);
  return `${kind}-${hex}`;
}

/** 从条目直接派生 id */
export function deriveEntryId(
  entry: MemoryEntry,
  scope?: MemoryScopeKey,
): string {
  return deriveMemoryId(entry.kind, canonicalBody(entry), entry.repo, scope);
}
