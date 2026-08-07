/**
 * 触发式检索管线（spec v2 §6 / §9.1，M6）
 *
 * 检索由事件触发而非每步执行；召回可以宽，注入必须少。
 * 流程：触发 → query 构造（§6.2）→ hybrid 召回（M2，α：T1=0.5/T2=0.7）
 * → LLM 精排（§6.4 输出契约，序号映射回真实 id）→ disagreement gate（§6.5）
 * → XML 注入包（§6.6，预算 ≤500 tokens）。
 *
 * 降级（§6.7）：空库/无命中零开销；召回单路失败 → 另一路；精排失败 →
 * 召回分数直取 top-k（k 减半）；embedding 不可用由 hybridRecall 内部降级。
 */

import { TiktokenEstimator } from "@paw/core";
import type { RunEvent } from "@paw/core";
import type { MemoryEntry, MemoryKind, MemoryStoreEngine } from "../store/engine.js";
import { hybridRecall, RECALL_ALPHA, type ScoredEntry } from "./hybrid.js";
import { appendOpLog } from "../observability/op-log.js";
import { recordRetrievalHits } from "../observability/ledger.js";
import { listTrialLessons, decrementTrialAttempts } from "../write/trial.js";

// ── 触发与配置（§9.1 / §9.4）──

export type MemoryTrigger =
  | { type: "task_start"; taskDescription: string; branch?: string; repo?: string; runId?: string }
  | { type: "action_failed"; errorOutput: string; lastActionSummary: string; branch?: string; repo?: string; runId?: string }
  | { type: "post_compact"; summaryHead: string; goal: string; repo?: string; runId?: string; existingContextHints?: string[] }
  | { type: "explicit_query"; question: string; repo?: string; runId?: string };

export interface RetrieverOptions {
  engine: MemoryStoreEngine;
  /** 精排 LLM（缺省 → 召回分数直取 top-k） */
  reranker?: RerankerLlm;
  /**
   * T1 query 改写 LLM（§6.2，修复批次 B #9）：提炼核心概念检索词，
   * 与原始描述两路召回合并；缺省/失败 → 降级原文单路 + degraded 标记
   */
  queryRewriter?: RerankerLlm;
  /** 各触发点注入上限（§6.1 表） */
  topK?: Partial<{ taskStart: number; actionFailed: number; postCompact: number; explicitQuery: number }>;
  /** 注入预算，默认 500 tokens（§6.6） */
  maxInjectTokens?: number;
  emit?: (event: RunEvent) => void;
  /** token 估算器（默认 TiktokenEstimator cl100k） */
  countTokens?: (text: string) => number;
  /**
   * shadow 模式（spec §11.2）：检索全流程照常，但假设注入包只记录不注入——
   * 不涨 freq 账本、不发射 memory.inject，op-log 记 read.shadow 含完整假设包，
   * 供事后回放"如果开了记忆会注入什么"。
   */
  shadow?: boolean;
}

export interface RerankerLlm {
  complete(prompt: string): Promise<string>;
}

export type InjectStatus = "verified" | "trial" | "reference";

export interface InjectedMemory {
  id: string;
  kind: MemoryKind | "trial";
  /** 注入正文（否定句逐字保留，绝不 paraphrase，§6.6） */
  text: string;
  /** 检索键（episodic 的 whenToUse，注入段首行） */
  whenToUse?: string;
  status: InjectStatus;
  /** 精排给的"为何相关"（一句） */
  why?: string;
  score: number;
  /** 失效时间（仅 T4 过期条目非空，§6.6 失效标注） */
  tInvalid?: string;
  /** profile 画像的支持证据数（预算内按 supportCount 降序的排序键） */
  supportCount?: number;
  /** 单条超预算被条目内截断（正文尾部标注"已截断"） */
  truncated?: boolean;
}

export interface InjectionPackage {
  items: InjectedMemory[];
  totalTokens: number;
  /** true = 召回或精排走了降级路径 */
  degraded: boolean;
  /** 带 XML 来源标签的最终注入文本（§6.6）；空包返回空串 */
  render(): string;
}

