import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import type { MemoryEvidenceNotebookHitV1 } from "./evidence-contracts.js";
import type { MemoryEvidenceResolutionPassV1 } from "./evidence-resolution-pass.js";

export const PAW_MEMORY_EVIDENCE_REPAIR_COMMIT_POLICY_V1 =
  "paw.memory-evidence-repair-commit.v1:proof-and-reader-prefix-dominance" as const;

export type MemoryEvidenceRepairCommitReasonV1 =
  | "dominant"
  | "source_lock_changed"
  | "authority_expanded"
  | "rejected_evidence_leaked"
  | "protected_requirement_changed"
  | "protected_proof_lost_or_reordered"
  | "protected_coverage_downgraded"
  | "protected_support_downgraded"
  | "protected_reader_source_lost_or_reordered"
  | "protected_reader_text_changed"
  | "protected_reader_binding_changed"
  | "protected_answer_role_changed"
  | "protected_evidence_identity_changed";

export interface MemoryEvidenceRepairCommitReportV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_REPAIR_COMMIT_POLICY_V1;
  readonly status: "committed" | "rolled_back";
  readonly reason: MemoryEvidenceRepairCommitReasonV1;
  readonly protectedRequirementCount: number;
  readonly retainedRequirementCount: number;
  readonly protectedEvidenceCount: number;
  readonly retainedEvidenceCount: number;
  readonly protectedSupportingEvidenceCount: number;
  readonly retainedSupportingEvidenceCount: number;
  readonly rejectedEvidenceLeakCount: number;
  readonly evidenceIdentityMismatchCount: number;
  readonly bindingMismatchCount: number;
  readonly answerRoleMismatchCount: number;
  readonly sourceLockUnchanged: boolean;
  readonly authorityExpanded: boolean;
  readonly protectedProofOrderPreserved: boolean;
  readonly protectedReaderOrderPreserved: boolean;
  readonly packetEvidenceCountDelta: number;
  readonly packetCharsDelta: number;
  readonly reportRevision: string;
}

/**
 * Treat a closure repair as an isolated proposal. The proposal may append
 * proof and reader context, but it may not rewrite either surface that the
 * initial pass already committed.
 */
