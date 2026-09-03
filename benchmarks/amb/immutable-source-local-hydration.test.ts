import { describe, expect, test } from "bun:test";

import type { MemorySourceLocalHydratedEvidenceV1 } from "@paw/memory-plugin";

import {
  type AmbImmutableSourceLocalHydrationPortV1,
  hydrateAmbImmutableSourceLocalEvidenceV1,
} from "./immutable-source-local-hydration.js";

function row(
  evidenceRef: string,
  turnOrder: number,
): MemorySourceLocalHydratedEvidenceV1 {
  return Object.freeze({
    evidenceRef,
    sourceKind: turnOrder % 2 === 0 ? "assistant_output" : "user_input",
    turnOrder,
    observedAt: "2025-04-10T00:00:00.000Z",
    content: `immutable turn ${turnOrder}`,
    contentHash: "a".repeat(64),
  });
}

describe("AMB immutable source-local hydration", () => {
  test("uses current aliases first and maps legacy archive addresses without reindexing", async () => {
    const rows = new Map([
      [
        "amb:document/session-a#source-1",
        row("amb:document/session-a#source-1", 1),
      ],
      [
        "amb:document/session-b#atom-2",
        row("amb:document/session-b#atom-2", 2),
      ],
    ]);
    const calls: string[][] = [];
    const archive: AmbImmutableSourceLocalHydrationPortV1 = {
      async hydrate(evidenceRefs) {
        calls.push([...evidenceRefs]);
        return evidenceRefs.flatMap((evidenceRef) => {
          const found = rows.get(evidenceRef);
          return found ? [found] : [];
        });
      },
    };
    const result = await hydrateAmbImmutableSourceLocalEvidenceV1({
      archive,
      evidenceRefs: ["session-a#source-1", "session-b#source-2"],
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([
      ["amb:document/session-a#source-1", "amb:document/session-b#source-2"],
      ["amb:document/session-b#atom-2"],
    ]);
    expect(result.rows.map((item) => item.evidenceRef)).toEqual([
      "session-a#source-1",
      "session-b#source-2",
    ]);
    expect(result.directCount).toBe(1);
    expect(result.legacyMappedCount).toBe(1);
  });

  test("batches exact immutable reads above the archive port limit", async () => {
    const calls: string[][] = [];
    const archive: AmbImmutableSourceLocalHydrationPortV1 = {
      async hydrate(evidenceRefs) {
        calls.push([...evidenceRefs]);
        return evidenceRefs.map((evidenceRef, index) =>
          row(evidenceRef, calls.length === 1 ? index + 1 : index + 65),
        );
      },
    };
    const result = await hydrateAmbImmutableSourceLocalEvidenceV1({
      archive,
      evidenceRefs: Array.from(
        { length: 65 },
        (_, index) => `session-a#source-${index + 1}`,
      ),
      signal: new AbortController().signal,
    });
    expect(calls.map((call) => call.length)).toEqual([64, 1]);
    expect(result.rows).toHaveLength(65);
    expect(result.directCount).toBe(65);
  });

  test("fails closed on missing or out-of-partition archive rows", async () => {
    const missing: AmbImmutableSourceLocalHydrationPortV1 = {
      async hydrate() {
        return [];
      },
    };
    await expect(
      hydrateAmbImmutableSourceLocalEvidenceV1({
        archive: missing,
        evidenceRefs: ["session-a#source-1"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("AmbImmutableSourceLocalHydrationIncomplete");

    const outOfPartition: AmbImmutableSourceLocalHydrationPortV1 = {
      async hydrate() {
        return [row("amb:document/other#source-1", 1)];
      },
    };
    await expect(
      hydrateAmbImmutableSourceLocalEvidenceV1({
        archive: outOfPartition,
        evidenceRefs: ["session-a#source-1"],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("AmbImmutableSourceLocalHydrationPartitionInvalid");
  });

  test("rejects a row borrowed from a different hydration batch", async () => {
    let callCount = 0;
    const archive: AmbImmutableSourceLocalHydrationPortV1 = {
      async hydrate(evidenceRefs) {
        callCount += 1;
        if (callCount === 1) {
          return [row("amb:document/session-a#source-65", 65)];
        }
        return evidenceRefs.map((evidenceRef) => row(evidenceRef, 65));
      },
    };
    await expect(
      hydrateAmbImmutableSourceLocalEvidenceV1({
        archive,
        evidenceRefs: Array.from(
          { length: 65 },
          (_, index) => `session-a#source-${index + 1}`,
        ),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("AmbImmutableSourceLocalHydrationPartitionInvalid");
  });
});
