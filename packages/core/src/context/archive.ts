/**
 * P3 冷库：可寻址归档（ARC 全套移植）。
 * ======================================
 *
 * v3 方案 ④（论文：ARC / PRO-LONG / Router-Mem）：
 * - 被截断/被驱逐的工具输出全文按「序号 ID + 内容哈希」存入 artifact registry，
 *   上下文中只保留紧凑引用桩（stub）——存储与呈现分离（ARC）。
 * - context.recall 工具按 ID 取回全文注入当前轮（取回预算三件套防再膨胀）。
 * - Cited 契约：模型实际 recall 过的 ID 在任务生命周期内不驱逐。
 * - 目录有界化：上下文内引用桩数量有界，超出后旧桩移出（ARC 命题 9）。
 *
 * 归档单元：动作+结果配对（Router-Mem 时间邻域）——条目携带产生它的
 * 工具调用文本（callerText）与创建轮次，recall 时可带回前后文。
 */

import { simpleHash } from "../utils/hash.js";

/** 归档条目的元数据（写入时提供） */
export interface ArchiveMeta {
  readonly tool: string;
  readonly ok: boolean;
  /** 产生该输出的轮次（0-based） */
  readonly turn: number;
  /** 产生该输出的模型动作文本（截取前 N 字符，动作+结果配对） */
  readonly callerText?: string;
}

/** 归档条目的完整记录 */
export interface ArchiveEntry {
  /** 可见序号（recall 的寻址键） */
  readonly id: string;
  /** 内容哈希（去重键：相同内容共享同一 id） */
  readonly hash: string;
  /** 全文（原样，可寻址恢复） */
  readonly content: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly turn: number;
  /** 内容字符数 */
  readonly size: number;
  /** 头 200 字预览（引用桩用） */
  readonly preview: string;
  /** 产生该输出的模型动作文本（截取） */
  readonly callerText?: string;
  /** Cited 契约：被 recall 过的条目任务生命周期内不可驱逐 */
  readonly cited: boolean;
  /** LRU：最近物化/取回的轮次（越大越新） */
  readonly lastUsedTurn: number;
}

/** 检索候选（无效 ID 转关键词检索的返回项） */
export interface ArchiveSearchResult {
  readonly id: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly turn: number;
  readonly size: number;
  readonly preview: string;
}

/** 最近 N 条归档（检索空结果时的回退候选） */
function recentEntries(
  byId: ReadonlyMap<string, ArchiveEntry>,
  limit: number,
): readonly ArchiveSearchResult[] {
  const out: ArchiveSearchResult[] = [];
  for (const entry of byId.values()) {
    if (out.length >= limit) break;
    out.push({
      id: entry.id,
      tool: entry.tool,
      ok: entry.ok,
      turn: entry.turn,
      size: entry.size,
      preview: entry.preview,
    });
  }
  return out;
}

/** 取回窗口：超长内容的头尾窗口 / 分块游标 */
export interface RecallWindow {
  /** 窗口类型：head（开头）/ tail（结尾）/ chunk（offset 游标） */
  readonly part: "head" | "tail" | "chunk";
  readonly offset: number;
  readonly length: number;
  readonly total: number;
}

export interface RecallOutcome {
  readonly ok: boolean;
  readonly entry?: ArchiveEntry;
  readonly window?: RecallWindow;
  readonly content?: string;
  /** 预算拒绝 / 无效 ID 时的说明 */
  readonly reason?: string;
  /** 无效 ID 自动转关键词检索的候选 */
  readonly candidates?: readonly ArchiveSearchResult[];
}

/**
 * 引用桩格式（上下文中的紧凑引用）：
 *   [archived id=17, tool=workspace.run_shell, size=82000, ok=true, turn=7, preview=...]
 * preview 已清洗（无 ] 与换行），保证可被 parseArchiveStub 精确解析。
 */
export const ARCHIVE_STUB_PATTERN =
  /\[archived id=(\d+), tool=([^,\]]+), size=(\d+), ok=(true|false), turn=(\d+), preview=([^\n\]]*)\]/;

