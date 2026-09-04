import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type {
  MemoryRawEvidenceArchiveV1,
  MemorySourceLocalHydratedEvidenceV1,
} from "@paw/memory-plugin";
import { validateMemoryDialoguePredecessorVerificationV1 } from "@paw/memory-plugin";

import { verifyAmbImmutableDialoguePredecessorsV1 } from "./immutable-dialogue-predecessor-verifier.js";
import { ambSourceLocalEvidenceRefBelongsToSourceV1 } from "./immutable-evidence-address.js";

function row(
  evidenceRef: string,
  sourceKind: "user_input" | "assistant_output",
  turnOrder: number,
): MemorySourceLocalHydratedEvidenceV1 {
  const content = `turn ${turnOrder}`;
  return Object.freeze({
    evidenceRef,
    sourceKind,
    turnOrder,
    observedAt: "2025-04-10T00:00:00.000Z",
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
  });
}

function archiveFrom(
  rows: ReadonlyMap<string, MemorySourceLocalHydratedEvidenceV1>,
): MemoryRawEvidenceArchiveV1 {
  return {
    async hydrate(evidenceRefs: readonly string[]) {
      return evidenceRefs.flatMap((evidenceRef) => {
        const found = rows.get(evidenceRef);
        return found ? [found] : [];
      });
    },
  } as unknown as MemoryRawEvidenceArchiveV1;
}

describe("AMB immutable dialogue predecessor verifier", () => {
  test("hydrates a logical target through a legacy atom archive and preserves its exact target ref", async () => {
    const archive = archiveFrom(
      new Map([
        [
          "amb:document/session#source-1",
          row("amb:document/session#source-1", "user_input", 1),
        ],
        [
          "amb:document/session#atom-2",
          row("amb:document/session#atom-2", "assistant_output", 2),
        ],
      ]),
    );
    const result = await verifyAmbImmutableDialoguePredecessorsV1({
      archive,
      verifierVersion: "test-verifier",
      request: {
        targets: [{ sourceId: "session", evidenceRef: "session#source-2" }],
        lockedSourceIds: ["session"],
      },
      signal: new AbortController().signal,
    });

    expect(result.proofs).toHaveLength(1);
    expect(result.proofs[0]?.assistant.evidenceRef).toBe("session#source-2");
    expect(result.proofs[0]?.precedingUser.evidenceRef).toBe(
      "session#source-1",
    );
  });

  test("supports a physical target alias while retaining its byte-exact target address", async () => {
    const archive = archiveFrom(
      new Map([
        [
          "amb:document/session#source-1",
          row("amb:document/session#source-1", "user_input", 1),
        ],
        [
          "amb:document/session#atom-2",
          row("amb:document/session#atom-2", "assistant_output", 2),
        ],
      ]),
    );
    const target = "amb:document/session#atom-2";
    const result = await verifyAmbImmutableDialoguePredecessorsV1({
      archive,
      verifierVersion: "test-verifier",
      request: {
        targets: [{ sourceId: "session", evidenceRef: target }],
        lockedSourceIds: ["session"],
      },
      signal: new AbortController().signal,
    });

    expect(result.proofs[0]?.assistant.evidenceRef).toBe(target);
  });

  test("fails closed before hydration for ambiguous or cross-source targets", async () => {
    let calls = 0;
    const archive = {
      async hydrate(_evidenceRefs: readonly string[]) {
        calls += 1;
        return [];
      },
    } as unknown as MemoryRawEvidenceArchiveV1;
    for (const target of [
      { sourceId: "session", evidenceRef: "amb:document/session#atom-2-tail" },
      { sourceId: "other", evidenceRef: "session#source-2" },
    ]) {
      const result = await verifyAmbImmutableDialoguePredecessorsV1({
        archive,
        verifierVersion: "test-verifier",
        request: { targets: [target], lockedSourceIds: [target.sourceId] },
        signal: new AbortController().signal,
      });
      expect(result.proofs).toEqual([]);
    }
    expect(calls).toBe(0);
  });

  test("rejects hydrated rows whose turn orders disagree with the logical address", async () => {
    const archive = archiveFrom(
      new Map([
        [
          "amb:document/session#source-1",
          row("amb:document/session#source-1", "user_input", 99),
        ],
        [
          "amb:document/session#source-2",
          row("amb:document/session#source-2", "assistant_output", 100),
        ],
      ]),
    );
    const result = await verifyAmbImmutableDialoguePredecessorsV1({
      archive,
      verifierVersion: "test-verifier",
      request: {
        targets: [{ sourceId: "session", evidenceRef: "session#source-2" }],
        lockedSourceIds: ["session"],
      },
      signal: new AbortController().signal,
    });

    expect(result.proofs).toEqual([]);
  });

  test("passes a logical legacy proof through the core source ownership validator", async () => {
    const archive = archiveFrom(
      new Map([
        [
          "amb:document/session#atom-1",
          row("amb:document/session#atom-1", "user_input", 1),
        ],
        [
          "amb:document/session#atom-2",
          row("amb:document/session#atom-2", "assistant_output", 2),
        ],
      ]),
    );
    const request = {
      targets: [{ sourceId: "session", evidenceRef: "session#source-2" }],
      lockedSourceIds: ["session"],
    } as const;
    const result = await verifyAmbImmutableDialoguePredecessorsV1({
      archive,
      verifierVersion: "test-verifier",
      request,
      signal: new AbortController().signal,
    });
    const verifier = {
      verifierVersion: "test-verifier",
      async verify() {
        return result;
      },
    };

    expect(
      validateMemoryDialoguePredecessorVerificationV1({
        verifier,
        request,
        result,
        evidenceRefBelongsToSource: ambSourceLocalEvidenceRefBelongsToSourceV1,
      }),
    ).toHaveLength(1);
  });

  test("propagates cancellation instead of converting it to an empty proof", async () => {
    const aborted = new Error("cancelled");
    aborted.name = "AbortError";
    const archive = {
      async hydrate() {
        throw aborted;
      },
    } as unknown as MemoryRawEvidenceArchiveV1;

    await expect(
      verifyAmbImmutableDialoguePredecessorsV1({
        archive,
        verifierVersion: "test-verifier",
        request: {
          targets: [{ sourceId: "session", evidenceRef: "session#source-2" }],
          lockedSourceIds: ["session"],
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toHaveProperty("name", "AbortError");
  });
});
