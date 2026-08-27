import fs from "node:fs";
import path from "node:path";

import type { FileSessionAuthorityDiscoveryCorruptionV1 } from "@paw/runtime";

import { createPawNextProductProfileCatalogV3 } from "./product-profile-catalog-v3.js";
import {
  type PawNextStartupRunStatusV1,
  scanAndResumePawNextRunsWithCatalogV1,
} from "./startup-scan.js";

export const PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V3 =
  "paw.next-startup-cli-report.v3" as const;

export type PawNextStartupCliExitCodeV3 = 0 | 1 | 2;

export interface PawNextStartupCliResultV3 {
  readonly exitCode: PawNextStartupCliExitCodeV3;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

interface PawNextStartupCliReportV3 {
  readonly schemaVersion: typeof PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V3;
  readonly productCatalog: "v3";
  readonly mode: "once";
  readonly configurationIssue?: {
    readonly code: "v3_profile_configuration_unavailable";
  };
  readonly executionIssue?: {
    readonly reasonCode: "startup_scan_v3_failed";
  };
  readonly authorityIssues: readonly {
    readonly reasonCode: FileSessionAuthorityDiscoveryCorruptionV1;
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

/** Explicit one-shot V3-only scan. It never admits new work or retries. */
export async function runPawNextStartupCliV3(
  args: readonly string[],
): Promise<PawNextStartupCliResultV3> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return result(2, "stderr", startupUsage());

  let workspaceRoot: string;
  try {
    workspaceRoot = fs.realpathSync.native(
      path.normalize(parsed.workspaceRoot),
    );
    const rootStat = fs.lstatSync(workspaceRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("workspace root is not a real directory");
    }
  } catch {
    return result(1, "stdout", stableJson(executionFailureReport(false)));
  }

  let configurationIssue = false;
  let resolver: ReturnType<typeof createPawNextProductProfileCatalogV3>;
  try {
    resolver = createPawNextProductProfileCatalogV3({
      workspaceRoot,
      v3: {},
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
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V3,
      productCatalog: "v3" as const,
      mode: "once" as const,
      ...(configurationIssue
        ? {
            configurationIssue: Object.freeze({
              code: "v3_profile_configuration_unavailable" as const,
            }),
          }
        : {}),
      authorityIssues: Object.freeze(
        scan.issues.map((issue) => Object.freeze({ reasonCode: issue.reason })),
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
    }) satisfies PawNextStartupCliReportV3;
    const attention =
      configurationIssue ||
      report.authorityIssues.length > 0 ||
      report.runs.some((run) => ATTENTION_STATUSES.has(run.status));
    return result(attention ? 1 : 0, "stdout", stableJson(report));
  } catch {
    return result(
      1,
      "stdout",
      stableJson(executionFailureReport(configurationIssue)),
    );
  }
}

function parseArgs(
  args: readonly string[],
): Readonly<{ ok: true; workspaceRoot: string }> | Readonly<{ ok: false }> {
  if (
    args.length !== 3 ||
    args[0] !== "--startup-scan-v3" ||
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
  configurationIssue: boolean,
): PawNextStartupCliReportV3 {
  return Object.freeze({
    schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V3,
    productCatalog: "v3" as const,
    mode: "once" as const,
    ...(configurationIssue
      ? {
          configurationIssue: Object.freeze({
            code: "v3_profile_configuration_unavailable" as const,
          }),
        }
      : {}),
    executionIssue: Object.freeze({
      reasonCode: "startup_scan_v3_failed" as const,
    }),
    authorityIssues: Object.freeze([]),
    runs: Object.freeze([]),
  });
}

function startupUsage(): string {
  return "Usage: paw-ts paw-next --startup-scan-v3 --root <absolute-workspace>";
}

function stableJson(value: PawNextStartupCliReportV3): string {
  return JSON.stringify(value, null, 2);
}

function result(
  exitCode: PawNextStartupCliExitCodeV3,
  stream: PawNextStartupCliResultV3["stream"],
  text: string,
): PawNextStartupCliResultV3 {
  return Object.freeze({ exitCode, stream, text });
}
