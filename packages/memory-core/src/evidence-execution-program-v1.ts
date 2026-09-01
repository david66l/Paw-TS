import { hashCanonicalJsonV1 } from "./canonical.js";
import { compileMemoryEvidenceObligationShapeV1 } from "./evidence-obligation.js";
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceBoundTemporalWindowV2,
  MemoryEvidenceDurationRequestV1,
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./query-plan-contracts.js";
import type {
  MemorySelectorExecutionRequirementV1,
  MemorySelectorExecutionSnapshotV1,
} from "./selector-execution-snapshot-v1.js";

export const PAW_MEMORY_EVIDENCE_EXECUTION_PROGRAM_VERSION_V1 =
  "paw.memory-evidence-execution-program.v1:typed-proof-gated-dag" as const;
export const PAW_MEMORY_EVIDENCE_AGGREGATE_REQUEST_VERSION_V1 =
  "paw.memory-evidence-aggregate-request.v1:typed-operation-unit-count-basis" as const;
export const PAW_MEMORY_EVIDENCE_PERSONALIZATION_REQUEST_VERSION_V1 =
  "paw.memory-evidence-personalization-request.v1:bounded-context" as const;

export interface MemoryEvidenceAggregateRequestV1 {
  readonly requestVersion: typeof PAW_MEMORY_EVIDENCE_AGGREGATE_REQUEST_VERSION_V1;
  readonly operator:
    "collect_unique" | "count" | "sum" | "difference" | "ratio_percent";
  readonly aggregationUnit:
    "event" | "semantic_value" | "entity" | "numeric_quantity";
  /**
   * Counting an enumerated evidence set is not the same operation as reading
   * a cardinality stated inside one piece of evidence. The latter needs a
   * separate typed certificate and must not be inferred from an arbitrary
   * number in free text.
   */
  readonly countBasis: "enumerated_members" | "stated_cardinality" | null;
  readonly queryRevision: string;
  readonly requestRevision: string;
}

export interface MemoryEvidencePersonalizationRequestV1 {
  readonly requestVersion: typeof PAW_MEMORY_EVIDENCE_PERSONALIZATION_REQUEST_VERSION_V1;
  /** This proves one answer constraint bundle, never a complete user profile. */
  readonly scope: "answer_personalization";
  readonly completionBasis: "bounded_context";
  readonly minimumContextObservations: 1;
  readonly queryRevision: string;
  readonly requestRevision: string;
}

export type MemoryEvidenceExecutionOperationV1 =
  | "read_requirement"
  | "resolve_latest"
  | "resolve_as_of"
  | "preserve_history"
  | "restrict_range"
  | "dependency_join"
  | "collect_operands"
  | "compare_operands"
  | "aggregate_operands"
  | "measure_duration"
  | "infer_preference"
  | "compile_personalization_profile"
  | "render_answer";

export type MemoryEvidenceExecutionOutputTypeV1 =
  | "evidence_set"
  | "state_value"
  | "ordered_history"
  | "collection"
  | "comparison"
  | "aggregate"
  | "temporal_duration"
  | "recommendation"
  | "rendered_answer";

export type MemoryEvidenceExecutionBlockedReasonV1 =
  | "unassessed_requirement"
  | "supporting_evidence_missing"
  | "role_unresolved"
  | "operand_blocked";

export interface MemoryEvidenceExecutionNodeV1 {
  readonly nodeId: string;
  readonly operation: MemoryEvidenceExecutionOperationV1;
  readonly outputType: MemoryEvidenceExecutionOutputTypeV1;
  readonly operandNodeIds: readonly string[];
  readonly completionPolicy: "single_operand" | "all_operands";
  readonly status: "ready" | "blocked";
  readonly blockedReason?: MemoryEvidenceExecutionBlockedReasonV1;
  readonly requirementId?: string;
  readonly groupId?: string;
  readonly necessity?: "required" | "contextual";
  readonly relation?: MemoryEvidenceRequirementV3["relation"];
  readonly coverageMode?: NonNullable<
    MemoryEvidenceRequirementV3["coverageMode"]
  >;
  readonly minimumIndependentEvidence?: number;
  readonly dependencyRelation?: NonNullable<
    MemoryEvidenceRequirementV3["dependencyRelation"]
  >;
  readonly dependencyRequirementIds?: readonly string[];
  readonly requirementRevision?: string;
  readonly temporalBindingRevision?: string;
  readonly temporalWindow?: MemoryEvidenceBoundTemporalWindowV2;
  readonly durationRequest?: MemoryEvidenceDurationRequestV1;
  readonly aggregateRequest?: MemoryEvidenceAggregateRequestV1;
  readonly personalizationRequest?: MemoryEvidencePersonalizationRequestV1;
  readonly resolvedRole?: "user" | "assistant";
  readonly supportingEvidenceRefs?: readonly string[];
  readonly nodeRevision: string;
}

