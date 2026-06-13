import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";

const DEFAULT_MAX_STEPS = 32;
const HARD_CAP = 256;

/** Effective model↔tool rounds: explicit spec wins, else settings, else default. */
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
  try {
    const s = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));
    const m = s.max_steps;
    if (typeof m === "number" && Number.isFinite(m) && m >= 1) {
      return Math.min(Math.floor(m), HARD_CAP);
    }
  } catch {
    /* no settings file */
  }
  return DEFAULT_MAX_STEPS;
}
