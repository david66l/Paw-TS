/** A shared deadline for sequential stages, including providers that ignore abort.
 * Call run at each asynchronous boundary so late results cannot start another stage.
 * This bounds host waiting; it cannot guarantee cancellation of remote billing.
 */
export function createOperationDeadline(parent: AbortSignal | undefined, timeoutMs: number) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
    throw new Error("Invalid operation deadline");
  const controller = new AbortController();
  const expires = performance.now() + timeoutMs;
  let timedOut = false;
  let disposed = false;
  const expire = () => {
    if (controller.signal.aborted || disposed) return;
    timedOut = true;
    controller.abort(new DOMException("Operation deadline exceeded", "TimeoutError"));
  };
  const cancel = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  const timer = setTimeout(expire, timeoutMs);
  const check = () => {
    if (disposed) throw new Error("Operation deadline is disposed");
    if (performance.now() >= expires) expire();
    controller.signal.throwIfAborted();
  };
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    async run<T>(execute: (signal: AbortSignal) => T | PromiseLike<T>): Promise<T> {
      check();
      let removeListener = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        const abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
        removeListener = () => controller.signal.removeEventListener("abort", abort);
      });
      try {
        const result = await Promise.race([
          interrupted,
          Promise.resolve().then(() => {
            check();
            return execute(controller.signal);
          }),
        ]);
        check();
        return result;
      } finally {
        removeListener();
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", cancel);
    },
  };
}
