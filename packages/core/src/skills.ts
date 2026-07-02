/**
 * 技能系统模块 —— 可复用的参数化工作流定义与加载。
 *
 * ## 模块职责
 *
 * 在 AI Agent 框架中，"技能"（Skill）是一种封装了特定工作流程的可复用单元。
 * 每个技能包含：
 * - 一个带有 `{{param}}` 占位符的提示词模板
 * - 一组可选的预定义工具调用（如读取文件、编辑文件）
 * - 执行约束（是否需要审批、允许的工具白名单、模型要求）
 *
 * 用户通过 `/skill-name args` 的方式调用技能，系统将模板填充用户参数后
 * 发送给 LLM 执行。
 *
 * ## 技能定义来源
 *
 * 技能可以从多种来源加载：
 * 1. **文件系统目录**：`.paw/skills/` 下的 .md / .json 文件或子目录
 * 2. **项目记忆文件**：`.paw/CLAUDE.md` 和 `.paw/CLAUDE.local.md` 作为隐式技能
 * 3. **构建时嵌入**：编译时打包到应用中的技能定义
 *
 * ## 支持的文件格式
 *
 * ### Markdown 格式（.md）
 * 使用 YAML frontmatter 定义元数据，Markdown 正文作为提示词模板：
 * ```markdown
 * ---
 * name: 技能名称
 * description: 技能描述
 * version: 1.0.0
 * tools: Bash(git *), FileRead(*)
 * context: fork
 * ---
 * # 提示词正文...
 * ```
 *
 * ### JSON 格式（.json）
 * 完整的结构化定义，包含 id、name、description、prompt、parameters 等字段。
 *
 * ### 目录格式（Directory Skill）
 * 包含 `SKILL.md`、`skill.md` 或 `prompt.md` 的子目录作为一个技能，
 * 目录名作为技能 ID，目录中的其他文件作为技能可访问的资源（assets）。
 *
 * ## 关键设计决策
 *
 * - **模板渲染**：使用 `{{paramName}}` 风格的占位符，与 Mustache/Handlebars 兼容
 * - **参数自动检测**：如果 prompt 中包含 `{{args}}` 占位符，自动注册 `args` 参数
 * - **执行上下文**：支持 `inline`（在主会话中执行）和 `fork`（在子 Agent 中执行）
 *   两种模式
 * - **工具约束**：通过 `allowedTools` 限制技能可以使用的工具，防止越权操作
 * - **项目记忆作为技能**：`_project_memory` 和 `_project_memory_local` 是保留 ID，
 *   它们作为隐式技能注入到每个会话的系统提示词中
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseYamlFrontmatter, splitFrontmatter } from "./markdown.js";

/**
 * 技能定义 —— 一个可复用的、参数化的工作流。
 *
 * Agent 可以根据用户输入和任务上下文选择和调用技能。
 */
export interface SkillDefinition {
  /** 技能唯一标识符（用于引用和调用） */
  readonly id: string;
  /** 技能显示名称 */
  readonly name: string;
  /** 技能描述（用于 Agent 理解技能用途和选择技能） */
  readonly description: string;
  /** 技能版本号（遵循语义化版本规范） */
  readonly version: string;
  /** 技能接受的参数列表 */
  readonly parameters?: readonly SkillParameter[];
  /** 提示词模板，使用 {{param}} 占位符表示可变部分 */
  readonly prompt: string;
  /** 可选的预定义工具调用列表（如读取文件、编辑文件） */
  readonly tools?: readonly string[];
  /** 技能执行前是否需要用户审批 */
  readonly requiresApproval?: boolean;
  /**
   * 技能允许使用的工具白名单。
   *
   * 例如：`["Bash(git *)", "FileRead(*)"]` 表示只能执行 git 命令和读取文件。
   * 不设置则表示无限制（继承 Agent 的默认工具权限）。
   */
  readonly allowedTools?: readonly string[];
  /** 模型覆盖提示（例如："opus"、"sonnet"），不设置则使用默认模型 */
  readonly model?: string;
  /**
   * 执行上下文模式：
   * - "inline"（默认）：在当前 Agent 会话中执行
   * - "fork"：在独立的子 Agent 中执行，拥有隔离的工作区
   */
  readonly context?: "inline" | "fork";
  /**
   * 技能的基础目录。
   *
   * 仅对目录型技能设置，让模型在执行时能找到技能目录中的资源文件。
   * 在渲染 prompt 时会自动拼接 "Base directory for this skill: ..." 前缀。
   */
  readonly skillDir?: string;
}

/** 技能参数定义 */
export interface SkillParameter {
  /** 参数名称（对应模板中的 {{name}} 占位符） */
  readonly name: string;
  /** 参数描述 */
  readonly description: string;
  /** 参数类型 */
  readonly type: "string" | "number" | "boolean";
  /** 参数是否为必填 */
  readonly required?: boolean;
  /** 参数默认值 */
  readonly default?: unknown;
}

