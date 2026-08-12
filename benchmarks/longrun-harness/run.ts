#!/usr/bin/env bun
/**
 * Long-run harness (greenfield app) — Anthropic-style multi-session outer loop.
 *
 * Usage:
 *   bun run benchmarks/longrun-harness/run.ts --preset todo-mini
 *   bun run benchmarks/longrun-harness/run.ts --preset todo-mini --max-sessions 2 --max-wall-ms 600000
 *   bun run benchmarks/longrun-harness/run.ts --preset todo-mini --verify-only
 *   bun run benchmarks/longrun-harness/run.ts --preset todo-mini --headed
 *
 * Requires: DATABASE_URL optional; model via .paw/settings.local.json
 * Playwright: bun add -d playwright && bunx playwright install chromium
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runStubRun } from "../../packages/agent/src/stub-run.ts";
import {
  appendProgressSession,
  auditFeatureLedger,
  artifactPaths,
  countPassing,
  countRemaining,
  ensureWorkspace,
  hasFeatureList,
  loadHarnessLedger,
  loadFeatureList,
  nextOpenFeature,
  saveHarnessLedger,
  writeInitialProgress,
  type FeatureItem,
} from "./artifacts.ts";
import { buildCodingGoal, buildInitializerGoal } from "./prompts.ts";
import {
  captureProgressSnapshot,
  evaluateProgressDelta,
} from "./progress.ts";
import {
  reconcilePassesWithE2e,
  verifyFeaturesE2e,
} from "./verify-e2e.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

const repoRoot = path.resolve(import.meta.dir, "../..");
const preset = arg("--preset") ?? "todo-mini";
const maxSessions = Number(arg("--max-sessions") ?? "24");
const maxWallMs = Number(arg("--max-wall-ms") ?? String(4 * 60 * 60 * 1000));
const maxSteps = Number(arg("--max-steps") ?? "48");
const maxAttemptsPerFeature = Number(arg("--max-attempts-per-feature") ?? "3");
const maxNoProgressSessions = Number(arg("--max-no-progress-sessions") ?? "2");
const verifyOnly = flag("--verify-only");
const headed = flag("--headed");
const skipE2e = flag("--skip-e2e");
const seedReference = flag("--seed-reference");
const workspaceRoot = path.resolve(
  arg("--workspace") ??
    path.join(repoRoot, "benchmarks/longrun-harness/.workspace", preset),
);

const fixtureDir = path.join(
  import.meta.dir,
  "fixtures",
  preset === "todo-mini" ? "todo-mini" : preset,
);

function seedPreset(): void {
  ensureWorkspace(workspaceRoot);
  const paths = artifactPaths(workspaceRoot);
  if (!existsSync(paths.appSpecPath)) {
    copyFileSync(path.join(fixtureDir, "app_spec.txt"), paths.appSpecPath);
  }
  if (!hasFeatureList(workspaceRoot)) {
    copyFileSync(
      path.join(fixtureDir, "feature_list.json"),
      paths.featureListPath,
    );
  }
  writeInitialProgress(workspaceRoot);

  if (seedReference) {
    const ref = path.join(fixtureDir, "reference-app", "index.html");
    if (existsSync(ref)) {
      copyFileSync(ref, path.join(workspaceRoot, "index.html"));
      writeFileSync(
        path.join(workspaceRoot, "package.json"),
        `${JSON.stringify(
          {
            name: "todo-mini-reference",
            private: true,
            scripts: {
              // static file server for Playwright
              start: "bun x serve -l 5173 .",
              dev: "bun x serve -l 5173 .",
            },
          },
          null,
          2,
        )}\n`,
      );
    }
  }
}

function gitOk(cwd: string, args: string[]): boolean {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0;
}

function ensureGit(cwd: string): void {
  if (!existsSync(path.join(cwd, ".git"))) {
    gitOk(cwd, ["init"]);
    gitOk(cwd, ["config", "user.email", "paw-longrun@local"]);
    gitOk(cwd, ["config", "user.name", "paw-longrun"]);
  }
  const excludePath = path.join(cwd, ".git", "info", "exclude");
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  const harnessExcludes = ["feature_list.json", ".paw/", ".paw-e2e-last.json"];
  const missing = harnessExcludes.filter(
    (entry) => !existing.split(/\r?\n/).includes(entry),
  );
  if (missing.length > 0) {
    appendFileSync(
      excludePath,
      `${existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
      "utf8",
    );
  }
}

function auditVisibleLedger(
  canonical: readonly FeatureItem[],
): ReturnType<typeof auditFeatureLedger> {
  try {
    return auditFeatureLedger(canonical, loadFeatureList(workspaceRoot));
  } catch (error) {
    return {
      changedPassClaims: [],
      contractViolations: [
        `feature_list.json unreadable: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

/** Keep the cross-session ledger bounded without cutting JSON mid-token. */
function progressSummary(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const evidence =
      parsed.evidence && typeof parsed.evidence === "object"
        ? (parsed.evidence as Record<string, unknown>)
        : undefined;
    const compact = {
      runId: parsed.runId,
      status: parsed.status,
      message:
        typeof parsed.message === "string"
          ? parsed.message.slice(0, 1200)
          : parsed.message,
      outcome: parsed.outcome,
      completionReason: parsed.completionReason,
      evidence: evidence
        ? {
            filesChanged: Array.isArray(evidence.filesChanged)
              ? evidence.filesChanged.slice(-16)
              : [],
            tests: Array.isArray(evidence.testResults)
              ? evidence.testResults.slice(-8)
              : [],
            recentCommands: Array.isArray(evidence.commandsRun)
              ? evidence.commandsRun.slice(-5)
              : [],
          }
        : undefined,
    };
    const detailed = JSON.stringify(compact, null, 2);
    if (detailed.length <= 4000) return detailed;
    // Still valid JSON if command details are unusually large.
    return JSON.stringify(
      {
        ...compact,
        evidence: evidence
          ? {
              filesChanged: Array.isArray(evidence.filesChanged)
                ? evidence.filesChanged.slice(-16)
                : [],
              testCount: Array.isArray(evidence.testResults)
                ? evidence.testResults.length
                : 0,
              commandCount: Array.isArray(evidence.commandsRun)
                ? evidence.commandsRun.length
                : 0,
            }
          : undefined,
      },
      null,
      2,
    );
  } catch {
    return raw.length <= 4000 ? raw : `${raw.slice(0, 3990)}\n…`;
  }
}

