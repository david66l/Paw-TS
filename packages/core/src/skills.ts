import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A Skill is a reusable, parameterized workflow that the agent can invoke.
 * Skills are loaded from `.paw/skills/` or bundled at build time.
 */
export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** Parameters the skill accepts. */
  readonly parameters?: readonly SkillParameter[];
  /** Prompt template with {{param}} placeholders. */
  readonly prompt: string;
  /** Optional tool calls to pre-seed (e.g. [read_file, edit_file]). */
  readonly tools?: readonly string[];
  /** Whether the skill requires approval before execution. */
  readonly requiresApproval?: boolean;
  /** Tools this skill is restricted to (e.g. ["Bash(git *)", "FileRead(*)"]). */
  readonly allowedTools?: readonly string[];
  /** Model override hint (e.g. "opus", "sonnet"). */
  readonly model?: string;
  /** Execution context: "inline" (default) or "fork" (sub-agent). */
  readonly context?: "inline" | "fork";
  /** Base directory for this skill (set for directory skills so the model can find assets). */
  readonly skillDir?: string;
}

export interface SkillParameter {
  readonly name: string;
  readonly description: string;
  readonly type: "string" | "number" | "boolean";
  readonly required?: boolean;
  readonly default?: unknown;
}

/** Runtime skill invocation arguments. */
export interface SkillInvocation {
  readonly skillId: string;
  readonly args: Record<string, unknown>;
}

/** Registry of loaded skills, indexed by id. */
export class SkillRegistry {
  private readonly map = new Map<string, SkillDefinition>();

  register(skill: SkillDefinition): void {
    this.map.set(skill.id, skill);
  }

  unregister(skillId: string): boolean {
    return this.map.delete(skillId);
  }

  get(skillId: string): SkillDefinition | undefined {
    return this.map.get(skillId);
  }

  has(skillId: string): boolean {
    return this.map.has(skillId);
  }

  list(): readonly SkillDefinition[] {
    return [...this.map.values()];
  }

  /** Skills that can be invoked by the user via /slash-command. */
  listUserInvocable(): readonly SkillDefinition[] {
    return this.list();
  }

  catalogText(): string {
    const skills = this.list();
    if (skills.length === 0) {
      return "Skills: none loaded.";
    }
    const lines = skills.map((s) => {
      const params = s.parameters
        ?.map((p) => {
          const req = p.required ? "required" : "optional";
          const def =
            p.default !== undefined
              ? ` default=${JSON.stringify(p.default)}`
              : "";
          return `${p.name}: ${p.type} (${req})${def} — ${p.description}`;
        })
        .join("; ");
      return `  - ${s.id}: ${s.name} — ${s.description}${params ? ` [params: ${params}]` : ""}`;
    });
    return `Available skills:\n${lines.join("\n")}`;
  }
}

/**
 * Load skills from a directory tree.
 *
 * Two formats are supported:
 * 1. **Flat files** — each `.json` or `.md` file is a skill (id = filename without ext).
 * 2. **Directory skills** — any directory containing `SKILL.md`, `prompt.md`,
 *    or `skill.md` is treated as a single skill (id = directory name), with the
 *    markdown file as the prompt and other directory contents available as assets.
 */
export function loadSkillsFromDirectory(dir: string): SkillDefinition[] {
  const skills: SkillDefinition[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return skills;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        // Check if this directory is a skill (has SKILL.md / prompt.md / skill.md)
        const skillMd = findSkillMd(full);
        if (skillMd) {
          const raw = readFileSync(skillMd, "utf-8");
          const skill = parseMarkdownSkill(raw, entry);
          if (skill) {
            skills.push({ ...skill, skillDir: full });
          }
        } else {
          // Recurse into subdirectories that are not skills themselves
          skills.push(...loadSkillsFromDirectory(full));
        }
      } else if (entry.endsWith(".json")) {
        const raw = readFileSync(full, "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        const skill = parseSkillDefinition(parsed);
        if (skill) {
          skills.push(skill);
        }
      } else if (entry.endsWith(".md")) {
        const raw = readFileSync(full, "utf-8");
        const skill = parseMarkdownSkill(raw, path.basename(entry, ".md"));
        if (skill) {
          skills.push(skill);
        }
      }
    } catch {
      // skip unreadable entries
    }
  }
  return skills;
}

const SKILL_MD_NAMES = ["SKILL.md", "skill.md", "prompt.md"] as const;

/** Return the path to a skill markdown file inside a directory, or null. */
function findSkillMd(dir: string): string | null {
  for (const name of SKILL_MD_NAMES) {
    const p = path.join(dir, name);
    try {
      statSync(p);
      return p;
    } catch {
      // not found, try next name
    }
  }
  return null;
}

/**
 * Parse a markdown file with YAML frontmatter into a SkillDefinition.
 * Format:
 *   ---
 *   name: skill-name
 *   description: what it does
 *   version: 1.0.0
 *   tools: Bash(git *), FileRead(*)
 *   ---
 *   # Prompt body...
 */
