#!/usr/bin/env bun

import {
  createPawFreshQualificationManifest,
  writeSweCompareManifest,
} from "../src/swe-compare/index.js";

const repoRoot = process.cwd();
const fileName = "paw-fresh-qualification-v14.json";
const fresh = createPawFreshQualificationManifest({ repoRoot });
let previous: typeof fresh | undefined;
for (const candidate of [
  fileName,
  "paw-fresh-qualification-v13.json",
  "paw-fresh-qualification-v12.json",
  "paw-fresh-qualification-v11.json",
  "paw-fresh-qualification-v10.json",
  "paw-fresh-qualification-v9.json",
  "paw-fresh-qualification-v8.json",
  "paw-fresh-qualification-v7.json",
  "paw-fresh-qualification-v6.json",
  "paw-fresh-qualification-v5.json",
  "paw-fresh-qualification-v4.json",
  "paw-fresh-qualification-v3.json",
]) {
  try {
    previous = JSON.parse(
      await Bun.file(
        new URL(
          `../../../benchmarks/swe-compare/manifests/${candidate}`,
          import.meta.url,
        ),
      ).text(),
    ) as typeof fresh;
    break;
  } catch {
    // Try the prior prefix manifest before declaring a first freeze.
  }
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
const out = writeSweCompareManifest(repoRoot, manifest, fileName);
console.log(
  JSON.stringify(
    {
      manifest: out,
      protocol: manifest.protocol,
      purpose: manifest.selection.purpose,
      selection: manifest.selection,
      sourceTree: manifest.sourceTree,
      budget: manifest.budget,
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
