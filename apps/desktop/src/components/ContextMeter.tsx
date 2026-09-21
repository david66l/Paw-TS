import { Minimize2, X } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { ContextSnapshot } from "../agent/useRightPanelData";
import styles from "./ContextMeter.module.css";

export function ContextMeter({
  context,
  busy,
  onCompress,
}: {
  context: ContextSnapshot | null;
  busy: boolean;
  onCompress: () => Promise<{ ok: boolean; message: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [message, setMessage] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const next = context?.nextBudget;
  const used = next?.selectedInputTokens ?? 0;
  const capacity = next?.contextWindowTokens ?? 0;
  const percent = capacity ? Math.min(100, (used / capacity) * 100) : 0;
  const categories =
    next?.categories ??
    (next
      ? [
          { id: "fixed", label: "系统与工具", tokens: next.fixedInputTokens },
          {
            id: "history",
            label: "对话与工具结果",
            tokens: Math.max(0, used - next.fixedInputTokens),
          },
        ]
      : []);
  const colors = [
    "#8060a2",
    "#ac8dc0",
    "#bca8ce",
    "#839b8f",
    "#94a6bc",
    "#b2a197",
    "#b4b990",
    "#8e909b",
  ];
  const fmt = (n: number) => n.toLocaleString("en-US");
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className={styles.root} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label="上下文占用详情"
        aria-expanded={open}
        aria-controls="context-details"
        title={capacity ? `上下文 ${percent.toFixed(1)}%` : "上下文尚未计算"}
        onClick={() => setOpen(!open)}
      >
        <span
          className={styles.ring}
          role="progressbar"
          aria-label="上下文占用"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={
            capacity ? `${fmt(used)} / ${fmt(capacity)} tokens` : "尚未计算"
          }
          style={{ "--usage": `${percent}%` } as CSSProperties}
        />
      </button>
      {open && (
        <section
          id="context-details"
          className={styles.popover}
          aria-label="上下文详情"
        >
          <header>
            <strong>上下文占用</strong>
            <span>最近上下文 · 估算</span>
            <button
              type="button"
              aria-label="关闭上下文详情"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={15} />
            </button>
          </header>
          <div className={styles.total}>
            <strong>{capacity ? `${percent.toFixed(1)}%` : "—"}</strong>
            <span>{capacity ? `${fmt(used)} tokens` : "等待首次调用"}</span>
          </div>
          <div className={styles.bar} aria-hidden="true">
            {categories.map((c, i) => (
              <span
                key={c.id}
                style={{
                  width: `${capacity ? (c.tokens / capacity) * 100 : 0}%`,
                  background: colors[i % colors.length],
                }}
              />
            ))}
          </div>
          <div className={styles.rows}>
            {categories.map((c, i) => (
              <div key={c.id}>
                <i style={{ background: colors[i % colors.length] }} />
                <span>{c.label}</span>
                <span>{fmt(c.tokens)}</span>
              </div>
            ))}
          </div>
          {next && (
            <div className={styles.capacity}>
              <div>
                <span>模型容量</span>
                <span>{fmt(capacity)} tokens</span>
              </div>
              <div>
                <span>回复预留</span>
                <span>{fmt(next.reservedOutputTokens)} tokens</span>
              </div>
              <div>
                <span>可用余量</span>
                <span>
                  {fmt(
                    Math.max(0, capacity - used - next.reservedOutputTokens),
                  )}{" "}
                  tokens
                </span>
              </div>
            </div>
          )}
          <p role="status">
            {message ||
              (busy
                ? "当前任务执行中，结束后可压缩上下文。"
                : next
                  ? "将较早的内容整理成摘要，保留近期对话与关键证据。"
                  : "开始对话后显示实际调用的上下文占用。")}
          </p>
          <button
            type="button"
            className={styles.compress}
            disabled={busy || compressing || !next}
            aria-busy={compressing}
            onClick={async () => {
              setCompressing(true);
              setMessage("正在整理上下文…");
              try {
                const result = await onCompress();
                setMessage(result.message);
              } catch (error) {
                setMessage(
                  error instanceof Error
                    ? error.message
                    : "压缩失败，请稍后重试。",
                );
              } finally {
                setCompressing(false);
              }
            }}
          >
            <Minimize2 size={15} />
            {compressing ? "正在压缩…" : "压缩上下文"}
          </button>
        </section>
      )}
    </div>
  );
}
