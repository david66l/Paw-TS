import type { MemoryWriterModelV1 } from "./model-port.js";
import {
  classifyMemoryEvidenceQueryV3,
  needsCertifiedAssistantDialogueCandidateV1,
} from "./query-classifier.js";
import {
  type MemoryEvidenceCoverageModeV3,
  type MemoryEvidenceQueryIntentV3,
  type MemoryEvidenceQueryPlanV3,
  type MemoryEvidenceQueryPlannerV3,
  type MemoryEvidenceRelationV3,
  type MemoryEvidenceRequirementV3,
  PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
} from "./query-plan-contracts.js";

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
      options?: Readonly<{ force?: boolean }>,
    ) {
      const intent = classifyMemoryEvidenceQueryV3(query);
      if (!intent.needsPlanning && options?.force !== true) {
        return Object.freeze({
          plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
          ...intent,
          requirements: Object.freeze([]),
        });
      }
      const request = buildMemoryEvidenceQueryPlanRequestV3(query, intent);
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
): Readonly<{ system: string; user: string }> {
  const value = boundedQuery(query);
  const certifiedAssistantDialogueCandidate =
    intent.roleConstraint === "user" &&
    needsCertifiedAssistantDialogueCandidateV1(value);
  return Object.freeze({
    system: [
      "You plan retrieval requirements, not the answer.",
      "The memory store contains concrete past dialogue, so bridge the current wording to concrete clues that may have been stated earlier.",
      "Answer shape and temporal mode are independent immutable axes supplied by the caller. Return them unchanged.",
      "Role constraint is an immutable authority boundary supplied by deterministic code. Return it unchanged.",
      "roleConstraint=any means the current question establishes a prior-dialogue answer but cannot establish whether the requested artifact came from the user, assistant, or a shared exchange. Preserve any; do not guess or upgrade it.",
      ...(certifiedAssistantDialogueCandidate
        ? [
            "certifiedAssistantDialogueCandidate=true keeps roleConstraint=user as the primary authority while allowing a separate, certificate-gated assistant candidate path. Do not rewrite the role or assume the assistant authored the answer.",
          ]
        : []),
      "For recommend requests, separately search likely possessions or ingredients, goals, constraints, routines, prior attempts, and explicit likes or dislikes that could constrain a useful recommendation.",
      "For compare or aggregate requests, create one requirement and search per independent operand.",
      "Do not split one operand into separate identity, value, threshold, status, or background requirements when one concrete memory can establish it.",
      "A single requested quantity is one requirement. An aggregate across N named entities is N requirements, one per entity.",
      "For latest, as_of, history, or range requests, include state and time wording without inventing a date.",
      "For every requirement declare relation, coverageMode, and minimumEvidence. These describe evidence closure, not an answer.",
      "Use relation=direct for an explicitly stated fact, temporal for state over time, comparative for one operand in a comparison or aggregate, and inferred only when multiple concrete observations must support a conclusion.",
      "Use coverageMode=any with minimumEvidence=1 for one direct fact, latest with 1 for controlling current state, all when the listed independent facts are jointly necessary, and convergent with 2 or 3 independent observations for an inference.",
      "minimumEvidence must be 1, 2, or 3. Never demand multiple copies of the same statement.",
      "Every item is a search hint only. Never invent a user fact, preference, event, entity, amount, date, or answer.",
      "Each requirement must bind its human-readable evidence need to exactly one concrete search text; never return parallel arrays.",
      'Return exactly one JSON object: {"answerShape":"...","temporalMode":"...","roleConstraint":"...","requirements":[{"label":"...","searchText":"...","relation":"direct|temporal|comparative|inferred","coverageMode":"any|all|latest|convergent","minimumEvidence":1}]}.',
    ].join("\n"),
    user: JSON.stringify({
      schemaVersion: "paw.memory-evidence-query-plan-input.v3",
      query: value,
      answerShape: intent.answerShape,
      temporalMode: intent.temporalMode,
      roleConstraint: intent.roleConstraint,
      ...(certifiedAssistantDialogueCandidate
        ? { certifiedAssistantDialogueCandidate: true }
        : {}),
      maxRequirements: 4,
      maxItemChars: 192,
    }),
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
    parsed.answerShape !== intent.answerShape ||
    parsed.temporalMode !== intent.temporalMode ||
    parsed.roleConstraint !== intent.roleConstraint
  ) {
    throw namedError("MemoryEvidenceQueryPlanShapeInvalid");
  }
  return Object.freeze({
    plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
    ...intent,
    requirements: boundedRequirements(parsed.requirements, intent),
  });
}

function boundedRequirements(
  value: unknown,
  intent: MemoryEvidenceQueryIntentV3,
): readonly MemoryEvidenceRequirementV3[] {
  if (!Array.isArray(value) || value.length > 4) {
    throw namedError("MemoryEvidenceQueryPlanRequirementsInvalid");
  }
  const output: MemoryEvidenceRequirementV3[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      Object.keys(raw).sort().join("\0") !==
        "coverageMode\0label\0minimumEvidence\0relation\0searchText" ||
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
    const key = `${label}\0${searchText}`.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(
      Object.freeze({
        requirementId: `requirement-${output.length + 1}`,
        label,
        searchText,
        temporalMode: intent.temporalMode,
        roleConstraint: intent.roleConstraint,
        relation: raw.relation as MemoryEvidenceRelationV3,
        coverageMode: raw.coverageMode as MemoryEvidenceCoverageModeV3,
        minimumEvidence: raw.minimumEvidence as number,
      }),
    );
  }
  return Object.freeze(output);
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
