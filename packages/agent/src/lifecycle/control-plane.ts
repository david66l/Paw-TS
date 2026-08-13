import type { ToolRunResult } from "@paw/harness";

const CONTROL_PLANE_CODES = new Set([
  "E_LOOP_POLICY",
  "E_CODING_PHASE",
  "E_TOOL_POLICY",
]);

/**
 * A control-plane rejection is visible to the model as a failed tool result,
 * but no workspace operation was attempted. It must not become task evidence,
 * long-term failure memory, or an idle-fuse signature.
 */
export function isControlPlaneToolResult(result: ToolRunResult): boolean {
  if (!result.payload || typeof result.payload !== "object") return false;
  const code = (result.payload as Record<string, unknown>).code;
  return typeof code === "string" && CONTROL_PLANE_CODES.has(code);
}
