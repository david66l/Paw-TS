/**
 * SWE-bench 官方 harness 评测（Docker）+ 预测文件写出
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export function swebenchPythonCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const candidates = [env.SWE_BENCH_PYTHON];
  if (platform === "win32") {
    if (env.CONDA_PREFIX) {
      candidates.push(path.join(env.CONDA_PREFIX, "python.exe"));
    }
    if (env.USERPROFILE) {
      candidates.push(
        path.join(env.USERPROFILE, "miniconda3", "python.exe"),
        path.join(env.USERPROFILE, "anaconda3", "python.exe"),
      );
    }
  }
  candidates.push("python");
  return [
    ...new Set(candidates.filter((value): value is string => Boolean(value))),
  ];
}

export function resolveSwebenchPythonCommand(
  cwd: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
    readonly probe?: (command: string, args: readonly string[]) => boolean;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const probeArgs =
    platform === "win32"
      ? [path.join(cwd, "benchmarks", "swe-exp", "run_harness_lf.py"), "--help"]
      : ["-c", "import swebench.harness.run_evaluation"];
  const probe =
    options.probe ??
    ((command: string, args: readonly string[]) => {
      const result = spawnSync(command, [...args], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
      return result.status === 0 && !result.error;
    });
  const candidates = swebenchPythonCandidates(
    platform,
    options.env ?? process.env,
  );
  for (const candidate of candidates) {
    if (probe(candidate, probeArgs)) return candidate;
  }
  throw new Error(
    `No Python interpreter can import the SWE-bench harness; tried: ${candidates.join(", ")}. Set SWE_BENCH_PYTHON to the verified interpreter.`,
  );
}

export interface SwePrediction {
  readonly instance_id: string;
  readonly model_name_or_path: string;
  readonly model_patch: string;
}

export function writePredictionsJsonl(
  outPath: string,
  preds: readonly SwePrediction[],
): void {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    preds.map((p) => JSON.stringify(p)).join("\n") + (preds.length ? "\n" : ""),
    "utf8",
  );
}

export interface HarnessEvalResult {
  readonly resolved: boolean;
  readonly source: "swebench_harness" | "none" | "error";
  readonly reportPath?: string;
  readonly detail?: string;
  readonly error?: string;
}

export function harnessPythonArgs(
  cwd: string,
  officialArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") {
    return [
      path.join(cwd, "benchmarks", "swe-exp", "run_harness_lf.py"),
      ...officialArgs,
    ];
  }
  return ["-m", "swebench.harness.run_evaluation", ...officialArgs];
}

export function officialHarnessArgs(opts: {
  readonly dataset: string;
  readonly predictionsPath: string;
  readonly runId: string;
  readonly maxWorkers: number;
  readonly instanceIds: readonly string[];
  readonly cacheLevel?: "none" | "base" | "env" | "instance";
  readonly cleanImages?: boolean;
}): string[] {
  const args = [
    "--dataset_name",
    opts.dataset,
    "--predictions_path",
    opts.predictionsPath,
    "--run_id",
    opts.runId,
    "--max_workers",
    String(opts.maxWorkers),
  ];
  if (opts.instanceIds.length >= 1) {
    args.push("--instance_ids", ...opts.instanceIds);
  }
  if (opts.cacheLevel) {
    args.push("--cache_level", opts.cacheLevel);
  }
  if (opts.cleanImages !== undefined) {
    args.push("--clean", String(opts.cleanImages));
  }
  return args;
}

/**
 * 调用官方 swebench harness 评测。
 * Windows：通过 benchmarks/swe-exp/win_shim 注入假 resource 模块（Unix-only）。
 */