export function evaluateMemoryEvidenceRepairDominanceV1(input: {
  readonly baseline: MemoryEvidenceResolutionPassV1;
  readonly repaired: MemoryEvidenceResolutionPassV1;
  readonly rejectedEvidenceRefs: ReadonlySet<string>;
}): MemoryEvidenceRepairCommitReportV1 {
  const rejected = input.rejectedEvidenceRefs;
  const baselineCoverage = new Map(
    input.baseline.notebook.coverage.map((item) => [item.requirementId, item]),
  );
  const repairedCoverage = new Map(
    input.repaired.notebook.coverage.map((item) => [item.requirementId, item]),
  );
  const baselineAssessments = new Map(
    input.baseline.supportAssessments.map((item) => [item.requirementId, item]),
  );
  const repairedAssessments = new Map(
    input.repaired.supportAssessments.map((item) => [item.requirementId, item]),
  );
  let retainedRequirementCount = 0;
  let protectedEvidenceCount = 0;
  let retainedEvidenceCount = 0;
  let protectedSupportingEvidenceCount = 0;
  let retainedSupportingEvidenceCount = 0;
  let protectedProofOrderPreserved = true;
  let protectedRequirementChanged = false;
  let protectedCoverageDowngraded = false;
  let protectedSupportDowngraded = false;
  const protectedRefs = new Set<string>();

  for (const baselineRequirement of input.baseline.requirements) {
    const repairedRequirement = input.repaired.requirements.find(
      (item) => item.requirementId === baselineRequirement.requirementId,
    );
    if (
      !repairedRequirement ||
      requirementIdentity(baselineRequirement) !==
        requirementIdentity(repairedRequirement)
    ) {
      protectedRequirementChanged = true;
      continue;
    }
    retainedRequirementCount += 1;
    const baselineSlot = baselineCoverage.get(
      baselineRequirement.requirementId,
    );
    const repairedSlot = repairedCoverage.get(
      baselineRequirement.requirementId,
    );
    if (!baselineSlot || !repairedSlot) {
      protectedRequirementChanged = true;
      continue;
    }
    const baselineSelected = baselineSlot.selectedEvidenceRefs.filter(
      (evidenceRef) => !rejected.has(evidenceRef),
    );
    const baselineSlotWasSanitized =
      baselineSelected.length !== baselineSlot.selectedEvidenceRefs.length;
    protectedEvidenceCount += baselineSelected.length;
    for (const evidenceRef of baselineSelected) {
      protectedRefs.add(evidenceRef);
    }
    const selectedPrefixPreserved = isPrefix(
      baselineSelected,
      repairedSlot.selectedEvidenceRefs,
    );
    protectedProofOrderPreserved &&= selectedPrefixPreserved;
    retainedEvidenceCount += baselineSelected.filter((evidenceRef) =>
      repairedSlot.selectedEvidenceRefs.includes(evidenceRef),
    ).length;
    if (
      !baselineSlotWasSanitized &&
      (coverageRank(repairedSlot.status) < coverageRank(baselineSlot.status) ||
        repairedSlot.closureEvidenceCount < baselineSlot.closureEvidenceCount)
    ) {
      protectedCoverageDowngraded = true;
    }
    const baselineSupporting = (
      baselineAssessments.get(baselineRequirement.requirementId)
        ?.supportingEvidenceRefs ?? []
    ).filter((evidenceRef) => !rejected.has(evidenceRef));
    const repairedSupporting = new Set(
      repairedAssessments.get(baselineRequirement.requirementId)
        ?.supportingEvidenceRefs ?? [],
    );
    protectedSupportingEvidenceCount += baselineSupporting.length;
    retainedSupportingEvidenceCount += baselineSupporting.filter(
      (evidenceRef) => repairedSupporting.has(evidenceRef),
    ).length;
    if (
      baselineSupporting.some(
        (evidenceRef) => !repairedSupporting.has(evidenceRef),
      )
    ) {
      protectedSupportDowngraded = true;
    }
  }

  const baselineSources = input.baseline.packetSources.filter((source) =>
    source.evidenceRefs.every((evidenceRef) => !rejected.has(evidenceRef)),
  );
  const repairedSources = input.repaired.packetSources;
  const protectedReaderOrderPreserved = baselineSources.every(
    (baseline, index) => repairedSources[index]?.sourceId === baseline.sourceId,
  );
  const protectedReaderTextChanged = baselineSources.some(
    (baseline, index) =>
      !repairedSources[index]?.text.startsWith(baseline.text),
  );
  let bindingMismatchCount = 0;
  let answerRoleMismatchCount = 0;
  for (const [index, baseline] of baselineSources.entries()) {
    const repaired = repairedSources[index];
    if (!repaired || repaired.sourceId !== baseline.sourceId) continue;
    if (
      !isPrefix(baseline.evidenceRefs, repaired.evidenceRefs) ||
      !isBindingPrefix(baseline.evidenceBindings, repaired.evidenceBindings) ||
      !isPrefix(baseline.evidenceUses, repaired.evidenceUses)
    ) {
      bindingMismatchCount += 1;
    }
    if (baseline.answerRole !== repaired.answerRole) {
      answerRoleMismatchCount += 1;
    }
    for (const evidenceRef of baseline.evidenceRefs) {
      protectedRefs.add(evidenceRef);
    }
  }

  const baselineHits = hitsByRef(input.baseline.requirementHits.flat());
  const repairedHits = hitsByRef(input.repaired.requirementHits.flat());
  const evidenceIdentityMismatchCount = [...protectedRefs].filter(
    (evidenceRef) => {
      const baseline = baselineHits.get(evidenceRef);
      const repaired = repairedHits.get(evidenceRef);
      return (
        baseline === undefined ||
        repaired === undefined ||
        evidenceIdentity(baseline) !== evidenceIdentity(repaired)
      );
    },
  ).length;
  const rejectedEvidenceLeakCount = [
    ...executableExposureRefs(input.repaired),
  ].filter((evidenceRef) => rejected.has(evidenceRef)).length;
  const sourceLockUnchanged =
    hashCanonicalJsonV1(sourceLockIdentity(input.baseline)) ===
    hashCanonicalJsonV1(sourceLockIdentity(input.repaired));
  const lockedSourceIds = new Set(input.baseline.lockedSourceIds);
  const authorityExpanded =
    input.repaired.lockedSourceIds.some(
      (sourceId) => !lockedSourceIds.has(sourceId),
    ) ||
    repairedSources.some((source) => !lockedSourceIds.has(source.sourceId));

  let reason: MemoryEvidenceRepairCommitReasonV1 = "dominant";
  if (!sourceLockUnchanged) reason = "source_lock_changed";
  else if (authorityExpanded) reason = "authority_expanded";
  else if (rejectedEvidenceLeakCount > 0) reason = "rejected_evidence_leaked";
  else if (protectedRequirementChanged)
    reason = "protected_requirement_changed";
  else if (!protectedProofOrderPreserved)
    reason = "protected_proof_lost_or_reordered";
  else if (protectedCoverageDowngraded)
    reason = "protected_coverage_downgraded";
  else if (protectedSupportDowngraded) reason = "protected_support_downgraded";
  else if (!protectedReaderOrderPreserved)
    reason = "protected_reader_source_lost_or_reordered";
  else if (protectedReaderTextChanged) reason = "protected_reader_text_changed";
  else if (bindingMismatchCount > 0)
    reason = "protected_reader_binding_changed";
  else if (answerRoleMismatchCount > 0)
    reason = "protected_answer_role_changed";
  else if (evidenceIdentityMismatchCount > 0)
    reason = "protected_evidence_identity_changed";

  const reportBody = {
    policyVersion: PAW_MEMORY_EVIDENCE_REPAIR_COMMIT_POLICY_V1,
    status: reason === "dominant" ? "committed" : "rolled_back",
    reason,
    protectedRequirementCount: input.baseline.requirements.length,
    retainedRequirementCount,
    protectedEvidenceCount,
    retainedEvidenceCount,
    protectedSupportingEvidenceCount,
    retainedSupportingEvidenceCount,
    rejectedEvidenceLeakCount,
    evidenceIdentityMismatchCount,
    bindingMismatchCount,
    answerRoleMismatchCount,
    sourceLockUnchanged,
    authorityExpanded,
    protectedProofOrderPreserved,
    protectedReaderOrderPreserved,
    packetEvidenceCountDelta:
      repairedSources.reduce(
        (count, source) => count + source.evidenceRefs.length,
        0,
      ) -
      baselineSources.reduce(
        (count, source) => count + source.evidenceRefs.length,
        0,
      ),
    packetCharsDelta: packetChars(input.repaired) - packetChars(input.baseline),
  } as const;
  return Object.freeze({
    ...reportBody,
    reportRevision: hashCanonicalJsonV1(reportBody as unknown as JsonValue),
  });
}

