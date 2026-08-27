import type {
  SubAgentLaunchOptions,
  SubAgentLauncher,
  SubAgentOutcomeV1,
  SubAgentResult,
} from "@paw/harness";

import {
  type CollaborationPolicyV1,
  DEFAULT_COLLABORATION_POLICY_V1,
  freezeCollaborationPolicyV1,
} from "./policy.js";
import {
  COLLABORATION_CAPABILITIES_V1,
  type CollaborationCapabilityV1,
  type CollaborationRosterV1,
  DEFAULT_COLLABORATION_ROSTER_V1,
  collaborationAgentEffectV1,
  isCollaborationCapabilityV1,
  resolveCollaborationAgentForCapabilityV1,
} from "./roster.js";

export const COLLABORATION_DELEGATION_SCHEMA_VERSION_V1 =
  "paw.collaboration-delegation.v3:explicit-agent:soft-renewal" as const;

const PREVIOUS_COLLABORATION_DELEGATION_SCHEMA_VERSION_V1 =
  "paw.collaboration-delegation.v2:explicit-agent" as const;

const LEGACY_COLLABORATION_DELEGATION_SCHEMA_VERSION_V1 =
  "paw.collaboration-delegation.v1" as const;

export interface CollaborationDelegationTaskV1 {
  readonly id: string;
  readonly goal: string;
  readonly capability: CollaborationCapabilityV1;
  readonly scope: readonly string[];
  readonly acceptance: readonly string[];
  readonly dependsOn: readonly string[];
  /** First progress checkpoint; maxSteps remains the reserved hard cap. */
  readonly initialSteps: number;
  readonly maxSteps: number;
  readonly agentId: string;
}

export interface CollaborationDelegationPlanV1 {
  readonly schemaVersion: typeof COLLABORATION_DELEGATION_SCHEMA_VERSION_V1;
  readonly mode: "single" | "mission";
  readonly goal: string;
  readonly acceptance: readonly string[];
  readonly tasks: readonly CollaborationDelegationTaskV1[];
}

export function normalizeCollaborationDelegationV1(input: {
  readonly args: unknown;
  readonly roster?: CollaborationRosterV1;
  readonly policy?: CollaborationPolicyV1;
}): CollaborationDelegationPlanV1 {
  const policy = freezeCollaborationPolicyV1(
    input.policy ?? DEFAULT_COLLABORATION_POLICY_V1,
  );
  const roster = input.roster ?? DEFAULT_COLLABORATION_ROSTER_V1;
  const record = asRecord(input.args, "arguments");
  assertOnlyKeys(record, [
    "goal",
    "kind",
    "scope",
    "acceptance",
    "max_steps",
    "agent_id",
    "tasks",
  ]);
  const goal = boundedText(record.goal, "goal", policy.maxGoalChars);
  if (!isCollaborationCapabilityV1(record.kind)) {
    throw new Error(
      `kind must be one of ${COLLABORATION_CAPABILITIES_V1.join(", ")}`,
    );
  }
  const acceptance = stringList(record.acceptance, "acceptance", 12, 500);
  const rawTasks = record.tasks;
  const tasks =
    rawTasks === undefined
      ? [
          normalizeTask(
            {
              id: "task",
              goal,
              kind: record.kind,
              scope: record.scope,
              acceptance,
              max_steps: record.max_steps,
              agent_id: record.agent_id,
            },
            roster,
            policy,
          ),
        ]
      : normalizeTasks(rawTasks, roster, policy);
  validateTaskGraph(tasks);
  validateMissionBudget(tasks, policy);
  return Object.freeze({
    schemaVersion: COLLABORATION_DELEGATION_SCHEMA_VERSION_V1,
    mode: tasks.length === 1 ? "single" : "mission",
    goal,
    acceptance,
    tasks: Object.freeze(tasks),
  });
}

