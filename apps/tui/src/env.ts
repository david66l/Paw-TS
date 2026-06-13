/**
 * When truthy, every harness tool (including read/list) prompts for approval in TUI.
 * Example: `PAW_TUI_STRICT_TOOL_APPROVAL=1 bun run tui`
 */
export function tuiStrictToolApprovalFromEnv(): boolean {
  const v = process.env.PAW_TUI_STRICT_TOOL_APPROVAL?.trim().toLowerCase();
  if (!v) {
    return false;
  }
  return v === "1" || v === "true" || v === "yes" || v === "all";
}

/**
 * Override TUI theme detection.
 * Values: "light" | "dark" | "auto" (default).
 * Example: `PAW_TUI_THEME=light bun run tui`
 */
export function tuiThemeFromEnv(): "light" | "dark" | "auto" {
  const v = process.env.PAW_TUI_THEME?.trim().toLowerCase();
  if (v === "light" || v === "dark") {
    return v;
  }
  return "auto";
}
