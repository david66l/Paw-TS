import { describe, expect, test } from "bun:test";

import {
  type MemoryAspectLinkClaimV1,
  type PawNextMemoryScopeV1,
  applyMemoryAspectGraphMutationV1,
  buildMemoryAspectLinkCandidatesV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createMemoryAspectClaimV1,
  createMemoryAspectV1,
  createMemoryClaimAspectMembershipV1,
  deriveMemoryAspectLinkStatementHashV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-candidates",
  userId: "user-candidates",
  workspaceId: "workspace-candidates",
  repositoryId: "repo-candidates",
});
const jan = "2025-01-01T00:00:00.000Z";
const feb = "2025-02-01T00:00:00.000Z";

describe("deterministic aspect candidate builder v1", () => {
  test("recalls multiple aspects and exact relation representatives", () => {
    const cooking = aspect("cooking", "Cooking activities");
    const gardening = aspect("gardening", "Gardening activities");
    const cookingClaim = claim("cooking-old", jan);
    const gardeningClaim = claim("gardening-old", jan);
    const combined = claim("combined-new", feb);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: [cookingClaim, gardeningClaim, combined],
      aspects: [cooking, gardening],
      memberships: [
        membership(cookingClaim.id, cooking.id),
        membership(cookingClaim.id, gardening.id),
        membership(gardeningClaim.id, gardening.id),
      ],
    });
    const input = {
      scope,
      snapshot,
      observedAt: feb,
      claims: [
        evidence(combined.id, "Joined a gardening club with cooking workshops"),
      ],
      catalog: [
        evidence(cookingClaim.id, "Enjoys cooking workshops"),
        evidence(gardeningClaim.id, "Enjoys gardening clubs"),
      ],
      maxNewAspects: 1,
    };
    const result = buildMemoryAspectLinkCandidatesV1(input);

    expect(
      result.linkingInput.aspectCandidates.map((item) => item.aspectId),
    ).toEqual(expect.arrayContaining([cooking.id, gardening.id]));
    const relationTargets =
      result.linkingInput.relationCandidates[0]?.targetClaimIds ?? [];
    expect(relationTargets).toEqual(
      expect.arrayContaining([cookingClaim.id, gardeningClaim.id]),
    );
    expect(new Set(relationTargets).size).toBe(relationTargets.length);
    expect(result.metrics).toEqual(
      expect.objectContaining({
        candidateAspectCount: 2,
        representativeCount: 3,
        relationEvidenceCount: 2,
        relationTargetCount: 2,
        truncatedAspectCount: 0,
      }),
    );
    expect(result.metrics.promptChars).toBeGreaterThan(0);

    const reordered = buildMemoryAspectLinkCandidatesV1({
      ...input,
      catalog: [...input.catalog].reverse(),
    });
    expect(reordered.candidateRevision).toBe(result.candidateRevision);

    const enrichment = buildMemoryAspectLinkCandidatesV1({
      ...input,
      claims: [evidence(cookingClaim.id, "Enjoys cooking workshops")],
      catalog: [
        evidence(gardeningClaim.id, "Enjoys gardening clubs"),
        evidence(combined.id, "Joined a gardening club with cooking workshops"),
      ],
      includeRelations: false,
      excludeExistingMemberships: true,
      maxNewAspects: 0,
    });
    expect(enrichment.linkingInput.aspectCandidates).toEqual([]);
    expect(
      enrichment.linkingInput.relationCandidates[0]?.targetClaimIds,
    ).toEqual([]);
  });

  test("ignores non-global memberships and rejects statement receipt mismatch", () => {
    const work = aspect("work", "Concise report preference");
    const old = claim("work-old", jan);
    const current = claim("work-current", feb);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: [old, current],
      aspects: [work],
      memberships: [
        createMemoryClaimAspectMembershipV1({
          scope,
          claimId: old.id,
          aspectId: work.id,
          contextKey: "work",
          role: "state",
          confidence: 1,
          createdAt: jan,
        }),
      ],
    });
    const valid = {
      scope,
      snapshot,
      observedAt: feb,
      claims: [evidence(current.id, "Now prefers concise reports")],
      catalog: [evidence(old.id, "Previously preferred detailed reports")],
      maxNewAspects: 1,
    };
    const result = buildMemoryAspectLinkCandidatesV1(valid);
    expect(result.linkingInput.aspectCandidates).toEqual([]);
    expect(result.metrics.eligibleAspectCount).toBe(0);
    const originalCatalogItem = valid.catalog[0];
    if (originalCatalogItem === undefined) {
      throw new Error("missing catalog item");
    }

    expect(() =>
      buildMemoryAspectLinkCandidatesV1({
        ...valid,
        catalog: [
          {
            ...originalCatalogItem,
            statement: "Tampered catalog statement",
          },
        ],
      }),
    ).toThrow("MemoryAspectCandidateBuilderCatalogInvalid");
  });

  test("enforces global aspect and relation budgets with explicit truncation", () => {
    const aspects = Array.from({ length: 7 }, (_, index) =>
      aspect(`shared-${index}`, `Topic${index} activity`),
    );
    const existingClaims = aspects.flatMap((_, aspectIndex) =>
      Array.from({ length: 4 }, (_, memberIndex) =>
        claim(`old-${aspectIndex}-${memberIndex}`, jan),
      ),
    );
    const current = claim("shared-current", feb);
    const snapshot = applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: [...existingClaims, current],
      aspects,
      memberships: existingClaims.map((item, index) =>
        membership(item.id, aspects[Math.floor(index / 4)]?.id ?? "missing"),
      ),
    });
    const result = buildMemoryAspectLinkCandidatesV1({
      scope,
      snapshot,
      observedAt: feb,
      claims: [
        evidence(
          current.id,
          "Topic0 Topic1 Topic2 Topic3 Topic4 Topic5 Topic6 activity update",
        ),
      ],
      catalog: existingClaims.map((item) =>
        evidence(
          item.id,
          `Topic${item.id.split("-")[1]} activity memory ${item.id}`,
        ),
      ),
      maxNewAspects: 1,
    });

    expect(result.metrics).toEqual(
      expect.objectContaining({
        positivelyScoredAspectCount: 7,
        candidateAspectCount: 6,
        representativeCount: 18,
        truncatedAspectCount: 1,
        truncatedRepresentativeCount: 6,
        relationTargetCount: 12,
        relationEvidenceCount: 12,
        truncatedRelationTargetCount: 12,
      }),
    );
  });
});

function evidence(claimId: string, statement: string): MemoryAspectLinkClaimV1 {
  return {
    claimId,
    statement,
    statementHash: deriveMemoryAspectLinkStatementHashV1(statement),
  };
}

function aspect(identitySeed: string, displayName: string) {
  return createMemoryAspectV1({ scope, identitySeed, displayName });
}

function claim(id: string, validFrom: string) {
  return createMemoryAspectClaimV1({
    id,
    kind: "assertion",
    validFrom,
    ingestedAt: validFrom,
    evidenceRefs: [`l0:${id}`],
  });
}

function membership(claimId: string, aspectId: string) {
  return createMemoryClaimAspectMembershipV1({
    scope,
    claimId,
    aspectId,
    role: "state",
    confidence: 1,
    createdAt: jan,
  });
}
