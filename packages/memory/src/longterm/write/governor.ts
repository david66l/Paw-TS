/**
 * Longterm Governor（spec v2 §5.6 / §9.1，M5）
 *
 * 批量裁决：同批多候选 + 各自 top-10 相似旧条目打包一次 LLM 调用；
 * prompt 内条目用整数序号引用，序号→真实 id 由代码映射（mem0 同款防 UUID 幻觉）。
 *
 * 四态语义：
 * - NOOP：语义等价 → 丢弃候选
 * - UPDATE：同主题更丰富 → 更新条目（旧值入 history[]，账本保留——由引擎 upsert 保证）
 * - INVALIDATE：矛盾 → 旧条目 tInvalid=now 软失效，不物理删除（A8）
 * - ADD：全新信息
 *
 * 时序倒挂（§7.4）：候选 tValid 早于既有活跃条目 → 候选自身 NOOP（不入库），
 * 这是规则层判定，不进 LLM。
 *
 * 裁决记录：governance_decisions 表（复用 V005，decision 列写 ADD/UPDATE/INVALIDATE/NOOP）。
 * LLM 输出手写 JSON 校验；序号非法/越界 → 该条降级 NOOP 并记 op-log（防幻觉 id 污染）。
 */

import { getSql } from "../../db/connection.js";
import { generateId } from "../../db/modules/platform/idGen.js";
import type { EpisodicExperience, MemoryEntry, SemanticFact } from "../store/engine.js";
import { deriveEntryId } from "../store/id.js";
import { appendOpLog } from "../observability/op-log.js";
import { extractJson } from "./distiller.js";

export interface GovernorLlm {
  complete(prompt: string): Promise<string>;
}

export type GovernorOp = "ADD" | "UPDATE" | "INVALIDATE" | "NOOP";

export interface GovernorDecision {
  op: GovernorOp;
  targetId?: string;
  reason?: string;
}

/** 进入裁决的候选（修复批次 B #6：semantic + episodic 同通道） */
export type GovernorCandidate = SemanticFact | EpisodicExperience;

/** 候选正文（prompt 展示用） */
function candidateText(c: GovernorCandidate): string {
  return c.kind === "semantic" ? c.fact : `${c.whenToUse}\n${c.perspective}`;
}

function candidateKeywords(c: GovernorCandidate): string[] {
  return c.kind === "semantic" ? c.keywords : [c.issueType];
}

export interface AdjudicateItem {
  candidate: GovernorCandidate;
  similar: MemoryEntry[];
}

export interface GovernorOptions {
  llm: GovernorLlm;
  now?: () => Date;
}

const OPS: readonly GovernorOp[] = ["ADD", "UPDATE", "INVALIDATE", "NOOP"];

/** 时序倒挂判定（§7.4，规则层）：候选描述的状态早于任一活跃相似条目 */
export function isTemporalInversion(candidate: GovernorCandidate, similar: readonly MemoryEntry[]): boolean {
  const cValid = Date.parse(candidate.tValid);
  if (Number.isNaN(cValid)) return false;
  return similar.some((s) => {
    if (s.tInvalid != null) return false;
    const sValid = Date.parse(s.tValid);
    return !Number.isNaN(sValid) && cValid < sValid;
  });
}

// ── prompt ──

