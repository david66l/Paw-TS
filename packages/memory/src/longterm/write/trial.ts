/**
 * 试用教训池（spec v2 §4.2 TrialLesson，M1 V026 建表，V032 扩展检索键列）
 *
 * 失败轨迹的教训先落 trial 池（独立命名空间，不进正式检索）；
 * 随行注入时 attemptsLeft 递减（#8），耗尽由 janitor 物理丢弃；
 * 任务成功后"转正"为 EpisodicExperience（转正逻辑属 v2）。
 *
 * 教训生成（修复批次 B #7）：优先 LLM 蒸馏（Reflexion 式第一人称：哪个 action
 * 错、应该做什么，≤3 句，附 whenToUse/关键词作检索键）；超成本预算或蒸馏失败
 * 才降级为原文切片（distilled=false 标注）。
 */

import { createHash } from "node:crypto";
import { getSql, textArrayLiteral } from "../../db/connection.js";
import type { TrialLesson } from "../store/engine.js";
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

/** 随行注入一次 → attemptsLeft-1（#8；耗尽由 janitor 物理丢弃）。返回剩余次数。 */
export async function decrementTrialAttempts(id: string): Promise<number> {
  const sql = getSql();
  const [row] = await sql`
    UPDATE memory_trial_lessons SET attempts_left = GREATEST(attempts_left - 1, 0)
    WHERE id = ${id} RETURNING attempts_left
  `;
  return row ? ((row as { attempts_left: number }).attempts_left) : 0;
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
