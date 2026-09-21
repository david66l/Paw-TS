import { type ToolErrorCode, makeToolError } from "@paw/core";
import { fetchWebPage, searchWeb } from "@paw/workspace";
/** shell 与网络类工具（run_shell/web_fetch/web_search/browser_check）。 */
import {
  type RunShellResult,
  interpretShellExitCode,
  runShellInWorkspace,
  runShellInWorkspaceStreaming,
} from "../../shell/index.js";
import { captureWorkspaceRevision, compareWorkspaceRevisions } from "../../workspace-revision.js";
import type { ToolRunResult } from "../definitions.js";
import { type ToolScope, errorCodeForToolPayload, num, toolErrorResult } from "../tool-support.js";

/** `workspace.browser_check` */
export async function handleBrowserCheck(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, args } = scope;
  if (!ctx.browserCheck)
    return {
      ok: false,
      summary: "Browser verification is unavailable",
      payload: { code: "E_POLICY_DENIED" },
    };
  return ctx.browserCheck(args, ctx.abortSignal);
}

/** `workspace.run_shell` */
export async function handleShell(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec, tool } = scope;
  const cmd = typeof rec.command === "string" ? rec.command : "";
  if (!cmd.trim()) {
    return toolErrorResult("run_shell", "E_USER", "missing command", {
      field: "command",
    });
  }
  const cwd = typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd : undefined;
  const timeoutSec = num(rec.timeout_sec, undefined) ?? num(rec.timeoutSec, undefined);
  const timeoutMs =
    timeoutSec !== undefined && Number.isFinite(timeoutSec)
      ? Math.floor(timeoutSec * 1000)
      : undefined;
  const shellOpts = {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(ctx.shellSandbox ? { shellSandbox: ctx.shellSandbox } : {}),
    ...(ctx.shellCommandPreApproved ? { skipApprovalGate: true } : {}),
    ...(ctx.abortSignal ? { signal: ctx.abortSignal } : {}),
  };
  const onChunk = ctx.onShellChunk;
  const before = await captureWorkspaceRevision(ctx.workspaceRoot);
  const r =
    onChunk || ctx.abortSignal
      ? await runShellInWorkspaceStreaming(ctx.workspaceRoot, cmd, {
          ...shellOpts,
          ...(onChunk
            ? {
                onChunk: (chunk: string, isStderr: boolean) => onChunk(tool, chunk, isStderr),
              }
            : {}),
        })
      : runShellInWorkspace(ctx.workspaceRoot, cmd, shellOpts);
  const workspaceEffect = compareWorkspaceRevisions(
    before,
    await captureWorkspaceRevision(ctx.workspaceRoot),
  );
  if (r.error) {
    const msg = r.timed_out ? "timeout" : r.error;
    const code: ToolErrorCode = r.timed_out
      ? "E_RETRY"
      : r.requiresApproval
        ? "E_POLICY_DENIED"
        : errorCodeForToolPayload(r);
    return {
      ...toolErrorResult("run_shell", code, msg),
      payload: { ...r, ...makeToolError(code, msg), workspaceEffect },
    };
  }
  const code = r.exit_code ?? "?";
  const interpretation = interpretShellExitCode(cmd, r.exit_code);
  const enriched: RunShellResult = {
    ...r,
    interpretation: interpretation.message,
  };
  const isError = interpretation.isError && r.exit_code !== 0;
  const summary =
    isError && interpretation.message
      ? `run_shell: exit ${code} — ${interpretation.message}`
      : `run_shell: exit ${code}`;
  return {
    ok: !isError,
    payload: { ...enriched, workspaceEffect },
    summary,
  };
}

/** `workspace.web_fetch` */
export async function handleWebFetch(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const url = typeof rec.url === "string" ? rec.url : "";
  const maxLength = num(rec.max_length, undefined) ?? num(rec.maxLength, undefined);
  if (ctx.webAccess) {
    const outcome = await ctx.webAccess.fetch(
      { url, ...(maxLength === undefined ? {} : { maxLength }) },
      ctx.abortSignal,
    );
    if (!outcome.ok) {
      return {
        ok: false,
        payload: { error: outcome.reason },
        summary: `web_fetch: ${outcome.reason}`,
      };
    }
    return {
      ok: true,
      payload: outcome.value,
      summary: `web_fetch: ${outcome.value.title ?? outcome.value.finalUrl} (${outcome.value.content.length} chars)`,
    };
  }
  const r = await fetchWebPage({
    url,
    ...(maxLength !== undefined ? { maxLength } : {}),
  });
  if (r.error) {
    return { ok: false, payload: r, summary: `web_fetch: ${r.error}` };
  }
  const len = r.content?.length ?? 0;
  return {
    ok: true,
    payload: r,
    summary: `web_fetch: ${r.title ?? url} (${len} chars)`,
  };
}

/** `workspace.web_search` */
export async function handleWebSearch(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const query = typeof rec.query === "string" ? rec.query : "";
  if (!query.trim()) {
    return {
      ok: false,
      payload: { error: "missing query" },
      summary: "web_search: missing query",
    };
  }
  const maxResults = num(rec.max_results, undefined) ?? num(rec.maxResults, undefined);
  if (ctx.webAccess) {
    const outcome = await ctx.webAccess.search(
      { query, ...(maxResults === undefined ? {} : { maxResults }) },
      ctx.abortSignal,
    );
    if (!outcome.ok) {
      return {
        ok: false,
        payload: { error: outcome.reason },
        summary: `web_search: ${outcome.reason}`,
      };
    }
    return {
      ok: true,
      payload: outcome.value,
      summary: `web_search: ${outcome.value.results.length} result(s)`,
    };
  }
  const r = await searchWeb({
    query,
    ...(maxResults !== undefined ? { maxResults } : {}),
  });
  if (r.error) {
    return { ok: false, payload: r, summary: `web_search: ${r.error}` };
  }
  const n = r.results?.length ?? 0;
  return {
    ok: true,
    payload: r,
    summary: `web_search: ${n} result(s)`,
  };
}
