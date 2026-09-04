import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import {
  type MemoryQueryAnswerProvenanceFeaturesV1,
  classifyMemoryEvidenceIntentBoundaryV1,
  classifyMemoryEvidenceQueryV3,
  classifyMemoryQueryAnswerProvenanceFeaturesV1,
} from "./query-classifier.js";
import type {
  MemoryEvidenceQueryPlanV3,
  MemoryEvidenceRequirementV3,
  MemoryEvidenceRoleConstraintV3,
} from "./query-plan-contracts.js";

export const PAW_MEMORY_QUERY_ANSWER_ORIGIN_VERSION_V1 =
  "paw.memory-query-answer-origin.v1:typed-provenance" as const;
export const PAW_MEMORY_QUERY_ANSWER_ORIGIN_AUTHORIZATION_VERSION_V1 =
  "paw.memory-query-answer-origin-authorization.v1:source-local" as const;

export type MemoryQueryAnswerOriginKindV1 =
  | "ordinary_semantic"
  | "explicit_user"
  | "explicit_assistant"
  | "explicit_shared"
  | "dialogue_artifact_unowned";

export interface MemoryQueryAnswerOriginV1 {
  readonly originVersion: typeof PAW_MEMORY_QUERY_ANSWER_ORIGIN_VERSION_V1;
  readonly originKind: MemoryQueryAnswerOriginKindV1;
  /** Role before any planner-owned normalization. */
  readonly classifiedRoleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly roleBoundary: "fixed" | "semantic";
  readonly features: MemoryQueryAnswerProvenanceFeaturesV1;
  /** Content-free identity used by resolver revisions and locator cache keys. */
  readonly originRevision: string;
}

export type MemoryQueryAnswerOriginMaterializationModeV1 =
  | "late_binding"
  | "assistant_leaf"
  | "shared_envelope";

export interface MemoryQueryAnswerOriginAuthorizationV1 {
  readonly authorizationVersion: typeof PAW_MEMORY_QUERY_ANSWER_ORIGIN_AUTHORIZATION_VERSION_V1;
  readonly originVersion: typeof PAW_MEMORY_QUERY_ANSWER_ORIGIN_VERSION_V1;
  readonly originKind: MemoryQueryAnswerOriginKindV1;
  readonly originRevision: string;
  readonly requirementId: string;
  /** Hash of the planner-proposed leaf before resolver-owned role widening. */
  readonly requirementRevision: string;
  readonly originalRequirementRole: MemoryEvidenceRoleConstraintV3;
  readonly effectiveRequirementRole: MemoryEvidenceRoleConstraintV3;
  readonly mode: MemoryQueryAnswerOriginMaterializationModeV1;
  readonly authorizationRevision: string;
}

/**
 * Compile query-owned answer provenance before the planner runs. A generic
 * semantic role boundary is deliberately closed. Only explicit authorship or
 * a jointly present second-person/prior/recall trace can open the unowned
 * dialogue-artifact state.
 */
