import type { ModelSettlement } from "@paw/agent-loop";
import type { ChatMessage, ModelTokenUsage } from "@paw/core";
import type {
  ModelCompletionResult,
  ModelStreamChunk,
  NativeToolCall,
  PawAgentLoopModel,
  PawModelRequest,
} from "@paw/models";

export const MODEL_OUTPUT_RECOVERY_POLICY_VERSION_V1 =
  "paw.model-output-recovery.v1:d32000:l64000:h128000:c3" as const;

export const DEFAULT_MODEL_OUTPUT_RECOVERY_POLICY_V1 = Object.freeze({
  policyVersion: MODEL_OUTPUT_RECOVERY_POLICY_VERSION_V1,
  defaultMaxOutputTokens: 32_000,
  lowerTierMaxOutputTokens: 64_000,
  upperTierMaxOutputTokens: 128_000,
  maxContinuations: 3,
});

export interface ModelOutputRecoveryBudgetV1 {
  readonly defaultMaxOutputTokens: number;
  readonly recoveryMaxOutputTokens: number;
}

export interface ModelOutputRecoveryPluginOptionsV1 {
  readonly nativeMaxOutputTokens?: number;
  readonly maxContinuations?: number;
}

const CONTINUATION_INSTRUCTION = [
  "[Paw output recovery] Your previous response was cut off by the output-token limit.",
  "Continue directly from where it stopped without repeating completed content.",
  "No tool call from the truncated response was executed; emit any still-needed tool call again as one complete call.",
].join(" ");

/** Resolve the default request budget and the larger truncation-recovery cap. */
export function resolveModelOutputRecoveryBudgetV1(
  nativeMaxOutputTokens?: number,
): ModelOutputRecoveryBudgetV1 {
  if (
    nativeMaxOutputTokens !== undefined &&
    (!Number.isSafeInteger(nativeMaxOutputTokens) || nativeMaxOutputTokens <= 0)
  ) {
    throw new Error("nativeMaxOutputTokens must be a positive safe integer");
  }
  const policy = DEFAULT_MODEL_OUTPUT_RECOVERY_POLICY_V1;
  const tierCeiling =
    nativeMaxOutputTokens === undefined ||
    nativeMaxOutputTokens < policy.upperTierMaxOutputTokens
      ? policy.lowerTierMaxOutputTokens
      : policy.upperTierMaxOutputTokens;
  const recoveryMaxOutputTokens = Math.min(
    nativeMaxOutputTokens ?? tierCeiling,
    tierCeiling,
  );
  return Object.freeze({
    defaultMaxOutputTokens: Math.min(
      policy.defaultMaxOutputTokens,
      recoveryMaxOutputTokens,
    ),
    recoveryMaxOutputTokens,
  });
}

/**
 * Model-port decorator. Agent Loop still receives one logical settlement while
 * provider truncations are resumed within this independently testable plugin.
 */
export function createModelOutputRecoveryPluginV1(
  model: PawAgentLoopModel,
  options: ModelOutputRecoveryPluginOptionsV1 = {},
): PawAgentLoopModel {
  const budget = resolveModelOutputRecoveryBudgetV1(
    options.nativeMaxOutputTokens,
  );
  const maxContinuations =
    options.maxContinuations ??
    DEFAULT_MODEL_OUTPUT_RECOVERY_POLICY_V1.maxContinuations;
  if (!Number.isSafeInteger(maxContinuations) || maxContinuations < 0) {
    throw new Error("maxContinuations must be a non-negative safe integer");
  }

  const plugin: PawAgentLoopModel = {
    async execute(
      request: PawModelRequest,
      callOptions: Parameters<PawAgentLoopModel["execute"]>[1],
    ) {
      const completions: ModelCompletionResult[] = [];
      let currentRequest = withOutputBudget(
        request,
        request.options?.maxOutputTokens ?? budget.defaultMaxOutputTokens,
        budget.recoveryMaxOutputTokens,
      );

      for (let attempt = 0; ; attempt += 1) {
        const stream = createAttemptStream(callOptions.onStreamEvent);
        const settlement = await model.execute(currentRequest, {
          signal: callOptions.signal,
          onStreamEvent: stream.onEvent,
        });
        if (
          settlement.status !== "success" &&
          settlement.status !== "truncated"
        ) {
          return settlement;
        }

        completions.push(settlement.message);
        if (settlement.status === "success") {
          const combined = combineCompletions(completions, settlement.message);
          await stream.flushFinal(combined, true);
          return Object.freeze({
            status: "success" as const,
            message: combined,
            toolCalls: combined.toolCalls ?? [],
          });
        }

        if (attempt >= maxContinuations || callOptions.signal.aborted) {
          const combined = combineCompletions(completions, settlement.message);
          await stream.flushFinal(combined, false);
          return Object.freeze({
            status: "truncated" as const,
            message: combined,
            toolCalls: Object.freeze([]) as readonly NativeToolCall[],
            reason: `Model output remained truncated after ${attempt} continuation${attempt === 1 ? "" : "s"}`,
            finishReason: settlement.finishReason,
          });
        }

        currentRequest = continuationRequest(
          currentRequest,
          settlement.message,
          budget.recoveryMaxOutputTokens,
        );
      }
    },
  };
  return Object.freeze(plugin);
}