/** 裸 ID 桩（P4.1 降级链第 3 级：引用桩降级后保留寻址键，去元数据） */
export const ARCHIVE_BARE_STUB_PATTERN = /\[archived id=(\d+)\]/;

/** 从文本中提取引用桩；无匹配返回 null */
export function parseArchiveStub(text: string): {
  readonly id: string;
  readonly tool: string;
  readonly size: number;
  readonly ok: boolean;
  readonly turn: number;
  readonly preview: string;
} | null {
  const m = text.match(ARCHIVE_STUB_PATTERN);
  if (!m) return null;
  return {
    id: m[1]!,
    tool: m[2]!,
    size: Number.parseInt(m[3]!, 10),
    ok: m[4] === "true",
    turn: Number.parseInt(m[5]!, 10),
    preview: m[6] ?? "",
  };
}

/** 从文本中提取裸 ID 桩的 id；无匹配返回 null */
export function parseBareArchiveStub(text: string): string | null {
  const m = text.match(ARCHIVE_BARE_STUB_PATTERN);
  return m ? m[1]! : null;
}

export interface ArtifactRegistryOptions {
  /** 上下文中引用桩的数量上限（目录有界化，ARC 命题 9） */
  readonly maxStubsInContext?: number;
  /** 裸 ID 桩的数量上限（降级链第 3 级；超出后最旧非 Cited 删除） */
  readonly maxBareStubsInContext?: number;
  /** 单次取回上限（字符） */
  readonly recallPerCallChars?: number;
  /** 每轮取回物化总预算（字符） */
  readonly recallPerTurnChars?: number;
  /** 每轮取回调用次数上限 */
  readonly recallPerTurnCalls?: number;
}

export const DEFAULT_ARCHIVE_OPTIONS: Required<ArtifactRegistryOptions> = {
  maxStubsInContext: 24,
  maxBareStubsInContext: 48,
  recallPerCallChars: 8_000,
  recallPerTurnChars: 16_000,
  recallPerTurnCalls: 2,
};

const PREVIEW_CHARS = 200;
const CALLER_TEXT_CHARS = 500;

/** 清洗 preview：引用桩单行可解析（去换行/方括号/控制字符） */
function sanitizePreview(text: string): string {
  return text
    .replace(/[\]\n\r]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_CHARS);
}

/**
 * P3 冷库：会话级可寻址归档注册表。
 *
 * - store：按内容哈希去重（相同内容观察共享同一 id，重复 ls/git status 免费去重）
 * - getByHash：去重键寻址（供 P1 入口闸的 [repeat of #hash] 链接到归档 id）
 * - search：关键词检索（无效 ID 的兜底，不静默失败）
 * - markCited：Cited 契约（recall 过 → 任务生命周期内不可驱逐）
 * - startTurn：每轮重置取回预算计数（每步 ≤2 次、每轮 ≤16K 字符）
 * - tryRecall：取回预算三件套（单次 ≤8K、每轮 ≤16K、LRU 回退）
 */
export class ArtifactRegistry {
  private readonly opts: Required<ArtifactRegistryOptions>;
  private readonly byId = new Map<string, ArchiveEntry>();
  private readonly byHash = new Map<string, string>();
  private seq = 0;
  /** 当前轮取回预算：调用次数 + 已物化字符（startTurn 重置） */
  private turnRecallCalls = 0;
  private turnRecallChars = 0;
  /** 当前轮各条目已计费字符（同 id 重复取回不重复计费） */
  private turnCharged = new Map<string, number>();
  private turn = 0;

  constructor(opts?: ArtifactRegistryOptions) {
    this.opts = { ...DEFAULT_ARCHIVE_OPTIONS, ...opts };
  }

  /** 注册表内条目总数 */
  get size(): number {
    return this.byId.size;
  }

  /** 当前取回预算占用（字符） */
  get currentTurnRecallChars(): number {
    return this.turnRecallChars;
  }

  get recallPerTurnChars(): number {
    return this.opts.recallPerTurnChars;
  }

  get recallPerTurnCalls(): number {
    return this.opts.recallPerTurnCalls;
  }

