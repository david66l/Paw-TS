import { describe, expect, test } from "bun:test";

import type { WebAccessServiceV1 } from "../src/context.js";
import { executeTool } from "../src/registry/index.js";

/**
 * `workspace.web_fetch` 与 `workspace.web_search` 是 §D9 里"无测试的工具 id"中的两个。
 *
 * 两者都有 `ctx.webAccess` 的**注入路径**，所以用例完全不碰网络：只要注入了
 * service，处理器就不会走 `fetchWebPage`/`searchWeb` 那条真实请求的兜底。
 * （这也意味着**桩是必需的** —— 不注入就等于发真实请求，测试里绝不能那么写。）
 *
 * 两条工具的错误形态与文件类工具不同：`web_search` 对空白 query 走的是**裸
 * payload**（无 `error_code`），见 §11.32 记的那类不一致。
 */

interface FetchCall {
  readonly url: string;
  readonly maxLength?: number;
  readonly signal?: AbortSignal;
}
interface SearchCall {
  readonly query: string;
  readonly maxResults?: number;
  readonly signal?: AbortSignal;
}

function webAccessStub(
  outcome: { fetch?: unknown; search?: unknown },
  calls: { fetch?: FetchCall[]; search?: SearchCall[] } = {},
): WebAccessServiceV1 {
  return {
    fetch: async (input: FetchCall, signal?: AbortSignal) => {
      if (!calls.fetch) calls.fetch = [];
      calls.fetch.push({ ...input, ...(signal ? { signal } : {}) });
      return outcome.fetch;
    },
    search: async (input: SearchCall, signal?: AbortSignal) => {
      if (!calls.search) calls.search = [];
      calls.search.push({ ...input, ...(signal ? { signal } : {}) });
      return outcome.search;
    },
  } as unknown as WebAccessServiceV1;
}

const WORKSPACE = { workspaceRoot: "/tmp" };

describe("workspace.web_fetch", () => {
  test("an omitted url is refused by the schema", async () => {
    const r = await executeTool(WORKSPACE, "workspace.web_fetch", {});
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error_code).toBe("E_SCHEMA_INVALID");
    expect((r.payload as Record<string, unknown>).field).toBe("url");
  });

  test("a failed fetch reports the reason verbatim", async () => {
    const r = await executeTool(
      { ...WORKSPACE, webAccess: webAccessStub({ fetch: { ok: false, reason: "blocked host" } }) },
      "workspace.web_fetch",
      { url: "https://example.test/a" },
    );
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe("blocked host");
    expect(r.summary).toBe("web_fetch: blocked host");
  });

  test("a successful fetch summarises by title and content length", async () => {
    const value = { title: "Example", finalUrl: "https://example.test/a", content: "0123456789" };
    const r = await executeTool(
      { ...WORKSPACE, webAccess: webAccessStub({ fetch: { ok: true, value } }) },
      "workspace.web_fetch",
      { url: "https://example.test/a" },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("web_fetch: Example (10 chars)");
    expect(r.payload).toBe(value);
  });

  test("without a title the summary falls back to the final url", async () => {
    const value = { finalUrl: "https://example.test/redirected", content: "abc" };
    const r = await executeTool(
      { ...WORKSPACE, webAccess: webAccessStub({ fetch: { ok: true, value } }) },
      "workspace.web_fetch",
      { url: "https://example.test/a" },
    );
    expect(r.summary).toBe("web_fetch: https://example.test/redirected (3 chars)");
  });

  test("max_length is forwarded to the service as maxLength", async () => {
    const calls: { fetch?: FetchCall[] } = {};
    await executeTool(
      {
        ...WORKSPACE,
        webAccess: webAccessStub(
          { fetch: { ok: true, value: { finalUrl: "u", content: "" } } },
          calls,
        ),
      },
      "workspace.web_fetch",
      { url: "https://example.test/a", max_length: 512 },
    );
    expect(calls.fetch?.[0]?.maxLength).toBe(512);
    expect(calls.fetch?.[0]?.url).toBe("https://example.test/a");
  });
});

describe("workspace.web_search", () => {
  test("an omitted query is refused by the schema", async () => {
    const r = await executeTool(WORKSPACE, "workspace.web_search", {});
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error_code).toBe("E_SCHEMA_INVALID");
    expect((r.payload as Record<string, unknown>).field).toBe("query");
  });

  /**
   * 空白 query **能过 schema**（它是字符串、键也在），于是落到处理器自己的分支 ——
   * 与 `run_skill`/`todo_write` 同型的第二个形态。这条分支是裸 payload。
   */
  test("a blank query reaches the handler: bare payload, no error_code", async () => {
    const r = await executeTool(WORKSPACE, "workspace.web_search", { query: "   " });
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe("missing query");
    expect((r.payload as Record<string, unknown>).error_code).toBeUndefined();
    expect(r.summary).toBe("web_search: missing query");
  });

  test("a successful search counts the results", async () => {
    const value = { results: [{ title: "a" }, { title: "b" }] };
    const r = await executeTool(
      { ...WORKSPACE, webAccess: webAccessStub({ search: { ok: true, value } }) },
      "workspace.web_search",
      { query: "paw" },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("web_search: 2 result(s)");
    expect(r.payload).toBe(value);
  });

  test("a failed search reports the reason verbatim", async () => {
    const r = await executeTool(
      { ...WORKSPACE, webAccess: webAccessStub({ search: { ok: false, reason: "quota spent" } }) },
      "workspace.web_search",
      { query: "paw" },
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("web_search: quota spent");
  });

  test("max_results is forwarded to the service as maxResults", async () => {
    const calls: { search?: SearchCall[] } = {};
    await executeTool(
      {
        ...WORKSPACE,
        webAccess: webAccessStub({ search: { ok: true, value: { results: [] } } }, calls),
      },
      "workspace.web_search",
      { query: "paw", max_results: 3 },
    );
    expect(calls.search?.[0]?.maxResults).toBe(3);
  });
});
