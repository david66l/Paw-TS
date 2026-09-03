import { isAssistantMemoryQueryV1 } from "./evidence-first.js";
import { memoryEvidenceQueryHasMultipleObligationsV1 } from "./evidence-obligation.js";
import type {
  MemoryEvidenceAnswerShapeV3,
  MemoryEvidenceIntentBoundaryV1,
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRoleConstraintV3,
  MemoryEvidenceTemporalModeV3,
} from "./query-plan-contracts.js";

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
  const priorRecommendationRecall = isPriorRecommendationRecallV1(value);
  const compare =
    /\b(?:compared\s+to|difference\s+between|both|each|respectively)\b|(?:相比|比较|区别|差异|两者|分别|各自)/iu.test(
      value,
    );
  const aggregate =
    /\b(?:how\s+(?:many|much)|what\s+percentage|percent(?:age)?\s+of|ratio\s+of|total|combined|altogether)\b|(?:多少|总共|合计|一共|加起来|百分之|占.{0,24}(?:比例|百分比))/iu.test(
      value,
    );
  const newRecommendation =
    !priorRecommendationRecall &&
    /\b(?:recommend|recommendation|suggest|suggestion|what\s+should\s+i|should\s+i|any\s+(?:tips|ideas|advice)|good\s+(?:options|activities|recipes?)|what\s+do\s+you\s+think|do\s+you\s+think\s+(?:it|this|that).{0,64}good\s+idea|could\s+there\s+be\s+a\s+reason|do\s+you\s+think\s+it\s+might)\b|(?:推荐|建议|有什么(?:好)?(?:办法|选择|活动|食谱)|我应该|你觉得|你怎么看)/iu.test(
      value,
    );
  const answerShape: MemoryEvidenceAnswerShapeV3 = compare
    ? "compare"
    : aggregate
      ? "aggregate"
      : newRecommendation
        ? "recommend"
        : "lookup";
  const temporalMode = classifyMemoryEvidenceTemporalModeV1(value);
  return Object.freeze({
    answerShape,
    temporalMode,
    roleConstraint,
    needsPlanning:
      answerShape !== "lookup" ||
      temporalMode !== "any" ||
      roleConstraint !== "user" ||
      certifiedAssistantDialogueCandidate ||
      memoryEvidenceQueryHasMultipleObligationsV1(value),
  });
}

/** A past recommendation is an assistant-authored artifact to recall, not a new recommendation. */
function isPriorRecommendationRecallV1(query: string): boolean {
  const futureRequest =
    /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:recommend|suggest)\b|\bwhat\s+should\s+i\b/iu.test(
      query,
    ) || /(?:请|能否|可以|帮我).{0,12}(?:推荐|建议)|我应该/u.test(query);
  if (futureRequest) return false;
  return (
    /\b(?:what|which)\b.{0,64}\b(?:did|had)\s+you\b.{0,48}\b(?:recommend|suggest|mention)\b/iu.test(
      query,
    ) ||
    /\b(?:what|which)\s+(?:recommendation|suggestion)\b.{0,48}\bdid\b/iu.test(
      query,
    ) ||
    /\b(?:remember|recall|remind)\b.{0,128}\b(?:recommend(?:ed|ation)?|suggest(?:ed|ion)?)\b/iu.test(
      query,
    ) ||
    /\b(?:recommend(?:ed)?|suggest(?:ed)?)\b.{0,64}\b(?:last|previous|previously|earlier|before|prior)\b/iu.test(
      query,
    ) ||
    /(?:上次|之前|此前|曾经|还记得|记得|回忆|提醒我).{0,80}(?:推荐|建议)|(?:推荐|建议).{0,48}(?:上次|之前|此前|曾经).{0,32}(?:什么|哪个|哪些)/u.test(
      query,
    )
  );
}

/**
 * Separates explicit authority from heuristic fallback. A semantic axis is not
 * unrestricted input: the planner still returns one bounded enum value and the
 * port validates every requirement against that normalized value.
 */
export function classifyMemoryEvidenceIntentBoundaryV1(
  query: string,
  intent = classifyMemoryEvidenceQueryV3(query),
): MemoryEvidenceIntentBoundaryV1 {
  const value = boundedQuery(query);
  const recallProvenance = classifyMemoryRecallProvenanceV1(value);
  const explicitRole =
    recallProvenance === "user" ||
    recallProvenance === "assistant" ||
    recallProvenance === "shared" ||
    isExplicitUserOriginMemoryQueryV1(value) ||
    isExplicitSharedDialogueQueryV1(value) ||
    isAssistantMemoryQueryV1(value);
  return Object.freeze({
    answerShape:
      intent.answerShape === "lookup" && !isPriorRecommendationRecallV1(value)
        ? "semantic"
        : "fixed",
    temporalMode: intent.temporalMode === "any" ? "semantic" : "fixed",
    roleConstraint: explicitRole ? "fixed" : "semantic",
  });
}