function parseMarkdownSkill(
  raw: string,
  skillId: string,
): SkillDefinition | null {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter — treat entire file as prompt
    const rawPrompt = raw.trim();
    const hasArgs =
      rawPrompt.includes("{{args}}") || rawPrompt.includes("{{ args }}");
    return {
      id: skillId,
      name: skillId,
      description: "",
      version: "1.0.0",
      prompt: rawPrompt,
      ...(hasArgs
        ? {
            parameters: [
              {
                name: "args",
                type: "string",
                description: "User arguments",
                required: false,
              },
            ],
          }
        : {}),
    };
  }

  const fmRaw = fmMatch[1];
  if (!fmRaw) return null;
  const fmLines = fmRaw.split("\n");
  const fm: Record<string, string> = {};
  for (const line of fmLines) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m?.[1] && m[2]) {
      fm[m[1].trim()] = m[2].trim();
    }
  }

  const prompt = fmMatch[2]?.trim();
  if (!prompt) return null;

  const allowedTools = fm.tools
    ? fm.tools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const context =
    fm.context === "inline" || fm.context === "fork" ? fm.context : undefined;

  const hasArgsParam =
    prompt.includes("{{args}}") || prompt.includes("{{ args }}");
  return {
    id: skillId,
    name: fm.name ?? skillId,
    description: fm.description ?? "",
    version: fm.version ?? "1.0.0",
    prompt,
    ...(hasArgsParam
      ? {
          parameters: [
            {
              name: "args",
              type: "string",
              description: "User arguments",
              required: false,
            },
          ],
        }
      : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(context ? { context } : {}),
  };
}

/** Parse an unknown value into a validated SkillDefinition. */
function parseSkillDefinition(raw: unknown): SkillDefinition | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : "";
  const name = typeof obj.name === "string" ? obj.name : id;
  const description =
    typeof obj.description === "string" ? obj.description : "";
  const version = typeof obj.version === "string" ? obj.version : "1.0.0";
  const prompt = typeof obj.prompt === "string" ? obj.prompt : "";
  if (!id || !prompt) {
    return null;
  }

  const parameters = parseSkillParameters(obj.parameters);
  const tools = parseStringArray(obj.tools);
  const allowedTools = parseStringArray(obj.allowedTools);
  const requiresApproval =
    typeof obj.requiresApproval === "boolean"
      ? obj.requiresApproval
      : undefined;
  const model = typeof obj.model === "string" ? obj.model : undefined;
  const context =
    obj.context === "inline" || obj.context === "fork"
      ? obj.context
      : undefined;

  const skill: SkillDefinition = {
    id,
    name,
    description,
    version,
    prompt,
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    ...(requiresApproval !== undefined ? { requiresApproval } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(context !== undefined ? { context } : {}),
  };
  return skill;
}

function parseSkillParameters(raw: unknown): SkillParameter[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: SkillParameter[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : "";
    const description =
      typeof obj.description === "string" ? obj.description : "";
    const type =
      obj.type === "string" || obj.type === "number" || obj.type === "boolean"
        ? obj.type
        : "string";
    const required =
      typeof obj.required === "boolean" ? obj.required : undefined;
    const def = obj.default;
    if (!name) {
      continue;
    }
    out.push({
      name,
      description,
      type,
      ...(required !== undefined ? { required } : {}),
      ...(def !== undefined ? { default: def } : {}),
    });
  }
  return out;
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((s): s is string => typeof s === "string");
}

/**
 * Create implicit skill definitions from project memory files.
 * Returns skills with reserved IDs `_project_memory` and `_project_memory_local`.
 */
export function skillsFromProjectMemory(
  committedContent: string | null,
  localContent: string | null,
): SkillDefinition[] {
  const skills: SkillDefinition[] = [];
  if (committedContent?.trim()) {
    skills.push({
      id: "_project_memory",
      name: "Project Memory",
      description:
        "Committed project rules and conventions from .paw/CLAUDE.md",
      version: "1.0.0",
      prompt: committedContent.trim(),
    });
  }
  if (localContent?.trim()) {
    skills.push({
      id: "_project_memory_local",
      name: "Local Project Memory",
      description: "Local project preferences from .paw/CLAUDE.local.md",
      version: "1.0.0",
      prompt: localContent.trim(),
    });
  }
  return skills;
}

/** Replace {{param}} placeholders in a skill prompt with actual values. */
export function renderSkillPrompt(
  skill: SkillDefinition,
  args: Record<string, unknown>,
): string {
  let prompt = skill.prompt;
  for (const param of skill.parameters ?? []) {
    const value = args[param.name] ?? param.default;
    const placeholder = `{{${param.name}}}`;
    const replacement =
      value !== undefined
        ? String(value)
        : param.required
          ? `[missing: ${param.name}]`
          : "";
    prompt = prompt.split(placeholder).join(replacement);
  }
  if (skill.skillDir) {
    prompt = `Base directory for this skill: ${skill.skillDir}\n\n${prompt}`;
  }
  return prompt;
}
