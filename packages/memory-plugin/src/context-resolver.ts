import type { SessionInputSnapshot } from "@paw/agent-loop";
import type {
  InputFactV1,
  JsonValue,
  MemoryCardV1,
  MemoryTopicEvidenceStateV1,
} from "@paw/protocol";

import { hashCanonicalJsonV1, hashTextV1 } from "./canonical.js";
import {
  type MemoryContextResolverV1,
  type MemoryRawEvidenceSpanV1,
  type MemoryResolvedContextEvidenceV1,
  type MemoryResolvedContextPacketV1,
  type MemoryResolvedContextTopicV1,
  PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
} from "./context-contract.js";
export {
  type MemoryContextResolverV1,
  type MemoryResolvedContextEvidenceV1,
  type MemoryResolvedContextPacketV1,
  type MemoryResolvedContextTopicV1,
  PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
} from "./context-contract.js";
import {
  type MemoryEvidenceCoveragePlanV1,
  type MemoryEvidenceCoveragePlannerV1,
  planMemoryEvidenceCoverageV1,
} from "./evidence-coverage-planner.js";
import type {
  MemoryEvidenceSupportAssessmentV1,
  MemoryEvidenceSupportVerificationV1,
  MemoryEvidenceSupportVerifierV1,
} from "./evidence-support-verifier.js";
import type { PawNextMemoryPluginProfileV1 } from "./profile.js";
import { memoryScopeFingerprintV1 } from "./profile.js";
import type { MemoryRawEvidenceArchiveV1 } from "./raw-evidence-archive.js";
import { boundMemoryRawEvidenceSpansV1 } from "./raw-evidence-resolver.js";
import {
  type MemoryProviderQueryV1,
  type MemoryProviderV1,
  createMemorySearchTextsV1,
} from "./retrieval-input-port.js";
import type { MemoryTopicDossierStoreV1 } from "./topic-dossier-store.js";
import {
  type MemoryTopicEvidenceCatalogItemV1,
  planMemoryTopicEvidenceV1,
} from "./topic-evidence-planner.js";
import type { MemoryTopicEvidenceStoreV1 } from "./topic-evidence-store.js";

export interface MemoryContextResolverEventV1 {
  readonly schemaVersion: "paw.memory-context-resolver-event.v1";
  readonly mode: MemoryResolvedContextPacketV1["mode"];
  readonly stop: MemoryResolvedContextPacketV1["stop"];
  readonly requirementCount: number;
  readonly coveredCount: number;
  readonly partialCount: number;
  readonly missingCount: number;
  readonly evidenceCount: number;
  readonly topicCount: number;
  readonly spanCount: number;
  readonly verificationStatus: "verified" | "not_configured" | "failed";
  readonly supportingCount: number;
  readonly contradictionCount: number;
  readonly unknownCount: number;
  readonly l0EvidenceCount: number;
  readonly verificationRevision?: string;
  readonly packetRevision: string;
  readonly evidenceSetHash: string;
  readonly topicSetHash: string;
  readonly spanSetHash: string;
  readonly durationMs: number;
  readonly reasonCode?: string;
}

