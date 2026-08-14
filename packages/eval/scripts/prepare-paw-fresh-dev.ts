#!/usr/bin/env bun

import {
  createPawFreshDevelopmentManifest,
  writeSweCompareManifest,
} from "../src/swe-compare/index.js";

const repoRoot = process.cwd();
const fresh = createPawFreshDevelopmentManifest({ repoRoot });
let previous: typeof fresh | undefined;
try {
  previous = JSON.parse(
    await Bun.file(
      new URL(
        "../../../benchmarks/swe-compare/manifests/paw-fresh-dev-v2.json",
        import.meta.url,
      ),
    ).text(),
  ) as typeof fresh;
} catch {
  // First freeze has no reusable no-model preflight results.
}
const reusable = new Map(
  (previous?.instances ?? [])
    .filter(
      (entry) =>
        entry.qualification === "eligible" && entry.preflight?.completed,
    )
    .map((entry) => [entry.instanceId, entry]),
);
const manifest = {
  ...fresh,
  instances: fresh.instances.map((item) => {
    const old = reusable.get(item.instanceId);
    return old &&
      old.baseCommit === item.baseCommit &&
      old.problemStatementSha256 === item.problemStatementSha256
      ? {
          ...item,
          qualification: old.qualification,
          preflight: old.preflight,
        }
      : item;
  }),
};
const out = writeSweCompareManifest(
  repoRoot,
  manifest,
  "paw-fresh-dev-v2.json",
);
console.log(
  JSON.stringify(
    {
      manifest: out,
      protocol: manifest.protocol,
      purpose: manifest.selection.purpose,
      selection: manifest.selection,
      sourceTree: manifest.sourceTree,
      runner: manifest.runners.paw,
      instances: manifest.instances.map((instance) => ({
        instanceId: instance.instanceId,
        repo: instance.repo,
        failToPassCount: instance.failToPassCount,
        passToPassCount: instance.passToPassCount,
        priorLocalHistory: instance.localHistoryHits.length > 0,
        qualification: instance.qualification,
      })),
    },
    null,
    2,
  ),
);
