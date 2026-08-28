import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import {
  type MemoryEvidenceCandidateFusionV2,
  type MemoryEvidenceCandidateRankListV2,
  type MemoryEvidenceNotebookHitV1,
  type MemoryEvidenceNotebookV1,
  PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
  PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
  type RankedMemoryEvidenceSourceV2,
  buildMemoryEvidenceNotebookV1,
  memoryEvidenceOrdinalAnchorScoreV1,
  memoryEvidenceSupportScoreV1,
  projectMemoryEvidenceExcerptV1,
  rankMemoryEvidenceCandidatesV2,
} from "./evidence-first.js";
import {
  type MemoryEvidenceQueryIntentV3,
  type MemoryEvidenceQueryPlannerV3,
  type MemoryEvidenceRequirementV3,
  classifyMemoryEvidenceQueryV3,
} from "./evidence-query-planner.js";
import type {
  MemoryEvidenceSupportSelectorV1,
  MemoryEvidenceTriageAssessmentV1,
} from "./evidence-support-selector.js";

export const PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1 =
  "paw.memory-evidence-resolver.v5:planned-discovery-source-lock" as const;

export interface MemoryEvidenceIndexSearchResultV1 {
  readonly lists: readonly MemoryEvidenceCandidateRankListV2[];
  /** Hydrated exact evidence keyed by evidenceRef. */
  readonly hits: readonly MemoryEvidenceNotebookHitV1[];
  /** A failed channel may degrade independently without discarding the other. */
  readonly degradedChannels?: readonly ("l0" | "l1")[];
}

export interface MemoryEvidenceIndexV1 {
  readonly indexVersion: string;
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<MemoryEvidenceIndexSearchResultV1>;
}

export interface MemoryEvidenceResolutionV1 {
  readonly resolverVersion: typeof PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1;
  readonly indexVersion: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly directCertificateStatus:
    | "deterministic_direct"
    | "missing"
    | "not_applicable";
  readonly plannerStatus: "not_needed" | "completed" | "fallback";
  readonly supportSelectorStatus:
    | "not_needed"
    | "not_configured"
    | "completed"
    | "fallback";
  readonly supportSelectionRevision?: string;
  readonly supportSelectorVersion?: string;
  readonly supportAssessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  readonly degradedChannels: readonly ("l0" | "l1")[];
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly sources: readonly RankedMemoryEvidenceSourceV2[];
  readonly primaryHits: readonly MemoryEvidenceNotebookHitV1[];
  /** Canonical model-facing packet shared by product and benchmark adapters. */
  readonly packetSources: readonly Readonly<{
    sourceId: string;
    text: string;
    evidenceRefs: readonly string[];
    answerRole: "current" | "ambiguous" | "supporting" | "candidate" | "mixed";
  }>[];
  readonly telemetry: MemoryEvidenceCandidateFusionV2["telemetry"];
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly resolutionRevision: string;
}

/**
 * Shared plugin-owned evidence pipeline. The caller query and bounded planner
 * requirements participate in one capped discovery fusion, after which the
 * source set is locked. The selector can bind supplied evidence addresses but
 * cannot introduce a source, address, or search of its own.
 */
