/**
 * 试用教训池（spec v2 §4.2 TrialLesson，M1 V026 建表，V032 扩展检索键列）
 *
 * 失败轨迹的教训先落 trial 池（独立命名空间，不进正式检索）；
 * 随行注入时 attemptsLeft 递减（#8），耗尽由 janitor 物理丢弃；
 * 所在任务验证成功后转正为 EpisodicExperience（source=trial_graduated，§4.2 / §12.3）。
 *
 * 教训生成（修复批次 B #7）：优先 LLM 蒸馏（Reflexion 式第一人称：哪个 action
 * 错、应该做什么，≤3 句，附 whenToUse/关键词作检索键）；超成本预算或蒸馏失败
 * 才降级为原文切片（distilled=false 标注）。
 */

import { createHash } from "node:crypto";
import { getSql, textArrayLiteral } from "../../db/connection.js";
import { appendOpLog } from "../observability/op-log.js";
import type { EpisodicExperience, MemoryStoreEngine, TrialLesson } from "../store/engine.js";
import { deriveEntryId } from "../store/id.js";
import type { DistillerLlm, DistillInput } from "./distiller.js";

export interface TrialLessonRow extends TrialLesson {
  whenToUse?: string;
  keywords?: string[];
  /** false = 超预算/蒸馏失败的原文切片降级产物 */
  distilled: boolean;
}

function trialId(lesson: string, originTaskId: string): string {
  const hex = createHash("sha256").update(`${originTaskId}\n${lesson}`).digest("hex").slice(0, 16);
  return `trial-${hex}`;
}

function rowToLesson(r: Record<string, unknown>): TrialLessonRow {
  return {
    id: r.id as string,
    lesson: r.lesson as string,
    originTaskId: r.origin_task_id as string,
    created: r.created instanceof Date ? r.created.toISOString() : String(r.created),
    attemptsLeft: r.attempts_left as number,
    whenToUse: (r.when_to_use as string | null) ?? undefined,
    keywords: (r.keywords as string[] | null) ?? undefined,
    distilled: (r.distilled as boolean) ?? false,
  };
}

/** 写入试用教训（同任务同教训幂等：attemptsLeft 重置为 3） */
export async function addTrialLesson(
  lesson: string,
  originTaskId: string,
  extra: { whenToUse?: string; keywords?: string[]; distilled?: boolean } = {},
): Promise<TrialLessonRow> {
  const sql = getSql();
  const id = trialId(lesson, originTaskId);
  const [row] = await sql`
    INSERT INTO memory_trial_lessons (id, lesson, origin_task_id, created, attempts_left, when_to_use, keywords, distilled)
    VALUES (${id}, ${lesson}, ${originTaskId}, now(), 3,
            ${extra.whenToUse ?? null}, ${textArrayLiteral(extra.keywords ?? [])}::text[], ${extra.distilled ?? false})
    ON CONFLICT (id) DO UPDATE SET attempts_left = 3
    RETURNING *
  `;
  return rowToLesson(row as Record<string, unknown>);
}

export async function listTrialLessons(originTaskId?: string): Promise<TrialLessonRow[]> {
  const sql = getSql();
  const rows = originTaskId
    ? await sql`SELECT * FROM memory_trial_lessons WHERE origin_task_id = ${originTaskId} ORDER BY created DESC`
    : await sql`SELECT * FROM memory_trial_lessons ORDER BY created DESC LIMIT 100`;
  return (rows as unknown as Record<string, unknown>[]).map(rowToLesson);
}

/** 按 id 取单条试用教训；不存在返回 null。 */
export async function getTrialLesson(id: string): Promise<TrialLessonRow | null> {
  const sql = getSql();
  const [row] = await sql`SELECT * FROM memory_trial_lessons WHERE id = ${id}`;
  return row ? rowToLesson(row as Record<string, unknown>) : null;
}

/** 随行注入一次 → attemptsLeft-1（#8；耗尽由 janitor 物理丢弃）。返回剩余次数。 */
export async function decrementTrialAttempts(id: string): Promise<number> {
  const sql = getSql();
  const [row] = await sql`
    UPDATE memory_trial_lessons SET attempts_left = GREATEST(attempts_left - 1, 0)
    WHERE id = ${id} RETURNING attempts_left
  `;
  return row ? ((row as { attempts_left: number }).attempts_left) : 0;
}

