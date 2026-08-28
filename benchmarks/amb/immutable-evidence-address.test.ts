import { describe, expect, test } from "bun:test";

import {
  immutableSourceTurnEvidenceRefV1,
  legacyImmutableTurnEvidenceRefV1,
  logicalSourceLocalEvidenceRefV1,
} from "./immutable-evidence-address.js";

describe("AMB immutable evidence address compatibility", () => {
  test("maps logical and physical source-turn addresses without changing families", () => {
    expect(
      logicalSourceLocalEvidenceRefV1("amb:document/session#source-27"),
    ).toBe("session#source-27");
    expect(immutableSourceTurnEvidenceRefV1("session#source-27")).toBe(
      "amb:document/session#source-27",
    );
    expect(legacyImmutableTurnEvidenceRefV1("session#source-27")).toBe(
      "amb:document/session#atom-27",
    );
    expect(
      legacyImmutableTurnEvidenceRefV1("amb:document/session#source-27-tail"),
    ).toBeUndefined();
    expect(
      legacyImmutableTurnEvidenceRefV1("amb:document/session#atom-27"),
    ).toBeUndefined();
    expect(
      immutableSourceTurnEvidenceRefV1("amb:document/session#source-27"),
    ).toBeUndefined();
  });
});
