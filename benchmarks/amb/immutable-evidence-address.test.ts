import { describe, expect, test } from "bun:test";

import { legacyImmutableTurnEvidenceRefV1 } from "./immutable-evidence-address.js";

describe("AMB immutable evidence address compatibility", () => {
  test("maps only an exact source-turn suffix to its legacy immutable alias", () => {
    expect(
      legacyImmutableTurnEvidenceRefV1("amb:document/session#source-27"),
    ).toBe("amb:document/session#atom-27");
    expect(
      legacyImmutableTurnEvidenceRefV1("amb:document/session#source-27-tail"),
    ).toBeUndefined();
    expect(
      legacyImmutableTurnEvidenceRefV1("amb:document/session#atom-27"),
    ).toBeUndefined();
  });
});
