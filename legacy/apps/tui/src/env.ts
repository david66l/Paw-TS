/**
 * TUI 环境变量读取工具。
 *
 * 集中处理与终端交互应用相关的环境开关，例如严格工具审批、主题覆盖等。
 */

/**
 * 是否启用严格工具审批模式。
 *
 * 当返回 true 时，所有 harness 工具（包括 read_file / list_dir 等只读工具）
 * 都会在执行前弹出 y/n 审批提示。
 *
 * 示例：`PAW_TUI_STRICT_TOOL_APPROVAL=1 bun run tui`
 */
export function tuiStrictToolApprovalFromEnv(): boolean {
  const v = process.env.PAW_TUI_STRICT_TOOL_APPROVAL?.trim().toLowerCase();
  if (!v) {
    return false;
  }
  return v === "1" || v === "true" || v === "yes" || v === "all";
}

/**
 * 从环境变量读取 TUI 主题覆盖。
 *
 * 可选值："light" | "dark" | "auto"（默认自动检测终端调色板）。
 *
 * 示例：`PAW_TUI_THEME=light bun run tui`
 */
export function tuiThemeFromEnv(): "light" | "dark" | "auto" {
  const v = process.env.PAW_TUI_THEME?.trim().toLowerCase();
  if (v === "light" || v === "dark") {
    return v;
  }
  return "auto";
}
