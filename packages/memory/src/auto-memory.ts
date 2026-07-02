/**
 * 自动记忆模块 — 跨会话持久化提取的事实/知识。
 *
 * ## 模块定位
 *
 * 本模块是 Paw 的记忆系统核心，负责将 AI 在对话过程中提取的关键信息（用户偏好、
 * 项目约定、错误修复经验、参考资料等）持久化到文件系统中，供后续会话检索和注入。
 *
 * ## 架构设计
 *
 * - **存储位置**: `~/.paw/projects/{hash}/memory/{name}.md`
 * - **文件格式**: YAML frontmatter（元数据） + Markdown body（正文内容）
 * - **索引分片**: 通过 `MEMORY.md`（主索引）和 `MEMORY-{n}.md`（分片文件）组织，
 *   避免单文件过大，每个分片最多容纳 `MAX_SHARD_SIZE`（180条）条目
 * - **去重策略**: `upsert` 通过名称或归一化 description 匹配已有条目，更新而非重复创建；
 *   对会话派生条目还额外按内容签名（session + category + contentHash）去重
 * - **过期归档**: 低优先级且长期未更新的条目会自动归档到 `memory/archive/` 目录
 * - **嵌入向量**: 支持 Base64 编码的 Float32Array 嵌入向量（v1 使用 nomic-embed-text via Ollama），
 *   用于语义相似度检索
 *
 * ## 关键设计决策
 *
 * 1. **YAML frontmatter 而非纯 JSON**: frontmatter 对人类阅读更友好，且与 Markdown 生态兼容
 * 2. **分片索引而非单一大文件**: 当记忆条目增长到数百条时，分片避免读写性能退化
 * 3. **upsert 而非 insert-only**: 避免重复记忆污染检索结果，同时保留手动设置的字段
 * 4. **归档而非删除**: 过期记忆移到 archive 目录而非直接删除，支持恢复和审计
 * 5. **双向链接**: `linked_memories` 字段支持记忆之间的双向引用，构建知识图谱
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  parseYamlFrontmatter,
  splitFrontmatter,
  stringifyYamlFrontmatter,
} from "@paw/core";
import {
  archiveExpiredEntries,
  rebuildArchiveIndex,
} from "./memory-archive.js";
import { memoryDir } from "@paw/core";

/** 记忆优先级：high（核心/重要）、mid（默认）、low（临时/次要） */
export type MemoryPriority = "high" | "mid" | "low";

/**
 * 单条自动记忆条目的数据结构。
 *
 * 每条记忆包含名称、描述、类型、正文以及可选的元数据（时间戳、标签、关联文件、
 * 嵌入向量、优先级、错误签名、工具使用记录、有效期、双向链接等）。
 */
export interface AutoMemoryEntry {
  /** 记忆的唯一名称，用作文件名 */
  readonly name: string;
  /** 简短的文字描述，用于检索匹配和索引展示 */
  readonly description: string;
  /** 记忆类型：用户偏好、反馈、项目约定、参考资料 */
  readonly type: "user" | "feedback" | "project" | "reference";
  /** 记忆正文，Markdown 格式 */
  readonly content: string;
  /** 创建时间戳（Unix ms），可选（P3/B1 优先级扩展字段） */
  readonly createdAt?: number;
  /** 最后更新时间戳（Unix ms），可选 */
  readonly updatedAt?: number;
  /** 标签列表，用于分类检索 */
  readonly tags?: readonly string[];
  /** 关联的文件路径列表 */
  readonly relatedFiles?: readonly string[];
  /** Base64 编码的 Float32Array 嵌入向量（v1: nomic-embed-text via Ollama） */
  readonly embedding?: string;
  /** 优先级分层：high（核心）、mid（默认）、low（临时/可丢弃） */
  readonly priority?: MemoryPriority;
  /** 提取的错误签名（错误码、异常名称等），用于错误关联检索 */
  readonly error_signatures?: readonly string[];
  /** 创建此记忆时使用的工具（MCP 工具名、harness 函数名等） */
  readonly tools_used?: readonly string[];
  /** 有效期截止时间戳（Unix ms），过期后记忆不再有效 */
  readonly valid_until?: number;
  /** 关联的其他记忆名称列表，用于双向链接和知识图谱遍历 */
  readonly linked_memories?: readonly string[];
}