export function parseCollaborationDelegationPlanV1(
  input: unknown,
): CollaborationDelegationPlanV1 {
  const record = asRecord(input, "delegation plan");
  assertOnlyKeys(record, [
    "schemaVersion",
    "mode",
    "goal",
    "acceptance",
    "tasks",
  ]);
  if (
    (record.schemaVersion !== COLLABORATION_DELEGATION_SCHEMA_VERSION_V1 &&
      record.schemaVersion !==
        PREVIOUS_COLLABORATION_DELEGATION_SCHEMA_VERSION_V1 &&
      record.schemaVersion !==
        LEGACY_COLLABORATION_DELEGATION_SCHEMA_VERSION_V1) ||
    (record.mode !== "single" && record.mode !== "mission") ||
    typeof record.goal !== "string" ||
    !Array.isArray(record.acceptance) ||
    !record.acceptance.every((item) => typeof item === "string") ||
    !Array.isArray(record.tasks)
  ) {
    throw new Error("Collaboration delegation plan is invalid");
  }
  const tasks = record.tasks.map(parseResolvedTask);
  if (
    tasks.length === 0 ||
    (record.mode === "single") !== (tasks.length === 1)
  ) {
    throw new Error("Collaboration delegation mode is invalid");
  }
  validateTaskGraph(tasks);
  return Object.freeze({
    schemaVersion: COLLABORATION_DELEGATION_SCHEMA_VERSION_V1,
    mode: record.mode,
    goal: record.goal,
    acceptance: Object.freeze([...record.acceptance]),
    tasks: Object.freeze(tasks),
  });
}

export function createAdaptiveCollaborationLauncherV1(input: {
  readonly delegate: SubAgentLauncher;
  readonly roster?: CollaborationRosterV1;
  readonly policy?: CollaborationPolicyV1;
}): SubAgentLauncher {
  if (!input.delegate || typeof input.delegate.launch !== "function") {
    throw new TypeError("Adaptive collaboration delegate is invalid");
  }
  const roster = input.roster ?? DEFAULT_COLLABORATION_ROSTER_V1;
  const policy = freezeCollaborationPolicyV1(
    input.policy ?? DEFAULT_COLLABORATION_POLICY_V1,
  );

  const launch = async (
    _goal: string,
    _maxSteps?: number,
    options?: SubAgentLaunchOptions,
  ): Promise<SubAgentResult> => {
    const launchOptions = options ?? {};
    const parentCallId = launchOptions.agentId?.trim();
    if (!parentCallId) {
      throw new Error("Adaptive collaboration requires a stable tool call id");
    }
    const plan = parseCollaborationDelegationPlanV1(
      launchOptions.args?.delegation_plan,
    );
    assertCollaborationDelegationAgentsV1(plan, roster, policy);
    validateMissionBudget(plan.tasks, policy);
    if (plan.mode === "single") {
      const task = plan.tasks[0] as CollaborationDelegationTaskV1;
      return launchTask(
        input.delegate,
        task,
        parentCallId,
        launchOptions,
        new Map(),
        policy.maxGoalChars,
      );
    }
    return runMission(
      input.delegate,
      plan,
      parentCallId,
      launchOptions,
      roster,
      policy,
    );
  };

  return Object.freeze({
    launch,
    async launchStreaming(
      options: Parameters<SubAgentLauncher["launchStreaming"]>[0],
    ) {
      return launch(options.goal, options.maxSteps, options);
    },
  });
}

export function collaborationDelegationRequiresWriteV1(
  plan: CollaborationDelegationPlanV1,
  roster: CollaborationRosterV1,
): boolean {
  return collaborationDelegationRequiresMutationV1(plan, roster);
}

export function collaborationDelegationRequiresMutationV1(
  plan: CollaborationDelegationPlanV1,
  roster: CollaborationRosterV1,
): boolean {
  return plan.tasks.some(
    (task) =>
      collaborationAgentEffectV1(
        resolveCollaborationAgentForCapabilityV1(
          roster,
          task.capability,
          task.agentId,
        ),
      ) === "mutate",
  );
}

function assertCollaborationDelegationAgentsV1(
  plan: CollaborationDelegationPlanV1,
  roster: CollaborationRosterV1,
  policy: CollaborationPolicyV1,
): void {
  for (const task of plan.tasks) {
    const agent = resolveCollaborationAgentForCapabilityV1(
      roster,
      task.capability,
      task.agentId,
    );
    if (task.maxSteps > Math.min(agent.maxSteps, policy.maxChildSteps)) {
      throw new Error(`max_steps exceeds the limit for ${agent.id}`);
    }
  }
}

function normalizeTasks(
  input: unknown,
  roster: CollaborationRosterV1,
  policy: CollaborationPolicyV1,
): CollaborationDelegationTaskV1[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > policy.maxMissionTasks
  ) {
    throw new Error(
      `tasks must contain between 1 and ${policy.maxMissionTasks} items`,
    );
  }
  return input.map((item) =>
    normalizeTask(asRecord(item, "task"), roster, policy),
  );
}

