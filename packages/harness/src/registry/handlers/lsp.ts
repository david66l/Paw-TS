import path from "node:path";
/** 代码智能类工具（lsp/symbol_search）。 */
import { LspClient, detectLspCommand, searchWorkspaceSymbols } from "@paw/workspace";
import type { ToolRunResult } from "../definitions.js";
import { type ToolScope, num } from "../tool-support.js";

/** `workspace.lsp` */
export async function handleLsp(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const filePath = typeof rec.file === "string" ? rec.file : "";
  const method = typeof rec.method === "string" ? rec.method : "hover";
  const line = num(rec.line, undefined) ?? 0;
  const character = num(rec.character, undefined) ?? 0;
  if (!filePath) {
    return {
      ok: false,
      payload: { error: "missing file" },
      summary: "lsp: missing file",
    };
  }
  const cmd = detectLspCommand(filePath);
  if (!cmd) {
    return {
      ok: false,
      payload: { error: `no LSP server known for ${path.extname(filePath)}` },
      summary: `lsp: no LSP server for ${path.extname(filePath)}`,
    };
  }
  const client = new LspClient(ctx.workspaceRoot);
  try {
    await client.start({
      command: cmd.command,
      args: cmd.args,
      cwd: ctx.workspaceRoot,
    });
    let result: unknown;
    switch (method) {
      case "hover":
        result = await client.hover(filePath, line, character);
        break;
      case "definition":
        result = await client.definition(filePath, line, character);
        break;
      case "references":
        result = await client.references(filePath, line, character);
        break;
      case "completion":
        result = await client.completion(filePath, line, character);
        break;
      default:
        return {
          ok: false,
          payload: { error: `unknown LSP method: ${method}` },
          summary: `lsp: unknown method ${method}`,
        };
    }
    return {
      ok: true,
      payload: result,
      summary: `lsp: ${method} on ${filePath}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      payload: { error: msg },
      summary: `lsp: ${msg}`,
    };
  } finally {
    await client.stop();
  }
}

/** `workspace.symbol_search` */
export async function handleSymbolSearch(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const query = typeof rec.query === "string" ? rec.query : "";
  if (!query.trim()) {
    return {
      ok: false,
      payload: { error: "missing query" },
      summary: "symbol_search: missing query",
    };
  }
  const maxResults = num(rec.max_results, undefined) ?? num(rec.maxResults, undefined) ?? 20;
  const r = searchWorkspaceSymbols(ctx.workspaceRoot, query, { maxResults });
  if (r.error) {
    return { ok: false, payload: r, summary: `symbol_search: ${r.error}` };
  }
  const totalSymbols = r.matches?.reduce((sum, m) => sum + m.symbols.length, 0) ?? 0;
  const tail = r.truncated ? " (truncated)" : "";
  return {
    ok: true,
    payload: r,
    summary: `symbol_search: ${totalSymbols} symbol(s) in ${r.matches?.length ?? 0} file(s)${tail}`,
  };
}
