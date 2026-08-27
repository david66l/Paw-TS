import { describe, expect, test } from "bun:test";

import type { MemoryCardV1 } from "@paw/protocol";

import { hashTextV1 } from "../src/canonical.js";
import {
  PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  type PawNextMemoryPluginProfileV1,
  createMemoryContextResolverV1,
} from "../src/index.js";

const scope = Object.freeze({
  tenantId: "tenant-resolver",
  userId: "user-resolver",
  workspaceId: "workspace-resolver",
  repositoryId: "repo-resolver",
});

const profile: PawNextMemoryPluginProfileV1 = Object.freeze({
  policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  mode: "read_only",
  providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  scope,
  maxCards: 8,
  maxInjectedTokens: 2_048,
});

describe("unified memory context resolver", () => {
  test("compiles L1 selection and exact L0 evidence into one sufficient packet", async () => {
    let plannerCalls = 0;
    let archiveCalls = 0;
    const resolver = createMemoryContextResolverV1({
      profile,
      provider: {
        providerVersion: profile.providerVersion,
        async retrieve() {
          return { status: "completed", cards: [card()] };
        },
      },
      topicStore: {
        scope,
        async load() {
          return [];
        },
      },
      archive: {
        scope,
        async put() {},
        async resolve(requests) {
          archiveCalls += 1;
          return requests.map((request) => {
            const content =
              "The user explicitly chose Compose because cloud cost was high.";
            return { ...request, content, contentHash: hashTextV1(content) };
          });
        },
      },
      planner: {
        plannerVersion: "resolver-planner-test-v1",
        async plan(input) {
          plannerCalls += 1;
          expect(input.evidence.map((item) => item.memoryId)).toEqual([
            "memory-1",
          ]);
          return [
            {
              description: "The user's deployment choice and its reason",
              priority: "required",
              minimumEvidence: 1,
              coveredMemoryIds: ["memory-1"],
              expandTopicIds: [],
            },
          ];
        },
      },
      verifier: {
        verifierVersion: "resolver-verifier-test-v1",
        async verify(input) {
          expect(input.requirements[0]?.candidateMemoryIds).toEqual([
            "memory-1",
          ]);
          expect(input.spans).toHaveLength(1);
          return {
            verifierVersion: "resolver-verifier-test-v1",
            verificationRevision: "verification-1",
            assessments: [
              {
                requirementId: input.requirements[0]!.requirementId,
                supportingMemoryIds: ["memory-1"],
                contradictingMemoryIds: [],
                unknownMemoryIds: [],
                supportingSpanHashes: [input.spans[0]!.contentHash],
                contradictingSpanHashes: [],
              },
            ],
          };
        },
      },
      maxRequirements: 4,
      maxExpansionTopics: 3,
      maxSupplementalStates: 8,
      maxSupplementalChars: 4_096,
      maxRawSpans: 4,
      maxRawChars: 4_000,
    });

    const packet = await resolver.resolve(
      "Why did the user choose Compose?",
      new AbortController().signal,
    );
    const replay = await resolver.resolve(
      "Why did the user choose Compose?",
      new AbortController().signal,
    );

    expect(plannerCalls).toBe(1);
    expect(archiveCalls).toBe(1);
    expect(replay).toBe(packet);
    expect(packet.mode).toBe("planned");
    expect(packet.stop).toBe("sufficient");
    expect(packet.requirements[0]?.status).toBe("covered");
    expect(packet.verification.status).toBe("verified");
    expect(packet.verification.supportingCount).toBe(1);
    expect(packet.evidence.map((item) => item.memoryId)).toEqual(["memory-1"]);
    expect(packet.spans).toHaveLength(1);
    expect(packet.packetRevision).toHaveLength(64);
  });

  test("audits every required claim through bounded L0 search before declaring coverage", async () => {
    const direct =
      "The user attended the named workshop and said the hands-on analysis sparked a lasting interest.";
    const resolver = createMemoryContextResolverV1({
      profile,
      provider: {
        providerVersion: profile.providerVersion,
        async retrieve() {
          return { status: "completed", cards: [card()] };
        },
      },
      topicStore: {
        scope,
        async load() {
          return [];
        },
      },
      archive: {
        scope,
        async put() {},
        async resolve(requests) {
          const related = "The user generally prefers practical learning.";
          return requests.map((request) => ({
            ...request,
            content: related,
            contentHash: hashTextV1(related),
          }));
        },
        async search(query) {
          expect(query.query).toBe(
            "The user's attendance and reaction to the named workshop",
          );
          expect(query.maxSpans).toBe(1);
          return [
            {
              evidenceRef: "conversation:exact-event",
              sourceKind: "user_input",
              sourceSeq: 7,
              authority: "user_asserted",
              content: direct,
              contentHash: hashTextV1(direct),
              hitContent: direct,
              hitContentHash: hashTextV1(direct),
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ];
        },
      },
      planner: {
        plannerVersion: "resolver-planner-l0-audit-test-v1",
        async plan() {
          return [
            {
              description:
                "The user's attendance and reaction to the named workshop",
              priority: "required",
              minimumEvidence: 1,
              coveredMemoryIds: ["memory-1"],
              expandTopicIds: [],
            },
          ];
        },
      },
      verifier: {
        verifierVersion: "resolver-verifier-l0-audit-test-v1",
        async verify(input) {
          const requirement = input.requirements[0]!;
          const l0 = input.evidence.find((item) => item.layer === "L0")!;
          expect(requirement.candidateMemoryIds).toContain(l0.memoryId);
          expect(
            input.spans.some((span) => span.memoryIds.includes(l0.memoryId)),
          ).toBe(true);
          return {
            verifierVersion: "resolver-verifier-l0-audit-test-v1",
            verificationRevision: "verification-l0-audit",
            assessments: [
              {
                requirementId: requirement.requirementId,
                supportingMemoryIds: [l0.memoryId],
                contradictingMemoryIds: [],
                unknownMemoryIds: ["memory-1"],
                supportingSpanHashes: [hashTextV1(direct)],
                contradictingSpanHashes: [],
              },
            ],
          };
        },
      },
      maxRawSpans: 4,
      maxRawChars: 4_000,
    });

    const packet = await resolver.resolve(
      "Which workshop best matches the user's past experience?",
      new AbortController().signal,
    );

    expect(packet.stop).toBe("sufficient");
    expect(packet.evidence[0]?.layer).toBe("L0");
    expect(packet.evidence[0]?.supportRole).toBe("supporting");
    expect(packet.spans[0]?.content).toBe(direct);
  });

  test("does not call related evidence sufficient when support verification is unknown", async () => {
    const resolver = createMemoryContextResolverV1({
      profile,
      provider: {
        providerVersion: profile.providerVersion,
        async retrieve() {
          return { status: "completed", cards: [card()] };
        },
      },
      topicStore: {
        scope,
        async load() {
          return [];
        },
      },
      archive: {
        scope,
        async put() {},
        async resolve(requests) {
          const content = "The user has used containers.";
          return requests.map((request) => ({
            ...request,
            content,
            contentHash: hashTextV1(content),
          }));
        },
      },
      planner: {
        plannerVersion: "resolver-planner-test-v1",
        async plan() {
          return [
            {
              description: "The reason for choosing Compose",
              priority: "required",
              minimumEvidence: 1,
              coveredMemoryIds: ["memory-1"],
              expandTopicIds: [],
            },
          ];
        },
      },
      verifier: {
        verifierVersion: "resolver-verifier-test-v1",
        async verify(input) {
          return {
            verifierVersion: "resolver-verifier-test-v1",
            verificationRevision: "verification-unknown",
            assessments: [
              {
                requirementId: input.requirements[0]!.requirementId,
                supportingMemoryIds: [],
                contradictingMemoryIds: [],
                unknownMemoryIds: ["memory-1"],
                supportingSpanHashes: [],
                contradictingSpanHashes: [],
              },
            ],
          };
        },
      },
    });

    const packet = await resolver.resolve(
      "Why did the user choose Compose?",
      new AbortController().signal,
    );
    expect(packet.stop).toBe("missing");
    expect(packet.requirements[0]?.status).toBe("missing");
    expect(packet.verification.unknownCount).toBe(1);
    expect(packet.evidence).toHaveLength(1);
    expect(packet.evidence[0]?.supportRole).toBe("contextual");
    expect(packet.spans).toHaveLength(1);
  });

  test("discards a failed planner and returns bounded deterministic evidence", async () => {
    const resolver = createMemoryContextResolverV1({
      profile,
      provider: {
        providerVersion: profile.providerVersion,
        async retrieve() {
          return { status: "completed", cards: [card()] };
        },
      },
      topicStore: {
        scope,
        async load() {
          return [];
        },
      },
      archive: {
        scope,
        async put() {},
        async resolve(requests) {
          return requests.map((request) => {
            const content = "source";
            return { ...request, content, contentHash: hashTextV1(content) };
          });
        },
      },
      planner: {
        plannerVersion: "resolver-planner-test-v1",
        async plan() {
          throw new Error("invalid model proposal");
        },
      },
    });

    const packet = await resolver.resolve(
      "Why did the user choose Compose?",
      new AbortController().signal,
    );
    expect(packet.mode).toBe("deterministic_fallback");
    expect(packet.stop).toBe("partial");
    expect(packet.evidence).toHaveLength(1);
    expect(packet.spans).toHaveLength(1);
  });
});

function card(): MemoryCardV1 {
  return Object.freeze({
    id: "memory-1",
    revision: 1,
    contentHash: hashTextV1(
      "High cloud cost caused the user to choose Compose.",
    ),
    kind: "episodic",
    statement: "High cloud cost caused the user to choose Compose.",
    applicability: "reference",
    scope: Object.freeze({ repositoryId: scope.repositoryId }),
    sources: Object.freeze([
      Object.freeze({
        kind: "memory_store_evidence",
        ref: "journal:run-1#input-fact-2",
      }),
    ]),
    confidence: 0.95,
    sensitivity: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}
