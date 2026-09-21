import type { LanguageModel } from "./language-model.js";
import type { ModelCompleteOptions } from "./model-options.js";
import { emitModelObservation } from "./observation.js";
import type { ChatMessage, ModelStreamChunk } from "./types.js";

export const THINKING_RECOVERY_POLICY = "paw.thinking-recovery.experimental.v3";

export const THINKING_RECOVERY_INSTRUCTION = `Incremental execution mode from the Paw host. An earlier generation was interrupted before producing text or a tool call; no tools from that interrupted generation executed. The original task and every acceptance criterion remain in force. This mode stays active for the remaining task.
Use completed tool results as the current state. In THIS response implement at most ONE function, ONE class method, or ONE focused test, with approximately 60 changed lines or fewer. Issue that tool call before designing subsequent methods. Do not implement an entire module in one response. When starting a missing class file, writing only its imports, constructor and initial state is a valid first step; add methods in subsequent tool calls. Preserve existing behavior while editing. If specific evidence is missing, read it; if the next step is verification, run the relevant check. Do not reopen settled choices or invent unspecified edge cases.
After each tool result, continue with the next small implementation or verification action. These are execution increments, not separate user tasks. Keep going until the ENTIRE original task is implemented and verified; a scaffold, partial module, plan or unexecuted test is never completion.`;

export const THINKING_RECOVERY_BATCH_INSTRUCTION = `Bounded execution mode from the Paw host. An earlier thinking-only generation was interrupted without executing tools. Subsequent file operations have completed, so you can now batch related work to reduce repeated context overhead. The entire original task and all acceptance criteria remain in force.
Choose one coherent implementation or verification slice for THIS response. You may implement several closely related methods, one small module, or a focused group of tests together (approximately 200 changed lines or fewer). Issue tools after deciding that slice; do not mentally implement the entire remaining project first. Use existing implementations and completed tool results, avoid reopening settled choices or adding unspecified requirements, and run relevant checks as functionality becomes executable. Keep going through implementation, integration, tests and documentation until the original task is fully verified. A completed file operation is not proof that its code is correct.`;

function confirmedWrites(messages: readonly ChatMessage[]): number {
  const calls = new Set<string>();
  for (const message of messages) {
    const turn = message.nativeToolTurn;
    if (turn?.schemaVersion !== 2) continue;
    for (const call of turn.calls) {
      if (
        !["workspace_write_file", "workspace_edit_file", "workspace_apply_patch"].includes(
          call.providerName,
        )
      )
        continue;
      const result = turn.results.find((item) => item.callId === call.callId);
      if (result?.status === "completed" && !result.isError) calls.add(call.callId);
    }
  }
  return calls.size;
}

export interface ThinkingRecoveryEvent {
  type: "interrupted" | "retry" | "exhausted";
  reason: "thinking_without_action" | "no_response";
  attempt: number;
  elapsedMs: number;
  recoveriesUsed: number;
  /** Interrupted requests commonly have no provider usage. Never count them as free. */
  usageUnknown: true;
}

export interface ThinkingRecoveryOptions {
  noActionMs: number;
  /** Shared across every main-loop call through this wrapper, not reset per turn. */
  maxRecoveries: number;
  onEvent?: (event: ThinkingRecoveryEvent) => void;
}

/**
 * Opt-in experiment. Instantiate once per run, with an externally bounded run signal.
 * Only streaming calls with tools participate; auxiliary complete() calls are unchanged.
 * Before the first action, chunks are buffered so an interrupted generation cannot
 * contaminate the successful attempt's native reasoning/tool history. This delays
 * the thinking preview, not tool execution. After text/tool fragments start, streaming
 * resumes normally and this guard never retries the request.
 */
