import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HarnessContext } from "../src/context.js";
import { executeTool } from "../src/registry/index.js";

/**
 * `workspace.create_agent` 是实测出的最后一个"从未在测试里出现"的工具 id
 * （见 §D9 与覆盖率测量）。它有两段：`ctx.createAgent` 存在时只做校验 + 转交；
 * 不存在时自己往 `.paw/agents/<id>.md` 写一份带 front matter 的定义。
 *
 * 两段都覆盖：前半用桩，后半用 `mkdtempSync` 出来的临时工作区。
 *
 * 参数规范化的默认值（role←name、tools←"inherit"、model←"inherit"、
 * outputFormat←固定文案）是这条路径真正的行为，所以逐项断言而不是只看 ok。
 */
function ctxWith(createAgent: unknown, workspaceRoot = "/tmp"): HarnessContext {
  return { workspaceRoot, createAgent } as HarnessContext;
}

const WORKSPACE = mkdtempSync(join(tmpdir(), "paw-create-agent-"));

afterAll(() => {
  rmSync(WORKSPACE, { recursive: true, force: true });
});

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

  // ---- 兜底路径：没有 ctx.createAgent 时自己写盘 ----

  test("writes the agent definition into .paw/agents when no creator is injected", async () => {
    const r = await executeTool(ctxWith(undefined, WORKSPACE), "workspace.create_agent", {
      id: "worker",
      name: "Worker",
      prompt: "do the work",
      emoji: "🔧",
    });

    expect(r.ok).toBe(true);
    const file = join(WORKSPACE, ".paw", "agents", "worker.md");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    // front matter 的关键字段与正文
    expect(text).toContain("id: worker");
    expect(text).toContain("name: Worker");
    expect(text).toContain("tools: inherit");
    expect(text).toContain("canSpawn: false");
    expect(text).toContain("emoji: 🔧");
    expect(text).toContain("do the work");
    // 摘要里报的是 id，不是路径（与注入路径不同，这点也钉住）
    expect(r.summary).toContain("wrote worker");
  });

  test("refuses to clobber an existing definition without overwrite", async () => {
    const r = await executeTool(ctxWith(undefined, WORKSPACE), "workspace.create_agent", {
      id: "worker",
      name: "Worker",
      prompt: "do the work",
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.payload)).toContain("exists: worker");
  });

  test("overwrite=true replaces the definition", async () => {
    const r = await executeTool(ctxWith(undefined, WORKSPACE), "workspace.create_agent", {
      id: "worker",
      name: "Worker",
      prompt: "do the work differently",
      overwrite: true,
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(WORKSPACE, ".paw", "agents", "worker.md"), "utf8")).toContain(
      "do the work differently",
    );
  });
});
