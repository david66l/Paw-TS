#!/usr/bin/env bun
/**
 * Sequential workspace typecheck.
 *
 * `bun run --filter '*' typecheck` runs every workspace member in parallel. With
 * 23 members that is 23 concurrent `tsc` processes, which exhausts memory on a
 * developer machine (observed: OutOfMemoryException / aborted runs). This runs
 * them one at a time instead, while still covering *every* member: the previous
 * hand-maintained chain of 21 `typecheck:*` scripts had silently omitted
 * `@paw/progress-advisor` and `@paw/desktop`.
 *
 * Each package's own `typecheck` script stays the single source of truth, so a
 * package that changes its tsconfig needs no change here.
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const groups = ["packages", "apps"] as const;

type Target = { readonly name: string; readonly dir: string };
const targets: Target[] = [];

for (const group of groups) {
  const groupDir = path.join(root, group);
  if (!fs.existsSync(groupDir)) continue;
  for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(groupDir, entry.name);
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) continue;
    let json: { name?: string; scripts?: Record<string, string> };
    try {
      json = JSON.parse(fs.readFileSync(manifest, "utf8")) as typeof json;
    } catch {
      continue;
    }
    if (!json.scripts?.typecheck) continue;
    targets.push({ name: json.name ?? entry.name, dir });
  }
}

targets.sort((a, b) => a.name.localeCompare(b.name));
if (targets.length === 0) {
  console.error("typecheck: no workspace package declares a `typecheck` script");
  process.exit(1);
}

const failures: string[] = [];
for (const target of targets) {
  const started = Date.now();
  const result = Bun.spawnSync(["bun", "run", "typecheck"], {
    cwd: target.dir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const elapsed = Date.now() - started;
  if (result.exitCode !== 0) {
    failures.push(target.name);
    console.error(`\nFAIL  ${target.name}  (${elapsed}ms)`);
    // Fail fast: a later package usually depends on this one, so its errors
    // would be noise rather than signal.
    break;
  }
  console.log(`ok    ${target.name}  (${elapsed}ms)`);
}

if (failures.length > 0) {
  console.error(`\ntypecheck failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\ntypecheck passed for ${targets.length} workspace packages`);