async function runAgentSession(opts: {
  readonly role: "initializer" | "coding";
  readonly sessionIndex: number;
  readonly goal: string;
  readonly featureId?: string;
}): Promise<{ ok: boolean; text: string; status: string }> {
  const r = await runStubRun(opts.goal, {
    workspaceRoot,
    maxSteps,
    autonomy: "headless",
    collaborationMode: "coding",
    resumeSession: false,
    runId: `longrun-${preset}-s${opts.sessionIndex}-${opts.role}`,
  });
  const status = r.ok ? "ok" : `exit_${r.exitCode}`;
  appendProgressSession(workspaceRoot, {
    sessionIndex: opts.sessionIndex,
    role: opts.role,
    summary: progressSummary(r.text),
    featureId: opts.featureId,
    status,
  });
  return { ok: r.ok, text: r.text, status };
}

async function e2eAndReconcile(
  features: FeatureItem[],
  onlyIds?: string[],
): Promise<{
  features: FeatureItem[];
  e2eOk: boolean;
  flipped: string[];
  verifiedToPass: string[];
  results: { id: string; ok: boolean; error?: string }[];
}> {
  if (skipE2e) {
    return {
      features,
      e2eOk: true,
      flipped: [],
      verifiedToPass: [],
      results: [],
    };
  }
  const report = await verifyFeaturesE2e({
    workspaceRoot,
    features,
    onlyIds,
    headed,
  });
  const {
    features: next,
    flippedToFail,
    verifiedToPass,
  } = reconcilePassesWithE2e(features, report);
  saveHarnessLedger(workspaceRoot, next);
  return {
    features: next,
    e2eOk: report.ok,
    flipped: flippedToFail,
    verifiedToPass,
    results: [...report.results],
  };
}

