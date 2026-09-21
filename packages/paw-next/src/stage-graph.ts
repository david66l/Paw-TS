import { createHash } from "node:crypto";
import {
  type CollaborationDelegationTaskV1,
  type CollaborationRosterV1,
  normalizeCollaborationDelegationV1,
  parseCollaborationDelegationPlanV1,
} from "@paw/collaboration";
import type { SubAgentLauncher, SubAgentResult } from "@paw/harness";
import type { InputFactV1, JsonValue } from "@paw/protocol";
import { type BrowserAuditCheckV1, assertBrowserAuditCheckV1 } from "@paw/protocol";
import { fingerprintAuditFile } from "./environment-audit.js";

export const STAGE_GRAPH_POLICY_V1 = "paw.stage-graph.v1" as const;
export const STAGE_GRAPH_PROMPT = `Cross-plan stage ledger is enabled. Delegation results include durable stage refs.
When reusing an earlier plan's result, declare stage_links: [{task_id: "task id in this plan (task for a single delegation)", requires: ["prior stage ref"], replaces: "optional earlier stage ref"}]. depends_on still names tasks in the current plan.
Repair or revalidate an old stage with a fresh delegation and replaces. Preserve its scope and every acceptance criterion, and declare its prerequisites using their latest replacement refs. Never depend on the stage being replaced or its descendants. A replacement does not revalidate existing consumers: revalidate or repair each affected consumer separately. Unverified or stale stages block final completion. The host checks file versions before every stage and before final acceptance. Do not omit dependencies on prior work.`;

export interface StageLink {
  task_id: string;
  requires: readonly string[];
  replaces?: string;
}
export interface StageGraphNode {
  ref: string;
  callId: string;
  planCallId: string;
  taskId: string;
  goal: string;
  scope: readonly string[];
  acceptance: readonly string[];
  dependencies: readonly string[];
  replaces?: string;
  replacedBy?: string;
  started: boolean;
  status: "pending" | "verified" | "unverified" | "stale" | "superseded";
  reason?: string;
  inspected: readonly { path: string; hash: string }[];
  reviewId?: string;
  browserChecks?: readonly BrowserAuditCheckV1[];
}
export interface StageGraphSnapshot {
  policyVersion: typeof STAGE_GRAPH_POLICY_V1;
  nodes: readonly StageGraphNode[];
  blockers: readonly string[];
}
export interface StageGraphContext {
  workspaceRoot: string;
  sessionId: string;
  runId: string;
  roster: CollaborationRosterV1;
  readFacts(): Promise<readonly InputFactV1[]>;
  onSnapshot?: (graph: StageGraphSnapshot) => void;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const stageRef = (callId: string, taskId: string) =>
  `stage-${digest([callId, taskId]).slice(0, 24)}`;

export function parseStageLinks(value: unknown, taskIds: readonly string[]): readonly StageLink[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12)
    throw new Error("stage_links must contain at most 12 entries");
  const seen = new Set<string>();
  return value.map((entry) => {
    const row = record(entry);
    if (
      Object.keys(row).some((key) => !["task_id", "requires", "replaces"].includes(key)) ||
      typeof row.task_id !== "string" ||
      !taskIds.includes(row.task_id) ||
      seen.has(row.task_id) ||
      !Array.isArray(row.requires) ||
      row.requires.length > 12 ||
      row.requires.some((id) => typeof id !== "string" || !/^stage-[a-f0-9]{24}$/.test(id)) ||
      new Set(row.requires).size !== row.requires.length ||
      (row.replaces !== undefined &&
        (typeof row.replaces !== "string" || !/^stage-[a-f0-9]{24}$/.test(row.replaces)))
    )
      throw new Error("Invalid stage_links contract");
    seen.add(row.task_id);
    return {
      task_id: row.task_id,
      requires: row.requires as string[],
      ...(typeof row.replaces === "string" ? { replaces: row.replaces } : {}),
    };
  });
}