/**
 * Content-free provenance features used by the typed query-origin boundary.
 *
 * These signals deliberately distinguish an answer-clause author from a
 * participant merely mentioned elsewhere in the question. In particular,
 * first-person context does not make the user the author of a requested prior
 * assistant artifact.
 */
export interface MemoryQueryAnswerProvenanceFeaturesV1 {
  readonly secondPersonCue: boolean;
  readonly priorDialogueCue: boolean;
  readonly recallActionCue: boolean;
  readonly explicitUserAnswerAuthor: boolean;
  readonly explicitAssistantAnswerAuthor: boolean;
  readonly explicitSharedAnswerAuthor: boolean;
  readonly dialogueRoleResolutionCandidate: boolean;
  readonly certifiedAssistantDialogueCandidate: boolean;
}

export function classifyMemoryQueryAnswerProvenanceFeaturesV1(
  query: string,
): MemoryQueryAnswerProvenanceFeaturesV1 {
  const value = boundedQuery(query);
  const answer = memoryRecallAnswerClauseV1(value);
  const answerSubject = answer
    ? firstAnswerClauseSubjectV1(answer.text, answer.language)
    : undefined;
  const answerSubjectOwner =
    answerSubject && answerSubject !== "ambiguous"
      ? answerSubject.owner
      : undefined;
  const recallProvenance = classifyMemoryRecallProvenanceV1(value);
  return Object.freeze({
    secondPersonCue: /\b(?:you|your|yours)\b|(?:你|你的)/iu.test(value),
    priorDialogueCue:
      /\b(?:again|before|earlier|last|previous|previously|prior)\b|(?:再次|以前|之前|上次|此前)/iu.test(
        value,
      ),
    recallActionCue:
      /\b(?:remember|recall|remind|forgot|forget)\b|(?:记得|回忆|提醒|忘记|想不起来)/iu.test(
        value,
      ),
    explicitUserAnswerAuthor:
      answerSubjectOwner === "user" || hasExplicitUserAnswerSubjectV1(value),
    explicitAssistantAnswerAuthor:
      answerSubjectOwner === "assistant" ||
      (answerSubjectOwner === undefined &&
        (recallProvenance === "assistant" || isAssistantMemoryQueryV1(value))),
    explicitSharedAnswerAuthor:
      answerSubjectOwner === "shared" ||
      recallProvenance === "shared" ||
      isExplicitSharedDialogueQueryV1(value),
    dialogueRoleResolutionCandidate: needsMemoryEvidenceRoleResolutionV1(value),
    certifiedAssistantDialogueCandidate:
      needsCertifiedAssistantDialogueCandidateV1(value),
  });
}

function classifyMemoryEvidenceTemporalModeV1(
  query: string,
): MemoryEvidenceTemporalModeV3 {
  if (/\bas\s+of\b|(?:截至|截止到|到.{0,24}为止)/iu.test(query)) {
    return "as_of";
  }
  // Ordering is a history operation even when its wording contains "latest".
  // This precedence prevents "earliest to latest" from collapsing to one
  // frontier value and discarding the sequence it explicitly asks for.
  const orderedHistory =
    /\b(?:earliest|oldest|first)\b.{0,64}\b(?:to|through|until)\b.{0,32}\b(?:latest|newest|last|most\s+recent)\b|\b(?:chronological(?:ly)?|in\s+(?:what|which)\s+order|order\s+of)\b|(?:从|按).{0,24}(?:最早|第一次|首次).{0,24}(?:到|至|排到).{0,24}(?:最新|最近|最后)|(?:时间顺序|先后顺序|按时间排序)/iu.test(
      query,
    );
  if (orderedHistory) return "history";
  const latest =
    /\b(?:latest|currently|most\s+recent|now|today|at\s+present)\b|(?:最新|现在|目前|最近一次|今天)/iu.test(
      query,
    ) ||
    /\bcurrent\s+(?:count|number|status|balance|level|value|total|amount|location|city|address|job|role|preference|plan)\b|当前(?:数量|数值|状态|余额|等级|级别|总数|金额|位置|城市|地址|工作|角色|偏好|计划)/iu.test(
      query,
    );
  if (latest) return "latest";
  // Strong relative-date expressions are bounded lookup scopes. Bare "last
  // time" remains ordinary dialogue recall. Recency is checked first so a
  // query such as "latest update last week" keeps its latest operation and
  // receives the week as an orthogonal bound later.
  if (
    /\b(?:last|this\s+past)\s+(?:weekend|month|week|sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b|\b(?:yesterday|\d{1,3}\s+(?:days?|weeks?|months?)\s+ago|(?:past|last)\s+\d{1,3}\s+(?:days?|weeks?|months?))\b|(?:上个周末|上周末|上个月|上周(?:[一二三四五六日天])?|昨天|\d{1,3}\s*(?:天|周|个?星期|个月)前|过去\s*\d{1,3}\s*(?:天|周|个?星期|个?月))/iu.test(
      query,
    )
  ) {
    return "range";
  }
  const ordinalHistory =
    !/\b(?:first|last|family|given|middle)\s+name\b/iu.test(query) &&
    /\b(?:what|which|where|when|how|who)\b.{0,96}\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|earliest)\b|\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|earliest)\b.{0,96}\b(?:did|was|were|is|are|came|happened|occurred|said|mentioned|recommended|suggested|chose|selected)\b|(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁).{0,64}(?:第[一二三四五六七八九十\d]+(?:次|个|条|项|段|轮)|首次|最早)|(?:第[一二三四五六七八九十\d]+(?:次|个|条|项|段|轮)|首次|最早).{0,64}(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁)/iu.test(
      query,
    );
  if (
    ordinalHistory ||
    /\b(?:over\s+time|changed?|history|previously|used\s+to|evolution)\b|(?:随时间|变化|历史|以前|曾经|演变|过程)/iu.test(
      query,
    )
  ) {
    return "history";
  }
  return /\b(?:between|from\b.{0,48}\bto|since|before|after|during|within|ago)\b|(?:从.{0,24}到|之间|以来|之前|之后|期间|以内|前(?:多久|多少(?:天|周|月|年)))/iu.test(
    query,
  )
    ? "range"
    : "any";
}

