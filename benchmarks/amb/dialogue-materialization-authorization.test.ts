import { describe, expect, test } from "bun:test";

import {
  type AmbDialogueMaterializationAuthorizedItemV1,
  canonicalizeAmbDialogueAuthorizationV1,
} from "./dialogue-materialization-authorization.js";
import { logicalSourceLocalEvidenceRefV1 } from "./immutable-evidence-address.js";

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
            logicalSourceLocalEvidenceRefV1(evidenceRef) ?? evidenceRef,
        }),
      ),
    );

    expect(canonical.status).toBe("completed");
    expect(canonical.items).toEqual([item()]);
    expect(canonical.duplicateCount).toBe(1);
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
});