/** 批量裁决 prompt：候选 C1..Cn、既有条目 E1..Em（全局去重），整数序号引用 */
export function buildAdjudicationPrompt(items: readonly AdjudicateItem[]): string {
  // 既有条目全局去重编号
  const entrySeq = new Map<string, number>();
  const entries: MemoryEntry[] = [];
  for (const item of items) {
    for (const s of item.similar) {
      if (!entrySeq.has(s.id)) {
        entrySeq.set(s.id, entries.length + 1);
        entries.push(s);
      }
    }
  }

  const candidateBlocks = items.map((item, i) => {
    const c = item.candidate;
    const sims = item.similar.map((s) => `E${entrySeq.get(s.id)}`).join(", ") || "(无相似条目)";
    return [
      `候选 C${i + 1}（kind: ${c.kind}，相似既有条目: ${sims}）:`,
      `  content: ${candidateText(c)}`,
      `  keywords: [${candidateKeywords(c).join(", ")}]`,
      `  tValid: ${c.tValid}    source: ${c.source}`,
    ].join("\n");
  });

  const entryBlocks = entries.map((e, i) => {
    const fact = e.kind === "semantic" ? e.fact : JSON.stringify(e).slice(0, 200);
    return `既有条目 E${i + 1}:\n  fact: ${fact}\n  tValid: ${e.tValid}    tInvalid: ${e.tInvalid ?? "(活跃)"}    source: ${e.source}`;
  });

  return `你是记忆库裁决器（Governor）。对每条候选给出裁决：ADD / UPDATE / INVALIDATE / NOOP。

判定表：
- NOOP：候选与某既有条目语义等价（措辞不同但信息相同）
- UPDATE：同主题但候选信息更丰富/更新（既有条目保留账本，内容被候选取代）
- INVALIDATE：矛盾——候选描述的新状态取代了既有条目的旧状态（既有条目软失效，不删除）
- ADD：全新信息，与所有既有条目无语义重叠

prompt 纪律：
1. 判 INVALIDATE（矛盾）必须在 reason 中引用双方原文片段（格式：candidate 说"…" vs E-n 说"…"），防误删。
2. 不得仅因"与当前任务无关"就判 INVALIDATE。
3. UPDATE/INVALIDATE 必须给 target（既有条目序号）；ADD/NOOP 的 target 为 null。
4. 冲突时新信息优先；同新鲜度时 source 优先级 user_statement > agent_verified > repo_docs > trial_graduated > agent_inferred。

输出 JSON（不要输出任何其它内容）：
{ "decisions": [ { "candidate": 1, "op": "ADD", "target": null, "reason": "…" } ] }
每条候选必须恰好出现一次。candidate/target 只用本 prompt 中的整数序号。

${candidateBlocks.join("\n\n")}

${entryBlocks.length > 0 ? entryBlocks.join("\n\n") : "（库中无相似既有条目）"}`;
}

// ── 输出校验（手写，防幻觉序号）──

export interface ParsedBatchDecision {
  /** candidateIndex（0-based）→ 裁决；targetSeq 为 0-based 既有条目序号 */
  byCandidate: Map<number, { op: GovernorOp; targetSeq?: number; reason?: string }>;
  /** 校验问题（幻觉序号等），每条已降级处理 */
  errors: string[];
}

export function parseGovernorOutput(
  raw: string,
  numCandidates: number,
  numEntries: number,
): ParsedBatchDecision {
  const errors: string[] = [];
  const byCandidate: ParsedBatchDecision["byCandidate"] = new Map();

  const parsed = extractJson(raw) as { decisions?: unknown };
  if (!Array.isArray(parsed.decisions)) {
    throw new Error("缺 decisions 数组");
  }

  for (const d of parsed.decisions) {
    if (typeof d !== "object" || d === null) {
      errors.push("decision 不是对象");
      continue;
    }
    const dec = d as Record<string, unknown>;
    const cSeq = dec.candidate;
    if (typeof cSeq !== "number" || !Number.isInteger(cSeq) || cSeq < 1 || cSeq > numCandidates) {
      errors.push(`幻觉候选序号: ${JSON.stringify(cSeq)}（合法范围 1..${numCandidates}）`);
      continue;
    }
    const op = dec.op;
    if (typeof op !== "string" || !OPS.includes(op as GovernorOp)) {
      errors.push(`C${cSeq}: 非法 op ${JSON.stringify(op)}`);
      continue;
    }

    let targetSeq: number | undefined;
    if (dec.target !== null && dec.target !== undefined) {
      if (typeof dec.target !== "number" || !Number.isInteger(dec.target) || dec.target < 1 || dec.target > numEntries) {
        errors.push(`C${cSeq}: 幻觉既有条目序号: ${JSON.stringify(dec.target)}（合法范围 1..${numEntries}）`);
        continue;
      }
      targetSeq = dec.target - 1;
    }
    if ((op === "UPDATE" || op === "INVALIDATE") && targetSeq === undefined) {
      errors.push(`C${cSeq}: ${op} 必须给 target 序号`);
      continue;
    }
    byCandidate.set(cSeq - 1, { op: op as GovernorOp, targetSeq, reason: typeof dec.reason === "string" ? dec.reason : undefined });
  }

  return { byCandidate, errors };
}

// ── Governor ──

export class LongtermGovernor {
  private readonly llm: GovernorLlm;
  private readonly now: () => Date;

  constructor(opts: GovernorOptions) {
    this.llm = opts.llm;
    this.now = opts.now ?? (() => new Date());
  }

  /** 逐条裁决（spec §9.1）；batch 关闭时由管线调用 */
  async adjudicate(candidate: GovernorCandidate, similar: MemoryEntry[]): Promise<GovernorDecision> {
    const [d] = await this.adjudicateBatch([{ candidate, similar }]);
    return d!;
  }