export function createMemoryContextResolverV1(
  input: Readonly<{
    profile: PawNextMemoryPluginProfileV1;
    provider: MemoryProviderV1;
    topicStore: MemoryTopicEvidenceStoreV1;
    dossierStore?: MemoryTopicDossierStoreV1;
    archive?: MemoryRawEvidenceArchiveV1;
    planner?: MemoryEvidenceCoveragePlannerV1;
    verifier?: MemoryEvidenceSupportVerifierV1;
    maxRequirements?: number;
    maxExpansionTopics?: number;
    maxSupplementalStates?: number;
    maxSupplementalChars?: number;
    maxRawSpans?: number;
    maxRawChars?: number;
    onEvent?: (event: MemoryContextResolverEventV1) => void;
  }>,
): MemoryContextResolverV1 {
  const scopeFingerprint = memoryScopeFingerprintV1(input.profile.scope);
  assertScope(input.topicStore.scope, scopeFingerprint);
  if (input.dossierStore)
    assertScope(input.dossierStore.scope, scopeFingerprint);
  if (input.archive) assertScope(input.archive.scope, scopeFingerprint);
  let catalogPromise:
    | Promise<readonly MemoryTopicEvidenceCatalogItemV1[]>
    | undefined;
  const packetPromises = new Map<
    string,
    Promise<MemoryResolvedContextPacketV1>
  >();

  async function resolveUncached(
    boundedQuery: string,
    signal: AbortSignal,
  ): Promise<MemoryResolvedContextPacketV1> {
    const started = Date.now();
    catalogPromise ??= input.topicStore.load(signal);
    const [retrieval, catalog] = await Promise.all([
      input.provider.retrieve(toolQuery(boundedQuery, input.profile), signal),
      catalogPromise,
    ]);
    const topicPlan = planMemoryTopicEvidenceV1({
      query: boundedQuery,
      scopeFingerprint,
      catalog,
      maxIndexTopics:
        input.profile.writer?.evidencePlanner.maxIndexTopics ?? 96,
      maxSelectedTopics:
        input.profile.writer?.evidencePlanner.maxSelectedTopics ?? 3,
      maxStates: input.profile.writer?.evidencePlanner.maxStates ?? 16,
      maxEvidenceChars:
        input.profile.writer?.evidencePlanner.maxEvidenceChars ?? 8_000,
    });
    let plan: MemoryEvidenceCoveragePlanV1 | undefined;
    let fallbackReason: string | undefined;
    if (input.planner && input.archive) {
      try {
        plan = await planMemoryEvidenceCoverageV1({
          queryId: toolQuery(boundedQuery, input.profile).queryId,
          query: boundedQuery,
          scopeFingerprint,
          snapshot: coverageSnapshot(
            toolQuery(boundedQuery, input.profile).queryId,
            input.provider.providerVersion,
            retrieval.cards,
            topicPlan,
          ),
          catalog,
          archive: input.archive,
          planner: input.planner,
          maxRequirements:
            input.maxRequirements ??
            input.profile.writer?.coveragePlanner.maxRequirements ??
            4,
          maxExpansionTopics:
            input.maxExpansionTopics ??
            input.profile.writer?.coveragePlanner.maxExpansionTopics ??
            3,
          maxSupplementalStates:
            input.maxSupplementalStates ??
            input.profile.writer?.coveragePlanner.maxSupplementalStates ??
            8,
          maxSupplementalChars:
            input.maxSupplementalChars ??
            input.profile.writer?.coveragePlanner.maxSupplementalChars ??
            4_096,
          maxRawSpans:
            input.maxRawSpans ??
            input.profile.writer?.rawEvidenceResolver.maxSpans ??
            6,
          maxRawChars:
            input.maxRawChars ??
            input.profile.writer?.rawEvidenceResolver.maxChars ??
            6_000,
          signal,
        });
      } catch (error) {
        if (signal.aborted || isAbort(error)) throw abortError();
        fallbackReason = stableErrorCode(error);
        plan = undefined;
      }
    }
    const packet = await materializePacket({
      query: boundedQuery,
      scopeFingerprint,
      cards: retrieval.cards,
      topicPlan,
      catalog,
      plan,
      dossierStore: input.dossierStore,
      archive: input.archive,
      verifier: input.verifier,
      maxRawSpans:
        input.maxRawSpans ??
        input.profile.writer?.rawEvidenceResolver.maxSpans ??
        6,
      maxRawChars:
        input.maxRawChars ??
        input.profile.writer?.rawEvidenceResolver.maxChars ??
        6_000,
      signal,
    });
    input.onEvent?.(
      Object.freeze({
        schemaVersion: "paw.memory-context-resolver-event.v1",
        mode: packet.mode,
        stop: packet.stop,
        requirementCount: packet.requirements.length,
        coveredCount: packet.requirements.filter(
          (item) => item.status === "covered",
        ).length,
        partialCount: packet.requirements.filter(
          (item) => item.status === "partial",
        ).length,
        missingCount: packet.requirements.filter(
          (item) => item.status === "missing",
        ).length,
        evidenceCount: packet.evidence.length,
        topicCount: packet.topics.length,
        spanCount: packet.spans.length,
        verificationStatus: packet.verification.status,
        supportingCount: packet.verification.supportingCount,
        contradictionCount: packet.verification.contradictionCount,
        unknownCount: packet.verification.unknownCount,
        l0EvidenceCount: packet.evidence.filter((item) => item.layer === "L0")
          .length,
        ...(packet.verification.verificationRevision === undefined
          ? {}
          : {
              verificationRevision: packet.verification.verificationRevision,
            }),
        packetRevision: packet.packetRevision,
        evidenceSetHash: hashCanonicalJsonV1(
          packet.evidence.map((item) => item.memoryId).sort() as JsonValue,
        ),
        topicSetHash: hashCanonicalJsonV1(
          packet.topics.map((item) => item.topicId).sort() as JsonValue,
        ),
        spanSetHash: hashCanonicalJsonV1(
          packet.spans.map((item) => item.contentHash).sort() as JsonValue,
        ),
        durationMs: Math.max(0, Date.now() - started),
        ...(fallbackReason === undefined ? {} : { reasonCode: fallbackReason }),
      }),
    );
    return packet;
  }

  return Object.freeze({
    resolverVersion: PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
    async resolve(query: string, signal: AbortSignal) {
      const boundedQuery = boundedText(
        query,
        8_192,
        "MemoryContextResolverQueryInvalid",
      );
      if (signal.aborted) throw abortError();
      const cacheKey = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-resolved-query-cache.v1",
        resolverVersion: PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
        scopeFingerprint,
        query: boundedQuery,
      } as JsonValue);
      let pending = packetPromises.get(cacheKey);
      if (!pending) {
        pending = resolveUncached(boundedQuery, signal).catch((error) => {
          packetPromises.delete(cacheKey);
          throw error;
        });
        packetPromises.set(cacheKey, pending);
        while (packetPromises.size > 8) {
          const oldest = packetPromises.keys().next().value;
          if (oldest !== undefined) packetPromises.delete(oldest);
          else break;
        }
      }
      return pending;
    },
  });
}

