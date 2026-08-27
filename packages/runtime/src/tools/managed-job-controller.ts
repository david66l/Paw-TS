import type { ControlReducer, LoopControlState } from "@paw/agent-loop";
import {
  MANAGED_JOB_SCHEMA_V1,
  type ManagedJobReadV1,
  ManagedJobRegistryV1,
  type ManagedJobSnapshotV1,
  type ManagedJobWaitV1,
  type ShellSandboxConfig,
  startManagedShellInWorkspaceV1,
} from "@paw/harness";
import type {
  InputFactV1,
  RuntimeActivitySettledFactV1,
  RuntimeActivityStartedFactV1,
} from "@paw/protocol";

export const MANAGED_JOB_ACTIVITY_KIND_V1 = "managed_job" as const;

export interface RuntimeManagedShellStartV1 {
  readonly jobId: string;
  readonly pid: number;
  readonly cwd: string;
  readonly status: "running";
}

export interface RuntimeActivityProjectionEntryV1 {
  readonly activityId: string;
  readonly activityKind: string;
  readonly label: string;
  readonly startedAt: number;
  readonly metadata?: RuntimeActivityStartedFactV1["metadata"];
  readonly settlement?: RuntimeActivitySettledFactV1;
}

export interface RuntimeActivityProjectionV1 {
  readonly activities: readonly RuntimeActivityProjectionEntryV1[];
  readonly active: readonly RuntimeActivityProjectionEntryV1[];
  readonly latestUnobservedSettlement?: RuntimeActivitySettledFactV1;
}

export interface RuntimeActivityFactRecorderV1 {
  record(facts: readonly InputFactV1[]): Promise<void>;
}

export interface RuntimeManagedJobControllerOptionsV1 {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly shellSandbox?: ShellSandboxConfig;
  readonly maxConcurrentJobs?: number;
  readonly resumeFacts?: readonly InputFactV1[];
  readonly factRecorder?: RuntimeActivityFactRecorderV1;
  /** Fire-and-forget notification after a terminal fact becomes durable. */
  readonly wakeExternal?: () => void;
  readonly clock?: () => number;
}

/** Pure projection shared by recovery, Context and control policy. */
export function projectRuntimeActivitiesV1(
  facts: readonly InputFactV1[],
): RuntimeActivityProjectionV1 {
  const entries = new Map<string, RuntimeActivityProjectionEntryV1>();
  let latestModelDispatchIndex = -1;
  let latestUnobservedSettlement: RuntimeActivitySettledFactV1 | undefined;
  for (const [index, fact] of facts.entries()) {
    if (fact.type === "model.dispatch_recorded") {
      latestModelDispatchIndex = index;
      latestUnobservedSettlement = undefined;
      continue;
    }
    if (fact.type === "runtime.activity_started") {
      entries.set(fact.activityId, {
        activityId: fact.activityId,
        activityKind: fact.activityKind,
        label: fact.label,
        startedAt: fact.startedAt,
        ...(fact.metadata === undefined ? {} : { metadata: fact.metadata }),
      });
      continue;
    }
    if (fact.type === "runtime.activity_settled") {
      const started = entries.get(fact.activityId);
      if (!started) continue;
      entries.set(fact.activityId, { ...started, settlement: fact });
      if (index > latestModelDispatchIndex) latestUnobservedSettlement = fact;
    }
  }
  const activities = Object.freeze([...entries.values()]);
  return Object.freeze({
    activities,
    active: Object.freeze(
      activities.filter((activity) => activity.settlement === undefined),
    ),
    ...(latestUnobservedSettlement === undefined
      ? {}
      : { latestUnobservedSettlement }),
  });
}

/** Runtime-level policy wrapper; the generic Agent Loop remains job-agnostic. */
export function withRuntimeActivityControlV1<
  TRunConfig,
  TState extends LoopControlState,
>(
  base: ControlReducer<InputFactV1, TRunConfig, TState>,
): ControlReducer<InputFactV1, TRunConfig, TState> {
  return {
    reduce(facts, config) {
      const state = base.reduce(facts, config);
      const activities = projectRuntimeActivitiesV1(facts);
      const baseDecision = state.decision;
      if (
        baseDecision.kind === "failed" ||
        baseDecision.kind === "aborted" ||
        baseDecision.kind === "incomplete"
      ) {
        return state;
      }
      const decision = activities.latestUnobservedSettlement
        ? ({ kind: "continue" } as const)
        : activities.active.length > 0 &&
            (baseDecision.kind === "completed" ||
              baseDecision.kind === "await_user")
          ? ({
              kind: "await_external",
              reason: "runtime-activities-pending",
            } as const)
          : baseDecision;
      return decision === baseDecision
        ? state
        : Object.freeze({ ...state, decision });
    },
  };
}

