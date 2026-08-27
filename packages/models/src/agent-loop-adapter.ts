import type { Model, ModelSettlement } from "@paw/agent-loop";
import {
  type ModelRequestV1,
  materializeModelRequestMessagesV1,
} from "@paw/core";
import {
  type JsonValue,
  MODEL_RESPONSE_SCHEMA_VERSION_V1,
  type ModelResponseV1,
  parseModelResponseV1,
} from "@paw/protocol";
import type { LanguageModel } from "./language-model.js";
import type { ModelCompleteOptions } from "./model-options.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
  NativeToolCall,
} from "./types.js";

/** 一次 Agent Loop 模型调用所需的既有 Paw 模型输入。 */
export type PawModelRequest = ModelRequestV1;

/** 每个 run 冻结一种传输方式，避免按模型名称在内循环中猜测。 */
export type PawModelTransport = "complete" | "stream";

export type PawProviderProtocol = ModelResponseV1["providerProtocol"];

export type PawAgentLoopModel = Model<
  PawModelRequest,
  ModelStreamChunk,
  ModelSettlement<ModelCompletionResult, NativeToolCall>
>;

/**
 * 把现有 LanguageModel 接到 Paw Next 的模型端口。
 *
 * 这里不解析供应商 JSON/SSE、不决定终局，也不做 stream→complete 重试。
 * 流事件只实时转发；最终必须汇总为一个完整结算。
 */
export function createAgentLoopModelAdapter(
  model: LanguageModel,
  transport: PawModelTransport,
): PawAgentLoopModel {
  return {
    async execute(request, callOptions) {
      if (callOptions.signal.aborted) {
        return cancelledSettlement(callOptions.signal);
      }

      const options: ModelCompleteOptions = {
        ...request.options,
        signal: callOptions.signal,
      };
      try {
        const messages = materializeModelRequestMessagesV1(request);
        const completion = normalizeCompletion(
          transport === "complete"
            ? await model.complete(messages, options)
            : await collectStreamCompletion(
                model,
                messages,
                options,
                callOptions.onStreamEvent,
              ),
        );
        if (isTruncated(completion.finishReason)) {
          return {
            status: "truncated",
            message: completion,
            toolCalls: completion.toolCalls ?? [],
            reason: `Model output ended with ${completion.finishReason}`,
            finishReason: completion.finishReason as "length" | "max_tokens",
          };
        }
        return {
          status: "success",
          message: completion,
          toolCalls: completion.toolCalls ?? [],
        };
      } catch (error) {
        if (callOptions.signal.aborted) {
          return cancelledSettlement(callOptions.signal);
        }
        return {
          status: "unknown",
          reason: `Model result was not proven: ${describeError(error)}`,
        };
      }
    },
  };
}

/**
 * Convert the in-process model result into the one durable Protocol DTO.
 *
 * Raw provider arguments are mandatory here: recreating them from parsed JSON
 * would change replay bytes and can hide a provider/parser mismatch.
 */
export function toDurableModelResponseV1(
  completion: ModelCompletionResult,
  providerProtocol: PawProviderProtocol,
): ModelResponseV1 {
  const toolCalls = (completion.toolCalls ?? []).map((call, sourceIndex) => {
    if (call.sourceIndex !== sourceIndex) {
      throw new Error("Model tool call sourceIndex must be contiguous");
    }
    if (typeof call.rawArguments !== "string") {
      throw new Error(`Model tool call ${call.id} is missing rawArguments`);
    }
    if (typeof call.argumentsValid !== "boolean") {
      throw new Error(
        `Model tool call ${call.id} is missing argumentsValid evidence`,
      );
    }
    return {
      callId: call.id,
      name: call.name,
      rawArguments: call.rawArguments,
      args: jsonObject(call.arguments, `toolCalls[${sourceIndex}].arguments`),
      sourceIndex,
      argumentsValid: call.argumentsValid,
    };
  });
  return parseModelResponseV1({
    schemaVersion: MODEL_RESPONSE_SCHEMA_VERSION_V1,
    providerProtocol,
    assistantContent: completion.nativeAssistantContent ?? completion.text,
    ...(completion.thinking ? { auditThinking: completion.thinking } : {}),
    ...(completion.reasoningPassback
      ? { reasoningPassback: completion.reasoningPassback }
      : {}),
    ...(completion.finishReason
      ? { finishReason: completion.finishReason }
      : {}),
    ...(completion.usage ? { usage: { ...completion.usage } } : {}),
    toolCalls,
  });
}

