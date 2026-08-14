import { readFileSync } from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "../swe-exp/checkpoint.js";
import {
  runSwebenchHarness,
  writePredictionsJsonl,
} from "../swe-exp/evaluate.js";
import type { SweCompareManifest } from "./types.js";

/** A valid, product-neutral patch that forces the official harness to run. */
export const PREFLIGHT_SENTINEL_PATCH = [
  "diff --git a/.swe-preflight-sentinel b/.swe-preflight-sentinel",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/.swe-preflight-sentinel",
  "@@ -0,0 +1 @@",
  "+infrastructure preflight only",
  "",
].join("\n");

interface OfficialSummary {
  readonly completed_ids?: readonly string[];
  readonly resolved_ids?: readonly string[];
  readonly empty_patch_ids?: readonly string[];
  readonly error_ids?: readonly string[];
}

function includesId(value: readonly string[] | undefined, id: string): boolean {
  return value?.includes(id) === true;
}

export function interpretPreflightSummary(
  instanceId: string,
  reportPath: string,
): {
  readonly eligible: boolean;
  readonly completed: boolean;
  readonly baselineResolved: boolean;
  readonly emptyPatch: boolean;
  readonly harnessError: boolean;
} {
  const summary = JSON.parse(
    readFileSync(reportPath, "utf8"),
  ) as OfficialSummary;
  const completed = includesId(summary.completed_ids, instanceId);
  const baselineResolved = includesId(summary.resolved_ids, instanceId);
  const emptyPatch = includesId(summary.empty_patch_ids, instanceId);
  const harnessError = includesId(summary.error_ids, instanceId);
  return {
    eligible: completed && !baselineResolved && !emptyPatch && !harnessError,
    completed,
    baselineResolved,
    emptyPatch,
    harnessError,
  };
}

export function preflightSweCompareInstance(opts: {
  readonly repoRoot: string;
  readonly manifestPath: string;
  readonly instanceId: string;
  readonly timeoutSec?: number;
  readonly now?: () => Date;
}): SweCompareManifest {
  const manifest = JSON.parse(
    readFileSync(opts.manifestPath, "utf8"),
  ) as SweCompareManifest;
  const target = manifest.instances.find(
    (instance) => instance.instanceId === opts.instanceId,
  );
  if (!target) throw new Error(`instance not in manifest: ${opts.instanceId}`);
  const safeId = opts.instanceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const predictionPath = path.join(
    opts.repoRoot,
    "benchmarks",
    "swe-compare",
    "preflight",
    `${safeId}.jsonl`,
  );
  writePredictionsJsonl(predictionPath, [
    {
      instance_id: opts.instanceId,
      model_name_or_path: "swe-compare-preflight-sentinel",
      model_patch: PREFLIGHT_SENTINEL_PATCH,
    },
  ]);
  const runId = `swecompare-preflight-${safeId}-${Date.now().toString(36)}`;
  const result = runSwebenchHarness({
    predictionsPath: predictionPath,
    instanceIds: [opts.instanceId],
    runId,
    maxWorkers: 1,
    timeoutSec: opts.timeoutSec ?? 3600,
    cwd: opts.repoRoot,
    ...(manifest.runners.paw.verificationEnvironment === "instance_image"
      ? { cacheLevel: "instance" as const, cleanImages: false }
      : {}),
  });
  let qualification: "eligible" | "infra_excluded" = "infra_excluded";
  let completed = false;
  let baselineResolved = result.resolved;
  let emptyPatch = false;
  let harnessError = result.source === "error";
  if (result.reportPath) {
    const interpreted = interpretPreflightSummary(
      opts.instanceId,
      result.reportPath,
    );
    qualification = interpreted.eligible ? "eligible" : "infra_excluded";
    completed = interpreted.completed;
    baselineResolved = interpreted.baselineResolved;
    emptyPatch = interpreted.emptyPatch;
    harnessError = interpreted.harnessError;
  }
  const updated: SweCompareManifest = {
    ...manifest,
    instances: manifest.instances.map((instance) =>
      instance.instanceId === opts.instanceId
        ? {
            ...instance,
            qualification,
            preflight: {
              checkedAt: (opts.now ?? (() => new Date()))().toISOString(),
              runId,
              source:
                result.source === "swebench_harness"
                  ? "swebench_harness"
                  : "error",
              baselineResolved,
              completed,
              emptyPatch,
              harnessError,
              ...(result.detail ? { detail: result.detail } : {}),
              ...(result.error ? { error: result.error } : {}),
            },
          }
        : instance,
    ),
  };
  writeJsonAtomic(opts.manifestPath, updated);
  return updated;
}
