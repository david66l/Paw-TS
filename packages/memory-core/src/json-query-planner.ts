import {
  compileMemoryEvidenceObligationShapeV1,
  validateMemoryEvidenceObligationsV1,
} from "./evidence-obligation.js";
import type { MemoryWriterModelV1 } from "./model-port.js";
import {
  classifyMemoryEvidenceIntentBoundaryV1,
  classifyMemoryEvidenceQueryV3,
  needsCertifiedAssistantDialogueCandidateV1,
} from "./query-classifier.js";
import {
  type MemoryEvidenceCoverageModeV3,
  type MemoryEvidenceIntentBoundaryV1,
  type MemoryEvidenceQueryIntentV3,
  type MemoryEvidenceQueryPlanOptionsV3,
  type MemoryEvidenceQueryPlanRevisionV1,
  type MemoryEvidenceQueryPlanV3,
  type MemoryEvidenceQueryPlannerV3,
  type MemoryEvidenceRelationV3,
  type MemoryEvidenceRequirementDependencyV4,
  type MemoryEvidenceRequirementV3,
  PAW_MEMORY_EVIDENCE_MAX_DEFICIENCIES_V1,
  PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
} from "./query-plan-contracts.js";
import {
  compileMemoryEvidenceTemporalConstraintV1,
  memoryEvidenceLeafTemporalModeAllowedV1,
  validateMemoryEvidenceTemporalConstraintV1,
} from "./temporal-constraint.js";

export function createJsonMemoryEvidenceQueryPlannerV3(input: {
  readonly model: MemoryWriterModelV1;
}): MemoryEvidenceQueryPlannerV3 {
  if (!input.model || typeof input.model.complete !== "function") {
    throw namedError("MemoryEvidenceQueryPlannerModelInvalid");
  }
  return Object.freeze({
    plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
    async plan(
      query: string,
      signal: AbortSignal,
      options?: MemoryEvidenceQueryPlanOptionsV3,
    ) {
      const intent = classifyMemoryEvidenceQueryV3(query);
      if (
        !intent.needsPlanning &&
        options?.force !== true &&
        options?.revision === undefined
      ) {
        return Object.freeze({
          plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
          ...intent,
          requirements: Object.freeze([]),
        });
      }
      const request = buildMemoryEvidenceQueryPlanRequestV3(
        query,
        intent,
        options?.revision,
      );
      if (signal.aborted) throw abortError();
      const result = await input.model.complete(request, { signal });
      if (signal.aborted || result.status === "cancelled") throw abortError();
      if (result.status !== "completed") {
        throw namedError(stableName(result.errorCode));
      }
      const plan = parseMemoryEvidenceQueryPlanV3(result.text, query, intent);
      if (plan.requirements.length === 0) {
        throw namedError("MemoryEvidenceQueryPlanRequirementsEmpty");
      }
      return plan;
    },
  });
}

