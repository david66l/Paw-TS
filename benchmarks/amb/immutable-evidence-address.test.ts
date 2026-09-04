import { describe, expect, test } from "bun:test";

import {
  ambSourceLocalEvidenceRefBelongsToSourceV1,
  immutableSourceTurnEvidenceRefV1,
  legacyImmutableTurnEvidenceRefV1,
  logicalSourceLocalEvidenceRefV1,
} from "./immutable-evidence-address.js";

describe("AMB immutable evidence address compatibility", () => {
  test("maps logical and physical source-turn addresses without changing families", () => {
    expect(
      logicalSourceLocalEvidenceRefV1("amb:document/session#source-27"),
    ).toBe("session#source-27");
    expect(
      logicalSourceLocalEvidenceRefV1("amb:document/session#atom-27"),
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
    for (const ambiguous of [
      "amb:document/session#atom-27-tail",
      "amb:document/session#atom-0x27",
      "amb:document/session#atom-27#source-1",
      "amb:document/#atom-27",
      "amb:document/session#turn-27",
    ]) {
      expect(logicalSourceLocalEvidenceRefV1(ambiguous)).toBeUndefined();
    }
    expect(
      ambSourceLocalEvidenceRefBelongsToSourceV1(
        "session",
        "session#source-27",
      ),
    ).toBe(true);
    expect(
      ambSourceLocalEvidenceRefBelongsToSourceV1(
        "session",
        "amb:document/session#atom-27",
      ),
    ).toBe(true);
    expect(
      ambSourceLocalEvidenceRefBelongsToSourceV1("other", "session#source-27"),
    ).toBe(false);
  });
});
