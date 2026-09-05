import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";

/**
 * A deliberately narrow, query-owned request for the Nth *assistant reply*
 * in one dialogue session. This is not a generic ordinal parser: ordinals
 * inside one response (for example, the fifth bottle in a list) remain a
 * reader/content operation and must never be mistaken for the fifth reply.
 */
export const PAW_MEMORY_DIALOGUE_ORDINAL_CONSTRAINT_VERSION_V1 =
  "paw.memory-dialogue-ordinal-constraint.v2:local-assistant-artifact" as const;

export interface MemoryDialogueOrdinalConstraintV1 {
  readonly constraintVersion: typeof PAW_MEMORY_DIALOGUE_ORDINAL_CONSTRAINT_VERSION_V1;
  readonly queryHash: string;
  readonly ordinal: number;
  readonly role: "assistant_output";
  readonly order: "ascending";
  readonly scope: "within_session";
  readonly artifactHead: string;
  readonly artifactPhrase: string;
  readonly granularity: "assistant_reply_artifact";
  readonly constraintRevision: string;
}

const ORDINAL_WORDS = new Map<string, number>([
  ["first", 1],
  ["second", 2],
  ["third", 3],
  ["fourth", 4],
  ["fifth", 5],
  ["sixth", 6],
  ["seventh", 7],
  ["eighth", 8],
  ["ninth", 9],
  ["tenth", 10],
]);
// The query itself supplies the artifact lemma. A fixed noun list both misses
// legitimate artifacts and creates benchmark-shaped behaviour.
const ARTIFACT_HEAD = "[\\p{L}][\\p{L}\\p{N}'-]{1,63}";
const CREATION_VERB =
  "(?:created|wrote|generated|recommended|suggested|gave|provided|produced|composed|made|drafted|designed)";
const COUNT_WORD =
  "(?:two|three|four|five|six|seven|eight|nine|ten|multiple|several|different|\\d{1,2})";

