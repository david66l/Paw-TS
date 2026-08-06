/**
 * 试用教训池（spec v2 §4.2 TrialLesson，M1 V026 建表）
 *
 * 失败轨迹的教训先落 trial 池（独立命名空间，不进正式检索）；
 * attemptsLeft 耗尽丢弃；任务成功后"转正"为 EpisodicExperience（转正逻辑属 v2）。
 */

import { createHash } from "node:crypto";
import { getSql } from "../../db/connection.js";
import type { TrialLesson } from "../store/engine.js";

function trialId(lesson: string, originTaskId: string): string {
  const hex = createHash("sha256").update(`${originTaskId}\n${lesson}`).digest("hex").slice(0, 16);
  return `trial-${hex}`;
}

/** 写入试用教训（同任务同教训幂等：attemptsLeft 重置为 3） */
export async function addTrialLesson(lesson: string, originTaskId: string): Promise<TrialLesson> {
  const sql = getSql();
  const id = trialId(lesson, originTaskId);
  const [row] = await sql`
    INSERT INTO memory_trial_lessons (id, lesson, origin_task_id, created, attempts_left)
    VALUES (${id}, ${lesson}, ${originTaskId}, now(), 3)
    ON CONFLICT (id) DO UPDATE SET attempts_left = 3
    RETURNING *
  `;
  const r = row as Record<string, unknown>;
  return {
    id: r.id as string,
    lesson: r.lesson as string,
    originTaskId: r.origin_task_id as string,
    created: r.created instanceof Date ? r.created.toISOString() : String(r.created),
    attemptsLeft: r.attempts_left as number,
  };
}

export async function listTrialLessons(originTaskId?: string): Promise<TrialLesson[]> {
  const sql = getSql();
  const rows = originTaskId
    ? await sql`SELECT * FROM memory_trial_lessons WHERE origin_task_id = ${originTaskId} ORDER BY created DESC`
    : await sql`SELECT * FROM memory_trial_lessons ORDER BY created DESC LIMIT 100`;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    lesson: r.lesson as string,
    originTaskId: r.origin_task_id as string,
    created: r.created instanceof Date ? r.created.toISOString() : String(r.created),
    attemptsLeft: r.attempts_left as number,
  }));
}
