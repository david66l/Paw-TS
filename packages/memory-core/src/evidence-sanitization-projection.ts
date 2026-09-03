import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import type { MemoryDialogueCertificateRegistryV1 } from "./dialogue-certificate.js";
import { memoryEvidenceExecutableExposureRefsV1 } from "./evidence-repair-dominance.js";
import { buildMemoryEvidenceRequirementLedgerV1 } from "./evidence-requirement-ledger.js";
import type { MemoryEvidenceResolutionPassV1 } from "./evidence-resolution-pass.js";

export const PAW_MEMORY_EVIDENCE_SANITIZATION_PROJECTION_POLICY_V1 =
  "paw.memory-evidence-sanitization.v1:source-atomic-deletion-only" as const;

export interface MemoryEvidenceSanitizationProjectionReportV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_SANITIZATION_PROJECTION_POLICY_V1;
  readonly status: "projected";
  readonly rejectedEvidenceCount: number;
  readonly contaminatedSourceCount: number;
  readonly removedPacketSourceCount: number;
  readonly retainedPacketSourceCount: number;
  readonly removedEvidenceCount: number;
  readonly retainedEvidenceCount: number;
  readonly rejectedEvidenceLeakCount: number;
  readonly initialPassRevision: string;
  readonly rejectedEvidenceRevision: string;
  readonly contaminatedSourceRevision: string;
  readonly retainedPacketRevision: string;
  readonly retainedExposureRevision: string;
  readonly projectionRevision: string;
}

export interface MemoryEvidenceSanitizationTransactionReportV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_SANITIZATION_PROJECTION_POLICY_V1;
  readonly status: "attempted" | "projected" | "failed";
  readonly attempt: 1 | 2;
  readonly rejectedEvidenceCount: number;
  readonly rejectedEvidenceRevision: string;
  readonly failureCode?: string;
  readonly contaminatedSourceCount?: number;
  readonly removedPacketSourceCount?: number;
  readonly retainedPacketSourceCount?: number;
  readonly removedEvidenceCount?: number;
  readonly retainedEvidenceCount?: number;
  readonly rejectedEvidenceLeakCount?: number;
  readonly projectionRevision?: string;
  readonly transactionRevision: string;
}

export function beginMemoryEvidenceSanitizationV1(input: {
  readonly attempt: 1 | 2;
  readonly rejectedEvidenceRefs: ReadonlySet<string>;
}): MemoryEvidenceSanitizationTransactionReportV1 {
  return transactionReportV1({
    policyVersion: PAW_MEMORY_EVIDENCE_SANITIZATION_PROJECTION_POLICY_V1,
    status: "attempted",
    attempt: input.attempt,
    rejectedEvidenceCount: input.rejectedEvidenceRefs.size,
    rejectedEvidenceRevision: rejectedEvidenceRevisionV1(
      input.rejectedEvidenceRefs,
    ),
  });
}

export function completeMemoryEvidenceSanitizationV1(input: {
  readonly attempt: 1 | 2;
  readonly projection: MemoryEvidenceSanitizationProjectionReportV1;
}): MemoryEvidenceSanitizationTransactionReportV1 {
  return transactionReportV1({
    ...input.projection,
    status: "projected",
    attempt: input.attempt,
  });
}

export function failMemoryEvidenceSanitizationV1(input: {
  readonly attempt: 1 | 2;
  readonly rejectedEvidenceRefs: ReadonlySet<string>;
  readonly error: unknown;
}): MemoryEvidenceSanitizationTransactionReportV1 {
  return transactionReportV1({
    policyVersion: PAW_MEMORY_EVIDENCE_SANITIZATION_PROJECTION_POLICY_V1,
    status: "failed",
    attempt: input.attempt,
    rejectedEvidenceCount: input.rejectedEvidenceRefs.size,
    rejectedEvidenceRevision: rejectedEvidenceRevisionV1(
      input.rejectedEvidenceRefs,
    ),
    failureCode: stableMemoryEvidenceSanitizationFailureCodeV1(input.error),
  });
}

/**
 * Removes model-rejected evidence as a deterministic host projection.
 *
 * Repair dominance is append-only, while sanitization is deletion-only. They
 * intentionally use different transactions: a rejected ref removes its whole
 * reader source, but every surviving source and evidence record remains byte-
 * identical and in the same order. No selector, locator, or model is rerun.
 */
