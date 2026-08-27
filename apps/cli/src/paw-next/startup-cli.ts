import fs from "node:fs";
import path from "node:path";

import { createPawNextProductProfileResolverV1 } from "./product-profile.js";
import {
  type PawNextStartupRunStatusV1,
  scanAndResumePawNextRunsV1,
} from "./startup-scan.js";

export const PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1 =
  "paw.next-startup-cli-report.v1" as const;

export type PawNextStartupCliExitCodeV1 = 0 | 1 | 2;

export interface PawNextStartupCliResultV1 {
  readonly exitCode: PawNextStartupCliExitCodeV1;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

interface PawNextStartupCliReportV1 {
  readonly schemaVersion: typeof PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1;
  readonly mode: "once";
  readonly workspaceRoot: string;
  readonly configurationIssue?: {
    readonly code: "profile_configuration_unavailable";
  };
  readonly executionIssue?: {
    readonly reasonCode: "startup_scan_failed";
  };
  readonly authorityIssues: readonly {
    readonly entryName: string;
    readonly reasonCode: string;
  }[];
  readonly runs: readonly {
    readonly sessionId: string;
    readonly runId: string;
    readonly status: PawNextStartupRunStatusV1;
    readonly inputIds?: readonly string[];
    readonly tailSeq?: number;
    readonly reasonCode?: string;
  }[];
}

const ATTENTION_STATUSES = new Set<PawNextStartupRunStatusV1>([
  "config_unavailable",
  "invalid",
  "ambiguous_session",
  "busy",
  "anchor_conflict",
  "inventory_stale",
  "failed",
]);

/** One explicit CLI invocation. It has no retry, timer, or persisted scan state. */
export async function runPawNextStartupCliV1(
  args: readonly string[],
): Promise<PawNextStartupCliResultV1> {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return result(2, "stderr", startupUsage());
  }
  const requestedRoot = path.normalize(parsed.workspaceRoot);
  let workspaceRoot: string;
  try {
    workspaceRoot = fs.realpathSync.native(requestedRoot);
    const rootStat = fs.lstatSync(workspaceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("workspace root is not a real directory");
    }
  } catch {
    const report = executionFailureReport(requestedRoot, false);
    return result(1, "stdout", stableJson(report));
  }

  let configurationIssue = false;
  let resolver: ReturnType<typeof createPawNextProductProfileResolverV1>;
  try {
    resolver = createPawNextProductProfileResolverV1({
      workspaceRoot,
    });
  } catch {
    configurationIssue = true;
    resolver = () => undefined;
  }

  try {
    const scan = await scanAndResumePawNextRunsV1({
      workspaceRoot,
      resolveOptions: resolver,
    });
    const report = Object.freeze({
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1,
      mode: "once" as const,
      workspaceRoot,
      ...(configurationIssue
        ? {
            configurationIssue: Object.freeze({
              code: "profile_configuration_unavailable" as const,
            }),
          }
        : {}),
      authorityIssues: Object.freeze(
        scan.issues.map((issue) =>
          Object.freeze({
            entryName: issue.entryName,
            reasonCode: issue.reason,
          }),
        ),
      ),
      runs: Object.freeze(
        scan.runs.map((run) =>
          Object.freeze({
            sessionId: run.sessionId,
            runId: run.runId,
            status: run.status,
            ...(run.inputIds === undefined
              ? {}
              : { inputIds: Object.freeze([...run.inputIds]) }),
            ...(run.tailSeq === undefined ? {} : { tailSeq: run.tailSeq }),
            ...(ATTENTION_STATUSES.has(run.status)
              ? { reasonCode: `run_${run.status}` }
              : {}),
          }),
        ),
      ),
    }) satisfies PawNextStartupCliReportV1;
    const attention =
      configurationIssue ||
      report.authorityIssues.length > 0 ||
      report.runs.some((run) => ATTENTION_STATUSES.has(run.status));
    return result(attention ? 1 : 0, "stdout", stableJson(report));
  } catch {
    const report = executionFailureReport(workspaceRoot, configurationIssue);
    return result(1, "stdout", stableJson(report));
  }
}

function executionFailureReport(
  workspaceRoot: string,
  configurationIssue: boolean,
): PawNextStartupCliReportV1 {
  return Object.freeze({
    schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1,
    mode: "once" as const,
    workspaceRoot,
    ...(configurationIssue
      ? {
          configurationIssue: Object.freeze({
            code: "profile_configuration_unavailable" as const,
          }),
        }
      : {}),
    executionIssue: Object.freeze({
      reasonCode: "startup_scan_failed" as const,
    }),
    authorityIssues: Object.freeze([]),
    runs: Object.freeze([]),
  });
}

function parseArgs(
  args: readonly string[],
): Readonly<{ ok: true; workspaceRoot: string }> | Readonly<{ ok: false }> {
  if (
    args.length !== 3 ||
    args[0] !== "--startup-scan" ||
    args[1] !== "--root" ||
    typeof args[2] !== "string" ||
    !args[2].trim() ||
    !path.isAbsolute(args[2])
  ) {
    return Object.freeze({ ok: false });
  }
  return Object.freeze({ ok: true, workspaceRoot: args[2] });
}

function startupUsage(): string {
  return "Usage: paw-ts paw-next --startup-scan --root <absolute-workspace>";
}

function stableJson(value: PawNextStartupCliReportV1): string {
  return JSON.stringify(value, null, 2);
}

function result(
  exitCode: PawNextStartupCliExitCodeV1,
  stream: PawNextStartupCliResultV1["stream"],
  text: string,
): PawNextStartupCliResultV1 {
  return Object.freeze({ exitCode, stream, text });
}