/** 运行时技能调用参数 */
export interface SkillInvocation {
  /** 要调用的技能 ID */
  readonly skillId: string;
  /** 调用时传入的实际参数值（用于替换模板中的占位符） */
  readonly args: Record<string, unknown>;
}

/**
 * 技能注册表 —— 管理所有已加载的技能定义。
 *
 * 使用 Map<id, SkillDefinition> 存储，提供注册、查询、列表等操作。
 * 技能 ID 作为主键，后注册的同 ID 技能会覆盖先注册的。
 */
export class SkillRegistry {
  private readonly map = new Map<string, SkillDefinition>();

  /** 注册一个技能定义（如果 ID 已存在则覆盖） */
  register(skill: SkillDefinition): void {
    this.map.set(skill.id, skill);
  }

  /** 注销一个技能定义，返回是否成功 */
  unregister(skillId: string): boolean {
    return this.map.delete(skillId);
  }

  /** 根据 ID 获取技能定义 */
  get(skillId: string): SkillDefinition | undefined {
    return this.map.get(skillId);
  }

  /** 检查是否存在指定 ID 的技能 */
  has(skillId: string): boolean {
    return this.map.has(skillId);
  }

  /** 列出所有已注册的技能 */
  list(): readonly SkillDefinition[] {
    return [...this.map.values()];
  }

  /** 列出用户可以通过 /slash-command 调用的技能 */
  listUserInvocable(): readonly SkillDefinition[] {
    return this.list();
  }

  /**
   * 生成技能目录的人类可读文本。
   *
   * 用于注入到 LLM 的系统提示词中，让模型了解可用的技能列表。
   * 格式示例：
   * ```
   * Available skills:
   *   - git-commit: Git 提交 — 自动生成 commit 信息并提交
   *   - code-review: 代码审查 — 审查代码变更 [params: file: string (required)...]
   * ```
   */
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
 * 从目录树中加载技能定义。
 *
 * ## 支持的格式
 * 1. **JSON 文件**（.json）：完整的结构化技能定义
 * 2. **Markdown 文件**（.md）：YAML frontmatter + Markdown 正文作为提示词
 * 3. **目录型技能**：包含 SKILL.md / skill.md / prompt.md 的子目录
 *
 * ## 递归行为
 * - 如果子目录不包含技能标记文件，则递归进入其子目录继续搜索
 * - 如果子目录包含技能标记文件，则将其作为一个技能加载（不再递归）
 *
 * ## 容错设计
 * - 无法读取的目录或文件会被静默跳过（try-catch 包裹每个条目的处理逻辑）
 * - 格式错误的文件不会影响其他正确文件的加载
 */
export function loadSkillsFromDirectory(dir: string): SkillDefinition[] {
  const skills: SkillDefinition[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return skills;  // 目录不存在或无法读取
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        // 检查该目录是否是一个技能（包含 SKILL.md / prompt.md / skill.md）
        const skillMd = findSkillMd(full);
        if (skillMd) {
          const raw = readFileSync(skillMd, "utf-8");
          const skill = parseMarkdownSkill(raw, entry);
          if (skill) {
            // 设置 skillDir 以便模型在执行时找到技能目录中的资源文件
            skills.push({ ...skill, skillDir: full });
          }
        } else {
          // 不是技能目录，递归进入其子目录继续搜索
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
        // 文件名（不含扩展名）作为技能 ID
        const skill = parseMarkdownSkill(raw, path.basename(entry, ".md"));
        if (skill) {
          skills.push(skill);
        }
      }
    } catch {
      // 跳过无法读取的条目
    }
  }
  return skills;
}

/** 技能目录中有效的 Markdown 文件名列表（按优先级排序） */
const SKILL_MD_NAMES = ["SKILL.md", "skill.md", "prompt.md"] as const;

/**
 * 在给定目录中查找技能 Markdown 文件。
 *
 * 按 SKILL_MD_NAMES 的优先级顺序依次尝试，返回第一个存在的文件路径。
 * 如果都不存在则返回 null。
 */
function findSkillMd(dir: string): string | null {
  for (const name of SKILL_MD_NAMES) {
    const p = path.join(dir, name);
    try {
      statSync(p);
      return p;
    } catch {
      // 文件不存在，继续尝试下一个名称
    }
  }
  return null;
}

