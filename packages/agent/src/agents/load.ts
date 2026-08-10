/**
 * 从目录加载 Agent 定义（.md）
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AgentSpec } from "./types.js";
import { parseAgentMarkdown } from "./parse.js";

export function agentsDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), ".paw", "agents");
}

/** 扫描 .paw/agents 下 md（一层 + 直接子目录一层） */
export function loadAgentsFromDirectory(dir: string): AgentSpec[] {
  const out: AgentSpec[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        // 子目录：优先 AGENT.md / agent.md / 与目录同名的 md
        const candidates = [
          path.join(full, "AGENT.md"),
          path.join(full, "agent.md"),
          path.join(full, `${entry}.md`),
        ];
        for (const c of candidates) {
          try {
            const raw = readFileSync(c, "utf-8");
            const spec = parseAgentMarkdown(raw, entry, c);
            if (spec) {
              out.push(spec);
              break;
            }
          } catch {
            /* try next */
          }
        }
      } else if (entry.endsWith(".md")) {
        const raw = readFileSync(full, "utf-8");
        const id = path.basename(entry, ".md");
        const spec = parseAgentMarkdown(raw, id, full);
        if (spec) out.push(spec);
      }
    } catch {
      /* skip bad entry */
    }
  }
  return out;
}