export function createMemoryEvidenceResolverV1(input: {
  readonly index: MemoryEvidenceIndexV1;
  readonly planner?: MemoryEvidenceQueryPlannerV3;
  readonly supportSelector?: MemoryEvidenceSupportSelectorV1;
  readonly maxSources?: number;
  /** Exact addresses retained inside each selected source before hydration. */
  readonly maxEvidencePerSource?: number;
  readonly maxHitsPerRequirement?: number;
  readonly maxNotebookChars?: number;
}): Readonly<{
  resolverVersion: typeof PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1;
  resolve(
    query: string,
    signal: AbortSignal,
  ): Promise<MemoryEvidenceResolutionV1>;
}> {
  const maxSources = boundedInteger(input.maxSources ?? 8, 1, 16);
  const maxEvidencePerSource = boundedInteger(
    input.maxEvidencePerSource ?? 8,
    1,
    16,
  );
  const maxHitsPerRequirement = boundedInteger(
    input.maxHitsPerRequirement ?? 2,
    1,
    4,
  );
  const maxNotebookChars = boundedInteger(
    input.maxNotebookChars ?? 4_096,
    256,
    16_384,
  );
  return Object.freeze({
    resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
    async resolve(query: string, signal: AbortSignal) {
      const value = boundedQuery(query);
      const intent = classifyMemoryEvidenceQueryV3(value);
      const primary = await input.index.search(value, signal);
      const primaryFusion = rankMemoryEvidenceCandidatesV2({
        lists: primary.lists,
        maxSources,
        maxEvidencePerSource,
      });
      const directCertificateStatus: MemoryEvidenceResolutionV1["directCertificateStatus"] =
        intent.needsPlanning
          ? "not_applicable"
          : hasDeterministicDirectCertificate(
                value,
                primary.hits,
                primaryFusion.sources.map((source) => source.sourceId),
                intent.roleConstraint === "assistant",
              )
            ? "deterministic_direct"
            : "missing";
      let requirements: readonly MemoryEvidenceRequirementV3[] = [];
      let plannerStatus: MemoryEvidenceResolutionV1["plannerStatus"] =
        intent.needsPlanning ? "fallback" : "not_needed";
      const shouldPlan =
        input.planner !== undefined &&
        (intent.needsPlanning ||
          directCertificateStatus !== "deterministic_direct");
      if (shouldPlan && input.planner) {
        try {
          const plan = await input.planner.plan(value, signal, {
            force: !intent.needsPlanning,
          });
          if (plan.requirements.length === 0) {
            throw namedError("MemoryEvidenceQueryPlanRequirementsEmpty");
          }
          requirements = plan.requirements;
          plannerStatus = "completed";
        } catch (error) {
          if (signal.aborted || isAbort(error)) throw abortError();
          plannerStatus = "fallback";
        }
      }
      // An empty requirement set must not turn a many-source lookup into an
      // unverified "sufficient" packet. Keep a one-source exact fast path;
      // otherwise bind the original question as one root requirement and run
      // the same support gate used by decomposed queries.
      if (requirements.length === 0 && input.supportSelector) {
        requirements = Object.freeze([
          createRootEvidenceRequirement(value, intent),
        ]);
      }
      const supplemental = await Promise.all(
        requirements.map((requirement) =>
          requirement.searchText === value
            ? Promise.resolve(primary)
            : input.index.search(requirement.searchText, signal),
        ),
      );
      const discoveryResults: Array<
        Readonly<{
          searchText: string;
          result: MemoryEvidenceIndexSearchResultV1;
        }>
      > = [{ searchText: value, result: primary }];
      const seenDiscoveryTexts = new Set([value]);
      for (const [index, requirement] of requirements.entries()) {
        if (seenDiscoveryTexts.has(requirement.searchText)) continue;
        const result = supplemental[index];
        if (!result) throw namedError("MemoryEvidenceDiscoveryMissing");
        seenDiscoveryTexts.add(requirement.searchText);
        discoveryResults.push({
          searchText: requirement.searchText,
          result,
        });
      }
      const fusion = rankMemoryEvidenceCandidatesV2({
        lists: discoveryResults.flatMap(({ result }, searchIndex) =>
          result.lists.map((list, listIndex) => ({
            ...list,
            retrieverId: `${list.retrieverId}:discovery-${searchIndex}-${listIndex}`,
            // The caller query remains authoritative while repeated support
            // across bounded obligations can promote an otherwise missed source.
            weight: list.weight * (searchIndex === 0 ? 1 : 0.8),
          })),
        ),
        maxSources,
        maxEvidencePerSource,
      });
      const degradedChannels = Object.freeze(
        [
          ...new Set(
            discoveryResults.flatMap(
              ({ result }) => result.degradedChannels ?? [],
            ),
          ),
        ].sort(),
      ) as readonly ("l0" | "l1")[];
      const sourceIds = fusion.sources.map((source) => source.sourceId);
      const requirementHits = requirements.map((_, index) =>
        mergeEvidenceHits(supplemental[index]?.hits ?? [], primary.hits),
      );
      let supportSelectorStatus: MemoryEvidenceResolutionV1["supportSelectorStatus"] =
        requirements.length === 0
          ? "not_needed"
          : input.supportSelector
            ? "fallback"
            : "not_configured";
      let supportSelectionRevision: string | undefined;
      let supportAssessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[] =
        Object.freeze([]);
      let selectedRefsByRequirement:
        | ReadonlyMap<string, ReadonlySet<string>>
        | undefined;
      if (requirements.length > 0 && input.supportSelector) {
        const candidates = selectSupportCandidates(
          requirementHits,
          sourceIds,
          intent.roleConstraint === "assistant",
          32,
        );
        if (candidates.length > 0) {
          try {
            const selection = await input.supportSelector.select(
              { query: value, requirements, candidates },
              signal,
            );
            selectedRefsByRequirement = new Map(
              selection.assessments.map((assessment) => [
                assessment.requirementId,
                new Set(assessment.supportingEvidenceRefs),
              ]),
            );
            supportAssessments = selection.assessments;
            supportSelectionRevision = selection.selectionRevision;
            supportSelectorStatus = "completed";
          } catch (error) {
            if (signal.aborted || isAbort(error)) throw abortError();
            supportSelectorStatus = "fallback";
          }
        }
      }
      const notebook = buildMemoryEvidenceNotebookV1({
        requirements: requirements.map((requirement, index) => ({
          requirementId: requirement.requirementId,
          label: requirement.label,
          searchText: requirement.searchText,
          selection:
            requirement.temporalMode === "latest" ? "latest" : "ranked",
          relation: requirement.relation ?? "direct",
          coverageMode:
            requirement.coverageMode ??
            (requirement.temporalMode === "latest" ? "latest" : "any"),
          minimumEvidence: requirement.minimumEvidence ?? 1,
          hits: filterRequirementHits(
            requirementHits[index] ?? [],
            selectedRefsByRequirement?.get(requirement.requirementId),
          ),
        })),
        allowedSourceIds: sourceIds,
        maxHitsPerRequirement,
        maxChars: maxNotebookChars,
        allowContextOnly: intent.roleConstraint === "assistant",
      });
      const nonSupportingRefs = new Set(
        supportAssessments.flatMap((assessment) => [
          ...assessment.contradictingEvidenceRefs,
          ...assessment.unknownEvidenceRefs,
        ]),
      );
      const packetFallbackHits = mergeEvidenceHits(
        requirementHits
          .flat()
          .filter((hit) => nonSupportingRefs.has(hit.evidenceRef)),
        primary.hits,
      );
      const packetSources =
        requirements.length > 0
          ? buildPlannedEvidencePacketSources({
              query: value,
              notebook,
              primaryHits: packetFallbackHits,
              selectedSourceIds: sourceIds,
              allowContextOnly: intent.roleConstraint === "assistant",
              includeFallback:
                intent.temporalMode !== "latest" ||
                notebook.coverage.some((item) => item.status !== "covered") ||
                nonSupportingRefs.size > 0,
              maxFallbackChars: maxNotebookChars,
            })
          : buildPrimaryEvidencePacketSources(
              primary.hits,
              sourceIds,
              intent.roleConstraint === "assistant",
              2,
              maxNotebookChars,
              new Set(),
              "supporting",
              value,
            );
      const revisionBody = {
        resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
        indexVersion: input.index.indexVersion,
        fusionVersion: PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
        notebookVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
        intent,
        directCertificateStatus,
        plannerStatus,
        supportSelectorStatus,
        supportAssessments,
        degradedChannels,
        ...(input.supportSelector === undefined
          ? {}
          : { supportSelectorVersion: input.supportSelector.selectorVersion }),
        ...(supportSelectionRevision === undefined
          ? {}
          : { supportSelectionRevision }),
        requirements: requirements.map(({ searchText, ...requirement }) => ({
          ...requirement,
          searchTextHash: hashCanonicalJsonV1(searchText as JsonValue),
        })),
        sources: fusion.sources.map((source) => ({
          sourceId: source.sourceId,
          evidenceRefs: source.evidence.map((item) => item.evidenceRef),
        })),
        coverage: notebook.coverage,
        packetSources: packetSources.map((source) => ({
          sourceId: source.sourceId,
          evidenceRefs: source.evidenceRefs,
        })),
      };
      return Object.freeze({
        resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
        indexVersion: input.index.indexVersion,
        intent,
        directCertificateStatus,
        plannerStatus,
        supportSelectorStatus,
        supportAssessments,
        degradedChannels,
        ...(input.supportSelector === undefined
          ? {}
          : { supportSelectorVersion: input.supportSelector.selectorVersion }),
        ...(supportSelectionRevision === undefined
          ? {}
          : { supportSelectionRevision }),
        requirements,
        sources: fusion.sources,
        primaryHits: primary.hits,
        packetSources,
        telemetry: fusion.telemetry,
        notebook,
        resolutionRevision: hashCanonicalJsonV1(
          revisionBody as unknown as JsonValue,
        ),
      });
    },
  });
}

