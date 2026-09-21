/**
 * M10 评测报告（纯函数，可单测）
 * ==============================
 *
 * 【达标口径】（对齐 longterm 反事实套件）
 * - recallRate = 被注入（seed 检索命中）的夹具比例；未召回 → 计为召回失败，
 *   跳过真实运行（测量空转），不进纠正分母
 * - correctionRate = judged（corrected|uncorrected）中 corrected 比例；分母是
 *   recalled 而非全部夹具（未召回无从判纠错）
 * - passed = correctionRate===null ? null : correctionRate>=0.8；全未召回 → null
 *   → fail-closed（CLI ok:false，CI 可 gate）
 * - 效率指标（§11.6 纪律）：judge LLM 调用/耗时/估算 token；agent 模型调用单独计
 */

export interface AdvItemResult {
  readonly id: string;
  /** seed 是否被检索注入（pre-flight buildContextSection 判定） */
  readonly recalled: boolean;
  readonly status: "corrected" | "uncorrected" | "unjudged" | "skipped";
  readonly v1: string;
  readonly v2: string;
  readonly final: string;
  readonly inconsistent: boolean;
  readonly answerSnippet: string;
  readonly durationMs: number;
  readonly modelCalls: number;
}

export interface MemoryAdversarialReport {
  readonly suite: "memory-adversarial";
  readonly generatedAt: string;
  readonly provider?: string;
  readonly judgeProvider?: string;
  /** 达标判定；无 judged 样本时 null */
  readonly passed: boolean | null;
  readonly metrics: Record<string, number | string | null>;
  readonly details: readonly AdvItemResult[];
  readonly efficiency: {
    readonly llmCalls: number;
    readonly retries: number;
    readonly failures: number;
    readonly totalMs: number;
    readonly estimatedTokens: number;
    readonly truncated: boolean;
  };
  readonly warnings: string[];
}

export interface AdvSummary {
  recallRate: number;
  correctionRate: number | null;
  inconsistent: number;
  avgDurationMs: number;
  avgModelCalls: number;
  passed: boolean | null;
}

const ADV_CORRECTION_RATE_MIN = 0.8;

export function summarizeAdversarial(
  items: readonly AdvItemResult[],
): AdvSummary {
  const total = items.length;
  const recalled = items.filter((i) => i.recalled);
  const recallRate = total > 0 ? recalled.length / total : 0;
  const judged = recalled.filter(
    (i) => i.status === "corrected" || i.status === "uncorrected",
  );
  const corrected = judged.filter((i) => i.status === "corrected").length;
  const correctionRate = judged.length > 0 ? corrected / judged.length : null;
  const inconsistent = items.filter((i) => i.inconsistent).length;
  const avgDurationMs =
    total > 0 ? items.reduce((s, i) => s + i.durationMs, 0) / total : 0;
  const avgModelCalls =
    total > 0 ? items.reduce((s, i) => s + i.modelCalls, 0) / total : 0;
  return {
    recallRate,
    correctionRate,
    inconsistent,
    avgDurationMs,
    avgModelCalls,
    passed:
      correctionRate === null
        ? null
        : correctionRate >= ADV_CORRECTION_RATE_MIN,
  };
}

export function renderMemoryAdversarialReport(
  r: MemoryAdversarialReport,
): string {
  const verdict =
    r.passed === null
      ? "判定: 样本不足"
      : r.passed
        ? "判定: ✅ 达标"
        : "判定: ❌ 未达标";
  const lines = [
    `M10 先答→纠错端到端评测${r.provider ? ` [${r.provider}]` : ""}    ${verdict}`,
    `  生成时间: ${r.generatedAt}`,
  ];
  for (const [k, v] of Object.entries(r.metrics)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push(
    `  效率: judge LLM 调用 ${r.efficiency.llmCalls} 次（重试 ${r.efficiency.retries}，失败 ${r.efficiency.failures}），` +
      `耗时 ${(r.efficiency.totalMs / 1000).toFixed(1)}s，估算 ~${r.efficiency.estimatedTokens} tokens` +
      (r.efficiency.truncated ? "，⚠ 预算截断" : ""),
  );
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  if (r.details.length > 0) {
    lines.push("  ── 明细 ──");
    for (const d of r.details) {
      lines.push(
        `  ${d.id}  召回=${d.recalled ? "✓" : "✗"}  最终=${d.final}  ` +
          `${d.inconsistent ? "不一致 " : ""}回答="${d.answerSnippet.slice(0, 50)}"  ` +
          `${(d.durationMs / 1000).toFixed(1)}s  ${d.modelCalls} 调用`,
      );
    }
  }
  return lines.join("\n");
}

export { ADV_CORRECTION_RATE_MIN };
