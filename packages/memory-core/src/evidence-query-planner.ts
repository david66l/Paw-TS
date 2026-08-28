import { isAssistantMemoryQueryV1 } from "./evidence-first.js";
import type { MemoryWriterModelV1 } from "./model-port.js";

export const PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3 =
  "paw.memory-evidence-query-planner.v8:shared-dialogue-candidates" as const;

export type MemoryEvidenceAnswerShapeV3 =
  | "lookup"
  | "compare"
  | "aggregate"
  | "recommend";

export type MemoryEvidenceTemporalModeV3 =
  | "any"
  | "latest"
  | "as_of"
  | "history"
  | "range";

export type MemoryEvidenceRoleConstraintV3 = "user" | "assistant" | "any";
export type MemoryEvidenceRelationV3 =
  | "direct"
  | "temporal"
  | "comparative"
  | "inferred";
export type MemoryEvidenceCoverageModeV3 =
  | "any"
  | "all"
  | "latest"
  | "convergent";

/**
 * Query intent is deliberately factored into independent axes. A question can
 * ask for an aggregate answer and the latest state at the same time; encoding
 * those as one mutually exclusive operation silently discards chronology.
 */
export interface MemoryEvidenceQueryIntentV3 {
  readonly answerShape: MemoryEvidenceAnswerShapeV3;
  readonly temporalMode: MemoryEvidenceTemporalModeV3;
  readonly roleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly needsPlanning: boolean;
}

export interface MemoryEvidenceRequirementV3 {
  readonly requirementId: string;
  readonly label: string;
  readonly searchText: string;
  readonly temporalMode: MemoryEvidenceTemporalModeV3;
  readonly roleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly relation?: MemoryEvidenceRelationV3;
  readonly coverageMode?: MemoryEvidenceCoverageModeV3;
  readonly minimumEvidence?: number;
}

export interface MemoryEvidenceQueryPlanV3 extends MemoryEvidenceQueryIntentV3 {
  readonly plannerVersion: typeof PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
}

export interface MemoryEvidenceQueryPlannerV3 {
  readonly plannerVersion: typeof PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3;
  plan(
    query: string,
    signal: AbortSignal,
    options?: Readonly<{ force?: boolean }>,
  ): Promise<MemoryEvidenceQueryPlanV3>;
}

/** Cheap deterministic gate; the model only expands complex or temporal requests. */
export function classifyMemoryEvidenceQueryV3(
  query: string,
): MemoryEvidenceQueryIntentV3 {
  const value = boundedQuery(query);
  const explicitSharedDialogue = isExplicitSharedDialogueQueryV1(value);
  const explicitAssistant = isAssistantMemoryQueryV1(value);
  const explicitUserOrigin = isExplicitUserOriginMemoryQueryV1(value);
  const roleNeedsResolution =
    !explicitUserOrigin &&
    (explicitSharedDialogue ||
      (!explicitAssistant && needsMemoryEvidenceRoleResolutionV1(value)));
  const roleConstraint: MemoryEvidenceRoleConstraintV3 = explicitUserOrigin
    ? "user"
    : explicitSharedDialogue
      ? "any"
      : explicitAssistant
        ? "assistant"
        : roleNeedsResolution
          ? "any"
          : "user";
  const answerShape: MemoryEvidenceAnswerShapeV3 =
    /\b(?:recommend|recommendation|suggest|suggestion|what\s+should\s+i|any\s+(?:tips|ideas)|good\s+(?:options|activities|recipes?))\b|(?:推荐|建议|有什么(?:好)?(?:办法|选择|活动|食谱)|我应该)/iu.test(
      value,
    )
      ? "recommend"
      : /\b(?:compared\s+to|difference\s+between|both|each|respectively)\b|(?:相比|比较|区别|差异|两者|分别|各自)/iu.test(
            value,
          )
        ? "compare"
        : /\b(?:how\s+(?:many|much)|what\s+percentage|percent(?:age)?\s+of|ratio\s+of|total|combined|altogether)\b|(?:多少|总共|合计|一共|加起来|百分之|占.{0,24}(?:比例|百分比))/iu.test(
              value,
            )
          ? "aggregate"
          : "lookup";
  const explicitLatest =
    /\b(?:latest|currently|most\s+recent|now|today|at\s+present)\b|(?:最新|现在|目前|最近一次|今天)/iu.test(
      value,
    );
  const explicitCurrentState =
    /\bcurrent\s+(?:count|number|status|balance|level|value|total|amount|location|city|address|job|role|preference|plan)\b|当前(?:数量|数值|状态|余额|等级|级别|总数|金额|位置|城市|地址|工作|角色|偏好|计划)/iu.test(
      value,
    );
  const temporalMode: MemoryEvidenceTemporalModeV3 =
    explicitLatest || explicitCurrentState
      ? "latest"
      : /\bas\s+of\b|(?:截至|截止到|到.{0,24}为止)/iu.test(value)
        ? "as_of"
        : /\b(?:over\s+time|changed?|history|previously|used\s+to|evolution)\b|(?:随时间|变化|历史|以前|曾经|演变|过程)/iu.test(
              value,
            )
          ? "history"
          : /\b(?:between|from\b.{0,48}\bto|since|before|after|during|within)\b|(?:从.{0,24}到|之间|以来|之前|之后|期间|以内)/iu.test(
                value,
              )
            ? "range"
            : "any";
  return Object.freeze({
    answerShape,
    temporalMode,
    roleConstraint,
    needsPlanning:
      answerShape !== "lookup" ||
      temporalMode !== "any" ||
      roleConstraint !== "user",
  });
}

