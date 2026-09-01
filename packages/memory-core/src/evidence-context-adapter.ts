import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import {
  type MemoryContextResolverV1,
  type MemoryRawEvidenceSpanV1,
  type MemoryResolvedContextPacketV1,
  PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
} from "./context-contract.js";
import {
  type MemoryEvidenceAnswerPolicyV1,
  createMemoryEvidenceAnswerPolicyV1,
} from "./evidence-answer-policy.js";
import type {
  MemoryEvidenceBindingV1,
  MemoryEvidenceDispositionBindingV1,
  MemoryEvidenceUseV1,
} from "./evidence-origin.js";
import type { MemoryEvidenceResolutionV1 } from "./evidence-resolver.js";

export const PAW_MEMORY_EVIDENCE_ANSWER_CONTRACT_VERSION_V1 =
  "paw.memory-evidence-answer-contract.v3:requirement-evidence-ledger" as const;

export interface MemoryEvidenceAnswerContractV1 {
  readonly schemaVersion: typeof PAW_MEMORY_EVIDENCE_ANSWER_CONTRACT_VERSION_V1;
  readonly answerShape: MemoryEvidenceResolutionV1["intent"]["answerShape"];
  readonly temporalMode: MemoryEvidenceResolutionV1["intent"]["temporalMode"];
  readonly roleConstraint: MemoryEvidenceResolutionV1["intent"]["roleConstraint"];
  readonly evidenceStatus: MemoryResolvedContextPacketV1["stop"];
  readonly answerPolicy: MemoryEvidenceAnswerPolicyV1;
  readonly evidenceBindings: readonly MemoryEvidenceBindingV1[];
  readonly evidenceUses: readonly MemoryEvidenceUseV1[];
  readonly guidance: string;
  readonly requirements: readonly Readonly<{
    requirementId: string;
    description: string;
    relation: string;
    coverageMode: string;
    minimumEvidence: number;
    status: "covered" | "partial" | "missing";
    selectedEvidenceCount: number;
    supportingEvidenceRefs: readonly string[];
    candidateEvidenceRefs: readonly string[];
    contradictingEvidenceRefs: readonly string[];
    evidenceDispositions: readonly Readonly<MemoryEvidenceDispositionBindingV1>[];
  }>[];
}