function createRootEvidenceRequirement(
  query: string,
  intent: MemoryEvidenceQueryIntentV3,
): MemoryEvidenceRequirementV3 {
  return Object.freeze({
    requirementId: "root-requirement",
    label: query.slice(0, 192),
    searchText: query.slice(0, 192),
    temporalMode: intent.temporalMode,
    roleConstraint: intent.roleConstraint,
    relation:
      intent.temporalMode === "latest"
        ? "temporal"
        : intent.answerShape === "compare" || intent.answerShape === "aggregate"
          ? "comparative"
          : "direct",
    coverageMode: intent.temporalMode === "latest" ? "latest" : "any",
    minimumEvidence: 1,
  });
}

function selectSupportCandidates(
  requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[],
  selectedSourceIds: readonly string[],
  allowContextOnly: boolean,
  maximum: number,
): readonly MemoryEvidenceNotebookHitV1[] {
  const allowed = new Set(selectedSourceIds);
  const rows = requirementHits.map((hits) =>
    hits.filter(
      (hit) =>
        allowed.has(hit.sourceId) &&
        (hit.authority !== "context_only" || allowContextOnly),
    ),
  );
  const output: MemoryEvidenceNotebookHitV1[] = [];
  const seen = new Set<string>();
  for (let rank = 0; output.length < maximum; rank += 1) {
    let found = false;
    for (const hits of rows) {
      const hit = hits[rank];
      if (!hit) continue;
      found = true;
      if (seen.has(hit.evidenceRef)) continue;
      seen.add(hit.evidenceRef);
      output.push(hit);
      if (output.length >= maximum) break;
    }
    if (!found) break;
  }
  return Object.freeze(output);
}

