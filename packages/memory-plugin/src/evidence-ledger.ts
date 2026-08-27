import type { JsonValue } from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";

const EVIDENCE_LIST_KEYS = Object.freeze([
  "evidence",
  "topics",
  "states",
  "spans",
] as const);

export interface MemoryEvidenceLedgerProjectionV1 {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly newItems: number;
  readonly repeatedItems: number;
  readonly totalDistinctItems: number;
}

export interface MemoryEvidenceLedgerV1 {
  project(
    tool: string,
    payload: Readonly<Record<string, unknown>>,
  ): MemoryEvidenceLedgerProjectionV1;
}

/**
 * Session-local evidence delta projector. It never persists content or changes
 * retrieval; it only prevents identical evidence from being paid for and
 * reconsidered across overlapping memory tool calls in the same model loop.
 */
export function createMemoryEvidenceLedgerV1(): MemoryEvidenceLedgerV1 {
  const seen = new Set<string>();
  return Object.freeze({
    project(tool: string, payload: Readonly<Record<string, unknown>>) {
      const listKey = EVIDENCE_LIST_KEYS.find((key) =>
        Array.isArray(payload[key]),
      );
      if (!listKey) {
        return Object.freeze({
          payload,
          newItems: 0,
          repeatedItems: 0,
          totalDistinctItems: seen.size,
        });
      }
      const values = payload[listKey] as readonly unknown[];
      const fresh: unknown[] = [];
      let repeatedItems = 0;
      for (const value of values) {
        const identity = evidenceIdentityV1(tool, listKey, value);
        if (seen.has(identity)) {
          repeatedItems += 1;
          continue;
        }
        seen.add(identity);
        fresh.push(value);
      }
      const projected = Object.freeze({
        ...payload,
        [listKey]: Object.freeze(fresh),
        evidenceLedger: Object.freeze({
          schemaVersion: "paw.memory-evidence-ledger.v1",
          newItems: fresh.length,
          repeatedItems,
          totalDistinctItems: seen.size,
          ...(fresh.length === 0 && repeatedItems > 0
            ? {
                guidance:
                  "No new evidence was returned; use prior evidence or choose a materially different read.",
              }
            : {}),
        }),
      });
      return Object.freeze({
        payload: projected,
        newItems: fresh.length,
        repeatedItems,
        totalDistinctItems: seen.size,
      });
    },
  });
}

function evidenceIdentityV1(
  tool: string,
  listKey: (typeof EVIDENCE_LIST_KEYS)[number],
  value: unknown,
): string {
  const item = record(value);
  const stable =
    listKey === "evidence"
      ? text(item?.memoryId)
      : listKey === "topics"
        ? text(item?.topicId)
        : listKey === "states"
          ? [
              text(item?.topicId),
              text(item?.memoryId),
              text(item?.status ?? item?.state),
              text(item?.validFrom),
              text(item?.validTo),
            ]
              .filter(Boolean)
              .join("\n")
          : [text(item?.evidenceRef), text(item?.contentHash)]
              .filter(Boolean)
              .join("\n");
  if (stable) return `${listKey}:${stable}`;
  return `${tool}:${listKey}:${hashCanonicalJsonV1(value as JsonValue)}`;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