export interface MemoryEvidenceExecutionProgramV1 {
  readonly programVersion: typeof PAW_MEMORY_EVIDENCE_EXECUTION_PROGRAM_VERSION_V1;
  readonly selectorSnapshotRevision: string;
  readonly originRevision: string;
  readonly lockedSourceRevision: string;
  readonly obligationKind: "answer_operands" | "personalization_context";
  readonly obligationRevision: string;
  /** Readiness only; execution results are a separate proof-carrying object. */
  readonly status: "ready" | "partial" | "fallback";
  readonly rootNodeId: string;
  /** Typed answer operation; the root is a separate render contract node. */
  readonly answerNodeId: string;
  /** Obligation DAG output frontier; consumed dependency leaves are excluded. */
  readonly answerOperandNodeIds: readonly string[];
  readonly nodes: readonly MemoryEvidenceExecutionNodeV1[];
  readonly readyRequirementCount: number;
  readonly blockedRequirementCount: number;
  readonly programRevision: string;
}

/**
 * Compiles a proof-gated answer DAG. Model-written notes may later populate
 * leaf values, but they cannot alter operands, temporal operators, or closure.
 */
export function compileMemoryEvidenceExecutionProgramV1(input: {
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly selectorSnapshot: MemorySelectorExecutionSnapshotV1;
}): MemoryEvidenceExecutionProgramV1 {
  if (
    input.requirements.length < 1 ||
    input.requirements.length > 4 ||
    input.temporalConstraints.length !== input.requirements.length
  ) {
    throw namedError("MemoryEvidenceExecutionProgramInputInvalid");
  }
  const executionByRequirement = new Map(
    input.selectorSnapshot.groups.flatMap((group) =>
      group.requirements.map(
        (requirement) =>
          [
            requirement.requirementId,
            Object.freeze({ groupId: group.groupId, execution: requirement }),
          ] as const,
      ),
    ),
  );
  if (
    input.selectorSnapshot.originRevision.length < 1 ||
    executionByRequirement.size !== input.requirements.length
  ) {
    throw namedError("MemoryEvidenceExecutionProgramSnapshotInvalid");
  }

  const nodes: MemoryEvidenceExecutionNodeV1[] = [];
  const terminalByRequirement = new Map<
    string,
    MemoryEvidenceExecutionNodeV1
  >();
  const temporalByRequirement = new Map(
    input.requirements.map((requirement, index) => [
      requirement.requirementId,
      input.temporalConstraints[index],
    ]),
  );
  let readyRequirementCount = 0;
  for (const requirement of topologicalRequirements(input.requirements)) {
    const temporal = temporalByRequirement.get(requirement.requirementId);
    const execution = executionByRequirement.get(requirement.requirementId);
    if (
      !temporal ||
      !execution ||
      execution.execution.requirementRevision !==
        hashCanonicalJsonV1(requirement as never) ||
      execution.execution.temporalBindingRevision !== temporal.bindingRevision
    ) {
      throw namedError("MemoryEvidenceExecutionProgramSnapshotInvalid");
    }
    const readNode = compileReadNode(
      requirement,
      temporal,
      execution.execution,
      execution.groupId,
    );
    nodes.push(readNode);
    if (readNode.status === "ready") readyRequirementCount += 1;
    let terminal = readNode;
    for (const operation of temporalOperations(
      requirement.temporalMode,
      temporal,
    )) {
      terminal = compileDerivedNode({
        operation,
        outputType:
          operation === "resolve_latest" || operation === "resolve_as_of"
            ? "state_value"
            : "ordered_history",
        operandNodeIds: Object.freeze([terminal.nodeId]),
        temporalWindow: temporal.window,
        operands: Object.freeze([terminal]),
      });
      nodes.push(terminal);
    }
    const dependencyNodeIds = Object.freeze(
      (requirement.dependsOnRequirementIds ?? []).map((requirementId) => {
        const dependency = terminalByRequirement.get(requirementId);
        if (!dependency) {
          throw namedError("MemoryEvidenceExecutionProgramDependencyInvalid");
        }
        return dependency.nodeId;
      }),
    );
    if (dependencyNodeIds.length > 0) {
      const operandNodeIds = Object.freeze([
        ...dependencyNodeIds,
        terminal.nodeId,
      ]);
      terminal = compileDerivedNode({
        operation: "dependency_join",
        outputType: "collection",
        operandNodeIds,
        dependencyRelation: requirement.dependencyRelation ?? "depends_on",
        dependencyRequirementIds: Object.freeze([
          ...(requirement.dependsOnRequirementIds ?? []),
        ]),
        operands: Object.freeze(
          operandNodeIds.map((nodeId) => {
            const operand = nodes.find((node) => node.nodeId === nodeId);
            if (!operand) {
              throw namedError("MemoryEvidenceExecutionProgramGraphInvalid");
            }
            return operand;
          }),
        ),
      });
      nodes.push(terminal);
    }
    terminalByRequirement.set(requirement.requirementId, terminal);
  }

  const consumedRequirementIds = new Set(
    input.requirements.flatMap(
      (requirement) => requirement.dependsOnRequirementIds ?? [],
    ),
  );
  const answerOperandNodeIds = Object.freeze(
    input.requirements
      .filter(
        (requirement) => !consumedRequirementIds.has(requirement.requirementId),
      )
      .map((requirement) => {
        const terminal = terminalByRequirement.get(requirement.requirementId);
        if (!terminal) {
          throw namedError("MemoryEvidenceExecutionProgramGraphInvalid");
        }
        return terminal.nodeId;
      }),
  );
  const terminals = answerOperandNodeIds.map((nodeId) => {
    const node = nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw namedError("MemoryEvidenceExecutionProgramGraphInvalid");
    return node;
  });
  const durationRequests = input.temporalConstraints.flatMap((temporal) =>
    temporal.durationRequest ? [temporal.durationRequest] : [],
  );
  const durationRequest = durationRequests[0];
  if (
    durationRequest &&
    durationRequests.some(
      (candidate) =>
        candidate.requestRevision !== durationRequest.requestRevision,
    )
  ) {
    throw namedError("MemoryEvidenceExecutionProgramTemporalInvalid");
  }
  const aggregateRequest =
    input.intent.answerShape === "aggregate" && durationRequest === undefined
      ? compileMemoryEvidenceAggregateRequestV1(input.query)
      : undefined;
  const personalizationRequest =
    input.intent.answerShape === "recommend"
      ? compileMemoryEvidencePersonalizationRequestV1(input.query)
      : undefined;
  const answerOperation = answerOperationFor(
    input.intent.answerShape,
    durationRequest,
  );
  const answerNode = compileDerivedNode({
    operation: answerOperation.operation,
    outputType: answerOperation.outputType,
    operandNodeIds: answerOperandNodeIds,
    ...(durationRequest === undefined ? {} : { durationRequest }),
    ...(aggregateRequest === undefined ? {} : { aggregateRequest }),
    ...(personalizationRequest === undefined ? {} : { personalizationRequest }),
    operands: Object.freeze(terminals),
  });
  nodes.push(answerNode);
  const renderNode = compileDerivedNode({
    operation: "render_answer",
    outputType: "rendered_answer",
    operandNodeIds: Object.freeze([answerNode.nodeId]),
    operands: Object.freeze([answerNode]),
  });
  nodes.push(renderNode);
  assertAcyclic(nodes);

  const frozenNodes = Object.freeze(nodes);
  const obligationShape = compileMemoryEvidenceObligationShapeV1(
    input.query,
    input.intent,
  );
  const status =
    renderNode.status === "ready"
      ? ("ready" as const)
      : readyRequirementCount > 0
        ? ("partial" as const)
        : ("fallback" as const);
  const identity = {
    programVersion: PAW_MEMORY_EVIDENCE_EXECUTION_PROGRAM_VERSION_V1,
    selectorSnapshotRevision: input.selectorSnapshot.snapshotRevision,
    originRevision: input.selectorSnapshot.originRevision,
    lockedSourceRevision: input.selectorSnapshot.lockedSourceRevision,
    obligationKind: obligationShape.obligationKind,
    obligationRevision: hashCanonicalJsonV1(obligationShape as never),
    status,
    rootNodeId: renderNode.nodeId,
    answerNodeId: answerNode.nodeId,
    answerOperandNodeIds,
    nodes: frozenNodes,
    readyRequirementCount,
    blockedRequirementCount: input.requirements.length - readyRequirementCount,
  };
  return Object.freeze({
    ...identity,
    programRevision: hashCanonicalJsonV1(identity as never),
  });
}