export function buildMemoryEvidenceQueryPlanRequestV3(
  query: string,
  intent = classifyMemoryEvidenceQueryV3(query),
  revision?: MemoryEvidenceQueryPlanRevisionV1,
): Readonly<{ system: string; user: string }> {
  const value = boundedQuery(query);
  const planRevision = revision
    ? validatePlanRevision(revision, intent, value)
    : undefined;
  const certifiedAssistantDialogueCandidate =
    intent.roleConstraint === "user" &&
    needsCertifiedAssistantDialogueCandidateV1(value);
  return Object.freeze({
    system: [
      "You plan retrieval requirements, not the answer.",
      "The memory store contains concrete past dialogue, so bridge the current wording to concrete clues that may have been stated earlier.",
      "Answer shape, temporal envelope, and role constraint are independent axes.",
      "The caller supplies an intentBoundary for each axis. Return fixed answer-shape and query-level temporal envelopes unchanged. A leaf temporalMode is a retrieval operation inside that envelope and may differ when compatible; it is never permission to invent a timestamp, date, or interval. A fixed role axis is a mandatory authority leaf: preserve at least one leaf with that role. Only when the query also requires a dependent artifact authored by the other dialogue participant may the plan add that concrete-role leaf and widen the query envelope to any.",
      "The caller also supplies a deterministic obligationShape. It describes only how many independent facts and evidence items must be bound. Your plan must satisfy it.",
      "The query-level roleConstraint is only an envelope. Use user or assistant when every answer leaf has that role; use any when the plan contains both roles. Query-level any never grants a leaf permission to use either role.",
      "Every requirement is an answer leaf and must declare exactly one concrete roleConstraint: user for a user-authored fact, or assistant only for the assistant's exact prior words or actions. Never emit roleConstraint=any on a requirement.",
      "Decompose provenance from answer ownership. If a requested prior-dialogue artifact was produced in response to user-provided context, constraints, examples, or a request, emit both the user provenance leaf and the assistant artifact leaf; connect the assistant leaf to the user leaf with responds_to. The context leaf locates and certifies the exchange but cannot satisfy the artifact leaf.",
      "Do not collapse a cross-role exchange into one leaf merely because one participant supplied the topic or constraints. Do not add an assistant leaf when the query asks only for the user's own fact, choice, action, possession, preference, or experience.",
      "Represent cross-role composition as a directed acyclic obligation graph. Give every requirement a stable key. Use dependencyRelation=independent with dependsOn=[] for a root; depends_on for a derived leaf; responds_to only for an assistant answer leaf that depends on its user request/context leaf; supersedes only for a later state that replaces an earlier state.",
      ...(certifiedAssistantDialogueCandidate
        ? [
            "certifiedAssistantDialogueCandidate=true keeps the classified user leaf mandatory while allowing a separate, certificate-gated assistant artifact leaf when the original query requires that artifact. Never replace the user leaf with the assistant leaf or assume assistant authorship from topical overlap.",
          ]
        : []),
      "For a new recommendation, advice, or personalized explanation request, emit one user-authored personalization-context requirement whose searchText covers the relevant union of possessions, goals, constraints, routines, prior attempts, and explicit likes or dislikes. These are optional evidence dimensions inside one context bundle, not separate mandatory answer leaves. Emit separate leaves only when the question explicitly asks for independently returned facts or a prior assistant artifact.",
      "For compare or aggregate requests, create one requirement and search per independent operand.",
      "For count, sum, difference, ratio, or duration questions, retrieve the exact event or quantity operands with their units; never calculate inside searchText and never replace several named operands with an invented total.",
      "Do not split one operand into separate identity, value, threshold, status, or background requirements when one concrete memory can establish it.",
      "A single requested quantity is one requirement. An aggregate across N named entities is N requirements, one per entity.",
      "For latest, as_of, history, or range leaves, include state and time wording without inventing a date. Absolute anchors and intervals are bound deterministically from the original query and trusted question cutoff, never from your output.",
      "For every requirement declare relation, coverageMode, and minimumEvidence. These describe evidence closure, not an answer.",
      "Use relation=direct for an explicitly stated fact, temporal for state over time, comparative for one operand in a comparison or aggregate, and inferred only when multiple concrete observations must support a conclusion.",
      "Use coverageMode=any with minimumEvidence=1 for one direct fact, latest with 1 for controlling current state, all when the listed independent facts are jointly necessary, and convergent with 2 or 3 independent observations for an inference.",
      "minimumEvidence must be 1, 2, or 3. Never demand multiple copies of the same statement.",
      "Every item is a search hint only. Never invent a user fact, preference, event, entity, amount, date, or answer.",
      "Each requirement must bind its human-readable evidence need to exactly one concrete search text; never return parallel arrays.",
      ...(planRevision
        ? [
            "A closure verifier found bounded deficiencies in the current plan.",
            "Return one complete replacement plan, not an append-only patch. Preserve valid requirements, merge or replace overlapping items, and fit every necessary answer slot within maxRequirements.",
            "Deficiencies contain reason codes only. A targetRequirementId points to an existing weak or wrong requirement; a missing target means the original query contains an omitted operand or constraint. Re-read the original query and current plan to identify it.",
            "Repeated query-level reason codes mean multiple slots were omitted. You alone own label, searchText, relation, coverageMode, minimumEvidence, and the final requirement boundaries.",
          ]
        : []),
      'Return exactly one JSON object: {"answerShape":"...","temporalMode":"...","roleConstraint":"user|assistant|any","requirements":[{"key":"stable-key","label":"...","searchText":"...","temporalMode":"any|latest|as_of|history|range","roleConstraint":"user|assistant","relation":"direct|temporal|comparative|inferred","coverageMode":"any|all|latest|convergent","minimumEvidence":1,"dependencyRelation":"independent|depends_on|responds_to|supersedes","dependsOn":["earlier-key"]}]}.',
    ].join("\n"),
    user: JSON.stringify({
      schemaVersion: "paw.memory-evidence-query-plan-input.v5",
      query: value,
      answerShape: intent.answerShape,
      temporalMode: intent.temporalMode,
      roleConstraint: intent.roleConstraint,
      intentBoundary: classifyMemoryEvidenceIntentBoundaryV1(value, intent),
      obligationShape: compileMemoryEvidenceObligationShapeV1(value, intent),
      ...(planRevision
        ? {
            revision: {
              currentRequirements: planRevision.currentRequirements.map(
                (requirement) => ({
                  requirementId: requirement.requirementId,
                  label: requirement.label,
                  searchText: requirement.searchText,
                  relation: requirement.relation ?? "direct",
                  coverageMode:
                    requirement.coverageMode ??
                    (requirement.temporalMode === "latest" ? "latest" : "any"),
                  minimumEvidence: requirement.minimumEvidence ?? 1,
                  temporalMode: requirement.temporalMode,
                  roleConstraint: requirement.roleConstraint,
                  dependencyRelation:
                    requirement.dependencyRelation ?? "independent",
                  dependsOn: requirement.dependsOnRequirementIds ?? [],
                }),
              ),
              deficiencies: planRevision.deficiencies.map((deficiency) => ({
                reason: deficiency.reason,
                targetRequirementId: deficiency.targetRequirementId,
              })),
            },
          }
        : {}),
      ...(certifiedAssistantDialogueCandidate
        ? { certifiedAssistantDialogueCandidate: true }
        : {}),
      maxRequirements: 4,
      maxItemChars: 192,
    }),
  });
}