function isExplicitUserOriginMemoryQueryV1(query: string): boolean {
  const value = boundedQuery(query);
  const firstPersonFact =
    /\b(?:i|me|my|mine)\b.{0,120}\b(?:said|mentioned|told|did|visited|went|traveled|preferred|preference|liked|owned|possessed|had|bought|chose|selected|planned|wanted|needed|worked|lived|city|address|job|role)\b/iu.test(
      value,
    );
  const firstPersonQuestion =
    /\b(?:what|which|where|when|how)\b.{0,100}\b(?:did|have|was|were|do|am)\s+(?:i|my)\b/iu.test(
      value,
    );
  const chineseUserFact =
    /(?:我|我的).{0,80}(?:说|提到|告诉|做|去|访问|旅行|偏好|喜欢|拥有|买|选择|计划|想要|需要|工作|居住|城市|地址|职位|角色)/u.test(
      value,
    );
  return firstPersonFact || firstPersonQuestion || chineseUserFact;
}

/**
 * Opens semantic role resolution only for dialogue-deictic questions. The
 * deterministic assistant classifier remains the high-precision fast path;
 * this gate catches ambiguous reminders, repetitions and references to prior
 * generated output without declaring them assistant-grounded itself.
 */
export function needsMemoryEvidenceRoleResolutionV1(query: string): boolean {
  const value = boundedQuery(query);
  const hasSecondPerson = /\b(?:you|your|yours)\b|(?:你|你的)/iu.test(value);
  const hasPriorCue =
    /\b(?:again|before|earlier|last|previous|previously|prior)\b|(?:再次|以前|之前|上次|此前)/iu.test(
      value,
    );
  const hasOutputAction =
    /\b(?:repeat|reproduce|restate|provide|share|give|tell|show|write|create|generate|recommend|suggest|list|answer|respond|mention|helped)\b|(?:重复|复述|提供|分享|告诉|展示|写|创建|生成|推荐|建议|列出|回答|回复|提到|帮)/iu.test(
      value,
    );
  const secondPersonPriorAction =
    hasSecondPerson && hasPriorCue && hasOutputAction;
  const priorOutputReference =
    /\b(?:again|earlier|previous|previously|prior|last\s+time|before|originally)\b.{0,120}\b(?:response|answer|reply|message|option|idea|suggestion|recommendation|list|plan|draft|summary|name|wording|advice)\b|(?:再次|以前|之前|上次|此前|原来).{0,80}(?:回复|回答|消息|选项|想法|建议|推荐|列表|计划|草稿|摘要|名称|措辞)/iu.test(
      value,
    );
  const passiveGeneratedOutput =
    /\bwas\s+(?:generated|suggested|recommended|listed|provided|created|written|answered)\b|(?:被|曾经).{0,40}(?:生成|建议|推荐|列出|提供|创建|写出|回答)/iu.test(
      value,
    );
  return (
    secondPersonPriorAction ||
    priorOutputReference ||
    isExplicitSharedDialogueQueryV1(value) ||
    passiveGeneratedOutput
  );
}

function isExplicitSharedDialogueQueryV1(query: string): boolean {
  const value = boundedQuery(query);
  const sharedStatement =
    /\b(?:we|our)\b.{0,80}\b(?:talked\s+about|discussed|decided|named|called|came\s+up\s+with)\b|(?:我们|咱们).{0,80}(?:聊过|讨论|决定|取名|命名|想到)/iu.test(
      value,
    );
  const sharedQuestion =
    /\b(?:what|which|where|when|how)\b.{0,80}\bdid\s+(?:we|you\s+and\s+i)\s+(?:talk\s+about|discuss|decide(?:\s+on)?|name|call|come\s+up\s+with|agree\s+on|choose|select|create|write|draft)\b/iu.test(
      value,
    );
  return sharedStatement || sharedQuestion;
}

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
  return Object.freeze({
    system: [
      "You plan retrieval requirements, not the answer.",
      "The memory store contains concrete past dialogue, so bridge the current wording to concrete clues that may have been stated earlier.",
      "Answer shape and temporal mode are independent immutable axes supplied by the caller. Return them unchanged.",
      "Role constraint is an immutable authority boundary supplied by deterministic code. Return it unchanged.",
      "roleConstraint=any means the current question alone cannot establish whether the requested shared-dialogue artifact came from the user or assistant. Preserve any; do not guess or upgrade it.",
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