async function materializePacket(
  input: Readonly<{
    query: string;
    scopeFingerprint: string;
    cards: readonly MemoryCardV1[];
    topicPlan: ReturnType<typeof planMemoryTopicEvidenceV1>;
    catalog: readonly MemoryTopicEvidenceCatalogItemV1[];
    plan?: MemoryEvidenceCoveragePlanV1;
    dossierStore?: MemoryTopicDossierStoreV1;
    archive?: MemoryRawEvidenceArchiveV1;
    verifier?: MemoryEvidenceSupportVerifierV1;
    maxRawSpans: number;
    maxRawChars: number;
    signal: AbortSignal;
  }>,
): Promise<MemoryResolvedContextPacketV1> {
  const evidenceById = new Map<string, MemoryResolvedContextEvidenceV1>();
  for (const card of input.cards) {
    evidenceById.set(
      card.id,
      Object.freeze({
        memoryId: card.id,
        layer: "L1",
        statement: card.statement.slice(0, 2_048),
        evidenceUse: "fact",
        ...(card.validFrom === undefined ? {} : { validFrom: card.validFrom }),
        evidenceRefs: Object.freeze(
          card.sources.map((source) => source.ref).slice(0, 8),
        ),
      }),
    );
  }
  for (const state of [
    ...input.topicPlan.evidenceStates,
    ...(input.plan?.supplementalStates ?? []),
  ]) {
    evidenceById.set(state.memoryId, topicStateEvidence(state));
  }
  const requirementL0Ids = new Map<string, string[]>();
  const searchedSpans: MemoryRawEvidenceSpanV1[] = [];
  if (input.plan && input.archive?.search) {
    const required = input.plan.requirements
      .filter((item) => item.priority === "required")
      .slice(0, input.maxRawSpans);
    const perRequirementChars = Math.max(
      256,
      Math.floor(input.maxRawChars / Math.max(1, required.length)),
    );
    const searchResults = await Promise.all(
      required.map(async (requirement) => ({
        requirement,
        results: await input.archive!.search!(
          {
            query: requirement.description.slice(0, 512),
            maxSpans: 1,
            maxChars: Math.min(16_384, perRequirementChars),
          },
          input.signal,
        ),
      })),
    );
    const spanByRef = new Map<
      string,
      { span: MemoryRawEvidenceSpanV1; memoryIds: Set<string> }
    >();
    for (const { requirement, results } of searchResults) {
      for (const result of results) {
        const memoryId = hashCanonicalJsonV1({
          schemaVersion: "paw.memory-l0-search-evidence.v1",
          scopeFingerprint: input.scopeFingerprint,
          evidenceRef: result.evidenceRef,
          contentHash: result.contentHash,
        });
        const ids = requirementL0Ids.get(requirement.requirementId) ?? [];
        if (!ids.includes(memoryId)) ids.push(memoryId);
        requirementL0Ids.set(requirement.requirementId, ids);
        evidenceById.set(
          memoryId,
          Object.freeze({
            memoryId,
            layer: "L0" as const,
            statement: result.content.slice(0, 900),
            evidenceUse: "fact" as const,
            validFrom: result.createdAt,
            evidenceRefs: Object.freeze([result.evidenceRef]),
          }),
        );
        const existing = spanByRef.get(result.evidenceRef);
        if (existing) {
          existing.memoryIds.add(memoryId);
        } else {
          spanByRef.set(result.evidenceRef, {
            span: Object.freeze({
              evidenceRef: result.evidenceRef,
              memoryIds: Object.freeze([memoryId]),
              content: result.content,
              contentHash: result.contentHash,
            }),
            memoryIds: new Set([memoryId]),
          });
        }
      }
    }
    searchedSpans.push(
      ...[...spanByRef.values()].map(({ span, memoryIds }) =>
        Object.freeze({
          ...span,
          memoryIds: Object.freeze([...memoryIds]),
        }),
      ),
    );
  }
  const selectedIds = input.plan
    ? new Set(input.plan.coverage.flatMap((item) => item.memoryIds))
    : new Set([...evidenceById.keys()].slice(0, 12));
  let evidence = Object.freeze(
    [...new Set([...[...requirementL0Ids.values()].flat(), ...selectedIds])]
      .flatMap((id) => {
        const item = evidenceById.get(id);
        return item ? [item] : [];
      })
      .slice(0, 16),
  );
  const topicIds = new Set<string>();
  for (const item of input.plan?.coverage ?? []) {
    for (const topicId of item.topicIds) topicIds.add(topicId);
  }
  for (const state of input.topicPlan.evidenceStates) {
    if (selectedIds.has(state.memoryId)) topicIds.add(state.topicId);
  }
  const topics: MemoryResolvedContextTopicV1[] = [];
  if (input.dossierStore) {
    for (const topicId of [...topicIds].slice(0, 3)) {
      const catalogItem = input.catalog.find(
        (item) => item.projection.topic.id === topicId,
      );
      if (!catalogItem) continue;
      const dossier = await input.dossierStore.getCurrent(
        topicId,
        input.signal,
      );
      if (
        !dossier ||
        dossier.projectionHash !==
          catalogItem.projection.topic.projectionHash ||
        dossier.scopeFingerprint !== input.scopeFingerprint
      )
        continue;
      topics.push(
        Object.freeze({
          topicId,
          name: catalogItem.projection.topic.canonicalName,
          family: catalogItem.projection.topic.family,
          dossierId: dossier.id,
          currentConclusions: Object.freeze(
            dossier.currentConclusions.slice(0, 12),
          ),
          evolutions: Object.freeze(dossier.evolutions.slice(0, 6)),
          conflicts: Object.freeze(dossier.conflicts.slice(0, 4)),
        }),
      );
    }
  }
  let spans = input.plan
    ? boundCombinedSpans(
        [...searchedSpans, ...input.plan.spans],
        input.maxRawSpans,
        input.maxRawChars,
      )
    : Object.freeze([] as MemoryRawEvidenceSpanV1[]);
  if (!input.plan && input.archive) {
    const requests = evidence
      .flatMap((item) =>
        item.evidenceRefs.map((evidenceRef) => ({
          evidenceRef,
          memoryIds: [item.memoryId],
        })),
      )
      .slice(0, input.maxRawSpans);
    const resolved = await input.archive.resolve(requests, input.signal);
    spans = boundMemoryRawEvidenceSpansV1({
      requests,
      resolved,
      maxSpans: input.maxRawSpans,
      maxChars: input.maxRawChars,
    }).spans;
  }
  const plannedRequirements = Object.freeze(
    (input.plan?.requirements ?? []).map((requirement) => {
      const coverage = input.plan?.coverage.find(
        (item) => item.requirementId === requirement.requirementId,
      );
      return Object.freeze({
        requirementId: requirement.requirementId,
        description: requirement.description,
        priority: requirement.priority,
        minimumEvidence: requirement.minimumEvidence,
        evidenceUse: "fact" as const,
        status: coverage?.status ?? "missing",
        selectedEvidenceCount:
          (coverage?.memoryIds.length ?? 0) +
          (requirementL0Ids.get(requirement.requirementId)?.length ?? 0),
        candidateMemoryIds: Object.freeze([
          ...new Set([
            ...(requirementL0Ids.get(requirement.requirementId) ?? []),
            ...(coverage?.memoryIds ?? []),
          ]),
        ]),
      });
    }),
  );
  let verificationResult: MemoryEvidenceSupportVerificationV1 | undefined;
  let verificationError: string | undefined;
  if (
    input.verifier &&
    input.plan &&
    plannedRequirements.length > 0 &&
    evidence.length > 0 &&
    spans.length > 0
  ) {
    try {
      verificationResult = await input.verifier.verify(
        {
          query: input.query,
          requirements: plannedRequirements.map((item) => ({
            requirementId: item.requirementId,
            description: item.description,
            priority: item.priority,
            minimumEvidence: item.minimumEvidence,
            candidateMemoryIds: item.candidateMemoryIds,
          })),
          evidence: evidence.map((item) => ({
            memoryId: item.memoryId,
            layer: item.layer,
            statement: item.statement,
            ...(item.state === undefined ? {} : { state: item.state }),
            ...(item.validFrom === undefined
              ? {}
              : { validFrom: item.validFrom }),
          })),
          spans,
        },
        input.signal,
      );
    } catch (error) {
      if (input.signal.aborted || isAbort(error)) throw abortError();
      verificationError = stableErrorCode(error);
    }
  }
  const assessmentByRequirement = new Map(
    (verificationResult?.assessments ?? []).map(
      (item) => [item.requirementId, item] as const,
    ),
  );
  const requirements = Object.freeze(
    plannedRequirements.map((requirement) => {
      const assessment = assessmentByRequirement.get(requirement.requirementId);
      if (!input.verifier) {
        return Object.freeze({
          requirementId: requirement.requirementId,
          description: requirement.description,
          priority: requirement.priority,
          minimumEvidence: requirement.minimumEvidence,
          evidenceUse: requirement.evidenceUse,
          status: requirement.status,
          selectedEvidenceCount: requirement.selectedEvidenceCount,
          supportingMemoryIds: requirement.candidateMemoryIds,
          contradictingMemoryIds: Object.freeze([] as string[]),
          unknownMemoryIds: Object.freeze([] as string[]),
        });
      }
      if (!assessment) {
        return Object.freeze({
          requirementId: requirement.requirementId,
          description: requirement.description,
          priority: requirement.priority,
          minimumEvidence: requirement.minimumEvidence,
          evidenceUse: requirement.evidenceUse,
          status:
            requirement.selectedEvidenceCount > 0
              ? ("partial" as const)
              : ("missing" as const),
          selectedEvidenceCount: requirement.selectedEvidenceCount,
          supportingMemoryIds: Object.freeze([] as string[]),
          contradictingMemoryIds: Object.freeze([] as string[]),
          unknownMemoryIds: requirement.candidateMemoryIds,
        });
      }
      return verifiedRequirement(requirement, assessment);
    }),
  );
  const supportingIds = new Set(
    requirements.flatMap((item) => item.supportingMemoryIds),
  );
  const contradictingIds = new Set(
    requirements.flatMap((item) => item.contradictingMemoryIds),
  );
  if (verificationResult) {
    evidence = Object.freeze(
      evidence
        .map((item) =>
          Object.freeze({
            ...item,
            supportRole: supportingIds.has(item.memoryId)
              ? ("supporting" as const)
              : contradictingIds.has(item.memoryId)
                ? ("contradicting" as const)
                : ("contextual" as const),
          }),
        )
        .sort(
          (left, right) =>
            supportRoleWeight(left.supportRole) -
              supportRoleWeight(right.supportRole) ||
            left.memoryId.localeCompare(right.memoryId),
        ),
    );
    const supportingSpanHashes = new Set(
      verificationResult.assessments.flatMap(
        (item) => item.supportingSpanHashes,
      ),
    );
    const contradictingSpanHashes = new Set(
      verificationResult.assessments.flatMap(
        (item) => item.contradictingSpanHashes,
      ),
    );
    spans = Object.freeze(
      [...spans].sort(
        (left, right) =>
          spanSupportWeight(
            left.contentHash,
            supportingSpanHashes,
            contradictingSpanHashes,
          ) -
            spanSupportWeight(
              right.contentHash,
              supportingSpanHashes,
              contradictingSpanHashes,
            ) || left.evidenceRef.localeCompare(right.evidenceRef),
      ),
    );
  }
  const verification = Object.freeze({
    status: verificationResult
      ? ("verified" as const)
      : input.verifier
        ? ("failed" as const)
        : ("not_configured" as const),
    ...(verificationResult === undefined
      ? {}
      : {
          verifierVersion: verificationResult.verifierVersion,
          verificationRevision: verificationResult.verificationRevision,
        }),
    supportingCount: supportingIds.size,
    contradictionCount: contradictingIds.size,
    unknownCount: new Set(requirements.flatMap((item) => item.unknownMemoryIds))
      .size,
    ...(verificationError === undefined
      ? {}
      : { reasonCode: verificationError }),
  });
  const required = requirements.filter((item) => item.priority === "required");
  const stop =
    evidence.length === 0
      ? ("missing" as const)
      : input.plan &&
          required.every((item) => item.status === "covered") &&
          spans.length > 0
        ? ("sufficient" as const)
        : input.plan && required.every((item) => item.status === "missing")
          ? ("missing" as const)
          : ("partial" as const);
  const body = {
    schemaVersion: "paw.memory-resolved-context.v2" as const,
    resolverVersion: PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
    mode: input.plan
      ? ("planned" as const)
      : ("deterministic_fallback" as const),
    stop,
    requirements,
    verification,
    evidence,
    topics: Object.freeze(topics),
    spans: Object.freeze(spans),
  };
  return Object.freeze({
    ...body,
    packetRevision: hashCanonicalJsonV1({
      ...body,
      queryHash: hashTextV1(input.query),
      spans: body.spans.map((span) => ({
        evidenceRef: span.evidenceRef,
        memoryIds: span.memoryIds,
        contentHash: span.contentHash,
      })),
    } as unknown as JsonValue),
  });
}

