import type { JsonValue, MemoryRawEvidenceSpanV1 } from "@paw/protocol";

import { hashCanonicalJsonV1, hashTextV1 } from "./canonical.js";
import {
  type MemoryContextResolverV1,
  type MemoryResolvedContextPacketV1,
  PAW_MEMORY_CONTEXT_RESOLVER_VERSION_V1,
} from "./context-resolver.js";
import type { MemoryEvidenceResolutionV1 } from "./evidence-resolver.js";

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
  const memoryIdBySource = new Map(
    contextSources.map((source) => [
      source.sourceId,
      hashCanonicalJsonV1({
        schemaVersion: "paw.memory-evidence-context-item.v1",
        resolutionRevision: resolution.resolutionRevision,
        sourceId: source.sourceId,
        evidenceRefs: source.evidenceRefs,
      } as unknown as JsonValue),
    ]),
  );
  const memoryIdByEvidenceRef = new Map<string, string>();
  for (const source of contextSources) {
    const memoryId = memoryIdBySource.get(source.sourceId)!;
    for (const evidenceRef of source.evidenceRefs) {
      memoryIdByEvidenceRef.set(evidenceRef, memoryId);
    }
  }
  const evidence = Object.freeze(
    contextSources.map((source) =>
      Object.freeze({
        memoryId: memoryIdBySource.get(source.sourceId)!,
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
      });
    }),
  );
  const spans: readonly MemoryRawEvidenceSpanV1[] = Object.freeze(
    contextSources.map((source) =>
      Object.freeze({
        evidenceRef: `memory:notebook/${resolution.resolutionRevision}/${hashTextV1(source.sourceId).slice(0, 20)}`,
        memoryIds: Object.freeze([memoryIdBySource.get(source.sourceId)!]),
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
  const plannedClosureVerified =
    resolution.requirements.length > 0 &&
    requiredCovered &&
    supportVerified &&
    !(
      resolution.intent.needsPlanning &&
      resolution.plannerStatus !== "completed"
    );
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

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
