import { useEffect } from "react";
import styles from "./SettingsModal.module.css";

export type SettingsModalProps = {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly colorTheme: "calm" | "aurora";
  readonly onColorThemeChange: (theme: "calm" | "aurora") => void;
  readonly materialTheme: "soft" | "lens";
  readonly onMaterialThemeChange: (theme: "soft" | "lens") => void;
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
 * 设置弹窗。目前只有「外观」——配色 / 材质（从侧栏搬入）。
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.overlay}>
      <button
        type="button"
        className={styles.backdrop}
        aria-label="关闭设置"
        onClick={onClose}
      />
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <header className={styles.header}>
          <span className={styles.title}>设置</span>
          <button
            type="button"
            className={styles.close}
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className={styles.body}>
          <section className={styles.section}>
            <div className={styles.sectionTitle}>模型</div>

            <div className={styles.row}>
              <div className={styles.rowText}>
                <div className={styles.rowLabel}>模型预设</div>
                <div className={styles.rowDesc}>
                  切换 settings.local.json 里的 provider
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
                <div className={styles.rowDesc}>
                  修改性工具（写文件 / 编辑 / shell）是否需要逐条确认
                </div>
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
                <div className={styles.rowLabel}>配色</div>
                <div className={styles.rowDesc}>界面主色调</div>
              </div>
              <Segmented
                value={colorTheme}
                options={[
                  ["calm", "静谧"],
                  ["aurora", "极光"],
                ]}
                onChange={(v) => onColorThemeChange(v as "calm" | "aurora")}
              />
            </div>

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
                onChange={(v) => onMaterialThemeChange(v as "soft" | "lens")}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
