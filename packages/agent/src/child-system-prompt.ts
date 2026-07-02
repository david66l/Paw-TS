/**
 * 子（Sub-）Agent 的轻量级 system prompt。
 * ========================================
 *
 * 子 Agent 使用 SharedContext（~2k token 预算）而非完整的 Paw system prompt。
 *
 * 为什么不用完整的 system prompt？
 * - 子 Agent 的上下文窗口有限
 * - 子 Agent 只需要知道：角色、任务、约束、可用工具
 * - 不需要 Git 状态、全局 Skills、项目记忆等父 Agent 才需要的信息
 *
 * 构建逻辑：
 * 将 SharedContext 的各个字段（role/task/facts/constraints/artifacts/
 * parentConclusions/outputFormat）组装为 markdown 格式的 system prompt。
 *
 * 工具目录截断：如果工具目录超过 4000 字符，只保留前 4000 字符。
 */

import type { SharedContext } from "./orchestrator/types.js";

/** 子 Agent 工具目录的最大字符数 */
const MAX_CHILD_TOOL_CATALOG_CHARS = 4_000;

/** 将字符串数组转为 markdown bullet list */
function bulletLines(items: readonly string[]): string {
  return items.map((s) => `- ${s}`).join("\n");
}

/**
 * 构建子 Agent 的 system prompt。
 *
 * 结构（按顺序）：
 * 1. Role（角色描述）
 * 2. Task（任务描述）
 * 3. Context from parent（父 Agent 传递的事实）
 * 4. Constraints（约束条件）
 * 5. Artifacts（相关文件/代码）
 * 6. Progress（已完成/待办）
 * 7. Parent conclusions（父 Agent 已有结论）
 * 8. Output format（期望的输出格式）
 * 9. Tools（可用工具目录）
 */
export function buildChildSystemPrompt(opts: {
  readonly sharedContext: SharedContext;
  readonly toolCatalog: string;
  readonly workspaceRoot: string;
}): string {
  const ctx = opts.sharedContext;
  const parts: string[] = [ctx.role, "", "# Task", ctx.task];

  // 父 Agent 传递的上下文事实
  if (ctx.facts.length > 0) {
    parts.push("", "# Context from parent", bulletLines(ctx.facts));
  }
  // 约束条件
  if (ctx.constraints.length > 0) {
    parts.push("", "# Constraints", bulletLines(ctx.constraints));
  }
  // 相关文件/代码制品
  if (ctx.artifacts.length > 0) {
    parts.push("", "# Artifacts");
    for (const a of ctx.artifacts) {
      const label = a.path ?? a.type;
      parts.push(`## ${label}\n${a.content.slice(0, 4_000)}`);
    }
  }
  // 进度状态
  if (ctx.state.completed.length > 0 || ctx.state.pending.length > 0) {
    parts.push("", "# Progress");
    if (ctx.state.completed.length > 0) {
      parts.push("Completed:", bulletLines(ctx.state.completed));
    }
    if (ctx.state.pending.length > 0) {
      parts.push("Pending:", bulletLines(ctx.state.pending));
    }
  }
  // 父 Agent 结论
  if (ctx.parentConclusions && ctx.parentConclusions.length > 0) {
    parts.push("", "# Parent conclusions");
    for (const c of ctx.parentConclusions) {
      parts.push(`- (${c.confidence}) ${c.conclusion}`);
    }
  }

  // 输出格式
  parts.push("", "# Output format", ctx.outputFormat);

  // 工具目录（截断保护）
  parts.push(
    "",
    "# Tools",
    "Use workspace tools via JSON lines or native tool calling.",
    opts.toolCatalog.length > MAX_CHILD_TOOL_CATALOG_CHARS
      ? `${opts.toolCatalog.slice(0, MAX_CHILD_TOOL_CATALOG_CHARS)}\n...(truncated)`
      : opts.toolCatalog,
    "",
    `Workspace: ${opts.workspaceRoot}`,
  );

  return parts.join("\n");
}
