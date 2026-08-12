import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { createDefaultLanguageModel } from "@paw/models";

import { writeJsonAtomic } from "../swe-exp/checkpoint.js";
import { defaultLiteJsonl, loadLiteInstances } from "../swe-exp/dataset.js";
import { buildSweCompareGoal } from "./goal.js";
import type {
  SweCompareInstanceManifest,
  SweCompareManifest,
} from "./types.js";

export const SWE_COMPARE_SMOKE_IDS = [
  "django__django-11019",
  "scikit-learn__scikit-learn-25638",
  "sympy__sympy-20049",
  "pallets__flask-5063",
  "pylint-dev__pylint-7228",
] as const;

export const SWE_COMPARE_SEEN_EXCLUSIONS = [
  "sphinx-doc__sphinx-8282",
  "sphinx-doc__sphinx-8435",
  "sphinx-doc__sphinx-8721",
  "sphinx-doc__sphinx-11445",
  "sphinx-doc__sphinx-8801",
  "pydata__xarray-4493",
  "matplotlib__matplotlib-25332",
] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandText(
  command: string,
  args: readonly string[],
  cwd: string,
): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? result.stdout ?? result.status}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function gitDirty(repoRoot: string): boolean {
  return commandText("git", ["status", "--porcelain"], repoRoot).length > 0;
}

export function findLocalTrajectoryHits(
  repoRoot: string,
  instanceId: string,
): string[] {
  const roots = ["benchmarks", ".paw"].filter((candidate) =>
    existsSync(path.join(repoRoot, candidate)),
  );
  if (roots.length === 0) return [];
  const result = spawnSync(
    "rg",
    ["-l", "--fixed-strings", instanceId, ...roots],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    },
  );
  if (result.status === 1) return [];
  if (result.error || result.status !== 0) {
    throw new Error(
      `history scan failed for ${instanceId}: ${result.error?.message ?? result.stderr ?? result.status}`,
    );
  }
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\\/g, "/"))
    .filter((line) => line !== "benchmarks/swe-bench/swe-bench-lite.jsonl")
    .filter((line) => !line.startsWith("benchmarks/swe-compare/manifests/"))
    .filter((line) => !line.startsWith("benchmarks/swe-compare/preflight/"))
    .filter((line) => !line.startsWith("benchmarks/swe-compare/runs/"))
    .filter((line) => !line.startsWith(".paw/code-index/"))
    .sort();
}

function dockerServerVersion(repoRoot: string): string | undefined {
  try {
    return commandText(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      repoRoot,
    );
  } catch {
    return undefined;
  }
}

export function createSweCompareManifest(opts: {
  readonly repoRoot: string;
  readonly datasetPath?: string;
  readonly instanceIds?: readonly string[];
  readonly now?: () => Date;
}): SweCompareManifest {
  const datasetPath = opts.datasetPath ?? defaultLiteJsonl(opts.repoRoot);
  const instances = loadLiteInstances(datasetPath);
  const byId = new Map(
    instances.map((instance) => [instance.instance_id, instance]),
  );
  const ids = [...(opts.instanceIds ?? SWE_COMPARE_SMOKE_IDS)];
  if (new Set(ids).size !== ids.length) {
    throw new Error("duplicate instance id in SWE compare selection");
  }
  const selected: SweCompareInstanceManifest[] = ids.map((instanceId) => {
    const instance = byId.get(instanceId);
    if (!instance)
      throw new Error(`SWE-bench instance not found: ${instanceId}`);
    const hits = findLocalTrajectoryHits(opts.repoRoot, instanceId);
    if (hits.length > 0) {
      throw new Error(
        `instance ${instanceId} has prior local trajectory hits: ${hits.join(", ")}`,
      );
    }
    const failToPassCount = instance.FAIL_TO_PASS?.length ?? 0;
    const passToPassCount = instance.PASS_TO_PASS?.length ?? 0;
    if (failToPassCount < 1 || passToPassCount < 5) {
      throw new Error(
        `instance ${instanceId} fails metadata gate: FAIL_TO_PASS=${failToPassCount}, PASS_TO_PASS=${passToPassCount}`,
      );
    }
    return {
      instanceId,
      repo: instance.repo,
      baseCommit: instance.base_commit,
      failToPassCount,
      passToPassCount,
      problemStatementSha256: sha256(instance.problem_statement),
      goalSha256: sha256(buildSweCompareGoal(instance)),
      localHistoryHits: hits,
      qualification: "static_qualified",
    };
  });
  if (
    new Set(selected.map((instance) => instance.repo)).size !== selected.length
  ) {
    throw new Error(
      "smoke selection must use at most one instance per repository",
    );
  }
  const model = createDefaultLanguageModel(opts.repoRoot);
  if (!model.runtimeProfile) {
    throw new Error("Paw model does not expose a runtime profile");
  }
  if (
    model.runtimeProfile.model !== "deepseek-v4-flash" ||
    model.runtimeProfile.thinkingEnabled !== true ||
    model.runtimeProfile.reasoningEffort !== "max"
  ) {
    throw new Error(
      `Paw fairness profile mismatch: ${JSON.stringify(model.runtimeProfile)}`,
    );
  }
  const datasetBuffer = readFileSync(datasetPath);
  const dockerVersion = dockerServerVersion(opts.repoRoot);
  return {
    schemaVersion: 1,
    protocol: "paw-vs-claude-public-swe",
    createdAt: (opts.now ?? (() => new Date()))().toISOString(),
    dataset: {
      name: "princeton-nlp/SWE-bench_Lite",
      split: "test",
      localPath: path.relative(opts.repoRoot, datasetPath).replace(/\\/g, "/"),
      rowCount: instances.length,
      sha256: sha256(datasetBuffer),
    },
    selection: {
      ruleVersion: "smoke-v1",
      purpose: "engineering_smoke_not_headline_score",
      ids,
      excludedSeenIds: SWE_COMPARE_SEEN_EXCLUSIONS,
    },
    sourceTree: {
      gitCommit: commandText("git", ["rev-parse", "HEAD"], opts.repoRoot),
      gitDirty: gitDirty(opts.repoRoot),
    },
    environment: {
      platform: process.platform,
      ...(dockerVersion ? { dockerServerVersion: dockerVersion } : {}),
    },
    budget: {
      pawMaxSteps: 64,
      sharedTimeoutMs: 1_500_000,
      codingPhaseBudget: false,
    },
    runners: {
      paw: { memory: "off", runtimeProfile: model.runtimeProfile },
      claudeCode: {
        version: commandText("claude", ["--version"], opts.repoRoot),
        mode: "bare",
        model: "deepseek-v4-flash[1m]",
        effort: "max",
        autocompact: "1m",
        sessionPersistence: false,
      },
    },
    instances: selected,
  };
}

export function writeSweCompareManifest(
  repoRoot: string,
  manifest: SweCompareManifest,
  fileName = "smoke-v1.json",
): string {
  const out = path.join(
    repoRoot,
    "benchmarks",
    "swe-compare",
    "manifests",
    fileName,
  );
  writeJsonAtomic(out, manifest);
  return out;
}
