import type { DesktopMonitorSnapshot, MonitorTask } from "../agent/monitorTypes";
import styles from "./RuntimeMonitor.module.css";
// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal ANSI escapes from log output.
const ansiEscape = /\x1b\[[0-9;]*[A-Za-z]/g;
const statusLabel: Record<string, string> = {
  waiting: "等待依赖 / 调度",
  running: "运行中",
  done: "执行结束",
  failed: "失败",
  cancelled: "已取消",
  blocked: "依赖阻塞",
  interrupted: "已中断",
  stopping: "正在停止",
  completed: "完成",
  killed: "已停止",
  interrupted_orphaned: "连接中断",
};
function Evidence({ task }: { task: MonitorTask }) {
  return (
    <>
      {task.scope.length ? <p>范围：{task.scope.join("、")}</p> : null}
      {task.acceptance.length ? (
        <details>
          <summary>验收要求</summary>
          <ul>
            {task.acceptance.map((text, i) => (
              <li key={`${i}-${text}`}>{text}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {task.summary ? (
        <details>
          <summary>执行结果</summary>
          <p>{task.summary}</p>
        </details>
      ) : null}
      {task.files.length || task.artifacts.length || task.tests.length ? (
        <details open>
          <summary>产物与验证</summary>
          {task.files.map((file) => (
            <p key={file}>
              文件：<code>{file}</code>
            </p>
          ))}
          {task.artifacts.map((ref) => (
            <p key={ref}>
              产物：<code>{ref}</code>
            </p>
          ))}
          {task.tests.map((test, i) => (
            <p key={`${i}-${test.name}`}>
              {test.passed ? "✓" : "✗"} {test.name}
            </p>
          ))}
        </details>
      ) : null}
    </>
  );
}
export function TaskOverview({ snapshot }: { snapshot: DesktopMonitorSnapshot | null }) {
  const tasks = snapshot?.tasks ?? [];
  const blocked = tasks.filter((t) => t.status === "blocked");
  return (
    <div className={styles.content}>
      {snapshot?.audit ? (
        <article className={styles.card}>
          <div className={styles.heading}>
            <strong>本阶段验收</strong>
            <span className={styles.status} data-status={snapshot.audit.status}>
              {
                {
                  checking: "待核验",
                  verified: "已验证完成",
                  unverified: "尚未通过",
                  repairing: "修复中",
                }[snapshot.audit.status]
              }
            </span>
          </div>
          <p>{snapshot.audit.summary}</p>
          {snapshot.audit.browserChecks?.map((check) => (
            <p key={check.callId}>
              浏览器行为已检查：{check.url} · {check.assertions} 项断言通过
              {check.visual ? (
                <span style={{ display: "block" }}>
                  视觉验收：
                  {{ pass: "通过", fail: "失败", unknown: "无法判断" }[check.visual.verdict]} ·{" "}
                  {check.visual.summary}
                  <small style={{ display: "block" }}>
                    截图：{check.visual.screenshotHash.slice(0, 12)} · 1280 × 800
                  </small>
                  {check.visual.checks.map((item) => (
                    <span key={item.criterion} style={{ display: "block" }}>
                      {item.criterion}：{item.observation}
                    </span>
                  ))}
                </span>
              ) : null}
            </p>
          ))}
          {snapshot.audit.unmetCriteria.length ? (
            <ul>
              {snapshot.audit.unmetCriteria.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
          {snapshot.audit.inspected.length ? (
            <details>
              <summary>实际检查的文件</summary>
              {snapshot.audit.inspected.map((item) => (
                <p key={item.path}>
                  <code>{item.path}</code>
                </p>
              ))}
            </details>
          ) : null}
        </article>
      ) : null}
      {!tasks.length ? (
        <p className={styles.empty}>尚无委派任务。这里会显示子任务依赖和执行结果。</p>
      ) : null}
      {tasks.length ? (
        <p className={styles.summary}>
          {tasks.length} 个子任务 · {tasks.filter((t) => t.status === "done").length} 执行结束 ·{" "}
          {blocked.length} 阻塞
        </p>
      ) : null}
      {tasks.map((task) => (
        <article key={task.id} className={styles.card}>
          <div className={styles.heading}>
            <strong>{task.name}</strong>
            <span data-status={task.status} className={styles.status}>
              {statusLabel[task.status]}
            </span>
          </div>
          {task.agentId ? <p>{task.agentId}</p> : null}
          {task.freshness ? (
            <div aria-label="成果版本状态">
              <p className={styles.status} data-status={task.freshness.status}>
                {
                  {
                    pending: "待执行",
                    verified: "成果版本有效",
                    unverified: "成果尚未验证",
                    stale: "成果已失效，需重新验收",
                    superseded: "已由新阶段替代",
                  }[task.freshness.status]
                }
              </p>
              {task.freshness.reason ? <p>{task.freshness.reason}</p> : null}
            </div>
          ) : null}
          {task.dependencies.length ? (
            <div className={styles.dependencies}>
              依赖 →{" "}
              {task.dependencies.map((id) => {
                const dependency = tasks.find((t) => t.id === id);
                return (
                  <span key={id}>
                    {dependency?.name ?? id}（{statusLabel[dependency?.status ?? "waiting"]}）
                  </span>
                );
              })}
            </div>
          ) : (
            <p>可独立执行</p>
          )}
          {task.blocker ? <output className={styles.blocker}>{task.blocker}</output> : null}
          {task.audit && task.freshness?.status !== "superseded" ? (
            <div>
              <p className={styles.status} data-status={task.audit.status}>
                {task.audit.status === "verified" ? "阶段验收通过" : "阶段尚未通过验收"}
              </p>
              {task.audit.unmetCriteria.map((item) => (
                <p key={item}>{item}</p>
              ))}
              {task.audit.browserChecks?.map((check) => (
                <p key={check.callId}>
                  浏览器行为已检查：{check.url} · {check.assertions} 项断言通过
                  {check.visual ? (
                    <span style={{ display: "block" }}>
                      视觉验收：
                      {{ pass: "通过", fail: "失败", unknown: "无法判断" }[check.visual.verdict]} ·{" "}
                      {check.visual.summary}
                      <small style={{ display: "block" }}>
                        截图：{check.visual.screenshotHash.slice(0, 12)} · 1280 × 800
                      </small>
                      {check.visual.checks.map((item) => (
                        <span key={item.criterion} style={{ display: "block" }}>
                          {item.criterion}：{item.observation}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </p>
              ))}
              <details>
                <summary>阶段检查的文件</summary>
                {task.audit.inspected.map((file) => (
                  <p key={file.path}>
                    <code>{file.path}</code>
                  </p>
                ))}
              </details>
            </div>
          ) : null}
          <Evidence task={task} />
        </article>
      ))}
    </div>
  );
}
export function BackgroundJobs({
  snapshot,
  live,
  onStop,
}: {
  snapshot: DesktopMonitorSnapshot | null;
  live: boolean;
  onStop: (runId: string, jobId: string) => void;
}) {
  const jobs = snapshot?.jobs ?? [];
  if (!jobs.length)
    return (
      <p className={styles.empty}>
        暂无后台任务。Agent 启动后台命令后，可在这里查看状态、日志并单独停止。
      </p>
    );
  return (
    <div className={styles.content}>
      <p className={styles.summary}>
        {live ? "每秒更新 · 日志仅保留最近部分" : "历史记录 · 显示最后保存的日志"}
      </p>
      {jobs.map((job) => (
        <article className={styles.card} key={job.id}>
          <div className={styles.heading}>
            <strong>{job.label}</strong>
            <span className={styles.status} data-status={job.status}>
              {statusLabel[job.status] ?? job.status}
            </span>
          </div>
          <p>
            {job.jobId} · {new Date(job.startedAt).toLocaleTimeString()}
          </p>
          {job.detail ? <p>{job.detail}</p> : null}
          {live && ["running", "stopping"].includes(job.status) ? (
            <button
              type="button"
              disabled={job.status === "stopping"}
              onClick={() => onStop(job.runId, job.jobId)}
            >
              停止后台任务
            </button>
          ) : null}
          <details open>
            <summary>日志</summary>
            <pre>{job.output.replace(ansiEscape, "") || "尚无输出"}</pre>
          </details>
        </article>
      ))}
    </div>
  );
}