function filterRequirementHits(
  hits: readonly MemoryEvidenceNotebookHitV1[],
  selectedRefs: ReadonlySet<string> | undefined,
): readonly MemoryEvidenceNotebookHitV1[] {
  if (selectedRefs === undefined) return hits;
  return Object.freeze(hits.filter((hit) => selectedRefs.has(hit.evidenceRef)));
}

function buildPrimaryEvidencePacketSources(
  hits: readonly MemoryEvidenceNotebookHitV1[],
  selectedSourceIds: readonly string[],
  allowContextOnly: boolean,
  maxHitsPerSource: number,
  maxChars: number,
  excludedEvidenceRefs: ReadonlySet<string> = new Set(),
  answerRole: "supporting" | "candidate" = "supporting",
  query = "",
  fairShare = false,
): readonly Readonly<{
  sourceId: string;
  text: string;
  evidenceRefs: readonly string[];
  answerRole: "supporting" | "candidate";
}>[] {
  const output: Array<{
    sourceId: string;
    text: string;
    evidenceRefs: readonly string[];
    answerRole: "supporting" | "candidate";
  }> = [];
  let chars = 0;
  const eligibleSourceIds = selectedSourceIds.filter((sourceId) =>
    hits.some(
      (hit) =>
        hit.sourceId === sourceId &&
        !excludedEvidenceRefs.has(hit.evidenceRef) &&
        (hit.authority !== "context_only" || allowContextOnly),
    ),
  );
  const fairSourceBudget = fairShare
    ? Math.floor(maxChars / Math.max(1, eligibleSourceIds.length))
    : maxChars;
  for (const sourceId of eligibleSourceIds) {
    const selected = hits
      .filter(
        (hit) =>
          hit.sourceId === sourceId &&
          !excludedEvidenceRefs.has(hit.evidenceRef) &&
          (hit.authority !== "context_only" || allowContextOnly),
      )
      .map((hit, rank) => ({
        hit,
        rank,
        ordinalScore: memoryEvidenceOrdinalAnchorScoreV1(hit.content, query),
      }))
      .sort(
        (left, right) =>
          right.ordinalScore - left.ordinalScore || left.rank - right.rank,
      )
      .slice(0, maxHitsPerSource);
    if (selected.length === 0) continue;
    const fixedParts = selected.map(
      ({ hit }) =>
        `[authority=${hit.authority}; observed=${hit.observedAt ?? "unknown"}; evidence=${hit.evidenceRef}]`,
    );
    const fixedChars =
      "[Primary exact memory evidence]".length +
      fixedParts.reduce((total, part) => total + part.length, 0) +
      selected.length * 3 +
      Math.max(0, selected.length - 1) * 2;
    const contentBudget = Math.max(
      128,
      Math.floor((fairSourceBudget - fixedChars) / selected.length),
    );
    const text = [
      "[Primary exact memory evidence]",
      ...selected.map(
        ({ hit }, index) =>
          `${fixedParts[index]}\n${
            fairShare
              ? projectMemoryEvidenceExcerptV1(
                  hit.content,
                  query,
                  Math.min(16_384, contentBudget),
                )
              : hit.content
          }`,
      ),
    ].join("\n\n");
    if (chars + text.length > maxChars) continue;
    output.push({
      sourceId,
      text,
      evidenceRefs: Object.freeze(selected.map(({ hit }) => hit.evidenceRef)),
      answerRole,
    });
    chars += text.length;
  }
  return Object.freeze(output.map((item) => Object.freeze(item)));
}