export function projectMemoryEvidenceSanitizedBaselineV1(input: {
  readonly initial: MemoryEvidenceResolutionPassV1;
  readonly rejectedEvidenceRefs: ReadonlySet<string>;
}): Readonly<{
  pass: MemoryEvidenceResolutionPassV1;
  report: MemoryEvidenceSanitizationProjectionReportV1;
}> {
  const rejectedEvidenceRefs = new Set(input.rejectedEvidenceRefs);
  const sourceIdsByEvidenceRef = sourceIdsByEvidenceRefV1(input.initial);
  const contaminatedSourceIds = contaminatedSourceClosureV1(
    rejectedEvidenceRefs,
    sourceIdsByEvidenceRef,
  );

  const evidenceAllowed = (evidenceRef: string): boolean => {
    if (rejectedEvidenceRefs.has(evidenceRef)) return false;
    const sourceIds = sourceIdsByEvidenceRef.get(evidenceRef);
    return (
      sourceIds === undefined ||
      [...sourceIds].every((sourceId) => !contaminatedSourceIds.has(sourceId))
    );
  };
  const filterRefs = (evidenceRefs: readonly string[]) =>
    Object.freeze(evidenceRefs.filter(evidenceAllowed));

  const requirementHits = Object.freeze(
    input.initial.requirementHits.map((hits) =>
      Object.freeze(
        hits.filter(
          (hit) =>
            !contaminatedSourceIds.has(hit.sourceId) &&
            evidenceAllowed(hit.evidenceRef) &&
            (hit.contextEvidenceRefs ?? []).every(evidenceAllowed),
        ),
      ),
    ),
  );
  const supportAssessments = Object.freeze(
    input.initial.supportAssessments.map((assessment) =>
      Object.freeze({
        ...assessment,
        supportingEvidenceRefs: filterRefs(assessment.supportingEvidenceRefs),
        contradictingEvidenceRefs: filterRefs(
          assessment.contradictingEvidenceRefs,
        ),
        unknownEvidenceRefs: filterRefs(assessment.unknownEvidenceRefs),
        ...(assessment.evidenceDispositions === undefined
          ? {}
          : {
              evidenceDispositions: Object.freeze(
                assessment.evidenceDispositions.filter(
                  (disposition) =>
                    evidenceAllowed(disposition.evidenceRef) &&
                    disposition.contextEvidenceRefs.every(evidenceAllowed),
                ),
              ),
            }),
      }),
    ),
  );
  const notebookSources = Object.freeze(
    input.initial.notebook.sources.filter(
      (source) =>
        !contaminatedSourceIds.has(source.sourceId) &&
        source.evidenceRefs.every(evidenceAllowed) &&
        source.evidenceBindings.every((binding) =>
          evidenceAllowed(binding.evidenceRef),
        ),
    ),
  );
  const requirementById = new Map(
    input.initial.requirements.map((requirement) => [
      requirement.requirementId,
      requirement,
    ]),
  );
  const coverage = Object.freeze(
    input.initial.notebook.coverage.map((item) => {
      const selectedEvidenceRefs = filterRefs(item.selectedEvidenceRefs);
      const historicalEvidenceRefs = filterRefs(item.historicalEvidenceRefs);
      const unresolvedEvidenceRefs = filterRefs(item.unresolvedEvidenceRefs);
      const inputEvidenceRefs = filterRefs(item.inputEvidenceRefs ?? []);
      const budgetOmittedEvidenceRefs = filterRefs(
        item.budgetOmittedEvidenceRefs ?? [],
      );
      const admission = Object.freeze(
        (item.admission ?? []).filter((entry) =>
          evidenceAllowed(entry.evidenceRef),
        ),
      );
      const selectedChanged =
        selectedEvidenceRefs.length !== item.selectedEvidenceRefs.length;
      const selectedSet = new Set(selectedEvidenceRefs);
      const independentEvidenceCount = selectedChanged
        ? new Set(
            admission
              .filter((entry) => selectedSet.has(entry.evidenceRef))
              .map((entry) => entry.independenceIdentityRevision),
          ).size
        : item.independentEvidenceCount;
      const requirement = requirementById.get(item.requirementId);
      const closureEvidenceCount = selectedChanged
        ? Math.min(
            item.closureEvidenceCount,
            requirement?.coverageMode === "convergent"
              ? independentEvidenceCount
              : selectedEvidenceRefs.length,
          )
        : item.closureEvidenceCount;
      const status = !selectedChanged
        ? item.status
        : selectedEvidenceRefs.length === 0 || item.status === "missing"
          ? ("missing" as const)
          : ("partial" as const);
      return Object.freeze({
        ...item,
        status,
        selectedHitCount: selectedEvidenceRefs.length,
        independentEvidenceCount,
        closureEvidenceCount,
        selectedEvidenceRefs,
        historicalEvidenceRefs,
        unresolvedEvidenceRefs,
        inputEvidenceRefs,
        budgetOmittedEvidenceRefs,
        admission,
        budgetOmittedHitCount: budgetOmittedEvidenceRefs.length,
      });
    }),
  );
  const notebook = Object.freeze({
    ...input.initial.notebook,
    sources: notebookSources,
    coverage,
    inputHitCount: requirementHits.reduce(
      (count, hits) => count + hits.length,
      0,
    ),
    budgetOmittedHitCount: coverage.reduce(
      (count, item) => count + (item.budgetOmittedHitCount ?? 0),
      0,
    ),
    selectedHitCount: new Set(
      coverage.flatMap((item) => item.selectedEvidenceRefs),
    ).size,
    chars: notebookSources.reduce(
      (count, source) => count + source.text.length,
      0,
    ),
  });
  const packetSources = Object.freeze(
    input.initial.packetSources.filter(
      (source) =>
        !contaminatedSourceIds.has(source.sourceId) &&
        source.evidenceRefs.every(evidenceAllowed) &&
        source.evidenceBindings.every((binding) =>
          evidenceAllowed(binding.evidenceRef),
        ),
    ),
  );
  const requirementEvidence = buildMemoryEvidenceRequirementLedgerV1({
    requirements: input.initial.requirements,
    notebook,
    assessments: supportAssessments,
    packetSources,
  });
  const dialogueCertificateRegistry = sanitizedDialogueRegistryV1(
    input.initial.dialogueCertificateRegistry,
    contaminatedSourceIds,
    evidenceAllowed,
  );
  const {
    supportSelectionRevision: _supportSelectionRevision,
    selectorExecutionSnapshot: _selectorExecutionSnapshot,
    ...retained
  } = input.initial;
  const pass = Object.freeze({
    ...retained,
    requirementHits,
    supportSelectorStatus: "fallback" as const,
    supportAssessments,
    notebook,
    requirementEvidence,
    packetSources,
    dialogueCertificateRegistry,
  });
  const beforeExposure = memoryEvidenceExecutableExposureRefsV1(input.initial);
  const afterExposure = memoryEvidenceExecutableExposureRefsV1(pass);
  const beforePacketEvidenceRefs = new Set(
    input.initial.packetSources.flatMap((source) => source.evidenceRefs),
  );
  const afterPacketEvidenceRefs = packetSources.flatMap(
    (source) => source.evidenceRefs,
  );
  const rejectedEvidenceLeakCount = [...afterExposure].filter((evidenceRef) =>
    rejectedEvidenceRefs.has(evidenceRef),
  ).length;
  if (
    [...afterExposure].some(
      (evidenceRef) => !beforeExposure.has(evidenceRef),
    ) ||
    afterPacketEvidenceRefs.some(
      (evidenceRef) => !beforePacketEvidenceRefs.has(evidenceRef),
    ) ||
    rejectedEvidenceLeakCount > 0
  ) {
    throw namedError("MemoryEvidenceSanitizationProjectionInvalid");
  }
  const reportBody = {
    policyVersion: PAW_MEMORY_EVIDENCE_SANITIZATION_PROJECTION_POLICY_V1,
    status: "projected" as const,
    rejectedEvidenceCount: rejectedEvidenceRefs.size,
    contaminatedSourceCount: contaminatedSourceIds.size,
    removedPacketSourceCount:
      input.initial.packetSources.length - packetSources.length,
    retainedPacketSourceCount: packetSources.length,
    removedEvidenceCount: [...beforeExposure].filter(
      (evidenceRef) => !afterExposure.has(evidenceRef),
    ).length,
    retainedEvidenceCount: afterExposure.size,
    rejectedEvidenceLeakCount,
    initialPassRevision: hashCanonicalJsonV1({
      requirements: input.initial.requirements,
      lockedSourceIds: input.initial.lockedSourceIds,
      fusion: input.initial.fusion,
      sourceAcquisition: input.initial.sourceAcquisition,
      packetSources: input.initial.packetSources,
      exposure: [...beforeExposure].sort(),
    } as unknown as JsonValue),
    rejectedEvidenceRevision: hashCanonicalJsonV1(
      [...rejectedEvidenceRefs].sort() as unknown as JsonValue,
    ),
    contaminatedSourceRevision: hashCanonicalJsonV1(
      [...contaminatedSourceIds].sort() as unknown as JsonValue,
    ),
    retainedPacketRevision: hashCanonicalJsonV1(
      packetSources as unknown as JsonValue,
    ),
    retainedExposureRevision: hashCanonicalJsonV1(
      [...afterExposure].sort() as unknown as JsonValue,
    ),
  };
  return Object.freeze({
    pass,
    report: Object.freeze({
      ...reportBody,
      projectionRevision: hashCanonicalJsonV1(
        reportBody as unknown as JsonValue,
      ),
    }),
  });
}