/**
 * 自动记忆存储管理器。
 *
 * 封装了对记忆文件的所有 CRUD 操作，以及索引构建、分片管理、过期归档等功能。
 * 不直接管理嵌入向量的生成——那由上层（memory-retriever）负责。
 */
export class AutoMemoryStore {
  /** 记忆文件存储目录的绝对路径 */
  readonly memoryDir: string;

  /**
   * @param opts.workspaceRoot - 工作区根目录
   * @param opts.memoryDir - 可选的自定义记忆目录，未提供时使用默认路径
   */
  constructor(opts: { workspaceRoot: string; memoryDir?: string }) {
    this.memoryDir = opts.memoryDir ?? memoryDir(opts.workspaceRoot);
  }

  /**
   * 列出所有记忆条目。
   *
   * 排除主索引文件（MEMORY.md）和编号分片文件（MEMORY-\d+.md），
   * 只返回真正的记忆条目文件。
   */
  list(): AutoMemoryEntry[] {
    if (!existsSync(this.memoryDir)) return [];
    // 判断是否为主索引或分片文件：MEMORY.md 或 MEMORY-1.md, MEMORY-2.md 等
    const isShardFile = (f: string): boolean =>
      f === "MEMORY.md" || /^MEMORY-\d+\.md$/.test(f);
    return readdirSync(this.memoryDir)
      .filter((f) => f.endsWith(".md") && !isShardFile(f))
      .map((f) => this.load(path.basename(f, ".md")))
      .filter((e): e is AutoMemoryEntry => e !== null);
  }

