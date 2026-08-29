import type { MemoryEvidenceNotebookHitV1 } from "./evidence-contracts.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceQueryPlannerV3,
} from "./evidence-query-planner.js";
import { memoryEvidenceSupportScoreV1 } from "./evidence-text.js";

export function validateMemoryEvidenceQueryPlanBoundary(input: {
  readonly plan: Awaited<ReturnType<MemoryEvidenceQueryPlannerV3["plan"]>>;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly plannerVersion: string;
}): void {
  const { plan, intent } = input;
  if (
    plan.plannerVersion !== input.plannerVersion ||
    plan.answerShape !== intent.answerShape ||
    plan.temporalMode !== intent.temporalMode ||
    plan.roleConstraint !== intent.roleConstraint ||
    plan.needsPlanning !== intent.needsPlanning
  ) {
    throw namedError("MemoryEvidenceQueryPlanAuthorityInvalid");
  }
  if (
    !Array.isArray(plan.requirements) ||
    plan.requirements.length < 1 ||
    plan.requirements.length > 4
  ) {
    throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
  }
  const ids = new Set<string>();
  const relations = new Set(["direct", "temporal", "comparative", "inferred"]);
  const coverageModes = new Set(["any", "all", "latest", "convergent"]);
  for (const requirement of plan.requirements) {
    const minimumEvidence = requirement.minimumEvidence ?? 1;
    const relation = requirement.relation ?? "direct";
    const coverageMode =
      requirement.coverageMode ??
      (requirement.temporalMode === "latest" ? "latest" : "any");
    if (
      typeof requirement.requirementId !== "string" ||
      requirement.requirementId.trim() !== requirement.requirementId ||
      requirement.requirementId.length < 1 ||
      requirement.requirementId.length > 96 ||
      ids.has(requirement.requirementId) ||
      typeof requirement.label !== "string" ||
      requirement.label.trim().length < 1 ||
      requirement.label.length > 192 ||
      typeof requirement.searchText !== "string" ||
      requirement.searchText.trim().length < 1 ||
      requirement.searchText.length > 512 ||
      requirement.temporalMode !== intent.temporalMode ||
      requirement.roleConstraint !== intent.roleConstraint ||
      !relations.has(relation) ||
      !coverageModes.has(coverageMode) ||
      !Number.isSafeInteger(minimumEvidence) ||
      minimumEvidence < 1 ||
      minimumEvidence > 3 ||
      ((coverageMode === "all" || coverageMode === "convergent") &&
        minimumEvidence < 2)
    ) {
      throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
    }
    ids.add(requirement.requirementId);
  }
}

export function mergeEvidenceHits(
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

export function hasDeterministicDirectCertificate(
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

export function boundedQuery(query: string): string {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryEvidenceResolverQueryInvalid");
  }
  return value;
}

export function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw namedError("MemoryEvidenceResolverBudgetInvalid");
  }
  return value;
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

export function abortError(): Error {
  return namedError("AbortError");
}
