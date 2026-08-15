import { createHash } from "node:crypto";

import {
  type AppState,
  USER_INTERACTION_SCHEMA_V1,
  type UserReplyInboxEventV1,
  type WaitingUserInteractionV1,
  sanitizeUserInput,
} from "@paw/core";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function parseWaitingUserInteractionV1(
  value: unknown,
): WaitingUserInteractionV1 | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid waiting-user interaction");
  }
  const interaction = value as Record<string, unknown>;
  const context = interaction.context;
  if (
    interaction.schemaVersion !== USER_INTERACTION_SCHEMA_V1 ||
    typeof interaction.requestId !== "string" ||
    (interaction.status !== "waiting_user" &&
      interaction.status !== "consumed") ||
    typeof interaction.question !== "string" ||
    !context ||
    typeof context !== "object" ||
    Array.isArray(context) ||
    (interaction.timeoutSec !== null &&
      typeof interaction.timeoutSec !== "number") ||
    typeof interaction.requestedTurn !== "number" ||
    typeof interaction.requestedAt !== "number" ||
    (interaction.consumedReplyId !== undefined &&
      typeof interaction.consumedReplyId !== "string")
  ) {
    throw new Error("Invalid waiting-user interaction");
  }
  return Object.freeze({
    schemaVersion: USER_INTERACTION_SCHEMA_V1,
    requestId: interaction.requestId,
    status: interaction.status,
    question: interaction.question,
    context: Object.freeze({ ...(context as Record<string, unknown>) }),
    timeoutSec: interaction.timeoutSec as number | null,
    requestedTurn: interaction.requestedTurn,
    requestedAt: interaction.requestedAt,
    ...(typeof interaction.consumedReplyId === "string"
      ? { consumedReplyId: interaction.consumedReplyId }
      : {}),
  });
}

export function createWaitingUserInteractionV1(input: {
  readonly runId: string;
  readonly turn: number;
  readonly question: string;
  readonly context: Readonly<Record<string, unknown>>;
  readonly timeoutSec: number | null;
  readonly now?: number;
}): WaitingUserInteractionV1 {
  const question = input.question.trim();
  if (!question) throw new Error("waiting_user question must not be empty");
  return Object.freeze({
    schemaVersion: USER_INTERACTION_SCHEMA_V1,
    requestId: `ask-${digest(`${input.runId}\0${input.turn}\0${question}`)}`,
    status: "waiting_user" as const,
    question,
    context: Object.freeze({ ...input.context }),
    timeoutSec: input.timeoutSec,
    requestedTurn: input.turn,
    requestedAt: input.now ?? Date.now(),
  });
}

export function parseInteractionInboxV1(
  value: unknown,
): readonly UserReplyInboxEventV1[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("Invalid interaction inbox");
  return Object.freeze(
    value.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Invalid interaction inbox event");
      }
      const event = raw as Record<string, unknown>;
      if (
        event.schemaVersion !== USER_INTERACTION_SCHEMA_V1 ||
        event.seq !== index + 1 ||
        event.type !== "user.reply.submitted" ||
        typeof event.replyId !== "string" ||
        typeof event.requestId !== "string" ||
        typeof event.reply !== "string" ||
        typeof event.submittedAt !== "number"
      ) {
        throw new Error(`Invalid interaction inbox event at ${index + 1}`);
      }
      return Object.freeze({
        schemaVersion: USER_INTERACTION_SCHEMA_V1,
        seq: event.seq,
        type: "user.reply.submitted" as const,
        replyId: event.replyId,
        requestId: event.requestId,
        reply: event.reply,
        submittedAt: event.submittedAt,
      });
    }),
  );
}

export function appendUserReplyV1(
  state: AppState,
  input: {
    readonly requestId: string;
    readonly reply: string;
    readonly now?: number;
  },
): AppState {
  const interaction = parseWaitingUserInteractionV1(state.interaction);
  if (
    interaction?.schemaVersion !== USER_INTERACTION_SCHEMA_V1 ||
    interaction.status !== "waiting_user"
  ) {
    throw new Error(`Run ${state.runId} is not waiting for user input`);
  }
  if (interaction.requestId !== input.requestId) {
    throw new Error("User reply requestId does not match the active question");
  }
  const appended = appendReplyToInboxV1(
    state.interactionInbox,
    interaction,
    input,
  );
  if (!appended.appended) return state;
  return {
    ...state,
    interactionInbox: appended.inbox,
    savedAt: input.now ?? Date.now(),
  };
}

export function appendReplyToInboxV1(
  source: unknown,
  interaction: WaitingUserInteractionV1,
  input: {
    readonly requestId: string;
    readonly reply: string;
    readonly now?: number;
  },
): {
  readonly inbox: readonly UserReplyInboxEventV1[];
  readonly event: UserReplyInboxEventV1;
  readonly appended: boolean;
} {
  if (interaction.requestId !== input.requestId) {
    throw new Error("User reply requestId does not match the active question");
  }
  const reply = input.reply.trim();
  if (!reply) throw new Error("User reply must not be empty");
  if (reply.length > 100_000) throw new Error("User reply is too large");
  const inbox = parseInteractionInboxV1(source);
  const existing = inbox.find((event) => event.requestId === input.requestId);
  if (existing) {
    if (existing.reply !== reply) {
      throw new Error("A different reply already exists for this requestId");
    }
    return { inbox, event: existing, appended: false };
  }
  const event: UserReplyInboxEventV1 = Object.freeze({
    schemaVersion: USER_INTERACTION_SCHEMA_V1,
    seq: inbox.length + 1,
    type: "user.reply.submitted",
    replyId: `reply-${digest(`${input.requestId}\0${reply}`)}`,
    requestId: input.requestId,
    reply,
    submittedAt: input.now ?? Date.now(),
  });
  return {
    inbox: Object.freeze([...inbox, event]),
    event,
    appended: true,
  };
}

export type PrepareInteractionResumeV1 =
  | {
      readonly kind: "waiting_user";
      readonly interaction: WaitingUserInteractionV1;
    }
  | { readonly kind: "ready"; readonly state: AppState };

export function prepareInteractionResumeV1(
  state: AppState,
  now = Date.now(),
): PrepareInteractionResumeV1 {
  const interaction = parseWaitingUserInteractionV1(state.interaction);
  if (!interaction || interaction.status === "consumed") {
    return { kind: "ready", state };
  }
  if (interaction.schemaVersion !== USER_INTERACTION_SCHEMA_V1) {
    throw new Error("Unsupported waiting-user interaction schema");
  }
  const inbox = parseInteractionInboxV1(state.interactionInbox);
  const reply = inbox.find(
    (event) => event.requestId === interaction.requestId,
  );
  if (!reply) return { kind: "waiting_user", interaction };
  const marker = `[User reply request_id=${interaction.requestId} reply_id=${reply.replyId}]`;
  const alreadyInjected = state.messages.some((message) =>
    message.content.startsWith(marker),
  );
  const sanitized = sanitizeUserInput(reply.reply).text;
  const prepared: AppState = {
    ...state,
    messages: alreadyInjected
      ? state.messages
      : [
          ...state.messages,
          { role: "user", content: `${marker}\n${sanitized}` },
        ],
    interaction: Object.freeze({
      ...interaction,
      status: "consumed" as const,
      consumedReplyId: reply.replyId,
    }),
    outcome: undefined,
    savedAt: now,
  };
  return { kind: "ready", state: prepared };
}
