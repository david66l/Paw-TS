import {
  type MemoryConversationTurnBundleV1,
  type MemoryConversationTurnV1,
  PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1,
  type SelectedMemoryConversationBundlesV1,
} from "./evidence-contracts.js";
import {
  conversationTerms,
  focusedConversationExcerpt,
} from "./evidence-text.js";

/**
 * Returns true only when the current question explicitly asks about an earlier
 * assistant response or action. Assistant output is not a source of user facts,
 * so ordinary personal-memory questions must remain on the user-grounded path.
 */
export function isAssistantMemoryQueryV1(query: string): boolean {
  const normalized = query.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 512) return false;
  const explicitAssistantAction =
    /\b(?:what|which|how)\b.{0,80}\b(?:did|have)\s+you\b|\b(?:you|your)\s+(?:said|told|recommended|suggested|wrote|created|generated|showed|booked|scheduled|provided|listed|gave|produced|composed|answered|mentioned|shared|replied|responded|came\s+up\s+with)\b|(?:你(?:之前|上次|此前)?|(?:之前|上次|此前)你)(?:说|告诉|推荐|建议|写|创建|生成|展示|提供|列出|给出|回答|回复|提到|分享|预订|安排)(?:了|过|的)?/iu.test(
      normalized,
    );
  const explicitPriorResponse =
    /\byour\s+(?:previous|earlier|last)\s+(?:response|answer|message|reply)\b|(?:你之前|你上次|你此前)(?:的)?(?:回复|回答|消息)/iu.test(
      normalized,
    );
  const explicitReminder =
    /\bremind\s+me\b.{0,80}\bwhat\s+you\s+(?:said|answered|recommended|suggested|mentioned|provided|listed)\b|提醒我.{0,40}你(?:说|回答|推荐|建议|提到|提供|列出)(?:了|过|的)?/iu.test(
      normalized,
    );
  return explicitAssistantAction || explicitPriorResponse || explicitReminder;
}

/**
 * Packs one lexical L0 hit with its immediate conversational neighbors. Role
 * labels are trust boundaries: assistant text stays context-only, while an
 * adjacent user confirmation remains visible to the reader. Output order is
 * always chronological even though retrieval ranks the hit first.
 */
export function buildMemoryConversationTurnBundleV1(input: {
  readonly turns: readonly MemoryConversationTurnV1[];
  readonly query: string;
  readonly maxChars: number;
}): MemoryConversationTurnBundleV1 {
  if (!Number.isSafeInteger(input.maxChars) || input.maxChars < 256) {
    throw namedError("MemoryConversationTurnBundleBudgetInvalid");
  }
  const query = input.query.trim();
  if (!query || query.length > 512) {
    throw namedError("MemoryConversationTurnBundleQueryInvalid");
  }
  const turnsByIdentity = new Map<string, MemoryConversationTurnV1>();
  for (const turn of input.turns) {
    if (
      !Number.isSafeInteger(turn.sourceSeq) ||
      turn.sourceSeq < 0 ||
      !turn.content.trim()
    ) {
      continue;
    }
    const key = `${turn.sourceSeq}\0${turn.sourceKind}`;
    const existing = turnsByIdentity.get(key);
    if (!existing || preferConversationTurn(turn, existing) < 0) {
      turnsByIdentity.set(key, turn);
    }
  }
  const turns = [...turnsByIdentity.values()].sort(
    (left, right) =>
      left.sourceSeq - right.sourceSeq ||
      left.sourceKind.localeCompare(right.sourceKind),
  );
  const hits = turns.filter((turn) => turn.hit);
  if (hits.length !== 1) {
    throw namedError("MemoryConversationTurnBundleHitInvalid");
  }
  const hit = hits[0];
  if (!hit) throw namedError("MemoryConversationTurnBundleHitInvalid");
  const previousAssistant = turns.some(
    (turn) =>
      turn.sourceKind === "assistant_output" && turn.sourceSeq < hit.sourceSeq,
  );
  const nextUserConfirmation = turns.some(
    (turn) =>
      turn.sourceKind === "user_input" &&
      turn.sourceSeq > hit.sourceSeq &&
      explicitConfirmation(turn.content),
  );
  const authority =
    hit.sourceKind === "user_input"
      ? explicitConfirmation(hit.content) && previousAssistant
        ? "user_confirmed_dialogue"
        : "user_asserted"
      : hit.sourceKind === "assistant_output" && nextUserConfirmation
        ? "user_confirmed_dialogue"
        : "context_only";
  const hitBudget = Math.max(128, Math.floor(input.maxChars * 0.55));
  const neighborBudget = Math.max(
    64,
    Math.floor((input.maxChars - hitBudget) / Math.max(1, turns.length - 1)),
  );
  const queryTerms = conversationTerms(query);
  const parts: string[] = [];
  for (const turn of turns) {
    const relation = turn.hit
      ? "hit"
      : turn.sourceSeq < hit.sourceSeq
        ? "previous"
        : "next";
    const label = `[${turn.sourceKind} ${relation}] `;
    const available = Math.max(
      1,
      (turn.hit ? hitBudget : neighborBudget) - label.length,
    );
    const confirmed =
      turn.sourceKind === "user_input" &&
      turn.sourceSeq > hit.sourceSeq &&
      explicitConfirmation(turn.content);
    const content = confirmed
      ? turn.content.slice(0, available)
      : focusedConversationExcerpt(turn.content, queryTerms, available);
    parts.push(`${label}${content}`);
  }
  const text = parts.join("\n").slice(0, input.maxChars);
  return Object.freeze({
    policyVersion: PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1,
    text,
    hitSeq: hit.sourceSeq,
    authority,
    includedTurns: turns.length,
    includedEvidence: Object.freeze(
      turns.flatMap((turn) =>
        turn.evidenceRef
          ? [
              Object.freeze({
                evidenceRef: turn.evidenceRef,
                sourceKind: turn.sourceKind,
                turnOrder: turn.sourceSeq,
              }),
            ]
          : [],
      ),
    ),
    chars: text.length,
  });
}

