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
