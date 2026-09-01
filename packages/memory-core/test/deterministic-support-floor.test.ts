import { describe, expect, test } from "bun:test";
import type { MemoryEvidenceNotebookHitV1 } from "../src/evidence-contracts.js";
import {
  PAW_MEMORY_DETERMINISTIC_SUPPORT_FLOOR_POLICY_V1,
  applyMemoryDeterministicSupportFloorV1,
} from "../src/evidence-packet-builder.js";

function hit(
  evidenceRef: string,
  overrides: Partial<MemoryEvidenceNotebookHitV1> = {},
): MemoryEvidenceNotebookHitV1 {
  return {
    sourceId: "session-a",
    evidenceRef,
    content: `content for ${evidenceRef}`,
    authority: "user_asserted",
    ...overrides,
  };
}

describe("deterministic support floor v1", () => {
  test("binds lane-ranked candidates when a committed selection is empty", () => {
    const floor = applyMemoryDeterministicSupportFloorV1({
      selectedRefsByRequirement: new Map([["req-1", new Set<string>()]]),
      requirementIds: ["req-1"],
      requirementHits: [[hit("a#1"), hit("a#2"), hit("a#3")]],
      lockedSourceIds: ["session-a"],
      maxFloorHitsPerRequirement: 2,
    });
    expect(floor.flooredRequirementIds).toEqual(["req-1"]);
    const refs = [...(floor.selectedRefsByRequirement.get("req-1") ?? [])];
    expect(refs).toEqual(["a#1", "a#2"]);
    expect(floor.policyVersion).toBe(
      PAW_MEMORY_DETERMINISTIC_SUPPORT_FLOOR_POLICY_V1,
    );
  });

  test("never overrides a non-empty selector binding", () => {
    const floor = applyMemoryDeterministicSupportFloorV1({
      selectedRefsByRequirement: new Map([["req-1", new Set(["a#2"])]]),
      requirementIds: ["req-1"],
      requirementHits: [[hit("a#1"), hit("a#2")]],
      lockedSourceIds: ["session-a"],
      maxFloorHitsPerRequirement: 2,
    });
    expect(floor.flooredRequirementIds).toEqual([]);
    const refs = [...(floor.selectedRefsByRequirement.get("req-1") ?? [])];
    expect(refs).toEqual(["a#2"]);
  });

  test("honors explicit negative judgments, context-only authority, and locked sources", () => {
    const floor = applyMemoryDeterministicSupportFloorV1({
      selectedRefsByRequirement: new Map([["req-1", new Set<string>()]]),
      requirementIds: ["req-1"],
      requirementHits: [
        [
          hit("a#1", {
            authority: "context_only",
            sourceKind: "assistant_output",
          }),
          hit("b#1", { sourceId: "session-b" }),
          hit("a#2"),
        ],
      ],
      lockedSourceIds: ["session-a"],
      maxFloorHitsPerRequirement: 2,
      excludedEvidenceRefs: [new Set(["a#2"])],
    });
    expect(floor.flooredRequirementIds).toEqual([]);
    expect(floor.selectedRefsByRequirement.get("req-1")?.size).toBe(0);
  });

  test("rejects out-of-range floor budgets", () => {
    expect(() =>
      applyMemoryDeterministicSupportFloorV1({
        selectedRefsByRequirement: new Map(),
        requirementIds: [],
        requirementHits: [],
        lockedSourceIds: [],
        maxFloorHitsPerRequirement: 0,
      }),
    ).toThrow("MemoryDeterministicSupportFloorBudgetInvalid");
  });
});
