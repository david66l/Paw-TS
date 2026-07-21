import type { CSSProperties, ReactNode } from "react";
import styles from "./GlassPanel.module.css";

export type GlassPanelProps = {
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** strong = 更不透明，适合主内容卡片 */
  readonly variant?: "default" | "strong" | "subtle";
  readonly padding?: "none" | "sm" | "md" | "lg";
};

export function GlassPanel({
  children,
  className,
  style,
  variant = "default",
  padding = "md",
}: GlassPanelProps) {
  const cls = [
    styles.panel,
    styles[`variant_${variant}`],
    styles[`pad_${padding}`],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} style={style}>
      {children}
    </div>
  );
}
