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

export const SWE_COMPARE_FORMAL_DEV_IDS = [
  "django__django-11019",
  "scikit-learn__scikit-learn-25638",
  "sympy__sympy-20049",
  "pylint-dev__pylint-7228",
  "astropy__astropy-12907",
] as const;

export const SWE_COMPARE_SEEN_EXCLUSIONS = [
  "sphinx-doc__sphinx-8282",
  "sphinx-doc__sphinx-8435",
  "sphinx-doc__sphinx-8721",
  "sphinx-doc__sphinx-11445",
  "sphinx-doc__sphinx-8801",
  "pydata__xarray-4493",
  "matplotlib__matplotlib-25332",
  // Engineering smoke only: Paw saw this before the paired runner baseline.
  "pallets__flask-5063",
] as const;

/**
 * Cross-repository tasks already exposed to Paw during engineering.
 * Diagnostic only: never count these as unseen holdout or headline score.
 */
export const PAW_SEEN_DEVELOPMENT_IDS = [
  "django__django-11019",
  "scikit-learn__scikit-learn-25638",
  "sympy__sympy-20049",
  "pylint-dev__pylint-7228",
  "astropy__astropy-12907",
  "pallets__flask-5063",
  "pydata__xarray-4493",
  "matplotlib__matplotlib-25332",
] as const;

export const PAW_FRESH_DEVELOPMENT_RULE = {
  version: "paw-fresh-dev-v2" as const,
  seed: "paw-fresh-dev-v2",
  count: 5,
  minFailToPass: 1,
  maxFailToPass: 20,
  minPassToPass: 5,
  maxPassToPass: 500,
} as const;

/** Frozen output of the v2 rule; these became seen after their single runs. */
export const PAW_FRESH_V2_IDS = [
  "django__django-13028",
  "pytest-dev__pytest-5692",
  "sphinx-doc__sphinx-8627",
  "astropy__astropy-14995",
  "sympy__sympy-21614",
] as const;

const PAW_PRE_V2_EXPOSED_IDS: readonly string[] = [
  ...new Set([...SWE_COMPARE_SEEN_EXCLUSIONS, ...PAW_SEEN_DEVELOPMENT_IDS]),
];

export const PAW_KNOWN_EXPOSED_IDS: readonly string[] = [
  ...new Set([...PAW_PRE_V2_EXPOSED_IDS, ...PAW_FRESH_V2_IDS]),
];

