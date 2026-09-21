import { AsyncLocalStorage } from "node:async_hooks";
import type { LanguageModel } from "./language-model.js";
import type { ModelCompleteOptions } from "./model-options.js";
import type { ModelCompletionResult, ModelStreamChunk } from "./types.js";

/** Metadata only: never pass messages, headers, URLs, arguments or error text. */
export type ModelObservationEvent =
  | {
      type: "request";
      maxOutputTokens?: number;
      reasoningEffort?: string;
      streaming: boolean;
    }
  | { type: "headers"; status: number }
  | { type: "bytes"; count: number }
  | {
      type: "delta";
      kind: "text" | "thinking" | "tool_fragment";
      count: number;
    }
  | { type: "tool_assembled" }
  /**
   * A rescue layer is retrying the logical call as a fresh physical request
   * (e.g. thinking-recovery after a thinking-only stall). Supervision must
   * reset its reasoning-only window instead of letting the retry inherit the
   * time the stalled attempt already consumed.
   */
  | { type: "recovery_attempt"; attempt: number }
  | {
      type: "failure";
      kind:
        | "cancelled"
        | "http"
        | "network"
        | "parse"
        | "stream_incomplete"
        | "unknown";
    }
  | {
      type: "result";
      usage?: ModelCompletionResult["usage"];
      finishReason?: string;
      toolCalls?: number;
    };

export interface ModelObservation {
  event(event: ModelObservationEvent): void;
  end(status: "completed" | "failed" | "cancelled" | "interrupted"): void;
}
export interface ModelObserver {
  start(input: {
    model: string;
    protocol?: string;
    runId?: string;
    phase?: string;
  }): ModelObservation | undefined;
}
type Scope = { observer: ModelObserver; runId?: string; phase?: string };
const scope = new AsyncLocalStorage<Scope>();

export function withModelObserver<T>(
  observer: ModelObserver,
  action: () => T,
): T {
  return scope.run({ observer }, action);
}

/** Identity is observation-only and never changes a canonical model request. */
export function withModelObservationScope<T>(
  runId: string,
  phase: string,
  action: () => T,
): T {
  const current = scope.getStore();
  return current ? scope.run({ ...current, runId, phase }, action) : action();
}

export function emitModelObservation(
  options: ModelCompleteOptions | undefined,
  event: ModelObservationEvent,
): void {
  try {
    options?.onObservation?.(event);
  } catch {
    /* Monitoring cannot affect inference. */
  }
}

function begin(model: LanguageModel): ModelObservation | undefined {
  const current = scope.getStore();
  try {
    return current?.observer.start({
      model: model.runtimeProfile?.model ?? model.label,
      protocol: model.runtimeProfile?.protocol,
      runId: current.runId,
      phase: current.phase,
    });
  } catch {
    return undefined;
  }
}

function observedOptions(
  options: ModelCompleteOptions | undefined,
  observation: ModelObservation,
): ModelCompleteOptions {
  return {
    ...options,
    onObservation(event) {
      try {
        observation.event(event);
      } catch {
        /* Best effort. */
      }
      emitModelObservation(options, event);
    },
  };
}
function end(
  observation: ModelObservation,
  status: Parameters<ModelObservation["end"]>[0],
): void {
  try {
    observation.end(status);
  } catch {
    /* Best effort. */
  }
}

function failureKind(
  error: unknown,
  cancelled: boolean,
): Extract<ModelObservationEvent, { type: "failure" }>["kind"] {
  if (cancelled) return "cancelled";
  if (!(error instanceof Error)) return "unknown";
  // Classify locally; the exception text/stack/cause never reaches the observer.
  if (/HTTP \d{3}/.test(error.message)) return "http";
  if (/without .*?(marker|reason)|missing response body/.test(error.message))
    return "stream_incomplete";
  if (
    /JSON|conflicting|duplicate|orphan|invalid.*(stream|tool)/i.test(
      error.message,
    )
  )
    return "parse";
  if (error instanceof TypeError || error.name === "TimeoutError")
    return "network";
  return "unknown";
}

export async function observeModelComplete(
  model: LanguageModel,
  options: ModelCompleteOptions | undefined,
  execute: (options?: ModelCompleteOptions) => Promise<ModelCompletionResult>,
): Promise<ModelCompletionResult> {
  const observation = begin(model);
  if (!observation) return execute(options);
  const observed = observedOptions(options, observation);
  try {
    const result = await execute(observed);
    emitModelObservation(observed, {
      type: "result",
      usage: result.usage,
      finishReason: result.finishReason,
      toolCalls: result.toolCalls?.length ?? 0,
    });
    end(observation, "completed");
    return result;
  } catch (error) {
    emitModelObservation(observed, {
      type: "failure",
      kind: failureKind(error, options?.signal?.aborted === true),
    });
    end(observation, options?.signal?.aborted ? "cancelled" : "failed");
    throw error;
  }
}

export async function* observeModelStream(
  model: LanguageModel,
  options: ModelCompleteOptions | undefined,
  execute: (options?: ModelCompleteOptions) => AsyncIterable<ModelStreamChunk>,
): AsyncIterable<ModelStreamChunk> {
  const observation = begin(model);
  if (!observation) {
    yield* execute(options);
    return;
  }
  const observed = observedOptions(options, observation);
  let status: Parameters<ModelObservation["end"]>[0] = "interrupted";
  try {
    for await (const chunk of execute(observed)) {
      if (chunk.type === "done") {
        emitModelObservation(observed, {
          type: "result",
          usage: chunk.usage,
          finishReason: chunk.finishReason,
        });
        status = "completed";
      }
      yield chunk;
    }
  } catch (error) {
    emitModelObservation(observed, {
      type: "failure",
      kind: failureKind(error, options?.signal?.aborted === true),
    });
    status = options?.signal?.aborted ? "cancelled" : "failed";
    throw error;
  } finally {
    end(observation, options?.signal?.aborted ? "cancelled" : status);
  }
}

/** Observe the existing fetch; do not clone/read the body or install a global fetch patch. */
export async function observedModelFetch(
  url: string,
  init: RequestInit,
  options: ModelCompleteOptions | undefined,
  request: Extract<ModelObservationEvent, { type: "request" }>,
): Promise<Response> {
  emitModelObservation(options, request);
  const response = await fetch(url, init);
  emitModelObservation(options, { type: "headers", status: response.status });
  return response;
}
