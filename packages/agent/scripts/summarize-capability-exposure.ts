import fs from "node:fs";
import path from "node:path";

import {
  type CapabilityExposureRunObservationV1,
  type CapabilityExposureScanFailureV1,
  parseCapabilityExposureTraceV1,
  summarizeCapabilityExposureV1,
} from "../src/capability-exposure-summary.js";

const workspaceRoot = path.resolve(process.argv[2] ?? process.cwd());
const runsRoot = path.resolve(
  process.argv[3] ??
    path.join(workspaceRoot, "benchmarks", "swe-compare", "runs"),
);
const outputPath = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
const observations: CapabilityExposureRunObservationV1[] = [];
const failures: CapabilityExposureScanFailureV1[] = [];

for (const tracePath of findFiles(runsRoot, "trace.json")) {
  try {
    const resultPath = path.join(path.dirname(tracePath), "result.json");
    observations.push(
      parseCapabilityExposureTraceV1({
        tracePath,
        traceRaw: fs.readFileSync(tracePath, "utf8"),
        resultRaw: fs.existsSync(resultPath)
          ? fs.readFileSync(resultPath, "utf8")
          : undefined,
      }),
    );
  } catch (error) {
    failures.push({
      tracePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const summary = summarizeCapabilityExposureV1(observations, failures);
const serialized = `${JSON.stringify(summary, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized, "utf8");
}
process.stdout.write(serialized);
if (!summary.shadowCoverageReady) process.exitCode = 2;

function findFiles(root: string, name: string): readonly string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name === name) found.push(target);
    }
  };
  visit(root);
  return found;
}
