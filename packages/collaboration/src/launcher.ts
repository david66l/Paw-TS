import type {
  SubAgentLaunchOptions,
  SubAgentLauncher,
  SubAgentResult,
} from "@paw/harness";

import {
  type CollaborationPolicyV1,
  DEFAULT_COLLABORATION_POLICY_V1,
  freezeCollaborationPolicyV1,
} from "./policy.js";
import {
  type CollaborationRosterV1,
  DEFAULT_COLLABORATION_ROLE_V1,
  DEFAULT_COLLABORATION_ROSTER_V1,
  collaborationAgentSpecHashV1,
  isCollaborationRoleV1,
  selectCollaborationAgentV1,
} from "./roster.js";

export interface CreateBoundedSubAgentLauncherInputV1 {
  readonly delegate: SubAgentLauncher;
  readonly policy?: CollaborationPolicyV1;
  readonly roster?: CollaborationRosterV1;
}

/**
 * Product-boundary guard for child dispatch. It owns concurrency and output
 * bounds; the injected delegate owns the child engine.
 */
export function createBoundedSubAgentLauncherV1(
  input: CreateBoundedSubAgentLauncherInputV1,
): SubAgentLauncher {
  if (!input.delegate || typeof input.delegate.launch !== "function") {
    throw new TypeError("Collaboration delegate is invalid");
  }
  const policy = freezeCollaborationPolicyV1(
    input.policy ?? DEFAULT_COLLABORATION_POLICY_V1,
  );
  const roster = input.roster ?? DEFAULT_COLLABORATION_ROSTER_V1;
  const slots = new Semaphore(policy.maxConcurrentChildren);

  async function launch(
    goal: string,
    maxSteps?: number,
    options?: SubAgentLaunchOptions,
  ): Promise<SubAgentResult> {
    return slots.run(options?.signal, async () => {
      const bounded = normalizeLaunch(goal, maxSteps, options, policy, roster);
      try {
        return boundResult(
          await input.delegate.launch(
            bounded.goal,
            bounded.maxSteps,
            bounded.options,
          ),
          policy,
        );
      } catch (error) {
        return failed(error, policy);
      }
    });
  }

  return Object.freeze({
    launch,
    async launchStreaming(
      options: Parameters<SubAgentLauncher["launchStreaming"]>[0],
    ) {
      return launch(options.goal, options.maxSteps, {
        args: options.args,
        sharedContext: options.sharedContext,
        signal: options.signal,
        parentRunId: options.parentRunId,
        agentId: options.agentId,
        onEvent: options.onEvent,
        fileLock: options.fileLock,
      });
    },
  });
}

/** @deprecated Use createBoundedSubAgentLauncherV1. */
export const createBoundedReadOnlySubAgentLauncherV1 =
  createBoundedSubAgentLauncherV1;
export type CreateBoundedReadOnlySubAgentLauncherInputV1 =
  CreateBoundedSubAgentLauncherInputV1;

function normalizeLaunch(
  goal: string,
  maxSteps: number | undefined,
  options: SubAgentLaunchOptions | undefined,
  policy: CollaborationPolicyV1,
  roster: CollaborationRosterV1,
): {
  readonly goal: string;
  readonly maxSteps: number;
  readonly options: SubAgentLaunchOptions;
} {
  const normalizedGoal = goal.trim();
  if (!normalizedGoal || normalizedGoal.length > policy.maxGoalChars) {
    throw new Error(
      `Child goal must be between 1 and ${policy.maxGoalChars} characters`,
    );
  }
  const requestedRole = isCollaborationRoleV1(options?.args?.role)
    ? options.args.role
    : DEFAULT_COLLABORATION_ROLE_V1;
  const agent = selectCollaborationAgentV1(roster, {
    agentId: options?.args?.agent_id,
    role: requestedRole,
  });
  const maxForAgent = Math.min(agent.maxSteps, policy.maxChildSteps);
  const steps = maxSteps ?? maxForAgent;
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > maxForAgent) {
    throw new Error(
      `Child maxSteps must be between 1 and ${maxForAgent} for ${agent.id}`,
    );
  }
  return {
    goal: normalizedGoal,
    maxSteps: steps,
    options: Object.freeze({
      ...(options ?? {}),
      args: Object.freeze({
        ...(options?.args ?? {}),
        role: agent.role,
        agent_id: agent.id,
        agent_spec: agent,
        agent_spec_hash: collaborationAgentSpecHashV1(agent),
        roster_hash: roster.rosterHash,
        effect_profile: agent.effect,
        child_policy: agent.childPolicy,
        max_steps: steps,
      }),
    }),
  };
}

function boundResult(
  value: SubAgentResult,
  policy: CollaborationPolicyV1,
): SubAgentResult {
  return Object.freeze({
    status: value.status,
    summary: truncate(value.summary, policy.maxSummaryChars),
    ...(value.childRun
      ? { childRun: Object.freeze({ ...value.childRun }) }
      : {}),
    ...(value.collaborationTask
      ? {
          collaborationTask: Object.freeze({ ...value.collaborationTask }),
        }
      : {}),
    ...(value.findings
      ? {
          findings: Object.freeze(
            value.findings.slice(0, 20).map((item) => truncate(item, 1_000)),
          ),
        }
      : {}),
    ...(value.changedFiles
      ? { changedFiles: Object.freeze(value.changedFiles.slice(0, 100)) }
      : {}),
    ...(value.testsRun
      ? {
          testsRun: Object.freeze(
            value.testsRun
              .slice(0, 50)
              .map((item) => Object.freeze({ ...item })),
          ),
        }
      : {}),
    ...(value.outcome
      ? {
          outcome: Object.freeze({
            ...value.outcome,
            commands: Object.freeze(
              value.outcome.commands
                .slice(0, 50)
                .map((item) => Object.freeze({ ...item })),
            ),
            artifactRefs: Object.freeze(
              value.outcome.artifactRefs.slice(0, 50),
            ),
          }),
        }
      : {}),
    ...(value.errors
      ? {
          errors: Object.freeze(
            value.errors.slice(0, 20).map((item) => truncate(item, 1_000)),
          ),
        }
      : {}),
  });
}

function failed(error: unknown, policy: CollaborationPolicyV1): SubAgentResult {
  const message = truncate(
    error instanceof Error ? error.message : String(error),
    Math.min(policy.maxSummaryChars, 2_000),
  );
  return Object.freeze({
    status: "failed",
    summary: `Delegated child failed: ${message}`,
    errors: Object.freeze([message]),
  });
}

function truncate(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated]`;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    await this.acquire(signal);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) throw abortError(signal);
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(abortError(signal));
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Child dispatch aborted");
}
