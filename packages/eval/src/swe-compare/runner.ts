import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  createBudgetAbort,
  createRunOrchestrator,
  resolveLifecycleBudget,
} from "@paw/agent";
import type {
  ToolEffectPolicy,
  ToolExecutionPolicy,
  VerificationPolicy,
} from "@paw/agent";
import type { RunEventEnvelope } from "@paw/core";
import type { RunAcceptanceCriterionSeed } from "@paw/core";
import type { ShellSandboxConfig } from "@paw/harness";
import {
  createDeepSeekFlashModel,
  createDefaultLanguageModel,
} from "@paw/models";
import { editWorkspaceFile } from "@paw/workspace";
import { parsePatch } from "diff";

import { buildSweAcceptanceCriteria } from "../swe-exp/acceptance.js";
import { writeJsonAtomic } from "../swe-exp/checkpoint.js";
import { loadLiteInstances } from "../swe-exp/dataset.js";
import {
  runSwebenchHarness,
  writePredictionsJsonl,
} from "../swe-exp/evaluate.js";
import {
  type GitDiffCapture,
  captureGitDiff,
  createCommitWorktree,
  ensureRepoClone,
  writeArmPawConfig,
} from "../swe-exp/repo-cache.js";
import { buildSweCompareGoal } from "./goal.js";
import { PAW_FRESH_QUALIFICATION_RULE } from "./manifest.js";
import type { SweCompareManifest } from "./types.js";
import { assertPawVerificationEnvironmentReady } from "./verification-environment.js";

export type SweCompareRunnerName = "paw" | "claude";

export interface SweCompareRunResult {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly runner: SweCompareRunnerName;
  readonly instanceId: string;
  readonly sourceCommit: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly status: "completed" | "failed" | "timeout";
  readonly patch: string;
  readonly patchChars: number;
  readonly patchSource?:
    | "workspace"
    | "claude_trace_git_diff"
    | "claude_trace_mutation_replay"
    | "paw_trace_edit_replay"
    | "none";
  readonly artifactStatus?: "valid" | "patch_collection_failed";
  readonly patchCollectionError?: string;
  readonly integrity?: SweCompareIntegrityAudit;
  readonly resolved: boolean;
  readonly resolvedSource: "swebench_harness" | "none" | "error";
  readonly modelCalls?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly turns?: number;
  readonly terminalReason?: string;
  readonly verificationAuthority?: "local" | "external";
  readonly verificationEnvironment?: "host" | "instance_image";
  readonly error?: string;
  readonly tracePath: string;
  readonly verifier?: {
    readonly reportPath?: string;
    readonly detail?: string;
    readonly error?: string;
  };
}

export interface SweCompareIntegrityAudit {
  readonly valid: boolean;
  readonly violations: readonly string[];
}

interface TraceMutationHints {
  readonly explicitPaths: readonly string[];
  readonly unknownWritePossible: boolean;
}

export function claudeCodeArgs(goal: string): string[] {
  return [
    "-p",
    "--bare",
    "--model",
    "deepseek-v4-flash[1m]",
    "--effort",
    "max",
    "--autocompact",
    "1m",
    // --tools accepts a variadic list. Keep another flag after the value so
    // the final positional goal cannot be consumed as an additional tool.
    "--tools",
    "Read,Edit,Write,Bash,Glob,Grep",
    "--disallowedTools",
    [
      "WebFetch",
      "WebSearch",
      "Bash(curl *)",
      "Bash(* curl *)",
      "Bash(wget *)",
      "Bash(* wget *)",
      "Bash(Invoke-WebRequest *)",
      "Bash(* Invoke-WebRequest *)",
      "Bash(Invoke-RestMethod *)",
      "Bash(* Invoke-RestMethod *)",
      "Bash(iwr *)",
      "Bash(* iwr *)",
      "Bash(irm *)",
      "Bash(* irm *)",
      "Bash(gh *)",
      "Bash(* gh *)",
      "Bash(git fetch *)",
      "Bash(* git fetch *)",
      "Bash(git pull *)",
      "Bash(* git pull *)",
      "Bash(git clone *)",
      "Bash(* git clone *)",
      "Bash(git ls-remote *)",
      "Bash(* git ls-remote *)",
      "Bash(pip install *)",
      "Bash(* pip install *)",
      "Bash(pip download *)",
      "Bash(* pip download *)",
      "Bash(python -m pip install *)",
      "Bash(* python -m pip install *)",
      "Bash(python -m pip download *)",
      "Bash(* python -m pip download *)",
      "Bash(* site-packages *)",
      "Bash(* huggingface *)",
      "Bash(* swe-bench *)",
      "Bash(* test_patch *)",
      "Read(*site-packages*)",
      "Read(*dist-packages*)",
      "Read(*huggingface*)",
      "Read(*swe-bench*)",
      "Grep(*site-packages*)",
      "Grep(*dist-packages*)",
      "Grep(*huggingface*)",
      "Glob(*site-packages*)",
      "Glob(*dist-packages*)",
      "Glob(*huggingface*)",
    ].join(","),
    "--no-session-persistence",
    "--disable-slash-commands",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
    goal,
  ];
}