/** Revalidates every host-compiled identity before the runtime trusts it. */
export function validateMemoryEvidenceExecutionProgramV1(
  program: MemoryEvidenceExecutionProgramV1,
): void {
  const { programRevision, ...programIdentity } = program;
  if (
    hashCanonicalJsonV1(programIdentity as never) !== programRevision ||
    program.nodes.length < 3
  ) {
    throw namedError("MemoryEvidenceExecutionProgramInvalid");
  }
  for (const node of program.nodes) {
    const { nodeRevision, ...nodeIdentity } = node;
    const expectedNodeId =
      node.operation === "read_requirement"
        ? hashCanonicalJsonV1({
            programVersion: PAW_MEMORY_EVIDENCE_EXECUTION_PROGRAM_VERSION_V1,
            operation: node.operation,
            requirementId: node.requirementId,
          } as never)
        : hashCanonicalJsonV1({
            programVersion: PAW_MEMORY_EVIDENCE_EXECUTION_PROGRAM_VERSION_V1,
            operation: node.operation,
            operandNodeIds: node.operandNodeIds,
          } as never);
    if (
      expectedNodeId !== node.nodeId ||
      hashCanonicalJsonV1(nodeIdentity as never) !== nodeRevision
    ) {
      throw namedError("MemoryEvidenceExecutionProgramInvalid");
    }
    if (node.durationRequest) {
      const { requestRevision, ...requestIdentity } = node.durationRequest;
      if (hashCanonicalJsonV1(requestIdentity as never) !== requestRevision) {
        throw namedError("MemoryEvidenceExecutionProgramInvalid");
      }
    }
    if (node.aggregateRequest) {
      const { requestRevision, ...requestIdentity } = node.aggregateRequest;
      if (hashCanonicalJsonV1(requestIdentity as never) !== requestRevision) {
        throw namedError("MemoryEvidenceExecutionProgramInvalid");
      }
    }
    if (node.personalizationRequest) {
      const { requestRevision, ...requestIdentity } =
        node.personalizationRequest;
      if (hashCanonicalJsonV1(requestIdentity as never) !== requestRevision) {
        throw namedError("MemoryEvidenceExecutionProgramInvalid");
      }
    }
  }
  try {
    assertAcyclic(program.nodes);
  } catch {
    throw namedError("MemoryEvidenceExecutionProgramInvalid");
  }
  const byId = new Map(program.nodes.map((node) => [node.nodeId, node]));
  const root = byId.get(program.rootNodeId);
  const answer = byId.get(program.answerNodeId);
  const readyRequirementCount = program.nodes.filter(
    (node) => node.operation === "read_requirement" && node.status === "ready",
  ).length;
  const requirementCount = program.nodes.filter(
    (node) => node.operation === "read_requirement",
  ).length;
  const expectedStatus =
    root?.status === "ready"
      ? ("ready" as const)
      : readyRequirementCount > 0
        ? ("partial" as const)
        : ("fallback" as const);
  if (
    !root ||
    !answer ||
    root.operation !== "render_answer" ||
    root.operandNodeIds.length !== 1 ||
    root.operandNodeIds[0] !== answer.nodeId ||
    program.answerOperandNodeIds.some((nodeId) => !byId.has(nodeId)) ||
    program.readyRequirementCount !== readyRequirementCount ||
    program.blockedRequirementCount !==
      requirementCount - readyRequirementCount ||
    program.status !== expectedStatus
  ) {
    throw namedError("MemoryEvidenceExecutionProgramInvalid");
  }
}

