import { sha256Canonical } from "./canonical.js";

/**
 * Bounded, order-agnostic task projection for auxiliary model calls.
 *
 * Coding goals commonly put host rules and named tests first and the actual
 * issue/reproduction last. A prefix slice therefore deletes the semantic task
 * on long benchmark contracts. Preserve both ends and make the omission
 * explicit instead of pretending that the projection is complete.
 */
export function projectAuxiliaryGoalV1(goal: string, maxChars: number): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 512) {
    throw new Error("Auxiliary goal maxChars must be at least 512");
  }
  if (goal.length <= maxChars) return goal;

  const omittedHash = sha256Canonical({ goal });
  const marker = `\n... [middle of task goal omitted; fullChars=${goal.length}; sha256=${omittedHash}] ...\n`;
  const available = maxChars - marker.length;
  const headChars = Math.floor(available * 0.4);
  const tailChars = available - headChars;
  return `${goal.slice(0, headChars)}${marker}${goal.slice(-tailChars)}`;
}