/**
 * 解析带有 YAML frontmatter 的 Markdown 文件为 SkillDefinition。
 *
 * ## 格式
 * ```markdown
 * ---
 * name: skill-name
 * description: what it does
 * version: 1.0.0
 * tools: Bash(git *), FileRead(*)
 * context: fork
 * ---
 * # Prompt 正文...
 * ```
 *
 * ## 无 frontmatter 的处理
 * 如果文件不包含 frontmatter，将整个文件内容作为 prompt，
 * 技能名称使用文件名（去掉扩展名）。
 * 如果 prompt 中包含 `{{args}}` 占位符，自动注册 `args` 字符串参数。
 */
function parseMarkdownSkill(
  raw: string,
  skillId: string,
): SkillDefinition | null {
  const fmMatch = splitFrontmatter(raw);
  if (!fmMatch) {
    // 无 frontmatter —— 将整个文件内容作为 prompt
    const rawPrompt = raw.trim();
    const hasArgs =
      rawPrompt.includes("{{args}}") || rawPrompt.includes("{{ args }}");
    return {
      id: skillId,
      name: skillId,
      description: "",
      version: "1.0.0",
      prompt: rawPrompt,
      // 如果 prompt 中检测到 {{args}} 占位符，自动注册 args 参数
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

  // 解析 YAML frontmatter 元数据
  const fm = parseYamlFrontmatter(fmMatch.frontmatter);

  const prompt = fmMatch.body.trim();
  if (!prompt) return null;  // 没有 prompt 正文的技能定义无效

  // 解析工具白名单：逗号分隔的字符串转为数组
  const allowedTools = fm.tools
    ? fm.tools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const context =
    fm.context === "inline" || fm.context === "fork" ? fm.context : undefined;

  // 检测 prompt 中是否包含 {{args}} 占位符，自动注册参数
  const hasArgsParam =
    prompt.includes("{{args}}") || prompt.includes("{{ args }}");
  return {
    id: skillId,
    name: fm.name ?? skillId,  // frontmatter 中的 name 优先，否则使用文件名
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

/**
 * 将未知类型的值解析为经过验证的 SkillDefinition。
 *
 * 用于解析 JSON 格式的技能定义文件。对每个字段进行类型检查和默认值填充，
 * 缺少必填字段（id 或 prompt）的定义被视为无效。
 */
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
    return null;  // 缺少必填字段，视为无效定义
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

  // 使用展开运算符，只包含已定义的字段
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

/**
 * 解析技能参数列表。
 *
 * 对数组中每个元素进行类型验证和默认值处理：
 * - 类型字段必须是 "string"、"number" 或 "boolean" 之一，否则默认为 "string"
 * - 缺少 name 字段的参数会被跳过
 */
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
        : "string";  // 非法类型默认为 string
    const required =
      typeof obj.required === "boolean" ? obj.required : undefined;
    const def = obj.default;
    if (!name) {
      continue;  // 跳过缺少 name 的参数
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

/**
 * 解析字符串数组（类型安全的过滤）。
 *
 * 只保留数组中值为 string 类型的元素，过滤掉所有非字符串值。
 */
function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((s): s is string => typeof s === "string");
}

/**
 * 从项目记忆文件中创建隐式技能定义。
 *
 * ## 背景
 * 项目可以在 `.paw/CLAUDE.md`（提交到版本控制）和 `.paw/CLAUDE.local.md`
 * （本地，不提交）中定义项目级的规则和约定。这些文件的内容需要以技能的形式
 * 注入到每个 Agent 会话的系统提示词中。
 *
 * 返回的技能使用保留 ID：
 * - `_project_memory`：来自 CLAUDE.md（共享的项目规则）
 * - `_project_memory_local`：来自 CLAUDE.local.md（本地个人偏好）
 *
 * @param committedContent - CLAUDE.md 的内容（可以为 null 表示不存在）
 * @param localContent - CLAUDE.local.md 的内容（可以为 null 表示不存在）
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

/**
 * 渲染技能提示词 —— 将模板中的 {{param}} 占位符替换为实际参数值。
 *
 * ## 替换逻辑
 * 1. 遍历技能定义中的每个参数
 * 2. 从 args 中获取参数值，如果不存在则使用参数的默认值
 * 3. 如果值存在，用其字符串表示替换 {{paramName}}
 * 4. 如果必需参数值缺失，替换为 `[missing: paramName]` 标记
 * 5. 如果可选参数值缺失，替换为空字符串
 *
 * ## 额外处理
 * 如果技能设置了 `skillDir`，在渲染后的 prompt 前拼接目录路径提示，
 * 让模型在执行时知道资源文件的位置。
 */
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
          ? `[missing: ${param.name}]`  // 必填参数缺失时的占位标记
          : "";
    // 使用 split + join 而非 replaceAll，避免正则转义问题
    prompt = prompt.split(placeholder).join(replacement);
  }
  // 为目录型技能添加资源目录路径提示
  if (skill.skillDir) {
    prompt = `Base directory for this skill: ${skill.skillDir}\n\n${prompt}`;
  }
  return prompt;
}
