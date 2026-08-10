/**
 * 解析 `.paw/agents/*.md` → AgentSpec
 */

import { parseYamlFrontmatter, splitFrontmatter } from "@paw/core";
import type {
  AgentModelPref,
  AgentRunKind,
  AgentSpec,
  ChildPolicy,
  CreateAgentInput,
  MemoryExtractionMode,
} from "./types.js";
import { parseToolsField } from "./resolve-tools.js";

function asChildPolicy(v: string | undefined): ChildPolicy {
  return v === "read_write" ? "read_write" : "read_only";
}

function asModel(v: string | undefined): AgentModelPref {
  if (v === "flash" || v === "pro" || v === "inherit") return v;
  return "inherit";
}

function asKind(v: string | undefined): AgentRunKind {
  return v === "root" ? "root" : "worker";
}

function asMemory(v: string | undefined): MemoryExtractionMode {
  if (v === "background" || v === "await" || v === "off") return v;
  return "off";
}

function asBool(v: string | undefined, defaultValue: boolean): boolean {
  if (v === undefined || v === "") return defaultValue;
  const s = v.toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return defaultValue;
}

function asInt(v: string | undefined, defaultValue: number): number {
  if (v === undefined || v === "") return defaultValue;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** 从 markdown 原文解析 AgentSpec；失败返回 null */
export function parseAgentMarkdown(
  raw: string,
  fallbackId: string,
  sourcePath?: string,
): AgentSpec | null {
  const split = splitFrontmatter(raw);
  const fm = split
    ? parseYamlFrontmatter(split.frontmatter)
    : ({} as Record<string, string>);
  const body = (split?.body ?? raw).trim();
  if (!body && !fm.id && !fm.name) return null;

  const id = (fm.id || fallbackId).trim();
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return null;

  const name = (fm.name || id).trim();
  const role = (fm.role || name).trim();
  const kind = asKind(fm.kind);
  const tools = parseToolsField(fm.tools);
  const canSpawn = asBool(fm.canSpawn ?? fm.can_spawn, kind === "root");

  return {
    id,
    name,
    role,
    ...(fm.emoji ? { emoji: fm.emoji.trim() } : {}),
    ...(fm.description ? { description: fm.description.trim() } : {}),
    prompt: body || `You are ${name} (${role}).`,
    tools,
    childPolicy: asChildPolicy(fm.childPolicy ?? fm.child_policy),
    model: asModel(fm.model),
    outputFormat:
      (fm.outputFormat ?? fm.output_format)?.trim() ||
      "Return a clear summary of what you did.",
    canSpawn,
    maxSteps: asInt(fm.maxSteps ?? fm.max_steps, kind === "root" ? 24 : 12),
    kind,
    memoryExtraction: asMemory(
      fm.memoryExtraction ?? fm.memory_extraction ?? (kind === "root" ? "background" : "off"),
    ),
    ...(sourcePath ? { sourcePath } : {}),
  };
}

/** CreateAgentInput → 可序列化 frontmatter + body */
export function createInputToMarkdown(input: CreateAgentInput): string {
  const tools =
    input.tools === undefined
      ? "inherit"
      : input.tools === "inherit"
        ? "inherit"
        : Array.isArray(input.tools)
          ? input.tools.join(", ")
          : String(input.tools);

  const lines: string[] = [
    "---",
    `id: ${input.id.trim()}`,
    `name: ${input.name.trim()}`,
    `role: ${(input.role ?? input.name).trim()}`,
  ];
  if (input.emoji) lines.push(`emoji: ${input.emoji}`);
  if (input.description) lines.push(`description: ${input.description}`);
  lines.push(`tools: ${tools}`);
  lines.push(`childPolicy: ${input.childPolicy ?? "read_only"}`);
  lines.push(`model: ${input.model ?? "inherit"}`);
  // 避免 frontmatter 值里出现未转义冒号；简单压成单行
  const of = (input.outputFormat ?? "Return a clear summary of what you did.")
    .replace(/\n/g, " ")
    .trim();
  lines.push(`outputFormat: ${of}`);
  lines.push(`canSpawn: ${input.canSpawn === true ? "true" : "false"}`);
  lines.push(`maxSteps: ${String(input.maxSteps ?? 12)}`);
  lines.push(`kind: ${input.kind ?? "worker"}`);
  lines.push(
    `memoryExtraction: ${input.memoryExtraction ?? "off"}`,
  );
  lines.push("---");
  lines.push("");
  lines.push(input.prompt.trim());
  lines.push("");
  return lines.join("\n");
}
