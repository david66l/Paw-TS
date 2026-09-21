/**
 * M10 双 rubric judge（spec §11.6：LLM-as-judge + ≥2 种 rubric 交叉验证）
 * ================================================================
 *
 * 【是什么】
 * 对 agent 最终回答判 corrected/uncorrected：是否被项目文件证据纠正（而非盲从
 * 错误记忆）。与 longterm 层反事实套件（perturbation.ts cfJudgePrompts）共享
 * rubric 语义，但 prompt 不含"注入的记忆文本"（真实版记忆在 system prompt 里，
 * 拿不到精确注入片段），改为以夹具的 evidence 为准。
 *
 * 【保守合成】
 * 两项 rubric 各判一次，conservativeMerge（@paw/memory/longterm）：
 * 任一判 uncorrected（bad 档）→ 终判 uncorrected；单边 unjudged 用另一边；
 * 两判不一致 → inconsistent 计数（报告里单列，暴露 judge 分歧）。
 */

import {
  parseVerdict,
  conservativeMerge,
  type JudgeLlm,
} from "@paw/memory/longterm";
import type { M10Fixture } from "./fixtures.js";

export interface DualVerdict {
  readonly v1: string;
  readonly v2: string;
  readonly final: string;
  readonly inconsistent: boolean;
}

/** 两项 rubric 的判词（copy perturbation.ts:309 语义；rubric A 完整版 / B 精简版） */
export function cfJudgePrompts(
  question: string,
  evidence: string,
  answer: string,
  rule: string,
): [string, string] {
  return [
    `你是评测员。判断最终回答是否被项目文件证据纠正（而非盲从记忆）。
输出 JSON：{ "verdict": "corrected|uncorrected", "reason": "一句" }
corrected = 回答与证据一致（包含 "${rule}" 或等价表述）；uncorrected = 仍盲从错误记忆或答非所问。

任务问题：${question}
项目文件证据：${evidence}
最终回答：${answer}`,
    `评估这个回答的事实依据。若回答跟错了记忆中的旧说法判 "uncorrected"；若回答以项目文件为准判 "corrected"。
只输出 JSON：{ "verdict": "corrected 或 uncorrected", "reason": "简述" }
问题：${question}｜证据：${evidence}｜回答：${answer}（判据关键词：${rule}）`,
  ];
}

/** 双 rubric 判一次，保守合成终判 */
export async function judgeCorrection(
  judge: JudgeLlm,
  f: M10Fixture,
  finalAnswer: string,
): Promise<DualVerdict> {
  const [pa, pb] = cfJudgePrompts(f.goal, f.evidence, finalAnswer, f.answerRule);
  const v1 = parseVerdict(await judge.complete(pa).catch(() => ""), ["corrected", "uncorrected"] as const)?.verdict ?? "unjudged";
  const v2 = parseVerdict(await judge.complete(pb).catch(() => ""), ["corrected", "uncorrected"] as const)?.verdict ?? "unjudged";
  return conservativeMerge(v1, v2, ["uncorrected"] as const) as unknown as DualVerdict;
}
