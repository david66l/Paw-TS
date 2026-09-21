import { describe, expect, test } from "bun:test";

import { SkillRegistry } from "@paw/core";

import { executeTool } from "../src/registry/index.js";

/**
 * `workspace.run_skill` 在 `packages/harness/test` 里此前 **0 命中**
 * （docs/CODE-REVIEW.md §D9）。它此前没有任何用例，尽管它是把技能提示词注入
 * 会话的唯一入口 —— 注入错了就是模型照着错的东西干活。
 *
 * 与文件类工具一样，"缺参数"有两种形态、两个错误码：键不存在由声明式 schema
 * 拦下（`definitions.ts:651` 要求 `["skill_id"]`），空串则落到处理器自己的分支
 * （`handlers/agents.ts:162-168`）。两种都钉住。
 */

const WORKSPACE = { workspaceRoot: "/tmp" };

function registryWith(
  id: string,
  prompt: string,
  parameters?: readonly {
    name: string;
    description: string;
    type: "string" | "number" | "boolean";
    required?: boolean;
    default?: unknown;
  }[],
): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register({
    id,
    name: `Skill ${id}`,
    description: "test skill",
    version: "1.0.0",
    prompt,
    ...(parameters ? { parameters } : {}),
  });
  return registry;
}

describe("workspace.run_skill", () => {
  test("an omitted skill_id is refused by the schema, not the handler", async () => {
    const r = await executeTool(WORKSPACE, "workspace.run_skill", {});
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error_code).toBe("E_SCHEMA_INVALID");
    expect(r.summary).toBe(
      "workspace.run_skill: E_SCHEMA_INVALID missing required field: skill_id",
    );
  });

  /**
   * 与文件类工具**不一致**的一点：`handleRunSkill` 的错误分支返回裸 payload，
   * **没有 `error_code`**，摘要也没有 `E_*` 前缀（`handlers/agents.ts:162-168`），
   * 而 `handlers/files.ts` 走的是 `toolErrorResult`，两者都有。
   * 这条测试把这个现状钉下来；§R4 说 `errorCode` 对崩溃恢复是承重的，
   * 所以这是一处值得收敛的不一致，而不是"无所谓"。
   */
  test("an empty skill_id reaches the handler: no error_code, bare summary", async () => {
    const r = await executeTool(WORKSPACE, "workspace.run_skill", { skill_id: "" });
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe("missing skill_id");
    expect((r.payload as Record<string, unknown>).error_code).toBeUndefined();
    expect(r.summary).toBe("run_skill: missing skill_id");
  });

  test("without a registry configured the tool refuses rather than pretending", async () => {
    const r = await executeTool(WORKSPACE, "workspace.run_skill", { skill_id: "anything" });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("run_skill: skill registry not configured");
  });

  test("an unknown skill names the id it could not find", async () => {
    const r = await executeTool(
      { ...WORKSPACE, skillRegistry: registryWith("known", "do the known thing") },
      "workspace.run_skill",
      { skill_id: "missing" },
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toBe("run_skill: skill not found: missing");
  });

  test("a known skill reports its id and injects the rendered prompt as a user message", async () => {
    const r = await executeTool(
      { ...WORKSPACE, skillRegistry: registryWith("known", "Do the known thing carefully.") },
      "workspace.run_skill",
      { skill_id: "known" },
    );
    expect(r.ok).toBe(true);
    expect((r.payload as Record<string, unknown>).skillId).toBe("known");
    expect(r.summary).toBe("run_skill: known");

    // 提示词是通过 newMessages 注入的，不是塞进 summary —— 断言形状而不是渲染细节
    const messages = (r as { newMessages?: readonly { role: string; content: string }[] })
      .newMessages;
    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.role).toBe("user");
    expect(messages?.[0]?.content).toContain("Do the known thing carefully.");
  });

  test("declared parameters are substituted from args", async () => {
    const r = await executeTool(
      {
        ...WORKSPACE,
        skillRegistry: registryWith("greet", "Greet {{who}} warmly.", [
          { name: "who", description: "person", type: "string", required: true },
        ]),
      },
      "workspace.run_skill",
      { skill_id: "greet", args: { who: "Ada" } },
    );
    expect(r.ok).toBe(true);
    const content = (r as { newMessages?: readonly { content: string }[] }).newMessages?.[0]
      ?.content;
    expect(content).toContain("Ada");
    expect(content).not.toContain("{{who}}");
  });

  /**
   * 这条钉的是一个真实的坑（`renderSkillPrompt`，`core/src/skills.ts:556-567`）：
   * 替换只遍历 `skill.parameters`，**没声明过的占位符原样留在提示词里**。
   * 也就是说技能作者写了 `{{who}}` 却忘了声明参数时，模型看到的是字面量
   * `{{who}}`，而不是报错也不是空串 —— 静默地把模板当正文发出去。
   */
  test("an undeclared placeholder is left verbatim, not substituted", async () => {
    const r = await executeTool(
      { ...WORKSPACE, skillRegistry: registryWith("raw", "Greet {{who}} warmly.") },
      "workspace.run_skill",
      { skill_id: "raw", args: { who: "Ada" } },
    );
    expect(r.ok).toBe(true);
    const content = (r as { newMessages?: readonly { content: string }[] }).newMessages?.[0]
      ?.content;
    expect(content).toContain("{{who}}");
    expect(content).not.toContain("Ada");
  });
});