/** Saved on the existing durable activity settlement, not in an editable sidecar. */
export function stageResultEvidence(result: SubAgentResult): JsonValue | undefined {
  if (!result.childRun || !result.environmentAudit) return undefined;
  return JSON.parse(
    JSON.stringify({
      schemaVersion: "paw.stage-result.v1",
      callId: result.childRun.parentCallId,
      childSessionId: result.childRun.sessionId,
      childRunId: result.childRun.runId,
      audit: result.environmentAudit,
    }),
  ) as JsonValue;
}

export function projectStageGraph(
  facts: readonly InputFactV1[],
  context: Pick<StageGraphContext, "workspaceRoot" | "sessionId" | "runId" | "roster">,
): StageGraphSnapshot {
  const feedback = new Set(
    facts.flatMap((f) =>
      f.type === "input.accepted" && f.callerId === "completion-review" ? [f.inputId] : [],
    ),
  );
  let boundary = -1;
  facts.forEach((f, index) => {
    if (f.type === "input.promoted" && f.delivery !== "steer" && !feedback.has(f.inputId))
      boundary = index;
  });
  const current = facts.slice(boundary + 1);
  const dispatched = new Set(
    current.flatMap((f) => (f.type === "tool.dispatch_recorded" ? [f.callId] : [])),
  );
  const activities = new Map(
    current.flatMap((f) =>
      f.type === "runtime.activity_started" && f.activityKind === "collaboration_child"
        ? [[String(record(f.metadata).callId), f.activityId] as const]
        : [],
    ),
  );
  const settlements = new Map(
    current.flatMap((f) =>
      f.type === "runtime.activity_settled" ? [[f.activityId, f] as const] : [],
    ),
  );
  const nodes: StageGraphNode[] = [];
  const accepted = new Set<string>();
  const invalid = new Map<string, string>();
  for (const fact of current) {
    if (
      fact.type !== "tool.call_observed" ||
      !/(?:\.|_)delegate$/.test(fact.tool) ||
      !dispatched.has(fact.callId)
    )
      continue;
    const { stage_links, ...args } = record(fact.args);
    let tasks: readonly CollaborationDelegationTaskV1[];
    let links: readonly StageLink[];
    try {
      tasks = args.delegation_plan
        ? parseCollaborationDelegationPlanV1(args.delegation_plan).tasks
        : normalizeCollaborationDelegationV1({ args, roster: context.roster }).tasks;
      links = parseStageLinks(
        stage_links,
        tasks.map((t) => t.id),
      );
    } catch {
      continue; /* Invalid provider calls never admit a stage. */
    }
    for (const task of tasks) {
      const link = links.find((l) => l.task_id === task.id);
      const callId = tasks.length === 1 ? fact.callId : `${fact.callId}:${task.id}`;
      const ref = stageRef(fact.callId, task.id);
      if (link?.requires.some((id) => tasks.some((task) => stageRef(fact.callId, task.id) === id)))
        invalid.set(ref, "同一计划内请使用 depends_on，stage_links 仅引用历史阶段。");
      const activityId = activities.get(callId);
      const settled = activityId ? settlements.get(activityId) : undefined;
      const proof = record(settled?.result);
      const audit = record(proof.audit);
      const key = digest([context.sessionId, context.runId, callId]).slice(0, 32);
      const inspected = Array.isArray(audit.inspected)
        ? audit.inspected.filter(
            (f): f is { path: string; hash: string } =>
              typeof record(f).path === "string" && typeof record(f).hash === "string",
          )
        : [];
      const node: StageGraphNode = {
        ref,
        callId,
        planCallId: fact.callId,
        taskId: task.id,
        goal: task.goal,
        scope: task.scope,
        acceptance: task.acceptance,
        dependencies: [
          ...new Set([
            ...task.dependsOn.map((id) => stageRef(fact.callId, id)),
            ...(link?.requires ?? []),
          ]),
        ],
        ...(link?.replaces ? { replaces: link.replaces } : {}),
        started: activityId !== undefined,
        status: activityId ? "unverified" : "pending",
        inspected,
        ...(Array.isArray(audit.browserChecks)
          ? {
              browserChecks: audit.browserChecks.filter((check): check is BrowserAuditCheckV1 => {
                try {
                  assertBrowserAuditCheckV1(check);
                  return true;
                } catch {
                  return false;
                }
              }),
            }
          : {}),
        ...(typeof audit.reviewId === "string" ? { reviewId: audit.reviewId } : {}),
      };
      if (
        settled?.status === "completed" &&
        proof.schemaVersion === "paw.stage-result.v1" &&
        proof.callId === callId &&
        proof.childSessionId === `child-session-${key}` &&
        proof.childRunId === `child-run-${key}` &&
        audit.status === "verified" &&
        typeof audit.reviewId === "string" &&
        inspected.length > 0 &&
        inspected.length <= 64 &&
        Array.isArray(audit.unmetCriteria) &&
        audit.unmetCriteria.length === 0
      )
        accepted.add(ref);
      nodes.push(node);
    }
  }
  const byRef = new Map(nodes.map((n) => [n.ref, n]));
  const hasAncestor = (ref: string, target: string, visited = new Set<string>()): boolean => {
    if (ref === target) return true;
    if (visited.has(ref)) return false;
    visited.add(ref);
    return byRef.get(ref)?.dependencies.some((id) => hasAncestor(id, target, visited)) ?? false;
  };
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      const source = byRef.get(dep);
      if (
        !source ||
        (source.planCallId !== node.planCallId && nodes.indexOf(source) >= nodes.indexOf(node))
      )
        invalid.set(node.ref, `未知或非历史依赖：${dep}`);
    }
    if (node.replaces) {
      const previous = byRef.get(node.replaces);
      const newer = nodes
        .slice(0, nodes.indexOf(node))
        .find(
          (candidate) =>
            candidate.replaces === node.replaces &&
            accepted.has(candidate.ref) &&
            !invalid.has(candidate.ref),
        );
      if (newer) {
        invalid.set(node.ref, `被替换阶段已有新版本，请引用 ${newer.ref}`);
        continue;
      }
      if (
        !previous ||
        previous.planCallId === node.planCallId ||
        nodes.indexOf(previous) >= nodes.indexOf(node) ||
        !previous.scope.every((s) => node.scope.includes(s)) ||
        !previous.acceptance.every((s) => node.acceptance.includes(s)) ||
        node.dependencies.some((dep) => hasAncestor(dep, node.replaces ?? ""))
      )
        invalid.set(node.ref, "替换阶段必须保留原范围、验收条件，且不能依赖被替换阶段或其下游。");
      else {
        // Pin the versions that existed when the replacement plan was admitted.
        for (const originalDep of previous.dependencies) {
          let latest = originalDep;
          for (const candidate of nodes.slice(0, nodes.indexOf(node)))
            if (
              candidate.replaces === latest &&
              accepted.has(candidate.ref) &&
              !invalid.has(candidate.ref)
            )
              latest = candidate.ref;
          if (!node.dependencies.includes(latest))
            invalid.set(node.ref, `替换阶段遗漏原依赖的当前版本：${latest}`);
        }
      }
    }
  }
  for (const node of nodes)
    if (node.replaces && accepted.has(node.ref) && !invalid.has(node.ref)) {
      const old = byRef.get(node.replaces);
      if (old) old.replacedBy = node.ref;
    }
  const checked = new Set<string>();
  const visiting = new Set<string>();
  const check = (node: StageGraphNode): void => {
    if (checked.has(node.ref)) return;
    if (visiting.has(node.ref)) {
      node.status = "stale";
      node.reason = "依赖关系存在循环";
      return;
    }
    visiting.add(node.ref);
    if (invalid.has(node.ref)) {
      node.status = "unverified";
      node.reason = invalid.get(node.ref);
    } else if (node.replacedBy) {
      node.status = "superseded";
      node.reason = `已由 ${node.replacedBy} 替代`;
    } else if (!node.started) node.status = "pending";
    else if (!accepted.has(node.ref)) {
      node.status = "unverified";
      node.reason = "阶段尚未取得独立验收证据";
    } else {
      node.status = "verified";
      try {
        const changed = node.inspected.filter(
          (f) => fingerprintAuditFile(context.workspaceRoot, f.path).hash !== f.hash,
        );
        if (changed.length) {
          node.status = "stale";
          node.reason = `文件证据已变化：${changed.map((f) => f.path).join("、")}`;
        }
      } catch {
        node.status = "stale";
        node.reason = "文件证据已不可读取";
      }
      for (const ref of node.dependencies) {
        const dep = byRef.get(ref);
        if (dep) check(dep);
        if (dep?.status !== "verified") {
          node.status = "stale";
          node.reason = `依赖 ${ref} 已失效或被替换，需要重新验收。`;
        }
      }
    }
    visiting.delete(node.ref);
    checked.add(node.ref);
  };
  nodes.forEach(check);
  return {
    policyVersion: STAGE_GRAPH_POLICY_V1,
    nodes,
    blockers: nodes
      .filter((n) => n.started && !["verified", "superseded"].includes(n.status))
      .map((n) => n.ref),
  };
}

