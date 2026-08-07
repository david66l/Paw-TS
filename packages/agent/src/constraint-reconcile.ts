/**
 * 约束调和 Agent（Constraint Lifecycle 的 LLM 判定层）。
 * ======================================================
 *
 * 用户意图会变化/过期/反转——约束不能是"永久红线"。本模块用一次
 * 便宜的辅助模型调用维护"当前有效约束集合"：
 *
 * - harness 侧规则只决定**什么时候该问**（新用户消息 / 15 轮强制 /
 *   任务转向信号），**不做语义判定**（固定词匹配会漏掉真实意图变化）
 * - LLM 判定：现有约束 keep / drop（撤销、反转、过期）、新约束 add
 * - 降级路径（LLM 失败/解析失败）：保守——全部 keep + 规则提取追加，
 *   绝不因 LLM 故障丢约束（红线安全方向）
 */

import type { LanguageModel } from "@paw/models";
import { completeAuxiliaryTask } from "./auxiliary-complete.js";
import type { ConstraintRecord } from "./task-state.js";

export interface ConstraintReconcileResult {
  /** 现有约束中保留为 active 的下标 */
  readonly keep: readonly number[];
  /** 现有约束中标记 superseded 的下标（撤销/反转/过期） */
  readonly drop: readonly number[];
  /** 新用户消息中发现的新约束（verbatim 原文） */
  readonly add: readonly { readonly text: string }[];
  /** 调和是否成功（false = 降级路径：keep 全部 + 规则追加） */
  readonly ok: boolean;
}

const RECONCILE_SYSTEM = `You maintain the CURRENT set of active user constraints for a coding agent. A constraint is a rule the user explicitly gave ("不要修改 X", "只用 Y", "Never run Z").

Users change their minds over time. Your job: decide, based on the NEW user messages, which existing constraints are still active and which are no longer wanted.

Decide for each existing constraint:
- keep: still applies to the current task
- drop: the user revoked, superseded, or reversed it (e.g. "don't use X" followed by "now use X"; "ignore what I said earlier"; "forget the old rule"). Also drop constraints that clearly no longer apply to the new task direction.

Also list NEW constraints found verbatim in the new messages (copy the exact original sentence — never reword, never paraphrase).

If a new message reverses an old constraint, drop the old one. When unsure, keep. Never invent constraints. If nothing changed, return empty lists.`;

const RECONCILE_FORMAT = `Respond with ONLY a JSON object, no other text:
{"keep":[<indexes of existing constraints to keep>],"add":[{"text":"<new constraint verbatim>"}],"drop":[<indexes to drop>]}`;

/** 构建调和 prompt：现有 active 约束 + 新增用户消息 */
export function buildConstraintReconcilePrompt(opts: {
  readonly existing: readonly ConstraintRecord[];
  readonly newUserMessages: readonly string[];
  readonly currentTurn: number;
}): string {
  const existingLines =
    opts.existing.length > 0
      ? opts.existing.map(
          (c, i) => `[${i}] (turn ${c.sourceTurn}) ${c.text}`,
        )
      : ["(none)"];
  const newLines =
    opts.newUserMessages.length > 0
      ? opts.newUserMessages.map((m, i) => `${opts.currentTurn - opts.newUserMessages.length + 1 + i}: ${m}`)
      : ["(no new user messages — this is a periodic check: drop constraints that have become stale)"];
  return [
    "Existing active constraints:",
    ...existingLines,
    "",
    "New user messages since the last check:",
    ...newLines,
  ].join("\n");
}

/** 宽松 JSON 解析：容忍 ```json 围栏与前后杂文 */
function parseReconcileJson(text: string): {
  readonly keep?: unknown;
  readonly add?: unknown;
  readonly drop?: unknown;
} | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toIndexArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "number" ? x : Number(x)))
    .filter((n) => Number.isInteger(n) && n >= 0);
}

function toAddArray(v: unknown): { text: string }[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> =>
      !!x && typeof x === "object" && !Array.isArray(x),
    )
    .map((x) => ({ text: typeof x.text === "string" ? x.text.trim() : "" }))
    .filter((a) => a.text.length > 0);
}

/** 规则兜底追加：LLM 降级时从新消息提取字面约束（只追加不删除，安全方向） */
function ruleFallbackExtract(messages: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const line of m.split(/\n+/)) {
      const t = line.trim();
      if (
        t &&
        t.length <= 200 &&
        /\b(?:must|only|never|do not|don't)\b|必须|只能|不要|不能|禁止/.test(
          t,
        )
      ) {
        out.push(t);
      }
    }
  }
  return out;
}

/**
 * 执行一次约束调和（一次辅助模型调用）。
 *
 * 失败降级：keep 全部现有约束 + 规则提取的新约束追加
 * （绝不因 LLM 故障丢约束）。
 */
export async function runConstraintReconcile(opts: {
  readonly model: LanguageModel;
  readonly existing: readonly ConstraintRecord[];
  readonly newUserMessages: readonly string[];
  readonly currentTurn: number;
  readonly signal?: AbortSignal;
}): Promise<ConstraintReconcileResult> {
  const prompt = buildConstraintReconcilePrompt({
    existing: opts.existing,
    newUserMessages: opts.newUserMessages,
    currentTurn: opts.currentTurn,
  });

  let text: string;
  try {
    text = await completeAuxiliaryTask({
      model: opts.model,
      system: RECONCILE_SYSTEM,
      user: `${prompt}\n\n${RECONCILE_FORMAT}`,
      signal: opts.signal,
    });
  } catch {
    return {
      keep: opts.existing.map((_, i) => i),
      drop: [],
      add: ruleFallbackExtract(opts.newUserMessages).map((text) => ({ text })),
      ok: false,
    };
  }

  const parsed = parseReconcileJson(text);
  if (!parsed) {
    return {
      keep: opts.existing.map((_, i) => i),
      drop: [],
      add: ruleFallbackExtract(opts.newUserMessages).map((text) => ({ text })),
      ok: false,
    };
  }

  const keep = toIndexArray(parsed.keep);
  const drop = toIndexArray(parsed.drop);
  const add = toAddArray(parsed.add);
  // 防御：keep/drop 下标越界过滤；同一下标不能既 keep 又 drop（drop 优先）
  const validKeep = keep.filter((i) => i < opts.existing.length && !drop.includes(i));
  return {
    keep: validKeep,
    drop: drop.filter((i) => i < opts.existing.length),
    add,
    ok: true,
  };
}
