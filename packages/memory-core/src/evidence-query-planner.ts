import { isAssistantMemoryQueryV1 } from "./evidence-first.js";
import type { MemoryWriterModelV1 } from "./model-port.js";

export const PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3 =
  "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate" as const;

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

export type MemoryAssistantOriginApertureV1 =
  | "closed"
  | "addressed_reply_only"
  | "session_opening_assistant_artifact"
  | "session_opening_reported_assistant_assertion";

export type MemoryEvidenceUseV1 = "fact" | "reported_assistant_assertion";

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
  /** Code-owned evidence semantics; model planner output cannot set this. */
  readonly evidenceUse?: MemoryEvidenceUseV1;
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
  const recallProvenance = classifyMemoryRecallProvenanceV1(value);
  const explicitSharedDialogue = isExplicitSharedDialogueQueryV1(value);
  const explicitAssistant = isAssistantMemoryQueryV1(value);
  const explicitUserOrigin = isExplicitUserOriginMemoryQueryV1(value);
  const roleConstraint: MemoryEvidenceRoleConstraintV3 = recallProvenance
    ? recallProvenance === "user"
      ? "user"
      : recallProvenance === "assistant"
        ? "assistant"
        : recallProvenance === "shared" ||
            recallProvenance === "passive_unresolved" ||
            recallProvenance === "ambiguous_subject" ||
            isUnresolvedDialogueRecallQueryV1(value)
          ? "any"
          : "user"
    : isUnresolvedPassiveDialogueQueryV1(value)
      ? "any"
      : explicitUserOrigin
        ? "user"
        : explicitSharedDialogue
          ? "any"
          : explicitAssistant
            ? "assistant"
            : needsMemoryEvidenceRoleResolutionV1(value)
              ? "any"
              : "user";
  const certifiedAssistantDialogueCandidate =
    roleConstraint === "user" &&
    needsCertifiedAssistantDialogueCandidateV1(value);
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
      roleConstraint !== "user" ||
      certifiedAssistantDialogueCandidate,
  });
}

function isExplicitUserOriginMemoryQueryV1(query: string): boolean {
  const value = boundedQuery(query);
  const firstPersonQuestion =
    /\b(?:what|which|where|when|how|who)\b.{0,100}\b(?:did|do|have|has|had|was|were|am)\s+i\b/iu.test(
      value,
    );
  const possessiveUserState =
    /\b(?:what|which|where|when|how)\b.{0,80}\b(?:is|are|was|were|has|have|had)\s+(?:my|mine)\b|\b(?:what|which)\s+my\s+[\p{L}\p{N}_-]{1,48}\s+(?:is|are|was|were|has|have|had)\b/iu.test(
      value,
    );
  const chineseFirstPersonQuestion =
    /(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁).{0,64}(?:是我|我(?:曾经|之前|上次|此前)?(?:在|于|有|做|说|提|去|把|将|给|从|向|选择|决定))/u.test(
      value,
    );
  const chinesePossessive =
    /(?:什么|哪个|哪里|何时|什么时候|怎么|如何|多少).{0,64}(?:我的|本人(?:的)?)/u.test(
      value,
    );
  return (
    firstPersonQuestion ||
    possessiveUserState ||
    chineseFirstPersonQuestion ||
    chinesePossessive
  );
}

type MemoryRecallProvenanceV1 =
  | "user"
  | "assistant"
  | "shared"
  | "unowned"
  | "ambiguous_subject"
  | "passive_unresolved";

function memoryRecallAnswerClauseV1(
  query: string,
): Readonly<{ language: "en" | "zh"; text: string }> | undefined {
  const english =
    /\b(?:remember|recall|remind\s+me)\b.{0,32}?(?<answer>\b(?:what|which|where|when|how|who|whether)\b.{0,160})/iu.exec(
      query,
    );
  if (english?.groups?.answer) {
    return Object.freeze({ language: "en", text: english.groups.answer });
  }
  const chinese = /(?:记得|回忆|提醒我|想不起来)(?<answer>.{0,120})/u.exec(
    query,
  );
  if (
    chinese?.groups?.answer &&
    /(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁|是否)/u.test(
      chinese.groups.answer,
    )
  ) {
    return Object.freeze({ language: "zh", text: chinese.groups.answer });
  }
  return undefined;
}