  /**
   * 根据名称加载单条记忆。
   *
   * 解析 YAML frontmatter 获取元数据，body 部分作为正文。
   * 对嵌入向量字段做了 v1 兼容处理（embedding_v1 -> embedding）。
   *
   * @param name - 记忆名称（不含 .md 扩展名）
   * @returns 解析后的记忆条目，文件不存在或格式错误时返回 null
   */
  load(name: string): AutoMemoryEntry | null {
    const file = path.join(this.memoryDir, `${name}.md`);
    if (!existsSync(file)) return null;
    try {
      const text = readFileSync(file, "utf-8");
      const split = splitFrontmatter(text);
      if (!split) return null;
      const fm = parseYamlFrontmatter(split.frontmatter);
      const content = split.body.trim();
      const type = fm.type as AutoMemoryEntry["type"];
      // 必需字段校验：name、description、type 缺一不可
      if (!fm.name || !fm.description || !isValidType(type)) return null;
      const createdAt = fm.createdAt ? Number(fm.createdAt) : undefined;
      const updatedAt = fm.updatedAt ? Number(fm.updatedAt) : undefined;
      // v1 兼容：读取 embedding_v1 字段
      const embedding = fm.embedding_v1?.trim() || undefined;
      const priority = fm.priority && isValidPriority(fm.priority) ? fm.priority : undefined;
      const tags = parseCsvList(fm.tags);
      const relatedFiles = parseCsvList(fm.relatedFiles);
      const errorSignatures = parseCsvList(fm.error_signatures);
      const toolsUsed = parseCsvList(fm.tools_used);
      const validUntil = fm.valid_until ? Number(fm.valid_until) : undefined;
      const linked = parseCsvList(fm.linked_memories);
      return {
        name: fm.name,
        description: fm.description ?? "",
        type,
        content: content ?? "",
        // 条件展开：只在值有效时才包含，避免 undefined 字段污染
        ...(createdAt !== undefined && !Number.isNaN(createdAt)
          ? { createdAt }
          : {}),
        ...(updatedAt !== undefined && !Number.isNaN(updatedAt)
          ? { updatedAt }
          : {}),
        ...(embedding ? { embedding } : {}),
        ...(priority ? { priority } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(relatedFiles && relatedFiles.length > 0 ? { relatedFiles } : {}),
        ...(errorSignatures && errorSignatures.length > 0 ? { error_signatures: errorSignatures } : {}),
        ...(toolsUsed && toolsUsed.length > 0 ? { tools_used: toolsUsed } : {}),
        ...(validUntil !== undefined && !Number.isNaN(validUntil) ? { valid_until: validUntil } : {}),
        ...(linked && linked.length > 0 ? { linked_memories: linked } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * 保存一条记忆到文件。
   *
   * 注意：此方法不自动重建索引。批量操作后应调用 {@link buildIndex} 统一重建。
   * 会自动创建所需目录。
   */
  save(entry: AutoMemoryEntry): void {
    const file = path.join(this.memoryDir, `${entry.name}.md`);
    mkdirSync(this.memoryDir, { recursive: true });
    // 构建 frontmatter 键值对
    const fm: Record<string, string> = {
      name: entry.name,
      description: entry.description,
      type: entry.type,
    };
    // 可选字段：只在有值时才写入，保持 frontmatter 干净
    if (entry.createdAt !== undefined) fm.createdAt = String(entry.createdAt);
    if (entry.updatedAt !== undefined) fm.updatedAt = String(entry.updatedAt);
    if (entry.embedding) fm.embedding_v1 = entry.embedding;
    if (entry.priority) fm.priority = entry.priority;
    // 数组字段转为逗号分隔的字符串
    if (entry.tags && entry.tags.length > 0) fm.tags = entry.tags.join(", ");
    if (entry.relatedFiles && entry.relatedFiles.length > 0) fm.relatedFiles = entry.relatedFiles.join(", ");
    if (entry.error_signatures && entry.error_signatures.length > 0) fm.error_signatures = entry.error_signatures.join(", ");
    if (entry.tools_used && entry.tools_used.length > 0) fm.tools_used = entry.tools_used.join(", ");
    if (entry.valid_until !== undefined) fm.valid_until = String(entry.valid_until);
    if (entry.linked_memories && entry.linked_memories.length > 0) fm.linked_memories = entry.linked_memories.join(", ");
    const fmStr = stringifyYamlFrontmatter(fm);
    // 格式：frontmatter + 空行 + 正文
    writeFileSync(file, `${fmStr}\n\n${entry.content}\n`, "utf-8");
  }

  /**
   * 删除指定名称的记忆文件。
   *
   * 注意：此方法不自动重建索引。批量删除后应调用 {@link buildIndex}。
   */
  delete(name: string): void {
    const file = path.join(this.memoryDir, `${name}.md`);
    if (existsSync(file)) {
      rmSync(file);
    }
  }

  /**
   * 读取 MEMORY.md 主索引文件内容。
   *
   * 为防止索引过大占据上下文，默认截断到 `maxLines` 行（默认 200 行）。
   * 超出部分会显示省略提示，引导用户使用 memory.read 读取完整条目。
   *
   * @param maxLines - 最大返回行数，默认 200
   */
  loadIndex(maxLines = 200): string | null {
    const indexPath = path.join(this.memoryDir, "MEMORY.md");
    if (!existsSync(indexPath)) return null;
    try {
      const text = readFileSync(indexPath, "utf-8");
      const lines = text.split("\n");
      if (lines.length <= maxLines) return text.trimEnd();
      // 超出限制时截断并附加提示
      return (
        lines.slice(0, maxLines).join("\n") +
        `\n\n(... ${lines.length - maxLines} more index lines omitted; use memory.read for full entries)\n`
      );
    } catch {
      return null;
    }
  }

  /**
   * Upsert 操作：按名称或匹配 description 更新已有条目，否则创建新条目。
   *
   * ## 合并策略
   *
   * - 新条目的值优先：description、type、content 始终使用新值
   * - 旧条目的值兜底：priority、tags、relatedFiles 等可选字段在新值缺失时保留旧值
   * - 这避免了自动提取覆盖用户手动设置的字段（如手动调整的优先级）
   * - createdAt 保留首次创建时间，updatedAt 更新为当前时间
   *
   * @returns "created" 或 "updated"，指示实际操作类型
   */
  upsert(entry: AutoMemoryEntry): "created" | "updated" {
    const existing = this.findSimilar(entry);
    if (existing) {
      const prior = this.load(existing.name);
      this.save({
        // 新值优先，旧值兜底 — 避免覆盖手动设置的字段
        priority: entry.priority ?? prior?.priority,
        tags: entry.tags ?? prior?.tags,
        relatedFiles: entry.relatedFiles ?? prior?.relatedFiles,
        error_signatures: entry.error_signatures ?? prior?.error_signatures,
        tools_used: entry.tools_used ?? prior?.tools_used,
        valid_until: entry.valid_until ?? prior?.valid_until,
        linked_memories: entry.linked_memories ?? prior?.linked_memories,
        embedding: entry.embedding ?? prior?.embedding,
        // 以下为强制更新的字段：名称保持不变，描述/类型/正文使用新值
        name: existing.name,
        description: entry.description,
        type: entry.type,
        content: entry.content,
        createdAt: prior?.createdAt ?? entry.createdAt,
        updatedAt: entry.updatedAt ?? Date.now(),
      });
      return "updated";
    }
    // 未见匹配条目：全新创建
    this.save({
      ...entry,
      createdAt: entry.createdAt ?? Date.now(),
      updatedAt: entry.updatedAt ?? Date.now(),
    });
    return "created";
  }

  /**
   * 查找与给定条目相似的已有记忆。
   *
   * ## 匹配策略（按优先级）
   *
   * 1. **精确名称匹配**: 直接按 name 查找
   * 2. **归一化 description 匹配**: 去除首尾空白并转小写后比较
   * 3. **会话派生条目签名匹配**: 对于名称格式为 `sess-{sessionPrefix}-{category}-{contentHash}`
   *    的条目，按相同会话前缀 + 相同类别 + 相同内容哈希进行正则匹配。
   *    这确保同一会话中提取的相同内容不会被重复存储。
   */
  findSimilar(entry: AutoMemoryEntry): AutoMemoryEntry | null {
    // 策略1: 精确名称匹配
    const byName = this.load(entry.name);
    if (byName) return byName;

    const norm = (s: string) => s.trim().toLowerCase();
    const target = norm(entry.description);
    if (!target) return null;

    // 策略2: 归一化 description 匹配
    for (const e of this.list()) {
      if (norm(e.description) === target) return e;
    }

    // 策略3: 会话派生条目的内容签名匹配
    // 匹配格式: sess-{8位hex会话前缀}-{类别(dec/err)}-{12位hex内容哈希}
    const sessMatch = entry.name.match(/^(sess-[a-f0-9]{8})-(dec|err)-([a-f0-9]{12})$/);
    if (sessMatch) {
      const [, sessionPrefix, category, contentHash] = sessMatch;
      const namePattern = new RegExp(`^sess-${sessionPrefix}-${category}-${contentHash}$`);
      for (const e of this.list()) {
        if (namePattern.test(e.name)) return e;
      }
    }

    return null;
  }

  /** 每个 MEMORY 分片文件的最大条目数。超过此值会创建新分片。 */
  static readonly MAX_SHARD_SIZE = 180;

  /**
   * 从所有记忆条目生成索引（MEMORY.md + 分片文件）。
   *
   * ## 执行流程
   *
   * 1. 先归档过期的低优先级记忆（超过 90 天未更新）
   * 2. 如有归档发生，重建归档索引
   * 3. 按 MAX_SHARD_SIZE 分割条目，写入 MEMORY-1.md, MEMORY-2.md, ...
   * 4. 清理多余的过期分片文件（条目数减少时）
   * 5. 写入主索引 MEMORY.md，指向所有分片
   *
   * @returns 主索引的 Markdown 文本内容
   */
  buildIndex(): string {
    // 第一步：归档过期的低优先级记忆
    const archived = archiveExpiredEntries(this.list(), this.memoryDir, 90);
    if (archived.archivedNames.length > 0) {
      rebuildArchiveIndex(this.memoryDir);
    }

    const entries = this.list();
    const shardCount = Math.ceil(entries.length / AutoMemoryStore.MAX_SHARD_SIZE);

    // 第二步：写入每个分片文件
    for (let i = 0; i < shardCount; i++) {
      const slice = entries.slice(i * AutoMemoryStore.MAX_SHARD_SIZE, (i + 1) * AutoMemoryStore.MAX_SHARD_SIZE);
      const shardLines = [
        `# Memory Index — Shard ${i + 1}`,
        "",
        "| Name | Type | Priority | Description |",
        "|------|------|----------|-------------|",
        ...slice.map((e) =>
          `| ${e.name} | ${e.type} | ${e.priority ?? "mid"} | ${e.description} |`
        ),
        "",
      ];
      writeFileSync(
        path.join(this.memoryDir, `MEMORY-${i + 1}.md`),
        shardLines.join("\n"),
        "utf-8",
      );
    }

    // 第三步：清理多余分片（条目减少时，之前创建的分片索引号可能超出当前分片数）
    this.cleanStaleShards(shardCount);

    // 第四步：写入主索引文件
    const masterLines = [
      "# Memory Index",
      "",
      `${entries.length} entries across ${shardCount} shard(s)`,
      "",
      ...Array.from({ length: shardCount }, (_, i) => `- [Shard ${i + 1}](MEMORY-${i + 1}.md)`),
      "",
    ];
    const indexPath = path.join(this.memoryDir, "MEMORY.md");
    writeFileSync(indexPath, masterLines.join("\n"), "utf-8");
    return masterLines.join("\n");
  }

  /**
   * 加载所有索引分片并拼接为单个字符串。
   *
   * 先读取主索引 MEMORY.md 获取分片文件列表，再逐一读取分片内容。
   * 兼容旧格式：如果主索引不包含分片引用但本身是表格格式，直接返回主索引内容。
   */
  loadAllIndexShards(): string | null {
    const indexPath = path.join(this.memoryDir, "MEMORY.md");
    if (!existsSync(indexPath)) return null;

    try {
      // 从主索引中提取分片文件引用
      const master = readFileSync(indexPath, "utf-8");
      const shardMatches = master.match(/MEMORY-(\d+)\.md/g);
      const shardFiles = shardMatches ?? [];

      if (shardFiles.length === 0) {
        // 兼容旧格式：主索引本身就是表格格式的内容
        const text = readFileSync(indexPath, "utf-8");
        if (text.includes("| Name | Type |")) {
          return text.trimEnd();
        }
        return null;
      }

      // 拼接所有分片内容
      const parts: string[] = [];
      for (const shardFile of shardFiles) {
        const shardPath = path.join(this.memoryDir, shardFile);
        if (existsSync(shardPath)) {
          const content = readFileSync(shardPath, "utf-8");
          parts.push(content.trimEnd());
        }
      }
      return parts.length > 0 ? parts.join("\n\n") : null;
    } catch {
      return null;
    }
  }

  /**
   * 清理超出当前分片数量的旧分片文件。
   *
   * 当记忆条目减少时（如大量归档），之前创建的 MEMORY-{n}.md 可能不再需要，
   * 此方法从 currentShardCount+1 开始逐一检查并删除多余的分片文件。
   *
   * @param currentShardCount - 当前应有的分片数量
   * @returns 清理的分片文件数量
   */
  private cleanStaleShards(currentShardCount: number): number {
    let cleaned = 0;
    let i = currentShardCount + 1;
    while (true) {
      const shardPath = path.join(this.memoryDir, `MEMORY-${i}.md`);
      if (existsSync(shardPath)) {
        rmSync(shardPath);
        cleaned++;
        i++;
      } else {
        break;
      }
    }
    return cleaned;
  }

  /**
   * 归档过期的低优先级记忆。
   *
   * 将超过 `maxAgeDays` 天未更新的低优先级条目，以及 `valid_until` 已过期的条目，
   * 移动到 `memory/archive/` 目录。
   *
   * @param maxAgeDays - 未更新的最大容忍天数，默认 90 天
   * @returns 被归档的条目数量
   */
  archiveExpired(maxAgeDays = 90): number {
    return archiveExpiredEntries(this.list(), this.memoryDir, maxAgeDays)
      .archivedNames.length;
  }
}

/**
 * 解析逗号分隔的字符串列表。
 *
 * 用于从 YAML frontmatter 中读取 CSV 格式的字段（如 tags, relatedFiles 等）。
 * 空字符串或全空白字符串返回 undefined。
 */
function parseCsvList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return list.length > 0 ? list : undefined;
}

/** 类型守卫：验证字符串是否为合法的记忆类型 */
function isValidType(t: string): t is AutoMemoryEntry["type"] {
  return (
    t === "user" || t === "feedback" || t === "project" || t === "reference"
  );
}

/** 类型守卫：验证字符串是否为合法的优先级值 */
function isValidPriority(p: string): p is MemoryPriority {
  return p === "high" || p === "mid" || p === "low";
}