/** Compile only an explicit multi-reply artifact reference. */
export function compileMemoryDialogueOrdinalConstraintV1(
  query: string,
): MemoryDialogueOrdinalConstraintV1 | undefined {
  const normalized = query.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 4_096 || !normalized.includes("?"))
    return undefined;
  const ordinalMatches = [
    ...normalized.matchAll(
      /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d{1,2}(?:st|nd|rd|th))\b/giu,
    ),
  ];
  if (ordinalMatches.length !== 1) return undefined;
  const ordinal = ordinalMatches[0]?.[1]
    ? readOrdinal(ordinalMatches[0][1])
    : undefined;
  if (ordinal === undefined || ordinal > 8) return undefined;
  const ordinalAt = ordinalMatches[0]?.index ?? -1;
  const interrogatives = [
    ...normalized.matchAll(/\b(?:what|which|who|where|when|how)\b/giu),
  ];
  const interrogativeAt = interrogatives[0]?.index ?? -1;
  // The ordered artifact must be the answer slot of the interrogative clause,
  // not merely timeline context for a different question ("after the second
  // song, what recipe..."). Keeping this syntactic gate local makes the
  // compiler query-owned without a benchmark noun/verb blacklist.
  if (
    interrogatives.length !== 1 ||
    interrogativeAt < 0 ||
    ordinalAt <= interrogativeAt
  )
    return undefined;
  const answerLead = normalized.slice(interrogativeAt, ordinalAt);
  const beforeOrdinal = normalized.slice(
    Math.max(0, ordinalAt - 48),
    ordinalAt,
  );
  if (
    /(?:\b(?:his|her|their|its)|\b[\p{L}][\p{L}'-]{1,63}'s)\s*$/iu.test(
      beforeOrdinal,
    ) ||
    /\b(?:for|to)\s+(?:him|her|them|[A-Z][\p{L}'-]{1,63})\b/u.test(normalized)
  )
    return undefined;
  // Content ordinals inside one assistant response are reader work. They may
  // share the same nouns and creation verbs, but must never select an
  // assistant *turn* / population host.
  if (
    /\b(?:same|single|one)\s+(?:assistant\s+)?(?:response|reply|message|list)\b/iu.test(
      normalized,
    )
  )
    return undefined;
  // One bounded local construction binds owner, creation, count, and the
  // plural artifact. A separate global verb/noun match would silently join
  // unrelated clauses, which is exactly what this compiler must prevent.
  const ownerCreation = new RegExp(
    `\\b(?<owner>you|assistant)\\s+${CREATION_VERB}\\s+(?<count>${COUNT_WORD})\\s+(?<createdPhrase>(?:[\\p{L}\\p{N}'-]+\\s+){0,3}(?<createdHead>${ARTIFACT_HEAD})s)\\b(?<tail>[\\s\\S]{0,192})`,
    "iu",
  ).exec(normalized);
  const reverseCreation = new RegExp(
    `\\b(?<count>${COUNT_WORD})\\s+(?<createdPhrase>(?:[\\p{L}\\p{N}'-]+\\s+){0,3}(?<createdHead>${ARTIFACT_HEAD})s)\\s+(?<owner>you|assistant)\\s+${CREATION_VERB}\\b(?<tail>[\\s\\S]{0,192})`,
    "iu",
  ).exec(normalized);
  const groups = ownerCreation?.groups ?? reverseCreation?.groups;
  if (!groups?.count || !groups.createdHead || !groups.tail) return undefined;
  const count = readCardinal(groups.count);
  if (count === undefined || count < ordinal || count > 8) return undefined;
  const createdHead = groups.createdHead.toLowerCase();
  const ordinalArtifact = new RegExp(
    `\\b${ordinalMatches[0]?.[1]}\\s+(?<ordinalPhrase>(?:[\\p{L}\\p{N}'-]+\\s+){0,3}${escapeRegExp(createdHead)})\\b`,
    "iu",
  ).exec(groups.tail);
  if (!ordinalArtifact?.groups?.ordinalPhrase) {
    return undefined;
  }
  const ordinalArtifactEnd =
    (ordinalArtifact.index ?? -1) + ordinalArtifact[0].length;
  if (
    ordinalArtifactEnd < 0 ||
    !isDirectOrdinalArtifactQuestionV1({
      answerLead,
      tail: groups.tail.slice(ordinalArtifactEnd),
    })
  ) {
    return undefined;
  }
  const artifactHead = createdHead;
  if (
    !artifactDescriptorsCompatible(
      groups.createdPhrase ?? "",
      ordinalArtifact.groups.ordinalPhrase,
    )
  ) {
    return undefined;
  }
  const artifactPhrase = ordinalArtifact.groups.ordinalPhrase
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  const identity = {
    constraintVersion: PAW_MEMORY_DIALOGUE_ORDINAL_CONSTRAINT_VERSION_V1,
    queryHash: hashTextV1(normalized),
    ordinal,
    role: "assistant_output" as const,
    order: "ascending" as const,
    scope: "within_session" as const,
    artifactHead,
    artifactPhrase,
    granularity: "assistant_reply_artifact" as const,
  };
  return Object.freeze({
    ...identity,
    constraintRevision: hashCanonicalJsonV1(identity as JsonValue),
  });
}

/**
 * The ordinal artifact itself must fill the question's answer slot. This is a
 * syntax whitelist, not a noun/benchmark list: direct copula and containment
 * questions are safe, as is the narrow internal-composition relation used by
 * the EACA-style chord/chorus question. Generic "of the second ..." questions
 * are intentionally not enough.
 */
function isDirectOrdinalArtifactQuestionV1(input: {
  readonly answerLead: string;
  readonly tail: string;
}): boolean {
  const directTail =
    /^\s*(?:(?:you|assistant)\s+(?:created|wrote|generated|recommended|suggested|gave|provided|produced|composed|made|drafted|designed))?\s*\?\s*$/iu;
  if (!directTail.test(input.tail)) return false;
  const copula = /^\bwhat\s+(?:was|were|is|are)\s+(?:(?:the|your|my)\s+)?$/iu;
  const containment = /^\bwhat\s+(?:was|were|is|are)\s+in\s+(?:the\s+)?$/iu;
  const word = "[\\p{L}\\p{N}'-]+";
  const internalComposition = new RegExp(
    `^\\bwhat\\s+(?:${word}\\s+){0,5}(?:made\\s+up|formed|comprised|constituted)\\s+(?:the\\s+)?(?:${word}\\s+){1,4}of\\s+(?:the\\s+)?$`,
    "iu",
  );
  return (
    copula.test(input.answerLead) ||
    containment.test(input.answerLead) ||
    internalComposition.test(input.answerLead)
  );
}

export function isMemoryDialogueOrdinalConstraintV1(
  value: unknown,
): value is MemoryDialogueOrdinalConstraintV1 {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<MemoryDialogueOrdinalConstraintV1>;
  if (
    item.constraintVersion !==
      PAW_MEMORY_DIALOGUE_ORDINAL_CONSTRAINT_VERSION_V1 ||
    typeof item.queryHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item.queryHash) ||
    !Number.isSafeInteger(item.ordinal) ||
    (item.ordinal ?? 0) < 1 ||
    (item.ordinal ?? 0) > 8 ||
    item.role !== "assistant_output" ||
    item.order !== "ascending" ||
    item.scope !== "within_session" ||
    item.granularity !== "assistant_reply_artifact" ||
    typeof item.artifactHead !== "string" ||
    !/^[\p{L}][\p{L}\p{N}'-]{1,63}$/u.test(item.artifactHead) ||
    typeof item.artifactPhrase !== "string" ||
    !item.artifactPhrase.trim() ||
    typeof item.constraintRevision !== "string" ||
    !/^[a-f0-9]{64}$/u.test(item.constraintRevision)
  )
    return false;
  const identity = {
    constraintVersion: item.constraintVersion,
    queryHash: item.queryHash,
    ordinal: item.ordinal,
    role: item.role,
    order: item.order,
    scope: item.scope,
    artifactHead: item.artifactHead,
    artifactPhrase: item.artifactPhrase,
    granularity: item.granularity,
  };
  return item.constraintRevision === hashCanonicalJsonV1(identity as JsonValue);
}

function readOrdinal(wordInput: string): number | undefined {
  const word = wordInput.toLowerCase();
  const named = ORDINAL_WORDS.get(word);
  if (named !== undefined) return named;
  const numericMatch = /^(\d+)(st|nd|rd|th)$/u.exec(word);
  if (!numericMatch) return undefined;
  const digits = numericMatch[1] ?? "";
  if (digits.length > 1 && digits.startsWith("0")) return undefined;
  const numeric = Number.parseInt(digits, 10);
  const suffix = numericMatch[2];
  const expectedSuffix =
    numeric % 100 >= 11 && numeric % 100 <= 13
      ? "th"
      : numeric % 10 === 1
        ? "st"
        : numeric % 10 === 2
          ? "nd"
          : numeric % 10 === 3
            ? "rd"
            : "th";
  if (suffix !== expectedSuffix) return undefined;
  return Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= 10
    ? numeric
    : undefined;
}

/** An ordinal may omit a modifier, but never replace one with another. */
function artifactDescriptorsCompatible(
  createdPhrase: string,
  ordinalPhrase: string,
): boolean {
  const words = (value: string) =>
    value
      .toLowerCase()
      .match(/[\p{L}\p{N}'-]+/gu)
      ?.slice(0, -1)
      .map((word) => word.replace(/s$/u, "")) ?? [];
  const created = new Set(words(createdPhrase));
  return words(ordinalPhrase).every((word) => created.has(word));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readCardinal(wordInput: string): number | undefined {
  const words = new Map<string, number>([
    ["two", 2],
    ["three", 3],
    ["four", 4],
    ["five", 5],
    ["six", 6],
    ["seven", 7],
    ["eight", 8],
    ["nine", 9],
    ["ten", 10],
  ]);
  return (
    words.get(wordInput.toLowerCase()) ??
    (/^(?:[2-9]|10)$/u.test(wordInput) ? Number(wordInput) : undefined)
  );
}