function compileReadNode(
  requirement: Readonly<MemoryEvidenceRequirementV3>,
  temporal: Readonly<MemoryEvidenceBoundTemporalConstraintV1>,
  execution: Readonly<MemorySelectorExecutionRequirementV1>,
  groupId: string,
): MemoryEvidenceExecutionNodeV1 {
  const supportingEvidenceRefs = Object.freeze([
    ...(execution.assessment?.supportingEvidenceRefs ?? []),
  ]);
  const blockedReason: MemoryEvidenceExecutionBlockedReasonV1 | undefined =
    execution.status !== "assessed"
      ? "unassessed_requirement"
      : supportingEvidenceRefs.length === 0
        ? "supporting_evidence_missing"
        : requirement.roleConstraint === "any" && !execution.resolvedRole
          ? "role_unresolved"
          : undefined;
  const identity = {
    operation: "read_requirement" as const,
    outputType: "evidence_set" as const,
    operandNodeIds: Object.freeze([]),
    completionPolicy: "single_operand" as const,
    status:
      blockedReason === undefined ? ("ready" as const) : ("blocked" as const),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    requirementId: requirement.requirementId,
    groupId,
    necessity: "required" as const,
    relation: requirement.relation ?? "direct",
    coverageMode:
      requirement.coverageMode ??
      (requirement.temporalMode === "latest" ? "latest" : "any"),
    minimumIndependentEvidence: requirement.minimumEvidence ?? 1,
    dependencyRelation: requirement.dependencyRelation ?? "independent",
    dependencyRequirementIds: Object.freeze([
      ...(requirement.dependsOnRequirementIds ?? []),
    ]),
    requirementRevision: execution.requirementRevision,
    temporalBindingRevision: temporal.bindingRevision,
    ...(execution.resolvedRole === undefined
      ? requirement.roleConstraint === "any"
        ? {}
        : { resolvedRole: requirement.roleConstraint }
      : { resolvedRole: execution.resolvedRole }),
    supportingEvidenceRefs,
  };
  const nodeId = hashCanonicalJsonV1({
    programVersion: PAW_MEMORY_EVIDENCE_EXECUTION_PROGRAM_VERSION_V1,
    operation: identity.operation,
    requirementId: requirement.requirementId,
  } as never);
  return Object.freeze({
    nodeId,
    ...identity,
    nodeRevision: hashCanonicalJsonV1({ nodeId, ...identity } as never),
  });
}