function normalizeCompletion(
  completion: ModelCompletionResult,
): ModelCompletionResult {
  return completion.nativeAssistantContent === undefined
    ? completion
    : { ...completion, text: completion.nativeAssistantContent };
}

async function collectStreamCompletion(
  model: LanguageModel,
  messages: readonly ChatMessage[],
  options: ModelCompleteOptions,
  onStreamEvent: (event: ModelStreamChunk) => void | Promise<void>,
): Promise<ModelCompletionResult> {
  const stream = model.completeStream;
  if (!stream) {
    throw new Error("Configured stream transport is unavailable");
  }

  let text = "";
  let thinking = "";
  let reasoningPassback = "";
  let finishReason: string | undefined;
  let usage: ModelCompletionResult["usage"];
  let sawDone = false;
  const toolCalls: NativeToolCall[] = [];

  for await (const chunk of stream.call(model, messages, options)) {
    if (sawDone)
      throw new Error("Model stream emitted data after its done chunk");
    await onStreamEvent(chunk);
    switch (chunk.type) {
      case "text":
        text += chunk.delta;
        break;
      case "thinking":
        thinking += chunk.delta;
        break;
      case "reasoning_passback":
        reasoningPassback += chunk.delta;
        break;
      case "tool_use":
        toolCalls.push(streamToolCall(chunk, toolCalls.length));
        break;
      case "done":
        if (sawDone)
          throw new Error("Model stream emitted more than one done chunk");
        sawDone = true;
        usage = chunk.usage;
        finishReason = chunk.finishReason;
        break;
    }
  }

  if (!sawDone) throw new Error("Model stream ended without a done chunk");

  return {
    text,
    nativeAssistantContent: text,
    ...(thinking ? { thinking } : {}),
    ...(reasoningPassback ? { reasoningPassback } : {}),
    ...(usage ? { usage } : {}),
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function streamToolCall(
  chunk: Extract<ModelStreamChunk, { type: "tool_use" }>,
  fallbackSourceIndex: number,
): NativeToolCall {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(chunk.input);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // Preserve the raw payload and mark it invalid; never substitute executable {}.
  }
  return {
    id: chunk.id,
    name: chunk.name,
    arguments: parsed ?? {},
    rawArguments: chunk.input,
    sourceIndex: chunk.sourceIndex ?? fallbackSourceIndex,
    argumentsValid: parsed !== undefined,
  };
}

function cancelledSettlement(signal: AbortSignal) {
  return {
    status: "cancelled" as const,
    reason:
      typeof signal.reason === "string" && signal.reason.trim()
        ? signal.reason
        : "Model call was cancelled",
  };
}

function isTruncated(reason: string | undefined): boolean {
  return reason === "length" || reason === "max_tokens";
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function jsonObject(
  value: Record<string, unknown>,
  field: string,
): Readonly<{ readonly [key: string]: JsonValue }> {
  const normalized = jsonValue(value, field, new Set());
  if (normalized === null || Array.isArray(normalized)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return normalized as Readonly<{ readonly [key: string]: JsonValue }>;
}

function jsonValue(
  value: unknown,
  field: string,
  seen: Set<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must be valid JSON`);
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${field} must be JSON-serializable`);
  }
  if (seen.has(value)) throw new Error(`${field} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        jsonValue(item, `${field}[${index}]`, seen),
      );
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = jsonValue(item, `${field}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
