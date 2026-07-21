/**
 * 将 Agent 定义写入 `.paw/agents/<id>.md`
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CreateAgentInput } from "./types.js";
import { createInputToMarkdown, parseAgentMarkdown } from "./parse.js";
import { validateCreateInput } from "./validate.js";
import { agentsDir } from "./load.js";

export interface WriteAgentResult {
  readonly ok: boolean;
  readonly path?: string;
  readonly id?: string;
  readonly error?: string;
  readonly warnings?: readonly string[];
}

/** 校验并落盘；overwrite=false 时若已存在则失败 */
export function writeAgentFile(
  workspaceRoot: string,
  input: CreateAgentInput,
  opts?: { readonly overwrite?: boolean },
): WriteAgentResult {
  const id = input.id.trim();
  if (!id) {
    return { ok: false, error: "id 不能为空" };
  }
  const v = validateCreateInput({ ...input, id });
  if (!v.ok) {
    return {
      ok: false,
      error: v.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
    };
  }

  const dir = agentsDir(workspaceRoot);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.md`);

  if (!opts?.overwrite && existsSync(filePath)) {
    return { ok: false, error: `Agent 已存在: ${id}（需 overwrite）` };
  }

  const md = createInputToMarkdown({ ...input, id });
  const spec = parseAgentMarkdown(md, id, filePath);
  if (!spec) {
    return { ok: false, error: "生成的 markdown 无法解析" };
  }

  writeFileSync(filePath, md, "utf-8");
  return {
    ok: true,
    path: filePath,
    id,
    warnings: v.warnings,
  };
}