  get recallPerCallChars(): number {
    return this.opts.recallPerCallChars;
  }

  /** 归档全文；相同内容（同哈希）返回已有 id（去重键）。 */
  store(content: string, meta: ArchiveMeta): string | null {
    if (!content || content.length === 0) return null;
    const hash = simpleHash(content);
    const existing = this.byHash.get(hash);
    if (existing !== undefined) {
      const entry = this.byId.get(existing);
      if (entry) return entry.id;
    }
    this.seq += 1;
    const id = String(this.seq);
    const entry: ArchiveEntry = {
      id,
      hash,
      content,
      tool: meta.tool,
      ok: meta.ok,
      turn: meta.turn,
      size: content.length,
      preview: sanitizePreview(content),
      ...(meta.callerText
        ? { callerText: meta.callerText.slice(0, CALLER_TEXT_CHARS) }
        : {}),
      cited: false,
      lastUsedTurn: meta.turn,
    };
    this.byId.set(id, entry);
    this.byHash.set(hash, id);
    return id;
  }

  /** 按序号 ID 取条目；不存在返回 undefined */
  get(id: string): ArchiveEntry | undefined {
    return this.byId.get(id);
  }

  /** 按内容哈希取条目（去重键寻址） */
  getByHash(hash: string): ArchiveEntry | undefined {
    const id = this.byHash.get(hash);
    return id !== undefined ? this.byId.get(id) : undefined;
  }

