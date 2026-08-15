export const MANAGED_JOB_SCHEMA_V1 = "paw.managed-job.v1" as const;

export type ManagedJobStatusV1 =
  | "running"
  | "stopping"
  | "completed"
  | "killed"
  | "failed";

export interface ManagedJobOutcomeV1 {
  readonly status: "completed" | "killed" | "failed";
  readonly detail?: string;
  readonly output?: string;
}

export interface ManagedJobHooksV1 {
  readonly cancel: (reason?: string) => void;
  readonly done: Promise<ManagedJobOutcomeV1>;
  /** One consuming cursor owned by the producer. */
  readonly readOutput?: () => string;
}

export interface ManagedJobStartV1 {
  readonly ownerId: string;
  readonly kind: string;
  readonly label: string;
  readonly outputLimitBytes?: number;
  /** Called only after every host-side preflight succeeds. */
  readonly run: () => ManagedJobHooksV1;
}

export interface ManagedJobSnapshotV1 {
  readonly schemaVersion: typeof MANAGED_JOB_SCHEMA_V1;
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly label: string;
  readonly outputLimitBytes?: number;
  readonly status: ManagedJobStatusV1;
  readonly detail?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly reported: boolean;
}

export interface ManagedJobReadV1 {
  readonly text: string;
  readonly snapshot: ManagedJobSnapshotV1;
}

export interface ManagedJobWaitV1 {
  readonly timedOut: boolean;
  readonly snapshot: ManagedJobSnapshotV1;
}

type DoneListenerV1 = (
  snapshot: ManagedJobSnapshotV1,
) => void | PromiseLike<void>;

interface TrackedJobV1 {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly label: string;
  readonly outputLimitBytes?: number;
  readonly cancel: (reason?: string) => void;
  readonly done: Promise<ManagedJobOutcomeV1>;
  readonly readOutput?: () => string;
  status: ManagedJobStatusV1;
  detail?: string;
  output?: string;
  readonly startedAt: number;
  finishedAt?: number;
  reported: boolean;
  readonly waiters: Set<() => void>;
}

function isTerminal(status: ManagedJobStatusV1): boolean {
  return status === "completed" || status === "killed" || status === "failed";
}

function assertNonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must be a non-empty string`);
}

export class ManagedJobRegistryV1 {
  private readonly maxConcurrentJobsPerOwner: number;
  private readonly jobs = new Map<string, TrackedJobV1>();
  private readonly counters = new Map<string, number>();
  private readonly controllers = new Map<string, number>();
  private readonly listeners = new Set<DoneListenerV1>();
  private closed = false;

  constructor(options?: { readonly maxConcurrentJobsPerOwner?: number }) {
    const limit = options?.maxConcurrentJobsPerOwner ?? 4;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("maxConcurrentJobsPerOwner must be a positive integer");
    }
    this.maxConcurrentJobsPerOwner = limit;
  }

  attachController(ownerId: string): () => void {
    this.assertOpen();
    assertNonEmpty("ownerId", ownerId);
    this.controllers.set(ownerId, (this.controllers.get(ownerId) ?? 0) + 1);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      const next = (this.controllers.get(ownerId) ?? 1) - 1;
      if (next <= 0) this.controllers.delete(ownerId);
      else this.controllers.set(ownerId, next);
    };
  }

  start(spec: ManagedJobStartV1): string {
    this.assertOpen();
    assertNonEmpty("ownerId", spec.ownerId);
    assertNonEmpty("kind", spec.kind);
    assertNonEmpty("label", spec.label);
    if ((this.controllers.get(spec.ownerId) ?? 0) <= 0) {
      throw new Error(
        `background jobs unavailable for owner ${spec.ownerId}: no controller attached`,
      );
    }
    if (
      spec.outputLimitBytes !== undefined &&
      (!Number.isSafeInteger(spec.outputLimitBytes) ||
        spec.outputLimitBytes <= 0)
    ) {
      throw new Error("outputLimitBytes must be a positive integer");
    }
    const active = [...this.jobs.values()].filter(
      (job) =>
        job.ownerId === spec.ownerId &&
        (job.status === "running" || job.status === "stopping"),
    ).length;
    if (active >= this.maxConcurrentJobsPerOwner) {
      throw new Error(
        `background job limit reached for owner ${spec.ownerId} (limit: ${this.maxConcurrentJobsPerOwner})`,
      );
    }

    // A throwing starter leaves no registry record and consumes no id.
    const hooks = spec.run();
    if (typeof hooks.cancel !== "function" || !hooks.done) {
      throw new Error("job starter returned invalid hooks");
    }
    const count = (this.counters.get(spec.kind) ?? 0) + 1;
    const id = `${spec.kind}-${count}`;
    this.counters.set(spec.kind, count);
    const job: TrackedJobV1 = {
      id,
      ownerId: spec.ownerId,
      kind: spec.kind,
      label: spec.label,
      ...(spec.outputLimitBytes !== undefined
        ? { outputLimitBytes: spec.outputLimitBytes }
        : {}),
      cancel: hooks.cancel,
      done: hooks.done,
      ...(hooks.readOutput ? { readOutput: hooks.readOutput } : {}),
      status: "running",
      startedAt: Date.now(),
      reported: false,
      waiters: new Set(),
    };
    this.jobs.set(id, job);
    void hooks.done.then(
      (outcome) => this.settle(job, outcome),
      (error: unknown) =>
        this.settle(job, {
          status: "failed",
          detail: `producer done rejected: ${String(error)}`,
        }),
    );
    return id;
  }

  list(ownerId: string): readonly ManagedJobSnapshotV1[] {
    return Object.freeze(
      [...this.jobs.values()]
        .filter((job) => job.ownerId === ownerId)
        .map((job) => this.snapshot(job)),
    );
  }

  get(ownerId: string, id: string): ManagedJobSnapshotV1 {
    return this.snapshot(this.expectOwned(ownerId, id));
  }

  read(ownerId: string, id: string): ManagedJobReadV1 {
    const job = this.expectOwned(ownerId, id);
    const text = job.readOutput
      ? job.readOutput()
      : isTerminal(job.status)
        ? (job.output ?? "")
        : "";
    if (isTerminal(job.status)) job.reported = true;
    return Object.freeze({ text, snapshot: this.snapshot(job) });
  }

  kill(
    ownerId: string,
    id: string,
    reason?: string,
  ): "requested" | "already_finished" {
    const job = this.expectOwned(ownerId, id);
    if (isTerminal(job.status)) {
      job.reported = true;
      return "already_finished";
    }
    // Cancellation is requested first. A throw cannot forge a stopping state.
    job.cancel(reason);
    if (!isTerminal(job.status)) job.status = "stopping";
    job.reported = true;
    return "requested";
  }

  async wait(
    ownerId: string,
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ManagedJobWaitV1> {
    const job = this.expectOwned(ownerId, id);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive number");
    }
    if (isTerminal(job.status)) {
      job.reported = true;
      return Object.freeze({ timedOut: false, snapshot: this.snapshot(job) });
    }
    if (signal?.aborted) throw new Error("wait aborted");

    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const timedOut = await new Promise<boolean>((resolve, reject) => {
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        job.waiters.delete(onJobSettled);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const onJobSettled = (): void => finish(false);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        job.waiters.delete(onJobSettled);
        reject(new Error("wait aborted"));
      };
      job.waiters.add(onJobSettled);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => finish(true), timeoutMs);
    });
    if (isTerminal(job.status)) job.reported = true;
    return Object.freeze({ timedOut, snapshot: this.snapshot(job) });
  }

  onDone(listener: DoneListenerV1): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async disposeOwner(ownerId: string, timeoutMs = 5_000): Promise<void> {
    const owned = [...this.jobs.values()].filter(
      (job) => job.ownerId === ownerId,
    );
    for (const job of owned) this.cancelForTeardown(job, "owner disposed");
    await Promise.all(
      owned.map(async (job) => {
        if (isTerminal(job.status)) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          job.done.catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (!isTerminal(job.status)) {
          this.settle(job, {
            status: "failed",
            detail: "teardown timed out; work may be orphaned",
          });
        }
      }),
    );
    for (const job of owned) this.jobs.delete(job.id);
    this.controllers.delete(ownerId);
  }

  async close(timeoutMs = 5_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const owners = [
      ...new Set([...this.jobs.values()].map((job) => job.ownerId)),
    ];
    for (const ownerId of owners) await this.disposeOwner(ownerId, timeoutMs);
    this.listeners.clear();
    this.controllers.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("managed job registry is closed");
  }

  private expectOwned(ownerId: string, id: string): TrackedJobV1 {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    if (job.ownerId !== ownerId) {
      throw new Error(`job ${id} belongs to another owner`);
    }
    return job;
  }

  private snapshot(job: TrackedJobV1): ManagedJobSnapshotV1 {
    return Object.freeze({
      schemaVersion: MANAGED_JOB_SCHEMA_V1,
      id: job.id,
      ownerId: job.ownerId,
      kind: job.kind,
      label: job.label,
      ...(job.outputLimitBytes !== undefined
        ? { outputLimitBytes: job.outputLimitBytes }
        : {}),
      status: job.status,
      ...(job.detail !== undefined ? { detail: job.detail } : {}),
      startedAt: job.startedAt,
      ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      reported: job.reported,
    });
  }

  private settle(job: TrackedJobV1, outcome: ManagedJobOutcomeV1): void {
    if (isTerminal(job.status)) return;
    job.status = outcome.status;
    job.detail = outcome.detail;
    job.output = outcome.output;
    job.finishedAt = Date.now();
    if (job.waiters.size > 0) job.reported = true;
    const waiters = [...job.waiters];
    job.waiters.clear();
    for (const waiter of waiters) waiter();
    const snapshot = this.snapshot(job);
    // Completion is announced last; listener failures are contained.
    for (const listener of this.listeners) {
      try {
        void Promise.resolve(listener(snapshot)).catch(() => {});
      } catch {
        // Listener failure cannot roll back a committed terminal state.
      }
    }
  }

  private cancelForTeardown(job: TrackedJobV1, reason: string): void {
    if (isTerminal(job.status)) return;
    job.reported = true;
    try {
      job.cancel(reason);
      if (!isTerminal(job.status)) job.status = "stopping";
    } catch (error) {
      this.settle(job, {
        status: "failed",
        detail: `cancel threw during teardown; work may be orphaned: ${String(error)}`,
      });
    }
  }
}
