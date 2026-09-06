export interface MonitorAudit {
  reviewId: string;
  status: "checking" | "verified" | "unverified" | "repairing";
  summary: string;
  inspected: readonly { path: string; hash: string }[];
  unmetCriteria: readonly string[];
}
export interface MonitorTask {
  id: string;
  activityId?: string;
  parentId: string;
  name: string;
  agentId?: string;
  dependencies: string[];
  scope: string[];
  acceptance: string[];
  status:
    | "waiting"
    | "running"
    | "done"
    | "failed"
    | "cancelled"
    | "blocked"
    | "interrupted";
  blocker?: string;
  summary?: string;
  audit?: MonitorAudit;
  files: string[];
  artifacts: string[];
  tests: { name: string; passed: boolean }[];
}
export interface MonitorJob {
  id: string;
  runId: string;
  jobId: string;
  label: string;
  status: string;
  output: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}
export interface DesktopMonitorSnapshot {
  version: 1;
  runId: string;
  tasks: MonitorTask[];
  audit?: MonitorAudit;
  jobs: MonitorJob[];
  updatedAt: number;
}