function preferConversationTurn(
  left: MemoryConversationTurnV1,
  right: MemoryConversationTurnV1,
): number {
  if (left.hit !== right.hit) return left.hit ? -1 : 1;
  const evidenceOrder = (left.evidenceRef ?? "").localeCompare(
    right.evidenceRef ?? "",
  );
  return evidenceOrder || left.content.localeCompare(right.content);
}

function explicitConfirmation(content: string): boolean {
  return /^(?:user:\s*)?(?:yes|yeah|yep|correct|exactly|right|indeed|是的|对|没错)(?=$|[\s,，。.!！?？:：])/iu.test(
    content.trim(),
  );
}

/** Keeps several independently ranked dialogue hits from one source document. */
export function selectRankedMemoryConversationBundlesV1(input: {
  readonly bundles: readonly string[];
  readonly query: string;
  readonly maxBundles: number;
  readonly maxChars: number;
}): SelectedMemoryConversationBundlesV1 {
  const query = input.query.trim();
  if (
    !query ||
    query.length > 512 ||
    !Number.isSafeInteger(input.maxBundles) ||
    input.maxBundles < 1 ||
    input.maxBundles > 8 ||
    !Number.isSafeInteger(input.maxChars) ||
    input.maxChars < 256
  ) {
    throw namedError("MemoryConversationBundleSelectionBudgetInvalid");
  }
  const bundles = [...new Set(input.bundles.map((item) => item.trim()))]
    .filter(Boolean)
    .slice(0, input.maxBundles);
  if (bundles.length === 0) {
    return Object.freeze({ text: "", selectedBundles: 0, chars: 0 });
  }
  const separator = "\n--- adjacent evidence hit ---\n";
  const contentBudget = Math.max(
    1,
    input.maxChars - separator.length * Math.max(0, bundles.length - 1),
  );
  const perBundle = Math.max(1, Math.floor(contentBudget / bundles.length));
  const queryTerms = conversationTerms(query);
  const text = bundles
    .map((bundle) => focusedConversationExcerpt(bundle, queryTerms, perBundle))
    .join(separator)
    .slice(0, input.maxChars);
  return Object.freeze({
    text,
    selectedBundles: bundles.length,
    chars: text.length,
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
