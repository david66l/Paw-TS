import { isAssistantMemoryQueryV1 } from "./evidence-first.js";
import type {
  MemoryEvidenceAnswerShapeV3,
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