function withOutputBudget(
  request: PawModelRequest,
  requested: number,
  upper: number,
): PawModelRequest {
  return Object.freeze({
    ...request,
    options: Object.freeze({
      ...(request.options ?? {}),
      maxOutputTokens: Math.min(requested, upper),
    }),
  });
}

function continuationRequest(
  request: PawModelRequest,
  partial: ModelCompletionResult,
  maxOutputTokens: number,
): PawModelRequest {
  const assistantContent = partial.nativeAssistantContent ?? partial.text;
  const assistant: ChatMessage = Object.freeze({
    role: "assistant",
    content:
      assistantContent ||
      "[The previous response ended before producing visible assistant text.]",
    ...(partial.reasoningPassback
      ? { reasoningPassback: partial.reasoningPassback }
      : {}),
  });
  return Object.freeze({
    ...request,
    messages: Object.freeze([
      ...request.messages,
      assistant,
      Object.freeze({
        role: "user" as const,
        content: CONTINUATION_INSTRUCTION,
      }),
    ]),
    options: Object.freeze({
      ...(request.options ?? {}),
      maxOutputTokens,
    }),
  });
}

function combineCompletions(
  completions: readonly ModelCompletionResult[],
  final: ModelCompletionResult,
): ModelCompletionResult {
  const assistantContent = completions
    .map((completion) => completion.nativeAssistantContent ?? completion.text)
    .join("");
  const thinking = completions
    .map((completion) => completion.thinking)
    .filter((value): value is string => value !== undefined)
    .join("");
  const usage = sumUsage(completions.map((completion) => completion.usage));
  return Object.freeze({
    text: assistantContent,
    nativeAssistantContent: assistantContent,
    ...(thinking ? { thinking } : {}),
    ...(final.reasoningPassback
      ? { reasoningPassback: final.reasoningPassback }
      : {}),
    ...(usage ? { usage } : {}),
    ...(final.finishReason ? { finishReason: final.finishReason } : {}),
    ...(final.toolCalls && final.toolCalls.length > 0
      ? { toolCalls: Object.freeze([...final.toolCalls]) }
      : {}),
  });
}

function sumUsage(
  usages: readonly (ModelTokenUsage | undefined)[],
): ModelTokenUsage | undefined {
  const present = usages.filter(
    (usage): usage is ModelTokenUsage => usage !== undefined,
  );
  if (present.length === 0) return undefined;
  const sum = (field: keyof ModelTokenUsage): number | undefined => {
    const values = present
      .map((usage) => usage[field])
      .filter((value): value is number => value !== undefined);
    return values.length === 0
      ? undefined
      : values.reduce((total, value) => total + value, 0);
  };
  const promptTokens = sum("promptTokens");
  const completionTokens = sum("completionTokens");
  const reportedTotalTokens = sum("totalTokens");
  const cachedPromptTokens = sum("cachedPromptTokens");
  const cacheMissPromptTokens = sum("cacheMissPromptTokens");
  return Object.freeze({
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(reportedTotalTokens === undefined
      ? promptTokens === undefined && completionTokens === undefined
        ? {}
        : { totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0) }
      : { totalTokens: reportedTotalTokens }),
    ...(cachedPromptTokens === undefined ? {} : { cachedPromptTokens }),
    ...(cacheMissPromptTokens === undefined ? {} : { cacheMissPromptTokens }),
  });
}

function createAttemptStream(
  sink: (event: ModelStreamChunk) => void | Promise<void>,
): {
  readonly onEvent: (event: ModelStreamChunk) => void | Promise<void>;
  readonly flushFinal: (
    completion: ModelCompletionResult,
    includeToolEvents: boolean,
  ) => Promise<void>;
} {
  const pendingToolEvents: ModelStreamChunk[] = [];
  let sawStreamEvent = false;
  return {
    async onEvent(event) {
      sawStreamEvent = true;
      if (event.type === "done") return;
      if (event.type === "tool_use") {
        pendingToolEvents.push(event);
        return;
      }
      await sink(event);
    },
    async flushFinal(completion, includeToolEvents) {
      if (!sawStreamEvent) return;
      if (includeToolEvents) {
        for (const event of pendingToolEvents) await sink(event);
      }
      await sink({
        type: "done",
        ...(completion.usage ? { usage: completion.usage } : {}),
        ...(completion.finishReason
          ? { finishReason: completion.finishReason }
          : {}),
      });
    },
  };
}

export type ModelOutputRecoverySettlementV1 = ModelSettlement<
  ModelCompletionResult,
  NativeToolCall
>;
