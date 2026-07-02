/** 上下文预算 HUD 数据结构。 */
export interface ContextBudgetHud {
  readonly historyUsed: number;
  readonly historyBudget: number;
  readonly systemUsed: number;
  readonly systemBudget: number;
  readonly historyOverBudget: boolean;
  readonly systemOverBudget: boolean;
}

/** 底部状态栏聚合所需的核心 HUD 数据。 */
export interface HudState {
  readonly modelLabel: string | null;
  readonly turn: number | null;
  readonly maxSteps: number | null;
  readonly phase: string | null;
  readonly tokens: number | null;
  readonly contextBudget: ContextBudgetHud | null;
  readonly costDetail: CostDetail | null;
  readonly elapsedMs: number | null;
}

/** Token 消耗与成本明细。 */
export interface CostDetail {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
  readonly costCurrency?: "CNY" | "USD";
  readonly cachedPromptTokens?: number;
  readonly turnPromptTokens?: number;
  readonly turnCompletionTokens?: number;
}

/** 审批对话框的键盘动作。 */
export type ApprovalKeyAction =
  | "approve"
  | "confirm"
  | "deny"
  | "select-allow"
  | "select-deny";

/** 简化的按键描述。 */
export interface KeyLike {
  readonly name: string;
  readonly ctrl?: boolean;
}

/** 底部状态栏芯片颜色。 */
export type BottomBarChipColor =
  | "success"
  | "info"
  | "warning"
  | "error"
  | "highlight"
  | "muted";

/** 底部状态栏芯片。 */
export interface BottomBarChip {
  readonly text: string;
  readonly color: BottomBarChipColor;
}

// ── Footer 布局常量 ──

export const HUD_ROWS = 1;
export const CONTEXT_BAR_ROWS = 1;
export const BOTTOM_BAR_ROWS = 2;
export const STREAM_PREVIEW_ROWS = 4;
export const APPROVAL_ROWS = 5;
export const ASK_ROWS = 3;
export const TEXTAREA_MIN_ROWS = 1;
export const TEXTAREA_MAX_ROWS = 6;
