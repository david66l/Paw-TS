/** Optional automatic context enrichment cannot hold the coding loop indefinitely. */
export const MEMORY_CONTEXT_DEADLINE_MS = 2_000;
export async function withMemoryDeadline<T>(
  parent: AbortSignal,
  execute: (signal: AbortSignal) => Promise<T>,
  timeoutMs = MEMORY_CONTEXT_DEADLINE_MS,
): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      abort.abort(parent.reason);
      reject(parent.reason);
    };
    parent.addEventListener("abort", cancel, { once: true });
    if (parent.aborted) {
      cancel();
      return;
    }
    timer = setTimeout(() => {
      const error = new Error("Optional memory context deadline exceeded");
      error.name = "MemoryContextTimeout";
      abort.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      deadline,
      Promise.resolve().then(() => {
        abort.signal.throwIfAborted();
        return execute(abort.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
  }
}