function validatePlanRevision(
  revision: MemoryEvidenceQueryPlanRevisionV1,
  intent: MemoryEvidenceQueryIntentV3,
  query: string,
): MemoryEvidenceQueryPlanRevisionV1 {
  const boundary = classifyMemoryEvidenceIntentBoundaryV1(query, intent);
  if (
    revision.currentRequirements.length < 1 ||
    revision.currentRequirements.length > 4 ||
    revision.deficiencies.length < 1 ||
    revision.deficiencies.length > PAW_MEMORY_EVIDENCE_MAX_DEFICIENCIES_V1
  ) {
    throw namedError("MemoryEvidenceQueryPlanRevisionInvalid");
  }
  const reasons = new Set([
    "missing_operand",
    "missing_constraint",
    "wrong_role",
    "wrong_time",
    "weak_support",
  ]);
  for (const requirement of revision.currentRequirements) {
    if (
      !memoryEvidenceLeafTemporalModeAllowedV1(
        intent.temporalMode,
        requirement.temporalMode,
      ) ||
      !axisValueAllowed(
        requirement.roleConstraint,
        intent.roleConstraint,
        boundary.roleConstraint,
      ) ||
      !requirement.requirementId.trim() ||
      !requirement.label.trim() ||
      !requirement.searchText.trim()
    ) {
      throw namedError("MemoryEvidenceQueryPlanRevisionInvalid");
    }
    if (requirement.temporalConstraint) {
      try {
        validateMemoryEvidenceTemporalConstraintV1({
          query,
          queryEnvelopeMode: intent.temporalMode,
          leafMode: requirement.temporalMode,
          constraint: requirement.temporalConstraint,
        });
      } catch {
        throw namedError("MemoryEvidenceQueryPlanRevisionInvalid");
      }
    }
  }
  const requirementIds = new Set(
    revision.currentRequirements.map(
      (requirement) => requirement.requirementId,
    ),
  );
  const deficiencies = revision.deficiencies.map((deficiency) => {
    if (
      !reasons.has(deficiency.reason) ||
      (deficiency.targetRequirementId !== null &&
        !requirementIds.has(deficiency.targetRequirementId))
    ) {
      throw namedError("MemoryEvidenceQueryPlanRevisionInvalid");
    }
    return Object.freeze({
      reason: deficiency.reason,
      targetRequirementId: deficiency.targetRequirementId,
    });
  });
  return Object.freeze({
    currentRequirements: Object.freeze([...revision.currentRequirements]),
    deficiencies: Object.freeze(deficiencies),
  });
}

