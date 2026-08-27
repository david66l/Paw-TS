import type { DurableInputInboxV1 } from "./durable-input-inbox.js";

export interface SessionCoordinatorOptionsV1<TResult> {
  /** Diagnostic label only; trusted ownership comes from the Inbox Session. */
  readonly sessionKey: string;
  readonly inbox: DurableInputInboxV1;
  readonly execute: () => Promise<TResult>;
  /** Keeps the coordinator alive until an extension publishes another fact. */
  readonly shouldAwaitExternal?: (result: TResult) => boolean;
  readonly signal?: AbortSignal;
}

/**
 * Coalesces wakeups and guarantees one active executor for a session in this
 * process. Cross-process ownership remains a composition-layer lease concern.
 */
export class SessionCoordinatorV1<TResult> {
  private readonly owner = Symbol("session-coordinator-owner");
  private running: Promise<void> | undefined;
  private wakeRequested = false;
  private externalWakeGeneration = 0;
  private readonly externalWaiters = new Set<() => void>();
  private closed = false;

  constructor(private readonly options: SessionCoordinatorOptionsV1<TResult>) {
    if (!options.sessionKey.trim()) {
      throw new Error("Session coordinator requires a stable session key");
    }
    options.inbox.claimCoordinator(this.owner);
  }

  wake(): Promise<void> {
    this.assertOpen();
    this.wakeRequested = true;
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Wake caused by a durable external fact, not by Inbox admission. */
  wakeExternal(): Promise<void> {
    this.assertOpen();
    this.externalWakeGeneration += 1;
    for (const waiter of [...this.externalWaiters]) waiter();
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.externalWaiters]) waiter();
    try {
      await this.running;
    } finally {
      this.options.inbox.releaseCoordinator(this.owner);
    }
  }

  private async drain(): Promise<void> {
    while (true) {
      if (this.closed) return;
      this.wakeRequested = false;
      const externalBefore = this.externalWakeGeneration;
      const before = await this.options.inbox.inspect();
      await this.options.inbox.prepareIdleExecution();
      const result = await this.options.execute();
      if (this.options.shouldAwaitExternal?.(result)) {
        if (this.externalWakeGeneration === externalBefore) {
          await this.waitForExternalWake();
        }
        continue;
      }
      const after = await this.options.inbox.inspect();
      if (
        pendingCount(after) > 0 &&
        pendingFingerprint(after) !== pendingFingerprint(before)
      ) {
        continue;
      }
      if (this.wakeRequested) {
        const latest = await this.options.inbox.inspect();
        if (
          pendingCount(latest) > 0 &&
          pendingFingerprint(latest) !== pendingFingerprint(after)
        ) {
          continue;
        }
      }
      return;
    }
  }

  private async waitForExternalWake(): Promise<void> {
    if (this.closed) return;
    const signal = this.options.signal;
    if (signal?.aborted) throw abortError(signal);
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        this.externalWaiters.delete(finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      this.externalWaiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
    if (signal?.aborted) throw abortError(signal);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Paw Next session coordinator is closed");
    }
  }
}

function abortError(signal: AbortSignal): Error {
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "external wait aborted",
  );
  error.name = "AbortError";
  return error;
}

function pendingCount(state: {
  readonly pendingSteerIds: readonly string[];
  readonly pendingQueueIds: readonly string[];
}): number {
  return state.pendingSteerIds.length + state.pendingQueueIds.length;
}

function pendingFingerprint(state: {
  readonly pendingSteerIds: readonly string[];
  readonly pendingQueueIds: readonly string[];
}): string {
  return JSON.stringify([state.pendingSteerIds, state.pendingQueueIds]);
}
