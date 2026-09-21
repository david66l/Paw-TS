#!/usr/bin/env bun

import {
  createSweCompareManifest,
  writeSweCompareManifest,
} from "../src/swe-compare/index.js";

const repoRoot = process.cwd();
const fresh = createSweCompareManifest({ repoRoot });
const manifestPath = new URL(
  "../../../benchmarks/swe-compare/manifests/formal-dev-v1.json",
  import.meta.url,
);
let manifest = fresh;
const reusable = new Map<string, (typeof fresh.instances)[number]>();
for (const candidate of [
  manifestPath,
  new URL(
    "../../../benchmarks/swe-compare/manifests/smoke-v1.json",
    import.meta.url,
  ),
]) {
  try {
    const previous = JSON.parse(
      await Bun.file(candidate).text(),
    ) as typeof fresh;
    for (const item of previous.instances.filter((entry) => entry.preflight)) {
      if (!reusable.has(item.instanceId)) reusable.set(item.instanceId, item);
    }
  } catch {
    // Missing or invalid runtime artifact: continue to the next source.
  }
}
if (reusable.size > 0) {
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