export function createThinkingRecoveryModel(
  model: LanguageModel,
  policy: ThinkingRecoveryOptions,
): LanguageModel {
  if (!Number.isSafeInteger(policy.noActionMs) || policy.noActionMs <= 0)
    throw new Error("noActionMs must be a positive safe integer");
  if (!Number.isSafeInteger(policy.maxRecoveries) || policy.maxRecoveries < 0)
    throw new Error("maxRecoveries must be a nonnegative safe integer");
  let recoveriesUsed = 0;
  let writesAtRecovery = 0;
  let terminalError: Error | undefined;
  const stream = model.completeStream?.bind(model);
  const report = (event: ThinkingRecoveryEvent) => {
    try {
      policy.onEvent?.(event);
    } catch {
      /* Diagnostic sinks cannot change execution. */
    }
  };
  return {
    label: model.label,
    capabilities: model.capabilities,
    runtimeProfile: model.runtimeProfile,
    complete: model.complete.bind(model),
    ...(stream
      ? {
          async *completeStream(messages: readonly ChatMessage[], options?: ModelCompleteOptions) {
            options?.signal?.throwIfAborted();
            if (terminalError) throw terminalError;
            if (!options?.tools?.length) {
              yield* stream(messages, options);
              return;
            }
            for (let attempt = 0; ; attempt++) {
              options.signal?.throwIfAborted();
              const local = new AbortController();
              const signal = options.signal
                ? AbortSignal.any([options.signal, local.signal])
                : local.signal;
              const started = Date.now();
              let thinking = false;
              let actionStarted = false;
              let timedOut = false;
              const pending: ModelStreamChunk[] = [];
              const timeoutError = new Error(
                "Paw generation exceeded the experimental no-action deadline",
              );
              const timer = setTimeout(() => {
                if (!actionStarted) {
                  timedOut = true;
                  local.abort(timeoutError);
                }
              }, policy.noActionMs);
              const markAction = () => {
                actionStarted = true;
                clearTimeout(timer);
              };
              try {
                // Tell supervision this retry is a fresh physical request
                // so it does not inherit this attempt's reasoning window.
                emitModelObservation(options, {
                  type: "recovery_attempt",
                  attempt: attempt + 1,
                });
                const requestMessages =
                  recoveriesUsed === 0
                    ? messages
                    : [
                        ...messages,
                        {
                          role: "system" as const,
                          content:
                            confirmedWrites(messages) - writesAtRecovery >= 2
                              ? THINKING_RECOVERY_BATCH_INSTRUCTION
                              : THINKING_RECOVERY_INSTRUCTION,
                        },
                      ];
                for await (const chunk of stream(requestMessages, {
                  ...options,
                  signal,
                  onObservation(event) {
                    if (event.type === "delta" && event.count > 0) {
                      if (event.kind === "tool_fragment" || event.kind === "text") markAction();
                      if (event.kind === "thinking") thinking = true;
                    }
                    emitModelObservation(options, event);
                  },
                })) {
                  signal.throwIfAborted();
                  if (chunk.type === "thinking" && chunk.delta.length) thinking = true;
                  if (chunk.type === "tool_use" || (chunk.type === "text" && chunk.delta.length))
                    markAction();
                  if (actionStarted || chunk.type === "done") {
                    for (const item of pending) yield item;
                    pending.length = 0;
                    yield chunk;
                  } else pending.push(chunk);
                }
                signal.throwIfAborted();
                // Missing done is handled by the existing model adapter; never retry it here.
                for (const item of pending) yield item;
                return;
              } catch (error) {
                options.signal?.throwIfAborted();
                if (!timedOut || actionStarted) throw error;
                const event = {
                  reason: thinking
                    ? ("thinking_without_action" as const)
                    : ("no_response" as const),
                  attempt,
                  elapsedMs: Date.now() - started,
                  recoveriesUsed,
                  usageUnknown: true as const,
                };
                report({ ...event, type: "interrupted" });
                // One recovery per logical call, and a separate total run allowance.
                // No automatic retry for a silent provider/network or a repeated stall.
                if (!thinking || attempt > 0 || recoveriesUsed >= policy.maxRecoveries) {
                  terminalError = new Error(
                    `Paw thinking recovery stopped: ${event.reason}; recovery allowance exhausted or retry ineligible`,
                  );
                  report({ ...event, type: "exhausted" });
                  throw terminalError;
                }
                recoveriesUsed++;
                writesAtRecovery = confirmedWrites(messages);
                report({ ...event, type: "retry", recoveriesUsed });
              } finally {
                clearTimeout(timer);
              }
            }
          },
        }
      : {}),
  };
}
