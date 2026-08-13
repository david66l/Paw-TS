import type { ToolRunResult } from "@paw/harness";

const CONTROL_PLANE_CODES = new Set([
  "E_LOOP_POLICY",
  "E_CODING_PHASE",
  "E_TOOL_POLICY",
  "E_TOOL_EFFECT_POLICY",
]);

/**
 * A control-plane rejection is visible to the model as a failed tool result,
 * but no workspace operation was attempted. It must not become task evidence,
 * long-term failure memory, or an idle-fuse signature.
 */
export function isControlPlaneToolResult(result: ToolRunResult): boolean {
  if (!result.payload || typeof result.payload !== "object") return false;
  const payload = result.payload as Record<string, unknown>;
  const code = payload.code;
  if (code === "E_TOOL_EFFECT_POLICY" && payload.recovered === false) {
    return false;
  }
  return typeof code === "string" && CONTROL_PLANE_CODES.has(code);
}
