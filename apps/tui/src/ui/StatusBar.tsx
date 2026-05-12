import path from "node:path";
import { Box, Text } from "ink";

import { theme } from "./themes.js";

export interface CostHud {
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

export interface StatusHud {
  readonly cwd: string;
  readonly modelLabel: string | null;
  readonly turn: number | null;
  readonly maxSteps: number | null;
  readonly phase: string | null;
  /** Actual token/cost snapshot from {@link CostTracker}. */
  readonly cost: CostHud | null;
}

function formatPhase(phase: string | null): string {
  const p = phase ?? "idle";
  switch (p) {
    case "reply":
      return "await reply";
    case "approval":
      return "await approval (y/n)";
    case "approval:denied":
      return "denied";
    default:
      return p;
  }
}

function formatCost(cost: CostHud | null): string {
  if (!cost) return "— tok";
  const tok = cost.totalTokens.toLocaleString();
  const usd =
    cost.estimatedCostUsd < 0.0001
      ? "~$0"
      : `~$${cost.estimatedCostUsd.toFixed(4)}`;
  return `${tok} tok · ${usd}`;
}

/** RFC §25 Phase D — bottom status strip. */
export function StatusBar({ hud }: { readonly hud: StatusHud }) {
  const dir = path.basename(hud.cwd);
  const turn =
    hud.turn !== null && hud.maxSteps !== null
      ? `${hud.turn}/${hud.maxSteps}`
      : "—";
  const model = hud.modelLabel ?? "—";
  const phase = formatPhase(hud.phase);
  const cost = formatCost(hud.cost);

  return (
    <Box justifyContent="space-between" width="100%">
      <Text dimColor color={theme.muted}>
        <Text bold color={theme.accent}>
          paw
        </Text>
        {" · "}
        {model}
        {" · "}
        turn {turn}
        {" · "}
        {cost}
        {" · "}
        {phase}
      </Text>
      <Text dimColor>{dir}</Text>
    </Box>
  );
}