function compileDerivedNode(input: {
  readonly operation: Exclude<
    MemoryEvidenceExecutionOperationV1,
    "read_requirement"
  >;
  readonly outputType: MemoryEvidenceExecutionOutputTypeV1;
  readonly operandNodeIds: readonly string[];
  readonly operands: readonly MemoryEvidenceExecutionNodeV1[];
  readonly dependencyRelation?: NonNullable<
    MemoryEvidenceRequirementV3["dependencyRelation"]
  >;
  readonly dependencyRequirementIds?: readonly string[];
  readonly temporalWindow?: MemoryEvidenceBoundTemporalWindowV2;
  readonly durationRequest?: MemoryEvidenceDurationRequestV1;
  readonly aggregateRequest?: MemoryEvidenceAggregateRequestV1;
  readonly personalizationRequest?: MemoryEvidencePersonalizationRequestV1;
}): MemoryEvidenceExecutionNodeV1 {
  if (
    input.operandNodeIds.length < 1 ||
    input.operandNodeIds.length !== input.operands.length ||
    new Set(input.operandNodeIds).size !== input.operandNodeIds.length
  ) {
    throw namedError("MemoryEvidenceExecutionProgramGraphInvalid");
  }
  const blocked = input.operands.some((operand) => operand.status !== "ready");
  const identity = {
    operation: input.operation,
    outputType: input.outputType,
    operandNodeIds: Object.freeze([...input.operandNodeIds]),
    completionPolicy: "all_operands" as const,
    status: blocked ? ("blocked" as const) : ("ready" as const),
    ...(blocked ? { blockedReason: "operand_blocked" as const } : {}),
    ...(input.dependencyRelation === undefined
      ? {}
      : { dependencyRelation: input.dependencyRelation }),
    ...(input.dependencyRequirementIds === undefined
      ? {}
      : {
          dependencyRequirementIds: Object.freeze([
            ...input.dependencyRequirementIds,
          ]),
        }),
    ...(input.temporalWindow === undefined
      ? {}
      : { temporalWindow: input.temporalWindow }),
    ...(input.durationRequest === undefined
      ? {}
      : { durationRequest: input.durationRequest }),
    ...(input.aggregateRequest === undefined
      ? {}
      : { aggregateRequest: input.aggregateRequest }),
    ...(input.personalizationRequest === undefined
      ? {}
      : { personalizationRequest: input.personalizationRequest }),
  };
  const nodeId = hashCanonicalJsonV1({
    programVersion: PAW_MEMORY_EVIDENCE_EXECUTION_PROGRAM_VERSION_V1,
    operation: input.operation,
    operandNodeIds: identity.operandNodeIds,
  } as never);
  return Object.freeze({
    nodeId,
    ...identity,
    nodeRevision: hashCanonicalJsonV1({ nodeId, ...identity } as never),
  });
}

