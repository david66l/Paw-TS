import type { ManagedJobReadV1, SubAgentResult } from "@paw/harness";
import type { RunJournalEnvelopeV1 } from "@paw/protocol";
import type {
  DesktopMonitorSnapshot,
  MonitorTask,
} from "../src/agent/monitorTypes.js";
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").slice(0, 100)
    : [];
export class DesktopRunMonitor {
  private state: DesktopMonitorSnapshot;
  private activities = new Map<string, string>();
  constructor(
    readonly runId: string,
    private readonly publish: (snapshot: DesktopMonitorSnapshot) => void,
    initial?: DesktopMonitorSnapshot,
  ) {
    this.state =
      initial?.runId === runId
        ? structuredClone(initial)
        : { version: 1, runId, tasks: [], jobs: [], updatedAt: Date.now() };
    for (const task of this.state.tasks)
      if (task.activityId) this.activities.set(task.activityId, task.id);
  }
  private task(id: string, name: string, parentId = ""): MonitorTask {
    let task = this.state.tasks.find((t) => t.id === id);
    if (!task) {
      task = {
        id,
        parentId,
        name,
        dependencies: [],
        scope: [],
        acceptance: [],
        status: "waiting",
        files: [],
        artifacts: [],
        tests: [],
      };
      this.state.tasks.push(task);
    }
    return task;
  }
  committed(envelope: RunJournalEnvelopeV1) {
    if (envelope.record.kind !== "input_fact") return;
    const fact = envelope.record.fact;
    const key = (id: string) => `${envelope.runId}:${id}`;
    let changed = false;
    if (
      envelope.runId === this.runId &&
      fact.type === "completion.review_claimed" &&
      fact.reviewerId === "paw.environment-audit.v1"
    ) {
      this.state.audit = {
        reviewId: fact.reviewId,
        status: "checking",
        summary: "执行已结束，正在独立检查实际文件与验收条件。",
        inspected: [],
        unmetCriteria: [],
      };
      this.emit();
      return;
    }
    if (
      envelope.runId === this.runId &&
      fact.type === "completion.review_settled" &&
      this.state.audit?.reviewId === fact.reviewId
    ) {
      this.state.audit = {
        reviewId: fact.reviewId,
        status:
          fact.status === "completed" &&
          fact.verdict === "allow" &&
          fact.environmentAudit?.integrity === "clean"
            ? "verified"
            : "unverified",
        summary: fact.summary,
        inspected: fact.environmentAudit?.inspected ?? [],
        unmetCriteria: fact.environmentAudit?.unmetCriteria ?? [],
      };
      this.emit();
      return;
    }
    if (envelope.runId === this.runId && fact.type === "work.segment_started") {
      if (this.state.audit?.status === "unverified")
        this.state.audit = { ...this.state.audit, status: "repairing" };
      else this.state.audit = undefined;
      this.emit();
      return;
    }
    if (
      fact.type === "tool.call_observed" &&
      /(?:\.|_)delegate$/.test(fact.tool)
    ) {
      const args = record(fact.args);
      const plan = record(args.delegation_plan);
      const rawTasks = Array.isArray(plan.tasks)
        ? plan.tasks
        : Array.isArray(args.tasks)
          ? args.tasks
          : [args];
      const parentId = key(fact.callId);
      for (const raw of rawTasks) {
        const row = record(raw);
        const suffix = String(row.id ?? "task");
        const task = this.task(
          rawTasks.length === 1 ? parentId : `${parentId}:${suffix}`,
          String(row.goal ?? args.goal ?? "子任务"),
          parentId,
        );
        task.agentId = String(row.agentId ?? row.agent_id ?? "");
        task.scope = strings(row.scope);
        task.acceptance = strings(row.acceptance);
        task.dependencies = strings(row.dependsOn ?? row.depends_on).map(
          (id) => `${parentId}:${id}`,
        );
      }
      changed = true;
    } else if (
      fact.type === "runtime.activity_started" &&
      fact.activityKind === "collaboration_child"
    ) {
      const meta = record(fact.metadata);
      const id = key(String(meta.callId));
      this.activities.set(key(fact.activityId), id);
      const task = this.task(id, fact.label);
      task.activityId = key(fact.activityId);
      task.status = "running";
      task.agentId = String(meta.agentId ?? task.agentId ?? "");
      changed = true;
    } else if (fact.type === "runtime.activity_settled") {
      const id = this.activities.get(key(fact.activityId));
      if (id) {
        const task = this.task(id, id);
        task.status =
          fact.status === "completed"
            ? "done"
            : fact.status === "cancelled"
              ? "cancelled"
              : "failed";
        task.summary = fact.summary;
        changed = true;
      }
    } else if (fact.type === "tool.settled") {
      const parent = key(fact.callId);
      for (const task of this.state.tasks.filter(
        (t) => t.parentId === parent && t.status === "waiting",
      )) {
        task.status = "failed";
        task.blocker = fact.observation?.summary ?? "委派未启动或未返回结果";
        changed = true;
      }
    }
    if (changed) this.emit();
  }
  result(id: string, result: SubAgentResult) {
    const task = this.task(id, id);
    task.files = [...(result.changedFiles ?? [])];
    task.artifacts = [...(result.outcome?.artifactRefs ?? [])];
    task.tests = (result.testsRun ?? []).map((test) => ({
      name: test.name,
      passed: test.passed,
    }));
    task.summary = result.summary;
    this.emit();
  }
  job(runId: string, job: ManagedJobReadV1) {
    const id = `${runId}:${job.snapshot.id}`;
    const next = {
      ...job.snapshot,
      id,
      runId,
      jobId: job.snapshot.id,
      output: job.text.slice(-64000),
    };
    const index = this.state.jobs.findIndex((item) => item.id === id);
    if (
      index >= 0 &&
      JSON.stringify(this.state.jobs[index]) === JSON.stringify(next)
    )
      return;
    if (index < 0) this.state.jobs.push(next);
    else this.state.jobs[index] = next;
    this.emit();
  }
  finish() {
    if (
      this.state.audit &&
      ["checking", "repairing"].includes(this.state.audit.status)
    )
      this.state.audit = {
        ...this.state.audit,
        status: "unverified",
        summary: "任务停止或预算耗尽，尚未取得有效的验收结论。",
      };
    for (const task of this.state.tasks)
      if (["running", "waiting"].includes(task.status))
        task.status = "interrupted";
    this.emit();
  }
  private emit() {
    for (let pass = 0; pass < this.state.tasks.length; pass++) {
      let changed = false;
      for (const task of this.state.tasks) {
        if (!["waiting", "failed"].includes(task.status)) continue;
        const dependency = task.dependencies
          .map((id) => this.state.tasks.find((t) => t.id === id))
          .find(
            (t) =>
              t &&
              ["failed", "cancelled", "blocked", "interrupted"].includes(
                t.status,
              ),
          );
        if (dependency) {
          task.status = "blocked";
          task.blocker = `依赖「${dependency.name}」${dependency.status === "cancelled" ? "已停止" : "未完成"}`;
          changed = true;
        }
      }
      if (!changed) break;
    }
    this.state.tasks = this.state.tasks.slice(-200);
    this.state.jobs = this.state.jobs.slice(-100);
    this.state.updatedAt = Date.now();
    this.publish(structuredClone(this.state));
  }
}