function classifyMemoryRecallProvenanceV1(
  query: string,
): MemoryRecallProvenanceV1 | undefined {
  const answer = memoryRecallAnswerClauseV1(query);
  if (!answer) return undefined;
  const subject = firstAnswerClauseSubjectV1(answer.text, answer.language);
  if (subject === "ambiguous") return "ambiguous_subject";
  if (subject) {
    if (
      isPassiveAnswerSubjectV1(
        answer.text,
        subject.index,
        subject.owner,
        answer.language,
      )
    ) {
      return "passive_unresolved";
    }
    return subject.owner;
  }
  if (isUnresolvedPassiveDialogueQueryV1(answer.text)) {
    return "passive_unresolved";
  }
  return copularPossessiveOwnerV1(answer.text, answer.language) ?? "unowned";
}

/** Possessive determiners are objects; only nominative pronouns compete here. */
function firstAnswerClauseSubjectV1(
  clause: string,
  language: "en" | "zh",
):
  | Readonly<{
      owner: "user" | "assistant" | "shared";
      index: number;
    }>
  | "ambiguous"
  | undefined {
  if (language === "zh") {
    const joint = /(?:你和我|我和你|我们|咱们)/u.exec(clause);
    const withoutJoint = clause
      .replace(/(?:你和我|我和你|我们|咱们)/gu, (text) =>
        " ".repeat(text.length),
      )
      .replace(/(?:给|向|对|为|跟)(?:本人|我|您|你)/gu, (text) =>
        " ".repeat(text.length),
      );
    const user = /(?:本人|我)(?!的)/u.exec(withoutJoint);
    const assistant = /(?:您|你)(?!的)/u.exec(withoutJoint);
    const subject = earliestAnswerSubjectV1({
      user: user?.index,
      assistant: assistant?.index,
      shared: joint?.index,
    });
    return subject !== "ambiguous" &&
      subject?.owner === "assistant" &&
      !isCanonicalChineseAssistantSubjectV1(clause)
      ? "ambiguous"
      : subject;
  }

  const joint = /\b(?:you\s+and\s+i|i\s+and\s+you|we)\b/iu.exec(clause);
  const withoutJoint = clause
    .replace(/\b(?:you\s+and\s+i|i\s+and\s+you|we)\b/giu, (text) =>
      " ".repeat(text.length),
    )
    .replace(/\b(?:for|to|by|with|about|from|of)\s+(?:i|you)\b/giu, (text) =>
      " ".repeat(text.length),
    );
  const user = /\bi\b/iu.exec(withoutJoint);
  const assistant = /\byou\b/iu.exec(withoutJoint);
  const subject = earliestAnswerSubjectV1({
    user: user?.index,
    assistant: assistant?.index,
    shared: joint?.index,
  });
  if (subject !== "ambiguous") {
    return subject?.owner === "assistant" &&
      canonicalEnglishAnswerSubjectV1(clause) !== "assistant"
      ? "ambiguous"
      : subject;
  }
  const canonicalOwner = canonicalEnglishAnswerSubjectV1(clause);
  const canonicalIndex = canonicalOwner
    ? { user: user?.index, assistant: assistant?.index, shared: joint?.index }[
        canonicalOwner
      ]
    : undefined;
  return canonicalOwner !== undefined && canonicalIndex !== undefined
    ? Object.freeze({ owner: canonicalOwner, index: canonicalIndex })
    : "ambiguous";
}