function verifiedRequirement(
  requirement: Readonly<{
    requirementId: string;
    description: string;
    priority: "required" | "supporting";
    minimumEvidence: number;
    evidenceUse: "fact";
    status: "covered" | "partial" | "missing";
    selectedEvidenceCount: number;
    candidateMemoryIds: readonly string[];
  }>,
  assessment: MemoryEvidenceSupportAssessmentV1,
) {
  const status =
    assessment.supportingMemoryIds.length >= requirement.minimumEvidence &&
    assessment.contradictingMemoryIds.length === 0
      ? ("covered" as const)
      : assessment.supportingMemoryIds.length > 0 ||
          assessment.contradictingMemoryIds.length > 0
        ? ("partial" as const)
        : ("missing" as const);
  return Object.freeze({
    requirementId: requirement.requirementId,
    description: requirement.description,
    priority: requirement.priority,
    minimumEvidence: requirement.minimumEvidence,
    evidenceUse: requirement.evidenceUse,
    status,
    selectedEvidenceCount: requirement.selectedEvidenceCount,
    supportingMemoryIds: assessment.supportingMemoryIds,
    contradictingMemoryIds: assessment.contradictingMemoryIds,
    unknownMemoryIds: assessment.unknownMemoryIds,
  });
}

function supportRoleWeight(
  role: NonNullable<MemoryResolvedContextEvidenceV1["supportRole"]>,
): number {
  if (role === "supporting") return 0;
  if (role === "contradicting") return 1;
  return 2;
}

