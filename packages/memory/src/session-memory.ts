/**
 * 会话记忆模块 — 为对话上下文提供结构化的 Markdown 持久化。
 *
 * ## 模块定位
 *
 * 每个会话（session）在一次对话中会产生大量上下文信息：当前任务目标、正在进行的工作状态、
 * 关键决策、遇到的错误及其修复方案等。本模块负责将这些信息以结构化方式持久化到文件系统，
 * 使会话在中断/恢复时能够快速重建上下文，同时也为跨会话的记忆检索提供数据源。
 *
 * ## 架构设计
 *
 * - **存储位置**: `~/.paw/projects/{hash}/session-memory/{sessionId}.md`
 * - **文件格式**: YAML frontmatter（会话元数据） + Markdown sections（会话内容）
 * - **Section 结构**: 使用 `## SectionName` 二级标题组织内容，包括：
 *   - Task（任务描述）
 *   - Current State（当前工作状态）
 *   - Files & Functions（涉及的文件和函数）
 *   - Key Decisions（关键决策列表，使用 `- ` 项目符号）
 *   - Errors & Fixes（错误和修复列表，使用 `- ` 项目符号）
 *   - Relevant Context（相关上下文信息）
 * - **最近会话查询**: `listRecent` 按文件修改时间倒序排列，支持快速获取最近的 N 个会话
 *
 * ## 关键设计决策
 *
 * 1. **Markdown sections 而非 JSON 字段**: sections 格式对人类阅读和 AI 解析都友好，
 *    且与 Claude 的 Markdown 理解能力天然契合
 * 2. **按会话 ID 隔离**: 每个会话独立一个文件，避免锁竞争和写入冲突
 * 3. **文件 mtime 作为排序依据**: 利用文件系统自身的时间戳，无需在 frontmatter 中维护额外的排序索引
 * 4. **列表字段使用 Markdown 列表语法**: Key Decisions 和 Errors & Fixes 使用 `- item` 格式，
 *    解析时通过 `startsWith("- ")` 识别，简洁且不易与正文混淆
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  parseYamlFrontmatter,
  parseMarkdownSections,
  splitFrontmatter,
  stringifyYamlFrontmatter,
} from "@paw/core";
import { sessionMemoryDir } from "@paw/core";

/**
 * 单次会话记忆的数据结构。
 *
 * 包含会话标识、所属项目、更新时间戳，以及多个可选的上下文信息 section。
 */
export interface SessionMemory {
  /** 会话唯一标识符 */
  readonly session: string;
  /** 所属项目名称 */
  readonly project: string;
  /** 最后更新时间戳（Unix ms），用于排序和过期判断 */
  readonly updatedAt: number;
  /** 当前任务描述 */
  readonly task?: string;
  /** 当前工作状态（进度、正在处理的文件等） */
  readonly currentState?: string;
  /** 涉及的文件和函数列表 */
  readonly filesAndFunctions?: readonly string[];
  /** 关键决策列表 */
  readonly keyDecisions?: readonly string[];
  /** 错误及其修复方案列表 */
  readonly errorsAndFixes?: readonly string[];
  /** 其他相关上下文信息（自由文本） */
  readonly relevantContext?: string;
}


/**
 * 会话记忆存储管理器。
 *
 * 封装会话记忆的加载、保存、查询操作。支持按 sessionId 精确读写，
 * 也支持按最近修改时间批量查询。
 */
export class SessionMemoryStore {
  /** 会话记忆文件存储目录的绝对路径 */
  private readonly sessionsDir: string;

  /**
   * @param opts.workspaceRoot - 工作区根目录
   * @param opts.sessionsDir - 可选的自定义会话目录，未提供时使用默认路径
   */
  constructor(opts: { workspaceRoot: string; sessionsDir?: string }) {
    this.sessionsDir =
      opts.sessionsDir ?? sessionMemoryDir(opts.workspaceRoot);
  }

  /**
   * 加载指定会话 ID 的记忆。
   *
   * @param sessionId - 会话唯一标识符（不含 .md 扩展名）
   * @returns 解析后的会话记忆，文件不存在时返回 null
   */
  load(sessionId: string): SessionMemory | null {
    const file = path.join(this.sessionsDir, `${sessionId}.md`);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf-8");
    return this.fromMarkdown(text);
  }

  /**
   * 保存会话记忆到文件。
   *
   * 自动创建所需目录，以 Markdown（frontmatter + sections）格式写入。
   *
   * @param sessionId - 会话唯一标识符
   * @param memory - 会话记忆数据
   */
  save(sessionId: string, memory: SessionMemory): void {
    const file = path.join(this.sessionsDir, `${sessionId}.md`);
    mkdirSync(this.sessionsDir, { recursive: true });
    writeFileSync(file, this.toMarkdown(memory), "utf-8");
  }

