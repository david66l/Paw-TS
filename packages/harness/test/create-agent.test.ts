import { describe, expect, test } from "bun:test";

import type { HarnessContext } from "../src/context.js";
import { executeTool } from "../src/registry/index.js";

/**
 * `workspace.create_agent` 是实测出的最后一个"从未在测试里出现"的工具 id
 * （见 §D9 与上一轮的覆盖率测量）。它是最大的处理器之一，但**注入路径**不需要
 * 文件系统：`ctx.createAgent` 存在时它只负责校验输入、把规范化后的参数转交出去。
 *
 * 这里只钉这一段契约：两条校验出口 + 委派成功/失败。不碰 `ctx.createAgent` 缺失
 * 时那条自己写盘的兜底（那需要临时目录与真实 fs，属于另一条用例）。
 *
 * 参数规范化的默认值（role←name、tools←"inherit"、model←"inherit"、
 * outputFormat←固定文案）是这条路径真正的行为，所以逐项断言而不是只看 ok。
 */
function ctxWith(createAgent: unknown): HarnessContext {
  return { workspaceRoot: "/tmp", createAgent } as HarnessContext;
}

describe("create_agent tool", () => {
  test("rejects an id that is empty or not a safe identifier", async () => {
    for (const id of ["", "  ", "has space", "-leading-dash", "sla/sh"]) {
      const r = await executeTool(
        ctxWith(async () => ({ ok: true, id })),
        "workspace.create_agent",
        {
          id,
          name: "n",
          prompt: "p",
        },
      );
      expect(r.ok).toBe(false);
    }
  });

  test("requires both name and prompt", async () => {
    const missingName = await executeTool(
      ctxWith(async () => ({ ok: true, id: "a" })),
      "workspace.create_agent",
      { id: "a", prompt: "p" },
    );
    expect(missingName.ok).toBe(false);

    const missingPrompt = await executeTool(
      ctxWith(async () => ({ ok: true, id: "a" })),
      "workspace.create_agent",
      { id: "a", name: "n" },
    );
    expect(missingPrompt.ok).toBe(false);
  });

  test("delegates normalised arguments and reports where it wrote", async () => {
    let seen: Record<string, unknown> | undefined;
    const r = await executeTool(
      ctxWith(async (args: Record<string, unknown>) => {
        seen = args;
        return { ok: true, id: "reviewer", path: ".paw/agents/reviewer.md" };
      }),
      "workspace.create_agent",
      { id: "reviewer", name: "Reviewer", prompt: "review things" },
    );

    expect(r.ok).toBe(true);
    expect(seen).toMatchObject({
      id: "reviewer",
      name: "Reviewer",
      prompt: "review things",
      // 未显式给出的字段落在这几个默认值上
      role: "Reviewer",
      tools: "inherit",
      model: "inherit",
      overwrite: false,
    });
    expect(typeof seen?.outputFormat).toBe("string");
    // 注意：emoji / description 为空时**键仍然存在**、值为 undefined
    // （实现写的是 `emoji: emoji || undefined`，不是条件展开）。所以断言的是值，
    // 不是键的缺失 —— 后者会掩盖这条真实契约。
    expect(seen?.emoji).toBeUndefined();
    expect(seen?.description).toBeUndefined();
    expect(r.summary).toContain("wrote");
    expect(r.summary).toContain(".paw/agents/reviewer.md");
  });

  test("surfaces the creator's failure text", async () => {
    const r = await executeTool(
      ctxWith(async () => ({ ok: false, error: "registry rejected the spec" })),
      "workspace.create_agent",
      { id: "reviewer", name: "Reviewer", prompt: "review things" },
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("registry rejected the spec");
  });
});