function spanSupportWeight(
  contentHash: string,
  supporting: ReadonlySet<string>,
  contradicting: ReadonlySet<string>,
): number {
  if (supporting.has(contentHash)) return 0;
  if (contradicting.has(contentHash)) return 1;
  return 2;
}

function boundCombinedSpans(
  spans: readonly MemoryRawEvidenceSpanV1[],
  maxSpans: number,
  maxChars: number,
): readonly MemoryRawEvidenceSpanV1[] {
  const byEvidence = new Map<
    string,
    { span: MemoryRawEvidenceSpanV1; memoryIds: Set<string> }
  >();
  for (const span of spans) {
    const key = `${span.evidenceRef}\0${span.contentHash}`;
    const existing = byEvidence.get(key);
    if (existing) {
      for (const memoryId of span.memoryIds) existing.memoryIds.add(memoryId);
      continue;
    }
    byEvidence.set(key, { span, memoryIds: new Set(span.memoryIds) });
  }
  const result: MemoryRawEvidenceSpanV1[] = [];
  let usedChars = 0;
  for (const { span, memoryIds } of byEvidence.values()) {
    if (result.length >= maxSpans) break;
    const remaining = maxChars - usedChars;
    if (remaining < 64) break;
    const content = span.content.slice(0, remaining);
    result.push(
      Object.freeze({
        evidenceRef: span.evidenceRef,
        memoryIds: Object.freeze([...memoryIds]),
        content,
        contentHash: hashTextV1(content),
      }),
    );
    usedChars += content.length;
  }
  return Object.freeze(result);
}