  /**
   * 加载最近一次更新的会话记忆。
   *
   * 实质上是 `listRecent(1)` 的便捷封装，用于会话恢复时快速获取上一次的上下文。
   */
  loadLatest(): SessionMemory | null {
    return this.listRecent(1)[0] ?? null;
  }

  /**
   * 按最近修改时间列出会话记忆，最新的在前。
   *
   * 使用文件系统的 mtime（修改时间）作为排序依据，避免额外的排序索引维护。
   *
   * @param limit - 最多返回的会话数量，默认 5
   * @returns 按 updatedAt 降序排列的会话记忆数组
   */
  listRecent(limit = 5): SessionMemory[] {
    if (!existsSync(this.sessionsDir) || limit <= 0) return [];
    const files = readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const fp = path.join(this.sessionsDir, f);
        return { path: fp, mtime: statSync(fp).mtimeMs };
      })
      // 按修改时间降序排序（最新的在前）
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    const memories: SessionMemory[] = [];
    for (const file of files) {
      const text = readFileSync(file.path, "utf-8");
      const memory = this.fromMarkdown(text);
      if (memory) memories.push(memory);
    }
    return memories;
  }

  /**
   * 将 SessionMemory 对象序列化为 Markdown 字符串。
   *
   * 格式：
   *   ---（frontmatter YAML）
   *   # Session Memory
   *   ## Task / ## Current State / ## Files & Functions / ...
   *
   * 空 section 不会出现在输出中，保持文件精简。
   */
  toMarkdown(memory: SessionMemory): string {
    // 必选字段写入 frontmatter
    const fm: Record<string, string> = {
      session: memory.session,
      project: memory.project,
      updatedAt: String(memory.updatedAt),
    };

    const sections: string[] = [];
    // 各 section 按二级标题组织，内容紧跟标题
    if (memory.task) {
      sections.push(`## Task\n${memory.task}`);
    }
    if (memory.currentState) {
      sections.push(`## Current State\n${memory.currentState}`);
    }
    if (memory.filesAndFunctions?.length) {
      sections.push(
        `## Files & Functions\n${memory.filesAndFunctions.join("\n")}`,
      );
    }
    if (memory.keyDecisions?.length) {
      sections.push(
        `## Key Decisions\n${memory.keyDecisions.map((d) => `- ${d}`).join("\n")}`,
      );
    }
    if (memory.errorsAndFixes?.length) {
      sections.push(
        `## Errors & Fixes\n${memory.errorsAndFixes.map((e) => `- ${e}`).join("\n")}`,
      );
    }
    if (memory.relevantContext) {
      sections.push(`## Relevant Context\n${memory.relevantContext}`);
    }

    // body 部分：一级标题 + 各 section
    const body =
      sections.length > 0 ? `# Session Memory\n\n${sections.join("\n\n")}` : "";
    return `${stringifyYamlFrontmatter(fm)}\n\n${body}\n`;
  }

  /**
   * 从 Markdown 字符串反序列化为 SessionMemory 对象。
   *
   * 解析流程：
   * 1. 分离 frontmatter（YAML）和 body（Markdown）
   * 2. 从 frontmatter 提取 session、project、updatedAt 等必选字段
   * 3. 用 parseMarkdownSections 按 `## SectionName` 分割 body
   * 4. 按 section 名称映射到对应的 SessionMemory 字段
   *
   * 注意：Key Decisions 和 Errors & Fixes 中的列表项以 `- ` 开头，
   * 解析时去掉前缀取实际内容。
   */
  fromMarkdown(text: string): SessionMemory | null {
    const split = splitFrontmatter(text);
    if (!split) return null;
    const fm = parseYamlFrontmatter(split.frontmatter);
    const body = split.body;

    const session = fm.session;
    const project = fm.project;
    const updatedAt = Number(fm.updatedAt);
    // 必选字段缺失或无效则返回 null
    if (!session || !project || Number.isNaN(updatedAt)) return null;

    // 按 ## 二级标题解析 Markdown sections
    const sections = parseMarkdownSections(body);

    return {
      session,
      project,
      updatedAt,
      task: sections.task,
      currentState: sections["current state"],
      // Files & Functions：按行分割，过滤空行
      filesAndFunctions: sections["files & functions"]
        ?.split("\n")
        .filter(Boolean),
      // Key Decisions：只提取以 "- " 开头的行，去掉前缀
      keyDecisions: sections["key decisions"]
        ?.split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2)),
      // Errors & Fixes：同上
      errorsAndFixes: sections["errors & fixes"]
        ?.split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2)),
      relevantContext: sections["relevant context"],
    };
  }

}
