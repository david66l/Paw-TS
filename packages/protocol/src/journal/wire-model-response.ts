/** Model request/response wire values. */
import type { DurableJsonPayloadV1, JsonValue } from "./primitives.js";
import type { MODEL_RESPONSE_SCHEMA_VERSION_V1 } from "./versions.js";

export interface ModelResponseUsageV1 {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly cacheMissPromptTokens?: number;
}

export interface ModelResponseToolCallV1 {
  readonly callId: string;
  readonly name: string;
  readonly rawArguments: string;
  readonly args: Readonly<{ readonly [key: string]: JsonValue }>;
  readonly sourceIndex: number;
  readonly argumentsValid: boolean;
}

/** The one provider-neutral, durable successful/truncated model response DTO. */
export interface ModelResponseV1 {
  readonly schemaVersion: typeof MODEL_RESPONSE_SCHEMA_VERSION_V1;
  readonly providerProtocol: "openai-compatible" | "anthropic-compatible";
  /** Exact provider-visible assistant text; it may be empty for tool-only turns. */
  readonly assistantContent: string;
  /** Provider reasoning retained for audit only, never generic request replay. */
  readonly auditThinking?: string;
  /** Exact provider-supported reasoning state eligible for native passback. */
  readonly reasoningPassback?: string;
  readonly finishReason?: string;
  readonly usage?: ModelResponseUsageV1;
  readonly toolCalls: readonly ModelResponseToolCallV1[];
}

export interface InputAttachmentV1 {
  readonly attachmentId: string;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType?: string;
  /** Inline values must be strings; artifact resolvers must produce a string. */
  readonly content: DurableJsonPayloadV1;
}

export type ModelSettlementStatusV1 =
  | "completed"
  | "truncated"
  | "failed"
  | "cancelled"
  | "unknown"
  | "rejected";
