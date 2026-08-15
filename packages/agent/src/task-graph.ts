import type { AgentToolCallAction } from "@paw/core";
import type { ToolRunResult } from "@paw/harness";
import type { TaskState } from "./task-state.js";

export const TASK_GRAPH_SCHEMA_V1 = "paw.task-graph.v1" as const;

export type TaskGraphEventV1 =
  | {
      readonly schemaVersion: typeof TASK_GRAPH_SCHEMA_V1;
      readonly seq: number;
      readonly type: "plan.proposed";
      readonly nodes: readonly TaskGraphPlanProposalV1[];
    }
  | {
      readonly schemaVersion: typeof TASK_GRAPH_SCHEMA_V1;
      readonly seq: number;
      readonly type: "facts.observed";
      readonly facts: TaskGraphHostFactsV1;
    };

export interface TaskGraphPlanProposalV1 {
  readonly id: string;
  readonly task: string;
  readonly dependsOn: readonly string[];
  readonly modelStatus: string;
}

export interface TaskGraphHostFactsV1 {
  readonly filesRead: number;
  readonly shellRevision: number;
  readonly mutationRevision: number;
  readonly verification: "none" | "passed" | "code_failed" | "harness_failed";
  readonly verificationMutationRevision: number;
  readonly diffInspectedRevision: number;
  readonly lastTool: string;
  readonly lastToolOk: boolean;
}

export interface TaskGraphNodeV1 {
  readonly id: string;
  readonly kind: "plan_proposal" | "host_milestone";
  readonly task: string;
  readonly dependsOn: readonly string[];
  readonly status:
    | "proposal_ready"
    | "dependency_waiting"
    | "claimed_done"
    | "host_observed"
    | "blocked"
    | "superseded";
  readonly provenance: "model_proposal" | "host_fact";
  readonly reason?: string;
}

