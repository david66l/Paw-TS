import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ColorTheme, MaterialTheme } from "../styles/appearance";
import styles from "./SettingsModal.module.css";

export type SettingsModalProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly colorTheme: ColorTheme;
  readonly onColorThemeChange: (theme: ColorTheme) => void;
  readonly materialTheme: MaterialTheme;
  readonly onMaterialThemeChange: (theme: MaterialTheme) => void;
  /** 模型预设（来自 settings.local.json 的 models） */
  readonly modelPresets: readonly { id: string; model: string }[];
  readonly provider?: string;
  readonly onProviderChange: (id: string) => void;
  readonly approvalMode: "ask" | "auto";
  readonly onApprovalModeChange: (mode: "ask" | "auto") => void;
};

/** 分段选择器：复用主题切换的视觉。value 用字符串，父层做窄类型转换。 */
function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.segmented}>
      {options.map(([val, label]) => (
        <button
          key={val}
          type="button"
          className={value === val ? styles.segActive : styles.seg}
          aria-pressed={value === val}
          onClick={() => onChange(val)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * 设置弹窗：模型、工具审批与外观。
 * 布局参考 Codex 设置面板：分组 + 每行「左标签/说明 · 右控件」。
 * 关闭：× 按钮 / 点击遮罩（真实 button）/ Esc。
 */
export function SettingsModal({
  open,
  onClose,
  colorTheme,
  onColorThemeChange,
  materialTheme,
  onMaterialThemeChange,
  modelPresets,
  provider,
  onProviderChange,
  approvalMode,
  onApprovalModeChange,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const controls = [
          ...(dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),select:not(:disabled),input:not(:disabled)",
          ) ?? []),
        ];
        if (e.shiftKey && document.activeElement === controls[0]) {
          e.preventDefault();
          controls.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === controls.at(-1)) {
          e.preventDefault();
          controls[0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.overlay}>
      <button type="button" className={styles.backdrop} aria-label="关闭设置" onClick={onClose} />
      <dialog ref={dialogRef} className={styles.dialog} open aria-modal="true" aria-label="设置">
        <header className={styles.header}>
          <span className={styles.title}>设置</span>
          <button type="button" className={styles.close} aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <div className={styles.sectionTitle}>模型</div>

            <div className={`${styles.row} ${styles.modelRow}`}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>模型预设</div>
                <div className={styles.rowDesc}>
                  当前模型：
                  {modelPresets.find((p) => p.id === provider)?.model || "未选择"}
                </div>
              </div>
              <Segmented
                value={provider ?? ""}
                options={modelPresets.map((p) => [p.id, p.id] as const)}
                onChange={onProviderChange}
              />
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}>工具审批</div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>审批模式</div>
                <div className={styles.rowDesc}>控制修改文件、运行命令前的确认</div>
              </div>
              <Segmented
                value={approvalMode}
                options={[
                  ["ask", "逐条询问"],
                  ["auto", "自动批准"],
                ]}
                onChange={(v) => onApprovalModeChange(v as "ask" | "auto")}
              />
            </div>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionTitle}>外观</div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>皮肤</div>
                <div className={styles.rowDesc}>选择你的工作氛围</div>
              </div>
            </div>
            <fieldset className={styles.skinGrid} aria-label="界面皮肤">
              {(
                [
                  ["calm", "静谧", "轻盈 · 清透"],
                  ["aurora", "极光", "流光 · 玻璃"],
                  ["paper", "纸间 · Louis", "暖纸 · 薰衣草"],
                ] as const
              ).map(([id, label, description]) => (
                <button
                  key={id}
                  type="button"
                  className={styles.skinCard}
                  aria-pressed={colorTheme === id}
                  onClick={() => onColorThemeChange(id)}
                >
                  <span className={styles.skinPreview} data-skin={id} aria-hidden="true">
                    <span className={styles.previewSidebar} />
                    <span className={styles.previewPage}>
                      <span />
                      <span />
                      <span />
                    </span>
                    <span className={styles.previewAccent} />
                  </span>
                  <span className={styles.skinName}>{label}</span>
                  <span className={styles.skinDescription}>{description}</span>
                </button>
              ))}
            </fieldset>

            {colorTheme === "paper" ? (
              <p className={styles.skinNote}>
                暖白、薰衣草紫与清晰的内容层级。外观选择会自动保存。
              </p>
            ) : (
              <div className={styles.row}>
                <div className={styles.rowText}>
                  <div className={styles.rowLabel}>材质</div>
                  <div className={styles.rowDesc}>玻璃质感</div>
                </div>
                <Segmented
                  value={materialTheme}
                  options={[
                    ["soft", "柔雾"],
                    ["lens", "折光"],
                  ]}
                  onChange={(v) => onMaterialThemeChange(v as MaterialTheme)}
                />
              </div>
            )}
          </section>
        </div>
      </dialog>
    </div>
  );
}
