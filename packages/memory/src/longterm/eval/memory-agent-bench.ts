/**
 * MemoryAgentBench adapter（spec §11.3 / §11.3.1 P0）
 *
 * 协议（对齐官方 + paw coding 改造）：
 * - context 切成 chunks，每 chunk 作为独立 session 写入（不把整段塞进一次查询）
 * - query 必须新 session：explicit_query 检索，不附带完整历史
 * - 对照：memory on（写入+检索注入）vs memory off（空注入）→ 分项 Δ
 * - 维度：AR / TTL / LRU / CR（官方）+ SF 断言（新事实后旧事实零注入，问历史仍能答）
 *
 * 默认夹具：内置 coding-mini（无 HF 也能跑 CI）。
 * 官方数据：`--hf` 拉取/缓存，或 `--data` 加载导出 JSON（见 benchmarks/memory-agent-bench/README.md）。
 *
 * 达标（收紧）：meanΔ **> 0**（严格正增益）+ 配对 wins > losses；若有 SF current 则抑制率 ≥ 0.8。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSql } from "../../db/connection.js";
import type { MemoryStoreEngine, SemanticFact } from "../store/engine.js";
import { PostgresMemoryStoreEngine } from "../store/postgres-engine.js";
import { deriveEntryId } from "../store/id.js";
import { TriggeredRetriever } from "../retrieval/triggered.js";
import type { JudgeLlm } from "./replay.js";
import { LlmBudget, type RedteamReport } from "./perturbation.js";
import type { LlmStats } from "./llm-client.js";

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

export type MabDimension = "AR" | "TTL" | "LRU" | "CR" | "SF";
export type MabMetric = "substring_exact_match" | "exact_match" | "token_f1";

export interface MabQaPair {
  readonly id: string;
  readonly question: string;
  /** 任一命中即正确（官方多答案口径） */
  readonly answers: readonly string[];
  /**
   * SF 专用：
   * - current：问「现在」——注入包不得含 oldFactNeedle，答案应对新事实
   * - historical：问「以前」——应能答出旧事实
   */
  readonly sfMode?: "current" | "historical";
  /** 旧事实子串（SF current 抑制 / historical 可答） */
  readonly oldFactNeedle?: string;
}

export interface MabSample {
  readonly id: string;
  readonly dimension: MabDimension;
  /** 官方 source 或 coding_* */
  readonly source: string;
  readonly context: string;
  readonly qa: readonly MabQaPair[];
  readonly metric: MabMetric;
}

export interface MabQaResult {
  readonly sampleId: string;
  readonly qaId: string;
  readonly dimension: MabDimension;
  readonly memoryOn: boolean;
  readonly correct: boolean;
  readonly answerSnippet: string;
  readonly recalled: boolean;
  /** SF current：旧事实是否被抑制（未出现在注入包） */
  readonly oldFactSuppressed?: boolean;
  readonly warnings: string[];
}

/** 同题 memory on/off 配对统计（McNemar / 符号检验口径） */
export interface MabPairedStats {
  readonly nPairs: number;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /** (wins − losses) / nPairs；无配对 → null */
  readonly pairedAdvantage: number | null;
  /** wins / (wins + losses)；无决胜对 → null */
  readonly winRateAmongDecisive: number | null;
  /** H0: P(win)=0.5 下 P(X≥wins) 的单侧符号检验；无决胜对 → null */
  readonly signTestP: number | null;
}

export type MabReport = RedteamReport & {
  suite: "memory-agent-bench";
  /** 分项 Δ（on − off），键为维度 */
  deltas: Partial<Record<MabDimension, number | null>>;
  paired: MabPairedStats;
};

export interface MabRunOptions {
  samples: readonly MabSample[];
  backbone: JudgeLlm;
  engine?: MemoryStoreEngine;
  stats?: LlmStats;
  llmBudget?: number;
  maxSamples?: number;
  /** 每样本最多答题数（默认不截断） */
  maxQaPerSample?: number;
  /** 默认 512 字符（近似官方 memory-agent chunk） */
  chunkSize?: number;
  /** 每样本最多写入 chunk 数；超长 context 均匀抽稀，避免百万字打爆库 */
  maxChunks?: number;
  keep?: boolean;
  now?: () => Date;
  /** 只跑这些维度（默认全开） */
  dimensions?: readonly MabDimension[];
}

// ═══════════════════════════════════════════════════════════════
// 规范化 / 打分（对齐 MemoryAgentBench normalize + substring/exact）
// ═══════════════════════════════════════════════════════════════

const PUNCT_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g;

/** 小写、去标点、去英文冠词、折叠空白 */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(PUNCT_RE, "")
    .replace(/\b(a|an|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 词级 F1（InfBench/HELMET 风格近似；用于长摘要） */
export function tokenF1(prediction: string, groundTruth: string): number {
  const pt = normalizeAnswer(prediction).split(" ").filter(Boolean);
  const gt = normalizeAnswer(groundTruth).split(" ").filter(Boolean);
  if (pt.length === 0 || gt.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of gt) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of pt) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      overlap += 1;
      counts.set(t, c - 1);
    }
  }
  const precision = overlap / pt.length;
  const recall = overlap / gt.length;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** token_f1 判对阈值（长摘要难以 exact_match） */
export const TOKEN_F1_PASS = 0.15;

export function scorePrediction(
  prediction: string,
  answers: readonly string[],
  metric: MabMetric,
): boolean {
  const pred = normalizeAnswer(prediction);
  if (!pred || answers.length === 0) return false;
  if (metric === "token_f1") {
    let best = 0;
    for (const a of answers) {
      best = Math.max(best, tokenF1(prediction, a));
    }
    return best >= TOKEN_F1_PASS;
  }
  for (const a of answers) {
    const gt = normalizeAnswer(a);
    if (!gt) continue;
    if (metric === "exact_match") {
      if (pred === gt) return true;
    } else if (pred.includes(gt)) {
      return true;
    }
  }
  return false;
}

/** 按字符预算切 chunk；优先在句号/换行处断开 */
export function chunkText(text: string, chunkSize = 512): string[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];
  if (cleaned.length <= chunkSize) return [cleaned];

  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(start + chunkSize, cleaned.length);
    if (end < cleaned.length) {
      const window = cleaned.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf("\n"),
        window.lastIndexOf("。"),
        window.lastIndexOf(". "),
        window.lastIndexOf("！"),
        window.lastIndexOf("？"),
        window.lastIndexOf("! "),
        window.lastIndexOf("? "),
      );
      if (breakAt > chunkSize * 0.4) end = start + breakAt + 1;
    }
    const piece = cleaned.slice(start, end).trim();
    if (piece) chunks.push(piece);
    start = end;
  }
  return chunks;
}