function transactionReportV1(
  body: Omit<
    MemoryEvidenceSanitizationTransactionReportV1,
    "transactionRevision"
  >,
): MemoryEvidenceSanitizationTransactionReportV1 {
  return Object.freeze({
    ...body,
    transactionRevision: hashCanonicalJsonV1(body as unknown as JsonValue),
  });
}

function rejectedEvidenceRevisionV1(
  rejectedEvidenceRefs: ReadonlySet<string>,
): string {
  return hashCanonicalJsonV1(
    [...rejectedEvidenceRefs].sort() as unknown as JsonValue,
  );
}

function stableMemoryEvidenceSanitizationFailureCodeV1(error: unknown): string {
  if (
    error instanceof Error &&
    (error.name === "MemoryEvidenceSanitizationProjectionInvalid" ||
      error.name === "MemoryEvidenceRepairSanitizationFailed")
  ) {
    return error.name;
  }
  return "MemoryEvidenceSanitizationFailed";
}

function contaminatedSourceClosureV1(
  rejectedEvidenceRefs: ReadonlySet<string>,
  sourceIdsByEvidenceRef: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const evidenceRefsBySourceId = new Map<string, Set<string>>();
  for (const [evidenceRef, sourceIds] of sourceIdsByEvidenceRef) {
    for (const sourceId of sourceIds) {
      const evidenceRefs =
        evidenceRefsBySourceId.get(sourceId) ?? new Set<string>();
      evidenceRefs.add(evidenceRef);
      evidenceRefsBySourceId.set(sourceId, evidenceRefs);
    }
  }
  const contaminatedEvidenceRefs = new Set(rejectedEvidenceRefs);
  const contaminatedSourceIds = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const evidenceRef of contaminatedEvidenceRefs) {
      for (const sourceId of sourceIdsByEvidenceRef.get(evidenceRef) ?? []) {
        if (!contaminatedSourceIds.has(sourceId)) {
          contaminatedSourceIds.add(sourceId);
          changed = true;
        }
      }
    }
    for (const sourceId of contaminatedSourceIds) {
      for (const evidenceRef of evidenceRefsBySourceId.get(sourceId) ?? []) {
        if (!contaminatedEvidenceRefs.has(evidenceRef)) {
          contaminatedEvidenceRefs.add(evidenceRef);
          changed = true;
        }
      }
    }
  }
  return contaminatedSourceIds;
}