/**
 * Built-in Runtime extension for managed shell jobs. Harness owns processes;
 * this class owns durable activity facts, recovery projection and run cleanup.
 */
export class RuntimeManagedJobControllerV1 {
  private readonly registry: ManagedJobRegistryV1;
  private readonly detachController: () => void;
  private readonly detachDoneListener: () => void;
  private readonly recoveredJobs = new Map<string, ManagedJobSnapshotV1>();
  private readonly recoveredUnsettledIds = new Set<string>();
  private readonly startCommits = new Map<string, Promise<void>>();
  private readonly failedStarts = new Set<string>();
  private readonly backgroundErrors: unknown[] = [];
  private terminalTail: Promise<void> = Promise.resolve();
  private closed = false;
  private recoveryCompleted = false;
  private readonly clock: () => number;

  constructor(private readonly options: RuntimeManagedJobControllerOptionsV1) {
    if (!options.runId.trim()) {
      throw new Error("Runtime managed jobs require runId");
    }
    this.clock = options.clock ?? Date.now;
    const prior = projectRuntimeActivitiesV1(options.resumeFacts ?? []);
    this.registry = new ManagedJobRegistryV1({
      maxConcurrentJobsPerOwner: options.maxConcurrentJobs ?? 4,
      initialKindCounters: { shell: highestShellCounter(prior.activities) },
    });
    this.detachController = this.registry.attachController(options.runId);
    this.detachDoneListener = this.registry.onDone((snapshot) => {
      this.enqueueTerminalCommit(snapshot);
    });
    for (const activity of prior.activities) {
      if (activity.activityKind !== MANAGED_JOB_ACTIVITY_KIND_V1) continue;
      this.recoveredJobs.set(
        activity.activityId,
        recoveredSnapshot(options.runId, activity, this.clock()),
      );
      if (!activity.settlement) {
        this.recoveredUnsettledIds.add(activity.activityId);
      }
    }
  }

  /** Mark pre-crash active jobs unknown; old PIDs are deliberately not reused. */
  async recoverInterrupted(): Promise<void> {
    this.assertOpen();
    if (this.recoveryCompleted) return;
    this.recoveryCompleted = true;
    const unsettled = [...this.recoveredUnsettledIds]
      .map((id) => this.recoveredJobs.get(id))
      .filter((job): job is ManagedJobSnapshotV1 => job !== undefined);
    if (unsettled.length === 0 || !this.options.factRecorder) return;
    await this.options.factRecorder.record(
      unsettled.map(
        (job): RuntimeActivitySettledFactV1 => ({
          type: "runtime.activity_settled",
          activityId: job.id,
          status: "unknown",
          settledAt: job.finishedAt ?? this.clock(),
          summary:
            job.detail ??
            "Paw restarted before the background activity settled",
        }),
      ),
    );
  }

  async startShell(input: {
    readonly command: string;
    readonly cwd?: string;
    readonly outputLimitBytes?: number;
  }): Promise<RuntimeManagedShellStartV1> {
    this.assertOpen();
    let producer: ReturnType<typeof startManagedShellInWorkspaceV1> | undefined;
    const jobId = this.registry.start({
      ownerId: this.options.runId,
      kind: "shell",
      label: activityLabel(input.command),
      ...(input.outputLimitBytes === undefined
        ? {}
        : { outputLimitBytes: input.outputLimitBytes }),
      run: () => {
        producer = startManagedShellInWorkspaceV1(
          this.options.workspaceRoot,
          input.command,
          {
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(this.options.shellSandbox
              ? { shellSandbox: this.options.shellSandbox }
              : {}),
            ...(input.outputLimitBytes === undefined
              ? {}
              : { outputLimitBytes: input.outputLimitBytes }),
            skipApprovalGate: true,
          },
        );
        return producer.hooks;
      },
    });
    if (!producer) throw new Error("Managed shell producer did not start");
    const snapshot = this.registry.get(this.options.runId, jobId);
    const startCommit = this.recordStart(snapshot, producer);
    this.startCommits.set(jobId, startCommit);
    try {
      await startCommit;
    } catch (error) {
      this.failedStarts.add(jobId);
      this.registry.kill(
        this.options.runId,
        jobId,
        "activity start fact failed",
      );
      throw error;
    }
    return Object.freeze({
      jobId,
      pid: producer.pid,
      cwd: producer.cwd,
      status: "running" as const,
    });
  }

  list(): readonly ManagedJobSnapshotV1[] {
    this.assertOpen();
    return Object.freeze([
      ...this.recoveredJobs.values(),
      ...this.registry.list(this.options.runId),
    ]);
  }

  read(id: string): ManagedJobReadV1 {
    this.assertOpen();
    const recovered = this.recoveredJobs.get(id);
    if (recovered) {
      return Object.freeze({
        text:
          recovered.detail ??
          "Recovered managed job metadata; process output is unavailable.",
        snapshot: recovered,
      });
    }
    return this.registry.read(this.options.runId, id);
  }