export function parseMemoryEvidenceQueryPlanV3(
  text: string,
  query: string,
  intent = classifyMemoryEvidenceQueryV3(query),
): MemoryEvidenceQueryPlanV3 {
  boundedQuery(query);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw namedError("MemoryEvidenceQueryPlanJsonInvalid");
  }
  const boundary = classifyMemoryEvidenceIntentBoundaryV1(query, intent);
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some(
      (key) =>
        !new Set([
          "answerShape",
          "temporalMode",
          "roleConstraint",
          "requirements",
        ]).has(key),
    ) ||
    !isMemoryEvidenceAnswerShapeV3(parsed.answerShape) ||
    !isMemoryEvidenceTemporalModeV3(parsed.temporalMode) ||
    !isMemoryEvidenceRoleConstraintV3(parsed.roleConstraint) ||
    !axisValueAllowed(
      parsed.answerShape,
      intent.answerShape,
      boundary.answerShape,
    ) ||
    !axisValueAllowed(
      parsed.temporalMode,
      intent.temporalMode,
      boundary.temporalMode,
    )
  ) {
    throw namedError("MemoryEvidenceQueryPlanShapeInvalid");
  }
  const provisionalIntent: MemoryEvidenceQueryIntentV3 = Object.freeze({
    answerShape: parsed.answerShape,
    temporalMode: parsed.temporalMode,
    roleConstraint: parsed.roleConstraint,
    needsPlanning: intent.needsPlanning,
  });
  const bounded = boundedRequirements(
    parsed.requirements,
    provisionalIntent,
    query,
  );
  const plannedObligationShape = compileMemoryEvidenceObligationShapeV1(
    query,
    provisionalIntent,
  );
  const classifiedObligationShape = compileMemoryEvidenceObligationShapeV1(
    query,
    intent,
  );
  const requirements = collapseRecommendationContextV1(
    bounded,
    provisionalIntent,
    classifiedObligationShape,
    query,
  );
  const normalizedRoleConstraint = deriveRequirementRoleEnvelope(
    parsed.roleConstraint,
    requirements,
  );
  if (
    !roleEnvelopeAllowed(
      normalizedRoleConstraint,
      intent.roleConstraint,
      boundary.roleConstraint,
      requirements,
    )
  ) {
    throw namedError("MemoryEvidenceQueryPlanShapeInvalid");
  }
  const normalizedIntent: MemoryEvidenceQueryIntentV3 = Object.freeze({
    ...provisionalIntent,
    roleConstraint: normalizedRoleConstraint,
  });
  if (requirements.length > 0) {
    validateMemoryEvidenceObligationsV1(plannedObligationShape, requirements);
  }
  return Object.freeze({
    plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
    ...normalizedIntent,
    requirements,
  });
}

function collapseRecommendationContextV1(
  requirements: readonly MemoryEvidenceRequirementV3[],
  intent: MemoryEvidenceQueryIntentV3,
  obligationShape: ReturnType<typeof compileMemoryEvidenceObligationShapeV1>,
  query: string,
): readonly MemoryEvidenceRequirementV3[] {
  if (
    intent.answerShape !== "recommend" ||
    obligationShape.obligationKind !== "personalization_context" ||
    requirements.length < 2 ||
    obligationShape.minimumRequirementCount !== 1 ||
    requirements.some(
      (requirement) =>
        requirement.roleConstraint !== "user" ||
        (requirement.dependencyRelation ?? "independent") !== "independent" ||
        (requirement.dependsOnRequirementIds?.length ?? 0) > 0 ||
        requirement.temporalMode !== requirements[0]?.temporalMode,
    )
  ) {
    return requirements;
  }
  // Union requirement facets in a canonical (input-order-independent) order
  // under the bounded search-text budget. Preference30 evidence (2026-09-01):
  // collapsing four focused facets into one compound search text blurred
  // source discovery and dropped the slice from 60% to 30% accuracy, so the
  // original all-or-nothing union guard is retained on purpose.
  const searchFacets = [
    ...new Set(requirements.map((requirement) => requirement.searchText)),
  ]
    .map((facet) => facet.trim().replace(/\s+/gu, " "))
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "en-US"));
  const searchText = searchFacets.join("; ").trim();
  if (!searchText || searchText.length > 192) return requirements;
  const temporalMode = requirements[0]?.temporalMode ?? intent.temporalMode;
  return Object.freeze([
    Object.freeze({
      requirementId: "personalization-context",
      label: "user personalization context",
      searchText,
      temporalMode,
      roleConstraint: "user" as const,
      relation: "direct" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
      dependencyRelation: "independent" as const,
      dependsOnRequirementIds: Object.freeze([]),
      temporalConstraint: compileMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: intent.temporalMode,
        leafMode: temporalMode,
      }),
    }),
  ]);
}

