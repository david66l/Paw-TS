import { createHash } from "node:crypto";

import type { SubAgentLauncher, SubAgentResult } from "@paw/harness";
import type {
  InputFactV1,
  JsonValue,
  RuntimeActivitySettledFactV1,
} from "@paw/protocol";

import {
  COLLABORATION_COORDINATOR_POLICY_VERSION_V1,
  type CollaborationPolicyV1,
  DEFAULT_COLLABORATION_POLICY_V1,
  freezeCollaborationPolicyV1,
} from "./policy.js";
import {
  COLLABORATION_ROSTER_VERSION_V1,
  type CollaborationAgentSpecV1,
  type CollaborationChildPolicyV1,
  type CollaborationEffectProfileV1,
  type CollaborationRosterV1,
  DEFAULT_COLLABORATION_ROSTER_V1,
  collaborationAgentSpecHashV1,
  parseCollaborationAgentSpecV1,
  selectCollaborationAgentV1,
} from "./roster.js";

export const COLLABORATION_ACTIVITY_KIND_V1 = "collaboration_child" as const;
export const COLLABORATION_TASK_SCHEMA_VERSION_V1 =
  "paw.collaboration-task.v2" as const;
const LEGACY_COLLABORATION_TASK_SCHEMA_VERSION_V1 =
  "paw.collaboration-task.v1" as const;
const LEGACY_COLLABORATION_ROSTER_VERSION_V1 =
  "paw.collaboration-roster.v3:typed-capabilities" as const;

export interface CollaborationJournalPortV1 {
  readFacts(): readonly InputFactV1[] | Promise<readonly InputFactV1[]>;
  record(facts: readonly InputFactV1[]): Promise<void>;
}

export interface CollaborationTaskProjectionV1 {
  readonly taskId: string;
  readonly callId: string;
  readonly parentRunId: string;
  readonly agentId: string;
  readonly role: string;
  readonly agentSpecHash: string;
  readonly childPolicy: CollaborationChildPolicyV1;
  readonly effectProfile: CollaborationEffectProfileV1;
  readonly goalHash: string;
  readonly maxSteps: number;
  readonly label: string;
  readonly startedAt: number;
  readonly settlement?: RuntimeActivitySettledFactV1;
}

export interface CollaborationProjectionV1 {
  readonly tasks: readonly CollaborationTaskProjectionV1[];
  readonly active: readonly CollaborationTaskProjectionV1[];
}