function sourceIdsByEvidenceRefV1(
  pass: MemoryEvidenceResolutionPassV1,
): ReadonlyMap<string, ReadonlySet<string>> {
  const mutable = new Map<string, Set<string>>();
  const add = (sourceId: string, evidenceRefs: readonly string[]) => {
    for (const evidenceRef of evidenceRefs) {
      const sourceIds = mutable.get(evidenceRef) ?? new Set<string>();
      sourceIds.add(sourceId);
      mutable.set(evidenceRef, sourceIds);
    }
  };
  for (const hit of pass.requirementHits.flat()) {
    add(hit.sourceId, [hit.evidenceRef, ...(hit.contextEvidenceRefs ?? [])]);
  }
  for (const source of [...pass.notebook.sources, ...pass.packetSources]) {
    add(source.sourceId, [
      ...source.evidenceRefs,
      ...source.evidenceBindings.map((binding) => binding.evidenceRef),
    ]);
  }
  for (const certificate of pass.dialogueCertificateRegistry.certificates) {
    add(certificate.sourceId, [
      certificate.assistant.evidenceRef,
      certificate.predecessor.evidenceRef,
    ]);
  }
  return new Map(
    [...mutable.entries()].map(([evidenceRef, sourceIds]) => [
      evidenceRef,
      new Set(sourceIds),
    ]),
  );
}

function sanitizedDialogueRegistryV1(
  registry: MemoryDialogueCertificateRegistryV1,
  contaminatedSourceIds: ReadonlySet<string>,
  evidenceAllowed: (evidenceRef: string) => boolean,
): MemoryDialogueCertificateRegistryV1 {
  const certificates = Object.freeze(
    registry.certificates.filter(
      (certificate) =>
        !contaminatedSourceIds.has(certificate.sourceId) &&
        evidenceAllowed(certificate.assistant.evidenceRef) &&
        evidenceAllowed(certificate.predecessor.evidenceRef),
    ),
  );
  const registryIdentity = {
    registryVersion: registry.registryVersion,
    lockedSourceIdsRevision: registry.lockedSourceIdsRevision,
    originRevision: registry.originRevision,
    evidenceTimeUpperBound: registry.evidenceTimeUpperBound,
    certificates,
  };
  return Object.freeze({
    ...registry,
    certificates,
    registryRevision: hashCanonicalJsonV1(
      registryIdentity as unknown as JsonValue,
    ),
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
