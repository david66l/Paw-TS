/** MCP 代理工具。 */
import type { HarnessContext } from "../../context.js";
import type { ToolRunResult } from "../definitions.js";
import { type ToolScope, asRecord } from "../tool-support.js";

/** `workspace.use_mcp` */
export async function handleMcpProxy(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  return executeMcpProxy(ctx, rec);
}

async function executeMcpProxy(
  ctx: HarnessContext,
  args: Record<string, unknown>,
): Promise<ToolRunResult> {
  const provenance = Object.freeze({
    source: "mcp",
    trust: "external_untrusted_data",
    taint: "external_content",
    instructionAuthority: "none",
    permissionAuthority: "none",
  });
  const action = args.action;
  if (action === "search") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const requestedLimit =
      typeof args.limit === "number" && Number.isInteger(args.limit) ? args.limit : 8;
    const limit = Math.min(Math.max(requestedLimit, 1), 20);
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_./:-]+/u)
      .filter((term) => term.length > 0);
    const exact = query.toLowerCase().startsWith("select:")
      ? query.slice("select:".length).trim().toLowerCase()
      : "";
    const allowedTargets = new Set(ctx.mcpAllowedTools ?? []);
    const ranked = (ctx.mcp?.listTools() ?? [])
      .map((candidate) => {
        const id = `mcp:${candidate.serverName}/${candidate.toolName}`;
        const haystack = `${id} ${candidate.description}`.toLowerCase();
        const score =
          exact && id.toLowerCase() === exact
            ? 10_000
            : terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        return { candidate, id, score };
      })
      .filter((entry) => allowedTargets.has(entry.id))
      .filter((entry) => query.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const matches = ranked.slice(0, limit).map(({ candidate, id }) => ({
      id,
      description: candidate.description,
      inputSchema: candidate.inputSchema,
    }));
    return {
      ok: true,
      payload: {
        schemaVersion: "paw.mcp-capability-search.v1",
        provenance,
        query,
        totalMatches: ranked.length,
        returned: matches.length,
        hasMore: ranked.length > matches.length,
        tools: matches,
      },
      summary: `mcp search: ${matches.length}/${ranked.length} tools`,
    };
  }

  if (action === "call") {
    const id = typeof args.tool === "string" ? args.tool.trim() : "";
    const parsed = ctx.mcp?.parseToolId(id);
    if (!ctx.mcp) {
      return {
        ok: false,
        payload: { error: "MCP is not configured" },
        summary: "mcp proxy: no servers configured",
      };
    }
    if (!parsed) {
      return {
        ok: false,
        payload: {
          error: "action=call requires an exact mcp:<server>/<tool> id",
        },
        summary: "mcp proxy: invalid tool id",
      };
    }
    if (!ctx.mcpAllowedTools?.includes(id)) {
      return {
        ok: false,
        payload: { error: `MCP tool is outside the run allowlist: ${id}` },
        summary: "mcp proxy: tool not in allowlist",
      };
    }
    const callArgs = asRecord(args.arguments);
    if (!callArgs) {
      return {
        ok: false,
        payload: { error: "action=call requires object arguments" },
        summary: "mcp proxy: invalid arguments",
      };
    }
    const result = await ctx.mcp.callTool(
      parsed.serverName,
      parsed.toolName,
      callArgs,
      ctx.abortSignal ? { signal: ctx.abortSignal } : undefined,
    );
    return {
      ...result,
      payload: {
        schemaVersion: "paw.mcp-capability-result.v1",
        provenance,
        tool: id,
        content: result.payload,
      },
    };
  }

  return {
    ok: false,
    payload: { error: "action must be search or call" },
    summary: "mcp proxy: invalid action",
  };
}