export const PAW_FRESH_QUALIFICATION_RULE = {
  version: "paw-fresh-qualification-v3" as const,
  seed: "paw-fresh-qualification-v3",
  count: 5,
  minFailToPass: 2,
  maxFailToPass: 20,
  minPassToPass: 20,
  maxPassToPass: 500,
  pawMaxSteps: 96,
  sharedTimeoutMs: 2_700_000,
  verificationAuthority: "local" as const,
  verificationEnvironment: "instance_image" as const,
} as const;

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
    .filter((line) => line !== "benchmarks/swe-compare/README.md")
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
  readonly mode?: "formal-paired" | "paw-seen-development";
  readonly pawDevelopmentRuleVersion?:
    | "paw-seen-dev-v1"
    | "paw-fresh-dev-v2"
    | "paw-fresh-qualification-v3";
  readonly excludedSeenIds?: readonly string[];
  readonly pawMaxSteps?: number;
  readonly sharedTimeoutMs?: number;
  readonly verificationAuthority?: "local" | "external";
  readonly verificationEnvironment?: "host" | "instance_image";
}): SweCompareManifest {
  const pawSeenDevelopment = opts.mode === "paw-seen-development";
  const datasetPath = opts.datasetPath ?? defaultLiteJsonl(opts.repoRoot);
  const instances = loadLiteInstances(datasetPath);
  const byId = new Map(
    instances.map((instance) => [instance.instance_id, instance]),
  );
  const ids = [...(opts.instanceIds ?? SWE_COMPARE_FORMAL_DEV_IDS)];
  if (new Set(ids).size !== ids.length) {
    throw new Error("duplicate instance id in SWE compare selection");
  }
  const selected: SweCompareInstanceManifest[] = ids.map((instanceId) => {
    const instance = byId.get(instanceId);
    if (!instance)
      throw new Error(`SWE-bench instance not found: ${instanceId}`);
    const hits = findLocalTrajectoryHits(opts.repoRoot, instanceId);
    if (hits.length > 0 && !pawSeenDevelopment) {
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
      "formal dev selection must use at most one instance per repository",
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
    protocol: pawSeenDevelopment
      ? "paw-only-seen-development"
      : "paw-vs-claude-public-swe",
    createdAt: (opts.now ?? (() => new Date()))().toISOString(),
    dataset: {
      name: "princeton-nlp/SWE-bench_Lite",
      split: "test",
      localPath: path.relative(opts.repoRoot, datasetPath).replace(/\\/g, "/"),
      rowCount: instances.length,
      sha256: sha256(datasetBuffer),
    },
    selection: {
      ruleVersion: pawSeenDevelopment
        ? (opts.pawDevelopmentRuleVersion ?? "paw-seen-dev-v1")
        : "formal-dev-v1",
      purpose: pawSeenDevelopment
        ? "paw_only_seen_architecture_diagnostic_not_holdout_or_headline_score"
        : "frozen_paired_dev_diagnostic_not_headline_score",
      ids,
      excludedSeenIds: pawSeenDevelopment
        ? (opts.excludedSeenIds ?? [])
        : SWE_COMPARE_SEEN_EXCLUSIONS,
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
      pawMaxSteps: opts.pawMaxSteps ?? 64,
      sharedTimeoutMs: opts.sharedTimeoutMs ?? 1_500_000,
      codingPhaseBudget: false,
    },
    runners: {
      paw: {
        memory: "off",
        verificationAuthority: opts.verificationAuthority ?? "external",
        verificationEnvironment: opts.verificationEnvironment ?? "host",
        runtimeProfile: model.runtimeProfile,
      },
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

export function createPawSeenDevelopmentManifest(opts: {
  readonly repoRoot: string;
  readonly datasetPath?: string;
  readonly now?: () => Date;
}): SweCompareManifest {
  return createSweCompareManifest({
    ...opts,
    instanceIds: PAW_SEEN_DEVELOPMENT_IDS,
    mode: "paw-seen-development",
  });
}

/**
 * Freeze fresh Paw-only development tasks without reading their problem text
 * or gold patches for selection. A salted hash makes ordering deterministic;
 * the metadata bounds keep the official verifier operationally feasible.
 */
export function selectPawFreshDevelopmentIds(opts: {
  readonly repoRoot: string;
  readonly datasetPath?: string;
}): string[] {
  return selectPawFreshIds({
    ...opts,
    excludedIds: PAW_PRE_V2_EXPOSED_IDS,
    rule: PAW_FRESH_DEVELOPMENT_RULE,
  });
}

interface PawFreshSelectionRule {
  readonly version: string;
  readonly seed: string;
  readonly count: number;
  readonly minFailToPass: number;
  readonly maxFailToPass: number;
  readonly minPassToPass: number;
  readonly maxPassToPass: number;
}

function selectPawFreshIds(opts: {
  readonly repoRoot: string;
  readonly datasetPath?: string;
  readonly excludedIds: readonly string[];
  readonly rule: PawFreshSelectionRule;
}): string[] {
  const datasetPath = opts.datasetPath ?? defaultLiteJsonl(opts.repoRoot);
  const knownIds = new Set(opts.excludedIds);
  const rule = opts.rule;
  const candidates = loadLiteInstances(datasetPath)
    .filter((instance) => {
      const failToPass = instance.FAIL_TO_PASS?.length ?? 0;
      const passToPass = instance.PASS_TO_PASS?.length ?? 0;
      return (
        !knownIds.has(instance.instance_id) &&
        failToPass >= rule.minFailToPass &&
        failToPass <= rule.maxFailToPass &&
        passToPass >= rule.minPassToPass &&
        passToPass <= rule.maxPassToPass
      );
    })
    .map((instance) => ({
      instance,
      rank: sha256(`${rule.seed}\0${instance.instance_id}`),
    }))
    .sort(
      (a, b) =>
        a.rank.localeCompare(b.rank) ||
        a.instance.instance_id.localeCompare(b.instance.instance_id),
    );
  const selected: string[] = [];
  const selectedRepos = new Set<string>();
  for (const { instance } of candidates) {
    if (selectedRepos.has(instance.repo)) continue;
    if (findLocalTrajectoryHits(opts.repoRoot, instance.instance_id).length > 0)
      continue;
    selected.push(instance.instance_id);
    selectedRepos.add(instance.repo);
    if (selected.length === rule.count) return selected;
  }
  throw new Error(
    `only ${selected.length}/${rule.count} fresh cross-repository SWE-bench tasks satisfy ${rule.version}`,
  );
}

export function selectPawFreshQualificationIds(opts: {
  readonly repoRoot: string;
  readonly datasetPath?: string;
}): string[] {
  return selectPawFreshIds({
    ...opts,
    excludedIds: PAW_KNOWN_EXPOSED_IDS,
    rule: PAW_FRESH_QUALIFICATION_RULE,
  });
}

export function createPawFreshDevelopmentManifest(opts: {
  readonly repoRoot: string;
  readonly datasetPath?: string;
  readonly now?: () => Date;
}): SweCompareManifest {
  return createSweCompareManifest({
    ...opts,
    instanceIds: selectPawFreshDevelopmentIds(opts),
    mode: "paw-seen-development",
    pawDevelopmentRuleVersion: PAW_FRESH_DEVELOPMENT_RULE.version,
    excludedSeenIds: PAW_PRE_V2_EXPOSED_IDS,
  });
}

export function createPawFreshQualificationManifest(opts: {
  readonly repoRoot: string;
  readonly datasetPath?: string;
  readonly now?: () => Date;
}): SweCompareManifest {
  const rule = PAW_FRESH_QUALIFICATION_RULE;
  return createSweCompareManifest({
    ...opts,
    instanceIds: selectPawFreshQualificationIds(opts),
    mode: "paw-seen-development",
    pawDevelopmentRuleVersion: rule.version,
    excludedSeenIds: PAW_KNOWN_EXPOSED_IDS,
    pawMaxSteps: rule.pawMaxSteps,
    sharedTimeoutMs: rule.sharedTimeoutMs,
    verificationAuthority: rule.verificationAuthority,
    verificationEnvironment: rule.verificationEnvironment,
  });
}

export function writeSweCompareManifest(
  repoRoot: string,
  manifest: SweCompareManifest,
  fileName = "formal-dev-v1.json",
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