function isExplicitUserOriginMemoryQueryV1(query: string): boolean {
  const value = boundedQuery(query);
  const explicitUserSubject = hasExplicitUserAnswerSubjectV1(value);
  const possessiveUserState =
    /\b(?:what|which|where|when|how)\b.{0,80}\b(?:is|are|was|were|has|have|had)\s+(?:my|mine)\b|\b(?:what|which)\s+my\s+[\p{L}\p{N}_-]{1,48}\s+(?:is|are|was|were|has|have|had)\b/iu.test(
      value,
    );
  const chinesePossessive =
    /(?:什么|哪个|哪里|何时|什么时候|怎么|如何|多少).{0,64}(?:我的|本人(?:的)?)/u.test(
      value,
    );
  return explicitUserSubject || possessiveUserState || chinesePossessive;
}

/**
 * A nominative user subject establishes who supplied the remembered fact.
 * Possessive objects establish ownership only: "my draft" may still name an
 * artifact written by the assistant in a prior exchange.
 */
function hasExplicitUserAnswerSubjectV1(query: string): boolean {
  const firstPersonQuestion =
    /\b(?:what|which|where|when|how|who)\b.{0,100}\b(?:did|do|have|has|had|was|were|am)\s+i\b/iu.test(
      query,
    );
  const chineseFirstPersonQuestion =
    /(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁).{0,64}(?:是我|我(?:曾经|之前|上次|此前)?(?:在|于|有|做|说|提|去|把|将|给|从|向|选择|决定))/u.test(
      query,
    );
  return firstPersonQuestion || chineseFirstPersonQuestion;
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
  // A polite request to recall an artifact from a prior exchange establishes
  // dialogue provenance but not authorship. Keep the user lane primary and
  // allow only the certified assistant alternative. Explicit "I said/gave"
  // questions remain closed even when phrased as a reminder.
  if (hasExplicitUserAnswerSubjectV1(value)) return false;
  if (
    isPriorDialogueReferenceV1(value) &&
    /\b(?:can|could|would|will)\s+you\s+(?:please\s+)?remind\s+me\b|\b(?:please\s+)?remind\s+me\b.{0,80}\b(?:our|the)\s+(?:previous|earlier|prior|last)\s+(?:conversation|chat|discussion|exchange|talk)\b|(?:你能|你可以|请你|麻烦你).{0,24}提醒我/u.test(
      value,
    )
  ) {
    return true;
  }
  const answer = memoryRecallAnswerClauseV1(value);
  if (answer) {
    const provenance = classifyMemoryRecallProvenanceV1(value);
    if (provenance === "unowned") return true;
    const subject = firstAnswerClauseSubjectV1(answer.text, answer.language);
    // A possessive object is not an author signal. Keep user authority as the
    // primary lane, but let the existing certificate gate test whether an
    // exact assistant turn supplied the recalled dialogue artifact.
    return (
      provenance === "user" &&
      subject === undefined &&
      isPriorDialogueReferenceV1(value)
    );
  }
  return (
    isPriorDialogueReferenceV1(value) &&
    /\b(?:what|which|where|when|how|who|whether)\b|(?:什么|哪个|哪里|何时|什么时候|怎么|如何|谁|是否)/iu.test(
      value,
    )
  );
}

function isPriorDialogueReferenceV1(query: string): boolean {
  return /\b(?:previous|earlier|prior|last)\b.{0,64}\b(?:conversation|chat|discussion|exchange|talk)\b|\b(?:conversation|chat|discussion|exchange|talk)\b.{0,64}\b(?:previous|earlier|prior|last)\b|(?:之前|上次|此前|先前|过去).{0,48}(?:对话|聊天|讨论|交流)|(?:对话|聊天|讨论|交流).{0,48}(?:之前|上次|此前|先前|过去)/iu.test(
    query,
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

function boundedQuery(query: string): string {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryEvidenceQueryPlanQueryInvalid");
  }
  return value;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