export function compileMemoryEvidencePersonalizationRequestV1(
  query: string,
): MemoryEvidencePersonalizationRequestV1 {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryEvidencePersonalizationRequestQueryInvalid");
  }
  const identity = {
    requestVersion: PAW_MEMORY_EVIDENCE_PERSONALIZATION_REQUEST_VERSION_V1,
    scope: "answer_personalization" as const,
    completionBasis: "bounded_context" as const,
    minimumContextObservations: 1 as const,
    queryRevision: hashCanonicalJsonV1(value as never),
  };
  return Object.freeze({
    ...identity,
    requestRevision: hashCanonicalJsonV1(identity as never),
  });
}

export function compileMemoryEvidenceAggregateRequestV1(
  query: string,
): MemoryEvidenceAggregateRequestV1 {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryEvidenceAggregateRequestQueryInvalid");
  }
  const ratio =
    /\b(?:what\s+percentage|percent(?:age)?\s+of|ratio\s+of|proportion\s+of)\b|(?:百分之|百分比|比例|占.{0,24}(?:比例|百分比))/iu.test(
      value,
    );
  const difference =
    /\b(?:how\s+(?:much|many).{0,48}(?:more|less)|older|younger|faster|slower|earlier|later|exceed(?:ed)?|difference\s+between)\b|(?:多(?:了|出|花|赚|省)|少(?:了|花)|相差|差额|早了|晚了|快了|慢了)/iu.test(
      value,
    );
  const sum =
    /\b(?:total|combined|altogether|in\s+total|sum\s+of)\b|(?:总共|合计|一共|加起来|总计)/iu.test(
      value,
    );
  const count =
    /\b(?:how\s+many|number\s+of|count\s+of)\b|(?:多少(?:个|次|项|件|场|门|条|本|人|只)?|几个|几次)/iu.test(
      value,
    );
  const operator = ratio
    ? ("ratio_percent" as const)
    : difference
      ? ("difference" as const)
      : sum
        ? ("sum" as const)
        : count
          ? ("count" as const)
          : ("collect_unique" as const);
  const aggregationUnit =
    operator === "sum" ||
    operator === "difference" ||
    operator === "ratio_percent"
      ? ("numeric_quantity" as const)
      : /\b(?:different|distinct|unique|types?\s+of|kinds?\s+of)\b|(?:不同|各类|种类|唯一)/iu.test(
            value,
          )
        ? ("semantic_value" as const)
        : /\b(?:times?|events?|appointments?|ceremon(?:y|ies)|trips?|visits?|orders?|sessions?|weddings?|parties|classes|festivals?|runs?|projects?)\b|(?:次数|活动|预约|典礼|旅行|访问|订单|会话|婚礼|聚会|课程|项目)/iu.test(
              value,
            )
          ? ("event" as const)
          : operator === "count"
            ? ("entity" as const)
            : ("semantic_value" as const);
  const countBasis =
    operator !== "count"
      ? null
      : aggregationUnit === "event" || aggregationUnit === "semantic_value"
        ? ("enumerated_members" as const)
        : ("stated_cardinality" as const);
  const identity = {
    requestVersion: PAW_MEMORY_EVIDENCE_AGGREGATE_REQUEST_VERSION_V1,
    operator,
    aggregationUnit,
    countBasis,
    queryRevision: hashCanonicalJsonV1(value as never),
  };
  return Object.freeze({
    ...identity,
    requestRevision: hashCanonicalJsonV1(identity as never),
  });
}