export interface TaskGraphSnapshotV1 {
  readonly schemaVersion: typeof TASK_GRAPH_SCHEMA_V1;
  readonly authority: "advisory_projection";
  readonly completionAuthority: "CompletionPolicy";
  readonly sourceThroughSeq: number;
  readonly nodes: readonly TaskGraphNodeV1[];
  readonly currentNodeId?: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseTaskGraphEventsV1(
  value: unknown,
): readonly TaskGraphEventV1[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("Invalid TaskGraph event ledger");
  const events: TaskGraphEventV1[] = value.map((raw, index) => {
    const event = recordOf(raw);
    if (
      event?.schemaVersion !== TASK_GRAPH_SCHEMA_V1 ||
      event.seq !== index + 1
    ) {
      throw new Error(`Invalid TaskGraph event sequence at ${index + 1}`);
    }
    if (event.type === "plan.proposed") {
      if (!Array.isArray(event.nodes))
        throw new Error("Invalid TaskGraph plan");
      const nodes = event.nodes.map((rawNode) => {
        const node = recordOf(rawNode);
        if (
          typeof node?.id !== "string" ||
          typeof node.task !== "string" ||
          !Array.isArray(node.dependsOn) ||
          !node.dependsOn.every((item) => typeof item === "string") ||
          typeof node.modelStatus !== "string"
        ) {
          throw new Error("Invalid TaskGraph plan node");
        }
        return Object.freeze({
          id: node.id,
          task: node.task,
          dependsOn: Object.freeze([...node.dependsOn] as string[]),
          modelStatus: node.modelStatus,
        });
      });
      return Object.freeze({
        schemaVersion: TASK_GRAPH_SCHEMA_V1,
        seq: event.seq,
        type: "plan.proposed" as const,
        nodes: Object.freeze(nodes),
      });
    }
    if (event.type !== "facts.observed") {
      throw new Error("Invalid TaskGraph event type");
    }
    const facts = recordOf(event.facts);
    const verification = facts?.verification;
    if (
      typeof facts?.filesRead !== "number" ||
      typeof facts.shellRevision !== "number" ||
      typeof facts.mutationRevision !== "number" ||
      !["none", "passed", "code_failed", "harness_failed"].includes(
        String(verification),
      ) ||
      typeof facts.verificationMutationRevision !== "number" ||
      typeof facts.diffInspectedRevision !== "number" ||
      typeof facts.lastTool !== "string" ||
      typeof facts.lastToolOk !== "boolean"
    ) {
      throw new Error("Invalid TaskGraph host facts");
    }
    return Object.freeze({
      schemaVersion: TASK_GRAPH_SCHEMA_V1,
      seq: event.seq,
      type: "facts.observed" as const,
      facts: Object.freeze({
        filesRead: facts.filesRead,
        shellRevision: facts.shellRevision,
        mutationRevision: facts.mutationRevision,
        verification: verification as TaskGraphHostFactsV1["verification"],
        verificationMutationRevision: facts.verificationMutationRevision,
        diffInspectedRevision: facts.diffInspectedRevision,
        lastTool: facts.lastTool,
        lastToolOk: facts.lastToolOk,
      }),
    });
  });
  replayTaskGraphV1(events);
  return Object.freeze(events);
}

function normalizePlan(items: readonly unknown[]): TaskGraphPlanProposalV1[] {
  const seen = new Set<string>();
  const nodes: TaskGraphPlanProposalV1[] = [];
  for (const [index, item] of items.entries()) {
    const value = recordOf(item);
    const rawId = typeof value?.id === "string" ? value.id.trim() : "";
    const id = rawId || `plan-${String(index).padStart(3, "0")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const taskValue = value?.task_id ?? value?.text ?? value?.note;
    const task =
      typeof taskValue === "string" && taskValue.trim()
        ? taskValue.trim().slice(0, 500)
        : id;
    const dependsOn = Array.isArray(value?.depends_on)
      ? value.depends_on
          .filter(
            (dependency): dependency is string =>
              typeof dependency === "string" && !!dependency.trim(),
          )
          .map((dependency) => dependency.trim())
      : [];
    nodes.push(
      Object.freeze({
        id,
        task,
        dependsOn: Object.freeze([...new Set(dependsOn)]),
        modelStatus:
          typeof value?.status === "string" ? value.status : "pending",
      }),
    );
  }
  return nodes;
}

function structuralPlanKey(nodes: readonly TaskGraphPlanProposalV1[]): string {
  return JSON.stringify(
    nodes.map((node) => [
      node.id,
      node.task,
      [...node.dependsOn],
      node.modelStatus,
    ]),
  );
}

function nextSeq(events: readonly TaskGraphEventV1[]): number {
  return (events.at(-1)?.seq ?? 0) + 1;
}

export function appendTaskGraphPlanV1(
  events: readonly TaskGraphEventV1[] | undefined,
  items: readonly unknown[],
): readonly TaskGraphEventV1[] {
  const current = events ?? [];
  const nodes = normalizePlan(items);
  const previous = [...current]
    .reverse()
    .find((event) => event.type === "plan.proposed");
  if (
    previous &&
    structuralPlanKey(previous.nodes) === structuralPlanKey(nodes)
  ) {
    return current;
  }
  return Object.freeze([
    ...current,
    Object.freeze({
      schemaVersion: TASK_GRAPH_SCHEMA_V1,
      seq: nextSeq(current),
      type: "plan.proposed" as const,
      nodes: Object.freeze(nodes),
    }),
  ]);
}

export function hostFactsFromTaskStateV1(
  state: TaskState,
  call: AgentToolCallAction,
  result: ToolRunResult,
): TaskGraphHostFactsV1 {
  const latestTest = state.testResults.at(-1);
  const mutationRevision = state.mutationRevision ?? 0;
  const latestCurrentSubstantive = [...state.testResults]
    .reverse()
    .find(
      (test) =>
        (test.mutationRevision ?? 0) === mutationRevision &&
        test.outcome !== "harness_failed",
    );
  const authoritativeTest = latestCurrentSubstantive ?? latestTest;
  return Object.freeze({
    filesRead: state.filesRead.length,
    shellRevision: state.shellCommandRevision ?? state.commandsRun.length,
    mutationRevision,
    verification: authoritativeTest?.passed
      ? "passed"
      : authoritativeTest?.outcome === "harness_failed"
        ? "harness_failed"
        : authoritativeTest
          ? "code_failed"
          : "none",
    verificationMutationRevision: authoritativeTest?.mutationRevision ?? 0,
    diffInspectedRevision: state.diffInspectedRevision ?? 0,
    lastTool: call.tool,
    lastToolOk: result.ok,
  });
}

export function appendTaskGraphFactsV1(
  events: readonly TaskGraphEventV1[] | undefined,
  facts: TaskGraphHostFactsV1,
): readonly TaskGraphEventV1[] {
  const current = events ?? [];
  return Object.freeze([
    ...current,
    Object.freeze({
      schemaVersion: TASK_GRAPH_SCHEMA_V1,
      seq: nextSeq(current),
      type: "facts.observed" as const,
      facts: Object.freeze({ ...facts }),
    }),
  ]);
}

function cycleMembers(nodes: readonly TaskGraphPlanProposalV1[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      for (const member of path.slice(start)) cyclic.add(member);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const node = byId.get(id);
    for (const dependency of node?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id, []);
  return cyclic;
}

export function replayTaskGraphV1(
  events: readonly TaskGraphEventV1[] | undefined,
): TaskGraphSnapshotV1 {
  const source = events ?? [];
  let plan: readonly TaskGraphPlanProposalV1[] = [];
  let priorPlanIds = new Set<string>();
  const superseded = new Map<string, TaskGraphPlanProposalV1>();
  let facts: TaskGraphHostFactsV1 | undefined;
  let expectedSeq = 1;
  for (const event of source) {
    if (
      event.schemaVersion !== TASK_GRAPH_SCHEMA_V1 ||
      event.seq !== expectedSeq
    ) {
      throw new Error(`Invalid TaskGraph event sequence at ${expectedSeq}`);
    }
    expectedSeq += 1;
    if (event.type === "facts.observed") {
      facts = event.facts;
      continue;
    }
    const nextIds = new Set(event.nodes.map((node) => node.id));
    for (const old of plan) {
      if (!nextIds.has(old.id)) superseded.set(old.id, old);
    }
    for (const id of nextIds) superseded.delete(id);
    priorPlanIds = nextIds;
    plan = event.nodes;
  }

  const cyclic = cycleMembers(plan);
  const byId = new Map(plan.map((node) => [node.id, node]));
  const proposalNodes: TaskGraphNodeV1[] = plan.map((node) => {
    const missing = node.dependsOn.filter(
      (dependency) => !byId.has(dependency),
    );
    if (missing.length > 0) {
      return {
        ...node,
        kind: "plan_proposal",
        status: "blocked",
        provenance: "model_proposal",
        reason: `missing_dependency:${missing.join(",")}`,
      };
    }
    if (cyclic.has(node.id)) {
      return {
        ...node,
        kind: "plan_proposal",
        status: "blocked",
        provenance: "model_proposal",
        reason: "dependency_cycle",
      };
    }
    const dependencyWaiting = node.dependsOn.some(
      (dependency) => byId.get(dependency)?.modelStatus !== "completed",
    );
    return {
      ...node,
      kind: "plan_proposal",
      status:
        node.modelStatus === "completed"
          ? "claimed_done"
          : dependencyWaiting
            ? "dependency_waiting"
            : "proposal_ready",
      provenance: "model_proposal",
    };
  });
  const supersededNodes: TaskGraphNodeV1[] = [...superseded.values()]
    .filter((node) => !priorPlanIds.has(node.id))
    .map((node) => ({
      ...node,
      kind: "plan_proposal",
      status: "superseded",
      provenance: "model_proposal",
    }));
  const milestones: TaskGraphNodeV1[] = [];
  if (facts && (facts.filesRead > 0 || facts.shellRevision > 0)) {
    milestones.push({
      id: "host:investigation",
      kind: "host_milestone",
      task: "Repository evidence gathered",
      dependsOn: [],
      status: "host_observed",
      provenance: "host_fact",
    });
  }
  if (facts && facts.mutationRevision > 0) {
    milestones.push({
      id: "host:mutation",
      kind: "host_milestone",
      task: `Source mutation revision ${facts.mutationRevision}`,
      dependsOn: [],
      status: "host_observed",
      provenance: "host_fact",
    });
  }
  if (facts && facts.verification !== "none") {
    const current =
      facts.verificationMutationRevision === facts.mutationRevision;
    milestones.push({
      id: "host:verification",
      kind: "host_milestone",
      task: `Verification ${facts.verification} at revision ${facts.verificationMutationRevision}`,
      dependsOn: facts.mutationRevision > 0 ? ["host:mutation"] : [],
      status:
        facts.verification === "passed" && current
          ? "host_observed"
          : "blocked",
      provenance: "host_fact",
      ...(!(facts.verification === "passed" && current)
        ? { reason: current ? facts.verification : "stale_verification" }
        : {}),
    });
  }
  if (
    facts &&
    facts.mutationRevision > 0 &&
    facts.diffInspectedRevision >= facts.mutationRevision
  ) {
    milestones.push({
      id: "host:diff_inspection",
      kind: "host_milestone",
      task: `Diff inspected at revision ${facts.diffInspectedRevision}`,
      dependsOn: ["host:mutation"],
      status: "host_observed",
      provenance: "host_fact",
    });
  }
  const nodes = Object.freeze([
    ...proposalNodes,
    ...supersededNodes,
    ...milestones,
  ]);
  const currentNode = proposalNodes.find(
    (node) => node.status === "proposal_ready",
  );
  return Object.freeze({
    schemaVersion: TASK_GRAPH_SCHEMA_V1,
    authority: "advisory_projection" as const,
    completionAuthority: "CompletionPolicy" as const,
    sourceThroughSeq: source.at(-1)?.seq ?? 0,
    nodes,
    ...(currentNode ? { currentNodeId: currentNode.id } : {}),
  });
}

export function formatTaskGraphV1(snapshot: TaskGraphSnapshotV1): string {
  const lines = [
    "[Task Graph v1]",
    `schema=${snapshot.schemaVersion} authority=${snapshot.authority} completion_authority=${snapshot.completionAuthority} source_seq=${snapshot.sourceThroughSeq}`,
    `current=${snapshot.currentNodeId ?? "none"}`,
  ];
  for (const node of snapshot.nodes.slice(0, 24)) {
    lines.push(
      `- ${node.id} [${node.kind}/${node.status}/${node.provenance}] deps=${node.dependsOn.join(",") || "none"}: ${node.task}${node.reason ? ` reason=${node.reason}` : ""}`,
    );
  }
  if (snapshot.nodes.length > 24) {
    lines.push(`- ... ${snapshot.nodes.length - 24} more nodes`);
  }
  return lines.join("\n");
}
