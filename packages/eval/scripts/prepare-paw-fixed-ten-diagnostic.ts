#!/usr/bin/env bun

import {
  createPawFixedTenDiagnosticManifest,
  reusePawFixedTenDiagnosticPreflights,
  writeSweCompareManifest,
} from "../src/swe-compare/index.js";

const repoRoot = process.cwd();
const sourceFile = Bun.file(
  new URL(
    "../../../benchmarks/swe-compare/manifests/paw-fresh-qualification-v15.json",
    import.meta.url,
  ),
);
const sourceBytes = await sourceFile.text();
const fresh = createPawFixedTenDiagnosticManifest({ repoRoot });
const manifest = reusePawFixedTenDiagnosticPreflights({
  sourceBytes,
  fresh,
});
const fileName = "paw-fixed-ten-diagnostic-v1.json";
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
        qualification: instance.qualification,
        preflightCompleted: instance.preflight?.completed === true,
      })),
    },
    null,
    2,
  ),
);
