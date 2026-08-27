import fs from "node:fs";
import path from "node:path";

import { createPawNextProductProfileCatalogV1 } from "./product-profile-catalog.js";
import {
  type PawNextStartupRunStatusV1,
  scanAndResumePawNextRunsWithCatalogV1,
} from "./startup-scan.js";

export const PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V2 =
  "paw.next-startup-cli-report.v2" as const;

export type PawNextStartupCliExitCodeV2 = 0 | 1 | 2;

export interface PawNextStartupCliResultV2 {
  readonly exitCode: PawNextStartupCliExitCodeV2;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

interface PawNextStartupCliReportV2 {
  readonly schemaVersion: typeof PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V2;
  readonly productCatalog: "v2";
  readonly mode: "once";
  readonly workspaceRoot: string;
  readonly configurationIssue?: {
    readonly code: "v2_profile_configuration_unavailable";
  };
  readonly executionIssue?: {
    readonly reasonCode: "startup_scan_v2_failed";
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

/** Explicit one-shot V2 catalog scan. It never enables V1 or retries. */
export async function runPawNextStartupCliV2(
  args: readonly string[],
): Promise<PawNextStartupCliResultV2> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return result(2, "stderr", startupUsage());

  const requestedRoot = path.normalize(parsed.workspaceRoot);
  let workspaceRoot: string;
  try {
    workspaceRoot = fs.realpathSync.native(requestedRoot);
    const rootStat = fs.lstatSync(workspaceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("workspace root is not a real directory");
    }
  } catch {
    return result(
      1,
      "stdout",
      stableJson(executionFailureReport(requestedRoot, false)),
    );
  }

  let configurationIssue = false;
  let resolver: ReturnType<typeof createPawNextProductProfileCatalogV1>;
  try {
    resolver = createPawNextProductProfileCatalogV1({
      workspaceRoot,
      v2: {},
    });
  } catch {
    configurationIssue = true;
    resolver = () => undefined;
  }

  try {
    const scan = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot,
      resolveProduct: resolver,
    });
    const report = Object.freeze({
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V2,
      productCatalog: "v2" as const,
      mode: "once" as const,
      workspaceRoot,
      ...(configurationIssue
        ? {
            configurationIssue: Object.freeze({
              code: "v2_profile_configuration_unavailable" as const,
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
    }) satisfies PawNextStartupCliReportV2;
    const attention =
      configurationIssue ||
      report.authorityIssues.length > 0 ||
      report.runs.some((run) => ATTENTION_STATUSES.has(run.status));
    return result(attention ? 1 : 0, "stdout", stableJson(report));
  } catch {
    return result(
      1,
      "stdout",
      stableJson(executionFailureReport(workspaceRoot, configurationIssue)),
    );
  }
}

function parseArgs(
  args: readonly string[],
): Readonly<{ ok: true; workspaceRoot: string }> | Readonly<{ ok: false }> {
  if (
    args.length !== 3 ||
    args[0] !== "--startup-scan-v2" ||
    args[1] !== "--root" ||
    typeof args[2] !== "string" ||
    !args[2].trim() ||
    !path.isAbsolute(args[2])
  ) {
    return Object.freeze({ ok: false });
  }
  return Object.freeze({ ok: true, workspaceRoot: args[2] });
}

function executionFailureReport(
  workspaceRoot: string,
  configurationIssue: boolean,
): PawNextStartupCliReportV2 {
  return Object.freeze({
    schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V2,
    productCatalog: "v2" as const,
    mode: "once" as const,
    workspaceRoot,
    ...(configurationIssue
      ? {
          configurationIssue: Object.freeze({
            code: "v2_profile_configuration_unavailable" as const,
          }),
        }
      : {}),
    executionIssue: Object.freeze({
      reasonCode: "startup_scan_v2_failed" as const,
    }),
    authorityIssues: Object.freeze([]),
    runs: Object.freeze([]),
  });
}

function startupUsage(): string {
  return "Usage: paw-ts paw-next --startup-scan-v2 --root <absolute-workspace>";
}

function stableJson(value: PawNextStartupCliReportV2): string {
  return JSON.stringify(value, null, 2);
}

function result(
  exitCode: PawNextStartupCliExitCodeV2,
  stream: PawNextStartupCliResultV2["stream"],
  text: string,
): PawNextStartupCliResultV2 {
  return Object.freeze({ exitCode, stream, text });
}