  wait(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ManagedJobWaitV1> {
    this.assertOpen();
    const recovered = this.recoveredJobs.get(id);
    if (recovered) {
      return Promise.resolve(
        Object.freeze({ timedOut: false, snapshot: recovered }),
      );
    }
    return this.registry.wait(this.options.runId, id, timeoutMs, signal);
  }

  kill(id: string, reason?: string): "requested" | "already_finished" {
    this.assertOpen();
    if (this.recoveredJobs.has(id)) return "already_finished";
    return this.registry.kill(this.options.runId, id, reason);
  }

  async close(timeoutMs = 5_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachController();
    await this.registry.close(timeoutMs);
    await this.terminalTail;
    this.detachDoneListener();
    if (this.backgroundErrors.length > 0) {
      throw new AggregateError(
        this.backgroundErrors,
        "Managed job terminal facts failed to commit",
      );
    }
  }

  private recordStart(
    snapshot: ManagedJobSnapshotV1,
    producer: ReturnType<typeof startManagedShellInWorkspaceV1>,
  ): Promise<void> {
    if (!this.options.factRecorder) return Promise.resolve();
    return this.options.factRecorder.record([
      {
        type: "runtime.activity_started",
        activityId: snapshot.id,
        activityKind: MANAGED_JOB_ACTIVITY_KIND_V1,
        label: snapshot.label,
        startedAt: snapshot.startedAt,
        metadata: { pid: producer.pid, cwd: producer.cwd },
      },
    ]);
  }

  private enqueueTerminalCommit(snapshot: ManagedJobSnapshotV1): void {
    if (!this.options.factRecorder) return;
    this.terminalTail = this.terminalTail
      .then(async () => {
        try {
          await this.startCommits.get(snapshot.id);
        } catch {
          return;
        }
        if (this.failedStarts.has(snapshot.id)) return;
        await this.options.factRecorder?.record([
          {
            type: "runtime.activity_settled",
            activityId: snapshot.id,
            status: activityStatus(snapshot.status),
            settledAt: snapshot.finishedAt ?? this.clock(),
            summary: activitySummary(snapshot),
          },
        ]);
        try {
          this.options.wakeExternal?.();
        } catch {
          // The fact is durable. A closing coordinator may reject a late wake;
          // startup recovery will observe the settlement on the next run.
        }
      })
      .catch((error: unknown) => {
        this.backgroundErrors.push(error);
      });
  }

  private assertOpen(): void {
    if (this.closed)
      throw new Error("Runtime managed job controller is closed");
  }
}

function highestShellCounter(
  activities: readonly RuntimeActivityProjectionEntryV1[],
): number {
  return activities.reduce((highest, activity) => {
    const match = activity.activityId.match(/^shell-(\d+)$/);
    const value = match?.[1] === undefined ? 0 : Number(match[1]);
    return Number.isSafeInteger(value) ? Math.max(highest, value) : highest;
  }, 0);
}

function recoveredSnapshot(
  ownerId: string,
  activity: RuntimeActivityProjectionEntryV1,
  now: number,
): ManagedJobSnapshotV1 {
  const prior = activity.settlement;
  const status = prior
    ? prior.status === "completed"
      ? "completed"
      : prior.status === "cancelled"
        ? "killed"
        : prior.status === "unknown"
          ? "interrupted_orphaned"
          : "failed"
    : "interrupted_orphaned";
  const detail = prior
    ? prior.summary
    : "Paw restarted before this job's terminal effect was durably committed; the old PID was not reattached.";
  return Object.freeze({
    schemaVersion: MANAGED_JOB_SCHEMA_V1,
    id: activity.activityId,
    ownerId,
    kind: "shell",
    label: activity.label,
    status,
    detail,
    startedAt: activity.startedAt,
    finishedAt: prior?.settledAt ?? now,
    reported: false,
  });
}

function activityStatus(
  status: ManagedJobSnapshotV1["status"],
): RuntimeActivitySettledFactV1["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "killed":
      return "cancelled";
    case "failed":
      return "failed";
    case "interrupted_orphaned":
    case "running":
    case "stopping":
      return "unknown";
  }
}

function activitySummary(snapshot: ManagedJobSnapshotV1): string {
  return singleLine(snapshot.detail ?? snapshot.status).slice(0, 8_192);
}

function activityLabel(command: string): string {
  return singleLine(command).slice(0, 200) || "managed shell";
}

function singleLine(value: string): string {
  let result = "";
  let replacingControls = false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const isControl =
      code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
    if (isControl) {
      if (!replacingControls) result += " ";
      replacingControls = true;
      continue;
    }
    replacingControls = false;
    result += character;
  }
  return result.trim();
}