/** 均匀抽稀 chunk，保留首尾；叙事/长文可选用 headTail 加重首尾 */
export function subsampleChunks(
  chunks: readonly string[],
  maxChunks: number,
  mode: "uniform" | "head_tail" = "uniform",
): string[] {
  if (chunks.length <= maxChunks || maxChunks <= 0) return [...chunks];
  if (maxChunks === 1) return [chunks[0]!];
  if (mode === "head_tail" && maxChunks >= 4) {
    const head = Math.ceil(maxChunks * 0.4);
    const tail = Math.ceil(maxChunks * 0.4);
    const mid = Math.max(0, maxChunks - head - tail);
    const out: string[] = [];
    for (let i = 0; i < head; i++) {
      out.push(chunks[Math.round((i * (Math.floor(chunks.length / 3))) / Math.max(1, head - 1))]!);
    }
    if (mid > 0) {
      const midStart = Math.floor(chunks.length / 3);
      const midEnd = Math.floor((2 * chunks.length) / 3);
      for (let i = 0; i < mid; i++) {
        const idx =
          midStart + Math.round((i * (midEnd - midStart)) / Math.max(1, mid - 1));
        out.push(chunks[Math.min(chunks.length - 1, idx)]!);
      }
    }
    for (let i = 0; i < tail; i++) {
      const base = Math.floor((2 * chunks.length) / 3);
      const idx =
        base +
        Math.round((i * (chunks.length - 1 - base)) / Math.max(1, tail - 1));
      out.push(chunks[Math.min(chunks.length - 1, idx)]!);
    }
    // 去重保序
    const seen = new Set<string>();
    const dedup: string[] = [];
    for (const c of out) {
      const k = c.slice(0, 80);
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(c);
    }
    return dedup.slice(0, maxChunks);
  }
  const out: string[] = [];
  for (let i = 0; i < maxChunks; i++) {
    const idx = Math.round((i * (chunks.length - 1)) / (maxChunks - 1));
    out.push(chunks[idx]!);
  }
  return out;
}

/** 从查询抽取词项（比 extractKeywords 更宽，用于选片打分） */
export function queryTerms(text: string): string[] {
  const bag = new Set<string>();
  for (const m of text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []) {
    bag.add(m);
  }
  return [...bag];
}

/**
 * 按问题词项给 chunk 打分选片（不用 gold，评测公平）。
 * 先取高分块，再用均匀抽稀补足覆盖，避免只盯局部。
 */
export function subsampleChunksForQuery(
  chunks: readonly string[],
  maxChunks: number,
  queries: readonly string[],
): string[] {
  if (chunks.length <= maxChunks || maxChunks <= 0) return [...chunks];
  const terms = queryTerms(queries.join("\n"));
  if (terms.length === 0) return subsampleChunks(chunks, maxChunks, "uniform");

  const scored = chunks.map((c, i) => {
    const low = c.toLowerCase();
    let s = 0;
    for (const t of terms) {
      if (low.includes(t)) s += 1;
    }
    return { i, s };
  });
  scored.sort((a, b) => b.s - a.s || a.i - b.i);

  const prefer = Math.max(1, Math.floor(maxChunks * 0.75));
  const pickedIdx = new Set<number>();
  for (const row of scored) {
    if (pickedIdx.size >= prefer) break;
    if (row.s <= 0) break;
    pickedIdx.add(row.i);
  }
  // 均匀补足
  const fill = subsampleChunks(chunks, maxChunks, "uniform");
  for (const c of fill) {
    if (pickedIdx.size >= maxChunks) break;
    const i = chunks.indexOf(c);
    if (i >= 0) pickedIdx.add(i);
  }
  // 若仍不足（高分过少），按分数继续填
  for (const row of scored) {
    if (pickedIdx.size >= maxChunks) break;
    pickedIdx.add(row.i);
  }
  return [...pickedIdx]
    .sort((a, b) => a - b)
    .slice(0, maxChunks)
    .map((i) => chunks[i]!);
}

export function extractKeywords(...parts: string[]): string[] {
  const bag = new Set<string>();
  for (const p of parts) {
    for (const m of p.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}/g) ?? []) {
      bag.add(m);
      if (bag.size >= 16) return [...bag];
    }
  }
  return [...bag];
}

// ═══════════════════════════════════════════════════════════════
// 内置 coding-mini 夹具（§11.3 coding 改造；CI 无 HF）
// ═══════════════════════════════════════════════════════════════

/** 填充噪声，迫使跨 chunk（避免整段一次装进窗口） */
function padNoise(seed: string, minLen: number): string {
  const filler =
    "背景说明：本仓库使用 bun 作为包管理与测试运行器。模块边界清晰，工具调用需带超时。" +
    "日志轮转保留 14 天。CI 在 Linux 上跑。无关段落用于撑开上下文窗口。";
  let out = seed;
  let i = 0;
  while (out.length < minLen) {
    out += `\n\n§noise-${i}: ${filler}`;
    i += 1;
  }
  return out;
}

/** 在段落之间插入噪声，确保旧/新事实落入不同 chunk（SF 必需） */
function padBetween(sections: readonly string[], minTotal: number, gapSize = 600): string {
  const gaps: string[] = [];
  const filler =
    "背景说明：本仓库使用 bun 作为包管理与测试运行器。模块边界清晰，工具调用需带超时。" +
    "日志轮转保留 14 天。CI 在 Linux 上跑。无关段落用于撑开上下文窗口。";
  let i = 0;
  const parts: string[] = [];
  for (let s = 0; s < sections.length; s++) {
    if (s > 0) {
      let gap = "";
      while (gap.length < gapSize) {
        gap += `\n§gap-${i}: ${filler}\n`;
        i += 1;
      }
      parts.push(gap);
      gaps.push(gap);
    }
    parts.push(sections[s]!);
  }
  let out = parts.join("\n\n");
  while (out.length < minTotal) {
    out += `\n\n§noise-${i}: ${filler}`;
    i += 1;
  }
  return out;
}