function coverageSnapshot(
  queryId: string,
  providerVersion: string,
  cards: readonly MemoryCardV1[],
  topicPlan: ReturnType<typeof planMemoryTopicEvidenceV1>,
): SessionInputSnapshot<InputFactV1> {
  return Object.freeze({
    entries: Object.freeze([
      {
        seq: 1,
        fact: {
          type: "memory.retrieval_settled",
          queryId,
          trigger: "task_start",
          providerVersion,
          policyVersion: "paw.memory-retrieval.v1",
          status: "completed",
          cards,
        } satisfies InputFactV1,
      },
      {
        seq: 2,
        fact: {
          type: "memory.topic_evidence_settled",
          queryId,
          plannerVersion: topicPlan.plannerVersion,
          scopeFingerprint: topicPlan.scopeFingerprint,
          status: topicPlan.evidenceStates.length > 0 ? "completed" : "noop",
          indexRevision: topicPlan.indexRevision,
          indexEntries: topicPlan.indexEntries,
          evidenceStates: topicPlan.evidenceStates,
          ...(topicPlan.evidenceStates.length > 0
            ? {}
            : { reasonCode: "memory_topic_no_matching_evidence" }),
          settledAt: 0,
        } satisfies InputFactV1,
      },
    ]),
    tailSeq: 2,
    latestInputSeq: 2,
  });
}