/** 从 trial 池物理删除（转正成功后或调用方显式丢弃）。 */
export async function removeTrialLesson(id: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`DELETE FROM memory_trial_lessons WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

export interface GraduateTrialOptions {
  engine: MemoryStoreEngine;
  /** 转正时写入的 repo（注入 run 的仓库） */
  repo: string;
  /** 验证成功的 runId（证据指针） */
  graduatingRunId: string;
  now?: () => Date;
}

export interface GraduateTrialResult {
  memoryId: string;
  trialId: string;
}

/**
 * 试用转正（spec §4.2）：trial → EpisodicExperience(source=trial_graduated)。
 * - 正式入库后删除 trial 行（幂等：trial 已不存在 → null）
 * - 同内容哈希幂等：重复转正得到同一 episodic id
 */
export async function graduateTrialLesson(
  trialId: string,
  opts: GraduateTrialOptions,
): Promise<GraduateTrialResult | null> {
  const lesson = await getTrialLesson(trialId);
  if (!lesson) return null;

  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const whenToUse =
    lesson.whenToUse?.trim() ||
    "When retrying a task that previously failed with a similar error";
  const perspective = lesson.lesson.trim();
  // 操作建议：试用教训本身即 Reflexion 式行动指引（≤1 条，避免空 modification）
  const modification = perspective ? [perspective.slice(0, 300)] : [];

  const entry: EpisodicExperience = {
    id: "",
    kind: "episodic",
    repo: opts.repo,
    created: nowIso,
    tValid: nowIso,
    tInvalid: null,
    source: "trial_graduated",
    confidence: 0.75,
    evidence: [
      `runs/${lesson.originTaskId}`,
      `runs/${opts.graduatingRunId}`,
      `trial/${lesson.id}`,
    ],
    freq: 0,
    utility: 1, // 转正当场即一次验证成功归因
    whenToUse,
    perspective,
    modification,
    issueType: "trial_graduated",
    taskId: opts.graduatingRunId,
  };

  await opts.engine.put(entry);
  const memoryId = deriveEntryId(entry);
  await removeTrialLesson(trialId);
  await appendOpLog("write.graduated", {
    runId: opts.graduatingRunId,
    entryIds: [memoryId],
    detail: { trialId, originTaskId: lesson.originTaskId, source: "trial_graduated" },
  });
  return { memoryId, trialId };
}

// ── LLM 蒸馏（#7）──

export interface TrialLessonDraft {
  /** Reflexion 式第一人称教训：哪个 action 错、应该做什么，≤3 句 */
  lesson: string;
  whenToUse: string;
  keywords: string[];
}

export function buildTrialLessonPrompt(input: DistillInput): string {
  return `你是失败复盘蒸馏器。从失败任务轨迹提炼一条"试用教训"，输出 JSON。

硬性要求：
1. lesson 用第一人称（"我…"），指出哪个 action 错了、应该做什么，≤3 句。
2. whenToUse：以 "When …"/"当…" 开头的条件句，描述该教训的适用场景。
3. keywords：3–5 个检索关键词（含错误类型名）。
4. 去具体化：禁止具体函数名/变量名/文件路径。

输出 JSON（不要输出其它内容）：
{ "lesson": "我…", "whenToUse": "When …", "keywords": ["…"] }

任务目标：
${input.goal}

失败轨迹：
${input.trajectory}`;
}

function countSentences(s: string): number {
  return s.split(/[.!?。！？]+/).filter((x) => x.trim().length > 0).length;
}

/** 手写校验试用教训 JSON；非法 → null（调用方降级原文切片） */
export function parseTrialLessonOutput(raw: string): TrialLessonDraft | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.lesson !== "string" || parsed.lesson.trim().length === 0) return null;
    if (countSentences(parsed.lesson) > 3) return null;
    if (typeof parsed.whenToUse !== "string" || !/^(?:当|When[\s,])/.test(parsed.whenToUse.trim())) return null;
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter((k): k is string => typeof k === "string")
      : [];
    return { lesson: parsed.lesson.trim(), whenToUse: parsed.whenToUse.trim(), keywords };
  } catch {
    return null;
  }
}

/** LLM 蒸馏试用教训；失败（重试 1 次后仍非法）→ null */
export async function distillTrialLesson(
  llm: DistillerLlm,
  input: DistillInput,
): Promise<TrialLessonDraft | null> {
  const prompt = buildTrialLessonPrompt(input);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await llm.complete(prompt);
      const parsed = parseTrialLessonOutput(raw);
      if (parsed) return parsed;
    } catch { /* 重试 */ }
  }
  return null;
}