function temporalOperations(
  temporalMode: MemoryEvidenceRequirementV3["temporalMode"],
  temporal: MemoryEvidenceBoundTemporalConstraintV1,
): readonly Exclude<MemoryEvidenceExecutionOperationV1, "read_requirement">[] {
  if (temporal.durationRequest) return Object.freeze([]);
  if (temporalMode === "latest") return Object.freeze(["resolve_latest"]);
  if (temporalMode === "as_of") return Object.freeze(["resolve_as_of"]);
  if (temporalMode === "history") return Object.freeze(["preserve_history"]);
  if (temporalMode === "range") {
    return Object.freeze(["restrict_range", "preserve_history"]);
  }
  return Object.freeze([]);
}

function answerOperationFor(
  answerShape: MemoryEvidenceQueryIntentV3["answerShape"],
  durationRequest?: MemoryEvidenceDurationRequestV1,
): Readonly<{
  operation: Exclude<MemoryEvidenceExecutionOperationV1, "read_requirement">;
  outputType: MemoryEvidenceExecutionOutputTypeV1;
}> {
  if (durationRequest) {
    return Object.freeze({
      operation: "measure_duration",
      outputType: "temporal_duration",
    });
  }
  if (answerShape === "compare") {
    return Object.freeze({
      operation: "compare_operands",
      outputType: "comparison",
    });
  }
  if (answerShape === "aggregate") {
    return Object.freeze({
      operation: "aggregate_operands",
      outputType: "aggregate",
    });
  }
  if (answerShape === "recommend") {
    return Object.freeze({
      operation: "compile_personalization_profile",
      outputType: "recommendation",
    });
  }
  return Object.freeze({
    operation: "collect_operands",
    outputType: "collection",
  });
}

function assertAcyclic(nodes: readonly MemoryEvidenceExecutionNodeV1[]): void {
  const seen = new Set<string>();
  for (const node of nodes) {
    if (
      seen.has(node.nodeId) ||
      node.operandNodeIds.some((operandNodeId) => !seen.has(operandNodeId))
    ) {
      throw namedError("MemoryEvidenceExecutionProgramGraphInvalid");
    }
    seen.add(node.nodeId);
  }
}

function topologicalRequirements(
  requirements: readonly MemoryEvidenceRequirementV3[],
): readonly MemoryEvidenceRequirementV3[] {
  const byId = new Map(
    requirements.map((requirement, index) => [
      requirement.requirementId,
      { requirement, index },
    ]),
  );
  const indegree = new Map(
    requirements.map((requirement) => [requirement.requirementId, 0]),
  );
  const dependents = new Map<string, string[]>();
  for (const requirement of requirements) {
    for (const dependency of requirement.dependsOnRequirementIds ?? []) {
      if (!byId.has(dependency) || dependency === requirement.requirementId) {
        throw namedError("MemoryEvidenceExecutionProgramDependencyInvalid");
      }
      indegree.set(
        requirement.requirementId,
        (indegree.get(requirement.requirementId) ?? 0) + 1,
      );
      const rows = dependents.get(dependency) ?? [];
      rows.push(requirement.requirementId);
      dependents.set(dependency, rows);
    }
  }
  const ready = requirements
    .filter((requirement) => indegree.get(requirement.requirementId) === 0)
    .sort(
      (left, right) =>
        (byId.get(left.requirementId)?.index ?? 0) -
        (byId.get(right.requirementId)?.index ?? 0),
    );
  const ordered: MemoryEvidenceRequirementV3[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as MemoryEvidenceRequirementV3;
    ordered.push(current);
    for (const dependentId of dependents.get(current.requirementId) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        const dependent = byId.get(dependentId)?.requirement;
        if (dependent) ready.push(dependent);
        ready.sort(
          (left, right) =>
            (byId.get(left.requirementId)?.index ?? 0) -
            (byId.get(right.requirementId)?.index ?? 0),
        );
      }
    }
  }
  if (ordered.length !== requirements.length) {
    throw namedError("MemoryEvidenceExecutionProgramDependencyInvalid");
  }
  return Object.freeze(ordered);
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
