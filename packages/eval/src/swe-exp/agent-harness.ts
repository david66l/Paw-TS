/**
 * SWE-Exp agent 模式配对 harness
 *
 * - 同 repo/commit/模型/工具/预算
 * - off/on 独立 worktree + session + memory namespace
 * - 唯一变量：on 可读 history memory（无 gold）
 * - 按臂 checkpoint，中断续跑
 * - 官方 harness 评测 resolved（可选延后）
 */

import path from "node:path";

import { closeSql, ping as pingMemoryDb } from "@paw/memory/db";

import type {
  SweExpAgentPair,
  SweExpArmResultExtended,
  SweExpRunManifest,
} from "./agent-types.js";
import { runAgentArm } from "./agent-arm.js";
import {
  isArmCompleted,
  loadArmCheckpoint,
  writeJsonAtomic,
  writeManifest,
} from "./checkpoint.js";
import {
  buildAgentPairs,
  ensureLiteJsonl,
  loadLiteInstances,
  writePairsManifest,
} from "./dataset.js";
import {
  runSwebenchHarness,
  writePredictionsJsonl,
  type SwePrediction,
} from "./evaluate.js";
import {
  armOutcome,
  buildSweExpReport,
  summarizeLifecycleGates,
} from "./report.js";
import type { SweExpPairResult, SweExpReport } from "./types.js";

export interface SweExpAgentRunOptions {
  readonly repoRoot: string;
  /** 复用已有 suite run（续跑） */
  readonly suiteRunId?: string;
  readonly maxPairs?: number;
  readonly maxSteps?: number;
  readonly timeoutMs?: number;
  readonly keep?: boolean;
  readonly modelProvider?: string;
  /** 跳过 Docker harness（只产 patch + 指标） */
  readonly skipHarness?: boolean;
  /** Reuse existing arm checkpoints and run only the external harness. */
  readonly evalOnly?: boolean;
  readonly minSimilarity?: number;
  readonly repos?: readonly string[];
  /** 手工指定 pairs；否则从 Lite 自动构对 */
  readonly pairs?: readonly SweExpAgentPair[];
  readonly now?: () => Date;
  /** Test seam; production defaults to the configured Postgres ping. */
  readonly memoryPreflight?: () => Promise<boolean>;
}

function defaultDirs(repoRoot: string) {
  const base = path.join(repoRoot, "benchmarks", "swe-exp");
  return {
    base,
    cacheDir: base,
    checkpointDir: base,
  };
}

function armToResult(
  arm: "off" | "on",
  cp: ReturnType<typeof loadArmCheckpoint>,
): SweExpArmResultExtended {
  if (cp?.result) return { ...cp.result, memoryOn: arm === "on" };
  return {
    memoryOn: arm === "on",
    resolved: false,
    failureReason: cp?.error ?? "missing_checkpoint",
    resolvedSource: "error",
    warnings: ["missing_or_incomplete_arm"],
  };
}

