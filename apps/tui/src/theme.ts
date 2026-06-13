/**
 * Paw TUI theme — DeepSeek-inspired palette.
 */

import { type CliRenderer, type ColorInput, RGBA } from "@opentui/core";
import { tuiThemeFromEnv } from "./env.js";

export type PawTheme = {
  background: ColorInput;
  footerBg: ColorInput;
  surface: ColorInput;
  pane: ColorInput;
  border: ColorInput;
  highlight: ColorInput;
  text: ColorInput;
  muted: ColorInput;
  inverseText: ColorInput;
  success: ColorInput;
  error: ColorInput;
  warning: ColorInput;
  info: ColorInput;
  brand: ColorInput;
  diffAdded: ColorInput;
  diffRemoved: ColorInput;
  selectionBg: ColorInput;
  placeholder: ColorInput;
  userText: ColorInput;
  assistantText: ColorInput;
  systemText: ColorInput;
  toolText: ColorInput;
  errorText: ColorInput;
};

function hexToRgba(hex: string): RGBA {
  return RGBA.fromHex(hex);
}

function isDark(bg: RGBA): boolean {
  const lum = 0.299 * bg.r * 255 + 0.587 * bg.g * 255 + 0.114 * bg.b * 255;
  return lum < 128;
}

const lightTheme: PawTheme = {
  background: hexToRgba("#f6f8fb"),
  footerBg: hexToRgba("#ecf2f8"),
  surface: hexToRgba("#ecf2f8"),
  pane: hexToRgba("#dbe5f0"),
  border: hexToRgba("#8ba1b8"),
  highlight: hexToRgba("#3578e5"),
  text: hexToRgba("#0f172a"),
  muted: hexToRgba("#64748b"),
  inverseText: hexToRgba("#ffffff"),
  success: hexToRgba("#15803d"),
  error: hexToRgba("#e25060"),
  warning: hexToRgba("#b45309"),
  info: hexToRgba("#3578e5"),
  brand: hexToRgba("#3578e5"),
  diffAdded: hexToRgba("#22c55e"),
  diffRemoved: hexToRgba("#ef4444"),
  selectionBg: hexToRgba("#cfe0f7"),
  placeholder: hexToRgba("#94a3b8"),
  userText: hexToRgba("#3578e5"),
  assistantText: hexToRgba("#0f172a"),
  systemText: hexToRgba("#64748b"),
  toolText: hexToRgba("#1e293b"),
  errorText: hexToRgba("#e25060"),
};

const darkTheme: PawTheme = {
  background: hexToRgba("#0b1526"),
  footerBg: hexToRgba("#101c30"),
  surface: hexToRgba("#121c2e"),
  pane: hexToRgba("#182338"),
  border: hexToRgba("#2a4a7f"),
  highlight: hexToRgba("#3578e5"),
  text: hexToRgba("#e2e8f0"),
  muted: hexToRgba("#b1becf"),
  inverseText: hexToRgba("#0b1526"),
  success: hexToRgba("#34d399"),
  error: hexToRgba("#e25060"),
  warning: hexToRgba("#f59e0b"),
  info: hexToRgba("#6aaef2"),
  brand: hexToRgba("#3578e5"),
  diffAdded: hexToRgba("#22c55e"),
  diffRemoved: hexToRgba("#ef4444"),
  selectionBg: hexToRgba("#1e3a5f"),
  placeholder: hexToRgba("#8797ab"),
  userText: hexToRgba("#6aaef2"),
  assistantText: hexToRgba("#e2e8f0"),
  systemText: hexToRgba("#b1becf"),
  toolText: hexToRgba("#d9e2ee"),
  errorText: hexToRgba("#e25060"),
};

export async function resolveTheme(renderer: CliRenderer): Promise<PawTheme> {
  const envTheme = tuiThemeFromEnv();
  if (envTheme === "light") return lightTheme;
  if (envTheme === "dark") return darkTheme;

  try {
    const mode = renderer.themeMode;
    if (mode === "light") return lightTheme;
    if (mode === "dark") return darkTheme;

    const colors = await renderer.getPalette({ size: 16 });
    const bgHex = colors.defaultBackground ?? colors.palette[0];
    if (bgHex) {
      const bg = hexToRgba(bgHex);
      return isDark(bg) ? darkTheme : lightTheme;
    }
  } catch {
    /* fall through */
  }

  return darkTheme;
}

export const fallbackTheme: PawTheme = darkTheme;
export { darkTheme, lightTheme };
