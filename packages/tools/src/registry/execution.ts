import type { HarnessContext } from "../context.js";
import type { ToolRunResult } from "./definitions.js";
import { TOOL_HANDLERS } from "./handlers/index.js";
import { asRecord, validateToolArguments } from "./tool-support.js";

export { validateToolArguments } from "./tool-support.js";

/**
 * Validate the arguments, then dispatch to the handler for this tool.
 *
 * The per-tool bodies live in `./handlers/`, grouped by domain. Each handler is
 * typed `Promise<ToolRunResult>`, so a handler whose control flow can leave
 * without returning is a compile error rather than a silent fall-through to the
 * unknown-tool branch below.
 *
 * `validateToolArguments` is re-exported above: it is part of the harness surface
 * and used to be declared in this file.
 */
export async function executeTool(
  ctx: HarnessContext,
  tool: string,
  args: unknown,
): Promise<ToolRunResult> {
  const schemaError = validateToolArguments(tool, args);
  if (schemaError) {
    return schemaError;
  }

  const rec = asRecord(args) ?? {};

  const handler = TOOL_HANDLERS[tool];
  if (handler) return handler({ ctx, rec, tool, args });
  return {
    ok: false,
    payload: { error: `unknown tool: ${tool}` },
    summary: `unknown tool: ${tool}`,
  };
}
