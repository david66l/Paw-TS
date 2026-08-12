#!/usr/bin/env bun

import {
  createSweCompareManifest,
  writeSweCompareManifest,
} from "../src/swe-compare/index.js";

const repoRoot = process.cwd();
const fresh = createSweCompareManifest({ repoRoot });
const manifestPath = new URL(
  "../../../benchmarks/swe-compare/manifests/smoke-v1.json",
  import.meta.url,
);
let manifest = fresh;
try {
  const previous = JSON.parse(
    await Bun.file(manifestPath).text(),
  ) as typeof fresh;
  const reusable = new Map(
    previous.instances
      .filter((item) => item.preflight)
      .map((item) => [item.instanceId, item] as const),
  );
  manifest = {
    ...fresh,
    instances: fresh.instances.map((item) => {
      const old = reusable.get(item.instanceId);
      return old &&
        old.baseCommit === item.baseCommit &&
        old.problemStatementSha256 === item.problemStatementSha256 &&
        old.goalSha256 === item.goalSha256
        ? {
            ...item,
            qualification: old.qualification,
            preflight: old.preflight,
          }
        : item;
    }),
  };
} catch {
  // First run or invalid prior runtime artifact: create a static manifest.
}
const out = writeSweCompareManifest(repoRoot, manifest);
console.log(
  JSON.stringify(
    {
      manifest: out,
      dataset: manifest.dataset,
      sourceTree: manifest.sourceTree,
      runners: manifest.runners,
      instances: manifest.instances.map((instance) => ({
        instanceId: instance.instanceId,
        repo: instance.repo,
        qualification: instance.qualification,
      })),
    },
    null,
    2,
  ),
);
