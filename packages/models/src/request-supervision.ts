import type { ModelObservationEvent } from "./observation.js";

/** Host wall-clock limits, independent of model effort and output-token limits. */
export const MODEL_REQUEST_SUPERVISION_V1 = Object.freeze({
  policyVersion:
    "paw.model-request-supervision.v1:idle90000:reasoning600000:wall900000:no-retry",
  idleMs: 90_000,
  // The workflow benchmark still received active reasoning at the former 360 s
  // cutoff. Allow a longer bounded generation, then leave time for tool output.
  // Idle detection and parent cancellation continue to apply independently.
  reasoningOnlyMs: 600_000,
  wallMs: 900_000,
});
export interface RequestSupervisionLimits {
  readonly idleMs: number;
  readonly reasoningOnlyMs: number;
  readonly wallMs: number;
}

/** No replay and no partial tool execution. The caller journals the unknown settlement. */
export function superviseModelRequest(
  parent: AbortSignal,
  limits: RequestSupervisionLimits,
) {
  for (const value of [limits.idleMs, limits.reasoningOnlyMs, limits.wallMs]) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("Invalid model supervision limit");
  }
  const controller = new AbortController();
  let started = performance.now();
  let lastActivity = started;
  let thinking = false;
  let action = false;
  let closed = false;
  const stop = (code: string) =>
    controller.abort(
      new Error(
        `${code}; response usage unknown; no tools from this request executed`,
      ),
    );
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = setInterval(
    () => {
      const now = performance.now();
      if (now - started >= limits.wallMs) stop("ModelRequestWallTimeout");
      else if (now - lastActivity >= limits.idleMs)
        stop("ModelRequestIdleTimeout");
      else if (thinking && !action && now - started >= limits.reasoningOnlyMs)
        stop("ModelReasoningWithoutActionTimeout");
    },
    Math.max(
      1,
      Math.min(
        1000,
        limits.idleMs / 4,
        limits.reasoningOnlyMs / 4,
        limits.wallMs / 4,
      ),
    ),
  );
  // A hard race also settles a provider that ignores AbortSignal. Its eventual
  // result is discarded; do not wait on generator.return(), which may also hang.
  let removeRaceListener = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    const fail = () => reject(controller.signal.reason);
    removeRaceListener = () =>
      controller.signal.removeEventListener("abort", fail);
    controller.signal.addEventListener("abort", fail, { once: true });
    if (controller.signal.aborted) fail();
  });
  return {
    signal: controller.signal,
    event(event: ModelObservationEvent) {
      if (closed || controller.signal.aborted) return;
      if (event.type === "recovery_attempt") {
        // A rescue retry is a fresh physical generation: give it a fresh
        // reasoning-only window. The absolute wall clock is NOT reset — the
        // logical call stays bounded by wallMs overall.
        started = performance.now();
        lastActivity = started;
        return;
      }
      if (
        (event.type === "bytes" && event.count > 0) ||
        event.type === "headers" ||
        event.type === "tool_assembled"
      )
        lastActivity = performance.now();
      if (event.type === "delta" && event.count > 0) {
        lastActivity = performance.now();
        if (event.kind === "thinking") thinking = true;
        else action = true;
      }
      if (event.type === "tool_assembled") action = true;
    },
    async run<T>(execute: () => Promise<T>): Promise<T> {
      try {
        controller.signal.throwIfAborted();
        return await Promise.race([
          Promise.resolve().then(execute),
          interrupted,
        ]);
      } finally {
        closed = true;
        clearInterval(timer);
        parent.removeEventListener("abort", abort);
        removeRaceListener();
      }
    },
  };
}