function topicStateEvidence(
  state: MemoryTopicEvidenceStateV1,
): MemoryResolvedContextEvidenceV1 {
  return Object.freeze({
    memoryId: state.memoryId,
    layer: "L2",
    statement: state.statement,
    evidenceUse: "fact",
    state: state.state,
    evidenceRefs: state.evidenceRefs,
  });
}

function toolQuery(
  text: string,
  profile: PawNextMemoryPluginProfileV1,
): MemoryProviderQueryV1 {
  const inputContentHash = hashTextV1(text);
  const searchTexts = createMemorySearchTextsV1(undefined, text);
  const queryId = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-context-resolver-query.v1",
    inputContentHash,
    providerVersion: profile.providerVersion,
    scopeFingerprint: memoryScopeFingerprintV1(profile.scope),
    maxCards: 8,
    searchTexts,
  } as unknown as JsonValue);
  return Object.freeze({
    queryId,
    trigger: "task_start",
    text,
    searchTexts,
    inputId: `memory-resolver:${queryId.slice(0, 24)}`,
    inputContentHash,
    scope: profile.scope,
    maxCards: 8,
    maxInjectedTokens: profile.maxInjectedTokens,
  });
}

function assertScope(
  scope: PawNextMemoryPluginProfileV1["scope"],
  expected: string,
): void {
  if (memoryScopeFingerprintV1(scope) !== expected)
    throw namedError("MemoryContextResolverScopeMismatch");
}

function boundedText(value: string, max: number, name: string): string {
  const text = value.trim();
  if (!text || text.length > max) throw namedError(name);
  return text;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function stableErrorCode(error: unknown): string {
  const value =
    error instanceof Error ? error.name || error.message : String(error);
  return (
    value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) ||
    "MemoryContextResolverUnknown"
  );
}

function abortError(): Error {
  const error = new Error("Memory context resolution aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
