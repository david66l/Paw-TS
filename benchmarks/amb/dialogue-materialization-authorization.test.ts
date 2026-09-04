import { describe, expect, test } from "bun:test";

import {
  AMB_DIALOGUE_PAIR_MAX_LINEAGE_REVISIONS_V1,
  type AmbDialogueMaterializationAuthorizedItemV1,
  type AmbDialoguePairProofV1,
  canonicalAmbDialogueEvidenceRefV1,
  canonicalizeAmbDialogueAuthorizationV1,
  canonicalizeAmbDialoguePairProofsV1,
} from "./dialogue-materialization-authorization.js";

function item(
  overrides: Partial<AmbDialogueMaterializationAuthorizedItemV1> = {},
): AmbDialogueMaterializationAuthorizedItemV1 {
  return {
    sourceId: "session",
    evidenceRef: "session#source-2",
    turnOrder: 2,
    evidenceUse: "assistant_report",
    allowedModes: ["dialogue_materialization"],
    ...overrides,
  };
}

function pair(
  overrides: Partial<AmbDialoguePairProofV1> = {},
): AmbDialoguePairProofV1 {
  return {
    sourceId: "session",
    assistantEvidenceRef: "session#source-2",
    assistantContentHash: "a".repeat(64),
    assistantTurnOrder: 2,
    assistantRole: "assistant_output",
    predecessorEvidenceRef: "session#source-1",
    predecessorContentHash: "b".repeat(64),
    predecessorTurnOrder: 1,
    predecessorRole: "user_input",
    relation: "immediate_predecessor",
    allowedModes: ["dialogue_pair_context"],
    evidenceTimeUpperBound: "2025-01-03T00:00:00.000Z",
    verifierVersion: "paw.test-verifier.v1",
    verificationRevision: "c".repeat(64),
    dialogueCertificateRevision: "1".repeat(64),
    ...overrides,
  };
}

describe("AMB dialogue materialization authorization", () => {
  test("coalesces identical final-packet bindings into one capability", () => {
    const canonical = canonicalizeAmbDialogueAuthorizationV1([
      item(),
      item(),
      item({
        evidenceRef: "session#source-4",
        turnOrder: 4,
      }),
    ]);

    expect(canonical).toEqual({
      status: "completed",
      items: [item(), item({ evidenceRef: "session#source-4", turnOrder: 4 })],
      duplicateCount: 1,
      conflictCount: 0,
    });
  });

  test("coalesces physical and logical aliases after canonical addressing", () => {
    const physical = "amb:document/session#atom-2";
    const logical = "session#source-2";
    const canonical = canonicalizeAmbDialogueAuthorizationV1(
      [physical, logical].map((evidenceRef) =>
        item({
          evidenceRef:
            canonicalAmbDialogueEvidenceRefV1(evidenceRef) ?? evidenceRef,
        }),
      ),
    );

    expect(canonical.status).toBe("completed");
    expect(canonical.items).toEqual([item()]);
    expect(canonical.duplicateCount).toBe(1);
  });

  test("keeps only exact source-local address families canonicalizable", () => {
    expect(
      canonicalAmbDialogueEvidenceRefV1("amb:document/session#atom-2"),
    ).toBe("session#source-2");
    expect(canonicalAmbDialogueEvidenceRefV1("session#source-2")).toBe(
      "session#source-2",
    );
    expect(canonicalAmbDialogueEvidenceRefV1("session#source-2-tail")).toBe(
      undefined,
    );
  });

  test("fails the whole authorization on any same-ref semantic conflict", () => {
    const conflicts: AmbDialogueMaterializationAuthorizedItemV1[] = [
      item({ sourceId: "other" }),
      item({ turnOrder: 3 }),
      item({ evidenceUse: "shared_dialogue_artifact" }),
      item({ allowedModes: [] as never }),
    ];

    for (const conflicting of conflicts) {
      expect(
        canonicalizeAmbDialogueAuthorizationV1([item(), conflicting]),
      ).toMatchObject({
        status: "conflict",
        items: [],
        conflictCount: 1,
      });
    }
  });

  test("coalesces physical and logical proof aliases without losing lineage", () => {
    const physicalAssistant = "amb:document/session#atom-2";
    const physicalPredecessor = "amb:document/session#atom-1";
    const proofs = [
      pair({
        assistantEvidenceRef:
          canonicalAmbDialogueEvidenceRefV1(physicalAssistant),
        predecessorEvidenceRef:
          canonicalAmbDialogueEvidenceRefV1(physicalPredecessor),
        dialogueCertificateRevision: "2".repeat(64),
      }),
      pair({ dialogueCertificateRevision: "1".repeat(64) }),
    ] as AmbDialoguePairProofV1[];

    expect(canonicalizeAmbDialoguePairProofsV1(proofs)).toEqual({
      status: "completed",
      pairs: [
        {
          ...pair(),
          dialogueCertificateRevision: undefined,
          dialogueCertificateRevisions: ["1".repeat(64), "2".repeat(64)],
        },
      ].map(({ dialogueCertificateRevision: _, ...value }) => value),
      duplicateCount: 0,
      lineageCount: 2,
      conflictCount: 0,
    });
  });

  test("fails closed on every same-capability semantic disagreement", () => {
    const conflicts: Partial<AmbDialoguePairProofV1>[] = [
      { assistantContentHash: "d".repeat(64) },
      { assistantTurnOrder: 3 },
      { assistantRole: "user_input" as never },
      { predecessorContentHash: "e".repeat(64) },
      { predecessorTurnOrder: 0 },
      { predecessorRole: "assistant_output" as never },
      { relation: "other" as never },
      { allowedModes: [] as never },
      { evidenceTimeUpperBound: "2025-01-02T00:00:00.000Z" },
      { verifierVersion: "paw.other-verifier.v1" },
      { verificationRevision: "f".repeat(64) },
    ];

    for (const override of conflicts) {
      expect(
        canonicalizeAmbDialoguePairProofsV1([
          pair(),
          pair({
            ...override,
            dialogueCertificateRevision: "2".repeat(64),
          }),
        ]),
      ).toMatchObject({ status: "conflict", pairs: [], conflictCount: 1 });
    }
  });

  test("coalesces an exact repeated proof but rejects lineage reuse across capabilities", () => {
    expect(canonicalizeAmbDialoguePairProofsV1([pair(), pair()])).toMatchObject(
      {
        status: "completed",
        duplicateCount: 1,
        lineageCount: 1,
      },
    );

    expect(
      canonicalizeAmbDialoguePairProofsV1([
        pair(),
        pair({
          assistantEvidenceRef: "session#source-4",
          assistantTurnOrder: 4,
          predecessorEvidenceRef: "session#source-3",
          predecessorTurnOrder: 3,
        }),
      ]),
    ).toMatchObject({ status: "conflict", pairs: [], conflictCount: 1 });
  });

  test("rejects malformed or unbounded lineage", () => {
    expect(
      canonicalizeAmbDialoguePairProofsV1([
        pair({ dialogueCertificateRevision: "A".repeat(64) }),
      ]),
    ).toMatchObject({ status: "conflict", pairs: [] });

    const proofs = Array.from(
      { length: AMB_DIALOGUE_PAIR_MAX_LINEAGE_REVISIONS_V1 + 1 },
      (_, index) =>
        pair({
          dialogueCertificateRevision: index.toString(16).padStart(64, "0"),
        }),
    );
    expect(canonicalizeAmbDialoguePairProofsV1(proofs)).toMatchObject({
      status: "conflict",
      pairs: [],
    });
  });
});