function earliestAnswerSubjectV1(input: {
  readonly user?: number;
  readonly assistant?: number;
  readonly shared?: number;
}):
  | Readonly<{
      owner: "user" | "assistant" | "shared";
      index: number;
    }>
  | "ambiguous"
  | undefined {
  const owners = (["user", "assistant", "shared"] as const)
    .map((owner) => ({ owner, index: input[owner] }))
    .filter(
      (
        entry,
      ): entry is { owner: "user" | "assistant" | "shared"; index: number } =>
        entry.index !== undefined,
    )
    .sort((left, right) => left.index - right.index);
  if (owners.length <= 1) return owners[0];
  return "ambiguous";
}

function canonicalEnglishAnswerSubjectV1(
  clause: string,
): "user" | "assistant" | "shared" | undefined {
  const match =
    /^\s*(?:what|which|where|when|how|who|whether)\b(?:\s+(?:did|do|does|was|were|is|are|has|have|had|can|could|would|will))?\s+(you\s+and\s+i|i\s+and\s+you|i|you|we)\b/iu.exec(
      clause,
    );
  const subject = match?.[1]?.toLocaleLowerCase("en-US");
  return subject === "i"
    ? "user"
    : subject === "you"
      ? "assistant"
      : subject === "we" || subject === "you and i" || subject === "i and you"
        ? "shared"
        : undefined;
}

function isCanonicalChineseAssistantSubjectV1(clause: string): boolean {
  if (!/^\s*(?:您|你)(?!的)/u.test(clause)) return false;
  const questionWord =
    /(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁|是否)/u.exec(clause);
  return !clause.slice(0, questionWord?.index ?? clause.length).includes("的");
}

function isPassiveAnswerSubjectV1(
  clause: string,
  subjectIndex: number,
  owner: "user" | "assistant" | "shared",
  language: "en" | "zh",
): boolean {
  if (language === "zh") {
    const subject =
      owner === "user"
        ? "(?:本人|我)"
        : owner === "assistant"
          ? "(?:您|你)"
          : "(?:我们|咱们|你和我|我和你)";
    return new RegExp(
      `^${subject}被.{0,32}(?:告诉|给|展示|推荐|建议|告知|提醒|发送|提供)`,
      "u",
    ).test(clause.slice(subjectIndex));
  }
  const before = clause.slice(0, subjectIndex);
  const after = clause.slice(subjectIndex);
  const subject =
    owner === "user"
      ? "i"
      : owner === "assistant"
        ? "you"
        : "(?:we|you\\s+and\\s+i|i\\s+and\\s+you)";
  const outputParticiple =
    "(?:told|given|shown|recommended|suggested|advised|informed|asked|sent|offered|assigned|provided)";
  return (
    new RegExp(
      `^${subject}\\s+(?:(?:was|were|am|have\\s+been|had\\s+been)\\s+)${outputParticiple}\\b`,
      "iu",
    ).test(after) ||
    (/(?:was|were|am|have\s+been|had\s+been)\s*$/iu.test(before) &&
      new RegExp(`^${subject}\\s+${outputParticiple}\\b`, "iu").test(after))
  );
}

function copularPossessiveOwnerV1(
  clause: string,
  language: "en" | "zh",
): "user" | "assistant" | "shared" | undefined {
  if (language === "zh") {
    const match =
      /(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁|是否).{0,24}(我的|你的|我们的)|(?:我的|你的|我们的).{0,32}(?:是什么|是多少|在哪|如何|怎么)/u.exec(
        clause,
      );
    const owner = match?.[1] ?? match?.[0]?.match(/我的|你的|我们的/u)?.[0];
    return owner === "我的"
      ? "user"
      : owner === "你的"
        ? "assistant"
        : owner === "我们的"
          ? "shared"
          : undefined;
  }
  const match =
    /\b(?:what|which|where|when|how|who)\b.{0,32}\b(?:is|are|was|were|has|have|had)\s+(my|your|our)\b|\b(?:what|which)\s+(my|your|our)\s+[\p{L}\p{N}_-]{1,48}\s+(?:is|are|was|were|has|have|had)\b/iu.exec(
      clause,
    );
  const owner = match?.[1] ?? match?.[2];
  return owner === "my"
    ? "user"
    : owner === "your"
      ? "assistant"
      : owner === "our"
        ? "shared"
        : undefined;
}

