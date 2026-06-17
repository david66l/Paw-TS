import { readSetting } from "./settings.js";

const DEFAULT_MAX_STEPS = 32;
const HARD_CAP = 256;

function parseMaxSteps(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 1
  ) {
    return Math.min(Math.floor(value), HARD_CAP);
  }
  return undefined;
}

/**
 * Effective model↔tool rounds: explicit spec wins, else settings, else default.
 */
export function resolveMaxSteps(
  workspaceRoot: string,
  override?: number,
): number {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override < 1) {
      return DEFAULT_MAX_STEPS;
    }
    return Math.min(Math.floor(override), HARD_CAP);
  }
  return readSetting(
    workspaceRoot,
    (s) => s.max_steps,
    DEFAULT_MAX_STEPS,
    parseMaxSteps,
  );
}
