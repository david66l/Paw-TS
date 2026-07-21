import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAgentInRegistry,
  loadAgentRegistry,
  loadAgentRegistryReadonly,
  materializeAgent,
  parseAgentMarkdown,
  validateAgentSpec,
  writeAgentFile,
} from "../src/agents/index.js";

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tmpWorkspace(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "paw-agents-"));
  tmpRoots.push(d);
  return d;
}

describe("AgentSpec parse / validate", () => {
  test("parses markdown frontmatter", () => {
    const md = `---
id: bianmu
name: 边牧
role: 代码实现
emoji: 🐕
tools: read_file, write_file, run_shell
childPolicy: read_write
model: flash
canSpawn: false
maxSteps: 18
kind: worker
---
你是边牧。
`;
    const spec = parseAgentMarkdown(md, "fallback");
    expect(spec).not.toBeNull();
    expect(spec!.id).toBe("bianmu");
    expect(spec!.name).toBe("边牧");
    expect(spec!.tools).not.toBe("inherit");
    expect(spec!.tools).toContain("workspace.read_file");
    expect(spec!.tools).toContain("workspace.write_file");
    expect(spec!.childPolicy).toBe("read_write");
    expect(spec!.canSpawn).toBe(false);
  });

  test("rejects unknown tools", () => {
    const md = `---
id: bad
name: bad
tools: not_a_real_tool
---
body
`;
    const spec = parseAgentMarkdown(md, "bad")!;
    const v = validateAgentSpec(spec);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.field === "tools")).toBe(true);
  });
});

describe("AgentRegistry seeds", () => {
  test("ensureDefaults writes lihua and workers", () => {
    const root = tmpWorkspace();
    const reg = loadAgentRegistry(root);
    expect(reg.has("lihua")).toBe(true);
    expect(reg.has("bianmu")).toBe(true);
    expect(reg.getRoot()?.id).toBe("lihua");
    expect(reg.catalogText()).toContain("agent_id=");
    const dir = path.join(root, ".paw", "agents");
    expect(fs.existsSync(path.join(dir, "lihua.md"))).toBe(true);
  });

  test("does not overwrite existing agent", () => {
    const root = tmpWorkspace();
    writeAgentFile(
      root,
      {
        id: "lihua",
        name: "自定义狸花",
        prompt: "CUSTOM PROMPT UNIQUE",
        kind: "root",
        canSpawn: true,
      },
      { overwrite: true },
    );
    const reg = loadAgentRegistry(root);
    expect(reg.get("lihua")?.prompt).toContain("CUSTOM PROMPT UNIQUE");
  });

  test("createAgentInRegistry adds worker and reloads", () => {
    const root = tmpWorkspace();
    const reg = loadAgentRegistry(root);
    const r = createAgentInRegistry(reg, {
      id: "frontend-specialist",
      name: "前端专员",
      role: "React",
      prompt: "You write React components only.",
      tools: "read_file, write_file, edit_file",
      childPolicy: "read_write",
    });
    expect(r.ok).toBe(true);
    expect(reg.has("frontend-specialist")).toBe(true);
    const mat = materializeAgent(reg.get("frontend-specialist")!, "build button");
    expect(mat.allowedTools).toContain("workspace.write_file");
    expect(mat.allowedTools).not.toContain("workspace.run_agent");
    expect(mat.sharedContext.task).toBe("build button");
  });

  test("readonly load without seeds", () => {
    const root = tmpWorkspace();
    const reg = loadAgentRegistryReadonly(root);
    expect(reg.list().length).toBe(0);
  });
});
