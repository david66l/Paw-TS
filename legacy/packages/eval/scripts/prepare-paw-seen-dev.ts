#!/usr/bin/env bun

import {
  createPawSeenDevelopmentManifest,
  writeSweCompareManifest,
} from "../src/swe-compare/index.js";

const repoRoot = process.cwd();
const fresh = createPawSeenDevelopmentManifest({ repoRoot });
const reusable = new Map<string, (typeof fresh.instances)[number]>();
for (const name of [
  "formal-dev-v1.json",
  "smoke-v1.json",
  "paw-seen-dev-v1.json",
]) {
  try {
    const previous = JSON.parse(
      await Bun.file(
        new URL(
          `../../../benchmarks/swe-compare/manifests/${name}`,
          import.meta.url,
        ),
      ).text(),
    ) as typeof fresh;
    for (const item of previous.instances.filter(
      (entry) =>
        entry.qualification === "eligible" && entry.preflight?.completed,
    )) {
      if (!reusable.has(item.instanceId)) reusable.set(item.instanceId, item);
    }
  } catch {
    // Runtime artifacts are optional; missing/invalid candidates are ignored.
  }
}
const manifest = {
  ...fresh,
  instances: fresh.instances.map((item) => {
    const old = reusable.get(item.instanceId);
    // Preflight is a no-model official baseline check. Goal wording changes do
    // not invalidate it; repository base + problem identity do.
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
const out = writeSweCompareManifest(repoRoot, manifest, "paw-seen-dev-v1.json");
console.log(
  JSON.stringify(
    {
      manifest: out,
      protocol: manifest.protocol,
      purpose: manifest.selection.purpose,
      sourceTree: manifest.sourceTree,
      runners: { paw: manifest.runners.paw },
      instances: manifest.instances.map((instance) => ({
        instanceId: instance.instanceId,
        repo: instance.repo,
        priorLocalHistory: instance.localHistoryHits.length > 0,
        qualification: instance.qualification,
      })),
    },
    null,
    2,
  ),
);