export function createDurableCollaborationCoordinatorV1(input: {
  readonly delegate: SubAgentLauncher;
  readonly journal: CollaborationJournalPortV1;
  readonly policy?: CollaborationPolicyV1;
  readonly roster?: CollaborationRosterV1;
  readonly clock?: () => number;
}): SubAgentLauncher {
  if (!input.delegate || typeof input.delegate.launch !== "function") {
    throw new TypeError("Collaboration coordinator delegate is invalid");
  }
  if (
    !input.journal ||
    typeof input.journal.readFacts !== "function" ||
    typeof input.journal.record !== "function"
  ) {
    throw new TypeError("Collaboration coordinator Journal port is invalid");
  }
  const policy = freezeCollaborationPolicyV1(
    input.policy ?? DEFAULT_COLLABORATION_POLICY_V1,
  );
  const clock = input.clock ?? Date.now;
  const roster = input.roster ?? DEFAULT_COLLABORATION_ROSTER_V1;

  const launch = async (
    goal: string,
    maxSteps?: number,
    options?: Parameters<SubAgentLauncher["launch"]>[2],
  ): Promise<SubAgentResult> => {
    const callId = options?.agentId?.trim();
    const parentRunId = options?.parentRunId?.trim();
    if (!callId || !parentRunId) {
      throw new Error(
        "Durable collaboration requires stable parent run and tool call ids",
      );
    }
    const normalizedGoal = goal.trim();
    const steps = maxSteps ?? policy.defaultMaxSteps;
    const agent = agentFromArgs(options?.args, roster);
    const identity = taskIdentity(
      parentRunId,
      callId,
      normalizedGoal,
      steps,
      agent,
    );
    const before = projectCollaborationTasksV1(await input.journal.readFacts());
    const existing = before.tasks.find(
      (task) => task.taskId === identity.taskId,
    );
    if (existing) assertSameTask(existing, identity);
    else {
      await input.journal.record([
        {
          type: "runtime.activity_started",
          activityId: identity.taskId,
          activityKind: COLLABORATION_ACTIVITY_KIND_V1,
          label: taskLabel(agent.id, agent.role, normalizedGoal),
          startedAt: clock(),
          metadata: taskMetadata(identity),
        },
      ]);
    }

    try {
      const result = await input.delegate.launch(
        normalizedGoal,
        steps,
        options,
      );
      await settleOnce(
        input.journal,
        identity.taskId,
        result.status,
        result.summary,
        clock,
      );
      return withTaskLocator(result, identity);
    } catch (error) {
      const status = options?.signal?.aborted ? "cancelled" : "failed";
      await settleOnce(
        input.journal,
        identity.taskId,
        status,
        describeError(error),
        clock,
      );
      throw error;
    }
  };

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

export function projectCollaborationTasksV1(
  facts: readonly InputFactV1[],
): CollaborationProjectionV1 {
  const tasks = new Map<string, CollaborationTaskProjectionV1>();
  for (const fact of facts) {
    if (
      fact.type === "runtime.activity_started" &&
      fact.activityKind === COLLABORATION_ACTIVITY_KIND_V1
    ) {
      if (tasks.has(fact.activityId)) {
        throw new Error(`Duplicate collaboration task: ${fact.activityId}`);
      }
      const metadata = parseTaskMetadata(fact.metadata);
      if (metadata.taskId !== fact.activityId) {
        throw new Error("Collaboration task metadata identity mismatch");
      }
      tasks.set(
        fact.activityId,
        Object.freeze({
          ...metadata,
          label: fact.label,
          startedAt: fact.startedAt,
        }),
      );
      continue;
    }
    if (fact.type !== "runtime.activity_settled") continue;
    const task = tasks.get(fact.activityId);
    if (!task) continue;
    if (task.settlement) {
      throw new Error(`Duplicate collaboration settlement: ${fact.activityId}`);
    }
    tasks.set(fact.activityId, Object.freeze({ ...task, settlement: fact }));
  }
  const values = Object.freeze([...tasks.values()]);
  return Object.freeze({
    tasks: values,
    active: Object.freeze(values.filter((task) => !task.settlement)),
  });
}

function taskIdentity(
  parentRunId: string,
  callId: string,
  goal: string,
  maxSteps: number,
  agent: CollaborationAgentSpecV1,
) {
  const goalHash = hash(goal);
  return Object.freeze({
    taskId: `collaboration-task-${hash(JSON.stringify([parentRunId, callId])).slice(0, 32)}`,
    callId,
    parentRunId,
    agentId: agent.id,
    role: agent.role,
    agentSpecHash: collaborationAgentSpecHashV1(agent),
    effectProfile: agent.effect,
    childPolicy: agent.childPolicy,
    goalHash,
    maxSteps,
  });
}

function taskMetadata(identity: ReturnType<typeof taskIdentity>): JsonValue {
  return Object.freeze({
    schemaVersion: COLLABORATION_TASK_SCHEMA_VERSION_V1,
    coordinatorPolicyVersion: COLLABORATION_COORDINATOR_POLICY_VERSION_V1,
    rosterVersion: COLLABORATION_ROSTER_VERSION_V1,
    ...identity,
  });
}

function parseTaskMetadata(value: JsonValue | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Collaboration task metadata is missing");
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(record).sort().join("\0");
  const legacy =
    record.schemaVersion === LEGACY_COLLABORATION_TASK_SCHEMA_VERSION_V1;
  const expectedKeys = legacy
    ? "agentId\0agentSpecHash\0callId\0childPolicy\0coordinatorPolicyVersion\0goalHash\0maxSteps\0parentRunId\0role\0rosterVersion\0schemaVersion\0taskId"
    : "agentId\0agentSpecHash\0callId\0childPolicy\0coordinatorPolicyVersion\0effectProfile\0goalHash\0maxSteps\0parentRunId\0role\0rosterVersion\0schemaVersion\0taskId";
  if (
    keys !== expectedKeys ||
    (!legacy &&
      record.schemaVersion !== COLLABORATION_TASK_SCHEMA_VERSION_V1) ||
    record.coordinatorPolicyVersion !==
      COLLABORATION_COORDINATOR_POLICY_VERSION_V1 ||
    (legacy
      ? record.rosterVersion !== LEGACY_COLLABORATION_ROSTER_VERSION_V1
      : record.rosterVersion !== COLLABORATION_ROSTER_VERSION_V1) ||
    typeof record.taskId !== "string" ||
    typeof record.callId !== "string" ||
    typeof record.parentRunId !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.role !== "string" ||
    typeof record.agentSpecHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.agentSpecHash) ||
    (record.childPolicy !== "read_only" &&
      record.childPolicy !== "read_write") ||
    (!legacy &&
      record.effectProfile !== "inspect" &&
      record.effectProfile !== "execute" &&
      record.effectProfile !== "mutate") ||
    typeof record.goalHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(record.goalHash) ||
    !Number.isSafeInteger(record.maxSteps) ||
    (record.maxSteps as number) < 1
  ) {
    throw new Error("Collaboration task metadata is invalid");
  }
  const expectedTaskId = `collaboration-task-${hash(
    JSON.stringify([record.parentRunId, record.callId]),
  ).slice(0, 32)}`;
  if (record.taskId !== expectedTaskId) {
    throw new Error("Collaboration task metadata identity is invalid");
  }
  return Object.freeze({
    taskId: record.taskId,
    callId: record.callId,
    parentRunId: record.parentRunId,
    agentId: record.agentId,
    role: record.role,
    agentSpecHash: record.agentSpecHash,
    effectProfile: legacy
      ? record.childPolicy === "read_write"
        ? ("mutate" as const)
        : ("inspect" as const)
      : (record.effectProfile as CollaborationEffectProfileV1),
    childPolicy: record.childPolicy,
    goalHash: record.goalHash,
    maxSteps: record.maxSteps as number,
  });
}

