import type { MemoryEvidenceNotebookHitV1 } from "./evidence-contracts.js";
import {
  compileMemoryEvidenceObligationShapeV1,
  validateMemoryEvidenceObligationsV1,
} from "./evidence-obligation.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceQueryPlannerV3,
} from "./evidence-query-planner.js";
import { classifyMemoryEvidenceIntentBoundaryV1 } from "./query-classifier.js";
import {
  memoryEvidenceLeafTemporalModeAllowedV1,
  validateMemoryEvidenceTemporalConstraintV1,
} from "./temporal-constraint.js";

export function validateMemoryEvidenceQueryPlanBoundary(input: {
  readonly query: string;
  readonly plan: Awaited<ReturnType<MemoryEvidenceQueryPlannerV3["plan"]>>;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly plannerVersion: string;
}): void {
  const { plan, intent } = input;
  const boundary = classifyMemoryEvidenceIntentBoundaryV1(input.query, intent);
  if (
    plan.plannerVersion !== input.plannerVersion ||
    (boundary.answerShape === "fixed" &&
      plan.answerShape !== intent.answerShape) ||
    (boundary.temporalMode === "fixed" &&
      plan.temporalMode !== intent.temporalMode) ||
    (boundary.roleConstraint === "fixed" &&
      plan.roleConstraint !== intent.roleConstraint &&
      !isMixedRoleEnvelope(plan, intent.roleConstraint)) ||
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
      !memoryEvidenceLeafTemporalModeAllowedV1(
        plan.temporalMode,
        requirement.temporalMode,
      ) ||
      !requirementRoleAllowed(
        requirement.roleConstraint,
        plan.roleConstraint,
      ) ||
      !relations.has(relation) ||
      !coverageModes.has(coverageMode) ||
      !Number.isSafeInteger(minimumEvidence) ||
      minimumEvidence < 1 ||
      minimumEvidence > 3 ||
      (coverageMode === "convergent" && minimumEvidence < 2)
    ) {
      throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
    }
    if (requirement.temporalConstraint) {
      try {
        validateMemoryEvidenceTemporalConstraintV1({
          query: input.query,
          queryEnvelopeMode: plan.temporalMode,
          leafMode: requirement.temporalMode,
          constraint: requirement.temporalConstraint,
        });
      } catch {
        throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
      }
    }
    ids.add(requirement.requirementId);
  }
  const dagPlan = plan.requirements.some(
    (requirement) => requirement.dependencyRelation !== undefined,
  );
  const requirementRoles = new Set(
    plan.requirements.map((requirement) => requirement.roleConstraint),
  );
  if (
    plan.roleConstraint === "any" &&
    requirementRoles.size === 1 &&
    !requirementRoles.has("any")
  ) {
    throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
  }
  if (dagPlan) {
    const derivedEnvelope =
      requirementRoles.size === 1
        ? plan.requirements[0]?.roleConstraint
        : ("any" as const);
    if (plan.roleConstraint !== derivedEnvelope) {
      throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
    }
  }
  validateRequirementDag(plan.requirements);
  validateMemoryEvidenceObligationsV1(
    compileMemoryEvidenceObligationShapeV1(input.query, plan),
    plan.requirements,
  );
}

function isMixedRoleEnvelope(
  plan: Awaited<ReturnType<MemoryEvidenceQueryPlannerV3["plan"]>>,
  classifiedRole: MemoryEvidenceQueryIntentV3["roleConstraint"],
): boolean {
  const roles = new Set(
    plan.requirements.map((requirement) => requirement.roleConstraint),
  );
  return (
    plan.roleConstraint === "any" &&
    roles.has("user") &&
    roles.has("assistant") &&
    (classifiedRole === "any" || roles.has(classifiedRole))
  );
}

function requirementRoleAllowed(
  requirementRole: MemoryEvidenceQueryIntentV3["roleConstraint"],
  envelopeRole: MemoryEvidenceQueryIntentV3["roleConstraint"],
): boolean {
  return envelopeRole === "any" || requirementRole === envelopeRole;
}

function validateRequirementDag(
  requirements: Awaited<
    ReturnType<MemoryEvidenceQueryPlannerV3["plan"]>
  >["requirements"],
): void {
  const withDag = requirements.filter(
    (requirement) => requirement.dependencyRelation !== undefined,
  );
  if (withDag.length === 0) return;
  const byId = new Map(
    requirements.map((requirement) => [requirement.requirementId, requirement]),
  );
  if (
    withDag.length !== requirements.length ||
    byId.size !== requirements.length
  ) {
    throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
  }
  for (const requirement of requirements) {
    const dependencies = requirement.dependsOnRequirementIds ?? [];
    if (
      new Set(dependencies).size !== dependencies.length ||
      dependencies.some(
        (dependency) =>
          dependency === requirement.requirementId || !byId.has(dependency),
      ) ||
      (requirement.dependencyRelation === "independent") !==
        (dependencies.length === 0) ||
      (requirement.dependencyRelation === "responds_to" &&
        (requirement.roleConstraint !== "assistant" ||
          !dependencies.some(
            (dependency) => byId.get(dependency)?.roleConstraint === "user",
          ))) ||
      (requirement.dependencyRelation === "supersedes" &&
        requirement.temporalMode === "any")
    ) {
      throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (requirementId: string): void => {
    if (visiting.has(requirementId)) {
      throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
    }
    if (visited.has(requirementId)) return;
    visiting.add(requirementId);
    for (const dependency of byId.get(requirementId)?.dependsOnRequirementIds ??
      []) {
      visit(dependency);
    }
    visiting.delete(requirementId);
    visited.add(requirementId);
  };
  for (const requirement of requirements) visit(requirement.requirementId);
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
