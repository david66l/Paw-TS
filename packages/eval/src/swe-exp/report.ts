/**
 * SWE-Exp 配对报告：核心指标 = 最终测试是否通过（resolved）
 */

import type {
  SweExpArmResult,
  SweExpPairedStats,
  SweExpPairResult,
  SweExpReport,
} from "./types.js";

/** H0: P(win)=0.5 下 P(X≥wins) 单侧（与 MAB 同口径） */
export function binomialSignTestP(wins: number, losses: number): number | null {
  const n = wins + losses;
  if (n === 0) return null;
  let p = 0;
  for (let k = wins; k <= n; k++) {
    p += binomialPmf(n, k);
  }
  return Math.min(1, p);
}

function binomialPmf(n: number, k: number): number {
  return binomialCoef(n, k) * 0.5 ** n;
}

function binomialCoef(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function armOutcome(
  off: SweExpArmResult,
  on: SweExpArmResult,
): "win" | "loss" | "tie" {
  if (on.resolved && !off.resolved) return "win";
  if (off.resolved && !on.resolved) return "loss";
  return "tie";
}

export function summarizeSweExp(
  details: readonly SweExpPairResult[],
): SweExpPairedStats {
  const n = details.length;
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let onPass = 0;
  let offPass = 0;
  for (const d of details) {
    if (d.on.resolved) onPass++;
    if (d.off.resolved) offPass++;
    if (d.outcome === "win") wins++;
    else if (d.outcome === "loss") losses++;
    else ties++;
  }
  const resolveRateOn = n > 0 ? onPass / n : 0;
  const resolveRateOff = n > 0 ? offPass / n : 0;
  const delta = resolveRateOn - resolveRateOff;
  const decisive = wins + losses;
  return {
    nPairs: n,
    wins,
    losses,
    ties,
    resolveRateOff,
    resolveRateOn,
    delta,
    pairedAdvantage: n > 0 ? (wins - losses) / n : null,
    winRateAmongDecisive: decisive > 0 ? wins / decisive : null,
    signTestP: binomialSignTestP(wins, losses),
  };
}

/**
 * 达标（对齐 §11.1 / MAB 收紧口径）：
 * - 至少 1 对
 * - Δ > 0
 * - wins > losses
 */
export function sweExpPassed(stats: SweExpPairedStats): boolean | null {
  if (stats.nPairs === 0) return null;
  return stats.delta > 0 && stats.wins > stats.losses;
}

/** Suite-level TaskLifecycle regression gates (agent mode). */
export interface LifecycleGateSummary {
  readonly totalArms: number;
  readonly emptyPatchArms: number;
  readonly fakeCompletedEmptyPatch: number;
  readonly incompleteRuns: number;
  readonly budgetExhausted: number;
  readonly mutationWithoutTests: number;
  readonly shellPolicyErrors: number;
  readonly codingPhaseErrors: number;
}

function countWarning(
  warnings: readonly string[] | undefined,
  needle: string,
): number {
  if (!warnings?.length) return 0;
  return warnings.filter((w) => w === needle || w.startsWith(`${needle}:`))
    .length;
}

export function summarizeLifecycleGates(
  details: readonly SweExpPairResult[],
): LifecycleGateSummary {
  let totalArms = 0;
  let emptyPatchArms = 0;
  let fakeCompletedEmptyPatch = 0;
  let incompleteRuns = 0;
  let budgetExhausted = 0;
  let mutationWithoutTests = 0;
  let shellPolicyErrors = 0;
  let codingPhaseErrors = 0;

  for (const d of details) {
    for (const arm of [d.off, d.on]) {
      totalArms += 1;
      const w = arm.warnings ?? [];
      emptyPatchArms += countWarning(w, "empty_patch");
      fakeCompletedEmptyPatch += countWarning(w, "fake_completed_empty_patch");
      incompleteRuns += countWarning(w, "incomplete_run");
      budgetExhausted += countWarning(w, "budget_exhausted");
      mutationWithoutTests += countWarning(w, "mutation_without_passing_tests");
      for (const item of w) {
        if (item.startsWith("shell_policy_errors:")) {
          const n = Number(item.split(":")[1] ?? "0");
          shellPolicyErrors += Number.isFinite(n) ? n : 1;
        }
        if (item.startsWith("coding_phase_errors:")) {
          const n = Number(item.split(":")[1] ?? "0");
          codingPhaseErrors += Number.isFinite(n) ? n : 1;
        }
      }
    }
  }

  return {
    totalArms,
    emptyPatchArms,
    fakeCompletedEmptyPatch,
    incompleteRuns,
    budgetExhausted,
    mutationWithoutTests,
    shellPolicyErrors,
    codingPhaseErrors,
  };
}

/**
 * Lifecycle regression gate: forbid fake completed+empty patch and shell
 * policy error storms. Incomplete / empty_patch alone do not fail the gate
 * (those are expected while the agent is still learning).
 */
export function lifecycleGatesOk(summary: LifecycleGateSummary): boolean {
  if (summary.fakeCompletedEmptyPatch > 0) return false;
  if (summary.totalArms > 0 && summary.shellPolicyErrors > summary.totalArms) {
    return false;
  }
  return true;
}

export function buildSweExpReport(opts: {
  mode: SweExpReport["mode"];
  details: readonly SweExpPairResult[];
  warnings?: string[];
  generatedAt?: string;
}): SweExpReport {
  const paired = summarizeSweExp(opts.details);
  const lifecycle = summarizeLifecycleGates(opts.details);
  const memoryPassed = sweExpPassed(paired);
  const lifecycleOk = lifecycleGatesOk(lifecycle);
  const warnings = [...(opts.warnings ?? [])];
  if (!lifecycleOk) {
    warnings.push(
      `lifecycle_gate_failed: fake_completed=${lifecycle.fakeCompletedEmptyPatch} shell_policy=${lifecycle.shellPolicyErrors}`,
    );
  }
  // Agent mode: memory Δ still primary; lifecycle gate can force not-passed.
  const passed =
    opts.mode === "agent" && !lifecycleOk
      ? false
      : memoryPassed === true && lifecycleOk
        ? true
        : memoryPassed === false
          ? false
          : memoryPassed;

  return {
    suite: "swe-exp",
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    protocol: "swe-exp-pairing",
    mode: opts.mode,
    passed,
    paired,
    details: opts.details,
    warnings,
    metrics: {
      delta: paired.delta,
      resolveRateOn: paired.resolveRateOn,
      resolveRateOff: paired.resolveRateOff,
      wins: paired.wins,
      losses: paired.losses,
      ties: paired.ties,
      signTestP: paired.signTestP,
      nPairs: paired.nPairs,
      lifecycle,
    },
  };
}

export function renderSweExpReport(report: SweExpReport): string {
  const p = report.paired;
  const lines = [
    `SWE-Exp pairing (${report.mode})`,
    `passed: ${report.passed}`,
    `pairs: ${p.nPairs}  Δ(resolve): ${fmt(p.delta)}  on=${fmt(p.resolveRateOn)} off=${fmt(p.resolveRateOff)}`,
    `paired w/l/t: ${p.wins}/${p.losses}/${p.ties}  signTestP=${p.signTestP ?? "n/a"}`,
  ];
  const life = (
    report.metrics as { lifecycle?: LifecycleGateSummary }
  ).lifecycle;
  if (life) {
    lines.push(
      `lifecycle: arms=${life.totalArms} empty_patch=${life.emptyPatchArms} fake_completed=${life.fakeCompletedEmptyPatch} incomplete=${life.incompleteRuns} shell_policy=${life.shellPolicyErrors}`,
    );
  }
  if (report.warnings.length) {
    lines.push(`warnings: ${report.warnings.join("; ")}`);
  }
  for (const d of report.details) {
    lines.push(
      `  ${d.pairId}: off=${d.off.resolved ? "pass" : "fail"} on=${d.on.resolved ? "pass" : "fail"} → ${d.outcome}`,
    );
  }
  return lines.join("\n");
}

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}
