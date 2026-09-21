/**
 * Aggregator — 评分聚合器
 * =========================
 *
 * 【是什么】
 * 将同一测试用例的多次重复运行分数合并为稳定性指标，生成
 * AggregateScoreReport（包含均值、极差、变异系数等）。
 *
 * 【为什么】
 * LLM 的输出是非确定性的（即使 temperature=0 也可能有微小差异），
 * 单次运行的高分不能证明模型在实际使用中持续稳定。通过重复运行并
 * 计算以下指标来量化稳定性：
 * - 均值（mu）：整体表现水平
 * - 极差（min～max）：波动范围
 * - 变异系数（CV = sigma/mu）：离散程度，CV 越低越稳定
 *
 * 【关键设计决策】
 * 1. **变异系数（CV）作为稳定性**：使用 sigma/mu 而非标准差，
 *    因为 CV 是归一化指标，消除了均值大小的影响。
 *    stabilityScore = (1 - CV) * 100，即 CV 越小稳定性越接近 100。
 * 2. **样本方差（n-1）**：当重复次数 > 1 时使用样本方差而非总体方差，
 *    避免对小样本的偏差。重复次数为 1 时方差为 0。
 * 3. **通过判定基于均值**：mu >= passThreshold 视为通过，而非要求
 *    每次重复都通过。这样更贴近实际使用场景：偶尔的低分可接受。
 */

import type { ScoreReport, AggregateScoreReport } from "./types.js";

export class Aggregator {
  /**
   * 聚合同一测试用例的多次重复运行分数。
   *
   * @param testCaseId 测试用例 ID
   * @param reports 该用例的所有重复运行报告
   * @param passThreshold 通过阈值（默认 70）
   * @returns 聚合后的评分报告
   */
  aggregate(
    testCaseId: string,
    reports: ScoreReport[],
    passThreshold: number = 70,
  ): AggregateScoreReport {
    // 边界情况：无运行数据
    if (reports.length === 0) {
      return {
        testCaseId,
        repetitionCount: 0,
        overallScore: 0,
        stabilityScore: 0,
        minScore: 0,
        maxScore: 0,
        perRepetition: [],
        passed: false,
        summary: "No repetitions to aggregate",
      };
    }

    const scores = reports.map((r) => r.overallScore);
    const mu = scores.reduce((a, b) => a + b, 0) / scores.length;
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);

    // 计算变异系数（Coefficient of Variation）作为稳定性指标
    // CV = sigma / mu，CV 越小表示越稳定
    const variance =
      scores.length > 1
        ? scores.reduce((sum, s) => sum + (s - mu) ** 2, 0) /
          (scores.length - 1) // 样本方差（n-1），对少量重复更准确
        : 0;
    const sigma = Math.sqrt(variance);
    // stabilityScore: (1 - CV) * 100，将变异系数转换为 0-100 的稳定性分数
    const stabilityScore = mu > 0 ? Math.round((1 - sigma / mu) * 100) : 0;

    // 基于均值判定是否通过（而非每次重复都通过）
    const passed = mu >= passThreshold;

    return {
      testCaseId,
      repetitionCount: reports.length,
      overallScore: Math.round(mu),
      // 稳定性分数限制在 0-100 范围内（负 CV 理论上不可能，但安全起见）
      stabilityScore: Math.max(0, Math.min(100, stabilityScore)),
      minScore,
      maxScore,
      perRepetition: reports,
      passed,
      summary: `Score ${Math.round(mu)}/100 (stability: ${stabilityScore}%), range: ${minScore}-${maxScore}. ${passed ? "PASS" : "FAIL"}`,
    };
  }
}