function requirementIdentity(
  requirement: MemoryEvidenceResolutionPassV1["requirements"][number],
): string {
  return hashCanonicalJsonV1({
    requirementId: requirement.requirementId,
    temporalMode: requirement.temporalMode,
    temporalConstraint: requirement.temporalConstraint ?? null,
    roleConstraint: requirement.roleConstraint,
    roleCandidates: requirement.roleCandidates ?? null,
    relation: requirement.relation ?? "direct",
    coverageMode: requirement.coverageMode ?? "any",
    minimumEvidence: requirement.minimumEvidence ?? 1,
    dependencyRelation: requirement.dependencyRelation ?? "independent",
    dependsOnRequirementIds: requirement.dependsOnRequirementIds ?? [],
  } as unknown as JsonValue);
}

function evidenceIdentity(hit: MemoryEvidenceNotebookHitV1): string {
  return hashCanonicalJsonV1({
    sourceId: hit.sourceId,
    evidenceRef: hit.evidenceRef,
    content: hit.content,
    authority: hit.authority,
    sourceKind: hit.sourceKind ?? null,
    observedAt: hit.observedAt ?? null,
    observedOrder: hit.observedOrder ?? null,
    episodeOrder: hit.episodeOrder ?? null,
    turnOrder: hit.turnOrder ?? null,
    eventKey: hit.eventKey ?? null,
    contextEvidenceRefs: hit.contextEvidenceRefs ?? [],
  } as unknown as JsonValue);
}