function buildPlannedEvidencePacketSources(input: {
  readonly query: string;
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly primaryHits: readonly MemoryEvidenceNotebookHitV1[];
  readonly selectedSourceIds: readonly string[];
  readonly allowContextOnly: boolean;
  readonly includeFallback: boolean;
  readonly maxFallbackChars: number;
}): MemoryEvidenceResolutionV1["packetSources"] {
  if (!input.includeFallback) return input.notebook.sources;
  const selectedRefs = new Set(
    input.notebook.coverage.flatMap((item) => item.selectedEvidenceRefs),
  );
  const fallback = buildPrimaryEvidencePacketSources(
    input.primaryHits,
    input.selectedSourceIds,
    input.allowContextOnly,
    1,
    input.maxFallbackChars,
    selectedRefs,
    "candidate",
    input.query,
    true,
  );
  const bySource = new Map<
    string,
    {
      parts: string[];
      evidenceRefs: string[];
      answerRoles: Set<
        "current" | "ambiguous" | "supporting" | "candidate" | "mixed"
      >;
    }
  >();
  for (const source of [...input.notebook.sources, ...fallback]) {
    const current = bySource.get(source.sourceId) ?? {
      parts: [],
      evidenceRefs: [],
      answerRoles: new Set(),
    };
    current.parts.push(source.text);
    current.evidenceRefs.push(...source.evidenceRefs);
    current.answerRoles.add(source.answerRole);
    bySource.set(source.sourceId, current);
  }
  const orderedIds = [
    ...input.selectedSourceIds,
    ...input.notebook.sources.map((source) => source.sourceId),
  ];
  return Object.freeze(
    [...new Set(orderedIds)].flatMap((sourceId) => {
      const value = bySource.get(sourceId);
      if (!value) return [];
      return [
        Object.freeze({
          sourceId,
          text: value.parts.join("\n\n[Bounded primary fallback]\n"),
          evidenceRefs: Object.freeze([...new Set(value.evidenceRefs)]),
          answerRole: singleAnswerRole(value.answerRoles),
        }),
      ];
    }),
  );
}

