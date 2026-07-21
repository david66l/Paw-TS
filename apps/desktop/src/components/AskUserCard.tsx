import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import styles from "./AskUserCard.module.css";

/**
 * ask_user 内联提问卡：模型主动向用户要输入时渲染在聊天区底部。
 * 回答后由 useAgentRun 沉淀为「系统问题条 + 用户气泡」进聊天流。
 */
export function AskUserCard({
  question,
  timeoutSec,
  onSubmit,
}: {
  question: string;
  timeoutSec: number | null;
  onSubmit: (answer: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 提问出现时自动聚焦，减少一次点击
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    onSubmit(t);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className={styles.card} role="alertdialog" aria-label="Paw 的提问">
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden>
          🐾
        </span>
        <span className={styles.title}>Paw 想问你</span>
        {timeoutSec ? (
          <span className={styles.timeout}>参考限时 {timeoutSec}s</span>
        ) : null}
      </div>

      <div className={styles.question}>{question}</div>

      <textarea
        ref={inputRef}
        className={styles.input}
        rows={2}
        placeholder="输入回答，Enter 提交，Shift+Enter 换行"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.submitBtn}
          disabled={!draft.trim()}
          onClick={submit}
        >
          回答
        </button>
      </div>
    </div>
  );
}