export function runSwebenchHarness(opts: {
  readonly predictionsPath: string;
  readonly instanceIds: readonly string[];
  readonly runId: string;
  readonly datasetName?: string;
  readonly maxWorkers?: number;
  readonly timeoutSec?: number;
  readonly cwd?: string;
  /** Retain official image layers needed by a later agent-side verification run. */
  readonly cacheLevel?: "none" | "base" | "env" | "instance";
  readonly cleanImages?: boolean;
}): HarnessEvalResult {
  const dataset = opts.datasetName ?? "princeton-nlp/SWE-bench_Lite";
  const cwd = opts.cwd ?? process.cwd();
  const predAbs = path.isAbsolute(opts.predictionsPath)
    ? opts.predictionsPath
    : path.join(cwd, opts.predictionsPath);

  const officialArgs = officialHarnessArgs({
    dataset,
    predictionsPath: predAbs,
    runId: opts.runId,
    maxWorkers: opts.maxWorkers ?? 1,
    instanceIds: opts.instanceIds,
    cacheLevel: opts.cacheLevel,
    cleanImages: opts.cleanImages,
  });
  const args = harnessPythonArgs(cwd, officialArgs);

  const env = { ...process.env };
  if (process.platform === "win32") {
    const shim = path.join(cwd, "benchmarks", "swe-exp", "win_shim");
    env.PYTHONPATH = env.PYTHONPATH ? `${shim};${env.PYTHONPATH}` : shim;
  }

  let pythonCommand: string;
  try {
    pythonCommand = resolveSwebenchPythonCommand(cwd);
  } catch (error) {
    return {
      resolved: false,
      source: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const r = spawnSync(pythonCommand, args, {
    encoding: "utf8",
    cwd,
    env,
    timeout: (opts.timeoutSec ?? 3600) * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (r.error || r.status !== 0) {
    return {
      resolved: false,
      source: "error",
      error: (
        r.stderr ||
        r.stdout ||
        r.error?.message ||
        `exit ${r.status}`
      ).slice(0, 2000),
      detail: r.stdout?.slice(0, 1000),
    };
  }

  return parseResolvedFromHarnessOutput(
    r.stdout ?? "",
    opts.runId,
    opts.instanceIds[0],
    cwd,
  );
}

export function parseResolvedFromHarnessOutput(
  stdout: string,
  runId: string,
  instanceId: string | undefined,
  cwd: string,
): HarnessEvalResult {
  const rootSummaries = existsSync(cwd)
    ? readdirSync(cwd)
        .filter((name) => name.endsWith(`.${runId}.json`))
        .map((name) => path.join(cwd, name))
    : [];
  const candidates = [
    ...rootSummaries,
    path.join(cwd, `${runId}.json`),
    path.join(cwd, "logs", "run_evaluation", runId, "report.json"),
    path.join(cwd, "logs", runId, "report.json"),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      const report = JSON.parse(readFileSync(c, "utf8")) as Record<
        string,
        unknown
      >;
      return parseHarnessReport(report, instanceId, c);
    } catch {
      /* try next */
    }
  }

  const logRoot = path.join(cwd, "logs", "run_evaluation");
  if (existsSync(logRoot)) {
    for (const name of readdirSync(logRoot)) {
      if (!name.includes(runId) && name !== runId) continue;
      const reportPath = path.join(logRoot, name, "report.json");
      if (!existsSync(reportPath)) continue;
      try {
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<
          string,
          unknown
        >;
        return parseHarnessReport(report, instanceId, reportPath);
      } catch {
        /* continue */
      }
    }
  }

  if (instanceId && stdout.includes(instanceId) && /resolved/i.test(stdout)) {
    const hit = new RegExp(
      `${instanceId}[^\\n]*resolved[^\\n]*(true|yes|1)`,
      "i",
    ).test(stdout);
    return {
      resolved: hit,
      source: "swebench_harness",
      detail: "parsed_from_stdout",
    };
  }

  return {
    resolved: false,
    source: "none",
    detail: "harness finished but report not found",
    error: stdout.slice(0, 1500),
  };
}

function parseHarnessReport(
  report: Record<string, unknown>,
  instanceId: string | undefined,
  reportPath: string,
): HarnessEvalResult {
  const resolvedIds = extractResolvedIds(report);
  const errorIds = extractStringIds(report.error_ids);
  const incompleteIds = extractStringIds(report.incomplete_ids);
  const requestedInstanceErrored = instanceId
    ? errorIds.has(instanceId) || incompleteIds.has(instanceId)
    : errorIds.size > 0 || incompleteIds.size > 0;
  if (requestedInstanceErrored) {
    return {
      resolved: false,
      source: "error",
      reportPath,
      detail: `error_ids=${[...errorIds].join(",")};incomplete_ids=${[
        ...incompleteIds,
      ].join(",")}`,
      error: "official SWE-bench harness did not produce a valid adjudication",
    };
  }
  const ok = instanceId ? resolvedIds.has(instanceId) : resolvedIds.size > 0;
  return {
    resolved: ok,
    source: "swebench_harness",
    reportPath,
    detail: `resolved_ids=${[...resolvedIds].join(",")}`,
  };
}

function extractStringIds(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

function extractResolvedIds(report: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const resolved = report.resolved_ids ?? report.resolved;
  if (Array.isArray(resolved)) {
    for (const id of resolved) out.add(String(id));
  }
  for (const [k, v] of Object.entries(report)) {
    if (k.includes("__") && v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (rec.resolved === true || rec.completed === true) out.add(k);
    }
  }
  return out;
}
