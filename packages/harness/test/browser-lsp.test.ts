import { describe, expect, test } from "bun:test";

import { executeTool } from "../src/registry/index.js";

/**
 * §D9 剩下的两个工具 id：`workspace.browser_check` 与 `workspace.lsp`。
 *
 * `lsp` 只测**两条错误出口**：真正启动语言服务器那条路会 spawn 子进程，不属于
 * 单元测试的范围（`detectLspCommand` 按扩展名判断，所以 `.zzz` 不必真实存在）。
 *
 * `browser_check` 更简单，但顺带钉住一个**结构事实**：它有处理器、有派发表条目
 * （`handlers/index.ts:84`），却**没有 `definitions.ts` 里的 `fn(...)` 声明**。
 * 后果是它不在模型可见的工具清单里，`validateToolArguments` 也找不到 schema
 * 因而**不做任何参数校验**（`tool-support.ts:74-77` 在无 schema 时返回 `null`）。
 * 名字在代码里有两副拼写：`fn()` 会把点换成下划线（`definitions.ts:216`），
 * 所以 `workspace.browser_check` 上线后写作 `workspace_browser_check` ——
 * `paw-next/src/environment-audit.ts:260` 两种都认，正是为了容忍这个。
 */

const WORKSPACE = { workspaceRoot: "/tmp" };

describe("workspace.browser_check", () => {
  test("without a checker it refuses with a policy-denied code the journal can read", async () => {
    const r = await executeTool(WORKSPACE, "workspace.browser_check", {});
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("Browser verification is unavailable");
    // 注意键是 `code` —— 那是喂 journal errorCode 的那个（§11.32），
    // 与 agents.ts 里既不写 code 也不写 error_code 的裸分支不同。
    expect((r.payload as Record<string, unknown>).code).toBe("E_POLICY_DENIED");
  });

  test("it forwards raw args and the abort signal to the injected checker", async () => {
    const seen: { args?: unknown; signal?: AbortSignal } = {};
    const controller = new AbortController();
    const r = await executeTool(
      {
        ...WORKSPACE,
        abortSignal: controller.signal,
        browserCheck: async (args: unknown, signal?: AbortSignal) => {
          seen.args = args;
          seen.signal = signal;
          return { ok: true, payload: { checked: true }, summary: "browser_check: ok" };
        },
      },
      "workspace.browser_check",
      { url: "https://example.test" },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("browser_check: ok");
    expect(seen.args).toEqual({ url: "https://example.test" });
    expect(seen.signal).toBe(controller.signal);
  });

  /**
   * 没有 schema ⇒ 不做参数校验：任意形状都能到处理器。这条把这个现状钉下来，
   * 而不是断言"应该报 E_SCHEMA_INVALID" —— 它与别的工具不同，是因为它没被声明。
   */
  test("being undeclared, it performs no argument validation", async () => {
    const r = await executeTool(WORKSPACE, "workspace.browser_check", {
      nonsense: { deeply: ["nested"] },
    });
    expect(r.ok).toBe(false);
    // 缺 checker 的那条出口，而不是 E_SCHEMA_INVALID
    expect(r.summary).toBe("Browser verification is unavailable");
  });
});

describe("workspace.lsp", () => {
  test("an omitted file is refused by the schema", async () => {
    const r = await executeTool(WORKSPACE, "workspace.lsp", {});
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error_code).toBe("E_SCHEMA_INVALID");
    expect((r.payload as Record<string, unknown>).field).toBe("file");
  });

  test("an empty file reaches the handler: bare payload, no error_code", async () => {
    const r = await executeTool(WORKSPACE, "workspace.lsp", { file: "" });
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe("missing file");
    expect((r.payload as Record<string, unknown>).error_code).toBeUndefined();
    expect(r.summary).toBe("lsp: missing file");
  });

  test("an extension with no known server is reported before any process is spawned", async () => {
    const r = await executeTool(WORKSPACE, "workspace.lsp", { file: "thing.zzz" });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("lsp: no LSP server for .zzz");
    expect(String((r.payload as Record<string, unknown>).error)).toContain(
      "no LSP server known for .zzz",
    );
  });
});