  /** 批量裁决（默认路径，§5.6）：一次 LLM 调用裁决整批 */
  async adjudicateBatch(items: AdjudicateItem[]): Promise<GovernorDecision[]> {
    if (items.length === 0) return [];

    // 规则层前置：时序倒挂候选不进 LLM，直接 NOOP（§7.4）
    const needsLlm: { index: number; item: AdjudicateItem }[] = [];
    const results: (GovernorDecision | null)[] = items.map(() => null);
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (isTemporalInversion(item.candidate, item.similar)) {
        results[i] = { op: "NOOP", reason: "temporal_inversion: 候选描述更早状态，既有条目更新（§7.4）" };
        await this.record(item.candidate, results[i]!, undefined);
        await appendOpLog("governed", {
          entryIds: [deriveEntryId(item.candidate)],
          detail: { op: "NOOP", reason: "temporal_inversion" },
        });
      } else {
        needsLlm.push({ index: i, item });
      }
    }
    if (needsLlm.length === 0) return results.map((r) => r!);

    // 既有条目全局编号（与 prompt 一致）
    const entrySeq = new Map<string, number>();
    const entries: MemoryEntry[] = [];
    for (const { item } of needsLlm) {
      for (const s of item.similar) {
        if (!entrySeq.has(s.id)) {
          entrySeq.set(s.id, entries.length);
          entries.push(s);
        }
      }
    }

    let parsed: ParsedBatchDecision | null = null;
    const errors: string[] = [];
    const prompt = buildAdjudicationPrompt(needsLlm.map((x) => x.item));
    for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
      try {
        const raw = await this.llm.complete(
          attempt === 0 ? prompt : `${prompt}\n\n上次输出校验失败：${errors.join("；")}。请修正后重新输出 JSON。`,
        );
        parsed = parseGovernorOutput(raw, needsLlm.length, entries.length);
      } catch (e) {
        errors.push(`attempt ${attempt + 1}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (parsed === null) {
      // 裁决器持续不可用（重试 1 次后仍败）：抛错交给 outbox worker 重试（3 次进死信），
      // 不伪装 NOOP 静默消费候选（修复批次 B #11）
      await appendOpLog("error", { detail: { stage: "governor", errors: errors.slice(0, 5) } });
      throw new Error(`governor_unavailable: ${errors.join("；")}`);
    }

    for (const err of parsed.errors) {
      await appendOpLog("error", { detail: { stage: "governor.parse", error: err } });
    }

    for (let j = 0; j < needsLlm.length; j++) {
      const { index, item } = needsLlm[j]!;
      const dec = parsed.byCandidate.get(j);
      if (!dec) {
        // LLM 漏判该候选 → 保守 NOOP + 记录
        results[index] = { op: "NOOP", reason: "missing_in_governor_output" };
        await appendOpLog("error", { detail: { stage: "governor.parse", error: `候选 ${j + 1} 未出现在裁决输出中，降级 NOOP` } });
      } else {
        const targetId = dec.targetSeq !== undefined ? entries[dec.targetSeq]!.id : undefined;
        results[index] = { op: dec.op, targetId, reason: dec.reason };
      }
      await this.record(item.candidate, results[index]!, results[index]!.targetId);
    }

    return results.map((r) => r!);
  }

  /** 裁决记录落 governance_decisions（V005） */
  private async record(candidate: GovernorCandidate, decision: GovernorDecision, targetId?: string): Promise<void> {
    try {
      const sql = getSql();
      const candidateId = deriveEntryId(candidate);
      const nowIso = this.now().toISOString();
      await sql`
        INSERT INTO governance_decisions (
          id, schema_version, candidate_id, decision, reasons,
          resulting_memory_id, target_memory_id,
          required_actions, policy_version, decided_by, status,
          decided_at, created_at
        ) VALUES (
          ${generateId("gov")}, 2, ${candidateId}, ${decision.op},
          ${sql.json([{ code: decision.op, description: decision.reason ?? "" }] as any)},
          ${decision.op === "ADD" ? candidateId : (targetId ?? null)},
          ${targetId ?? null},
          ${sql.json([] as any)}, 'v2-m5',
          ${sql.json({ actorType: "system", actorId: "longterm-governor" } as any)},
          'EXECUTED', ${nowIso}, ${nowIso}
        )
      `;
    } catch {
      // 裁决记录失败不阻塞主流程（§9.6）
    }
  }
}
