/**
 * Aggregator — combines multiple repetition scores into stability metrics.
 */

import type { ScoreReport, AggregateScoreReport } from "./types.js";

export class Aggregator {
  /**
   * Aggregate multiple repetition scores for the same test case.
   */
  aggregate(
    testCaseId: string,
    reports: ScoreReport[],
    passThreshold: number = 70,
  ): AggregateScoreReport {
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

    // Coefficient of variation (stability)
    const variance =
      scores.length > 1
        ? scores.reduce((sum, s) => sum + (s - mu) ** 2, 0) /
          (scores.length - 1)
        : 0;
    const sigma = Math.sqrt(variance);
    const stabilityScore = mu > 0 ? Math.round((1 - sigma / mu) * 100) : 0;

    const passed = mu >= passThreshold;

    return {
      testCaseId,
      repetitionCount: reports.length,
      overallScore: Math.round(mu),
      stabilityScore: Math.max(0, Math.min(100, stabilityScore)),
      minScore,
      maxScore,
      perRepetition: reports,
      passed,
      summary: `Score ${Math.round(mu)}/100 (stability: ${stabilityScore}%), range: ${minScore}-${maxScore}. ${passed ? "PASS" : "FAIL"}`,
    };
  }
}