function axisValueAllowed<T extends string>(
  value: T,
  classified: T,
  authority: MemoryEvidenceIntentBoundaryV1[keyof MemoryEvidenceIntentBoundaryV1],
): boolean {
  return authority === "semantic" || value === classified;
}

function isMemoryEvidenceAnswerShapeV3(
  value: unknown,
): value is MemoryEvidenceQueryIntentV3["answerShape"] {
  return new Set(["lookup", "compare", "aggregate", "recommend"]).has(
    String(value),
  );
}

function isMemoryEvidenceTemporalModeV3(
  value: unknown,
): value is MemoryEvidenceQueryIntentV3["temporalMode"] {
  return new Set(["any", "latest", "as_of", "history", "range"]).has(
    String(value),
  );
}

function isMemoryEvidenceRoleConstraintV3(
  value: unknown,
): value is MemoryEvidenceQueryIntentV3["roleConstraint"] {
  return new Set(["user", "assistant", "any"]).has(String(value));
}

function boundedRequirements(
  value: unknown,
  intent: MemoryEvidenceQueryIntentV3,
  query: string,
): readonly MemoryEvidenceRequirementV3[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
  }
  const provisional: Array<
    Readonly<{
      obligationDag: boolean;
      requirementId: string;
      label: string;
      searchText: string;
      temporalMode: MemoryEvidenceQueryIntentV3["temporalMode"];
      roleConstraint: MemoryEvidenceQueryIntentV3["roleConstraint"];
      relation: MemoryEvidenceRelationV3;
      coverageMode: MemoryEvidenceCoverageModeV3;
      minimumEvidence: number;
      dependencyRelation?: MemoryEvidenceRequirementDependencyV4;
      dependsOnRequirementIds?: readonly string[];
    }>
  > = [];
  const seenKeys = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)) {
      throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
    }
    const keys = Object.keys(raw).sort().join("\0");
    const legacy =
      keys === "coverageMode\0label\0minimumEvidence\0relation\0searchText";
    const obligationDag =
      keys ===
      "coverageMode\0dependencyRelation\0dependsOn\0key\0label\0minimumEvidence\0relation\0roleConstraint\0searchText\0temporalMode";
    if (
      (!legacy && !obligationDag) ||
      typeof raw.label !== "string" ||
      typeof raw.searchText !== "string" ||
      !new Set(["direct", "temporal", "comparative", "inferred"]).has(
        String(raw.relation),
      ) ||
      !new Set(["any", "all", "latest", "convergent"]).has(
        String(raw.coverageMode),
      ) ||
      !Number.isSafeInteger(raw.minimumEvidence) ||
      (raw.minimumEvidence as number) < 1 ||
      (raw.minimumEvidence as number) > 3 ||
      (raw.relation === "inferred" &&
        (raw.coverageMode !== "convergent" ||
          (raw.minimumEvidence as number) < 2)) ||
      (raw.coverageMode === "convergent" && (raw.minimumEvidence as number) < 2)
    ) {
      throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
    }
    const label = raw.label.trim().replace(/\s+/gu, " ");
    const searchText = raw.searchText.trim().replace(/\s+/gu, " ");
    if (
      !label ||
      label.length > 192 ||
      !searchText ||
      searchText.length > 192
    ) {
      throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
    }
    if (
      obligationDag &&
      (typeof raw.key !== "string" ||
        raw.key.length < 1 ||
        raw.key.length > 128 ||
        !isMemoryEvidenceTemporalModeV3(raw.temporalMode) ||
        !memoryEvidenceLeafTemporalModeAllowedV1(
          intent.temporalMode,
          raw.temporalMode,
        ) ||
        !new Set(["user", "assistant"]).has(String(raw.roleConstraint)) ||
        !new Set([
          "independent",
          "depends_on",
          "responds_to",
          "supersedes",
        ]).has(String(raw.dependencyRelation)) ||
        !Array.isArray(raw.dependsOn) ||
        raw.dependsOn.some(
          (dependency) =>
            typeof dependency !== "string" ||
            dependency.length < 1 ||
            dependency.length > 128,
        ))
    ) {
      throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
    }
    const requirementId = obligationDag
      ? canonicalizeModelRequirementKeyV1(raw.key as string)
      : `requirement-${provisional.length + 1}`;
    if (seenKeys.has(requirementId)) {
      throw namedError("MemoryEvidenceQueryPlanRequirementKeyCollision");
    }
    seenKeys.add(requirementId);
    const dependsOnRequirementIds = obligationDag
      ? Object.freeze(
          (raw.dependsOn as string[]).map(canonicalizeModelRequirementKeyV1),
        )
      : undefined;
    provisional.push(
      Object.freeze({
        obligationDag,
        requirementId,
        label,
        searchText,
        temporalMode: obligationDag
          ? (raw.temporalMode as MemoryEvidenceQueryIntentV3["temporalMode"])
          : intent.temporalMode,
        roleConstraint: obligationDag
          ? (raw.roleConstraint as "user" | "assistant")
          : intent.roleConstraint,
        relation: raw.relation as MemoryEvidenceRelationV3,
        coverageMode: raw.coverageMode as MemoryEvidenceCoverageModeV3,
        minimumEvidence: raw.minimumEvidence as number,
        ...(obligationDag && dependsOnRequirementIds
          ? {
              dependencyRelation:
                raw.dependencyRelation as MemoryEvidenceRequirementDependencyV4,
              dependsOnRequirementIds,
            }
          : {}),
      }),
    );
  }
  for (const requirement of provisional) {
    if (
      requirement.dependsOnRequirementIds?.some(
        (dependency) => !seenKeys.has(dependency),
      )
    ) {
      throw namedError("MemoryEvidenceQueryPlanRequirementDependencyInvalid");
    }
  }
  const output: MemoryEvidenceRequirementV3[] = provisional.map(
    ({ obligationDag, ...requirement }) =>
      Object.freeze({
        ...requirement,
        ...(obligationDag
          ? {
              temporalConstraint: compileMemoryEvidenceTemporalConstraintV1({
                query,
                queryEnvelopeMode: intent.temporalMode,
                leafMode: requirement.temporalMode,
              }),
            }
          : {}),
      }),
  );
  validateRequirementDag(output);
  return Object.freeze(output);
}

