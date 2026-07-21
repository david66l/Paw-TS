/**
 * AgentSpec 合规校验：工具 ⊆ 已知工具、spawn 与 kind 一致性等。
 */

import type {
  AgentSpec,
  AgentValidationError,
  AgentValidationResult,
  CreateAgentInput,
} from "./types.js";
import { knownBuiltinTools, parseToolsField, resolveAllowedTools } from "./resolve-tools.js";
import { parseAgentMarkdown, createInputToMarkdown } from "./parse.js";

export function validateAgentSpec(spec: AgentSpec): AgentValidationResult {
  const errors: AgentValidationError[] = [];
  const warnings: string[] = [];

  if (!spec.id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(spec.id)) {
    errors.push({
      field: "id",
      message: "id 须为字母数字/下划线/连字符，且不能为空",
    });
  }
  if (!spec.name.trim()) {
    errors.push({ field: "name", message: "name 不能为空" });
  }
  if (!spec.prompt.trim()) {
    errors.push({ field: "prompt", message: "prompt（正文）不能为空" });
  }
  if (spec.maxSteps < 1 || spec.maxSteps > 200) {
    errors.push({ field: "maxSteps", message: "maxSteps 须在 1–200" });
  }

  const known = new Set(knownBuiltinTools());
  let resolvedTools: readonly string[] | null = null;

  if (spec.tools !== "inherit") {
    const bad = spec.tools.filter((t) => !known.has(t));
    if (bad.length > 0) {
      errors.push({
        field: "tools",
        message: `未知工具: ${bad.join(", ")}`,
      });
    }
    resolvedTools = resolveAllowedTools({
      tools: spec.tools,
      canSpawn: spec.canSpawn,
    });
  } else {
    resolvedTools = resolveAllowedTools({
      tools: "inherit",
      canSpawn: spec.canSpawn,
    });
  }

  if (spec.kind === "root" && !spec.canSpawn) {
    warnings.push("root Agent 通常应 canSpawn=true 以便调度子 Agent");
  }
  if (spec.canSpawn && spec.tools !== "inherit") {
    const hasRun =
      spec.tools.includes("workspace.run_agent") ||
      resolvedTools?.includes("workspace.run_agent");
    if (!hasRun) {
      warnings.push("canSpawn=true 但 tools 未含 workspace.run_agent，将无法调度子 Agent");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    resolvedTools: errors.length === 0 ? resolvedTools : null,
  };
}

/** 校验创建输入（会先合成临时 Spec） */
export function validateCreateInput(input: CreateAgentInput): AgentValidationResult {
  const md = createInputToMarkdown(input);
  const spec = parseAgentMarkdown(md, input.id);
  if (!spec) {
    return {
      ok: false,
      errors: [{ field: "id", message: "无法解析为合法 AgentSpec" }],
      warnings: [],
      resolvedTools: null,
    };
  }
  // 再跑 tools 字段归一
  const tools = parseToolsField(
    input.tools === undefined
      ? "inherit"
      : input.tools === "inherit"
        ? "inherit"
        : Array.isArray(input.tools)
          ? input.tools.join(", ")
          : String(input.tools),
  );
  return validateAgentSpec({ ...spec, tools });
}
