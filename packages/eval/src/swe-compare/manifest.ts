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

/** Superseded before any model run when the user expanded the batch to ten. */
export const PAW_FRESH_QUALIFICATION_V3_RULE = {
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

/** Infeasible on Lite: only nine unseen repositories satisfy the strict tier. */
export const PAW_FRESH_QUALIFICATION_V4_RULE = {
  ...PAW_FRESH_QUALIFICATION_V3_RULE,
  version: "paw-fresh-qualification-v4" as const,
  // Keep the committed v3 rank so the five extra tasks extend the prefix;
  // no result, task prose, or model trajectory participates in selection.
  seed: PAW_FRESH_QUALIFICATION_V3_RULE.seed,
  count: 10,
} as const;

/** First ten-task contract; its only model-run sample is now a diagnostic. */
export const PAW_FRESH_QUALIFICATION_V5_RULE = {
  ...PAW_FRESH_QUALIFICATION_V4_RULE,
  version: "paw-fresh-qualification-v5" as const,
  fallbackMinFailToPass: 1,
} as const;

/** v5 samples that received a Paw model trajectory and are no longer unseen. */
export const PAW_FRESH_QUALIFICATION_V5_RUN_IDS = [
  "sympy__sympy-14024",
] as const;

const PAW_QUALIFICATION_EXPOSED_IDS: readonly string[] = [
  ...new Set([...PAW_KNOWN_EXPOSED_IDS, ...PAW_FRESH_QUALIFICATION_V5_RUN_IDS]),
];

/** First post-fix ten-task contract; Requests ended without a grader verdict. */
export const PAW_FRESH_QUALIFICATION_V6_RULE = {
  ...PAW_FRESH_QUALIFICATION_V5_RULE,
  version: "paw-fresh-qualification-v6" as const,
} as const;

/** v6 samples that received a Paw model trajectory and are no longer unseen. */
export const PAW_FRESH_QUALIFICATION_V6_RUN_IDS = [
  "psf__requests-2317",
] as const;

const PAW_QUALIFICATION_V7_EXPOSED_IDS: readonly string[] = [
  ...new Set([
    ...PAW_QUALIFICATION_EXPOSED_IDS,
    ...PAW_FRESH_QUALIFICATION_V6_RUN_IDS,
  ]),
];

/** First contract excluding externally networked Requests tests. */
export const PAW_FRESH_QUALIFICATION_V7_RULE = {
  ...PAW_FRESH_QUALIFICATION_V6_RULE,
  version: "paw-fresh-qualification-v7" as const,
  excludedRepos: ["psf/requests"] as const,
} as const;

/** v7 samples that received a Paw model trajectory and are no longer unseen. */
export const PAW_FRESH_QUALIFICATION_V7_RUN_IDS = [
  "django__django-11001",
  "scikit-learn__scikit-learn-15535",
  "sympy__sympy-20154",
] as const;

const PAW_QUALIFICATION_V8_EXPOSED_IDS: readonly string[] = [
  ...new Set([
    ...PAW_QUALIFICATION_V7_EXPOSED_IDS,
    ...PAW_FRESH_QUALIFICATION_V7_RUN_IDS,
  ]),
];

/** First contract after the three-sample v7 diagnostic. */
export const PAW_FRESH_QUALIFICATION_V8_RULE = {
  ...PAW_FRESH_QUALIFICATION_V7_RULE,
  version: "paw-fresh-qualification-v8" as const,
} as const;

/** v8 samples that received a Paw model trajectory and are no longer unseen. */
export const PAW_FRESH_QUALIFICATION_V8_RUN_IDS = [
  "django__django-16820",
  "scikit-learn__scikit-learn-14092",
] as const;

const PAW_QUALIFICATION_V9_EXPOSED_IDS: readonly string[] = [
  ...new Set([
    ...PAW_QUALIFICATION_V8_EXPOSED_IDS,
    ...PAW_FRESH_QUALIFICATION_V8_RUN_IDS,
  ]),
];

/** Ten unseen tasks after the two-sample v8 diagnostic. */
export const PAW_FRESH_QUALIFICATION_V9_RULE = {
  ...PAW_FRESH_QUALIFICATION_V8_RULE,
  version: "paw-fresh-qualification-v9" as const,
} as const;

/** v9 samples that received a Paw trajectory, including one user interruption. */
export const PAW_FRESH_QUALIFICATION_V9_RUN_IDS = [
  "django__django-16379",
  "sympy__sympy-20639",
  "matplotlib__matplotlib-22711",
] as const;

const PAW_QUALIFICATION_V10_EXPOSED_IDS: readonly string[] = [
  ...new Set([
    ...PAW_QUALIFICATION_V9_EXPOSED_IDS,
    ...PAW_FRESH_QUALIFICATION_V9_RUN_IDS,
  ]),
];

/** First contract after the interrupted v9 diagnostic. */
export const PAW_FRESH_QUALIFICATION_V10_RULE = {
  ...PAW_FRESH_QUALIFICATION_V9_RULE,
  version: "paw-fresh-qualification-v10" as const,
} as const;

/** v10 samples that received a Paw trajectory and are no longer unseen. */
export const PAW_FRESH_QUALIFICATION_V10_RUN_IDS = [
  "django__django-15738",
] as const;

const PAW_QUALIFICATION_V11_EXPOSED_IDS: readonly string[] = [
  ...new Set([
    ...PAW_QUALIFICATION_V10_EXPOSED_IDS,
    ...PAW_FRESH_QUALIFICATION_V10_RUN_IDS,
  ]),
];

/** Frozen v11 contract; retained so its manifest identity never changes. */
export const PAW_FRESH_QUALIFICATION_V11_RULE = {
  ...PAW_FRESH_QUALIFICATION_V10_RULE,
  version: "paw-fresh-qualification-v11" as const,
} as const;

/** Every task frozen into v11 is exposed, even if no model trajectory ran. */
export const PAW_FRESH_QUALIFICATION_V11_IDS = [
  "django__django-14155",
  "pytest-dev__pytest-7490",
  "sympy__sympy-17139",
  "pydata__xarray-5131",
  "scikit-learn__scikit-learn-14983",
  "matplotlib__matplotlib-23562",
  "sphinx-doc__sphinx-10451",
  "pallets__flask-4045",
  "pylint-dev__pylint-7080",
  "mwaskom__seaborn-3407",
] as const;

const PAW_QUALIFICATION_V12_EXPOSED_IDS: readonly string[] = [
  ...new Set([
    ...PAW_QUALIFICATION_V11_EXPOSED_IDS,
    ...PAW_FRESH_QUALIFICATION_V11_IDS,
  ]),
];

/** Frozen v12 contract; one valid run and one interrupted diagnostic exist. */
export const PAW_FRESH_QUALIFICATION_V12_RULE = {
  ...PAW_FRESH_QUALIFICATION_V11_RULE,
  version: "paw-fresh-qualification-v12" as const,
} as const;

/** Every task frozen into v12 is exposed, including the eight not executed. */
export const PAW_FRESH_QUALIFICATION_V12_IDS = [
  "django__django-13551",
  "sympy__sympy-16281",
  "scikit-learn__scikit-learn-11281",
  "pytest-dev__pytest-5495",
  "pydata__xarray-3364",
  "matplotlib__matplotlib-23913",
  "sphinx-doc__sphinx-8474",
  "pylint-dev__pylint-7114",
  "mwaskom__seaborn-3190",
  "astropy__astropy-7746",
] as const;

const PAW_QUALIFICATION_V13_EXPOSED_IDS: readonly string[] = [
  ...new Set([
    ...PAW_QUALIFICATION_V12_EXPOSED_IDS,
    ...PAW_FRESH_QUALIFICATION_V12_IDS,
  ]),
];

/** Infeasible after every v12 frozen ID was excluded: only seven repositories. */
export const PAW_FRESH_QUALIFICATION_V13_RULE = {
  ...PAW_FRESH_QUALIFICATION_V12_RULE,
  version: "paw-fresh-qualification-v13" as const,
} as const;

/** Frozen v14 contract with a metadata-only regression-suite-size fallback. */
export const PAW_FRESH_QUALIFICATION_V14_RULE = {
  ...PAW_FRESH_QUALIFICATION_V13_RULE,
  version: "paw-fresh-qualification-v14" as const,
  fallbackMinPassToPass: 10,
} as const;

/** Every task frozen into v14 is exposed, including the nine not executed. */
export const PAW_FRESH_QUALIFICATION_V14_IDS = [
  "django__django-14997",
  "sympy__sympy-14308",
  "scikit-learn__scikit-learn-13142",
  "pytest-dev__pytest-6116",
  "matplotlib__matplotlib-23987",
  "sphinx-doc__sphinx-7738",
  "mwaskom__seaborn-2848",
  "astropy__astropy-6938",
  "pylint-dev__pylint-7993",
  "pallets__flask-4992",
] as const;

const PAW_QUALIFICATION_V15_EXPOSED_IDS: readonly string[] = [
  ...new Set([
    ...PAW_QUALIFICATION_V13_EXPOSED_IDS,
    ...PAW_FRESH_QUALIFICATION_V14_IDS,
  ]),
];

/** Current contract moved to the larger official Verified public pool. */
export const PAW_FRESH_QUALIFICATION_RULE = {
  ...PAW_FRESH_QUALIFICATION_V14_RULE,
  version: "paw-fresh-qualification-v15" as const,
  seed: "paw-fresh-qualification-v15-verified",
} as const;

/**
 * Fixed replay set requested for architecture debugging. These tasks are all
 * exposed and must never be reported as fresh qualification/headline score.
 * External verification is authoritative because the base checkout does not
 * contain the official test patch whose changed expectations define F2P.
 */
export const PAW_FIXED_TEN_DIAGNOSTIC_RULE = {
  version: "paw-fixed-ten-diagnostic-v1" as const,
  ids: [
    "django__django-15098",
    "pydata__xarray-4966",
    "pytest-dev__pytest-7521",
    "scikit-learn__scikit-learn-25102",
    "sympy__sympy-20438",
    "sphinx-doc__sphinx-9461",
    "matplotlib__matplotlib-21568",
    "astropy__astropy-13977",
    "pylint-dev__pylint-6528",
    "mwaskom__seaborn-3069",
  ] as const,
  pawMaxSteps: 96,
  sharedTimeoutMs: 2_700_000,
  verificationAuthority: "external" as const,
  verificationEnvironment: "instance_image" as const,
  dataset: {
    name: "SWE-bench/SWE-bench_Verified" as const,
    split: "test" as const,
    sha256: "39e72d0da80f692b283386d46f55afaaf28a6c83eda7c011a44c730b97379ff4",
  },
  preflightSource: {
    ruleVersion: "paw-fresh-qualification-v15" as const,
    purpose:
      "paw_only_seen_architecture_diagnostic_not_holdout_or_headline_score" as const,
    manifestSha256:
      "9071c42fb442f846d56dd6ebef3ad84fc234eb5ff9cc5d2f0d0a56a643d09928",
    preflightBundleSha256:
      "bb1843a130388e8e445bc6092abb1637bd4fcfa3c88855beea216175f2dacb1d",
  },
} as const;

export function isEligibleOfficialPreflight(
  instance: SweCompareInstanceManifest,
): boolean {
  const preflight = instance.preflight;
  return (
    instance.qualification === "eligible" &&
    preflight?.completed === true &&
    preflight.source === "swebench_harness" &&
    preflight.baselineResolved === false &&
    preflight.emptyPatch === false &&
    preflight.harnessError === false &&
    !preflight.error
  );
}

function hasExactUniqueInstanceIds(
  manifest: SweCompareManifest,
  expected: readonly string[],
): boolean {
  const actual = manifest.instances.map((instance) => instance.instanceId);
  return (
    new Set(actual).size === actual.length &&
    JSON.stringify(actual) === JSON.stringify(expected)
  );
}

export function pawFixedTenPreflightBundleSha256(
  manifest: SweCompareManifest,
): string {
  return sha256(
    JSON.stringify(
      manifest.instances.map(
        ({
          instanceId,
          repo,
          baseCommit,
          failToPassCount,
          passToPassCount,
          problemStatementSha256,
          goalSha256,
          qualification,
          preflight,
        }) => ({
          instanceId,
          repo,
          baseCommit,
          failToPassCount,
          passToPassCount,
          problemStatementSha256,
          goalSha256,
          qualification,
          preflight,
        }),
      ),
    ),
  );
}

/**
 * Reuse only the already-paid official v15 preflight facts. The ignored JSON
 * is data, not authority: its exact bytes and every per-instance identity are
 * bound to tracked constants/current Verified metadata before reuse.
 */
export function reusePawFixedTenDiagnosticPreflights(input: {
  readonly sourceBytes: string | Buffer;
  readonly fresh: SweCompareManifest;
}): SweCompareManifest {
  const rule = PAW_FIXED_TEN_DIAGNOSTIC_RULE;
  if (sha256(input.sourceBytes) !== rule.preflightSource.manifestSha256) {
    throw new Error("fixed-ten preflight source bytes are not frozen v15");
  }
  let source: SweCompareManifest;
  try {
    source = JSON.parse(input.sourceBytes.toString()) as SweCompareManifest;
  } catch {
    throw new Error("fixed-ten preflight source is not valid JSON");
  }
  if (
    source.selection.ruleVersion !== rule.preflightSource.ruleVersion ||
    source.selection.purpose !== rule.preflightSource.purpose ||
    JSON.stringify(source.selection.ids) !== JSON.stringify(rule.ids) ||
    !hasExactUniqueInstanceIds(source, rule.ids) ||
    source.dataset.name !== rule.dataset.name ||
    source.dataset.split !== rule.dataset.split ||
    source.dataset.sha256 !== rule.dataset.sha256
  ) {
    throw new Error(
      "fixed-ten preflight source is not the frozen v15 artifact",
    );
  }
  if (
    input.fresh.dataset.name !== rule.dataset.name ||
    input.fresh.dataset.split !== rule.dataset.split ||
    input.fresh.dataset.sha256 !== rule.dataset.sha256 ||
    !hasExactUniqueInstanceIds(input.fresh, rule.ids)
  ) {
    throw new Error("fixed-ten fresh manifest dataset or selection drift");
  }
  const reusable = new Map(
    source.instances
      .filter(isEligibleOfficialPreflight)
      .map((instance) => [instance.instanceId, instance]),
  );
  const result: SweCompareManifest = {
    ...input.fresh,
    instances: input.fresh.instances.map((instance) => {
      const prior = reusable.get(instance.instanceId);
      return prior &&
        prior.repo === instance.repo &&
        prior.baseCommit === instance.baseCommit &&
        prior.problemStatementSha256 === instance.problemStatementSha256 &&
        prior.goalSha256 === instance.goalSha256 &&
        prior.failToPassCount === instance.failToPassCount &&
        prior.passToPassCount === instance.passToPassCount
        ? {
            ...instance,
            qualification: prior.qualification,
            preflight: prior.preflight,
          }
        : instance;
    }),
  };
  if (
    pawFixedTenPreflightBundleSha256(result) !==
    rule.preflightSource.preflightBundleSha256
  ) {
    throw new Error("fixed-ten reused preflight bundle does not match v15");
  }
  return result;
}

const PAW_QUALIFICATION_VERIFIED_DATASET =
  "SWE-bench/SWE-bench_Verified" as const;

function defaultVerifiedJsonl(repoRoot: string): string {
  return path.join(
    repoRoot,
    "benchmarks",
    "swe-bench",
    "swe-bench-verified.jsonl",
  );
}

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
    .filter((line) => line !== "benchmarks/swe-bench/swe-bench-verified.jsonl")
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
  readonly datasetName?: SweCompareManifest["dataset"]["name"];
  readonly instanceIds?: readonly string[];
  readonly now?: () => Date;
  readonly mode?: "formal-paired" | "paw-seen-development";
  readonly pawDevelopmentRuleVersion?:
    | "paw-seen-dev-v1"
    | "paw-fresh-dev-v2"
    | "paw-fresh-qualification-v3"
    | "paw-fresh-qualification-v4"
    | "paw-fresh-qualification-v5"
    | "paw-fresh-qualification-v6"
    | "paw-fresh-qualification-v7"
    | "paw-fresh-qualification-v8"
    | "paw-fresh-qualification-v9"
    | "paw-fresh-qualification-v10"
    | "paw-fresh-qualification-v11"
    | "paw-fresh-qualification-v12"
    | "paw-fresh-qualification-v13"
    | "paw-fresh-qualification-v14"
    | "paw-fresh-qualification-v15"
    | "paw-fixed-ten-diagnostic-v1";
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
      name: opts.datasetName ?? "princeton-nlp/SWE-bench_Lite",
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
        verificationAuthority: opts.verificationAuthority ?? "local",
        verificationEnvironment:
          opts.verificationEnvironment ?? "instance_image",
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
  readonly fallbackMinFailToPass?: number;
  readonly fallbackMinPassToPass?: number;
  readonly excludedRepos?: readonly string[];
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
  const excludedRepos = new Set(rule.excludedRepos ?? []);
  const instances = loadLiteInstances(datasetPath);
  const rankedCandidates = (minFailToPass: number, minPassToPass: number) =>
    instances
      .filter((instance) => {
        const failToPass = instance.FAIL_TO_PASS?.length ?? 0;
        const passToPass = instance.PASS_TO_PASS?.length ?? 0;
        return (
          !knownIds.has(instance.instance_id) &&
          !excludedRepos.has(instance.repo) &&
          failToPass >= minFailToPass &&
          failToPass <= rule.maxFailToPass &&
          passToPass >= minPassToPass &&
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
  const appendTier = (minFailToPass: number, minPassToPass: number): void => {
    for (const { instance } of rankedCandidates(minFailToPass, minPassToPass)) {
      if (selectedRepos.has(instance.repo)) continue;
      if (
        findLocalTrajectoryHits(opts.repoRoot, instance.instance_id).length > 0
      )
        continue;
      selected.push(instance.instance_id);
      selectedRepos.add(instance.repo);
      if (selected.length === rule.count) return;
    }
  };
  appendTier(rule.minFailToPass, rule.minPassToPass);
  if (
    selected.length < rule.count &&
    rule.fallbackMinFailToPass !== undefined
  ) {
    appendTier(rule.fallbackMinFailToPass, rule.minPassToPass);
  }
  if (
    selected.length < rule.count &&
    rule.fallbackMinPassToPass !== undefined
  ) {
    appendTier(rule.minFailToPass, rule.fallbackMinPassToPass);
    if (
      selected.length < rule.count &&
      rule.fallbackMinFailToPass !== undefined
    ) {
      appendTier(rule.fallbackMinFailToPass, rule.fallbackMinPassToPass);
    }
  }
  if (selected.length === rule.count) return selected;
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
    datasetPath: opts.datasetPath ?? defaultVerifiedJsonl(opts.repoRoot),
    excludedIds: PAW_QUALIFICATION_V15_EXPOSED_IDS,
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
  const datasetPath = opts.datasetPath ?? defaultVerifiedJsonl(opts.repoRoot);
  return createSweCompareManifest({
    ...opts,
    datasetPath,
    datasetName: PAW_QUALIFICATION_VERIFIED_DATASET,
    instanceIds: selectPawFreshQualificationIds(opts),
    mode: "paw-seen-development",
    pawDevelopmentRuleVersion: rule.version,
    excludedSeenIds: PAW_QUALIFICATION_V15_EXPOSED_IDS,
    pawMaxSteps: rule.pawMaxSteps,
    sharedTimeoutMs: rule.sharedTimeoutMs,
    verificationAuthority: rule.verificationAuthority,
    verificationEnvironment: rule.verificationEnvironment,
  });
}

export function createPawFixedTenDiagnosticManifest(opts: {
  readonly repoRoot: string;
  readonly datasetPath?: string;
  readonly now?: () => Date;
}): SweCompareManifest {
  const rule = PAW_FIXED_TEN_DIAGNOSTIC_RULE;
  const datasetPath = opts.datasetPath ?? defaultVerifiedJsonl(opts.repoRoot);
  return createSweCompareManifest({
    ...opts,
    datasetPath,
    datasetName: PAW_QUALIFICATION_VERIFIED_DATASET,
    instanceIds: rule.ids,
    mode: "paw-seen-development",
    pawDevelopmentRuleVersion: rule.version,
    excludedSeenIds: rule.ids,
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