// ── T2 防误检与 query 构造（§6.2，纯函数）──

const NON_ACTIONABLE_RE = /permission denied|EACCES|EPERM|operation not permitted|用户中止|用户取消|aborted by user|user abort(?:ed)?|interrupted|SIGINT|Ctrl\+C|手动取消/i;
const ACTIONABLE_RE = /error|failed|failure|exception|panic|traceback|exit(?:ed)?(?:\s+with)?(?:\s+code)?\s+[1-9]\d*|报错|失败/i;

/** T2 仅对"可行动错误"触发：权限拒绝/用户中止不触发（§6.2 防误检） */
export function isActionableError(errorOutput: string): boolean {
  if (NON_ACTIONABLE_RE.test(errorOutput)) return false;
  return ACTIONABLE_RE.test(errorOutput);
}

const ERROR_TYPE_RE = /\b([A-Z][\w]*(?:Error|Exception)|error\s+TS\d+|FAIL(?:ED)?)\b/;
const STACK_LINE_RE = /^\s*(?:at\s+\S+|\S+:\d+:\d+|File\s+")/;

/** T2 query = errorType + 关键堆栈行（错误输出 ≤400 字符）+ 上一轮动作摘要（§6.2） */
export function buildActionFailedQuery(errorOutput: string, lastActionSummary: string): string {
  const truncated = errorOutput.slice(0, 400);
  const errorType = ERROR_TYPE_RE.exec(truncated)?.[0] ?? "";
  const stackLines = truncated.split("\n").filter((l) => STACK_LINE_RE.test(l)).slice(0, 2)
    .map((l) => l.trim().slice(0, 120));
  return [errorType, ...stackLines, lastActionSummary.slice(0, 100)].filter(Boolean).join("\n");
}

/** T3 去重（§6.1）：条目文本与 SessionMemory hints 高重叠 → 跳过 */
export function isCoveredByHints(entryText: string, hints: readonly string[]): boolean {
  const tokens = new Set(entryText.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  if (tokens.size === 0) return false;
  for (const hint of hints) {
    const hintTokens = new Set(hint.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
    if (hintTokens.size === 0) continue;
    let overlap = 0;
    for (const t of tokens) if (hintTokens.has(t)) overlap += 1;
    if (overlap / tokens.size > 0.6) return true;
  }
  return false;
}

// ── 精排（§6.4 输出契约）──

export interface RerankItem {
  /** 1-based 序号（对应 prompt 中的候选编号） */
  seq: number;
  why: string;
  label: "applicable" | "reference";
}

export function buildRerankPrompt(query: string, candidates: readonly ScoredEntry[]): string {
  const blocks = candidates.map((c, i) => {
    const text = entryText(c.entry);
    return `候选 ${i + 1}:\n${text}`;
  });
  return `你是记忆精排器。从候选中选出与当前任务最相关的 1–3 条，输出 JSON。

对每条入选输出：seq（候选整数序号）、why（一句"为何相关"）、label：
- applicable = 直接适用于当前任务 → 以"建议策略"身份注入
- reference = 可能不相关的历史参考 → 以弱措辞注入

输出契约（严格遵守，序号只用上方候选的整数编号）：
{ "items": [ { "seq": 1, "why": "…", "label": "applicable" } ] }
没有相关候选时输出 { "items": [] }。

当前任务/查询：
${query}

${blocks.join("\n\n")}`;
}

// ── T1 query 改写（§6.2，#9）──

export function buildQueryRewritePrompt(taskDescription: string): string {
  return `从任务描述中提炼 3–6 个核心概念作为记忆库检索词（技术名词/错误类型/组件名，空格分隔，单行输出，不要解释）。

任务描述：
${taskDescription}`;
}

/** 校验改写输出：单行、≤300 字符、不含引号包裹；非法 → null（降级原文单路） */
export function parseQueryRewrite(raw: string): string | null {
  const firstLine = raw.trim().split("\n")[0]?.trim() ?? "";
  const cleaned = firstLine.replace(/^["'`]+|["'`]+$/g, "");
  if (cleaned.length === 0 || cleaned.length > 300) return null;
  if (/[{}\[\]]/.test(cleaned)) return null; // 拒绝 JSON 残骸
  return cleaned;
}

/** 手写校验精排输出；非法 → null（调用方降级召回直取） */
export function parseRerankOutput(raw: string, numCandidates: number): RerankItem[] | null {  let parsed: unknown;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;

  const out: RerankItem[] = [];
  for (const it of items) {
    if (typeof it !== "object" || it === null) return null;
    const r = it as Record<string, unknown>;
    if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 1 || r.seq > numCandidates) return null;
    if (r.label !== "applicable" && r.label !== "reference") return null;
    out.push({ seq: r.seq, why: typeof r.why === "string" ? r.why : "", label: r.label });
  }
  return out;
}

// ── 条目正文（注入内容，逐字不改写）──

export function entryText(entry: MemoryEntry): string {
  switch (entry.kind) {
    case "semantic":
      return entry.fact;
    case "episodic":
      return [entry.perspective, ...entry.modification.map((m) => `- ${m}`)].join("\n");
    case "profile":
      return entry.insight;
    case "vault_ref":
      return entry.refDescription;
  }
}

function entryWhenToUse(entry: MemoryEntry): string | undefined {
  return entry.kind === "episodic" ? entry.whenToUse : undefined;
}

// ── 触发点配置（§6.1 表）──

const TRIGGER_KINDS: Record<MemoryTrigger["type"], MemoryKind[] | undefined> = {
  task_start: ["episodic", "profile"],
  action_failed: ["episodic", "semantic"],
  post_compact: ["semantic", "profile"],
  explicit_query: undefined, // T4 全库（含历史）
};

const DEFAULT_TOPK = { taskStart: 1, actionFailed: 3, postCompact: 2, explicitQuery: 5 };

// ── 主类 ──

export class TriggeredRetriever {
  private readonly engine: MemoryStoreEngine;
  private readonly reranker?: RerankerLlm;
  private readonly queryRewriter?: RerankerLlm;
  private readonly topK: Required<NonNullable<RetrieverOptions["topK"]>>;
  private readonly maxInjectTokens: number;
  private readonly emit?: (event: RunEvent) => void;
  private readonly countTokens: (text: string) => number;
  private readonly shadow: boolean;

  constructor(opts: RetrieverOptions) {
    this.engine = opts.engine;
    this.reranker = opts.reranker;
    this.queryRewriter = opts.queryRewriter;
    this.topK = { ...DEFAULT_TOPK, ...opts.topK };
    this.maxInjectTokens = opts.maxInjectTokens ?? 500;
    this.emit = opts.emit;
    this.countTokens = opts.countTokens ?? ((t) => new TiktokenEstimator().count(t));
    this.shadow = opts.shadow ?? false;
  }

  async retrieve(trigger: MemoryTrigger): Promise<InjectionPackage> {
    const runId = "runId" in trigger ? trigger.runId : undefined;
    const repo = "repo" in trigger ? trigger.repo : undefined;

    // T2 防误检（§6.2）：不可行动错误零开销跳过
    if (trigger.type === "action_failed" && !isActionableError(trigger.errorOutput)) {
      return this.emptyPackage();
    }

    const query = this.buildQuery(trigger);

    // T1 query 改写（§6.2，#9）：LLM 提炼检索词 + 保留原始描述，两路召回合并
    let degraded = false;
    const queries = [query];
    if (trigger.type === "task_start" && this.queryRewriter) {
      const refined = await this.queryRewriter
        .complete(buildQueryRewritePrompt(trigger.taskDescription))
        .then(parseQueryRewrite)
        .catch(() => null);
      if (refined && refined !== query) {
        queries.unshift(refined);
      } else {
        degraded = true;
        await appendOpLog("read.degraded", { runId, detail: { stage: "query_rewrite" } });
      }
    }

    await appendOpLog("read.trigger", { runId, detail: { triggerType: trigger.type, querySummary: query.slice(0, 200), queries } });
    this.emit?.({ type: "memory.trigger", triggerType: trigger.type, querySummary: query.slice(0, 200) });

    // 空库零开销（§6.7 / §6.8-6）：不做任何检索调用
    const probe = await this.engine.query({ repo, limit: 1 });
    if (probe.length === 0 && trigger.type !== "explicit_query") {
      await appendOpLog("read.trigger", { runId, detail: { triggerType: trigger.type, skipped: "empty_store" } });
      return this.emptyPackage();
    }

    // ── 召回（M2 hybrid；α 按触发点；T1 可能双路）──
    const kinds = TRIGGER_KINDS[trigger.type];
    const alpha = trigger.type === "action_failed" ? RECALL_ALPHA.actionFailed : RECALL_ALPHA.taskStart;
    const candidates: ScoredEntry[] = [];
    for (const kind of kinds ?? [undefined]) {
      for (const q of queries) {
        const r = await hybridRecall(this.engine, q, {
          alpha,
          candidates: 10,
          kind,
          context: { branch: "branch" in trigger ? trigger.branch : undefined },
        });
        candidates.push(...r.items);
        degraded = degraded || r.degraded;
      }
    }
    if (degraded) {
      await appendOpLog("read.degraded", { runId, detail: { triggerType: trigger.type } });
    }
    // 去重（同一条目可能被多个 kind/多路 query 召回，保留高分）
    const byBest = new Map<string, ScoredEntry>();
    for (const c of candidates) {
      const prev = byBest.get(c.entry.id);
      if (!prev || c.score > prev.score) byBest.set(c.entry.id, c);
    }
    const pool = [...byBest.values()].sort((a, b) => b.score - a.score);

    if (pool.length === 0 && trigger.type !== "explicit_query") {
      return this.emptyPackage();
    }

    // ── 精排（§6.4）──
    const k = this.kFor(trigger);
    let selected: { entry: MemoryEntry; score: number; why?: string; label?: "applicable" | "reference" }[];
    if (this.reranker && pool.length > 0) {
      const parsed = parseRerankOutput(await this.reranker.complete(buildRerankPrompt(query, pool)).catch(() => ""), pool.length);
      if (parsed) {
        selected = parsed.slice(0, k).map((item) => ({
          entry: pool[item.seq - 1]!.entry,
          score: pool[item.seq - 1]!.score,
          why: item.why,
          label: item.label,
        }));
      } else {
        // 精排失败 → 召回分数直取 top-k（k 减半，§6.7）
        const halfK = Math.max(1, Math.floor(k / 2));
        selected = pool.slice(0, halfK);
        degraded = true;
        await appendOpLog("read.degraded", { runId, detail: { triggerType: trigger.type, stage: "rerank" } });
      }
    } else {
      selected = pool.slice(0, k);
    }

    // ── T3 与 SessionMemory 去重（§6.1）──
    if (trigger.type === "post_compact" && trigger.existingContextHints?.length) {
      selected = selected.filter((s) => !isCoveredByHints(entryText(s.entry), trigger.existingContextHints!));
    }

    // ── T1 经验类 ≤1 条（§6.1/§6.4 k=1 纪律）──
    if (trigger.type === "task_start") {
      const episodic = selected.filter((s) => s.entry.kind === "episodic").slice(0, this.topK.taskStart);
      const profiles = selected.filter((s) => s.entry.kind === "profile")
        .sort((a, b) => (b.entry.kind === "profile" ? b.entry.supportCount : 0) - (a.entry.kind === "profile" ? a.entry.supportCount : 0));
      selected = [...episodic, ...profiles];
    }

    // ── 组装注入项 ──
    const items: InjectedMemory[] = selected.map((s) => ({
      id: s.entry.id,
      kind: s.entry.kind,
      text: entryText(s.entry),
      whenToUse: entryWhenToUse(s.entry),
      // disagreement gate（§6.5）：reference → 弱措辞身份
      status: s.label === "reference" ? "reference" : "verified",
      why: s.why,
      score: s.score,
      supportCount: s.entry.kind === "profile" ? s.entry.supportCount : undefined,
    }));

    // ── trial 池随行（T1/T2，不占正式条额，§6.1/§4.3）──
    if (trigger.type === "task_start" || trigger.type === "action_failed") {
      const trial = await this.matchTrialLesson(queries.join("\n"));
      if (trial) items.push(trial);
    }

    // ── T4：过期条目可见且带失效标注（§6.6/§6.8-5）──
    if (trigger.type === "explicit_query") {
      const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
      const all = await this.engine.query({ repo, includeInvalidated: true, limit: 200 });
      const stale = all.filter((e) => e.tInvalid != null
        && !items.some((i) => i.id === e.id)
        && terms.some((t) => entryText(e).toLowerCase().includes(t)));
      // 过期条目保底名额：活跃召回在 T4 最多占 topK-2 个（见 kFor），总量 ≤ topK.explicitQuery
      const staleSlots = Math.max(0, this.topK.explicitQuery - items.length);
      for (const e of stale.slice(0, staleSlots)) {
        items.push({
          id: e.id,
          kind: e.kind,
          text: entryText(e),
          whenToUse: entryWhenToUse(e),
          status: "reference",
          score: 0,
          tInvalid: e.tInvalid ?? undefined,
        });
      }
    }

    const pkg = await this.pack(items, degraded, runId);
    // #8：trial 教训被实际随行注入（进入最终注入包）→ attemptsLeft 递减；耗尽由 janitor 丢弃
    const injectedTrial = pkg.items.find((i) => i.kind === "trial");
    if (injectedTrial) {
      try {
        await decrementTrialAttempts(injectedTrial.id);
      } catch { /* 计数失败不影响注入 */ }
    }
    return pkg;
  }

  private buildQuery(trigger: MemoryTrigger): string {
    switch (trigger.type) {
      case "task_start":
        return trigger.taskDescription;
      case "action_failed":
        return buildActionFailedQuery(trigger.errorOutput, trigger.lastActionSummary);
      case "post_compact":
        return `${trigger.summaryHead.split(/[。.\n]/)[0] ?? ""}\n${trigger.goal}`;
      case "explicit_query":
        return trigger.question;
    }
  }

  private kFor(trigger: MemoryTrigger): number {
    switch (trigger.type) {
      case "task_start": return this.topK.taskStart + 15; // T1：episodic 限额 + profile 预算内不限条数（预算截断）
      case "action_failed": return this.topK.actionFailed;
      case "post_compact": return this.topK.postCompact;
      case "explicit_query": return Math.max(1, this.topK.explicitQuery - 2); // 给过期条目预留 2 个名额（§6.6 T4）
    }
  }

  /** trial 池匹配（embedding 索引属 v2；宁缺毋滥：长特征词命中 whenToUse/keywords/lesson） */
  private async matchTrialLesson(query: string): Promise<InjectedMemory | null> {
    try {
      // 长特征词（>6 字符，如 ModuleResolutionError 这类错误类型名）才有区分度
      const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 6);
      if (terms.length === 0) return null;
      const lessons = await listTrialLessons();
      let best: { lesson: (typeof lessons)[number]; hits: number } | null = null;
      for (const lesson of lessons) {
        // 蒸馏产物有检索键（whenToUse/keywords，V032）；原文切片只有 lesson 文本
        const text = [lesson.whenToUse ?? "", ...(lesson.keywords ?? []), lesson.lesson]
          .join(" ").toLowerCase();
        const hits = terms.filter((t) => text.includes(t)).length;
        if (hits >= 1 && (!best || hits > best.hits)) best = { lesson, hits };
      }
      if (!best) return null;
      return {
        id: best.lesson.id,
        kind: "trial",
        text: best.lesson.lesson,
        whenToUse: best.lesson.whenToUse,
        status: "trial",
        score: 0,
      };
    } catch {
      return null;
    }
  }

  /** 预算组装：超限截断（截尾巴不截头）并记 op-log read.truncated（§6.6）。
   *  单条即超预算时按字符截断正文到预算内——总量硬顶 maxInjectTokens 无例外（修复批次 A #5） */
  private async pack(items: InjectedMemory[], degraded: boolean, runId?: string): Promise<InjectionPackage> {
    const kept: InjectedMemory[] = [];
    let truncated = false;
    for (const item of items) {
      const candidate = [...kept, item];
      const tokens = this.countTokens(renderXml(candidate));
      if (tokens > this.maxInjectTokens) {
        if (kept.length === 0) {
          // 单条即超预算：条目内截断到预算内（截尾巴），硬顶无例外
          kept.push(this.truncateToFit(item));
        }
        truncated = true;
        break;
      }
      kept.push(item);
    }
    if (truncated) {
      await appendOpLog("read.truncated", { runId, detail: { kept: kept.length, dropped: items.length - kept.length, singleItem: items.length > 0 && kept[0]!.truncated === true } });
    }

    const pkg: InjectionPackage = {
      items: kept,
      totalTokens: kept.length > 0 ? this.countTokens(renderXml(kept)) : 0,
      degraded,
      render: () => renderXml(kept),
    };

    if (kept.length > 0) {
      if (this.shadow) {
        // shadow 模式（§11.2）：只记录假设注入包——不涨 freq、不发射 memory.inject
        await appendOpLog("read.shadow", {
          runId,
          detail: {
            itemIds: kept.map((i) => i.id),
            totalTokens: pkg.totalTokens,
            degraded,
            rendered: renderXml(kept),
          },
        });
      } else {
        // 账本：注入即 freq+1（trial 不进正式账本）；op-log read.inject 由 recordRetrievalHits 落
        const formalIds = kept.filter((i) => i.kind !== "trial").map((i) => i.id);
        await recordRetrievalHits(this.engine, formalIds, {
          runId,
          detail: { totalTokens: pkg.totalTokens, degraded },
        });
        this.emit?.({ type: "memory.inject", itemIds: kept.map((i) => i.id), totalTokens: pkg.totalTokens, degraded });
      }
    }
    return pkg;
  }

  /** 单条超预算的条目内截断：按比例缩到预算内，标注"已截断"（截尾巴） */
  private truncateToFit(item: InjectedMemory): InjectedMemory {
    let body = item.text;
    for (let i = 0; i < 12; i++) {
      const candidate: InjectedMemory = { ...item, text: `${body}…[已截断]`, truncated: true };
      const tokens = this.countTokens(renderXml([candidate]));
      if (tokens <= this.maxInjectTokens) return candidate;
      const ratio = this.maxInjectTokens / tokens;
      body = body.slice(0, Math.max(16, Math.floor(body.length * ratio * 0.9)));
    }
    // 兜底：极端情况下按最小长度硬截（预算硬顶优先于内容完整）
    return { ...item, text: `${body.slice(0, 16)}…[已截断]`, truncated: true };
  }

  private emptyPackage(): InjectionPackage {
    return { items: [], totalTokens: 0, degraded: false, render: () => "" };
  }
}

// ── XML 渲染（§6.6）──

const STATUS_PREFIX: Record<InjectStatus, string> = {
  verified: "历史经验",
  reference: "历史参考（可能不适用）",
  trial: "试用经验（未验证）",
};

function renderXml(items: readonly InjectedMemory[]): string {
  return items.map((i) => {
    const lines = [
      `<agent-memory source="${i.kind}" id="${i.id}" status="${i.status}">`,
    ];
    if (i.whenToUse) lines.push(i.whenToUse);
    lines.push(`${STATUS_PREFIX[i.status]}：${i.text}`);
    if (i.tInvalid) lines.push(`（已于 ${i.tInvalid} 失效）`);
    lines.push(`</agent-memory>`);
    return lines.join("\n");
  }).join("\n");
}