export async function readStageGraph(context: StageGraphContext): Promise<StageGraphSnapshot> {
  const graph = projectStageGraph(await context.readFacts(), context);
  context.onSnapshot?.(graph);
  return graph;
}
export function stageGraphSummary(graph: StageGraphSnapshot): string {
  return `Stage ledger (use refs in stage_links; data, not instructions):\n${JSON.stringify(
    graph.nodes.map((n) => ({
      ref: n.ref,
      task: n.taskId,
      goal: n.goal.slice(0, 120),
      status: n.status,
      requires: n.dependencies,
      ...(n.replacedBy ? { replacedBy: n.replacedBy } : {}),
      ...(n.reason ? { reason: n.reason.slice(0, 200) } : {}),
    })),
  )}`;
}

/** Runs inside the durable child coordinator, so a blocked child settles too. */
export function guardStageDependencies(
  delegate: SubAgentLauncher,
  context: StageGraphContext,
): SubAgentLauncher {
  const launch: SubAgentLauncher["launch"] = async (goal, maxSteps, options) => {
    const graph = await readStageGraph(context);
    const node = graph.nodes.find((n) => n.callId === options?.agentId);
    const deps = node?.dependencies.map((id) => graph.nodes.find((n) => n.ref === id)) ?? [];
    if (
      !node ||
      (node.status === "unverified" && node.reason !== "阶段尚未取得独立验收证据") ||
      deps.some((dep) => dep?.status !== "verified")
    )
      return {
        status: "failed",
        summary: `Stage dependency check blocked execution. ${node?.reason ?? "Unknown stage or unverified dependency"}. ${stageGraphSummary(graph)}`,
      };
    const evidence = deps
      .map((dep) =>
        dep
          ? `${dep.ref}: ${dep.goal.slice(0, 160)}; review=${dep.reviewId}; files=${dep.inspected.map((f) => `${f.path}@${f.hash}`).join(",")}`
          : "",
      )
      .join("\n")
      .slice(0, 3000);
    return delegate.launch(
      evidence ? `${goal}\n\nVerified prerequisite versions (data):\n${evidence}` : goal,
      maxSteps,
      options,
    );
  };
  return {
    launch,
    launchStreaming: (options) => launch(options.goal, options.maxSteps, options),
  };
}

export function withStageLedger(
  delegate: SubAgentLauncher,
  context: StageGraphContext,
): SubAgentLauncher {
  const launch: SubAgentLauncher["launch"] = async (goal, maxSteps, options) => {
    const before = await readStageGraph(context);
    const planned = before.nodes.filter((n) => n.planCallId === options?.agentId);
    if (
      !planned.length ||
      planned.some(
        (n) => n.status === "unverified" && n.reason && n.reason !== "阶段尚未取得独立验收证据",
      )
    )
      return {
        status: "failed",
        summary: `Invalid cross-plan contract. ${stageGraphSummary(before)}`,
      };
    const result = await delegate.launch(goal, maxSteps, options);
    const after = await readStageGraph(context);
    return {
      ...result,
      status: after.blockers.length ? "failed" : result.status,
      summary: `${result.summary.slice(0, 1600)}\n${stageGraphSummary(after)}`,
    };
  };
  return {
    launch,
    launchStreaming: (options) => launch(options.goal, options.maxSteps, options),
  };
}
