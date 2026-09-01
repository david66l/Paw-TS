import { describe, expect, test } from "bun:test";

import {
  evidenceNotebookCharsForProfileV1,
  resolveAmbEvidenceExecutionProfileV1,
} from "./evidence-execution-profile.js";

describe("AMB evidence execution profiles", () => {
  test("keeps product parity lexical and product-sized", () => {
    const profile = resolveAmbEvidenceExecutionProfileV1("product_parity");
    expect(profile).toEqual({
      profileId: "product_parity",
      sourceLocalDense: false,
      closureAudit: false,
      closureMode: "disabled",
      maxHitsPerRequirement: 4,
      maximumNotebookChars: 4_096,
    });
    expect(evidenceNotebookCharsForProfileV1(profile, 14_000)).toBe(4_096);
  });

  test("names the larger dense profile instead of implying product parity", () => {
    const profile = resolveAmbEvidenceExecutionProfileV1("research_dense");
    expect(profile.sourceLocalDense).toBe(true);
    expect(profile.closureAudit).toBe(true);
    expect(profile.closureMode).toBe("observe");
    expect(profile.maxHitsPerRequirement).toBe(8);
    expect(evidenceNotebookCharsForProfileV1(profile, 14_000)).toBe(8_192);
  });

  test("keeps verifier-triggered replanning behind an explicit ablation profile", () => {
    const profile = resolveAmbEvidenceExecutionProfileV1("research_replan");
    expect(profile.closureAudit).toBe(true);
    expect(profile.closureMode).toBe("repair");
  });

  test("rejects unnamed profiles", () => {
    expect(() => resolveAmbEvidenceExecutionProfileV1("magic")).toThrow(
      "AmbEvidenceExecutionProfileInvalid",
    );
  });
});