function assertSameTask(
  existing: CollaborationTaskProjectionV1,
  expected: ReturnType<typeof taskIdentity>,
): void {
  if (
    existing.callId !== expected.callId ||
    existing.parentRunId !== expected.parentRunId ||
    existing.agentId !== expected.agentId ||
    existing.role !== expected.role ||
    existing.agentSpecHash !== expected.agentSpecHash ||
    existing.effectProfile !== expected.effectProfile ||
    existing.childPolicy !== expected.childPolicy ||
    existing.goalHash !== expected.goalHash ||
    existing.maxSteps !== expected.maxSteps
  ) {
    throw new Error(
      `Stable collaboration task id was reused with different input: ${expected.taskId}`,
    );
  }
}

async function settleOnce(
  journal: CollaborationJournalPortV1,
  taskId: string,
  status: "completed" | "failed" | "cancelled",
  summary: string,
  clock: () => number,
): Promise<void> {
  const task = projectCollaborationTasksV1(
    await journal.readFacts(),
  ).tasks.find((item) => item.taskId === taskId);
  if (!task) throw new Error(`Collaboration task start is missing: ${taskId}`);
  if (task.settlement) return;
  await journal.record([
    {
      type: "runtime.activity_settled",
      activityId: taskId,
      status,
      settledAt: clock(),
      summary: singleLine(summary, 8_000),
    },
  ]);
}

function withTaskLocator(
  result: SubAgentResult,
  identity: ReturnType<typeof taskIdentity>,
): SubAgentResult {
  return Object.freeze({
    ...result,
    collaborationTask: Object.freeze({
      schemaVersion: COLLABORATION_TASK_SCHEMA_VERSION_V1,
      taskId: identity.taskId,
      agentId: identity.agentId,
      role: identity.role,
      effectProfile: identity.effectProfile,
      childPolicy: identity.childPolicy,
      status: result.status,
    }),
  });
}

function agentFromArgs(
  args: Record<string, unknown> | undefined,
  roster: CollaborationRosterV1,
): CollaborationAgentSpecV1 {
  const selected = selectCollaborationAgentV1(roster, {
    agentId: args?.agent_id,
    role: args?.role,
  });
  if (args?.agent_spec !== undefined) {
    const agent = parseCollaborationAgentSpecV1(args.agent_spec);
    if (
      args.agent_spec_hash !== collaborationAgentSpecHashV1(agent) ||
      args.agent_id !== agent.id ||
      (args.effect_profile !== undefined &&
        args.effect_profile !== agent.effect) ||
      args.child_policy !== agent.childPolicy ||
      collaborationAgentSpecHashV1(selected) !==
        collaborationAgentSpecHashV1(agent)
    ) {
      throw new Error("Collaboration AgentSpec binding is invalid");
    }
    return agent;
  }
  return selected;
}

function taskLabel(agentId: string, role: string, goal: string): string {
  return singleLine(`${agentId} (${role}): ${goal}`, 240);
}

function singleLine(value: string, limit: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim() || "No summary";
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 14)} [truncated]`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
