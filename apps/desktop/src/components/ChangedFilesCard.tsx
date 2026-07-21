import { memo, useState } from "react";
import { totalChangeStats } from "../agent/toolCards";
import type { FileChangeItem } from "../agent/types";
import styles from "./ChangedFilesCard.module.css";

/** diff 文本按行着色：+ 绿 / − 红 / @@ 蓝；隐藏 Index/===/---/+++ 头部行 */
function DiffView({ diff }: { diff: string }) {
  const lines = diff
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("Index:") &&
        !line.startsWith("===") &&
        !line.startsWith("--- ") &&
        !line.startsWith("+++ "),
    );
  return (
    <pre className={styles.diff}>
      {lines.map((line, i) => {
        const cls = line.startsWith("+")
          ? styles.diffAdd
          : line.startsWith("-")
            ? styles.diffDel
            : line.startsWith("@@")
              ? styles.diffHunk
              : styles.diffCtx;
        return (
          // 行内容 + 行号足以做 key（diff 是一次性快照）
          <div key={`${i}-${line.slice(0, 16)}`} className={cls}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

/**
 * Changed files 内联卡：本 run 修改过的文件聚合（路径 + +/− 统计 + diff 预览）。
 * 运行中实时累加；无实时数据（重载会话）→ 锚点 content 静态单行兜底。
 */
export const ChangedFilesCard = memo(function ChangedFilesCard({
  changes,
  fallback,
}: {
  changes: readonly FileChangeItem[];
  fallback: string;
}) {
  const [openPath, setOpenPath] = useState<string | null>(null);

  if (changes.length === 0) {
    return (
      <div className={styles.card}>
        <div className={styles.fallback}>{fallback}</div>
      </div>
    );
  }

  const { added, removed } = totalChangeStats(changes);

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.headIcon} aria-hidden>
          Δ
        </span>
        <span className={styles.headTitle}>变更 {changes.length} 个文件</span>
        <span className={styles.stat}>
          <span className={styles.statAdd}>+{added}</span>
          <span className={styles.statDel}>−{removed}</span>
        </span>
      </div>

      <ul className={styles.rows}>
        {changes.map((c) => {
          // 只有新增没有删除 → 视为新文件（A），否则修改（M）
          const isNew = c.removed === 0 && c.added > 0;
          const open = openPath === c.path;
          return (
            <li key={c.path}>
              <button
                type="button"
                className={styles.row}
                onClick={() => setOpenPath(open ? null : c.path)}
                aria-expanded={open}
                disabled={!c.diff}
                title={c.diff ? c.path : `${c.path}（无 diff 预览）`}
              >
                <span
                  className={`${styles.badge} ${isNew ? styles.badgeNew : styles.badgeMod}`}
                >
                  {isNew ? "A" : "M"}
                </span>
                <span className={styles.path}>{c.path}</span>
                <span className={styles.rowStat}>
                  {c.added > 0 ? (
                    <span className={styles.statAdd}>+{c.added}</span>
                  ) : null}
                  {c.removed > 0 ? (
                    <span className={styles.statDel}>−{c.removed}</span>
                  ) : null}
                </span>
                {c.diff ? (
                  <span className={styles.caret}>{open ? "▴" : "▾"}</span>
                ) : null}
              </button>
              {open && c.diff ? <DiffView diff={c.diff} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
});