export async function runSweExpAgent(
  opts: SweExpAgentRunOptions,
): Promise<SweExpReport> {
  const now = opts.now ?? (() => new Date());
  const dirs = defaultDirs(opts.repoRoot);
  const suiteRunId =
    opts.suiteRunId ?? `agent-${now().toISOString().replace(/[:.]/g, "-")}`;
  // Capability-first default: give an unfamiliar repository task enough room
  // to investigate, edit, test and recover. Cost controls remain explicit
  // experiment inputs instead of silently constraining the production path.
  const maxSteps = opts.maxSteps ?? 64;
  const timeoutMs = opts.timeoutMs ?? 25 * 60_000;
  const warnings: string[] = [];

  let pairs: SweExpAgentPair[];
  if (opts.pairs?.length) {
    pairs = [...opts.pairs].slice(0, opts.maxPairs ?? opts.pairs.length);
  } else {
    const jsonl = ensureLiteJsonl(opts.repoRoot);
    const instances = loadLiteInstances(jsonl);
    pairs = buildAgentPairs(instances, {
      maxPairs: opts.maxPairs ?? 5,
      minSimilarity: opts.minSimilarity ?? 0.1,
      repos: opts.repos,
    });
  }

  if (pairs.length === 0) {
    return buildSweExpReport({
      mode: "agent",
      details: [],
      warnings: ["no_pairs"],
    });
  }

  const manifest: SweExpRunManifest = {
    runId: suiteRunId,
    createdAt: now().toISOString(),
    protocol: "swe-exp-pairing",
    mode: "agent",
    modelProvider: opts.modelProvider,
    maxSteps,
    timeoutMs,
    pairs: pairs.map((p) => ({
      pairId: p.id,
      repo: p.repo,
      historyId: p.history.instance_id,
      probeId: p.probe.instance_id,
      probeCommit: p.probe.base_commit,
      similarity: p.similarity,
    })),
  };
  writeManifest(dirs.checkpointDir, manifest);
  writePairsManifest(
    path.join(dirs.base, "runs", suiteRunId, "pairs.json"),
    pairs,
  );

  // A valid paired experiment requires both arms to be runnable. Fail before
  // spending model tokens on the off arm if the on arm's memory store is down.
  const needsMemory = !opts.evalOnly && pairs.some(
    (pair) =>
      !isArmCompleted(dirs.checkpointDir, suiteRunId, pair.id, "on"),
  );
  const memoryAvailable = needsMemory
    ? await (opts.memoryPreflight ?? pingMemoryDb)()
    : true;
  if (needsMemory && !opts.memoryPreflight) {
    try {
      await closeSql();
    } catch {
      /* ignore */
    }
  }
  if (!memoryAvailable) {
    const preflightReport = buildSweExpReport({
      mode: "agent",
      details: [],
      warnings: [
        "preflight_failed: memory database unavailable; no model arms were run",
      ],
      generatedAt: now().toISOString(),
    });
    (preflightReport as SweExpReport & { suiteRunId?: string }).suiteRunId =
      suiteRunId;
    writeJsonAtomic(
      path.join(dirs.base, "runs", suiteRunId, "report.json"),
      preflightReport,
    );
    writeJsonAtomic(path.join(dirs.base, "last-run.json"), preflightReport);
    return preflightReport;
  }

  const predictions: SwePrediction[] = [];
  const pairResults: SweExpPairResult[] = [];

  try {
    for (const pair of pairs) {
      console.error(
        `[swe-exp] pair ${pair.id} (${pair.repo}) sim=${pair.similarity?.toFixed(3) ?? "?"}`,
      );

      for (const arm of ["off", "on"] as const) {
        if (opts.evalOnly) {
          const cp = loadArmCheckpoint(
            dirs.checkpointDir,
            suiteRunId,
            pair.id,
            arm,
          );
          if (!cp?.result) {
            warnings.push(`${pair.id}/${arm}: eval_only_missing_checkpoint`);
          } else {
            console.error(`[swe-exp] eval-only reuse ${pair.id}/${arm}`);
          }
          continue;
        }
        if (isArmCompleted(dirs.checkpointDir, suiteRunId, pair.id, arm)) {
          console.error(`[swe-exp] skip completed arm ${pair.id}/${arm}`);
          continue;
        }
        console.error(`[swe-exp] running ${pair.id}/${arm} …`);
        await runAgentArm({
          suiteRunId,
          pairId: pair.id,
          arm,
          probe: pair.probe,
          history: arm === "on" ? pair.history : undefined,
          cacheDir: dirs.cacheDir,
          checkpointDir: dirs.checkpointDir,
          hostWorkspaceRoot: opts.repoRoot,
          maxSteps,
          timeoutMs,
          keep: opts.keep,
        });
      }

      const offCp = loadArmCheckpoint(
        dirs.checkpointDir,
        suiteRunId,
        pair.id,
        "off",
      );
      const onCp = loadArmCheckpoint(
        dirs.checkpointDir,
        suiteRunId,
        pair.id,
        "on",
      );
      const off = armToResult("off", offCp);
      const on = armToResult("on", onCp);

      for (const [armName, res, probeId] of [
        ["off", off, pair.probe.instance_id],
        ["on", on, pair.probe.instance_id],
      ] as const) {
        if (res.patch?.trim()) {
          predictions.push({
            instance_id: probeId,
            model_name_or_path: `paw-ts-memory-${armName}`,
            model_patch: res.patch,
          });
        }
      }

      pairResults.push({
        pairId: pair.id,
        repo: pair.repo,
        historyId: pair.history.instance_id,
        probeId: pair.probe.instance_id,
        off,
        on,
        outcome: armOutcome(off, on),
      });
    }

    // 写出 predictions（分 arm 文件，避免 instance_id 冲突）
    const predOff = predictions.filter((p) =>
      p.model_name_or_path.endsWith("-off"),
    );
    const predOn = predictions.filter((p) =>
      p.model_name_or_path.endsWith("-on"),
    );
    // 上面 filter 不对——model_name 是 paw-ts-memory-off/on；按推送顺序配对重写
    const offPreds: SwePrediction[] = [];
    const onPreds: SwePrediction[] = [];
    for (const pair of pairs) {
      const offCp = loadArmCheckpoint(
        dirs.checkpointDir,
        suiteRunId,
        pair.id,
        "off",
      );
      const onCp = loadArmCheckpoint(
        dirs.checkpointDir,
        suiteRunId,
        pair.id,
        "on",
      );
      if (offCp?.result?.patch?.trim()) {
        offPreds.push({
          instance_id: pair.probe.instance_id,
          model_name_or_path: "paw-ts-memory-off",
          model_patch: offCp.result.patch,
        });
      }
      if (onCp?.result?.patch?.trim()) {
        onPreds.push({
          instance_id: pair.probe.instance_id,
          model_name_or_path: "paw-ts-memory-on",
          model_patch: onCp.result.patch,
        });
      }
    }
    void predOff;
    void predOn;

    const offPath = path.join(
      dirs.base,
      "runs",
      suiteRunId,
      "preds-off.jsonl",
    );
    const onPath = path.join(dirs.base, "runs", suiteRunId, "preds-on.jsonl");
    writePredictionsJsonl(offPath, offPreds);
    writePredictionsJsonl(onPath, onPreds);

    if (!opts.skipHarness) {
      for (const pair of pairs) {
        const offCp = loadArmCheckpoint(
          dirs.checkpointDir,
          suiteRunId,
          pair.id,
          "off",
        );
        const onCp = loadArmCheckpoint(
          dirs.checkpointDir,
          suiteRunId,
          pair.id,
          "on",
        );
        for (const [arm, cp, predPath] of [
          ["off", offCp, offPath],
          ["on", onCp, onPath],
        ] as const) {
          if (!cp?.result?.patch?.trim()) {
            if (cp?.result) {
              const { saveArmCheckpoint } = await import("./checkpoint.js");
              saveArmCheckpoint(dirs.checkpointDir, suiteRunId, {
                ...cp,
                result: {
                  ...cp.result,
                  resolved: false,
                  resolvedSource: "none",
                  failureReason: cp.result.failureReason ?? "empty_patch",
                },
              });
            }
            continue;
          }
          // 单实例评测：写临时单行 prediction
          const singlePath = path.join(
            dirs.base,
            "runs",
            suiteRunId,
            `pred-${pair.id}-${arm}.jsonl`,
          );
          writePredictionsJsonl(singlePath, [
            {
              instance_id: pair.probe.instance_id,
              model_name_or_path: `paw-ts-memory-${arm}`,
              model_patch: cp.result!.patch!,
            },
          ]);
          console.error(
            `[swe-exp] harness eval ${pair.probe.instance_id} (${arm}) …`,
          );
          const ev = runSwebenchHarness({
            predictionsPath: singlePath,
            instanceIds: [pair.probe.instance_id],
            runId: `${suiteRunId}-${pair.id}-${arm}-${Date.now().toString(36)}`.replace(
              /[^a-zA-Z0-9_-]/g,
              "_",
            ),
            maxWorkers: 1,
            timeoutSec: Math.max(600, Math.floor(timeoutMs / 1000)),
          });
          const { saveArmCheckpoint } = await import("./checkpoint.js");
          if (cp?.result) {
            const updated: typeof cp = {
              ...cp,
              result: {
                ...cp.result,
                resolved: ev.resolved,
                resolvedSource:
                  ev.source === "swebench_harness"
                    ? "swebench_harness"
                    : ev.source,
                failureReason: ev.error
                  ? `${cp.result.failureReason ?? ""} | harness: ${ev.error}`.trim()
                  : cp.result.failureReason,
              },
            };
            saveArmCheckpoint(dirs.checkpointDir, suiteRunId, updated);
            if (ev.error) {
              warnings.push(`${pair.id}/${arm}: ${ev.error.slice(0, 200)}`);
            }
          }
          void predPath;
        }
      }

      // 重建 pairResults with updated resolved
      pairResults.length = 0;
      for (const pair of pairs) {
        const off = armToResult(
          "off",
          loadArmCheckpoint(dirs.checkpointDir, suiteRunId, pair.id, "off"),
        );
        const on = armToResult(
          "on",
          loadArmCheckpoint(dirs.checkpointDir, suiteRunId, pair.id, "on"),
        );
        pairResults.push({
          pairId: pair.id,
          repo: pair.repo,
          historyId: pair.history.instance_id,
          probeId: pair.probe.instance_id,
          off,
          on,
          outcome: armOutcome(off, on),
        });
      }
    } else {
      warnings.push("skip_harness: resolved left false; patches recorded");
    }
  } finally {
    try {
      await closeSql();
    } catch {
      /* ignore */
    }
  }

  const report = buildSweExpReport({
    mode: "agent",
    details: pairResults,
    warnings,
    generatedAt: now().toISOString(),
  });
  // Roll up arm-level lifecycle warnings to suite top-level for visibility
  const life = summarizeLifecycleGates(pairResults);
  for (const [key, n] of [
    ["empty_patch", life.emptyPatchArms],
    ["fake_completed_empty_patch", life.fakeCompletedEmptyPatch],
    ["incomplete_run", life.incompleteRuns],
    ["shell_policy_errors", life.shellPolicyErrors],
  ] as const) {
    if (n > 0 && !warnings.some((w) => w.startsWith(key))) {
      warnings.push(`${key}: ${n}`);
    }
  }
  const reportFinal = buildSweExpReport({
    mode: "agent",
    details: pairResults,
    warnings,
    generatedAt: report.generatedAt,
  });
  // 附加 suiteRunId
  (reportFinal as SweExpReport & { suiteRunId?: string }).suiteRunId =
    suiteRunId;
  writeJsonAtomic(
    path.join(dirs.base, "runs", suiteRunId, "report.json"),
    reportFinal,
  );
  writeJsonAtomic(path.join(dirs.base, "last-run.json"), reportFinal);
  return reportFinal;
}