/**
 * Model keys are dependency aliases, not semantic authority. Canonicalization
 * repairs syntax only; it never merges leaves. Callers must reject canonical
 * collisions before resolving DAG edges.
 */
function canonicalizeModelRequirementKeyV1(value: string): string {
  const canonical = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!canonical || canonical.length > 64) {
    throw namedError("MemoryEvidenceQueryPlanRequirementKeyInvalid");
  }
  return canonical;
}

function roleEnvelopeAllowed(
  envelope: MemoryEvidenceQueryIntentV3["roleConstraint"],
  classified: MemoryEvidenceQueryIntentV3["roleConstraint"],
  authority: MemoryEvidenceIntentBoundaryV1["roleConstraint"],
  requirements: readonly MemoryEvidenceRequirementV3[],
): boolean {
  if (axisValueAllowed(envelope, classified, authority)) return true;
  const roles = new Set(
    requirements.map((requirement) => requirement.roleConstraint),
  );
  return (
    envelope === "any" &&
    roles.has("user") &&
    roles.has("assistant") &&
    (classified === "any" || roles.has(classified))
  );
}

function deriveRequirementRoleEnvelope(
  proposedEnvelope: MemoryEvidenceQueryIntentV3["roleConstraint"],
  requirements: readonly MemoryEvidenceRequirementV3[],
): MemoryEvidenceQueryIntentV3["roleConstraint"] {
  if (
    !requirements.some(
      (requirement) => requirement.dependencyRelation !== undefined,
    ) ||
    requirements.length === 0
  ) {
    return proposedEnvelope;
  }
  const roles = new Set(
    requirements.map((requirement) => requirement.roleConstraint),
  );
  return roles.size === 1
    ? (requirements[0]?.roleConstraint ?? proposedEnvelope)
    : "any";
}

function validateRequirementDag(
  requirements: readonly MemoryEvidenceRequirementV3[],
): void {
  const dagRequirements = requirements.filter(
    (requirement) => requirement.dependencyRelation !== undefined,
  );
  if (dagRequirements.length === 0) return;
  if (dagRequirements.length !== requirements.length) {
    throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
  }
  const byId = new Map(
    requirements.map((requirement) => [requirement.requirementId, requirement]),
  );
  if (byId.size !== requirements.length) {
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

function boundedQuery(query: string): string {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryEvidenceQueryPlanQueryInvalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableName(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(value)
    ? value
    : "MemoryEvidenceQueryPlannerFailed";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function abortError(): Error {
  return namedError("AbortError");
}
