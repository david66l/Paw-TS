import { describe, expect, test } from "bun:test";
import { hashTextV1 } from "../src/canonical.js";
import type { MemoryEvidenceIndexSearchResultV1 } from "../src/evidence-resolution-contracts.js";
import { createMemoryEvidenceResolverV1 } from "../src/evidence-resolver.js";
import {
  PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_REVISION_V1,
  buildMemoryRequirementFairAcquisitionV1,
} from "../src/requirement-fair-acquisition.js";

function result(
  rows: ReadonlyArray<
    Readonly<{
      sourceId: string;
      evidenceRef?: string;
      authority?: "user_asserted" | "context_only";
      sourceKind?: "user_input" | "assistant_output";
    }>
  >,
  retrieverId = "test",
): MemoryEvidenceIndexSearchResultV1 {
  return Object.freeze({
    lists: Object.freeze([
      Object.freeze({
        channel: "l0" as const,
        retrieverId,
        weight: 1,
        candidates: Object.freeze(
          rows.map((row, index) => {
            const evidenceRef =
              row.evidenceRef ?? `${row.sourceId}#turn-${index + 1}`;
            return Object.freeze({
              candidateId: evidenceRef,
              sourceId: row.sourceId,
              evidenceRef,
              sourceKind: row.sourceKind ?? ("user_input" as const),
              authority: row.authority ?? ("user_asserted" as const),
            });
          }),
        ),
      }),
    ]),
    hits: Object.freeze(
      rows.map((row, index) => {
        const evidenceRef =
          row.evidenceRef ?? `${row.sourceId}#turn-${index + 1}`;
        return Object.freeze({
          sourceId: row.sourceId,
          evidenceRef,
          content: `evidence ${evidenceRef}`,
          authority: row.authority ?? ("user_asserted" as const),
          sourceKind: row.sourceKind ?? ("user_input" as const),
        });
      }),
    ),
  });
}

function acquire(input: {
  requirements: ReadonlyArray<
    Readonly<{
      requirementId: string;
      result: MemoryEvidenceIndexSearchResultV1;
    }>
  >;
  maxSources?: number;
  maxEvidencePerSource?: number;
}) {
  return buildMemoryRequirementFairAcquisitionV1({
    queryRevision: hashTextV1("same original query"),
    originRevision: hashTextV1("same immutable origin"),
    evidenceTimeUpperBoundRevision: hashTextV1("same cutoff"),
    originalRoleConstraint: "user",
    originalLaneMode: "role_filtered",
    original: result([
      { sourceId: "original-primary" },
      { sourceId: "original-secondary" },
    ]),
    requirements: input.requirements.map((requirement) => ({
      ...requirement,
      roleConstraint: "user" as const,
      temporalBindingRevision: hashTextV1(
        `temporal:${requirement.requirementId}`,
      ),
    })),
    maxSources: input.maxSources ?? 8,
    maxEvidencePerSource: input.maxEvidencePerSource ?? 2,
  });
}

describe("requirement-fair pre-lock acquisition v1", () => {
  test("adding an independent leaf cannot evict the original-query primary reservation", () => {
    const initial = acquire({
      maxSources: 2,
      requirements: [
        {
          requirementId: "leaf-a",
          result: result([{ sourceId: "leaf-a-source" }]),
        },
      ],
    });
    const extended = acquire({
      maxSources: 2,
      requirements: [
        {
          requirementId: "leaf-a",
          result: result([{ sourceId: "leaf-a-source" }]),
        },
        {
          requirementId: "leaf-b",
          result: result([{ sourceId: "leaf-b-source" }]),
        },
      ],
    });

    expect(initial.fusion.sources[0]?.sourceId).toBe("original-primary");
    expect(extended.fusion.sources[0]?.sourceId).toBe("original-primary");
    expect(extended.report.originalReservedSourceId).toBe("original-primary");
  });

  test("gives four independent leaves one bounded opportunity before global fill", () => {
    const acquired = acquire({
      maxSources: 5,
      requirements: ["a", "b", "c", "d"].map((id) => ({
        requirementId: `leaf-${id}`,
        result: result([{ sourceId: `source-${id}` }]),
      })),
    });

    expect(acquired.report.selectedSourceIds).toEqual([
      "original-primary",
      "source-a",
      "source-b",
      "source-c",
      "source-d",
    ]);
    expect(
      acquired.report.requirementContributions.map(
        (lane) => lane.selectedSourceIds,
      ),
    ).toEqual([["source-a"], ["source-b"], ["source-c"], ["source-d"]]);
    expect(acquired.report.telemetry.requirementLaneOpportunityCount).toBe(4);
  });

  test("is deterministic and enforces both source and per-source candidate caps", () => {
    const sharedRows = Array.from({ length: 6 }, (_, index) => ({
      sourceId: "shared-source",
      evidenceRef: `shared-source#turn-${index + 1}`,
    }));
    const input = {
      maxSources: 3,
      maxEvidencePerSource: 2,
      requirements: [
        {
          requirementId: "leaf-a",
          result: result(sharedRows, "shared-a"),
        },
        {
          requirementId: "leaf-b",
          result: result([{ sourceId: "other-source" }], "other-b"),
        },
      ],
    } as const;
    const left = acquire(input);
    const right = acquire(input);

    expect(left).toEqual(right);
    expect(left.report.policyRevision).toBe(
      PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_REVISION_V1,
    );
    expect(left.fusion.sources.length).toBeLessThanOrEqual(3);
    expect(
      left.fusion.sources.every((source) => source.evidence.length <= 2),
    ).toBe(true);
  });

  test("keeps ordinary and explicit-user original acquisition role-filtered", async () => {
    const queries: Array<[string, string]> = [
      ["What color is my car?", "explicit_user"],
      ["What is the project status?", "ordinary_semantic"],
    ];
    for (const [query] of queries) {
      const resolver = createMemoryEvidenceResolverV1({
        index: {
          indexVersion: "authority-test.v1",
          async search() {
            return result([
              {
                sourceId: "assistant-source",
                authority: "context_only",
                sourceKind: "assistant_output",
              },
              { sourceId: "user-source" },
            ]);
          },
        },
        evidenceGroundedRoleBinding: true,
        maxSources: 1,
      });
      const resolution = await resolver.resolve(
        query,
        new AbortController().signal,
      );
      expect(resolution.sourceAcquisition.originalLaneMode).toBe(
        "role_filtered",
      );
      expect(resolution.sources.map((source) => source.sourceId)).toEqual([
        "user-source",
      ]);
    }
  });

  test("opens only unowned-dialogue original source acquisition while support stays closed", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "late-binding-acquisition-test.v1",
        async search() {
          return result([
            {
              sourceId: "assistant-source",
              authority: "context_only",
              sourceKind: "assistant_output",
            },
            { sourceId: "user-source" },
          ]);
        },
      },
      evidenceGroundedRoleBinding: true,
      maxSources: 1,
    });
    const resolution = await resolver.resolve(
      "Which project name came from our earlier conversation?",
      new AbortController().signal,
    );

    expect(resolution.sourceAcquisition.originalLaneMode).toBe(
      "origin_authorized_unfiltered",
    );
    expect(resolution.sources.map((source) => source.sourceId)).toEqual([
      "assistant-source",
    ]);
    expect(resolution.packetSources).toEqual([]);
    expect(resolution.notebook.selectedHitCount).toBe(0);
  });
});
