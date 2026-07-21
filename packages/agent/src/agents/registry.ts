/**
 * AgentRegistry — 加载 / 查询 / 热更新 Agent 定义
 */

import { existsSync } from "node:fs";
import type { AgentSpec, AgentSummary, CreateAgentInput } from "./types.js";
import { agentsDir, loadAgentsFromDirectory } from "./load.js";
import { writeAgentFile } from "./write.js";
import { DEFAULT_AGENT_SEEDS } from "./seeds.js";
import { validateAgentSpec } from "./validate.js";

export class AgentRegistry {
  private readonly map = new Map<string, AgentSpec>();
  readonly workspaceRoot: string;
  private dir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.dir = agentsDir(workspaceRoot);
  }

  get directory(): string {
    return this.dir;
  }

  /** 注册（同 id 覆盖） */
  register(spec: AgentSpec): void {
    this.map.set(spec.id, spec);
  }

  get(id: string): AgentSpec | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  list(): readonly AgentSpec[] {
    return [...this.map.values()];
  }

  /** 总控 root：优先 id=lihua，否则第一个 kind=root */
  getRoot(): AgentSpec | undefined {
    return this.map.get("lihua") ?? this.list().find((s) => s.kind === "root");
  }

  listSummaries(): readonly AgentSummary[] {
    return this.list().map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      ...(s.emoji ? { emoji: s.emoji } : {}),
      description: s.description ?? s.role,
      kind: s.kind,
      childPolicy: s.childPolicy,
      canSpawn: s.canSpawn,
      tools: s.tools,
    }));
  }

  /** 注入总控 prompt 的花名册文本 */
  catalogText(): string {
    const items = this.list().filter((s) => s.kind !== "root" || s.id === "lihua");
    if (items.length === 0) return "Available agents: (none)";
    const lines = items.map((s) => {
      const emoji = s.emoji ? `${s.emoji} ` : "";
      const tools =
        s.tools === "inherit" ? "tools=inherit" : `tools=[${s.tools.join(", ")}]`;
      return `  - ${s.id}: ${emoji}${s.name} — ${s.role}${s.description ? `（${s.description}）` : ""} [${s.childPolicy}, ${tools}, canSpawn=${s.canSpawn}]`;
    });
    return [
      "Available agents (use workspace.run_agent with agent_id=<id> and goal=...):",
      ...lines,
      "To create a new worker agent: workspace.create_agent with id, name, prompt, tools, child_policy.",
    ].join("\n");
  }

  /** 从磁盘重载（先清空再加载） */
  reload(): number {
    this.map.clear();
    const loaded = loadAgentsFromDirectory(this.dir);
    let n = 0;
    for (const spec of loaded) {
      const v = validateAgentSpec(spec);
      if (!v.ok) continue;
      this.register(spec);
      n++;
    }
    return n;
  }

  /**
   * 确保默认种子存在（不覆盖已有文件），再 reload。
   * @returns 新写入的 id 列表
   */
  ensureDefaults(): readonly string[] {
    const written: string[] = [];
    for (const seed of DEFAULT_AGENT_SEEDS) {
      const r = writeAgentFile(this.workspaceRoot, seed, { overwrite: false });
      if (r.ok) written.push(seed.id);
      // 已存在时 error 含「已存在」——忽略
    }
    this.reload();
    return written;
  }
}

/**
 * 工作区 Agent 注册表：ensure 种子 + 加载。
 * 目录不存在也会创建并写入种子。
 */
export function loadAgentRegistry(workspaceRoot: string): AgentRegistry {
  const reg = new AgentRegistry(workspaceRoot);
  reg.ensureDefaults();
  return reg;
}

/** 仅加载，不写种子（测试用） */
export function loadAgentRegistryReadonly(workspaceRoot: string): AgentRegistry {
  const reg = new AgentRegistry(workspaceRoot);
  if (existsSync(agentsDir(workspaceRoot))) {
    reg.reload();
  }
  return reg;
}

export function createAgentInRegistry(
  registry: AgentRegistry,
  input: CreateAgentInput,
  opts?: { readonly overwrite?: boolean },
): { ok: boolean; error?: string; id?: string; path?: string } {
  const r = writeAgentFile(registry.workspaceRoot, input, opts);
  if (!r.ok) return { ok: false, error: r.error };
  registry.reload();
  return { ok: true, id: r.id, path: r.path };
}