function normalizeTask(
  input: Record<string, unknown>,
  roster: CollaborationRosterV1,
  policy: CollaborationPolicyV1,
): CollaborationDelegationTaskV1 {
  assertOnlyKeys(input, [
    "id",
    "goal",
    "kind",
    "scope",
    "acceptance",
    "depends_on",
    "max_steps",
    "agent_id",
  ]);
  const id = boundedText(input.id, "task id", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error(`Invalid collaboration task id: ${id}`);
  }
  if (!isCollaborationCapabilityV1(input.kind)) {
    throw new Error(
      `kind must be one of ${COLLABORATION_CAPABILITIES_V1.join(", ")}`,
    );
  }
  const goal = boundedText(input.goal, `task ${id} goal`, policy.maxGoalChars);
  const scope = stringList(input.scope, `task ${id} scope`, 12, 300);
  const acceptance = stringList(
    input.acceptance,
    `task ${id} acceptance`,
    12,
    500,
  );
  const dependsOn = stringList(
    input.depends_on,
    `task ${id} depends_on`,
    policy.maxMissionTasks,
    80,
  );
  if (typeof input.agent_id !== "string" || !input.agent_id.trim()) {
    throw new Error(
      `agent_id is required for task ${id}; choose an explicit agent from the Current Team Brief`,
    );
  }
  const agent = resolveCollaborationAgentForCapabilityV1(
    roster,
    input.kind,
    input.agent_id,
  );
  const maxForAgent = Math.min(agent.maxSteps, policy.maxChildSteps);
  const explicitlyBounded = input.max_steps !== undefined;
  const initialSteps = explicitlyBounded
    ? input.max_steps
    : Math.min(policy.defaultMaxSteps, maxForAgent);
  const maxSteps = explicitlyBounded ? input.max_steps : maxForAgent;
  if (
    !Number.isSafeInteger(maxSteps) ||
    (maxSteps as number) < 1 ||
    (maxSteps as number) > maxForAgent
  ) {
    throw new Error(
      `max_steps must be between 1 and ${maxForAgent} for ${agent.id}`,
    );
  }
  const task = Object.freeze({
    id,
    goal,
    capability: input.kind,
    scope,
    acceptance,
    dependsOn,
    initialSteps: initialSteps as number,
    maxSteps: maxSteps as number,
    agentId: agent.id,
  });
  if (formatDelegatedGoal(task).length > policy.maxGoalChars) {
    throw new Error(`Task ${id} context exceeds the child goal limit`);
  }
  return task;
}

function parseResolvedTask(input: unknown): CollaborationDelegationTaskV1 {
  const record = asRecord(input, "resolved task");
  assertOnlyKeys(record, [
    "id",
    "goal",
    "capability",
    "scope",
    "acceptance",
    "dependsOn",
    "initialSteps",
    "maxSteps",
    "agentId",
  ]);
  if (
    typeof record.id !== "string" ||
    typeof record.goal !== "string" ||
    !isCollaborationCapabilityV1(record.capability) ||
    !Array.isArray(record.scope) ||
    !record.scope.every((item) => typeof item === "string") ||
    !Array.isArray(record.acceptance) ||
    !record.acceptance.every((item) => typeof item === "string") ||
    !Array.isArray(record.dependsOn) ||
    !record.dependsOn.every((item) => typeof item === "string") ||
    !Number.isSafeInteger(record.maxSteps) ||
    (record.initialSteps !== undefined &&
      !Number.isSafeInteger(record.initialSteps)) ||
    typeof record.agentId !== "string"
  ) {
    throw new Error("Resolved collaboration task is invalid");
  }
  const initialSteps =
    record.initialSteps === undefined
      ? (record.maxSteps as number)
      : (record.initialSteps as number);
  if (
    initialSteps < 1 ||
    initialSteps > (record.maxSteps as number) ||
    (record.maxSteps as number) < 1
  ) {
    throw new Error("Resolved collaboration task step bounds are invalid");
  }
  return Object.freeze({
    id: record.id,
    goal: record.goal,
    capability: record.capability,
    scope: Object.freeze([...record.scope]),
    acceptance: Object.freeze([...record.acceptance]),
    dependsOn: Object.freeze([...record.dependsOn]),
    initialSteps,
    maxSteps: record.maxSteps as number,
    agentId: record.agentId,
  });
}