export function compileMemoryQueryAnswerOriginV1(
  query: string,
): MemoryQueryAnswerOriginV1 {
  const intent = classifyMemoryEvidenceQueryV3(query);
  const boundary = classifyMemoryEvidenceIntentBoundaryV1(query, intent);
  const features = classifyMemoryQueryAnswerProvenanceFeaturesV1(query);
  const unownedDialogueArtifact =
    !features.explicitUserAnswerAuthor &&
    !features.explicitAssistantAnswerAuthor &&
    !features.explicitSharedAnswerAuthor &&
    (features.certifiedAssistantDialogueCandidate ||
      features.dialogueRoleResolutionCandidate ||
      (features.secondPersonCue &&
        features.priorDialogueCue &&
        features.recallActionCue));
  const originKind: MemoryQueryAnswerOriginKindV1 =
    features.explicitSharedAnswerAuthor ||
    (boundary.roleConstraint === "fixed" && intent.roleConstraint === "any")
      ? "explicit_shared"
      : features.explicitAssistantAnswerAuthor ||
          (boundary.roleConstraint === "fixed" &&
            intent.roleConstraint === "assistant")
        ? "explicit_assistant"
        : features.explicitUserAnswerAuthor
          ? "explicit_user"
          : unownedDialogueArtifact
            ? "dialogue_artifact_unowned"
            : boundary.roleConstraint === "fixed" &&
                intent.roleConstraint === "user"
              ? "explicit_user"
              : "ordinary_semantic";
  const identity = {
    originVersion: PAW_MEMORY_QUERY_ANSWER_ORIGIN_VERSION_V1,
    originKind,
    classifiedRoleConstraint: intent.roleConstraint,
    roleBoundary: boundary.roleConstraint,
    features,
  } as const;
  return Object.freeze({
    ...identity,
    features: Object.freeze({ ...features }),
    originRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
}

/**
 * Planner output is a proposal. Reject role widening when the immutable query
 * origin did not independently authorize an assistant answer branch.
 */
export function validateMemoryEvidenceQueryPlanOriginV1(input: {
  readonly origin: MemoryQueryAnswerOriginV1;
  readonly plan: MemoryEvidenceQueryPlanV3;
}): void {
  assertMemoryQueryAnswerOriginV1(input.origin);
  const proposesAssistantAperture =
    input.plan.roleConstraint !== "user" ||
    input.plan.requirements.some(
      (requirement) => requirement.roleConstraint !== "user",
    );
  if (
    proposesAssistantAperture &&
    (input.origin.originKind === "ordinary_semantic" ||
      input.origin.originKind === "explicit_user")
  ) {
    throw namedError("MemoryEvidenceQueryPlanOriginInvalid");
  }
}

/**
 * Align a planner proposal with an immutable explicit-assistant origin before
 * the normal plan boundary and authority filters run. This is deliberately a
 * capability projection, not a role widening: user leaves remain user-only
 * dependencies/context, while every role-neutral leaf is made assistant-only.
 *
 * The mixed root envelope is retained only when preserved user leaves require
 * it. In that case the concrete assistant leaves, not the `any` envelope, are
 * the only leaves that may close an assistant-answer obligation.
 */
export function projectMemoryEvidenceQueryPlanForAnswerOriginV1(input: {
  readonly origin: MemoryQueryAnswerOriginV1;
  readonly plan: MemoryEvidenceQueryPlanV3;
}): MemoryEvidenceQueryPlanV3 {
  assertMemoryQueryAnswerOriginV1(input.origin);
  if (input.origin.originKind !== "explicit_assistant") return input.plan;
  if (!Array.isArray(input.plan.requirements)) {
    throw namedError("MemoryEvidenceQueryPlanAssistantAlignmentInvalid");
  }

  let requirements = input.plan.requirements.map((requirement) => {
    const roleConstraint =
      requirement.roleConstraint === "any"
        ? ("assistant" as const)
        : requirement.roleConstraint;
    // A role candidate is an unresolved alternative, never an authorization.
    // Origin alignment resolves it to the same singleton as the leaf role so
    // a later mixed-role binder cannot re-open a user/shared path.
    const roleCandidates = Object.freeze(
      roleConstraint === "user"
        ? (["user"] as const)
        : roleConstraint === "assistant"
          ? (["assistant"] as const)
          : [...(requirement.roleCandidates ?? [])],
    );
    return Object.freeze({ ...requirement, roleConstraint, roleCandidates });
  });
  const hasAssistantLeaf = requirements.some(
    (requirement) => requirement.roleConstraint === "assistant",
  );
  if (!hasAssistantLeaf) {
    if (requirements.length === 0 || requirements.length >= 4) {
      throw namedError("MemoryEvidenceQueryPlanAssistantCapabilityMissing");
    }
    const seed = requirements[0];
    if (!seed) {
      throw namedError("MemoryEvidenceQueryPlanAssistantCapabilityMissing");
    }
    const ids = new Set(requirements.map((requirement) => requirement.requirementId));
    let requirementId = "origin_assistant_answer";
    for (let suffix = 2; ids.has(requirementId); suffix += 1) {
      requirementId = `origin_assistant_answer_${suffix}`;
    }
    const dagPlan = requirements.some(
      (requirement) => requirement.dependencyRelation !== undefined,
    );
    // Preserve all user leaves as dependency/context. The new assistant leaf
    // carries the same retrieval wording as the first planner leaf; it does
    // not reinterpret that user leaf as assistant-authored evidence.
    requirements = [
      ...requirements,
      Object.freeze({
        ...seed,
        requirementId,
        label: `Assistant answer: ${seed.label}`.slice(0, 192),
        roleConstraint: "assistant" as const,
        roleCandidates: Object.freeze(["assistant"] as const),
        ...(dagPlan
          ? {
              dependencyRelation: "independent" as const,
              dependsOnRequirementIds: Object.freeze([]),
            }
          : {}),
      }),
    ];
  }
  const hasUserDependency = requirements.some(
    (requirement) => requirement.roleConstraint === "user",
  );
  return Object.freeze({
    ...input.plan,
    // `any` here is solely the legal envelope for a user dependency plus an
    // assistant answer leaf. No resulting leaf has an `any` role.
    roleConstraint: hasUserDependency ? ("any" as const) : ("assistant" as const),
    requirements: Object.freeze(requirements),
  });
}

/** Build one requirement-bound, content-free capability for the locator. */
export function authorizeMemoryQueryAnswerOriginMaterializationV1(input: {
  readonly origin: MemoryQueryAnswerOriginV1;
  readonly requirement: MemoryEvidenceRequirementV3;
  readonly effectiveRequirementRole: MemoryEvidenceRoleConstraintV3;
  readonly mode: MemoryQueryAnswerOriginMaterializationModeV1;
}): MemoryQueryAnswerOriginAuthorizationV1 | undefined {
  assertMemoryQueryAnswerOriginV1(input.origin);
  if (!materializationCombinationAllowed(input)) return undefined;
  const identity = {
    authorizationVersion:
      PAW_MEMORY_QUERY_ANSWER_ORIGIN_AUTHORIZATION_VERSION_V1,
    originVersion: input.origin.originVersion,
    originKind: input.origin.originKind,
    originRevision: input.origin.originRevision,
    requirementId: input.requirement.requirementId,
    requirementRevision: hashCanonicalJsonV1(
      input.requirement as unknown as JsonValue,
    ),
    originalRequirementRole: input.requirement.roleConstraint,
    effectiveRequirementRole: input.effectiveRequirementRole,
    mode: input.mode,
  } as const;
  return Object.freeze({
    ...identity,
    authorizationRevision: hashCanonicalJsonV1(
      identity as unknown as JsonValue,
    ),
  });
}

/**
 * Recompile from the immutable original query at the locator boundary. This
 * prevents a caller from pairing a valid capability with a different query,
 * requirement, role, or materialization mode.
 */
export function validateMemoryQueryAnswerOriginAuthorizationV1(input: {
  readonly query: string;
  readonly authorization: MemoryQueryAnswerOriginAuthorizationV1;
  readonly requirement: MemoryEvidenceRequirementV3;
  readonly assistantDialogueCandidate: boolean;
}): void {
  const origin = compileMemoryQueryAnswerOriginV1(input.query);
  const authorization = input.authorization;
  if (
    authorization.authorizationVersion !==
      PAW_MEMORY_QUERY_ANSWER_ORIGIN_AUTHORIZATION_VERSION_V1 ||
    authorization.originVersion !== origin.originVersion ||
    authorization.originKind !== origin.originKind ||
    authorization.originRevision !== origin.originRevision ||
    authorization.requirementId !== input.requirement.requirementId ||
    authorization.effectiveRequirementRole !==
      input.requirement.roleConstraint ||
    ((authorization.mode === "late_binding" ||
      authorization.mode === "shared_envelope") &&
      !input.assistantDialogueCandidate)
  ) {
    throw namedError("MemorySourceLocalEvidenceAnswerOriginInvalid");
  }
  const originalRequirement = Object.freeze({
    ...input.requirement,
    roleConstraint: authorization.originalRequirementRole,
  });
  const expected = authorizeMemoryQueryAnswerOriginMaterializationV1({
    origin,
    requirement: originalRequirement,
    effectiveRequirementRole: input.requirement.roleConstraint,
    mode: authorization.mode,
  });
  if (
    !expected ||
    expected.authorizationRevision !== authorization.authorizationRevision
  ) {
    throw namedError("MemorySourceLocalEvidenceAnswerOriginInvalid");
  }
}

export function memoryQueryAnswerOriginAllowsLateBindingV1(
  origin: MemoryQueryAnswerOriginV1,
): boolean {
  assertMemoryQueryAnswerOriginV1(origin);
  return origin.originKind === "dialogue_artifact_unowned";
}

function materializationCombinationAllowed(input: {
  readonly origin: MemoryQueryAnswerOriginV1;
  readonly requirement: MemoryEvidenceRequirementV3;
  readonly effectiveRequirementRole: MemoryEvidenceRoleConstraintV3;
  readonly mode: MemoryQueryAnswerOriginMaterializationModeV1;
}): boolean {
  switch (input.mode) {
    case "late_binding":
      return (
        input.origin.originKind === "dialogue_artifact_unowned" &&
        input.requirement.roleConstraint === "user" &&
        input.effectiveRequirementRole === "any"
      );
    case "assistant_leaf":
      return (
        input.requirement.roleConstraint === "assistant" &&
        input.effectiveRequirementRole === "assistant" &&
        new Set<MemoryQueryAnswerOriginKindV1>([
          "explicit_assistant",
          "explicit_shared",
          "dialogue_artifact_unowned",
        ]).has(input.origin.originKind)
      );
    case "shared_envelope":
      return (
        input.requirement.roleConstraint === "any" &&
        input.effectiveRequirementRole === "any" &&
        new Set<MemoryQueryAnswerOriginKindV1>([
          "explicit_shared",
          "dialogue_artifact_unowned",
        ]).has(input.origin.originKind)
      );
  }
}

function assertMemoryQueryAnswerOriginV1(
  origin: MemoryQueryAnswerOriginV1,
): void {
  const identity = {
    originVersion: origin.originVersion,
    originKind: origin.originKind,
    classifiedRoleConstraint: origin.classifiedRoleConstraint,
    roleBoundary: origin.roleBoundary,
    features: origin.features,
  };
  if (
    origin.originVersion !== PAW_MEMORY_QUERY_ANSWER_ORIGIN_VERSION_V1 ||
    !new Set<MemoryQueryAnswerOriginKindV1>([
      "ordinary_semantic",
      "explicit_user",
      "explicit_assistant",
      "explicit_shared",
      "dialogue_artifact_unowned",
    ]).has(origin.originKind) ||
    hashCanonicalJsonV1(identity as unknown as JsonValue) !==
      origin.originRevision
  ) {
    throw namedError("MemoryQueryAnswerOriginInvalid");
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