function singleAnswerRole<T extends string>(
  roles: ReadonlySet<T>,
): T | "mixed" {
  return roles.size === 1 ? (roles.values().next().value ?? "mixed") : "mixed";
}

function mergeEvidenceHits(
  focused: readonly MemoryEvidenceNotebookHitV1[],
  primary: readonly MemoryEvidenceNotebookHitV1[],
): readonly MemoryEvidenceNotebookHitV1[] {
  const output: MemoryEvidenceNotebookHitV1[] = [];
  const seenRefs = new Set<string>();
  const seenContent = new Set<string>();
  for (const hit of [...focused, ...primary]) {
    const evidenceRef = hit.evidenceRef.trim();
    const content = hit.content.trim().replace(/\s+/gu, " ");
    const contentKey = `${hit.sourceId.trim()}\0${content}`;
    if (
      !evidenceRef ||
      !content ||
      seenRefs.has(evidenceRef) ||
      seenContent.has(contentKey)
    ) {
      continue;
    }
    seenRefs.add(evidenceRef);
    seenContent.add(contentKey);
    output.push(hit);
  }
  return Object.freeze(output);
}

function hasDeterministicDirectCertificate(
  query: string,
  hits: readonly MemoryEvidenceNotebookHitV1[],
  selectedSourceIds: readonly string[],
  allowContextOnly: boolean,
): boolean {
  const allowed = new Set(selectedSourceIds);
  const scoreBySource = new Map<string, number>();
  for (const hit of hits) {
    const sourceId = hit.sourceId.trim();
    if (
      !allowed.has(sourceId) ||
      !hit.evidenceRef.trim() ||
      !hit.content.trim() ||
      (hit.authority === "context_only" && !allowContextOnly)
    ) {
      continue;
    }
    const score = memoryEvidenceSupportScoreV1(query, hit.content);
    scoreBySource.set(
      sourceId,
      Math.max(scoreBySource.get(sourceId) ?? 0, score),
    );
  }
  const scores = [...scoreBySource.values()].sort(
    (left, right) => right - left,
  );
  const best = scores[0] ?? 0;
  const runnerUp = scores[1] ?? 0;
  // This is intentionally a narrow, deterministic certificate: a hydrated
  // exact address must contain meaningful query evidence and be materially
  // stronger than every competing source. Anything ambiguous pays for the
  // bounded planner instead of being declared sufficient by source count.
  return best >= 4 && (scores.length === 1 || best >= runnerUp + 2);
}

function boundedQuery(query: string): string {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryEvidenceResolverQueryInvalid");
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw namedError("MemoryEvidenceResolverBudgetInvalid");
  }
  return value;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function abortError(): Error {
  return namedError("AbortError");
}