  /** 关键词检索：工具名/预览/全文头 2K 的宽松匹配 */
  search(query: string, limit = 10): readonly ArchiveSearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: ArchiveSearchResult[] = [];
    for (const entry of this.byId.values()) {
      if (out.length >= limit) break;
      const haystack = `${entry.tool} ${entry.preview} ${entry.content.slice(0, 2_000)}`.toLowerCase();
      if (q.split(/\s+/).every((term) => haystack.includes(term))) {
        out.push({
          id: entry.id,
          tool: entry.tool,
          ok: entry.ok,
          turn: entry.turn,
          size: entry.size,
          preview: entry.preview,
        });
      }
    }
    return out;
  }

  /** Cited 契约：标记为已取回（任务生命周期内不驱逐、引用桩不降级） */
  markCited(id: string): void {
    const entry = this.byId.get(id);
    if (entry) this.byId.set(id, { ...entry, cited: true });
  }

  isCited(id: string): boolean {
    return this.byId.get(id)?.cited === true;
  }

  /** 构建引用桩文本（上下文中可见的紧凑引用） */
  toStub(id: string): string {
    const e = this.byId.get(id);
    if (!e) return "";
    return `[archived id=${e.id}, tool=${e.tool}, size=${e.size}, ok=${e.ok}, turn=${e.turn}, preview=${e.preview}]`;
  }

  /** 构建裸 ID 桩（P4.1 降级链第 3 级：去元数据，仅保留寻址键） */
  toBareStub(id: string): string {
    return `[archived id=${id}]`;
  }

  /**
   * P4.1 降级链（Self-GC 三动作 + ARC 降级顺序）：
   *   内联（短内容）→ 引用桩（fold，可恢复）→ 裸 ID 桩（引用桩降级）
   *   → mask（截断骨架）→ prune（删除，无恢复保证）
   * 在文本中把完整引用桩降级为裸 ID 桩（Cited 桩不降级）。
   */
  downgradeStubToBare(text: string): string {
    return text.replace(ARCHIVE_STUB_PATTERN, (_m, id: string) => {
      return this.isCited(id) ? _m : this.toBareStub(id);
    });
  }

  /** 统计文本中的引用桩数量（完整桩 + 裸 ID 桩） */
  static countStubs(text: string): number {
    let n = 0;
    const re = new RegExp(
      `(?:${ARCHIVE_STUB_PATTERN.source})|(?:${ARCHIVE_BARE_STUB_PATTERN.source})`,
      "g",
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      n++;
      if (m.index + m[0].length >= text.length) break;
    }
    return n;
  }

  /** 每轮开始：重置取回预算（每步 ≤2 次、每轮 ≤16K 字符） */
  startTurn(turn: number): void {
    this.turn = turn;
    this.turnRecallCalls = 0;
    this.turnRecallChars = 0;
    this.turnCharged.clear();
  }

  /**
   * 取回（context.recall 工具的唯一入口）。
   *
   * 预算三件套（ARC 防再膨胀）：
   * 1. 单次上限 recallPerCallChars（8K）：超长 → 头/尾窗口或 offset 分块游标
   * 2. 每轮物化总预算 recallPerTurnChars（16K）：超限不注入
   * 3. 每步 ≤ recallPerTurnCalls（2）次
   * LRU：物化占用按 lastUsedTurn 追踪；新取回超预算时最久未用条目回退引用桩
   *  （条目本身保留，id 始终可再取回）。
   */
  tryRecall(idOrHash: string, opts?: {
    readonly part?: "head" | "tail" | "chunk";
    readonly offset?: number;
    readonly limit?: number;
  }): RecallOutcome {
    const entry = this.byId.get(idOrHash) ?? this.getByHash(idOrHash);
    if (!entry) {
      // 无效 ID → 自动转关键词检索返回候选列表（不静默失败）；
      // 检索为空时回退最近归档条目，让模型有可选的 id
      const candidates = this.search(idOrHash);
      const fallback =
        candidates.length > 0 ? candidates : recentEntries(this.byId, 5);
      return {
        ok: false,
        reason: `no archived artifact with id/hash "${idOrHash}"`,
        ...(fallback.length > 0 ? { candidates: fallback } : {}),
      };
    }

    if (this.turnRecallCalls >= this.opts.recallPerTurnCalls) {
      return {
        ok: false,
        reason: `recall budget exceeded: at most ${this.opts.recallPerTurnCalls} recall calls per turn`,
      };
    }

    const part = opts?.part ?? "head";
    const limit = Math.min(
      opts?.limit ?? this.opts.recallPerCallChars,
      this.opts.recallPerCallChars,
    );

    // 窗口计算（分块游标）
    let window: RecallWindow;
    let content: string;
    if (part === "tail") {
      const len = Math.min(entry.size, limit);
      content = entry.content.slice(entry.size - len);
      window = { part, offset: entry.size - len, length: len, total: entry.size };
    } else if (part === "chunk") {
      const offset = Math.max(0, Math.min(opts?.offset ?? 0, entry.size));
      const len = Math.min(limit, entry.size - offset);
      content = entry.content.slice(offset, offset + len);
      window = { part, offset, length: len, total: entry.size };
    } else {
      const len = Math.min(entry.size, limit);
      content = entry.content.slice(0, len);
      window = { part: "head", offset: 0, length: len, total: entry.size };
    }

    // 每轮物化总预算：超限 → LRU 回退（最久未用物化条目移出物化集，id 保持可见）。
    // 同 id 本轮已取回过的部分不重复计费（内容已在上下文中）。
    const alreadyCharged = this.turnCharged.get(entry.id) ?? 0;
    const additional = Math.max(0, window.length - alreadyCharged);
    if (this.turnRecallChars + additional > this.opts.recallPerTurnChars) {
      this.evictLruFor(additional, entry.id);
    }
    if (this.turnRecallChars + additional > this.opts.recallPerTurnChars) {
      return {
        ok: false,
        reason: `recall budget exceeded: ${this.opts.recallPerTurnChars} materialized chars per turn`,
      };
    }

    this.turnRecallCalls += 1;
    this.turnRecallChars += additional;
    this.turnCharged.set(entry.id, alreadyCharged + additional);
    this.markCited(entry.id);
    this.byId.set(entry.id, {
      ...entry,
      cited: true,
      lastUsedTurn: this.turn,
    });
    return { ok: true, entry, window, content };
  }

  /**
   * LRU 回退：超预算时把「上一轮或更早物化」的条目从当前占用中释放
   * （引用桩保持可见，id 仍可再取回）。
   *
   * 只回退 lastUsedTurn < 当前轮的条目——本轮物化的内容已经在上下文中
   * （recall 结果注入当前轮），无法撤销，必须全额计入预算。
   */
  private evictLruFor(incoming: number, skipId: string): void {
    let free = 0;
    const sorted = [...this.byId.values()]
      .filter((e) => e.lastUsedTurn < this.turn && e.id !== skipId)
      .sort((a, b) => a.lastUsedTurn - b.lastUsedTurn);
    for (const e of sorted) {
      if (this.turnRecallChars + incoming - free <= this.opts.recallPerTurnChars) {
        break;
      }
      // 回退：物化占用释放，条目保留（stub 仍在上下文中，id 仍可寻址）
      const charged = this.turnCharged.get(e.id) ?? 0;
      free += charged > 0 ? charged : Math.min(e.size, this.opts.recallPerCallChars);
      this.turnCharged.delete(e.id);
    }
    this.turnRecallChars = Math.max(0, this.turnRecallChars - free);
  }

  /**
   * 目录有界化（P4.1 降级链）：给定消息列表，
   * 1. 完整引用桩数量 > maxStubsInContext → 最旧非 Cited 桩降级为裸 ID 桩
   * 2. 裸 ID 桩数量 > maxBareStubsInContext → 最旧非 Cited 桩删除
   * （Cited 桩地址永久有效，不可降级不可驱逐）
   * 返回处理后消息（不修改入参）。
   */
  trimStubsInMessages<T extends { content: string }>(
    messages: readonly T[],
  ): { readonly messages: T[]; readonly removed: number } {
    const max = this.opts.maxStubsInContext;
    const maxBare = this.opts.maxBareStubsInContext;
    if (max <= 0) return { messages: [...messages], removed: 0 };
    // 收集所有完整引用桩（消息顺序 = 时间顺序）
    const fullStubs: Array<{ msgIdx: number; id: string }> = [];
    const bareStubs: Array<{ msgIdx: number; id: string }> = [];
    for (let i = 0; i < messages.length; i++) {
      const content = messages[i]?.content ?? "";
      const re = /\[archived id=\d+/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const parsed = parseArchiveStub(content.slice(m.index));
        if (parsed) {
          fullStubs.push({ msgIdx: i, id: parsed.id });
        } else {
          const bareId = parseBareArchiveStub(content.slice(m.index));
          if (bareId) bareStubs.push({ msgIdx: i, id: bareId });
        }
        if (m.index + 12 >= content.length) break;
      }
    }

    let removed = 0;
    const out = messages.map((m) => ({ ...m, content: m.content }));

    // 阶段 1：完整桩超限 → 降级为裸 ID（保留寻址键）
    let downgraded = 0;
    for (const stub of fullStubs) {
      if (fullStubs.length - downgraded <= max) break;
      if (this.isCited(stub.id)) continue;
      const msg = out[stub.msgIdx];
      if (!msg) continue;
      msg.content = this.downgradeStubToBare(msg.content);
      downgraded += 1;
      removed += 1;
    }

    // 阶段 2：裸 ID 桩超限 → 删除最旧非 Cited（阶段 1 已把所有可降级桩降为裸 ID）
    if (maxBare > 0) {
      const allBare: Array<{ msgIdx: number; id: string }> = [];
      for (let i = 0; i < out.length; i++) {
        const content = out[i]?.content ?? "";
        const re = /\[archived id=\d+\]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const bareId = parseBareArchiveStub(content.slice(m.index));
          if (bareId) allBare.push({ msgIdx: i, id: bareId });
          if (m.index + m[0].length >= content.length) break;
        }
      }
      let deleted = 0;
      for (const stub of allBare) {
        if (allBare.length - deleted <= maxBare) break;
        if (this.isCited(stub.id)) continue;
        const msg = out[stub.msgIdx];
        if (!msg) continue;
        const re = new RegExp(`\\n?\\s*\\[archived id=${stub.id}\\]`, "g");
        msg.content = msg.content.replace(re, "");
        deleted += 1;
        removed += 1;
      }
    }
    return { messages: out, removed };
  }
}
