import fs from "node:fs";
import path from "node:path";
/** Agent 与 Skill 类工具（run_agent/create_agent/run_skill）。 */
import { renderSkillPrompt } from "@paw/core";
import type { ToolRunResult } from "../definitions.js";
import { type ToolScope, asRecord, num } from "../tool-support.js";

/** `workspace.run_agent` */
export async function handleRunAgent(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const goal = typeof rec.goal === "string" ? rec.goal : "";
  if (!goal.trim()) {
    return {
      ok: false,
      payload: { error: "missing goal" },
      summary: "run_agent: missing goal",
    };
  }
  const launcher = ctx.subAgentLauncher;
  if (!launcher) {
    return {
      ok: false,
      payload: { error: "sub-agent launcher not configured" },
      summary: "run_agent: sub-agent launcher not configured",
    };
  }
  const maxSteps = num(rec.max_steps, undefined) ?? num(rec.maxSteps, undefined);
  const sharedContext = ctx.buildSubAgentSharedContext?.({
    goal,
    args: rec,
  });
  const r = await launcher.launch(goal, maxSteps, {
    args: rec,
    sharedContext,
    signal: ctx.abortSignal,
    parentRunId: ctx.parentRunId,
    agentId: ctx.currentToolCallId,
  });
  const agentId =
    typeof rec.agent_id === "string"
      ? rec.agent_id
      : typeof rec.agentId === "string"
        ? rec.agentId
        : "";
  return {
    ok: r.status === "completed",
    payload: r,
    summary: `run_agent: ${r.status}${agentId ? ` [${agentId}]` : ""} (${r.trace?.stepsTaken ?? 0} steps)`,
  };
}

/** `workspace.create_agent` */
export async function handleCreateAgent(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const name = typeof rec.name === "string" ? rec.name.trim() : "";
  const prompt = typeof rec.prompt === "string" ? rec.prompt.trim() : "";
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
    return {
      ok: false,
      payload: { error: "invalid id" },
      summary: "create_agent: invalid id",
    };
  }
  if (!name || !prompt) {
    return {
      ok: false,
      payload: { error: "name and prompt required" },
      summary: "create_agent: name and prompt required",
    };
  }
  const role = typeof rec.role === "string" && rec.role.trim() ? rec.role.trim() : name;
  const tools = typeof rec.tools === "string" && rec.tools.trim() ? rec.tools.trim() : "inherit";
  const childPolicy =
    rec.child_policy === "read_write" || rec.childPolicy === "read_write"
      ? "read_write"
      : "read_only";
  const modelRaw = typeof rec.model === "string" ? rec.model.trim() : "inherit";
  const model = modelRaw === "flash" || modelRaw === "pro" ? modelRaw : "inherit";
  const outputFormat =
    typeof rec.output_format === "string" && rec.output_format.trim()
      ? rec.output_format.trim().replace(/\n/g, " ")
      : typeof rec.outputFormat === "string" && rec.outputFormat.trim()
        ? rec.outputFormat.trim().replace(/\n/g, " ")
        : "Return a clear summary of what you did.";
  const emoji = typeof rec.emoji === "string" && rec.emoji.trim() ? rec.emoji.trim() : "";
  const description =
    typeof rec.description === "string" && rec.description.trim() ? rec.description.trim() : "";
  const overwrite = rec.overwrite === true;
  if (ctx.createAgent) {
    const r = await ctx.createAgent({
      id,
      name,
      role,
      prompt,
      tools,
      childPolicy,
      model,
      outputFormat,
      emoji: emoji || undefined,
      description: description || undefined,
      overwrite,
    });
    return {
      ok: r.ok,
      payload: r,
      summary: r.ok
        ? `create_agent: wrote ${r.id} → ${r.path ?? ".paw/agents"}`
        : `create_agent: ${r.error ?? "failed"}`,
    };
  }
  const agentsDir = path.join(ctx.workspaceRoot, ".paw", "agents");
  const filePath = path.join(agentsDir, `${id}.md`);
  try {
    fs.mkdirSync(agentsDir, { recursive: true });
    if (!overwrite && fs.existsSync(filePath)) {
      return {
        ok: false,
        payload: { error: `exists: ${id}` },
        summary: `create_agent: Agent 已存在 ${id}`,
      };
    }
    const lines = [
      "---",
      `id: ${id}`,
      `name: ${name}`,
      `role: ${role}`,
      ...(emoji ? [`emoji: ${emoji}`] : []),
      ...(description ? [`description: ${description}`] : []),
      `tools: ${tools}`,
      `childPolicy: ${childPolicy}`,
      `model: ${model}`,
      `outputFormat: ${outputFormat}`,
      "canSpawn: false",
      "maxSteps: 12",
      "kind: worker",
      "memoryExtraction: off",
      "---",
      "",
      prompt,
      "",
    ];
    fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
    return {
      ok: true,
      payload: { id, path: filePath },
      summary: `create_agent: wrote ${id}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      payload: { error: msg },
      summary: `create_agent: ${msg}`,
    };
  }
}

/** `workspace.run_skill` */
export async function handleRunSkill(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const skillId = typeof rec.skill_id === "string" ? rec.skill_id : "";
  if (!skillId) {
    return {
      ok: false,
      payload: { error: "missing skill_id" },
      summary: "run_skill: missing skill_id",
    };
  }
  const registry = ctx.skillRegistry;
  if (!registry) {
    return {
      ok: false,
      payload: { error: "skill registry not configured" },
      summary: "run_skill: skill registry not configured",
    };
  }
  const skill = registry.get(skillId);
  if (!skill) {
    return {
      ok: false,
      payload: { error: `skill not found: ${skillId}` },
      summary: `run_skill: skill not found: ${skillId}`,
    };
  }
  const skillArgs = asRecord(rec.args) ?? {};
  const rendered = renderSkillPrompt(skill, skillArgs);
  return {
    ok: true,
    payload: { skillId },
    summary: `run_skill: ${skillId}`,
    // Expanded skill prompt injected as a user message so the model
    // follows it on the next turn without needing to re-read the result.
    newMessages: [{ role: "user", content: rendered }],
  };
}