function validateTaskGraph(
  tasks: readonly CollaborationDelegationTaskV1[],
): void {
  const byId = new Map<string, CollaborationDelegationTaskV1>();
  for (const task of tasks) {
    if (byId.has(task.id)) {
      throw new Error(`Duplicate collaboration task id: ${task.id}`);
    }
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        throw new Error(`Task ${task.id} has unknown dependency ${dependency}`);
      }
      if (dependency === task.id) {
        throw new Error(`Task ${task.id} cannot depend on itself`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new Error("Collaboration task graph has a cycle");
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function validateMissionBudget(
  tasks: readonly CollaborationDelegationTaskV1[],
  policy: CollaborationPolicyV1,
): void {
  const reserved = tasks.reduce((sum, task) => sum + task.maxSteps, 0);
  if (reserved > policy.maxMissionSteps) {
    throw new Error(
      `Mission reserves ${reserved} model turns; maximum is ${policy.maxMissionSteps}`,
    );
  }
}

async function runMission(
  delegate: SubAgentLauncher,
  plan: CollaborationDelegationPlanV1,
  parentCallId: string,
  options: SubAgentLaunchOptions,
  roster: CollaborationRosterV1,
  policy: CollaborationPolicyV1,
): Promise<SubAgentResult> {
  const pending = new Map(plan.tasks.map((task) => [task.id, task]));
  const results = new Map<string, SubAgentResult>();
  while (pending.size > 0) {
    for (const task of [...pending.values()]) {
      const failedDependency = task.dependsOn.find(
        (id) => results.get(id)?.status === "failed",
      );
      if (!failedDependency) continue;
      results.set(task.id, {
        status: "failed",
        summary: `Blocked because dependency ${failedDependency} failed.`,
        errors: [`Dependency failed: ${failedDependency}`],
      });
      pending.delete(task.id);
    }
    const ready = [...pending.values()].filter((task) =>
      task.dependsOn.every((id) => results.get(id)?.status === "completed"),
    );
    if (ready.length === 0) continue;
    const effectFor = (task: CollaborationDelegationTaskV1) =>
      collaborationAgentEffectV1(
        resolveCollaborationAgentForCapabilityV1(
          roster,
          task.capability,
          task.agentId,
        ),
      );
    const inspectTasks = ready.filter((task) => effectFor(task) === "inspect");
    const executeTasks = ready.filter((task) => effectFor(task) === "execute");
    const mutationTask = ready.find((task) => effectFor(task) === "mutate");
    // Verification must observe a stable workspace revision. It may run with
    // readers, but never in the same wave as a mutating child.
    const wave = [
      ...inspectTasks,
      ...executeTasks,
      ...(executeTasks.length === 0 && mutationTask ? [mutationTask] : []),
    ].slice(0, policy.maxConcurrentChildren);
    const settled = await Promise.all(
      wave.map(async (task) => ({
        task,
        result: await launchTask(
          delegate,
          task,
          `${parentCallId}:${task.id}`,
          options,
          results,
          policy.maxGoalChars,
        ),
      })),
    );
    for (const item of settled) {
      results.set(item.task.id, item.result);
      pending.delete(item.task.id);
    }
  }
  return aggregateMissionResult(plan, results, policy.maxSummaryChars);
}

function launchTask(
  delegate: SubAgentLauncher,
  task: CollaborationDelegationTaskV1,
  callId: string,
  options: SubAgentLaunchOptions,
  dependencyResults: ReadonlyMap<string, SubAgentResult>,
  maxGoalChars: number,
): Promise<SubAgentResult> {
  return delegate.launch(
    formatDelegatedGoal(task, dependencyResults, maxGoalChars),
    task.maxSteps,
    {
      ...options,
      agentId: callId,
      args: {
        goal: task.goal,
        kind: task.capability,
        scope: task.scope,
        acceptance: task.acceptance,
        agent_id: task.agentId,
        initial_steps: task.initialSteps,
        max_steps: task.maxSteps,
      },
    },
  );
}

function formatDelegatedGoal(
  task: CollaborationDelegationTaskV1,
  dependencyResults: ReadonlyMap<string, SubAgentResult> = new Map(),
  maxGoalChars = Number.POSITIVE_INFINITY,
): string {
  const sections = [task.goal];
  if (task.scope.length > 0) {
    sections.push(
      `Scope:\n${task.scope.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  if (task.acceptance.length > 0) {
    sections.push(
      `Acceptance:\n${task.acceptance.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  const base = sections.join("\n\n");
  const dependencyEvidence = task.dependsOn
    .map((id) => {
      const result = dependencyResults.get(id);
      return result
        ? `- ${id} (${result.status}): ${singleLine(result.summary, 800)}`
        : undefined;
    })
    .filter((item): item is string => item !== undefined);
  if (dependencyEvidence.length === 0) return base;
  const header = "\n\nDependency evidence:\n";
  const remaining = maxGoalChars - base.length - header.length;
  if (remaining <= 0) return base;
  return `${base}${header}${dependencyEvidence.join("\n").slice(0, remaining)}`;
}

function aggregateMissionResult(
  plan: CollaborationDelegationPlanV1,
  results: ReadonlyMap<string, SubAgentResult>,
  summaryLimit: number,
): SubAgentResult {
  const ordered = plan.tasks.map((task) => ({
    task,
    result: results.get(task.id) as SubAgentResult,
  }));
  const completed = ordered.every((item) => item.result.status === "completed");
  const findings = ordered.map(
    ({ task, result }) =>
      `[${task.id}/${task.agentId}/${result.status}] ${singleLine(result.summary, 1_000)}`,
  );
  const changedFiles = unique(
    ordered.flatMap((item) => item.result.changedFiles ?? []),
  );
  const testsRun = ordered.flatMap((item) => item.result.testsRun ?? []);
  const outcome = aggregateMissionOutcomeV1(
    ordered.flatMap((item) =>
      item.result.outcome ? [item.result.outcome] : [],
    ),
  );
  const errors = ordered.flatMap((item) => item.result.errors ?? []);
  return Object.freeze({
    status: completed ? "completed" : "failed",
    summary: singleLine(
      `${completed ? "Mission completed" : "Mission failed"}: ${plan.goal}. ${findings.join(" ")}`,
      summaryLimit,
    ),
    findings: Object.freeze(findings),
    ...(changedFiles.length > 0
      ? { changedFiles: Object.freeze(changedFiles) }
      : {}),
    ...(testsRun.length > 0 ? { testsRun: Object.freeze(testsRun) } : {}),
    ...(outcome ? { outcome } : {}),
    ...(errors.length > 0 ? { errors: Object.freeze(errors) } : {}),
  });
}

function aggregateMissionOutcomeV1(
  outcomes: readonly SubAgentOutcomeV1[],
): SubAgentOutcomeV1 | undefined {
  if (outcomes.length === 0) return undefined;
  const verdict = outcomes.some((item) => item.verdict === "fail")
    ? ("fail" as const)
    : outcomes.some((item) => item.verdict === "partial")
      ? ("partial" as const)
      : outcomes.some((item) => item.verdict === "pass")
        ? ("pass" as const)
        : ("not_applicable" as const);
  const revisions = unique(
    outcomes.flatMap((item) =>
      item.sourceRevision ? [item.sourceRevision] : [],
    ),
  );
  return Object.freeze({
    schemaVersion: "paw.sub-agent-outcome.v1" as const,
    effectProfile: "mixed" as const,
    verdict,
    commands: Object.freeze(
      outcomes.flatMap((item) =>
        item.commands.map((command) => Object.freeze({ ...command })),
      ),
    ),
    artifactRefs: Object.freeze(
      unique(outcomes.flatMap((item) => item.artifactRefs)),
    ),
    ...(revisions.length === 1 ? { sourceRevision: revisions[0] } : {}),
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Collaboration ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allow = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allow.has(key));
  if (unexpected)
    throw new Error(`Unexpected collaboration field: ${unexpected}`);
}

function boundedText(value: unknown, label: string, limit: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > limit) {
    throw new Error(`${label} must be between 1 and ${limit} characters`);
  }
  return text;
}

function stringList(
  value: unknown,
  label: string,
  maxItems: number,
  maxChars: number,
): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        item.trim().length <= maxChars,
    )
  ) {
    throw new Error(`${label} must be a bounded string array`);
  }
  return Object.freeze([...new Set(value.map((item) => item.trim()))]);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function singleLine(value: string, limit: number): string {
  const text = value.replace(/[\r\n\t]+/g, " ").trim();
  return text.length <= limit
    ? text
    : `${text.slice(0, limit - 14)} [truncated]`;
}
