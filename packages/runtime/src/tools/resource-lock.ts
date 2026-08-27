import type { ToolClassificationV1 } from "./registry.js";

export interface ToolResourceLeaseV1 {
  release(): void;
}

interface ActiveLeaseV1 {
  readonly id: number;
  readonly classification: ToolClassificationV1;
}

interface WaitingLeaseV1 {
  readonly id: number;
  readonly classification: ToolClassificationV1;
  readonly signal: AbortSignal;
  readonly resolve: (lease: ToolResourceLeaseV1) => void;
  readonly reject: (error: Error) => void;
  onAbort?: () => void;
}

/** 进程内跨 Session 共享的资源锁；调用方仍必须在 finally 中释放。 */
export class ToolResourceLockV1 {
  private nextId = 1;
  private readonly active = new Map<number, ActiveLeaseV1>();
  private readonly waiting: WaitingLeaseV1[] = [];

  acquire(
    classification: ToolClassificationV1,
    signal: AbortSignal,
  ): Promise<ToolResourceLeaseV1> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter: WaitingLeaseV1 = {
        id: this.nextId++,
        classification,
        signal,
        resolve,
        reject,
      };
      waiter.onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(abortError());
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    const blockedDomains = new Set<string>();
    for (let index = 0; index < this.waiting.length; ) {
      const waiter = this.waiting[index];
      if (!waiter) break;
      if (waiter.signal.aborted) {
        this.waiting.splice(index, 1);
        continue;
      }
      if (blockedDomains.has(waiter.classification.lockDomain)) {
        index += 1;
        continue;
      }
      if (
        [...this.active.values()].some((lease) =>
          conflicts(lease.classification, waiter.classification),
        )
      ) {
        // FIFO is scoped to one canonical workspace. A blocked request prevents
        // later calls in that workspace from passing, but must not stall others.
        blockedDomains.add(waiter.classification.lockDomain);
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      if (waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.active.set(waiter.id, {
        id: waiter.id,
        classification: waiter.classification,
      });
      let released = false;
      waiter.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.active.delete(waiter.id);
          this.drain();
        },
      });
      if (waiter.classification.concurrencyMode === "exclusive") {
        blockedDomains.add(waiter.classification.lockDomain);
      }
    }
  }
}

export const GLOBAL_TOOL_RESOURCE_LOCK_V1 = new ToolResourceLockV1();

function conflicts(
  left: ToolClassificationV1,
  right: ToolClassificationV1,
): boolean {
  if (left.lockDomain !== right.lockDomain) return false;
  if (
    left.concurrencyMode === "exclusive" ||
    right.concurrencyMode === "exclusive"
  ) {
    return true;
  }
  return left.resources.some((a) =>
    right.resources.some(
      (b) =>
        overlaps(a.key, b.key) &&
        (a.access === "write" || b.access === "write"),
    ),
  );
}

function overlaps(left: string, right: string): boolean {
  const leftWildcard = left.endsWith("*");
  const rightWildcard = right.endsWith("*");
  if (leftWildcard && right.startsWith(left.slice(0, -1))) return true;
  if (rightWildcard && left.startsWith(right.slice(0, -1))) return true;
  return left === right;
}

function abortError(): Error {
  const error = new Error("Tool resource lock acquisition was cancelled");
  error.name = "AbortError";
  return error;
}