export function createEvidenceFirstMemoryContextResolverV1(input: {
  readonly evidenceResolver: Readonly<{
    resolve(
      query: string,
      signal: AbortSignal,
    ): Promise<MemoryEvidenceResolutionV1>;
  }>;
}): MemoryContextResolverV1 {
  // Coalesce only concurrent identical reads. A settled packet must not
  // survive an evidence write while the index has no monotonic revision API.
  const inFlight = new Map<string, Promise<MemoryResolvedContextPacketV1>>();
  return Object.freeze({
    resolverVersion: PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
    async resolve(query: string, signal: AbortSignal) {
      const value = query.trim().replace(/\s+/gu, " ");
      if (!value || value.length > 8_192) {
        throw namedError("MemoryContextResolverQueryInvalid");
      }
      const key = hashTextV1(value);
      let pending = inFlight.get(key);
      if (!pending) {
        pending = input.evidenceResolver
          .resolve(value.slice(0, 512), signal)
          .then(projectEvidenceFirstMemoryContextPacketV1)
          .finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return pending;
    },
  });
}

export function projectEvidenceFirstMemoryContextPacketV1(
  resolution: MemoryEvidenceResolutionV1,
): MemoryResolvedContextPacketV1 {
  const contextSources = resolution.packetSources;
  const contextItems = contextSources.map((source) =>
    Object.freeze({
      source,
      memoryId: hashCanonicalJsonV1({
        schemaVersion: "paw.memory-evidence-context-item.v1",
        resolutionRevision: resolution.resolutionRevision,
        sourceId: source.sourceId,
        evidenceRefs: source.evidenceRefs,
        evidenceBindings: source.evidenceBindings,
        evidenceUses: source.evidenceUses,
      } as unknown as JsonValue),
    }),
  );
  const memoryIdByEvidenceRef = new Map<string, string>();
  for (const { source, memoryId } of contextItems) {
    for (const evidenceRef of source.evidenceRefs) {
      memoryIdByEvidenceRef.set(evidenceRef, memoryId);
    }
  }
  const evidence = Object.freeze(
    contextItems.map(({ source, memoryId }) =>
      Object.freeze({
        memoryId,
        layer: "L0" as const,
        statement: source.text,
        ...(source.answerRole === "current"
          ? { state: "current" as const }
          : {}),
        supportRole:
          source.answerRole === "candidate" || source.answerRole === "mixed"
            ? ("contextual" as const)
            : ("supporting" as const),
        evidenceRefs: source.evidenceRefs,
        evidenceBindings: source.evidenceBindings,
        evidenceUses: source.evidenceUses,
      }),
    ),
  );
  const requirements = Object.freeze(
    resolution.requirements.map((requirement) => {
      const coverage = resolution.notebook.coverage.find(
        (item) => item.requirementId === requirement.requirementId,
      );
      const assessment = resolution.supportAssessments.find(
        (item) => item.requirementId === requirement.requirementId,
      );
      const minimumEvidence = requirement.minimumEvidence ?? 1;
      const supportingMemoryIds = Object.freeze([
        ...new Set(
          (coverage?.selectedEvidenceRefs ?? []).flatMap((evidenceRef) => {
            const memoryId = memoryIdByEvidenceRef.get(evidenceRef);
            return memoryId ? [memoryId] : [];
          }),
        ),
      ]);
      const unknownEvidenceRefs = [
        ...(coverage?.unresolvedEvidenceRefs ?? []),
        ...(assessment?.unknownEvidenceRefs ?? []),
      ];
      const contradictingEvidenceRefs = [
        ...(assessment?.contradictingEvidenceRefs ?? []),
      ];
      const unknownMemoryIds = Object.freeze([
        ...new Set(
          unknownEvidenceRefs.flatMap((evidenceRef) => {
            const memoryId = memoryIdByEvidenceRef.get(evidenceRef);
            return memoryId ? [memoryId] : [];
          }),
        ),
      ]);
      const contradictingMemoryIds = Object.freeze([
        ...new Set(
          contradictingEvidenceRefs.flatMap((evidenceRef) => {
            const memoryId = memoryIdByEvidenceRef.get(evidenceRef);
            return memoryId ? [memoryId] : [];
          }),
        ),
      ]);
      const notebookStatus = coverage?.status ?? "missing";
      const status =
        notebookStatus === "covered" &&
        contradictingEvidenceRefs.length === 0 &&
        unknownEvidenceRefs.length === 0
          ? "covered"
          : notebookStatus !== "missing" ||
              contradictingEvidenceRefs.length > 0 ||
              unknownEvidenceRefs.length > 0
            ? "partial"
            : "missing";
      return Object.freeze({
        requirementId: requirement.requirementId,
        description: requirement.label,
        priority: "required" as const,
        minimumEvidence,
        status,
        selectedEvidenceCount: coverage?.closureEvidenceCount ?? 0,
        supportingMemoryIds,
        contradictingMemoryIds,
        unknownMemoryIds,
        evidenceDispositions: Object.freeze([
          ...(assessment?.evidenceDispositions ?? []),
        ]),
      });
    }),
  );
  const spans: readonly MemoryRawEvidenceSpanV1[] = Object.freeze(
    contextItems.map(({ source, memoryId }) =>
      Object.freeze({
        evidenceRef: `memory:notebook/${resolution.resolutionRevision}/${hashTextV1(source.sourceId).slice(0, 20)}`,
        memoryIds: Object.freeze([memoryId]),
        content: source.text,
        contentHash: hashTextV1(source.text),
      }),
    ),
  );
  const requiredCovered = requirements.every(
    (requirement) => requirement.status === "covered",
  );
  const supportVerified =
    resolution.supportSelectorStatus === "completed" &&
    resolution.supportSelectionRevision !== undefined &&
    resolution.degradedChannels.length === 0;
  const independentClosureVerified =
    resolution.closureAuditStatus === "not_configured" ||
    resolution.closureAuditStatus === "not_needed" ||
    (resolution.closureAuditStatus === "completed" &&
      resolution.closureVerdict === "pass");
  const planningExecutionVerified =
    !resolution.intent.needsPlanning ||
    resolution.plannerStatus === "completed" ||
    (resolution.closureAuditStatus === "completed" &&
      resolution.closureVerdict === "pass");
  const plannedClosureVerified =
    resolution.requirements.length > 0 &&
    requiredCovered &&
    supportVerified &&
    independentClosureVerified &&
    planningExecutionVerified;
  const supportingRefs = new Set(
    resolution.notebook.coverage.flatMap(
      (requirement) => requirement.selectedEvidenceRefs,
    ),
  );
  const contradictingRefs = new Set(
    resolution.supportAssessments.flatMap(
      (assessment) => assessment.contradictingEvidenceRefs,
    ),
  );
  const unknownRefs = new Set([
    ...resolution.supportAssessments.flatMap(
      (assessment) => assessment.unknownEvidenceRefs,
    ),
    ...resolution.notebook.coverage.flatMap(
      (requirement) => requirement.unresolvedEvidenceRefs,
    ),
  ]);
  return Object.freeze({
    schemaVersion: "paw.memory-resolved-context.v1",
    resolverVersion: PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
    packetRevision: resolution.resolutionRevision,
    mode:
      resolution.plannerStatus === "completed"
        ? "planned"
        : "deterministic_fallback",
    stop:
      evidence.length === 0
        ? "missing"
        : plannedClosureVerified
          ? "sufficient"
          : "partial",
    requirements,
    verification: Object.freeze({
      status:
        resolution.degradedChannels.length > 0
          ? ("failed" as const)
          : supportVerified
            ? ("verified" as const)
            : ("not_configured" as const),
      ...(supportVerified
        ? {
            verifierVersion: resolution.supportSelectorVersion,
            verificationRevision: resolution.supportSelectionRevision,
          }
        : {}),
      supportingCount: supportingRefs.size,
      contradictionCount: contradictingRefs.size,
      unknownCount: unknownRefs.size,
    }),
    evidence,
    topics: Object.freeze([]),
    spans,
  });
}

/**
 * Preserve the typed evidence plan at the final model boundary. The contract
 * contains control metadata only; factual content remains in immutable L0
 * evidence. This prevents a generic RAG adapter from flattening a verified
 * multi-requirement packet back into an unstructured list of documents.
 */
export function projectEvidenceFirstMemoryAnswerContractV1(
  resolution: MemoryEvidenceResolutionV1,
  packet: MemoryResolvedContextPacketV1 = projectEvidenceFirstMemoryContextPacketV1(
    resolution,
  ),
): MemoryEvidenceAnswerContractV1 {
  const packetRequirements = new Map(
    packet.requirements.map((requirement) => [
      requirement.requirementId,
      requirement,
    ]),
  );
  const evidenceByRequirement = new Map(
    resolution.requirementEvidence.map((entry) => [entry.requirementId, entry]),
  );
  const assessmentByRequirement = new Map(
    resolution.supportAssessments.map((assessment) => [
      assessment.requirementId,
      assessment,
    ]),
  );
  return Object.freeze({
    schemaVersion: PAW_MEMORY_EVIDENCE_ANSWER_CONTRACT_VERSION_V1,
    answerShape: resolution.intent.answerShape,
    temporalMode: resolution.intent.temporalMode,
    roleConstraint: resolution.intent.roleConstraint,
    evidenceStatus: packet.stop,
    answerPolicy: createMemoryEvidenceAnswerPolicyV1({
      answerShape: resolution.intent.answerShape,
      temporalMode: resolution.intent.temporalMode,
      roleConstraint: resolution.intent.roleConstraint,
      requirementCount: resolution.requirements.length,
      evidenceStatus: packet.stop,
    }),
    evidenceBindings: Object.freeze(
      resolution.packetSources.flatMap((source) => source.evidenceBindings),
    ),
    evidenceUses: Object.freeze([
      ...new Set(
        resolution.packetSources.flatMap((source) =>
          source.evidenceBindings.map((binding) => binding.evidenceUse),
        ),
      ),
    ]),
    guidance:
      "Control metadata is not evidence. Execute the typed ledger by covered requirement ID; candidates never count as verified support and a contradictory address must not be silently reassigned.",
    requirements: Object.freeze(
      resolution.requirements.map((requirement) => {
        const projected = packetRequirements.get(requirement.requirementId);
        const evidence = evidenceByRequirement.get(requirement.requirementId);
        const assessment = assessmentByRequirement.get(
          requirement.requirementId,
        );
        if (!evidence) {
          throw namedError("MemoryEvidenceAnswerContractLedgerInvalid");
        }
        return Object.freeze({
          requirementId: requirement.requirementId,
          description: requirement.label,
          relation: requirement.relation ?? "direct",
          coverageMode:
            requirement.coverageMode ??
            (requirement.temporalMode === "latest" ? "latest" : "any"),
          minimumEvidence: requirement.minimumEvidence ?? 1,
          status: projected?.status ?? "missing",
          selectedEvidenceCount: projected?.selectedEvidenceCount ?? 0,
          supportingEvidenceRefs: evidence.supportingEvidenceRefs,
          candidateEvidenceRefs: evidence.candidateEvidenceRefs,
          contradictingEvidenceRefs: evidence.contradictingEvidenceRefs,
          evidenceDispositions: Object.freeze([
            ...(assessment?.evidenceDispositions ?? []),
          ]),
        });
      }),
    ),
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
