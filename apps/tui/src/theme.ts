/**
 * Paw TUI 主题定义。
 *
 * 提供受 DeepSeek 启发的浅色/深色调色板，并支持：
 * - 环境变量强制指定主题（PAW_TUI_THEME）
 * - 自动检测终端背景亮度
 */

import { type CliRenderer, type ColorInput, RGBA } from "@opentui/core";
import { tuiThemeFromEnv } from "./env.js";

/** Paw TUI 使用的完整主题色板。 */
export type PawTheme = {
  background: ColorInput;      // 主背景色
  footerBg: ColorInput;        // 底部状态栏背景
  surface: ColorInput;         // 输入框/卡片表面色
  pane: ColorInput;            // 流预览/审批面板背景
  border: ColorInput;          // 分隔线颜色
  highlight: ColorInput;       // 高亮色
  text: ColorInput;            // 主文本色
  muted: ColorInput;           // 次要/灰色文本
  inverseText: ColorInput;     // 反色文本
  success: ColorInput;         // 成功状态
  error: ColorInput;           // 错误状态
  warning: ColorInput;         // 警告状态
  info: ColorInput;            // 信息提示
  brand: ColorInput;           // 品牌色
  diffAdded: ColorInput;       //  diff 新增
  diffRemoved: ColorInput;     //  diff 删除
  selectionBg: ColorInput;     // 选区背景
  placeholder: ColorInput;     // 占位符文本
  userText: ColorInput;        // 用户输入文本
  assistantText: ColorInput;   // 助手回复文本
  systemText: ColorInput;      // 系统消息文本
  toolText: ColorInput;        // 工具调用文本
  errorText: ColorInput;       // 错误文本
};

/** 将十六进制颜色字符串转换为 RGBA 对象。 */
function hexToRgba(hex: string): RGBA {
  return RGBA.fromHex(hex);
}

/**
 * 根据背景色亮度判断是否为暗色主题。
 *
 * 使用标准亮度公式：Y = 0.299R + 0.587G + 0.114B
 */
function isDark(bg: RGBA): boolean {
  const lum = 0.299 * bg.r * 255 + 0.587 * bg.g * 255 + 0.114 * bg.b * 255;
  return lum < 128;
}

/** 浅色主题色板。 */
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

/** 深色主题色板。 */
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

/**
 * 解析当前应使用的主题。
 *
 * 优先级：
 * 1. 环境变量 PAW_TUI_THEME 强制指定；
 * 2. renderer 报告的 themeMode；
 * 3. 采样终端调色板，根据背景亮度自动推断；
 * 4. 兜底返回深色主题。
 *
 * @param renderer OpenTUI 渲染器
 */
export async function resolveTheme(renderer: CliRenderer): Promise<PawTheme> {
  const envTheme = tuiThemeFromEnv();
  if (envTheme === "light") return lightTheme;
  if (envTheme === "dark") return darkTheme;

  try {
    const mode = renderer.themeMode;
    if (mode === "light") return lightTheme;
    if (mode === "dark") return darkTheme;

    // 读取终端调色板并判断背景亮度
    const colors = await renderer.getPalette({ size: 16 });
    const bgHex = colors.defaultBackground ?? colors.palette[0];
    if (bgHex) {
      const bg = hexToRgba(bgHex);
      return isDark(bg) ? darkTheme : lightTheme;
    }
  } catch {
    /* 无法检测时继续兜底 */
  }

  return darkTheme;
}

/** 兜底主题：当自动检测失败时使用深色主题。 */
export const fallbackTheme: PawTheme = darkTheme;
export { darkTheme, lightTheme };
