import type {
  PawNextChildControlV1,
  PawNextLiveInputV1,
  RunFreshPawNextTaskInputV3,
} from "@paw/paw-next";

import { desktopAttachments } from "./paw-next-attachments.js";

type ManagedJobs = Parameters<NonNullable<RunFreshPawNextTaskInputV3["onManagedJobsReady"]>>[1];

/** Process-local handles; input and cancellation outcomes remain in V3 journals. */
export class DesktopNextControls {
  private inbox?: PawNextLiveInputV1;
  private children = new Map<string, PawNextChildControlV1>();
  private closed = false;
  private jobs = new Map<string, ManagedJobs>();
  managedJobs(runId: string, jobs: ManagedJobs) {
    this.jobs.set(runId, jobs);
  }
  onJobSnapshot?: (runId: string, job: import("@paw/harness").ManagedJobReadV1) => void;
  refreshJobs() {
    const result: {
      runId: string;
      job: import("@paw/harness").ManagedJobReadV1;
    }[] = [];
    for (const [runId, jobs] of this.jobs) {
      try {
        for (const job of jobs.list()) {
          const snapshot = jobs.peek(job.id);
          result.push({ runId, job: snapshot });
          this.onJobSnapshot?.(runId, snapshot);
        }
      } catch {
        this.jobs.delete(runId);
      }
    }
    return result;
  }
  stopJob(runId: string, jobId: string) {
    const jobs = this.jobs.get(runId);
    if (this.closed || !jobs) throw new Error("此后台任务已结束或不属于当前运行。");
    return jobs.kill(jobId, "Stopped from desktop");
  }

  ready(inbox: PawNextLiveInputV1) {
    if (!this.closed) this.inbox = inbox;
  }
  child(child: PawNextChildControlV1) {
    if (!this.closed) this.children.set(child.id, child);
  }
  close() {
    this.closed = true;
    this.inbox = undefined;
    this.children.clear();
    this.jobs.clear();
    this.onJobSnapshot = undefined;
  }

  async submit(inputId: string, content: string, attachments?: unknown) {
    if (this.closed || !this.inbox) throw new Error("任务尚未就绪或已结束，请稍后重试。");
    if (typeof content !== "string" || !content.trim() || content.length > 64_000)
      throw new Error("追加指令须为 1–64000 个字符。");
    const parsedAttachments = desktopAttachments(attachments);
    return this.inbox.accept({
      ...(parsedAttachments ? { attachments: parsedAttachments } : {}),
      inputId,
      content,
      delivery: "steer",
      callerId: "desktop-user",
    });
  }

  cancel(childId: string) {
    const child = this.children.get(childId);
    if (this.closed || !child?.cancel) throw new Error("此子任务已结束或不属于当前运行。");
    child.cancel();
  }
}
