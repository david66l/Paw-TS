import { memo, useState } from "react";
import type { ToolBatch, ToolRunRow } from "../agent/types";
import styles from "./ToolBatchCard.module.css";

function dotClass(status: ToolRunRow["status"]): string {
  switch (status) {
    case "ok":
      return styles.dotOk ?? "";
    case "fail":
      return styles.dotFail ?? "";
    case "denied":
      return styles.dotDenied ?? "";
    default:
      return styles.dotRun ?? "";
  }
}

function statusText(status: ToolRunRow["status"]): string {
  switch (status) {
    case "ok":
      return "完成";
    case "fail":
      return "失败";
    case "denied":
      return "已拒绝";
    default:
      return "执行中";
  }
}

/** 工具名去掉 workspace. 前缀，展示更紧凑 */
function shortTool(tool: string): string {
  return tool.replace(/^workspace\./, "");
}

/**
 * 工具执行卡：两个模型轮次之间的一批连续工具调用。
 * 运行中逐行展示进度；结束后收成一行摘要 + 可展开明细。
 * 无实时数据（重载会话）→ 用锚点消息的 content 静态单行兜底。
 */
export const ToolBatchCard = memo(function ToolBatchCard({
  batch,
  fallback,
}: {
  batch?: ToolBatch;
  fallback: string;
}) {
  const [open, setOpen] = useState(false);

  if (!batch) {
    return (
      <div className={styles.card}>
        <div className={styles.doneLine}>{fallback}</div>
      </div>
    );
  }

  const okCount = batch.rows.filter((r) => r.status === "ok").length;
  const badCount = batch.rows.length - okCount;
  const running = batch.status === "running";

  return (
    <div className={styles.card}>
      <button
        type="button"
        className={styles.head}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span
          className={`${styles.headDot} ${running ? styles.dotRun : badCount > 0 ? styles.dotFail : styles.dotOk}`}
        />
        <span className={styles.headTitle}>
          {running ? "调用工具 · 执行中" : `调用 ${batch.rows.length} 个工具`}
        </span>
        <span className={styles.headMeta}>
          {running
            ? `${okCount}/${batch.rows.length} 完成`
            : badCount > 0
              ? `${okCount} 成功 · ${badCount} 失败/拒绝`
              : "全部成功"}
        </span>
        <span className={styles.caret}>{open ? "收起" : "展开"}</span>
      </button>

      {open || running ? (
        <div className={styles.rows}>
          {batch.rows.map((r) => {
            const detail = r.result ?? r.summary;
            return (
              <div key={r.id} className={styles.row}>
                <span className={`${styles.dot} ${dotClass(r.status)}`} />
                <span className={styles.tool}>{shortTool(r.tool)}</span>
                {detail ? (
                  <span className={styles.summary} title={detail}>
                    {detail}
                  </span>
                ) : null}
                <span className={styles.rowStatus}>{statusText(r.status)}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});