async function main(): Promise<void> {
  if (!existsSync(fixtureDir)) {
    throw new Error(`Unknown preset / missing fixture: ${fixtureDir}`);
  }

  seedPreset();
  ensureGit(workspaceRoot);
  mkdirSync(path.join(import.meta.dir, "runs"), { recursive: true });

  const t0 = Date.now();
  const sessions: Array<Record<string, unknown>> = [];
  let canonicalFeatures = loadHarnessLedger(workspaceRoot);
  let ledgerPassClaims = 0;
  let ledgerContractViolations = 0;
  let noProgressSessions = 0;

  if (verifyOnly) {
    const features = canonicalFeatures;
    const rec = await e2eAndReconcile(features);
    const report = {
      mode: "verify-only",
      workspaceRoot,
      preset,
      elapsedMs: Date.now() - t0,
      passing: countPassing(rec.features),
      remaining: countRemaining(rec.features),
      e2e: rec.results,
      flippedToFail: rec.flipped,
      verifiedToPass: rec.verifiedToPass,
    };
    const out = path.join(
      import.meta.dir,
      "runs",
      `verify-${preset}-${Date.now()}.json`,
    );
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(
      rec.e2eOk && countRemaining(rec.features) === 0 ? 0 : 1,
    );
  }

  let sessionIndex = 0;
  const attemptsByFeature = new Map<string, number>();
  const lastFailureByFeature = new Map<string, string>();
  const noProgressByFeature = new Map<string, number>();
  const blockedFeatureIds = new Set<string>();

  // Session 1: initializer if scaffold missing (no package.json yet)
  const needsInit = !existsSync(path.join(workspaceRoot, "package.json"));
  if (needsInit) {
    sessionIndex += 1;
    console.error(`[longrun] session ${sessionIndex} initializer`);
    const init = await runAgentSession({
      role: "initializer",
      sessionIndex,
      goal: buildInitializerGoal({ workspaceRoot }),
    });
    const initLedgerAudit = auditVisibleLedger(canonicalFeatures);
    ledgerPassClaims += initLedgerAudit.changedPassClaims.length;
    ledgerContractViolations += initLedgerAudit.contractViolations.length;
    saveHarnessLedger(workspaceRoot, canonicalFeatures);
    sessions.push({
      sessionIndex,
      role: "initializer",
      ...init,
      ledgerAudit: initLedgerAudit,
      elapsedMs: Date.now() - t0,
    });
  }

  while (sessionIndex < maxSessions && Date.now() - t0 < maxWallMs) {
    let features = canonicalFeatures;
    const remaining = countRemaining(features);
    if (remaining === 0) {
      console.error("[longrun] all features passing (list); running full E2E");
      const rec = await e2eAndReconcile(features);
      features = rec.features;
      canonicalFeatures = rec.features;
      if (countRemaining(features) === 0) break;
    }

    const feature = nextOpenFeature(
      features,
      features.filter((f) => !blockedFeatureIds.has(f.id)).map((f) => f.id),
    );
    if (!feature) break;

    const attempts = (attemptsByFeature.get(feature.id) ?? 0) + 1;
    attemptsByFeature.set(feature.id, attempts);

    sessionIndex += 1;
    console.error(
      `[longrun] session ${sessionIndex} coding feature=${feature.id} remaining=${remaining}`,
    );
    const progressBefore = captureProgressSnapshot(workspaceRoot);
    const coding = await runAgentSession({
      role: "coding",
      sessionIndex,
      goal: buildCodingGoal({
        feature,
        remaining: countRemaining(features),
        total: features.length,
        workspaceRoot,
        priorFailure: lastFailureByFeature.get(feature.id),
      }),
      featureId: feature.id,
    });

    const ledgerAudit = auditVisibleLedger(canonicalFeatures);
    ledgerPassClaims += ledgerAudit.changedPassClaims.length;
    ledgerContractViolations += ledgerAudit.contractViolations.length;
    // Agent writes are claims only. Restore canonical data before the outer
    // verifier is allowed to update pass/fail.
    saveHarnessLedger(workspaceRoot, canonicalFeatures);
    const rec = await e2eAndReconcile(canonicalFeatures, [feature.id]);
    canonicalFeatures = rec.features;
    const currentResult = rec.results.find((r) => r.id === feature.id);
    const progressAfter = captureProgressSnapshot(workspaceRoot);
    const progress = evaluateProgressDelta({
      before: progressBefore,
      after: progressAfter,
      targetE2ePassed: currentResult?.ok === true,
    });
    if (!progress.progressed) noProgressSessions += 1;
    sessions.push({
      sessionIndex,
      role: "coding",
      featureId: feature.id,
      agentOk: coding.ok,
      e2e: rec.results,
      flippedToFail: rec.flipped,
      verifiedToPass: rec.verifiedToPass,
      passing: countPassing(rec.features),
      remaining: countRemaining(rec.features),
      attempt: attempts,
      ledgerAudit,
      progress,
    });

    if (currentResult?.ok) {
      attemptsByFeature.delete(feature.id);
      lastFailureByFeature.delete(feature.id);
      blockedFeatureIds.delete(feature.id);
      noProgressByFeature.delete(feature.id);
    } else {
      const evidence = currentResult?.error ??
        `agent status ${coding.status}; target E2E did not pass`;
      lastFailureByFeature.set(feature.id, evidence.slice(0, 2000));
      const noProgress = progress.progressed
        ? 0
        : (noProgressByFeature.get(feature.id) ?? 0) + 1;
      noProgressByFeature.set(feature.id, noProgress);
      if (
        attempts >= maxAttemptsPerFeature ||
        noProgress >= maxNoProgressSessions
      ) {
        blockedFeatureIds.add(feature.id);
        console.error(
          `[longrun] feature=${feature.id} stalled attempts=${attempts} noProgress=${noProgress}; moving to another open feature`,
        );
      }
    }

    // no progress fuse: if still failing same feature after session, continue once more then stop? keep going until wall/session budget
    if (Date.now() - t0 >= maxWallMs) break;
  }

  const finalFeatures = canonicalFeatures;
  const finalE2e = skipE2e
    ? {
        results: [],
        e2eOk: true,
        flipped: [],
        verifiedToPass: [],
        features: finalFeatures,
      }
    : await e2eAndReconcile(finalFeatures);

  const report = {
    suite: "longrun-harness",
    preset,
    workspaceRoot,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    sessions,
    metrics: {
      sessionCount: sessionIndex,
      passing: countPassing(finalE2e.features),
      remaining: countRemaining(finalE2e.features),
      total: finalE2e.features.length,
      e2eOk: finalE2e.e2eOk,
      flippedToFail: finalE2e.flipped,
      stalledFeatures: [...blockedFeatureIds],
      noProgressSessions,
      ledgerPassClaims,
      ledgerContractViolations,
      noProgressByFeature: Object.fromEntries(noProgressByFeature),
    },
    e2e: finalE2e.results,
    passed:
      countRemaining(finalE2e.features) === 0 &&
      finalE2e.e2eOk &&
      finalE2e.features.length > 0,
  };

  const out = path.join(
    import.meta.dir,
    "runs",
    `${preset}-${Date.now()}.json`,
  );
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  // also last-run
  writeFileSync(
    path.join(import.meta.dir, "last-run.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}

await main();