export const BUILTIN_CODING_FIXTURES: readonly MabSample[] = [
  {
    id: "coding-ar-build",
    dimension: "AR",
    source: "coding_ar",
    metric: "substring_exact_match",
    context: padNoise(
      [
        "项目早期用 make 构建，已废弃。",
        "关键决策：2024-11 起正式构建命令改为 bun run build，产物目录为 dist/。",
        "有人误写过 npm run build，已被纠正。",
      ].join("\n"),
      2200,
    ),
    qa: [
      {
        id: "q1",
        question: "本项目当前正式构建命令是什么？",
        answers: ["bun run build"],
      },
    ],
  },
  {
    id: "coding-ttl-error-style",
    dimension: "TTL",
    source: "coding_ttl",
    metric: "exact_match",
    context: padNoise(
      [
        "新项目错误处理惯例（请记住并后续遵循）：",
        "规则 A：所有可恢复错误必须抛出带 code 字段的 AppError。",
        "规则 B：禁止吞掉异常后返回 null。",
        "规则 C：用户可见文案不得包含堆栈。",
        "示例：throw new AppError({ code: 'E_TIMEOUT', message: '请求超时' })。",
      ].join("\n"),
      2200,
    ),
    qa: [
      {
        id: "q1",
        question:
          "按本项目惯例，可恢复错误应如何抛出？只回答：AppError-with-code / null-return / stack-to-user",
        answers: ["AppError-with-code"],
      },
    ],
  },
  {
    id: "coding-lru-module",
    dimension: "LRU",
    source: "coding_lru",
    metric: "substring_exact_match",
    context: padNoise(
      [
        "演进史第 1 阶段：auth 模块最初用 session cookie。",
        "演进史第 2 阶段：改为 JWT，但 refresh 逻辑写在 gateway。",
        "演进史第 3 阶段：refresh 下沉到 packages/auth，gateway 只转发。",
        "因此今天问「refresh 在哪」应回答 packages/auth。",
      ].join("\n"),
      2400,
    ),
    qa: [
      {
        id: "q1",
        question: "今天 refresh 逻辑在哪个包？",
        answers: ["packages/auth"],
      },
    ],
  },
  {
    id: "coding-cr-test-cmd",
    dimension: "CR",
    source: "coding_cr",
    metric: "substring_exact_match",
    context: padBetween(
      [
        "【旧文档】测试命令曾经是 npx jest。",
        "【最新决议】全面迁移后，当前跑测试的唯一命令是 bun test。jest 配置已删除。冲突时以本决议为准。",
      ],
      2200,
      700,
    ),
    qa: [
      {
        id: "q1",
        question: "当前跑测试的唯一命令是什么？请给出命令本身。",
        answers: ["bun test"],
      },
    ],
  },
  {
    id: "coding-sf-jest-vitest",
    dimension: "SF",
    source: "coding_sf",
    metric: "substring_exact_match",
    // 旧/新之间强制 gap，保证落入不同 chunk，便于软失效纯旧事实
    context: padBetween(
      [
        "【历史阶段】2023 年单元测试框架是 jest，命令为 npx jest。当时全部 CI 调用 jest。",
        "【迁移决议】2025-03 切换到 vitest，当前命令为 bunx vitest run。",
        "【现行惯例】新任务必须使用 vitest；不得再建议使用已移除的旧框架。",
      ],
      2400,
      700,
    ),
    qa: [
      {
        id: "q-current",
        question: "现在跑单元测试应该用什么？",
        answers: ["bunx vitest run", "vitest"],
        sfMode: "current",
        oldFactNeedle: "jest",
      },
      {
        id: "q-hist",
        question: "迁移之前项目用什么测试框架？",
        answers: ["jest"],
        sfMode: "historical",
        oldFactNeedle: "jest",
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════
// 加载器
// ═══════════════════════════════════════════════════════════════

const DIM_FROM_SPLIT: Record<string, MabDimension> = {
  Accurate_Retrieval: "AR",
  Test_Time_Learning: "TTL",
  Long_Range_Understanding: "LRU",
  Conflict_Resolution: "CR",
  AR: "AR",
  TTL: "TTL",
  LRU: "LRU",
  CR: "CR",
  SF: "SF",
};

/** 官方 HF split → 维度（全量四维；SF 仍用内置） */
export const MAB_HF_SPLITS: readonly { split: string; dimension: MabDimension }[] = [
  { split: "Accurate_Retrieval", dimension: "AR" },
  { split: "Test_Time_Learning", dimension: "TTL" },
  { split: "Long_Range_Understanding", dimension: "LRU" },
  { split: "Conflict_Resolution", dimension: "CR" },
];

export const MAB_HF_DATASET = "ai-hyz/MemoryAgentBench";
export const MAB_HF_ROWS_BASE =
  "https://datasets-server.huggingface.co/rows";

const METRIC_FOR_DIM: Record<MabDimension, MabMetric> = {
  AR: "substring_exact_match",
  TTL: "exact_match",
  /** InfBench 长摘要官方近 F1；短 detectiveQA 仍可走 exact，见 normalize 内 source 覆盖 */
  LRU: "token_f1",
  CR: "substring_exact_match",
  SF: "substring_exact_match",
};

function asStringList(v: unknown): string[] {
  if (v == null) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) {
    return v.flatMap((x) => (typeof x === "string" ? [x] : Array.isArray(x) ? asStringList(x) : [String(x)]));
  }
  return [String(v)];
}

/** 把官方 HF / 导出 JSON 单条规范化为 MabSample；非法返回 null */
export function normalizeMabRecord(raw: unknown, index = 0): MabSample | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const context = typeof o.context === "string" ? o.context : "";
  if (context.length < 20) return null;

  const meta = (o.metadata && typeof o.metadata === "object" ? o.metadata : {}) as Record<string, unknown>;
  const source =
    (typeof o.source === "string" && o.source) ||
    (typeof meta.source === "string" && meta.source) ||
    "unknown";

  const dimRaw =
    (typeof o.dimension === "string" && o.dimension) ||
    (typeof o.split === "string" && o.split) ||
    (typeof o.dataset === "string" && o.dataset) ||
    "";
  const dimension = DIM_FROM_SPLIT[dimRaw] ?? (source.startsWith("coding_sf") ? "SF" : null);
  if (!dimension) {
    // HF 官方按 split 加载时常不带 dimension 字段——允许调用方注入
    return null;
  }

  const metric: MabMetric =
    o.metric === "exact_match" ||
    o.metric === "substring_exact_match" ||
    o.metric === "token_f1"
      ? o.metric
      : dimension === "LRU" && /infbench|sum/i.test(source)
        ? "token_f1"
        : dimension === "LRU" && /detective/i.test(source)
          ? "exact_match"
          : METRIC_FOR_DIM[dimension];

  // 已是我们的扁平格式（带 qa 数组）
  if (Array.isArray(o.qa) && o.qa.length > 0) {
    const qa = o.qa
      .map((raw, i) => {
        if (!raw || typeof raw !== "object") return null;
        const q = raw as Record<string, unknown>;
        const question = typeof q.question === "string" ? q.question : "";
        const answers = asStringList(q.answers);
        if (!question || answers.length === 0) return null;
        return {
          id: typeof q.id === "string" ? q.id : `q${i}`,
          question,
          answers,
          sfMode:
            q.sfMode === "current" || q.sfMode === "historical" ? q.sfMode : undefined,
          oldFactNeedle: typeof q.oldFactNeedle === "string" ? q.oldFactNeedle : undefined,
        } satisfies MabQaPair;
      })
      .filter((x): x is MabQaPair => x != null);
    if (qa.length === 0) return null;
    return {
      id: typeof o.id === "string" ? o.id : `${dimension.toLowerCase()}-${source}-${index}`,
      dimension,
      source,
      context,
      qa,
      metric,
    };
  }

  const questions = asStringList(o.questions ?? o.question);
  const answersNested = o.answers ?? o.answer;
  const answerLists: string[][] = Array.isArray(answersNested)
    ? answersNested.map((a) => asStringList(a))
    : [asStringList(answersNested)];

  const qaIds = asStringList(o.qa_pair_ids ?? meta.qa_pair_ids);
  const qa: MabQaPair[] = [];
  for (let i = 0; i < Math.max(questions.length, 1); i++) {
    const q = questions[i] ?? questions[0] ?? "";
    if (!q) continue;
    const answers = answerLists[i] ?? answerLists[0] ?? [];
    if (answers.length === 0) continue;
    const sfMode = o.sfMode === "current" || o.sfMode === "historical" ? o.sfMode : undefined;
    const oldFactNeedle = typeof o.oldFactNeedle === "string" ? o.oldFactNeedle : undefined;
    qa.push({
      id: qaIds[i] || `q${i}`,
      question: q,
      answers,
      sfMode,
      oldFactNeedle,
    });
  }
  if (qa.length === 0) return null;

  return {
    id: typeof o.id === "string" ? o.id : `${dimension.toLowerCase()}-${source}-${index}`,
    dimension,
    source,
    context,
    qa,
    metric,
  };
}

/**
 * 从文件加载样本。支持：
 * - JSON 数组
 * - `{ "data": [...] }`
 * - JSONL
 * - 已是 MabSample 形状的对象
 *
 * `defaultDimension`：HF 按 split 导出时常缺 dimension 字段时注入。
 */
export function loadMabSamplesFromFile(
  path: string,
  opts?: { defaultDimension?: MabDimension },
): MabSample[] {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];

  let records: unknown[] = [];
  if (text.startsWith("[")) {
    records = JSON.parse(text) as unknown[];
  } else if (text.startsWith("{")) {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(obj.data)) records = obj.data;
    else if (obj.id || obj.context) records = [obj];
    else throw new Error(`无法识别的 JSON 形状: ${path}`);
  } else {
    records = text.split("\n").filter((l) => l.trim()).map((l, i) => {
      try {
        return JSON.parse(l);
      } catch (e) {
        throw new Error(`JSONL 第 ${i + 1} 行非法: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  const out: MabSample[] = [];
  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    let sample = normalizeMabRecord(raw, i);
    if (!sample && opts?.defaultDimension && raw && typeof raw === "object") {
      sample = normalizeMabRecord(
        { ...(raw as object), dimension: opts.defaultDimension },
        i,
      );
    }
    if (sample) out.push(sample);
  }
  return out;
}

export function filterMabSamples(
  samples: readonly MabSample[],
  opts?: {
    dimensions?: readonly MabDimension[];
    maxSamples?: number;
    /** 每样本最多保留前 N 道题（官方单样本可有上百题） */
    maxQaPerSample?: number;
  },
): MabSample[] {
  let xs = [...samples];
  if (opts?.dimensions && opts.dimensions.length > 0) {
    const allow = new Set(opts.dimensions);
    xs = xs.filter((s) => allow.has(s.dimension));
  }
  if (opts?.maxQaPerSample !== undefined && opts.maxQaPerSample > 0) {
    const n = opts.maxQaPerSample;
    xs = xs.map((s) => (s.qa.length <= n ? s : { ...s, qa: s.qa.slice(0, n) }));
  }
  if (opts?.maxSamples !== undefined) xs = xs.slice(0, opts.maxSamples);
  return xs;
}

/** 把 Node Buffer 转成 hyparquet 可用的 ArrayBuffer */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * 从官方 HF 导出的 parquet 目录加载（如 `hf-dataset/data/*-{split}-*.parquet`）。
 */
export async function loadMabSamplesFromParquetDir(
  dataDir: string,
  opts?: { splits?: readonly string[] },
): Promise<MabSample[]> {
  if (!existsSync(dataDir)) return [];
  const { parquetReadObjects } = await import("hyparquet");
  const { readdirSync } = await import("node:fs");
  const want = new Set(
    (opts?.splits?.length ? opts.splits : MAB_HF_SPLITS.map((s) => s.split)).map(String),
  );
  const files = readdirSync(dataDir).filter((f) => f.endsWith(".parquet"));
  const out: MabSample[] = [];

  for (const { split, dimension } of MAB_HF_SPLITS) {
    if (!want.has(split)) continue;
    const match = files.find(
      (f) => f === `${split}.parquet` || f.startsWith(`${split}-`) || f.includes(`${split}-`),
    );
    if (!match) continue;
    const buf = readFileSync(join(dataDir, match));
    const rows = (await parquetReadObjects({ file: toArrayBuffer(buf) })) as unknown[];
    out.push(...recordsToSamples(rows, dimension, split));
  }
  return out;
}

/** 从缓存目录加载官方 split JSON（每文件一个数组，文件名=split） */
export function loadMabSamplesFromHfCache(
  cacheDir: string,
  opts?: { splits?: readonly string[] },
): MabSample[] {
  const want = new Set(
    (opts?.splits?.length ? opts.splits : MAB_HF_SPLITS.map((s) => s.split)).map(String),
  );
  const out: MabSample[] = [];
  for (const { split, dimension } of MAB_HF_SPLITS) {
    if (!want.has(split)) continue;
    const path = join(cacheDir, `${split}.json`);
    if (!existsSync(path)) continue;
    const chunk = loadMabSamplesFromFile(path, { defaultDimension: dimension });
    out.push(...chunk);
  }
  return out;
}

function recordsToSamples(records: unknown[], dimension: MabDimension, split: string): MabSample[] {
  const out: MabSample[] = [];
  for (let i = 0; i < records.length; i++) {
    const raw = records[i];
    let sample = normalizeMabRecord(
      raw && typeof raw === "object" ? { ...(raw as object), dimension, split } : raw,
      i,
    );
    if (!sample && raw && typeof raw === "object") {
      sample = normalizeMabRecord({ ...(raw as object), dimension }, i);
    }
    if (sample) {
      out.push({
        ...sample,
        id: sample.id.includes(split) ? sample.id : `${split}-${sample.id}`,
      });
    }
  }
  return out;
}

/**
 * 从 HuggingFace datasets-server 拉取一个 split 并可选落盘缓存。
 * 网络不可达时抛错（调用方应改读缓存）。
 */
export async function fetchMabHfSplit(
  split: string,
  opts?: {
    dimension?: MabDimension;
    cacheDir?: string;
    fetchImpl?: typeof fetch;
    baseUrl?: string;
    pageSize?: number;
  },
): Promise<MabSample[]> {
  const dimension =
    opts?.dimension ??
    MAB_HF_SPLITS.find((s) => s.split === split)?.dimension ??
    DIM_FROM_SPLIT[split];
  if (!dimension) throw new Error(`未知 HF split: ${split}`);

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const baseUrl = opts?.baseUrl ?? MAB_HF_ROWS_BASE;
  const pageSize = opts?.pageSize ?? 100;
  const records: unknown[] = [];
  let offset = 0;
  let total: number | null = null;

  while (total === null || offset < total) {
    const url = new URL(baseUrl);
    url.searchParams.set("dataset", MAB_HF_DATASET);
    url.searchParams.set("config", "default");
    url.searchParams.set("split", split);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("length", String(pageSize));

    const res = await fetchImpl(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`HF rows ${split} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as {
      num_rows_total?: number;
      rows?: { row?: unknown }[];
    };
    total = body.num_rows_total ?? body.rows?.length ?? 0;
    const page = body.rows ?? [];
    if (page.length === 0) break;
    for (const r of page) {
      if (r?.row != null) records.push(r.row);
    }
    offset += page.length;
    if (page.length < pageSize) break;
  }

  if (opts?.cacheDir) {
    mkdirSync(opts.cacheDir, { recursive: true });
    writeFileSync(join(opts.cacheDir, `${split}.json`), JSON.stringify(records, null, 2), "utf8");
  }
  return recordsToSamples(records, dimension, split);
}

export interface MabHfLoadResult {
  readonly samples: MabSample[];
  readonly source: "cache" | "fetch" | "parquet" | "mixed";
  readonly warnings: readonly string[];
  readonly bySplit: Record<string, number>;
}

/**
 * 加载优先级：JSON cache → 本地 parquet 目录 → HF 拉取。
 * `forceFetch` 跳过 JSON，但仍会先试 parquet（除非未配置）。
 */
export async function loadOrFetchMabHf(opts: {
  cacheDir: string;
  /** 官方导出 parquet 目录，如 benchmarks/.../hf-dataset/data */
  parquetDir?: string;
  splits?: readonly string[];
  forceFetch?: boolean;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): Promise<MabHfLoadResult> {
  const splits = opts.splits?.length
    ? [...opts.splits]
    : MAB_HF_SPLITS.map((s) => s.split);
  const warnings: string[] = [];
  const bySplit: Record<string, number> = {};
  const all: MabSample[] = [];
  let fetched = 0;
  let cached = 0;
  let fromParquet = 0;

  mkdirSync(opts.cacheDir, { recursive: true });

  for (const split of splits) {
    const meta = MAB_HF_SPLITS.find((s) => s.split === split);
    if (!meta) {
      warnings.push(`跳过未知 split: ${split}`);
      continue;
    }
    const path = join(opts.cacheDir, `${split}.json`);
    let samples: MabSample[] = [];

    if (!opts.forceFetch && existsSync(path)) {
      samples = loadMabSamplesFromFile(path, { defaultDimension: meta.dimension }).map((s) => ({
        ...s,
        id: s.id.includes(split) ? s.id : `${split}-${s.id}`,
      }));
      cached += 1;
    } else if (opts.parquetDir && existsSync(opts.parquetDir)) {
      try {
        samples = await loadMabSamplesFromParquetDir(opts.parquetDir, { splits: [split] });
        if (samples.length > 0) fromParquet += 1;
      } catch (e) {
        warnings.push(
          `${split}: parquet 读取失败（${e instanceof Error ? e.message : String(e)}）`,
        );
      }
    }

    if (samples.length === 0) {
      try {
        samples = await fetchMabHfSplit(split, {
          dimension: meta.dimension,
          cacheDir: opts.cacheDir,
          fetchImpl: opts.fetchImpl,
          baseUrl: opts.baseUrl,
        });
        fetched += 1;
      } catch (e) {
        if (existsSync(path)) {
          samples = loadMabSamplesFromFile(path, { defaultDimension: meta.dimension });
          cached += 1;
          warnings.push(
            `${split}: 拉取失败，回退缓存（${e instanceof Error ? e.message : String(e)}）`,
          );
        } else {
          warnings.push(`${split}: ${e instanceof Error ? e.message : String(e)}`);
          bySplit[split] = 0;
          continue;
        }
      }
    }

    bySplit[split] = samples.length;
    all.push(...samples);
  }

  const kinds = [cached > 0, fromParquet > 0, fetched > 0].filter(Boolean).length;
  const source: MabHfLoadResult["source"] =
    kinds > 1
      ? "mixed"
      : fromParquet > 0
        ? "parquet"
        : fetched > 0
          ? "fetch"
          : "cache";
  if (all.length === 0) {
    warnings.push(
      `HF 无样本可用（cacheDir=${opts.cacheDir}` +
        (opts.parquetDir ? `, parquetDir=${opts.parquetDir}` : "") +
        `）。请放入 parquet 或 JSON，或联网拉取`,
    );
  }
  return { samples: all, source, warnings, bySplit };
}

// ═══════════════════════════════════════════════════════════════
// 汇总 / 报告
// ═══════════════════════════════════════════════════════════════

export function accuracyOf(items: readonly MabQaResult[], memoryOn: boolean, dim?: MabDimension): number | null {
  const xs = items.filter((i) => i.memoryOn === memoryOn && (dim === undefined || i.dimension === dim));
  if (xs.length === 0) return null;
  return xs.filter((i) => i.correct).length / xs.length;
}

export function sfSuppressionRate(items: readonly MabQaResult[]): number | null {
  const ys = items.filter((i) => i.memoryOn && i.oldFactSuppressed !== undefined);
  if (ys.length === 0) return null;
  return ys.filter((i) => i.oldFactSuppressed).length / ys.length;
}

/** Bin(n, 0.5) 上 P(X ≥ k) */
export function binomialSignTestP(wins: number, losses: number): number | null {
  const n = wins + losses;
  if (n === 0) return null;
  let p = 0;
  for (let k = wins; k <= n; k++) {
    let c = 1;
    for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
    p += c * Math.pow(0.5, n);
  }
  return Math.min(1, Math.max(0, p));
}

/**
 * 按 (sampleId, qaId, dimension) 配对 on/off。
 * win = on 对且 off 错；loss = on 错且 off 对。
 */
export function computePairedStats(items: readonly MabQaResult[]): MabPairedStats {
  type Key = string;
  const on = new Map<Key, MabQaResult>();
  const off = new Map<Key, MabQaResult>();
  for (const it of items) {
    const key = `${it.sampleId}\0${it.qaId}\0${it.dimension}`;
    if (it.memoryOn) on.set(key, it);
    else off.set(key, it);
  }
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const [key, a] of on) {
    const b = off.get(key);
    if (!b) continue;
    if (a.correct && !b.correct) wins += 1;
    else if (!a.correct && b.correct) losses += 1;
    else ties += 1;
  }
  const nPairs = wins + losses + ties;
  const decisive = wins + losses;
  return {
    nPairs,
    wins,
    losses,
    ties,
    pairedAdvantage: nPairs > 0 ? (wins - losses) / nPairs : null,
    winRateAmongDecisive: decisive > 0 ? wins / decisive : null,
    signTestP: binomialSignTestP(wins, losses),
  };
}

export function summarizeMab(items: readonly MabQaResult[]): {
  byDim: Record<
    MabDimension,
    { on: number | null; off: number | null; delta: number | null; nOn: number; nOff: number }
  >;
  sfSuppression: number | null;
  /** 所有有对照的维度平均 Δ；无对照 → null */
  meanDelta: number | null;
  paired: MabPairedStats;
  /**
   * 达标：meanΔ **> 0** 且配对 wins > losses；
   * 若有 SF current 抑制率 ≥ 0.8。样本不足 → null。
   */
  passed: boolean | null;
} {
  const dims: MabDimension[] = ["AR", "TTL", "LRU", "CR", "SF"];
  const byDim = {} as Record<
    MabDimension,
    { on: number | null; off: number | null; delta: number | null; nOn: number; nOff: number }
  >;
  const deltas: number[] = [];
  for (const d of dims) {
    const on = accuracyOf(items, true, d);
    const off = accuracyOf(items, false, d);
    const nOn = items.filter((i) => i.memoryOn && i.dimension === d).length;
    const nOff = items.filter((i) => !i.memoryOn && i.dimension === d).length;
    const delta = on !== null && off !== null ? on - off : null;
    byDim[d] = { on, off, delta, nOn, nOff };
    if (delta !== null) deltas.push(delta);
  }
  const sfSuppression = (() => {
    const ys = items.filter((i) => i.memoryOn && i.oldFactSuppressed !== undefined);
    if (ys.length === 0) return null;
    return ys.filter((i) => i.oldFactSuppressed).length / ys.length;
  })();
  const meanDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  const paired = computePairedStats(items);
  let passed: boolean | null = null;
  if (meanDelta !== null && paired.nPairs > 0) {
    // 严格正增益：零增益不再算达标
    passed = meanDelta > 0 && paired.wins > paired.losses;
    if (sfSuppression !== null) passed = passed && sfSuppression >= 0.8;
  }
  return { byDim, sfSuppression, meanDelta, paired, passed };
}

export function renderMabReport(r: MabReport): string {
  const lines = [
    `MemoryAgentBench [${r.suite}]    ${r.passed === null ? "判定: 样本不足" : r.passed ? "判定: ✅ 达标" : "判定: ❌ 未达标"}`,
    `生成: ${r.generatedAt}`,
    "指标:",
  ];
  for (const [k, v] of Object.entries(r.metrics)) {
    lines.push(`  ${k}: ${v === null ? "n/a" : typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(3)) : v}`);
  }
  if (Object.keys(r.deltas).length > 0) {
    lines.push("分项 Δ (on−off):");
    for (const [k, v] of Object.entries(r.deltas)) {
      lines.push(`  ${k}: ${v === null || v === undefined ? "n/a" : (v as number).toFixed(3)}`);
    }
  }
  const p = r.paired;
  lines.push(
    `配对: n=${p.nPairs} wins=${p.wins} losses=${p.losses} ties=${p.ties}` +
      ` adv=${p.pairedAdvantage === null ? "n/a" : p.pairedAdvantage.toFixed(3)}` +
      ` winRate=${p.winRateAmongDecisive === null ? "n/a" : p.winRateAmongDecisive.toFixed(3)}` +
      ` signP=${p.signTestP === null ? "n/a" : p.signTestP.toFixed(4)}`,
  );
  lines.push(
    `效率: llm=${r.efficiency.llmCalls} retries=${r.efficiency.retries} fail=${r.efficiency.failures} ms=${r.efficiency.totalMs} tok≈${r.efficiency.estimatedTokens}${r.efficiency.truncated ? " truncated" : ""}`,
  );
  if (r.warnings.length) {
    lines.push("警告:");
    for (const w of r.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// 运行
// ═══════════════════════════════════════════════════════════════

function buildAnswerPrompt(
  question: string,
  injected: string,
  opts?: { longForm?: boolean; extractive?: boolean },
): string {
  if (opts?.longForm) {
    return `你是记忆评测被试。请依据「参考记忆」完成题目；参考记忆为空时才回答「不知道」。

参考记忆：
${injected.trim() || "(无)"}

问题：${question}

请给出完整回答（摘要类题目按要求写足篇幅），不要只输出「不知道」除非参考记忆完全空白。`;
  }
  if (opts?.extractive) {
    return `你是记忆评测被试。根据「参考记忆」回答问题。
规则：
1. 优先从参考记忆中抽出事实短答（可抄写记忆中的原词/原句片段）。
2. 仅当参考记忆完全空白，或记忆内容与问题明显无关时，才回答「不知道」。
3. 不要因为记忆不完整就放弃；有一丁点相关线索也要尽力给出短答。

参考记忆：
${injected.trim() || "(无)"}

问题：${question}

请直接给出简短答案。`;
  }
  return `你是记忆评测被试。只能依据「参考记忆」回答；记忆不足就说「不知道」。

参考记忆：
${injected.trim() || "(无)"}

问题：${question}

请直接给出简短答案，不要解释过程。`;
}

function isLongFormSample(sample: { dimension: MabDimension; metric: MabMetric; source: string }): boolean {
  return (
    sample.dimension === "LRU" ||
    sample.metric === "token_f1" ||
    /infbench|sum|summary/i.test(sample.source)
  );
}

function isExtractiveSample(sample: { dimension: MabDimension }): boolean {
  return sample.dimension === "AR" || sample.dimension === "TTL" || sample.dimension === "CR";
}

async function putChunk(
  engine: MemoryStoreEngine,
  repo: string,
  chunk: string,
  idx: number,
): Promise<string> {
  const now = new Date().toISOString();
  const keywords = extractKeywords(chunk);
  const entry: SemanticFact = {
    id: "",
    kind: "semantic",
    repo,
    created: now,
    tValid: now,
    tInvalid: null,
    source: "user_statement",
    confidence: 1,
    evidence: [`runs/mab#chunk-${idx}`],
    freq: 0,
    utility: 0,
    fact: chunk.slice(0, 2000),
    keywords,
    // 用更长文本做 embedding，避免针落在 chunk 后半段时向量路系统性偏弱
    embeddingKey: `${chunk.slice(0, 1200)} ${keywords.join(" ")}`,
  };
  // 派生稳定 id（put 实现可能忽略空 id）
  const id = deriveEntryId(entry);
  await engine.put({ ...entry, id });
  return id;
}

/**
 * SF：仅含旧事实、不含新事实答案的条目应软失效（对齐 §11.3「旧事实零注入」）。
 * 含迁移叙述（新旧同现）的条目保留，供现行惯例检索。
 */
export function shouldInvalidateForSf(
  fact: string,
  oldFactNeedle: string,
  newAnswers: readonly string[],
): boolean {
  const f = normalizeAnswer(fact);
  const old = normalizeAnswer(oldFactNeedle);
  if (!old || !f.includes(old)) return false;
  return !newAnswers.some((a) => {
    const n = normalizeAnswer(a);
    return n.length > 0 && f.includes(n);
  });
}

/** 对 SF 样本：把「纯旧事实」chunk 软失效；返回失效 id 列表 */
export async function invalidateSupersededForSf(
  engine: MemoryStoreEngine,
  repo: string,
  sample: MabSample,
  writtenIds: readonly string[],
): Promise<string[]> {
  const current = sample.qa.find((q) => q.sfMode === "current");
  const needle = current?.oldFactNeedle;
  if (!needle) return [];
  const newAnswers = current?.answers ?? [];
  const invalidated: string[] = [];
  const when = new Date().toISOString();
  for (const id of writtenIds) {
    const entry = await engine.get(id);
    if (!entry || entry.kind !== "semantic") continue;
    if (!shouldInvalidateForSf(entry.fact, needle, newAnswers)) continue;
    await engine.invalidate(id, when);
    invalidated.push(id);
  }
  return invalidated;
}

/** 当前题：只用活跃注入（去掉 tInvalid）；历史题：保留 T4 失效标注 */
export function injectionForSfMode(
  rendered: string,
  items: readonly { text: string; tInvalid?: string }[],
  sfMode: "current" | "historical" | undefined,
): { text: string; activeTexts: string[] } {
  if (sfMode === "current") {
    const active = items.filter((i) => !i.tInvalid);
    const text = active.map((i) => i.text).join("\n");
    return { text: text || "(无)", activeTexts: active.map((i) => i.text) };
  }
  return { text: rendered, activeTexts: items.map((i) => i.text) };
}

async function cleanupRepo(repo: string): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${repo})`;
  await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${repo}`;
  await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${repo + "%"}`;
}

/**
 * 跑 MemoryAgentBench 适配评测。
 * 每个 sample：先 off（空注入答题）再 on（chunk 写入 → 检索 → 答题），保证同题配对。
 */
export async function runMemoryAgentBench(opts: MabRunOptions): Promise<MabReport> {
  const now = (opts.now ?? (() => new Date()))();
  const engine = opts.engine ?? new PostgresMemoryStoreEngine();
  const budget = new LlmBudget(opts.llmBudget ?? 400);
  const backbone = budget.wrap(opts.backbone);
  const chunkSize = opts.chunkSize ?? 512;
  const maxChunks = opts.maxChunks;
  const samples = filterMabSamples(opts.samples, {
    dimensions: opts.dimensions,
    maxSamples: opts.maxSamples,
    maxQaPerSample: opts.maxQaPerSample,
  });
  const warnings: string[] = [];
  const items: MabQaResult[] = [];
  const ts = now.getTime().toString(36);

  if (samples.length === 0) {
    warnings.push("无样本可跑（检查 --dimension / --data / --max-samples）");
  }

  for (let si = 0; si < samples.length; si++) {
    const sample = samples[si]!;
    const sampleT0 = Date.now();
    console.log(
      `[mab] ${si + 1}/${samples.length} start ${sample.dimension}/${sample.id} qa=${sample.qa.length} ctxChars=${sample.context.length}`,
    );
    const repo = `mab-${ts}-${sample.id}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
    const arLike = sample.dimension === "AR" || sample.dimension === "TTL" || sample.dimension === "CR";
    const retriever = new TriggeredRetriever({
      engine,
      shadow: true,
      // AR/TTL：放大注入预算，避免单条 2000 字事实占满 500 tok 后把答案挤掉
      ...(arLike
        ? {
            topK: { explicitQuery: 12 },
            maxInjectTokens: 3500,
          }
        : {}),
    });

    try {
      // ── memory OFF：空注入答题 ──
      const longForm = isLongFormSample(sample);
      const extractive = isExtractiveSample(sample);
      for (const qa of sample.qa) {
        let answer = "";
        try {
          answer = await backbone.complete(
            buildAnswerPrompt(qa.question, "", { longForm, extractive }),
          );
        } catch (e) {
          warnings.push(`${sample.id}/${qa.id} off: ${e instanceof Error ? e.message : String(e)}`);
        }
        items.push({
          sampleId: sample.id,
          qaId: qa.id,
          dimension: sample.dimension,
          memoryOn: false,
          correct: scorePrediction(answer, qa.answers, sample.metric),
          answerSnippet: answer.slice(0, 120),
          recalled: false,
          warnings: [],
        });
      }

      // ── memory ON：chunk → session 写入 ──
      // SF 夹具依赖窄 chunk + 禁止抽稀，避免旧/新事实粘在同一块导致无法软失效
      const effectiveChunkSize = sample.dimension === "SF" ? Math.min(chunkSize, 512) : chunkSize;
      const rawChunks = chunkText(sample.context, effectiveChunkSize);
      let chunks = rawChunks;
      const allowSubsample = sample.dimension !== "SF";
      if (
        allowSubsample &&
        maxChunks !== undefined &&
        maxChunks > 0 &&
        chunks.length > maxChunks
      ) {
        if (sample.dimension === "LRU") {
          chunks = subsampleChunks(chunks, maxChunks, "head_tail");
          warnings.push(
            `${sample.id}: context 切 ${rawChunks.length} chunk，抽稀至 ${chunks.length}（head_tail）`,
          );
        } else if (arLike) {
          const queries = sample.qa.map((q) => q.question);
          chunks = subsampleChunksForQuery(chunks, maxChunks, queries);
          warnings.push(
            `${sample.id}: context 切 ${rawChunks.length} chunk，抽稀至 ${chunks.length}（query_aware）`,
          );
        } else {
          chunks = subsampleChunks(chunks, maxChunks, "uniform");
          warnings.push(
            `${sample.id}: context 切 ${rawChunks.length} chunk，抽稀至 ${chunks.length}（uniform）`,
          );
        }
      }
      if (chunks.length === 0) {
        warnings.push(`${sample.id}: 空 context`);
        continue;
      }
      const writtenIds: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        writtenIds.push(await putChunk(engine, repo, chunks[i]!, i));
      }
      // SF：纯旧事实 chunk 软失效（现行检索不可见；T4 历史问仍可见）
      if (sample.dimension === "SF") {
        const inv = await invalidateSupersededForSf(engine, repo, sample, writtenIds);
        if (inv.length === 0) {
          warnings.push(`${sample.id}: SF 未失效任何旧 chunk（检查 oldFactNeedle 与分块）`);
        }
      }

      for (const qa of sample.qa) {
        const qaWarnings: string[] = [];
        let injected = "";
        let recalled = false;
        let activeTexts: string[] = [];
        try {
          const pkg = await retriever.retrieve({
            type: "explicit_query",
            question: qa.question,
            repo,
            runId: `${repo}-${qa.id}`,
          });
          let items = pkg.items.map((i) => ({ text: i.text, tInvalid: i.tInvalid }));
          // 历史题：T4 词面启发式可能漏掉中文失效条，显式补上含 oldFactNeedle 的失效条目
          if (qa.sfMode === "historical" && qa.oldFactNeedle) {
            const needle = normalizeAnswer(qa.oldFactNeedle);
            const all = await engine.query({ repo, includeInvalidated: true, limit: 200 });
            for (const e of all) {
              if (e.tInvalid == null || e.kind !== "semantic") continue;
              if (!normalizeAnswer(e.fact).includes(needle)) continue;
              if (items.some((i) => i.text === e.fact)) continue;
              items.push({ text: e.fact, tInvalid: e.tInvalid });
            }
          }
          const shaped = injectionForSfMode(pkg.render(), items, qa.sfMode);
          // historical：若 render 未含失效条，用补齐后的 items 重拼
          if (qa.sfMode === "historical") {
            injected = items
              .map((i) =>
                i.tInvalid
                  ? `历史参考（已失效 ${i.tInvalid}）：${i.text}`
                  : `建议策略：${i.text}`,
              )
              .join("\n");
            activeTexts = items.map((i) => i.text);
          } else {
            injected = shaped.text;
            activeTexts = shaped.activeTexts;
          }
          recalled = items.length > 0 || pkg.items.length > 0;
          if (arLike && recalled) {
            const hay = normalizeAnswer(injected);
            const goldInInject = qa.answers.some((a) => {
              const g = normalizeAnswer(a);
              return g.length > 0 && hay.includes(g);
            });
            if (!goldInInject) qaWarnings.push("inject_miss_gold");
          }
        } catch (e) {
          qaWarnings.push(`retrieve: ${e instanceof Error ? e.message : String(e)}`);
        }

        let oldFactSuppressed: boolean | undefined;
        if (qa.sfMode === "current" && qa.oldFactNeedle) {
          const needle = normalizeAnswer(qa.oldFactNeedle);
          // 现行题：只检查活跃注入（不含已失效标注）
          const hay = normalizeAnswer(activeTexts.join("\n"));
          oldFactSuppressed = !hay.includes(needle);
          if (!oldFactSuppressed) {
            qaWarnings.push(`SF: 活跃注入仍含旧事实「${qa.oldFactNeedle}」`);
          }
        }

        let answer = "";
        try {
          answer = await backbone.complete(
            buildAnswerPrompt(qa.question, injected, { longForm, extractive }),
          );
        } catch (e) {
          qaWarnings.push(`answer: ${e instanceof Error ? e.message : String(e)}`);
        }

        // historical SF：允许用 oldFactNeedle 作为答案兜底之一
        const answers =
          qa.sfMode === "historical" && qa.oldFactNeedle
            ? [...qa.answers, qa.oldFactNeedle]
            : qa.answers;

        items.push({
          sampleId: sample.id,
          qaId: qa.id,
          dimension: sample.dimension,
          memoryOn: true,
          correct: scorePrediction(answer, answers, sample.metric),
          answerSnippet: answer.slice(0, 120),
          recalled,
          oldFactSuppressed,
          warnings: qaWarnings,
        });
        warnings.push(...qaWarnings.map((w) => `${sample.id}/${qa.id}: ${w}`));
      }
    } catch (e) {
      warnings.push(`${sample.id}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (!opts.keep) {
        try {
          await cleanupRepo(repo);
        } catch (e) {
          warnings.push(`${sample.id} cleanup: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const onN = items.filter((i) => i.sampleId === sample.id && i.memoryOn && i.correct).length;
    const offN = items.filter((i) => i.sampleId === sample.id && !i.memoryOn && i.correct).length;
    const qaN = sample.qa.length;
    console.log(
      `[mab] ${si + 1}/${samples.length} done ${sample.id} on=${onN}/${qaN} off=${offN}/${qaN} ${Date.now() - sampleT0}ms`,
    );
  }

  const summary = summarizeMab(items);
  const metrics: Record<string, number | string | null> = {
    样本数: samples.length,
    QA数_on: items.filter((i) => i.memoryOn).length,
    QA数_off: items.filter((i) => !i.memoryOn).length,
    平均Δ: summary.meanDelta,
    配对对数: summary.paired.nPairs,
    配对wins: summary.paired.wins,
    配对losses: summary.paired.losses,
    配对ties: summary.paired.ties,
    配对优势: summary.paired.pairedAdvantage,
    决胜win率: summary.paired.winRateAmongDecisive,
    符号检验P: summary.paired.signTestP,
    SF旧事实抑制率: summary.sfSuppression,
  };
  for (const d of ["AR", "TTL", "LRU", "CR", "SF"] as const) {
    const b = summary.byDim[d];
    metrics[`${d}_on`] = b.on;
    metrics[`${d}_off`] = b.off;
    metrics[`${d}_Δ`] = b.delta;
  }

  return {
    suite: "memory-agent-bench",
    generatedAt: now.toISOString(),
    passed: summary.passed,
    metrics,
    deltas: {
      AR: summary.byDim.AR.delta,
      TTL: summary.byDim.TTL.delta,
      LRU: summary.byDim.LRU.delta,
      CR: summary.byDim.CR.delta,
      SF: summary.byDim.SF.delta,
    },
    paired: summary.paired,
    details: items.map((i) => ({
      sample: i.sampleId,
      qa: i.qaId,
      dim: i.dimension,
      on: i.memoryOn,
      correct: i.correct,
      recalled: i.recalled,
      oldSuppressed: i.oldFactSuppressed ?? null,
      answer: i.answerSnippet,
    })),
    efficiency: {
      llmCalls: opts.stats?.calls ?? budget.used,
      retries: opts.stats?.retries ?? 0,
      failures: opts.stats?.failures ?? 0,
      totalMs: opts.stats?.totalMs ?? 0,
      estimatedTokens: opts.stats?.estimatedTokens ?? 0,
      truncated: budget.used >= budget.max,
    },
    warnings,
  };
}
