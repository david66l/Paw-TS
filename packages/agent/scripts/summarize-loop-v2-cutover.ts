import fs from "node:fs";
import path from "node:path";

import {
  type LoopV2CutoverObservationV1,
  type LoopV2CutoverScanFailureV1,
  parseLoopV2LiveCandidateArtifactV1,
  parseLoopV2LiveReviewArtifactV1,
  parseLoopV2LiveTerminalArtifactV1,
  parseLoopV2RunResultShadowArtifactV1,
  summarizeLoopV2CutoverV1,
} from "../src/loop-v2/index.js";

const workspaceRoot = path.resolve(process.argv[2] ?? process.cwd());
const runsRoot = path.join(workspaceRoot, ".paw", "loop-v2", "runs");
const observations: LoopV2CutoverObservationV1[] = [];
const failures: LoopV2CutoverScanFailureV1[] = [];

for (const entry of readRunDirectories(runsRoot)) {
  const runDirectory = path.join(runsRoot, entry);
  try {
    const terminalRaw = readRequiredBySuffix(runDirectory, "terminal-v1.json");
    const candidateRaw = readOptionalBySuffix(
      runDirectory,
      "candidate-v1.json",
    );
    const candidate = candidateRaw
      ? parseLoopV2LiveCandidateArtifactV1(candidateRaw)
      : undefined;
    const reviewRaw = readOptionalBySuffix(runDirectory, "review-v1.json");
    const review = reviewRaw
      ? candidate
        ? parseLoopV2LiveReviewArtifactV1(reviewRaw, candidate)
        : (() => {
            throw new Error("review-v1.json exists without candidate-v1.json");
          })()
      : undefined;
    const terminal = parseLoopV2LiveTerminalArtifactV1(
      terminalRaw,
      candidate,
      review,
    );
    const shadowRaw = readRequiredBySuffix(
      runDirectory,
      "run-result-shadow-v1.json",
    );
    const shadow = parseLoopV2RunResultShadowArtifactV1(
      shadowRaw,
      terminal,
      candidate,
      review,
    );
    observations.push({
      runId: terminal.runId,
      terminalComparison: terminal.comparison,
      eligibility: shadow.eligibility,
      cutoverReady: shadow.comparison.cutoverReady,
    });
  } catch (error) {
    failures.push({
      runDirectory,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const summary = summarizeLoopV2CutoverV1(observations, failures);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.controlledCutoverEvidenceReady) process.exitCode = 2;

function readRunDirectories(root: string): readonly string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function readRequiredBySuffix(directory: string, suffix: string): string {
  const target = path.join(directory, suffix);
  if (!fs.existsSync(target)) throw new Error(`Missing ${suffix}`);
  return fs.readFileSync(target, "utf8");
}

function readOptionalBySuffix(
  directory: string,
  suffix: string,
): string | undefined {
  const target = path.join(directory, suffix);
  return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined;
}
