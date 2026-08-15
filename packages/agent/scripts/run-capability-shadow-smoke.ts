import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RunEventEnvelope } from "@paw/core";

import {
  parseCapabilityExposureTraceV1,
  summarizeCapabilityExposureV1,
} from "../src/capability-exposure-summary.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

interface Scenario {
  readonly id: string;
  readonly goal: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const scenarios: readonly Scenario[] = [
  {
    id: "list-tree",
    goal: "Inspect the workspace directory tree before planning the change.",
    tool: "workspace.list_dir",
    args: { path: ".", recursive: false },
  },
  {
    id: "git-status",
    goal: "Inspect the repository working tree status for uncommitted changes.",
    tool: "workspace.git_status",
    args: {},
  },
  {
    id: "git-history",
    goal: "Inspect recent git history to understand why the parser changed.",
    tool: "workspace.git_log",
    args: { max_count: 3 },
  },
  {
    id: "brief",
    goal: "Build a concise workspace brief before investigating the bug.",
    tool: "workspace.brief",
    args: { path: ".", max_files: 20 },
  },
  {
    id: "text-search",
    goal: "Search source text for the parseDocument implementation.",
    tool: "workspace.search",
    args: { pattern: "parseDocument", path: ".", max_results: 20 },
  },
  {
    id: "symbol-search",
    goal: "Find the parseDocument symbol definition across the project.",
    tool: "workspace.symbol_search",
    args: { query: "parseDocument", max_results: 20 },
  },
  {
    id: "language-service",
    goal: "Use language service hover information on the parser symbol.",
    tool: "workspace.lsp",
    args: { file: "src/parser.ts", method: "hover", line: 0, character: 16 },
  },
  {
    id: "glob-files",
    goal: "Find all TypeScript source files that may contain the parser.",
    tool: "workspace.glob",
    args: { pattern: "**/*.ts" },
  },
  {
    id: "grep-source",
    goal: "Grep the workspace for parseDocument references.",
    tool: "workspace.grep",
    args: { pattern: "parseDocument", path: "." },
  },
  {
    id: "read-source",
    goal: "Read the parser source before proposing a fix.",
    tool: "workspace.read_file",
    args: { path: "src/parser.ts" },
  },
];

const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
const suiteId = `deterministic-${Date.now().toString(36)}`;
const smokeRoot = path.join(
  repoRoot,
  "benchmarks",
  "swe-compare",
  "capability-shadow-smoke",
);
const suiteRoot = path.join(smokeRoot, "runs", suiteId);
const workspaceRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "paw-capability-shadow-"),
);

try {
  fs.mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, ".paw", "memory-config.json"),
    `${JSON.stringify({ enable: false }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "src", "parser.ts"),
    "export function parseDocument(value: string): string { return value.trim(); }\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "README.md"),
    "# deterministic capability shadow fixture\n",
    "utf8",
  );

  for (const scenario of scenarios) {
    const runId = `${suiteId}-${scenario.id}`;
    const events: RunEventEnvelope[] = [];
    let calls = 0;
    const orchestrator = new AgentOrchestrator({
      model: {
        label: "capability-shadow-deterministic",
        async complete() {
          calls += 1;
          return calls === 1
            ? {
                text: JSON.stringify({
                  tool: scenario.tool,
                  args: scenario.args,
                }),
              }
            : {
                text: JSON.stringify({
                  action: "final_answer",
                  summary: "Deterministic capability observation complete.",
                }),
              };
        },
      },
      onEvent: (event) => events.push(event),
      retrySleep: async () => {},
      memoryExtraction: "off",
      memoryLlm: "off",
    });
    const result = await orchestrator.run({
      runId,
      goal: scenario.goal,
      workspaceRoot,
      maxSteps: 4,
    });
    const runRoot = path.join(suiteRoot, runId);
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runRoot, "trace.json"),
      `${JSON.stringify(events, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(runRoot, "result.json"),
      `${JSON.stringify(
        {
          runId,
          runner: "paw-diagnostic",
          evidenceClass: "deterministic_smoke",
          scenarioId: scenario.id,
          intendedTool: scenario.tool,
          status: result.status,
          completionReason: result.completionReason,
          resolved: false,
          resolvedSource: "not_applicable",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  const observations = fs
    .readdirSync(suiteRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const runRoot = path.join(suiteRoot, entry.name);
      const tracePath = path.join(runRoot, "trace.json");
      return parseCapabilityExposureTraceV1({
        tracePath: path.relative(repoRoot, tracePath).replace(/\\/g, "/"),
        traceRaw: fs.readFileSync(tracePath, "utf8"),
        resultRaw: fs.readFileSync(path.join(runRoot, "result.json"), "utf8"),
      });
    });
  const summary = summarizeCapabilityExposureV1(observations);
  const summaryPath = path.join(suiteRoot, "summary.json");
  fs.writeFileSync(
    summaryPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(smokeRoot, "last-run-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        suiteId,
        summaryPath,
        structurallyValidRuns: summary.structurallyValidRuns,
        diagnosticRuns: summary.diagnosticRuns,
        qualifyingRuns: summary.qualifyingRuns,
        hitSelections: summary.hitSelections,
        fallbackSelections: summary.fallbackSelections,
        noToolSelections: summary.noToolSelections,
        outsideSuggestion: summary.outsideSuggestion,
        shadowCoverageReady: summary.shadowCoverageReady,
        hardActivationReady: summary.hardActivationReady,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}