function currentCommit(repoRoot: string): string {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function currentDirty(repoRoot: string): boolean {
  const result = Bun.spawnSync(["git", "status", "--porcelain"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim());
  }
  return new TextDecoder().decode(result.stdout).trim().length > 0;
}

function normalizePolicyPath(
  workspaceRoot: string,
  candidate: string,
): string | undefined {
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(workspaceRoot, candidate);
  const relative = path.relative(path.resolve(workspaceRoot), absolute);
  if (
    !relative ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  const normalized = relative.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isTestMutationPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const name = normalized.split("/").at(-1) ?? normalized;
  return (
    normalized
      .split("/")
      .some((part) => ["test", "tests", "__tests__"].includes(part)) ||
    /^test[_-]/.test(name) ||
    /(?:^|[_-])tests?\.[^.]+$/.test(name) ||
    /\.(?:test|spec)\.[^.]+$/.test(name) ||
    name === "conftest.py"
  );
}

function mutationTargets(tool: string, args: unknown): string[] {
  const input =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  if (
    tool === "workspace.write_file" ||
    tool === "workspace.edit_file" ||
    tool === "workspace.notebook_edit"
  ) {
    return typeof input.path === "string" ? [input.path] : [];
  }
  if (tool !== "workspace.apply_patch" || typeof input.patch !== "string") {
    return [];
  }
  try {
    return parsePatch(input.patch).flatMap((part) =>
      [part.oldFileName, part.newFileName]
        .filter(
          (value): value is string =>
            typeof value === "string" && value !== "/dev/null",
        )
        .map((value) => value.replace(/^(?:a|b)\//, "")),
    );
  } catch {
    return [];
  }
}

/**
 * Compile the frozen SWE task contract into a trusted pre-execution gate.
 * The model cannot weaken this policy by editing its own prompt or summary.
 */
export function createSweCompareToolExecutionPolicy(input: {
  readonly workspaceRoot: string;
  readonly trackedFiles: ReadonlySet<string>;
}): ToolExecutionPolicy {
  const tracked = new Set(
    [...input.trackedFiles].map((file) =>
      process.platform === "win32" ? file.toLowerCase() : file,
    ),
  );
  return ({ tool, args }) => {
    const targets = mutationTargets(tool, args);
    if (targets.length === 0) return { allowed: true };
    for (const target of targets) {
      const relative = normalizePolicyPath(input.workspaceRoot, target);
      if (!relative) {
        return {
          allowed: false,
          reason: "mutation_outside_workspace",
          message: `Mutation target ${target} is outside the task workspace. Edit an existing tracked product source file instead.`,
        };
      }
      if (!tracked.has(relative)) {
        return {
          allowed: false,
          reason: "new_file_forbidden",
          message: `This task permits edits only to existing tracked source files; ${relative} is not tracked. Do not create helper, probe, patch, or replacement test files. Use the repository's existing source and test commands.`,
        };
      }
      if (isTestMutationPath(relative)) {
        return {
          allowed: false,
          reason: "test_mutation_forbidden",
          message: `This task treats tests as read-only; ${relative} cannot be modified. Fix the existing product source instead.`,
        };
      }
    }
    return { allowed: true };
  };
}

interface SweWorkspaceEffectSnapshot {
  readonly head: string;
  readonly trackedPatch: string;
  readonly trackedPaths: readonly string[];
  readonly untracked: ReadonlyMap<string, Buffer>;
}

function gitNullList(workspaceRoot: string, args: readonly string[]): string[] {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replace(/\\/g, "/"));
}

function gitText(workspaceRoot: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function normalizeFrozenPath(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isEphemeralGeneratedPath(file: string): boolean {
  const parts = file.replace(/\\/g, "/").toLowerCase().split("/");
  return parts.some((part) =>
    [
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".coverage",
    ].includes(part),
  );
}

function snapshotUntrackedFiles(
  workspaceRoot: string,
): ReadonlyMap<string, Buffer> {
  const files = gitNullList(workspaceRoot, ["ls-files", "--others", "-z"]);
  const snapshot = new Map<string, Buffer>();
  for (const file of files) {
    const relative = normalizePolicyPath(workspaceRoot, file);
    if (!relative) throw new Error(`unsafe untracked baseline path: ${file}`);
    const absolute = path.resolve(workspaceRoot, relative);
    if (!existsSync(absolute)) continue;
    snapshot.set(normalizeFrozenPath(file), readFileSync(absolute));
  }
  return snapshot;
}

function restoreUntrackedBaseline(
  workspaceRoot: string,
  before: ReadonlyMap<string, Buffer>,
): string[] {
  const changed: string[] = [];
  for (const [file, content] of before) {
    const relative = normalizePolicyPath(workspaceRoot, file);
    if (!relative) throw new Error(`unsafe untracked recovery path: ${file}`);
    const absolute = path.resolve(workspaceRoot, relative);
    const current = existsSync(absolute) ? readFileSync(absolute) : undefined;
    if (current?.equals(content)) continue;
    changed.push(file);
    if (existsSync(absolute))
      rmSync(absolute, { recursive: true, force: true });
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return changed;
}

function gitPatch(workspaceRoot: string): string {
  const result = Bun.spawnSync(["git", "diff", "--binary", "HEAD"], {
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git diff --binary HEAD failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

function restoreTrackedSnapshot(
  workspaceRoot: string,
  before: SweWorkspaceEffectSnapshot,
): void {
  gitText(workspaceRoot, ["reset", "--hard", before.head]);
  if (!before.trackedPatch) return;
  const result = Bun.spawnSync(["git", "apply", "--binary", "-"], {
    cwd: workspaceRoot,
    stdin: Buffer.from(before.trackedPatch, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git apply baseline failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
}

function withWorkspaceEffect(
  result: import("@paw/harness").ToolRunResult,
  paths: readonly string[],
): import("@paw/harness").ToolRunResult {
  const payload =
    result.payload && typeof result.payload === "object"
      ? (result.payload as Record<string, unknown>)
      : { originalPayload: result.payload };
  return {
    ...result,
    payload: {
      ...payload,
      workspaceEffect: { changed: paths.length > 0, paths },
    },
  };
}

/**
 * Audit native shell effects in the isolated SWE worktree.
 *
 * This is deliberately separate from command-text policy. It restores exact
 * prohibited tracked/new paths after the process exits, before the result
 * reaches agent state. Known test caches are cleaned without turning an
 * otherwise-valid verification command into a failure. It does not claim to
 * confine writes outside `workspaceRoot`; native
 * process/filesystem isolation remains the stronger production boundary.
 */
export function createSweCompareToolEffectPolicy(input: {
  readonly workspaceRoot: string;
  readonly trackedFiles: ReadonlySet<string>;
}): ToolEffectPolicy {
  const frozenTracked = new Set(
    [...input.trackedFiles].map(normalizeFrozenPath),
  );
  const snapshot = (): SweWorkspaceEffectSnapshot => {
    const dirtyTests = gitNullList(input.workspaceRoot, [
      "diff",
      "HEAD",
      "--name-only",
      "-z",
    ]).filter(isTestMutationPath);
    if (dirtyTests.length > 0) {
      throw new Error(
        `cannot audit shell from a dirty test baseline: ${dirtyTests.join(", ")}`,
      );
    }
    return {
      head: gitText(input.workspaceRoot, ["rev-parse", "HEAD"]),
      trackedPatch: gitPatch(input.workspaceRoot),
      trackedPaths: gitNullList(input.workspaceRoot, [
        "diff",
        "HEAD",
        "--name-only",
        "-z",
      ]).filter((file) => !isTestMutationPath(file)),
      untracked: snapshotUntrackedFiles(input.workspaceRoot),
    };
  };

  return {
    appliesTo: ({ tool }) => tool === "workspace.run_shell",
    prepare: () => snapshot(),
    settle: (effect, prepared) => {
      const before = prepared as SweWorkspaceEffectSnapshot;
      const reasons: string[] = [];
      let recovered = true;
      try {
        const currentHead = gitText(input.workspaceRoot, ["rev-parse", "HEAD"]);
        if (currentHead !== before.head) {
          reasons.push("history mutation");
          // Restore first: files introduced by a new commit become untracked
          // only after HEAD returns to the frozen baseline.
          restoreTrackedSnapshot(input.workspaceRoot, before);
        }

        const staged = gitNullList(input.workspaceRoot, [
          "diff",
          "--cached",
          "--name-only",
          "-z",
        ]);
        if (staged.length > 0) {
          reasons.push(`index mutation: ${staged.join(", ")}`);
          gitText(input.workspaceRoot, [
            "reset",
            "--quiet",
            "HEAD",
            "--",
            ...staged,
          ]);
        }

        const forbiddenTracked = gitNullList(input.workspaceRoot, [
          "diff",
          "HEAD",
          "--name-only",
          "-z",
        ]).filter(isTestMutationPath);
        if (forbiddenTracked.length > 0) {
          reasons.push(`test mutation: ${forbiddenTracked.join(", ")}`);
          gitText(input.workspaceRoot, [
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            ...forbiddenTracked,
          ]);
        }

        const afterUntracked = gitNullList(input.workspaceRoot, [
          "ls-files",
          "--others",
          "-z",
        ]);
        const changedBaselineFiles = restoreUntrackedBaseline(
          input.workspaceRoot,
          before.untracked,
        );
        if (changedBaselineFiles.length > 0) {
          reasons.push(
            `untracked baseline mutation: ${changedBaselineFiles.join(", ")}`,
          );
        }
        const newFiles = afterUntracked.filter(
          (file) =>
            !before.untracked.has(normalizeFrozenPath(file)) &&
            !frozenTracked.has(normalizeFrozenPath(file)),
        );
        if (newFiles.length > 0) {
          const prohibitedNewFiles = newFiles.filter(
            (file) => !isEphemeralGeneratedPath(file),
          );
          if (prohibitedNewFiles.length > 0) {
            reasons.push(`new file: ${prohibitedNewFiles.join(", ")}`);
          }
          for (const file of newFiles) {
            const relative = normalizePolicyPath(input.workspaceRoot, file);
            if (!relative) throw new Error(`unsafe recovery path: ${file}`);
            const absolute = path.resolve(input.workspaceRoot, relative);
            if (existsSync(absolute))
              rmSync(absolute, { recursive: true, force: true });
          }
        }
        const afterTrackedPaths = new Set(
          gitNullList(input.workspaceRoot, [
            "diff",
            "HEAD",
            "--name-only",
            "-z",
          ]).filter((file) => !isTestMutationPath(file)),
        );
        const lostCandidatePaths = before.trackedPaths.filter(
          (file) => !afterTrackedPaths.has(file),
        );
        if (lostCandidatePaths.length > 0) {
          reasons.push(
            `material candidate rollback: ${lostCandidatePaths.join(", ")}`,
          );
        }
        if (reasons.length > 0 && currentHead === before.head) {
          restoreTrackedSnapshot(input.workspaceRoot, before);
        }
      } catch (error) {
        recovered = false;
        const message = error instanceof Error ? error.message : String(error);
        reasons.push(`recovery failed: ${message}`);
      }

      if (reasons.length === 0) {
        const afterPatch = gitPatch(input.workspaceRoot);
        if (afterPatch === before.trackedPatch) {
          return {
            allowed: true,
            result: withWorkspaceEffect(effect.result, []),
          };
        }
        const changedPaths = gitNullList(input.workspaceRoot, [
          "diff",
          "HEAD",
          "--name-only",
          "-z",
        ]).filter((file) => !isTestMutationPath(file));
        return {
          allowed: true,
          result: withWorkspaceEffect(effect.result, changedPaths),
        };
      }
      return {
        allowed: false,
        reason: recovered
          ? "prohibited_workspace_effect_recovered"
          : "prohibited_workspace_effect_unrecovered",
        message: `Shell produced prohibited workspace effects (${reasons.join("; ")}). ${
          recovered
            ? "They were restored; edit only existing tracked product source files."
            : "Recovery was incomplete; stop and inspect the isolated workspace."
        }`,
        recovered,
      };
    },
  };
}

function trackedFiles(workspaceRoot: string): ReadonlySet<string> {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `cannot freeze tracked-file policy: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new Set(
    new TextDecoder()
      .decode(result.stdout)
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replace(/\\/g, "/")),
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function compareProtocolMetadataIsValid(
  manifest: SweCompareManifest,
): boolean {
  const seenDevelopment = manifest.protocol === "paw-only-seen-development";
  const validRule = seenDevelopment
    ? manifest.selection.ruleVersion === "paw-seen-dev-v1" ||
      manifest.selection.ruleVersion === "paw-fresh-dev-v2" ||
      manifest.selection.ruleVersion === "paw-fresh-qualification-v3" ||
      manifest.selection.ruleVersion === "paw-fresh-qualification-v4" ||
      manifest.selection.ruleVersion === "paw-fresh-qualification-v5" ||
      manifest.selection.ruleVersion === "paw-fresh-qualification-v6" ||
      manifest.selection.ruleVersion === "paw-fresh-qualification-v7" ||
      manifest.selection.ruleVersion === "paw-fresh-qualification-v8" ||
      manifest.selection.ruleVersion === PAW_FRESH_QUALIFICATION_RULE.version
    : manifest.selection.ruleVersion === "formal-dev-v1";
  return (
    validRule &&
    manifest.selection.purpose ===
      (seenDevelopment
        ? "paw_only_seen_architecture_diagnostic_not_holdout_or_headline_score"
        : "frozen_paired_dev_diagnostic_not_headline_score")
  );
}

export function validateCompareRun(
  repoRoot: string,
  manifest: SweCompareManifest,
  instanceId: string,
): void {
  if (manifest.sourceTree.gitDirty) {
    throw new Error("compare manifest was created from a dirty source tree");
  }
  if (currentDirty(repoRoot)) {
    throw new Error("current source tree is dirty; commit before comparison");
  }
  const commit = currentCommit(repoRoot);
  if (manifest.sourceTree.gitCommit !== commit) {
    throw new Error(
      `compare manifest commit mismatch: manifest=${manifest.sourceTree.gitCommit} current=${commit}`,
    );
  }
  if (!compareProtocolMetadataIsValid(manifest)) {
    throw new Error("compare manifest protocol metadata is inconsistent");
  }
  validatePawQualificationContract(manifest);
  const instance = manifest.instances.find(
    (item) => item.instanceId === instanceId,
  );
  if (!instance)
    throw new Error(`instance not frozen in manifest: ${instanceId}`);
  if (
    instance.qualification !== "eligible" ||
    instance.preflight?.completed !== true
  ) {
    throw new Error(`instance is not preflight eligible: ${instanceId}`);
  }
  const datasetPath = path.join(repoRoot, manifest.dataset.localPath);
  const dataset = readFileSync(datasetPath);
  if (sha256(dataset) !== manifest.dataset.sha256) {
    throw new Error("compare dataset SHA-256 mismatch");
  }
  const probe = loadLiteInstances(datasetPath).find(
    (item) => item.instance_id === instanceId,
  );
  if (!probe) throw new Error(`dataset instance missing: ${instanceId}`);
  if (sha256(probe.problem_statement) !== instance.problemStatementSha256) {
    throw new Error(`problem statement hash mismatch: ${instanceId}`);
  }
  if (sha256(buildSweCompareGoal(probe)) !== instance.goalSha256) {
    throw new Error(`goal hash mismatch: ${instanceId}`);
  }
  const runtimeProfile = createDefaultLanguageModel(repoRoot).runtimeProfile;
  if (
    JSON.stringify(runtimeProfile) !==
    JSON.stringify(manifest.runners.paw.runtimeProfile)
  ) {
    throw new Error(
      `Paw runtime profile drift: manifest=${JSON.stringify(manifest.runners.paw.runtimeProfile)} current=${JSON.stringify(runtimeProfile)}`,
    );
  }
}

export function pawVerificationPolicyFromManifest(
  manifest: SweCompareManifest,
): VerificationPolicy {
  return {
    authority: manifest.runners.paw.verificationAuthority ?? "external",
    requireMutation: true,
  };
}

/** Fail closed if a versioned qualification rule drifts after it is frozen. */
export function validatePawQualificationContract(
  manifest: SweCompareManifest,
): void {
  const rule = PAW_FRESH_QUALIFICATION_RULE;
  if (manifest.selection.ruleVersion !== rule.version) return;
  if (
    manifest.selection.ids.length !== rule.count ||
    new Set(manifest.selection.ids).size !== rule.count ||
    manifest.budget.pawMaxSteps !== rule.pawMaxSteps ||
    manifest.budget.sharedTimeoutMs !== rule.sharedTimeoutMs ||
    manifest.budget.codingPhaseBudget !== false ||
    manifest.runners.paw.memory !== "off" ||
    manifest.runners.paw.verificationAuthority !== rule.verificationAuthority ||
    manifest.runners.paw.verificationEnvironment !==
      rule.verificationEnvironment
  ) {
    throw new Error(`${rule.version} contract drift`);
  }
}

export function collectPawMetrics(events: readonly RunEventEnvelope[]): {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
} {
  let modelCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let turns = 0;
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "model.done") {
      modelCalls += 1;
      promptTokens += event.usage?.promptTokens ?? 0;
      completionTokens += event.usage?.completionTokens ?? 0;
      totalTokens += event.usage?.totalTokens ?? 0;
    } else if (event.type === "candidate.review") {
      modelCalls += event.modelCalls;
      promptTokens += event.usage?.promptTokens ?? 0;
      completionTokens += event.usage?.completionTokens ?? 0;
      totalTokens += event.usage?.totalTokens ?? 0;
    } else if (event.type === "loop.tick") {
      turns = Math.max(turns, event.turn);
    }
  }
  return { modelCalls, promptTokens, completionTokens, totalTokens, turns };
}

async function runPaw(opts: {
  readonly repoRoot: string;
  readonly workspaceRoot: string;
  readonly goal: string;
  readonly runId: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly verificationPolicy: VerificationPolicy;
  readonly shellSandbox?: ShellSandboxConfig;
  readonly initialAcceptanceCriteria: readonly RunAcceptanceCriterionSeed[];
}): Promise<{
  status: "completed" | "failed" | "timeout";
  terminalReason?: string;
  error?: string;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
  trace: readonly RunEventEnvelope[];
}> {
  writeArmPawConfig({
    workspaceRoot: opts.workspaceRoot,
    repositoryId: `swe-compare-${opts.runId}`,
    memoryEnable: false,
  });
  const events: RunEventEnvelope[] = [];
  const budget = resolveLifecycleBudget({
    maxSteps: opts.maxSteps,
    timeoutMs: opts.timeoutMs,
  });
  const abort = createBudgetAbort(opts.timeoutMs);
  // The session store appends every event synchronously. Keep that durable
  // control-plane log beside the benchmark result so an expensive trajectory
  // survives a crash or a later patch-collection failure.
  const runtimeStateRoot = path.join(
    opts.repoRoot,
    "benchmarks",
    "swe-compare",
    "runs",
    opts.runId,
    "runtime",
  );
  mkdirSync(runtimeStateRoot, { recursive: true });
  let runtime: ReturnType<typeof createRunOrchestrator>;
  try {
    const mainModel = createDefaultLanguageModel(opts.repoRoot);
    runtime = createRunOrchestrator({
      workspaceRoot: opts.workspaceRoot,
      mainModel,
      subAgentModel: createDeepSeekFlashModel(opts.repoRoot) ?? mainModel,
      runtimeStateRoot,
      autonomy: "headless",
      budget,
      memoryExtraction: "off",
      collaborationMode: "coding",
      // Every shell call crosses the eval policy gate so network attempts are
      // rejected before the harness spawns a process. Non-shell tools stay free.
      approvalPolicy: (tool) => tool === "workspace.run_shell",
      resolveToolApproval: async (input) => allowSweCompareToolCall(input),
      toolExecutionPolicy: createSweCompareToolExecutionPolicy({
        workspaceRoot: opts.workspaceRoot,
        trackedFiles: trackedFiles(opts.workspaceRoot),
      }),
      toolEffectPolicy: createSweCompareToolEffectPolicy({
        workspaceRoot: opts.workspaceRoot,
        trackedFiles: trackedFiles(opts.workspaceRoot),
      }),
      // Local checks remain evidence, but the official SWE-bench container is
      // authoritative. Harness failure may close only after a material edit and
      // fresh diff inspection; it is never recorded as a local pass.
      verificationPolicy: opts.verificationPolicy,
      shellSandbox: opts.shellSandbox,
      onEvent: (event) => {
        if (
          event.event.type !== "model.chunk" &&
          event.event.type !== "model.thinking"
        ) {
          events.push(event);
        }
      },
    });
  } catch (error) {
    abort.clear();
    throw error;
  }
  const { orch, watcher } = runtime;
  try {
    const result = await orch.run({
      runId: opts.runId,
      goal: opts.goal,
      initialAcceptanceCriteria: opts.initialAcceptanceCriteria,
      workspaceRoot: opts.workspaceRoot,
      maxSteps: opts.maxSteps,
      abortSignal: abort.signal,
      conversationId: `${opts.runId}-session`,
    });
    const metrics = collectPawMetrics(events);
    const timeout = abort.signal.aborted;
    return {
      status: timeout
        ? "timeout"
        : result.status === "completed"
          ? "completed"
          : "failed",
      terminalReason: result.completionReason ?? result.outcome,
      ...(result.status === "completed" ? {} : { error: result.message }),
      ...metrics,
      trace: events,
    };
  } catch (error) {
    return {
      status: abort.signal.aborted ? "timeout" : "failed",
      error: error instanceof Error ? error.message : String(error),
      ...collectPawMetrics(events),
      trace: events,
    };
  } finally {
    abort.clear();
    watcher.stop();
  }
}

export interface ClaudeJsonResult {
  readonly type?: string;
  readonly is_error?: boolean;
  readonly num_turns?: number;
  readonly terminal_reason?: string;
  readonly result?: string;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
    readonly cache_creation_input_tokens?: number;
  };
}

function sanitizeClaudeTraceEvent(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const event = value as Record<string, unknown>;
  if (event.type === "system" && event.subtype === "thinking_tokens")
    return null;
  if (event.type !== "assistant") return event;
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return event;
  }
  const record = message as Record<string, unknown>;
  const content = Array.isArray(record.content)
    ? record.content.filter(
        (block) =>
          !block ||
          typeof block !== "object" ||
          Array.isArray(block) ||
          (block as Record<string, unknown>).type !== "thinking",
      )
    : record.content;
  if (Array.isArray(content) && content.length === 0) return null;
  return { ...event, message: { ...record, content } };
}

export function parseClaudeStream(stdout: string): {
  readonly result: ClaudeJsonResult;
  readonly trace: readonly unknown[];
} {
  const parsed: unknown[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    parsed.push(JSON.parse(line) as unknown);
  }
  const result = [...parsed]
    .reverse()
    .find(
      (item): item is ClaudeJsonResult =>
        !!item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as ClaudeJsonResult).type === "result",
    );
  if (!result)
    throw new Error("Claude Code stream has no terminal result event");
  return {
    result,
    trace: parsed
      .map(sanitizeClaudeTraceEvent)
      .filter((item): item is unknown => item !== null),
  };
}

export function extractClaudePatchFromTrace(
  trace: readonly unknown[],
): string | undefined {
  const diffToolIds = new Set<string>();
  let patch: string | undefined;
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const event = item as Record<string, unknown>;
    const message = event.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      if (
        !rawBlock ||
        typeof rawBlock !== "object" ||
        Array.isArray(rawBlock)
      ) {
        continue;
      }
      const block = rawBlock as Record<string, unknown>;
      if (block.type === "tool_use" && block.name === "Bash") {
        const input = block.input;
        const command =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>).command
            : undefined;
        if (
          typeof block.id === "string" &&
          typeof command === "string" &&
          /(?:^|&&|;)\s*git\s+diff(?:\s|$)/i.test(command)
        ) {
          diffToolIds.add(block.id);
        }
      }
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        diffToolIds.has(block.tool_use_id) &&
        typeof block.content === "string" &&
        block.content.trimStart().startsWith("diff --git ")
      ) {
        patch = block.content.trim();
      }
    }
  }
  return patch;
}

interface ClaudeSuccessfulTool {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

function successfulClaudeToolIds(trace: readonly unknown[]): Set<string> {
  const denied = new Set<string>();
  const successful = new Set<string>();
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const event = item as Record<string, unknown>;
    if (
      event.type === "system" &&
      event.subtype === "permission_denied" &&
      typeof event.tool_use_id === "string"
    ) {
      denied.add(event.tool_use_id);
    }
    const message = event.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      if (
        !rawBlock ||
        typeof rawBlock !== "object" ||
        Array.isArray(rawBlock)
      ) {
        continue;
      }
      const block = rawBlock as Record<string, unknown>;
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string" &&
        block.is_error !== true
      ) {
        successful.add(block.tool_use_id);
      }
    }
  }
  for (const id of denied) successful.delete(id);
  return successful;
}

function successfulClaudeTools(
  trace: readonly unknown[],
): ClaudeSuccessfulTool[] {
  const successfulIds = successfulClaudeToolIds(trace);
  const tools: ClaudeSuccessfulTool[] = [];
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = (item as Record<string, unknown>).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      if (
        !rawBlock ||
        typeof rawBlock !== "object" ||
        Array.isArray(rawBlock)
      ) {
        continue;
      }
      const block = rawBlock as Record<string, unknown>;
      if (
        block.type !== "tool_use" ||
        typeof block.id !== "string" ||
        !successfulIds.has(block.id) ||
        typeof block.name !== "string"
      ) {
        continue;
      }
      const input = block.input;
      tools.push({
        name: block.name,
        input:
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {},
      });
    }
  }
  return tools;
}

function tracePathToWorkspaceRelative(value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/");
  const worktreeMarker = normalized.toLowerCase().lastIndexOf("/wt/");
  const relative =
    worktreeMarker >= 0
      ? normalized.slice(worktreeMarker + 4)
      : path.isAbsolute(value)
        ? undefined
        : normalized;
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative.split("/").includes("..")
  ) {
    return undefined;
  }
  return relative;
}

function shellResetPaths(command: string): string[] {
  const paths: string[] = [];
  const matcher = /\bgit\s+(?:checkout|restore)\b([^;&\r\n]*)/gi;
  for (const match of command.matchAll(matcher)) {
    const tail = match[1] ?? "";
    const separator = tail.lastIndexOf("--");
    if (separator < 0) continue;
    const rawPaths = tail.slice(separator + 2).trim();
    for (const token of rawPaths.match(/"[^"]+"|'[^']+'|\S+/g) ?? []) {
      paths.push(token.replace(/^(?:"|')|(?:"|')$/g, ""));
    }
  }
  return paths;
}

/** Rebuild Claude's terminal source state from paired successful mutations. */
export function replayClaudeTracePatch(
  trace: readonly unknown[],
  workspaceRoot: string,
): { readonly diff?: string; readonly error?: string } {
  const paths = new Set<string>();
  let replayedMutation = false;
  for (const tool of successfulClaudeTools(trace)) {
    if (tool.name === "Edit") {
      const filePath = tool.input.file_path;
      const oldString = tool.input.old_string;
      const newString = tool.input.new_string;
      if (
        typeof filePath !== "string" ||
        typeof oldString !== "string" ||
        typeof newString !== "string"
      ) {
        return { error: "Claude Edit event is missing replay fields" };
      }
      const relative = tracePathToWorkspaceRelative(filePath);
      if (!relative) return { error: `unsafe Claude edit path: ${filePath}` };
      const target = path.join(workspaceRoot, ...relative.split("/"));
      const current = readFileSync(target, "utf8");
      const replaceAll = tool.input.replace_all === true;
      const first = current.indexOf(oldString);
      if (
        first < 0 ||
        (!replaceAll && current.indexOf(oldString, first + 1) >= 0)
      ) {
        return {
          error: `Claude edit replay anchor is not unique: ${relative}`,
        };
      }
      writeFileSync(
        target,
        replaceAll
          ? current.split(oldString).join(newString)
          : current.slice(0, first) +
              newString +
              current.slice(first + oldString.length),
        "utf8",
      );
      paths.add(relative);
      replayedMutation = true;
      continue;
    }
    if (tool.name === "Write") {
      const filePath = tool.input.file_path;
      const content = tool.input.content;
      if (typeof filePath !== "string" || typeof content !== "string") {
        return { error: "Claude Write event is missing replay fields" };
      }
      const relative = tracePathToWorkspaceRelative(filePath);
      if (!relative) return { error: `unsafe Claude write path: ${filePath}` };
      const target = path.join(workspaceRoot, ...relative.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      paths.add(relative);
      replayedMutation = true;
      continue;
    }
    if (tool.name !== "Bash" || typeof tool.input.command !== "string") {
      continue;
    }
    for (const rawPath of shellResetPaths(tool.input.command)) {
      const relative = tracePathToWorkspaceRelative(rawPath);
      if (!relative) return { error: `unsafe Claude reset path: ${rawPath}` };
      const reset = Bun.spawnSync(["git", "checkout", "HEAD", "--", relative], {
        cwd: workspaceRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (reset.exitCode !== 0) {
        return {
          error: `Claude reset replay failed for ${relative}: ${reset.stderr.toString().trim()}`,
        };
      }
      paths.delete(relative);
      replayedMutation = true;
    }
  }
  if (!replayedMutation || paths.size === 0) {
    return { error: "Claude trace has no terminal replayable mutation" };
  }
  return captureGitDiff(workspaceRoot, [...paths]);
}

function shellCommandsFromClaudeTrace(trace: readonly unknown[]): string[] {
  const commands: string[] = [];
  const deniedToolIds = new Set<string>();
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const event = item as Record<string, unknown>;
    if (
      event.type === "system" &&
      event.subtype === "permission_denied" &&
      typeof event.tool_use_id === "string"
    ) {
      deniedToolIds.add(event.tool_use_id);
    }
    const meta = event.tool_result_meta;
    if (!Array.isArray(meta)) continue;
    for (const raw of meta) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = raw as Record<string, unknown>;
      if (
        record.non_execution_kind === "permission-rule" &&
        typeof record.id === "string"
      ) {
        deniedToolIds.add(record.id);
      }
    }
  }
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const message = (item as Record<string, unknown>).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      if (
        !rawBlock ||
        typeof rawBlock !== "object" ||
        Array.isArray(rawBlock)
      ) {
        continue;
      }
      const block = rawBlock as Record<string, unknown>;
      if (
        block.type !== "tool_use" ||
        block.name !== "Bash" ||
        (typeof block.id === "string" && deniedToolIds.has(block.id))
      ) {
        continue;
      }
      const input = block.input;
      const command =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>).command
          : undefined;
      if (typeof command === "string") commands.push(command);
    }
  }
  return commands;
}

function shellCommandsFromPawTrace(trace: readonly unknown[]): string[] {
  const commands: string[] = [];
  const pending: string[] = [];
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const event = (item as Record<string, unknown>).event;
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (record.tool !== "workspace.run_shell") {
      continue;
    }
    if (record.type === "tool.call") {
      const args = record.args;
      const command =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>).command
          : undefined;
      if (typeof command === "string") pending.push(command);
      continue;
    }
    if (record.type === "tool.result") {
      const command = pending.shift();
      if (!command) continue;
      const summary = typeof record.summary === "string" ? record.summary : "";
      if (!pawShellCallRejectedBeforeExecution(summary)) {
        commands.push(command);
      }
    }
  }
  // Legacy/truncated traces may not contain the paired tool result. Preserve
  // the conservative behavior for those: an unpaired network call is treated
  // as potentially executed, never silently whitelisted.
  commands.push(...pending);
  return commands;
}

/**
 * Only results produced by Paw's control plane before the shell executor runs
 * can prove that a recorded tool.call had no benchmark-visible effect.
 * ToolEffectPolicy is deliberately excluded because it evaluates an execution
 * that already happened; ordinary shell failures are likewise still audited.
 */
function pawShellCallRejectedBeforeExecution(summary: string): boolean {
  const normalized = summary.trim();
  return (
    /execution denied|denied by user/i.test(normalized) ||
    /^\[(?:LoopPolicy|ToolPolicy):[^\]]+\]/.test(normalized)
  );
}

function commandMayWrite(command: string): boolean {
  return /(?:\bgit\s+(?:apply|checkout|restore|reset|am)\b|\bsed\s+-i\b|\bperl\s+-pi\b|\b(?:rm|del|mv|cp|tee|set-content|add-content|out-file|remove-item|move-item|copy-item)\b|\b(?:writeFile|write_text|write_bytes)\b|(?<!\d)>\s*[^&\s])/i.test(
    command,
  );
}

export function collectTraceMutationHints(opts: {
  readonly trace: readonly unknown[];
  readonly runner: SweCompareRunnerName;
  readonly workspaceRoot: string;
}): TraceMutationHints {
  const explicitPaths = new Set<string>();
  const pendingPawShellCommands: string[] = [];
  let unknownWritePossible = false;
  const addPath = (value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const relative = path.isAbsolute(value)
      ? path.relative(opts.workspaceRoot, value)
      : value;
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      explicitPaths.add(relative.replace(/\\/g, "/"));
    }
  };
  for (const item of opts.trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (opts.runner === "paw") {
      const event = (item as Record<string, unknown>).event;
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const record = event as Record<string, unknown>;
      const args = record.args;
      const argRecord =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {};
      const shellResult =
        record.type === "tool.result" && record.tool === "workspace.run_shell";
      const rawEffect = shellResult ? record.workspaceEffect : undefined;
      const auditedShellEffect =
        rawEffect &&
        typeof rawEffect === "object" &&
        !Array.isArray(rawEffect) &&
        typeof (rawEffect as Record<string, unknown>).changed === "boolean" &&
        Array.isArray((rawEffect as Record<string, unknown>).paths)
          ? (rawEffect as {
              readonly changed: boolean;
              readonly paths: readonly unknown[];
            })
          : undefined;
      if (
        record.type === "tool.call" &&
        record.tool === "workspace.run_shell"
      ) {
        pendingPawShellCommands.push(
          typeof argRecord.command === "string" ? argRecord.command : "",
        );
      }
      if (
        record.type === "tool.result" &&
        Array.isArray(record.fileChanges) &&
        (!shellResult || !auditedShellEffect)
      ) {
        let materialFileChange = false;
        for (const change of record.fileChanges) {
          if (!change || typeof change !== "object" || Array.isArray(change)) {
            continue;
          }
          const fileChange = change as Record<string, unknown>;
          const added =
            typeof fileChange.added === "number" ? fileChange.added : 0;
          const removed =
            typeof fileChange.removed === "number" ? fileChange.removed : 0;
          if (added + removed > 0) {
            addPath(fileChange.path);
            materialFileChange = true;
          }
        }
        if (materialFileChange && record.tool === "workspace.run_shell") {
          unknownWritePossible = true;
        }
      }
      if (shellResult) {
        const command = pendingPawShellCommands.shift() ?? "";
        if (auditedShellEffect) {
          if (auditedShellEffect.changed) {
            for (const changedPath of auditedShellEffect.paths) {
              addPath(changedPath);
            }
            unknownWritePossible = true;
          }
        } else {
          const summary =
            typeof record.summary === "string" ? record.summary : "";
          if (
            !pawShellCallRejectedBeforeExecution(summary) &&
            commandMayWrite(command) &&
            !summary.startsWith(
              "[ToolEffectPolicy:prohibited_workspace_effect_recovered]",
            )
          ) {
            // Legacy and non-audited traces retain command-text conservatism.
            unknownWritePossible = true;
          }
        }
      }
      continue;
    }
    const message = (item as Record<string, unknown>).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      if (
        !rawBlock ||
        typeof rawBlock !== "object" ||
        Array.isArray(rawBlock)
      ) {
        continue;
      }
      const block = rawBlock as Record<string, unknown>;
      if (block.type !== "tool_use") continue;
      const input = block.input;
      const inputRecord =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      if (block.name === "Edit" || block.name === "Write") {
        addPath(inputRecord.file_path);
      }
      if (
        block.name === "Bash" &&
        typeof inputRecord.command === "string" &&
        commandMayWrite(inputRecord.command)
      ) {
        unknownWritePossible = true;
      }
    }
  }
  if (opts.runner === "paw") {
    if (pendingPawShellCommands.some(commandMayWrite)) {
      unknownWritePossible = true;
    }
    for (const edit of successfulPawEdits(opts.trace)) addPath(edit.path);
  }
  return {
    explicitPaths: [...explicitPaths].sort(),
    unknownWritePossible,
  };
}

/** Flag benchmark-invalid attempts to retrieve an existing public solution. */
export function auditClaudeTraceIntegrity(
  trace: readonly unknown[],
): SweCompareIntegrityAudit {
  const shellAudit = auditShellCommands(shellCommandsFromClaudeTrace(trace));
  const violations = [...shellAudit.violations];
  for (const tool of successfulClaudeTools(trace)) {
    for (const value of Object.values(tool.input)) {
      if (typeof value !== "string") continue;
      const localGold = sweCompareLocalGoldViolation(value);
      if (localGold) violations.push(localGold);
    }
  }
  const unique = [...new Set(violations)];
  return { valid: unique.length === 0, violations: unique };
}

export function auditPawTraceIntegrity(
  trace: readonly unknown[],
): SweCompareIntegrityAudit {
  const shellAudit = auditShellCommands(shellCommandsFromPawTrace(trace));
  const violations = [...shellAudit.violations];
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const event = (item as Record<string, unknown>).event;
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    if (
      record.type === "tool.result" &&
      typeof record.summary === "string" &&
      /\[ToolEffectPolicy:(?:settle_failed|prohibited_workspace_effect_unrecovered)\]/.test(
        record.summary,
      )
    ) {
      violations.push("workspace_effect_policy_failure");
    }
  }
  const unique = [...new Set(violations)];
  return { valid: unique.length === 0, violations: unique };
}

function auditShellCommands(
  commands: readonly string[],
): SweCompareIntegrityAudit {
  const violations: string[] = [];
  for (const command of commands) {
    const outbound = sweCompareNetworkViolation(command);
    if (outbound) violations.push(outbound);
    const localGold = sweCompareLocalGoldViolation(command);
    if (localGold) violations.push(localGold);
    if (
      /\bgit\s+(?:show|log|diff)\b[^\r\n]*(?:origin\/|upstream\/)/i.test(
        command,
      )
    ) {
      violations.push("upstream_history_inspection");
    }
  }
  const unique = [...new Set(violations)];
  return { valid: unique.length === 0, violations: unique };
}

/** Detect local copies of public benchmark answers outside the frozen repo. */
export function sweCompareLocalGoldViolation(
  value: string,
): "installed_future_source_access" | "benchmark_gold_data_access" | undefined {
  if (/(?:site-packages|dist-packages)[\\/]/i.test(value)) {
    return "installed_future_source_access";
  }
  if (
    /(?:[\\/]\.cache[\\/]huggingface[\\/]|swe[_-]?bench[^\s"']*\.(?:arrow|parquet|jsonl)|\btest_patch\b|\bgold_patch\b)/i.test(
      value,
    )
  ) {
    return "benchmark_gold_data_access";
  }
  return undefined;
}

/**
 * Shared pre-execution/post-run rule for public benchmark network isolation.
 * Offline package installs remain allowed when pip is explicitly --no-index.
 */
export function sweCompareNetworkViolation(
  command: string,
):
  | "upstream_network_git_access"
  | "outbound_network_command"
  | "outbound_dependency_install"
  | undefined {
  if (/\bgit\s+(?:fetch|pull|clone|ls-remote)\b/i.test(command)) {
    return "upstream_network_git_access";
  }
  if (
    /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer)\b/i.test(
      command,
    ) ||
    /\bgh\s+(?:api|pr|issue|repo)\b/i.test(command) ||
    /\bpython(?:\d+(?:\.\d+)?)?(?:\.exe)?\b[^\r\n]*(?:requests\.(?:get|post)|urllib\.request|urlopen\s*\(|httpx\.|aiohttp\.)/i.test(
      command,
    ) ||
    /\bnode(?:\.exe)?\b[^\r\n]*\bfetch\s*\(/i.test(command)
  ) {
    return "outbound_network_command";
  }
  const dependencyCommand =
    /(?:\bpython(?:\d+(?:\.\d+)?)?(?:\.exe)?\s+-m\s+pip|\bpip\d*(?:\.exe)?)\s+(?:install|download)\b/i.test(
      command,
    ) ||
    /\b(?:conda|mamba|micromamba)(?:\.exe)?\s+(?:install|create|search)\b/i.test(
      command,
    ) ||
    /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b/i.test(command);
  if (dependencyCommand && !/\bpip\b[^\r\n]*\s--no-index\b/i.test(command)) {
    return "outbound_dependency_install";
  }
  return undefined;
}

export function allowSweCompareToolCall(input: {
  readonly tool: string;
  readonly args: unknown;
}): boolean {
  if (input.tool !== "workspace.run_shell") return true;
  const args =
    input.args && typeof input.args === "object" && !Array.isArray(input.args)
      ? (input.args as Record<string, unknown>)
      : {};
  return (
    typeof args.command !== "string" ||
    (sweCompareNetworkViolation(args.command) === undefined &&
      sweCompareLocalGoldViolation(args.command) === undefined)
  );
}

async function runClaude(opts: {
  readonly workspaceRoot: string;
  readonly goal: string;
  readonly timeoutMs: number;
}): Promise<{
  status: "completed" | "failed" | "timeout";
  terminalReason?: string;
  error?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  turns?: number;
  recoveredPatch?: string;
  trace: unknown;
}> {
  const executable = process.platform === "win32" ? "claude.cmd" : "claude";
  const child = Bun.spawn([executable, ...claudeCodeArgs(opts.goal)], {
    cwd: opts.workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, opts.timeoutMs);
  timer.unref?.();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (timedOut)
    return {
      status: "timeout",
      error: "Claude Code timed out",
      trace: { stderr: stderr.slice(0, 10_000) },
    };
  let parsed: ClaudeJsonResult | undefined;
  let trace: readonly unknown[] = [];
  try {
    const stream = parseClaudeStream(stdout);
    parsed = stream.result;
    trace = stream.trace;
  } catch {
    return {
      status: "failed",
      error: `Claude Code returned invalid JSON (exit ${exitCode}): ${stderr.slice(0, 1000)}`,
      // stdout may contain reasoning blocks before a malformed line. Never
      // persist it on parser failure; stderr is sufficient for infra triage.
      trace: { stderr: stderr.slice(0, 10_000) },
    };
  }
  const input = parsed.usage?.input_tokens ?? 0;
  const output = parsed.usage?.output_tokens ?? 0;
  const cache =
    (parsed.usage?.cache_read_input_tokens ?? 0) +
    (parsed.usage?.cache_creation_input_tokens ?? 0);
  return {
    status: exitCode === 0 && parsed.is_error !== true ? "completed" : "failed",
    terminalReason: parsed.terminal_reason,
    ...(exitCode === 0 && parsed.is_error !== true
      ? {}
      : { error: parsed.result ?? stderr.slice(0, 1000) }),
    promptTokens: input + cache,
    completionTokens: output,
    totalTokens: input + cache + output,
    turns: parsed.num_turns,
    ...(extractClaudePatchFromTrace(trace)
      ? { recoveredPatch: extractClaudePatchFromTrace(trace) }
      : {}),
    trace,
  };
}

export async function runSweCompareArm(opts: {
  readonly repoRoot: string;
  readonly manifestPath: string;
  readonly instanceId: string;
  readonly runner: SweCompareRunnerName;
  readonly keep?: boolean;
  readonly skipVerifier?: boolean;
}): Promise<SweCompareRunResult> {
  const manifest = JSON.parse(
    readFileSync(opts.manifestPath, "utf8"),
  ) as SweCompareManifest;
  if (
    manifest.protocol === "paw-only-seen-development" &&
    opts.runner !== "paw"
  ) {
    throw new Error(
      "paw-only-seen-development manifests cannot run Claude or produce paired scores",
    );
  }
  validateCompareRun(opts.repoRoot, manifest, opts.instanceId);
  const pawShellSandbox =
    opts.runner === "paw"
      ? assertPawVerificationEnvironmentReady(manifest, opts.instanceId)
      : undefined;
  const datasetPath = path.join(opts.repoRoot, manifest.dataset.localPath);
  const probe = loadLiteInstances(datasetPath).find(
    (item) => item.instance_id === opts.instanceId,
  );
  if (!probe) throw new Error(`dataset instance missing: ${opts.instanceId}`);
  const goal = buildSweCompareGoal(probe);
  const runId = `${opts.runner}-${opts.instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now().toString(36)}`;
  const gitRoot = ensureRepoClone(
    probe.repo,
    path.join(opts.repoRoot, "benchmarks", "swe-exp"),
    { fetch: false },
  );
  const workspace = createCommitWorktree(
    gitRoot,
    probe.base_commit,
    runId.slice(0, 60),
  );
  const started = new Date();
  try {
    const execution =
      opts.runner === "paw"
        ? await runPaw({
            repoRoot: opts.repoRoot,
            workspaceRoot: workspace.root,
            goal,
            runId,
            maxSteps: manifest.budget.pawMaxSteps,
            timeoutMs: manifest.budget.sharedTimeoutMs,
            verificationPolicy: pawVerificationPolicyFromManifest(manifest),
            shellSandbox: pawShellSandbox,
            initialAcceptanceCriteria: buildSweAcceptanceCriteria(probe),
          })
        : await runClaude({
            workspaceRoot: workspace.root,
            goal,
            timeoutMs: manifest.budget.sharedTimeoutMs,
          });
    const tracePath = path.join(
      "benchmarks",
      "swe-compare",
      "runs",
      runId,
      "trace.json",
    );
    // Persist the expensive agent trajectory before any post-run Git command.
    // A patch collection failure must remain an auditable infra-invalid sample
    // instead of deleting the model evidence in the surrounding finally block.
    writeJsonAtomic(path.join(opts.repoRoot, tracePath), execution.trace);
    const mutationHints = Array.isArray(execution.trace)
      ? collectTraceMutationHints({
          trace: execution.trace,
          runner: opts.runner,
          workspaceRoot: workspace.root,
        })
      : { explicitPaths: [], unknownWritePossible: true };
    const capturedPatch =
      mutationHints.explicitPaths.length === 0 &&
      !mutationHints.unknownWritePossible
        ? { diff: "" }
        : captureGitDiff(
            workspace.root,
            mutationHints.unknownWritePossible
              ? []
              : mutationHints.explicitPaths,
          );
    let replayedPawPatch: GitDiffCapture | undefined;
    if (
      capturedPatch.error &&
      opts.runner === "paw" &&
      Array.isArray(execution.trace) &&
      pawTraceHasOnlyReplayableEdits(execution.trace, mutationHints)
    ) {
      replayedPawPatch = recoverReplayablePawPatch({
        trace: execution.trace,
        hints: mutationHints,
        gitRoot,
        baseCommit: probe.base_commit,
        label: `capture-recover-${runId}`.slice(0, 60),
      });
    }
    const workspacePatch = capturedPatch.diff ?? "";
    const recoveredPatch =
      "recoveredPatch" in execution ? (execution.recoveredPatch ?? "") : "";
    const patch = capturedPatch.error
      ? (replayedPawPatch?.diff ?? "")
      : workspacePatch || recoveredPatch;
    const patchSource = workspacePatch
      ? "workspace"
      : replayedPawPatch?.diff
        ? "paw_trace_edit_replay"
        : recoveredPatch && !capturedPatch.error
          ? "claude_trace_git_diff"
          : "none";
    const artifactStatus = patch.trim()
      ? "valid"
      : capturedPatch.error
        ? "patch_collection_failed"
        : "valid";
    const executionSummary = {
      status: execution.status,
      ...(execution.terminalReason
        ? { terminalReason: execution.terminalReason }
        : {}),
      ...(execution.error ? { error: execution.error } : {}),
      ...(execution.promptTokens === undefined
        ? {}
        : { promptTokens: execution.promptTokens }),
      ...(execution.completionTokens === undefined
        ? {}
        : { completionTokens: execution.completionTokens }),
      ...(execution.totalTokens === undefined
        ? {}
        : { totalTokens: execution.totalTokens }),
      ...(execution.turns === undefined ? {} : { turns: execution.turns }),
      ...("modelCalls" in execution
        ? { modelCalls: execution.modelCalls }
        : {}),
    };
    const integrity = Array.isArray(execution.trace)
      ? opts.runner === "claude"
        ? auditClaudeTraceIntegrity(execution.trace)
        : auditPawTraceIntegrity(execution.trace)
      : { valid: true, violations: [] };
    let resolved = false;
    let resolvedSource: "swebench_harness" | "none" | "error" = "none";
    let verifier: SweCompareRunResult["verifier"];
    if (
      !opts.skipVerifier &&
      artifactStatus === "valid" &&
      patch.trim() &&
      integrity.valid
    ) {
      const predictionPath = path.join(
        opts.repoRoot,
        "benchmarks",
        "swe-compare",
        "runs",
        runId,
        "prediction.jsonl",
      );
      writePredictionsJsonl(predictionPath, [
        {
          instance_id: opts.instanceId,
          model_name_or_path: `swe-compare-${opts.runner}`,
          model_patch: patch,
        },
      ]);
      const checked = runSwebenchHarness({
        predictionsPath: predictionPath,
        instanceIds: [opts.instanceId],
        runId,
        maxWorkers: 1,
        timeoutSec: Math.max(
          600,
          Math.floor(manifest.budget.sharedTimeoutMs / 1000),
        ),
        cwd: opts.repoRoot,
      });
      resolved = checked.resolved;
      resolvedSource = checked.source;
      verifier = {
        ...(checked.reportPath ? { reportPath: checked.reportPath } : {}),
        ...(checked.detail ? { detail: checked.detail } : {}),
        ...(checked.error ? { error: checked.error } : {}),
      };
    }
    const finished = new Date();
    const result: SweCompareRunResult = {
      schemaVersion: 1,
      runId,
      runner: opts.runner,
      instanceId: opts.instanceId,
      sourceCommit: manifest.sourceTree.gitCommit,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      ...executionSummary,
      patch,
      patchChars: patch.length,
      patchSource,
      artifactStatus,
      ...(capturedPatch.error
        ? {
            patchCollectionError: replayedPawPatch?.error
              ? `${capturedPatch.error}; trace replay failed: ${replayedPawPatch.error}`
              : capturedPatch.error,
          }
        : {}),
      integrity,
      resolved,
      resolvedSource,
      ...(opts.runner === "paw"
        ? {
            verificationAuthority:
              manifest.runners.paw.verificationAuthority ?? "external",
            verificationEnvironment:
              manifest.runners.paw.verificationEnvironment ?? "host",
          }
        : {}),
      tracePath: tracePath.replace(/\\/g, "/"),
      ...(verifier ? { verifier } : {}),
    };
    writeJsonAtomic(
      path.join(
        opts.repoRoot,
        "benchmarks",
        "swe-compare",
        "runs",
        runId,
        "result.json",
      ),
      result,
    );
    return result;
  } finally {
    if (!opts.keep) workspace.cleanup();
  }
}

/** Recover Claude's final patch from successful mutations, then paired diff fallback. */
export function recoverClaudeResultPatch(opts: {
  readonly repoRoot: string;
  readonly resultPath: string;
}): SweCompareRunResult {
  const previous = JSON.parse(
    readFileSync(opts.resultPath, "utf8"),
  ) as SweCompareRunResult;
  if (previous.runner !== "claude") {
    throw new Error(
      `patch recovery only supports Claude results: ${previous.runId}`,
    );
  }
  if (
    previous.patch.trim() &&
    previous.artifactStatus !== "patch_collection_failed"
  ) {
    throw new Error(`result already contains a patch: ${previous.runId}`);
  }
  const tracePath = path.join(opts.repoRoot, previous.tracePath);
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as unknown[];
  let replayed: ReturnType<typeof replayClaudeTracePatch> = {
    error: "Claude trace has no structured mutation to replay",
  };
  const hasStructuredMutation = successfulClaudeTools(trace).some(
    (tool) => tool.name === "Edit" || tool.name === "Write",
  );
  if (hasStructuredMutation) {
    const datasetPath = path.join(
      opts.repoRoot,
      "benchmarks",
      "swe-bench",
      "swe-bench-lite.jsonl",
    );
    const probe = loadLiteInstances(datasetPath).find(
      (item) => item.instance_id === previous.instanceId,
    );
    if (!probe)
      throw new Error(`dataset instance missing: ${previous.instanceId}`);
    const gitRoot = ensureRepoClone(
      probe.repo,
      path.join(opts.repoRoot, "benchmarks", "swe-exp"),
      { fetch: false },
    );
    const workspace = createCommitWorktree(
      gitRoot,
      probe.base_commit,
      `recover-${previous.runId}`.slice(0, 60),
    );
    try {
      replayed = replayClaudeTracePatch(trace, workspace.root);
    } finally {
      workspace.cleanup();
    }
  }
  const patch = replayed.diff?.trim() || extractClaudePatchFromTrace(trace);
  if (!patch) {
    throw new Error(
      replayed.error ?? `no paired git diff result in trace: ${previous.runId}`,
    );
  }
  const replaySucceeded = !!replayed.diff?.trim();
  const updated: SweCompareRunResult = {
    ...previous,
    patch,
    patchChars: patch.length,
    patchSource: replaySucceeded
      ? "claude_trace_mutation_replay"
      : "claude_trace_git_diff",
    artifactStatus: "valid",
    patchCollectionError: undefined,
  };
  writeJsonAtomic(opts.resultPath, updated);
  return updated;
}

interface PawSuccessfulEdit {
  readonly path: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}

function successfulPawEdits(trace: readonly unknown[]): PawSuccessfulEdit[] {
  const pending: PawSuccessfulEdit[] = [];
  const successful: PawSuccessfulEdit[] = [];
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = (item as Record<string, unknown>).event;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;
    if (event.type === "tool.call" && event.tool === "workspace.edit_file") {
      const args = event.args;
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      const values = args as Record<string, unknown>;
      if (
        typeof values.path === "string" &&
        typeof values.old_string === "string" &&
        typeof values.new_string === "string"
      ) {
        pending.push({
          path: values.path,
          oldString: values.old_string,
          newString: values.new_string,
          replaceAll: values.replace_all === true,
        });
      }
      continue;
    }
    if (event.type === "tool.result" && event.tool === "workspace.edit_file") {
      const edit = pending.shift();
      if (edit && event.ok === true && edit.oldString !== edit.newString) {
        successful.push(edit);
      }
    }
  }
  return successful;
}

/**
 * Automatic recovery is narrower than the manual recovery command: every
 * material path must be explained by a successful exact edit and no shell
 * command may have an unpaired write effect.
 */
export function pawTraceHasOnlyReplayableEdits(
  trace: readonly unknown[],
  hints: TraceMutationHints,
): boolean {
  if (hints.unknownWritePossible) return false;
  const editPaths = new Set(
    successfulPawEdits(trace).map((edit) => edit.path.replace(/\\/g, "/")),
  );
  if (editPaths.size === 0) return false;
  if (!hints.explicitPaths.every((file) => editPaths.has(file))) return false;
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = (item as Record<string, unknown>).event;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;
    if (event.type !== "tool.call") continue;
    if (
      event.tool === "workspace.write_file" ||
      event.tool === "workspace.apply_patch" ||
      event.tool === "workspace.notebook_edit" ||
      event.tool === "workspace.run_agent"
    ) {
      return false;
    }
  }
  return true;
}

/** Rebuild Paw's terminal source state from paired successful exact edits. */
export function replayPawTracePatch(
  trace: readonly unknown[],
  workspaceRoot: string,
): GitDiffCapture {
  const edits = successfulPawEdits(trace);
  const deletedPaths = successfulPawDeletedPaths(trace);
  if (edits.length === 0) {
    return { error: "Paw trace has no successful edit_file events" };
  }
  const paths = new Set<string>();
  for (const edit of edits) {
    const normalized = edit.path.replace(/\\/g, "/");
    if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      return { error: `unsafe Paw edit path: ${edit.path}` };
    }
    if (deletedPaths.has(normalized)) continue;
    const replayed = editWorkspaceFile(workspaceRoot, normalized, {
      oldString: edit.oldString,
      newString: edit.newString,
      replaceAll: edit.replaceAll,
    });
    if (replayed.error) {
      return {
        error: `Paw edit replay failed for ${normalized}: ${replayed.error}`,
      };
    }
    if (replayed.changed !== true) {
      return { error: `Paw edit replay made no change: ${normalized}` };
    }
    paths.add(normalized);
  }
  if (paths.size === 0) {
    return { error: "Paw trace has no terminal replayable mutation" };
  }
  return captureGitDiff(workspaceRoot, [...paths]);
}

/** Recover a fully replayable Paw trace without risking the persisted run. */
export function recoverReplayablePawPatch(input: {
  readonly trace: readonly unknown[];
  readonly hints: TraceMutationHints;
  readonly gitRoot: string;
  readonly baseCommit: string;
  readonly label: string;
}): GitDiffCapture {
  if (!pawTraceHasOnlyReplayableEdits(input.trace, input.hints)) {
    return { error: "Paw trace contains mutations outside exact edit replay" };
  }
  try {
    const workspace = createCommitWorktree(
      input.gitRoot,
      input.baseCommit,
      input.label,
    );
    try {
      return replayPawTracePatch(input.trace, workspace.root);
    } finally {
      workspace.cleanup();
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function successfulPawDeletedPaths(trace: readonly unknown[]): Set<string> {
  const pending: string[] = [];
  const deleted = new Set<string>();
  for (const item of trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = (item as Record<string, unknown>).event;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;
    if (event.type === "tool.call" && event.tool === "workspace.run_shell") {
      const args = event.args;
      const command =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>).command
          : undefined;
      pending.push(typeof command === "string" ? command : "");
      continue;
    }
    if (event.type !== "tool.result" || event.tool !== "workspace.run_shell") {
      continue;
    }
    const command = pending.shift() ?? "";
    if (event.ok !== true) continue;
    for (const match of command.matchAll(
      /(?:^|[;&]\s*)(?:del|rm)(?:\s+-[a-z]+)*\s+([^;&\r\n]+)/gi,
    )) {
      for (const token of (match[1] ?? "").match(/"[^"]+"|'[^']+'|\S+/g) ??
        []) {
        const value = token.replace(/^(?:"|')|(?:"|')$/g, "");
        if (/^\d?>/i.test(value) || value === "nul") continue;
        const normalized = value.replace(/\\/g, "/");
        if (
          !path.isAbsolute(normalized) &&
          !normalized.split("/").includes("..")
        ) {
          deleted.add(normalized);
        }
      }
    }
  }
  return deleted;
}

/** Recover a Paw patch by replaying only paired, successful edit_file events. */
export function recoverPawResultPatch(opts: {
  readonly repoRoot: string;
  readonly resultPath: string;
  /** Recompute only a patch that was itself produced by Paw trace replay. */
  readonly replaceReplayedPatch?: boolean;
}): SweCompareRunResult {
  const previous = JSON.parse(
    readFileSync(opts.resultPath, "utf8"),
  ) as SweCompareRunResult;
  if (previous.runner !== "paw") {
    throw new Error(
      `Paw patch recovery requires a Paw result: ${previous.runId}`,
    );
  }
  if (
    previous.patch.trim() &&
    !(
      opts.replaceReplayedPatch === true &&
      previous.patchSource === "paw_trace_edit_replay"
    )
  ) {
    throw new Error(`result already contains a patch: ${previous.runId}`);
  }
  const persistedTracePath = path.isAbsolute(previous.tracePath)
    ? previous.tracePath
    : path.join(opts.repoRoot, previous.tracePath);
  const trace = JSON.parse(
    readFileSync(persistedTracePath, "utf8"),
  ) as unknown[];
  const datasetPath = path.join(
    opts.repoRoot,
    "benchmarks",
    "swe-bench",
    "swe-bench-lite.jsonl",
  );
  const probe = loadLiteInstances(datasetPath).find(
    (item) => item.instance_id === previous.instanceId,
  );
  if (!probe)
    throw new Error(`dataset instance missing: ${previous.instanceId}`);
  const gitRoot = ensureRepoClone(
    probe.repo,
    path.join(opts.repoRoot, "benchmarks", "swe-exp"),
    { fetch: false },
  );
  const workspace = createCommitWorktree(
    gitRoot,
    probe.base_commit,
    `recover-${previous.runId}`.slice(0, 60),
  );
  try {
    const captured = replayPawTracePatch(trace, workspace.root);
    if (captured.error || !captured.diff?.trim()) {
      throw new Error(
        captured.error ??
          `Paw edit replay produced no patch: ${previous.runId}`,
      );
    }
    const updated: SweCompareRunResult = {
      ...previous,
      patch: captured.diff,
      patchChars: captured.diff.length,
      patchSource: "paw_trace_edit_replay",
      artifactStatus: "valid",
      patchCollectionError: undefined,
    };
    writeJsonAtomic(opts.resultPath, updated);
    return updated;
  } finally {
    workspace.cleanup();
  }
}

/** Re-audit a persisted run after integrity rules are strengthened. */
export function auditSweCompareResult(opts: {
  readonly repoRoot: string;
  readonly resultPath: string;
}): SweCompareRunResult {
  const previous = JSON.parse(
    readFileSync(opts.resultPath, "utf8"),
  ) as SweCompareRunResult;
  const tracePath = path.join(opts.repoRoot, previous.tracePath);
  const trace = JSON.parse(readFileSync(tracePath, "utf8")) as unknown;
  const integrity = Array.isArray(trace)
    ? previous.runner === "claude"
      ? auditClaudeTraceIntegrity(trace)
      : auditPawTraceIntegrity(trace)
    : { valid: true, violations: [] };
  const updated: SweCompareRunResult = {
    ...previous,
    integrity,
    ...(integrity.valid
      ? {}
      : { resolved: false, resolvedSource: "none" as const }),
  };
  writeJsonAtomic(opts.resultPath, updated);
  return updated;
}

/** Run the official verifier against an already persisted patch, without resampling. */
export function verifySweCompareResult(opts: {
  readonly repoRoot: string;
  readonly resultPath: string;
  readonly timeoutSec?: number;
}): SweCompareRunResult {
  const previous = JSON.parse(
    readFileSync(opts.resultPath, "utf8"),
  ) as SweCompareRunResult;
  if (!previous.patch.trim()) {
    throw new Error(`cannot verify empty patch: ${previous.runId}`);
  }
  const predictionPath = path.join(
    path.dirname(opts.resultPath),
    "prediction.jsonl",
  );
  writePredictionsJsonl(predictionPath, [
    {
      instance_id: previous.instanceId,
      model_name_or_path: `swe-compare-${previous.runner}`,
      model_patch: previous.patch,
    },
  ]);
  const checked = runSwebenchHarness({
    predictionsPath: predictionPath,
    instanceIds: [previous.instanceId],
    runId: previous.runId,
    maxWorkers: 1,
    timeoutSec: opts.timeoutSec ?? 1800,
    cwd: opts.repoRoot,
  });
  const updated: SweCompareRunResult = {
    ...previous,
    resolved: checked.resolved,
    resolvedSource: checked.source,
    verifier: {
      ...(checked.reportPath ? { reportPath: checked.reportPath } : {}),
      ...(checked.detail ? { detail: checked.detail } : {}),
      ...(checked.error ? { error: checked.error } : {}),
    },
  };
  writeJsonAtomic(opts.resultPath, updated);
  return updated;
}