function sourceLockIdentity(pass: MemoryEvidenceResolutionPassV1): JsonValue {
  return {
    lockedSourceIds: pass.lockedSourceIds,
    fusion: pass.fusion,
    sourceAcquisition: pass.sourceAcquisition,
    degradedChannels: pass.degradedChannels,
  } as unknown as JsonValue;
}

function hitsByRef(
  hits: readonly MemoryEvidenceNotebookHitV1[],
): ReadonlyMap<string, MemoryEvidenceNotebookHitV1> {
  return new Map(hits.map((hit) => [hit.evidenceRef, hit] as const));
}

/** Every address that can still influence reader projection or state execution. */
function executableExposureRefs(
  pass: MemoryEvidenceResolutionPassV1,
): ReadonlySet<string> {
  const refs = new Set<string>();
  const add = (evidenceRefs: readonly string[]) => {
    for (const evidenceRef of evidenceRefs) refs.add(evidenceRef);
  };
  add(pass.requirementHits.flat().map((hit) => hit.evidenceRef));
  for (const source of pass.packetSources) add(source.evidenceRefs);
  for (const coverage of pass.notebook.coverage) {
    add(coverage.selectedEvidenceRefs);
    add(coverage.historicalEvidenceRefs);
    add(coverage.unresolvedEvidenceRefs);
  }
  for (const assessment of pass.supportAssessments) {
    add(assessment.supportingEvidenceRefs);
    add(assessment.contradictingEvidenceRefs);
    add(assessment.unknownEvidenceRefs);
    add(
      (assessment.evidenceDispositions ?? []).map(
        (disposition) => disposition.evidenceRef,
      ),
    );
  }
  for (const requirement of pass.requirementEvidence) {
    add(requirement.supportingEvidenceRefs);
    add(requirement.candidateEvidenceRefs);
    add(requirement.contradictingEvidenceRefs);
  }
  for (const group of pass.selectorExecutionSnapshot?.groups ?? []) {
    for (const requirement of group.requirements) {
      const assessment = requirement.assessment;
      if (!assessment) continue;
      add(assessment.supportingEvidenceRefs);
      add(assessment.contradictingEvidenceRefs);
      add(assessment.unknownEvidenceRefs);
    }
  }
  for (const certificate of pass.dialogueCertificateRegistry.certificates) {
    add([
      certificate.assistant.evidenceRef,
      certificate.predecessor.evidenceRef,
    ]);
  }
  return refs;
}

function isPrefix<T>(baseline: readonly T[], repaired: readonly T[]): boolean {
  return baseline.every((item, index) => repaired[index] === item);
}

function isBindingPrefix(
  baseline: readonly Readonly<{ evidenceRef: string; evidenceUse: string }>[],
  repaired: readonly Readonly<{ evidenceRef: string; evidenceUse: string }>[],
): boolean {
  return baseline.every(
    (binding, index) =>
      repaired[index]?.evidenceRef === binding.evidenceRef &&
      repaired[index]?.evidenceUse === binding.evidenceUse,
  );
}

function coverageRank(status: "covered" | "partial" | "missing"): number {
  return status === "covered" ? 2 : status === "partial" ? 1 : 0;
}

function packetChars(pass: MemoryEvidenceResolutionPassV1): number {
  return pass.packetSources.reduce(
    (total, source) => total + source.text.length,
    0,
  );
}