function isUnresolvedPassiveDialogueQueryV1(query: string): boolean {
  return (
    /\b(?:what|which|where|when|how|who)\b.{0,48}\b(?:was|were|am|have\s+been|had\s+been)\s+i\s+(?:told|given|shown|recommended|suggested|advised|informed|asked|sent|offered|assigned|provided)\b/iu.test(
      query,
    ) ||
    /\b(?:what|which|where|when|how|who)\b.{0,32}\b(?:was|were)\s+(?:ultimately|finally|eventually)?\s*(?:said|told|given|shown|recommended|suggested|advised|proposed|decided|chosen|selected|named|called|written|created|provided|answered)\b/iu.test(
      query,
    )
  );
}

/**
 * A memory speech act can establish that an answer belongs to prior dialogue
 * without establishing who authored it. This opens a certified dialogue
 * search aperture while preserving `any` as unresolved authority.
 */
function isUnresolvedDialogueRecallQueryV1(query: string): boolean {
  const value = boundedQuery(query);
  const englishRecall =
    /\b(?:do|can|could|would|will)\s+you\s+(?:remember|recall)\b|\b(?:can|could|would|will)\s+you\s+remind\s+me\b|\bi\s+(?:cannot|can't|cant|do\s+not|don't|dont)\s+(?:remember|recall)\b/iu.test(
      value,
    );
  const englishAnswerComplement =
    /\b(?:remember|recall|remind\s+me)\b.{0,96}\b(?:what|which|where|when|how|who|whether)\b/iu.test(
      value,
    );
  const englishPriorOrDeictic =
    /\b(?:that|those|it|one|ones|earlier|previous|previously|prior|last|before|chat|conversation|discussion)\b|\b(?:was|were)\s+(?:ultimately|finally|eventually)?\s*(?:proposed|decided|chosen|selected|named|called|written|created|recommended|suggested|provided|answered)\b/iu.test(
      value,
    );
  const chineseRecall =
    /(?:你还?记得|你能?回忆|提醒我|我(?:不|没)记得|我想不起来)/u.test(value);
  const chineseAnswerComplement =
    /(?:记得|回忆|提醒我|想不起来).{0,64}(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁|是否)/u.test(
      value,
    );
  const chinesePriorOrDeictic =
    /(?:当时|那个|那些|它|之前|上次|此前|过去|聊天|对话|讨论|说过|提过)/u.test(
      value,
    );
  return (
    (englishRecall && englishAnswerComplement && englishPriorOrDeictic) ||
    (chineseRecall && chineseAnswerComplement && chinesePriorOrDeictic)
  );
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

/**
 * Proposes session-start assistant evidence for an explicit assistant answer
 * or an author-unresolved dialogue artifact. This is not authorization: the
 * resolver must reconcile it with the final immutable authority contract.
 */
export function proposesMemorySessionOpeningAssistantOriginV1(
  query: string,
): boolean {
  return classifyMemoryAssistantOriginApertureV1(query).startsWith(
    "session_opening_",
  );
}

/**
 * Separates a broad certified assistant-candidate search from the narrower
 * permission to use an unaddressed session-opening assistant artifact.
 */
export function classifyMemoryAssistantOriginApertureV1(
  query: string,
): MemoryAssistantOriginApertureV1 {
  const value = boundedQuery(query);
  const provenance = classifyMemoryRecallProvenanceV1(value);
  const predicateOwner = classifyOutputPredicateOwnerV1(value);
  const artifactAgent = classifyArtifactAgentV1(value);
  const artifactOwner = classifyAssistantArtifactTargetOwnerV1(value);
  const artifactAuthorship = classifyAssistantOutputArtifactAuthorshipV1(value);

  if (predicateOwner === "assistant") {
    return "session_opening_assistant_artifact";
  }
  if (predicateOwner === "user") return "closed";
  if (predicateOwner === "shared" || predicateOwner === "third_party") {
    return "addressed_reply_only";
  }
  if (artifactAgent === "assistant") {
    return "session_opening_assistant_artifact";
  }
  if (artifactAgent === "user") return "closed";
  if (artifactAgent === "shared" || artifactAgent === "third_party") {
    return "addressed_reply_only";
  }
  if (
    provenance === "user" ||
    artifactOwner === "user" ||
    isExplicitUserOriginMemoryQueryV1(value)
  ) {
    return "closed";
  }
  if (
    provenance === "shared" ||
    artifactOwner === "shared" ||
    artifactOwner === "third_party" ||
    isExplicitSharedDialogueQueryV1(value) ||
    isSharedDialogueOutcomeQueryV1(value)
  ) {
    return "addressed_reply_only";
  }
  if (
    provenance === "assistant" ||
    artifactOwner === "assistant" ||
    (provenance === undefined && isAssistantMemoryQueryV1(value))
  ) {
    return "session_opening_assistant_artifact";
  }
  if (artifactAuthorship === "third_party") {
    return "addressed_reply_only";
  }
  if (
    artifactAuthorship === "assistant_artifact" ||
    isUnownedPriorAssistantArtifactQueryV1(value)
  ) {
    return "session_opening_assistant_artifact";
  }
  if (isUnownedRecallCopularAssistantAssertionV1(value, provenance)) {
    return "session_opening_reported_assistant_assertion";
  }
  if (provenance === "unowned" || provenance === "passive_unresolved") {
    return "addressed_reply_only";
  }
  return needsCertifiedAssistantDialogueCandidateV1(value)
    ? "addressed_reply_only"
    : "closed";
}

/**
 * Treats query-level assistant-origin classification as a proposal until the
 * immutable authority intent and its requirement shape are known. A reported
 * assistant assertion is a user-role framing contract, while an unresolved or
 * assistant-role request asks for a dialogue artifact instead.
 */
export function reconcileMemoryAssistantOriginApertureV1(input: {
  readonly proposal: MemoryAssistantOriginApertureV1;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
}): MemoryAssistantOriginApertureV1 {
  if (input.proposal !== "session_opening_reported_assistant_assertion") {
    return input.proposal;
  }
  if (
    input.requirements.length === 0 ||
    input.requirements.some(
      (requirement) =>
        requirement.roleConstraint !== input.intent.roleConstraint,
    )
  ) {
    return "closed";
  }
  if (
    input.intent.roleConstraint === "assistant" ||
    input.intent.roleConstraint === "any"
  ) {
    return "session_opening_assistant_artifact";
  }
  return input.requirements.length === 1
    ? "session_opening_reported_assistant_assertion"
    : "closed";
}

type MemoryOutputOwnerV1 = "user" | "assistant" | "shared" | "third_party";

function classifyOutputPredicateOwnerV1(
  query: string,
): MemoryOutputOwnerV1 | undefined {
  const clause = memoryRecallAnswerClauseV1(query)?.text ?? query;
  const english =
    /\b(?:what|which)\b[^?.!]{0,48}?\b(?:did|do|does|have|has|had)\s+(?<subject>you\s+and\s+i|i\s+and\s+you|you|i|we|(?:my|your|our|the)\s+[\p{L}\p{N}_-]+|[\p{L}\p{N}_-]+)\s+[\p{L}\p{N}_-]+/iu.exec(
      clause,
    )?.groups?.subject;
  if (english) return outputOwnerFromEnglishSubjectV1(english);

  const chinese =
    /^(?<subject>你和我|我和你|我们|咱们|你|您|我|我的[^，。？！?]{1,12}|你的[^，。？！?]{1,12}|我们的[^，。？！?]{1,12}|[\p{Script=Han}]{1,12}?)(?:曾经|之前|上次|此前|当时)?(?:说|告诉|推荐|建议|提议|写|创建|生成|展示|提供|列出|给出|回答|回复|提到|分享|起草|草拟|总结|创作|命名|添加|补充)(?:了|过)/u.exec(
      clause.trim(),
    )?.groups?.subject;
  if (!chinese) return undefined;
  if (chinese === "我") return "user";
  if (chinese === "你" || chinese === "您") return "assistant";
  if (
    chinese === "我们" ||
    chinese === "咱们" ||
    chinese === "你和我" ||
    chinese === "我和你"
  ) {
    return "shared";
  }
  return "third_party";
}

function outputOwnerFromEnglishSubjectV1(subject: string): MemoryOutputOwnerV1 {
  const value = subject.toLocaleLowerCase("en-US");
  if (value === "i") return "user";
  if (value === "you") return "assistant";
  if (value === "we" || value === "you and i" || value === "i and you") {
    return "shared";
  }
  return "third_party";
}

function classifyArtifactAgentV1(
  query: string,
): MemoryOutputOwnerV1 | undefined {
  const english =
    /\b(?:recommend(?:ed|ation)?|suggest(?:ed|ion)?|propos(?:ed|al)|answer(?:ed)?|repl(?:ied|y)|respond(?:ed|se)|provid(?:ed)?|list(?:ed)?|draft(?:ed)?|summar(?:ized|ised|y)|generat(?:ed)?|writ(?:ten|e)|creat(?:ed)?|compos(?:ed)?|word(?:ed|ing)?|nam(?:ed)?)\b[^?.!]{0,32}?\bby\s+(?<agent>you\s+and\s+me|me\s+and\s+you|you|me|us|i|we|(?:my|your|our|the)\s+[\p{L}\p{N}_-]+|[\p{L}\p{N}_-]+)/iu.exec(
      query,
    )?.groups?.agent;
  if (english) {
    const value = english.toLocaleLowerCase("en-US");
    if (value === "you") return "assistant";
    if (value === "me" || value === "i") return "user";
    if (
      value === "us" ||
      value === "we" ||
      value === "you and me" ||
      value === "me and you"
    ) {
      return "shared";
    }
    return "third_party";
  }

  const chinese =
    /被(?<agent>你和我|我和你|我们|咱们|你|您|我|[\p{Script=Han}]{1,12}?)(?:所)?(?:推荐|建议|提议|回答|回复|提供|列出|起草|草拟|总结|生成|写出|创建|创作|措辞|命名)/u.exec(
      query,
    )?.groups?.agent;
  if (!chinese) return undefined;
  if (chinese === "你" || chinese === "您") return "assistant";
  if (chinese === "我") return "user";
  if (
    chinese === "我们" ||
    chinese === "咱们" ||
    chinese === "你和我" ||
    chinese === "我和你"
  ) {
    return "shared";
  }
  return "third_party";
}

function isUnownedPriorAssistantArtifactQueryV1(query: string): boolean {
  const english =
    /^\s*(?:what|which)\s+(?:was|were|is|are)\s+the\s+(?:recommendation|suggestion|proposal|answer|response|reply|message|advice|list|draft|summary|wording)\s+(?:in|during)\s+(?:our\s+)?(?:previous|earlier|prior|last)\s+(?:conversation|chat|discussion|exchange|talk)\s*[?.!]*\s*$/iu.test(
      query,
    );
  const chinese =
    /^\s*(?:在)?(?:之前|上次|此前|先前|过去)(?:的)?(?:对话|聊天|讨论|交流)(?:里|中|里的|中的)?(?:的)?(?:推荐|建议|提议|回答|答案|回复|消息|列表|清单|草稿|摘要|措辞)(?:是什么|是哪个|有哪些|有哪(?:个|些))\s*[？?]*\s*$/u.test(
      query,
    );
  return english || chinese;
}

function isUnownedRecallCopularAssistantAssertionV1(
  query: string,
  provenance: MemoryRecallProvenanceV1 | undefined,
): boolean {
  if (provenance !== "unowned") return false;
  const answer = memoryRecallAnswerClauseV1(query);
  if (!answer || answer.language !== "en") return false;
  if (
    !/^\s*(?:what|which|where|when|how|who|whether)\s+(?:was|were|is|are)\s+(?:the|a|an)\b/iu.test(
      answer.text,
    )
  ) {
    return false;
  }
  const explicitOwnerOrSource =
    /\b(?:i|we|my|our|ours|us)\b|\b(?:by|from|according\s+to)\b|(?:来自|根据|按照|被)/iu.test(
      answer.text,
    );
  return !explicitOwnerOrSource && !isSharedDialogueOutcomeQueryV1(answer.text);
}

function classifyAssistantArtifactTargetOwnerV1(
  query: string,
): MemoryOutputOwnerV1 | undefined {
  const artifact =
    "recommendation|suggestion|proposal|answer|response|reply|message|advice|list|draft|summary|wording";
  const english = new RegExp(
    `\\b(?:what|which)\\s+(?:was|were|is|are)\\s+(?<owner>my|your|our)\\s+(?:${artifact})\\b`,
    "iu",
  ).exec(query)?.groups?.owner;
  if (english === "my") return "user";
  if (english === "your") return "assistant";
  if (english === "our") return "shared";
  if (
    new RegExp(
      `\\b(?:what|which)\\s+(?:was|were|is|are)\\s+(?:(?:my|your|our|the)\\s+)?[\\p{L}\\p{N}_-]+(?:'s|’s)\\s+(?:${artifact})\\b`,
      "iu",
    ).test(query)
  ) {
    return "third_party";
  }

  const chineseOwner =
    /(?<owner>我的|你的|您的|我们的|咱们的)(?:推荐|建议|提议|回答|答案|回复|消息|列表|清单|草稿|摘要|措辞).{0,32}(?:是什么|是哪个|什么|哪个|吗|？|\?)/u.exec(
      query,
    )?.groups?.owner;
  if (chineseOwner === "我的") return "user";
  if (chineseOwner === "你的" || chineseOwner === "您的") return "assistant";
  if (chineseOwner === "我们的" || chineseOwner === "咱们的") {
    return "shared";
  }
  const chineseArtifact =
    "(?:推荐|建议|提议|回答|答案|回复|消息|列表|清单|草稿|摘要|措辞)";
  const afterDialogue = new RegExp(
    `(?:对话|聊天|讨论|交流)(?:里|中)(?<owner>[\\p{Script=Han}]{1,8})的${chineseArtifact}`,
    "u",
  ).exec(query)?.groups?.owner;
  if (afterDialogue) return "third_party";
  const chineseThirdParty = new RegExp(
    `^(?<owner>[\\p{Script=Han}]{1,12})的${chineseArtifact}`,
    "u",
  ).exec(query.trim())?.groups?.owner;
  if (
    chineseThirdParty &&
    !/(?:之前|上次|此前|先前|过去|对话|聊天|讨论|交流|里面|里的)/u.test(
      chineseThirdParty,
    )
  ) {
    return "third_party";
  }
  return undefined;
}

function classifyAssistantOutputArtifactAuthorshipV1(
  query: string,
): "assistant_artifact" | "third_party" | undefined {
  const answer = memoryRecallAnswerClauseV1(query);
  if (!answer) return undefined;
  if (answer.language === "en") {
    const outputVerb =
      "recommend(?:ed)?|suggest(?:ed)?|propos(?:ed)?|answer(?:ed)?|repl(?:ied)?|respond(?:ed)?|provid(?:ed)?|list(?:ed)?|draft(?:ed)?|summar(?:ized|ised)?|generat(?:ed)?|writ(?:ten|e)|creat(?:ed)?|compos(?:ed)?|word(?:ed)?|nam(?:ed)?";
    if (
      new RegExp(
        `^\\s*(?:what|which)\\b.{0,48}?\\b(?:was|were|is|are|been)\\s+(?:${outputVerb})\\b`,
        "iu",
      ).test(answer.text)
    ) {
      return "assistant_artifact";
    }
    const active = new RegExp(
      `^\\s*(?:what|which)\\b\\s+(?<subject>(?:my|your|our|the)\\s+[\\p{L}\\p{N}_-]+|[\\p{L}\\p{N}_-]+)\\s+(?:${outputVerb})\\b`,
      "iu",
    ).exec(answer.text)?.groups?.subject;
    if (!active) return undefined;
    return outputOwnerFromEnglishSubjectV1(active) === "assistant"
      ? "assistant_artifact"
      : "third_party";
  }

  if (
    /^(?:被|曾被).{0,24}(?:推荐|建议|提议|回答|回复|提供|列出|起草|草拟|总结|生成|写出|创建|创作|措辞|命名)/u.test(
      answer.text.trim(),
    )
  ) {
    return "assistant_artifact";
  }
  const active =
    /^(?<subject>[\p{Script=Han}]{1,12}?)(?:曾经|之前|上次|此前|当时)?(?:推荐|建议|提议|回答|回复|提供|列出|起草|草拟|总结|生成|写出|创建|创作|措辞|命名)(?:了|过)/u.exec(
      answer.text.trim(),
    )?.groups?.subject;
  if (active && !/^(?:最后|之前|上次|此前|当时|曾经)$/u.test(active)) {
    return active === "你" || active === "您"
      ? "assistant_artifact"
      : "third_party";
  }
  return /(?:推荐|建议|提议|回答|回复|提供|列出|起草|草拟|总结|生成|写出|创建|创作|措辞|命名)/u.test(
    answer.text,
  )
    ? "assistant_artifact"
    : undefined;
}

function isSharedDialogueOutcomeQueryV1(query: string): boolean {
  const englishOutcome =
    /\b(?:decid(?:e|ed|ing)|decision|agree(?:d|ment)?|cho(?:ose|se|sen)|select(?:ed|ion)?|settle(?:d|ment)?|final(?:ize|ized|ised|\s+choice)|adopt(?:ed|ion)?|commit(?:ted|ment)?|approv(?:e|ed|al)|confirm(?:ed|ation)?|pick(?:ed|ing)?|resolution)\b/iu.test(
      query,
    );
  const chineseOutcome =
    /(?:决定|决策|同意|一致|达成|选择|选定|敲定|确定|确认|通过|最终方案|共同方案)/u.test(
      query,
    );
  return englishOutcome || chineseOutcome;
}

/**
 * Some recall questions establish that the answer lives in prior dialogue but
 * do not establish who authored it. Keep the primary user authority boundary
 * intact and open only a separately certified assistant-candidate channel.
 *
 * A nominative subject in the answer clause is explicit provenance. Possessive
 * objects such as "my plan" are not: the plan may have been supplied by either
 * participant. Prior-conversation references without a recall verb are the
 * same unresolved case.
 */
export function needsCertifiedAssistantDialogueCandidateV1(
  query: string,
): boolean {
  const value = boundedQuery(query);
  const answer = memoryRecallAnswerClauseV1(value);
  if (answer) {
    // Reuse the complete provenance classifier. In particular, possessive
    // user facts such as "my address" have no nominative subject but are not
    // unresolved dialogue artifacts and must remain closed to assistant text.
    return classifyMemoryRecallProvenanceV1(value) === "unowned";
  }
  if (isExplicitUserOriginMemoryQueryV1(value)) return false;
  const priorDialogueReference =
    /\b(?:previous|earlier|prior|last)\b.{0,64}\b(?:conversation|chat|discussion|exchange|talk)\b|\b(?:conversation|chat|discussion|exchange|talk)\b.{0,64}\b(?:previous|earlier|prior|last)\b|(?:之前|上次|此前|先前|过去).{0,48}(?:对话|聊天|讨论|交流)|(?:对话|聊天|讨论|交流).{0,48}(?:之前|上次|此前|先前|过去)/iu.test(
      value,
    );
  return (
    priorDialogueReference &&
    /\b(?:what|which|where|when|how|who|whether)\b|(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁|是否)/iu.test(
      value,
    )
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
