import { useState } from "react";
import type { PendingApprovalItem } from "../agent/types";
import styles from "./ApprovalCard.module.css";

/**
 * 工具审批卡：渲染在聊天区底部（composer 上方）。
 * 队列一次只展示一条（宿主与 packages/agent 双重串行化保证有序），
 * 其余排队条数以「还有 N 条」提示。
 */
export function ApprovalCard({
  item,
  queueSize,
  onResolve,
}: {
  item: PendingApprovalItem;
  queueSize: number;
  onResolve: (approvalId: string, approved: boolean, always: boolean) => void;
}) {
  const [showArgs, setShowArgs] = useState(false);

  return (
    <div className={styles.card} role="alertdialog" aria-label="工具审批请求">
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden>
          🛡
        </span>
        <span className={styles.title}>审批请求</span>
        {queueSize > 1 ? (
          <span className={styles.queue}>还有 {queueSize - 1} 条待审批</span>
        ) : null}
      </div>

      <div className={styles.tool}>{item.tool}</div>
      {item.summary ? (
        <div className={styles.summary} title={item.summary}>
          {item.summary}
        </div>
      ) : null}

      {item.argsPreview ? (
        <>
          <button
            type="button"
            className={styles.argsToggle}
            onClick={() => setShowArgs((v) => !v)}
            aria-expanded={showArgs}
          >
            {showArgs ? "隐藏参数 ▴" : "查看参数 ▾"}
          </button>
          {showArgs ? (
            <pre className={styles.args}>{item.argsPreview}</pre>
          ) : null}
        </>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.denyBtn}
          onClick={() => onResolve(item.approvalId, false, false)}
        >
          拒绝
        </button>
        <button
          type="button"
          className={styles.alwaysBtn}
          title="本会话内同类操作不再询问"
          onClick={() => onResolve(item.approvalId, true, true)}
        >
          始终允许
        </button>
        <button
          type="button"
          className={styles.allowBtn}
          onClick={() => onResolve(item.approvalId, true, false)}
        >
          允许
        </button>
      </div>
    </div>
  );
}
