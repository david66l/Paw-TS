import path from "node:path";

import {
  DEFAULT_LEGACY_RUN_EVIDENCE_POLICY_V1,
  type ExportLegacyPawRunEvidenceResultV1,
  LEGACY_RUN_SOURCE_KIND_V1,
  type LegacyRunInspectionV1,
  type LegacyRunInventoryV1,
  type LegacyRunSourceStatusV1,
  discoverLegacyPawRunsV1,
  exportLegacyPawRunEvidenceV1,
  inspectLegacyPawRunV1,
} from "./legacy-run-offline.js";

export const PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1 =
  "paw.legacy-run-export-report.v1" as const;
export const PAW_NEXT_LEGACY_EXPORT_USAGE_V1 =
  "Usage: paw-ts paw-next --legacy-export-v1 --root <absolute-legacy-runtime-root> --source-kind legacy_core_unversioned_jsonl_app_state --run-id <id> --output <absolute-file>";

export interface PawNextLegacyExportCliResultV1 {
  readonly exitCode: 0 | 1 | 2;
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface PawNextLegacyExportCliPortsV1 {
  readonly discover?: typeof discoverLegacyPawRunsV1;
  readonly inspect?: typeof inspectLegacyPawRunV1;
  readonly exportEvidence?: typeof exportLegacyPawRunEvidenceV1;
}

type SafeLegacyExportReportV1 = Readonly<{
  schemaVersion: typeof PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1;
  mode: "offline_evidence_export";
  sourceKind: typeof LEGACY_RUN_SOURCE_KIND_V1;
  runId: string;
  status: "exported" | "target_exists" | "failed";
  continuable: false;
  sourceStatus?: LegacyRunSourceStatusV1;
  bundleHash?: string;
  byteLength?: number;
  reasonCode?:
    | "target_exists"
    | "source_unavailable"
    | "source_changed"
    | "export_failed";
}>;

/** Explicit, one-shot, offline evidence export. It never writes a Paw journal. */
export async function runPawNextLegacyExportCliV1(
  argv: readonly string[],
  ports: PawNextLegacyExportCliPortsV1 = {},
): Promise<PawNextLegacyExportCliResultV1> {
  const parsed = parseArgs(argv);
  if (!parsed) {
    return Object.freeze({
      exitCode: 2,
      stream: "stderr",
      text: PAW_NEXT_LEGACY_EXPORT_USAGE_V1,
    });
  }
  let discover: typeof discoverLegacyPawRunsV1;
  let inspect: typeof inspectLegacyPawRunV1;
  let exportEvidence: typeof exportLegacyPawRunEvidenceV1;
  try {
    const discoverCandidate = ports.discover;
    const inspectCandidate = ports.inspect;
    const exportCandidate = ports.exportEvidence;
    if (
      (discoverCandidate !== undefined &&
        typeof discoverCandidate !== "function") ||
      (inspectCandidate !== undefined &&
        typeof inspectCandidate !== "function") ||
      (exportCandidate !== undefined && typeof exportCandidate !== "function")
    ) {
      throw new Error("Legacy export CLI ports are invalid");
    }
    discover = discoverCandidate ?? discoverLegacyPawRunsV1;
    inspect = inspectCandidate ?? inspectLegacyPawRunV1;
    exportEvidence = exportCandidate ?? exportLegacyPawRunEvidenceV1;
  } catch {
    return safeFailure(parsed.runId, "export_failed");
  }
  let inventory: LegacyRunInventoryV1;
  let inspection: LegacyRunInspectionV1;
  let inventoryHash: string;
  let pairDigest: string;
  let sourceStatus: LegacyRunSourceStatusV1;
  try {
    inventory = discover({
      legacyRuntimeRoot: parsed.legacyRuntimeRoot,
      policy: DEFAULT_LEGACY_RUN_EVIDENCE_POLICY_V1,
    });
    inventoryHash = exactHash(inventory.inventoryHash);
    inspection = inspect({
      legacyRuntimeRoot: parsed.legacyRuntimeRoot,
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId: parsed.runId,
      expectedInventoryHash: inventoryHash,
      policy: DEFAULT_LEGACY_RUN_EVIDENCE_POLICY_V1,
    });
    pairDigest = exactHash(inspection.pairDigest);
    const candidateStatus: unknown = inspection.status;
    if (!isSourceStatus(candidateStatus)) {
      throw new Error("Legacy inspection status is invalid");
    }
    sourceStatus = candidateStatus;
  } catch {
    return safeFailure(parsed.runId, "source_unavailable");
  }
  let result: ExportLegacyPawRunEvidenceResultV1;
  try {
    result = parseExportResult(
      exportEvidence({
        legacyRuntimeRoot: parsed.legacyRuntimeRoot,
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: parsed.runId,
        outputPath: parsed.outputPath,
        expectedInventoryHash: inventoryHash,
        expectedPairDigest: pairDigest,
        policy: DEFAULT_LEGACY_RUN_EVIDENCE_POLICY_V1,
      }),
    );
  } catch (error) {
    return safeFailure(
      parsed.runId,
      isSourceChange(error) ? "source_changed" : "export_failed",
      sourceStatus,
    );
  }
  if (result.status === "target_exists") {
    if (!isSourceStatus(result.sourceStatus)) {
      return safeFailure(parsed.runId, "export_failed");
    }
    return safeReport(
      {
        schemaVersion: PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1,
        mode: "offline_evidence_export",
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: parsed.runId,
        status: "target_exists",
        continuable: false,
        sourceStatus: result.sourceStatus,
        reasonCode: "target_exists",
      },
      1,
    );
  }
  if (
    !isSourceStatus(result.sourceStatus) ||
    !/^[a-f0-9]{64}$/.test(result.bundleHash) ||
    !Number.isSafeInteger(result.byteLength) ||
    result.byteLength <= 0
  ) {
    return safeFailure(parsed.runId, "export_failed");
  }
  return safeReport(
    {
      schemaVersion: PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1,
      mode: "offline_evidence_export",
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId: parsed.runId,
      status: "exported",
      continuable: false,
      sourceStatus: result.sourceStatus,
      bundleHash: result.bundleHash,
      byteLength: result.byteLength,
    },
    0,
  );
}

function parseArgs(argv: readonly string[]):
  | Readonly<{
      legacyRuntimeRoot: string;
      runId: string;
      outputPath: string;
    }>
  | undefined {
  if (
    argv.length !== 9 ||
    argv[0] !== "--legacy-export-v1" ||
    argv[1] !== "--root" ||
    argv[3] !== "--source-kind" ||
    argv[4] !== LEGACY_RUN_SOURCE_KIND_V1 ||
    argv[5] !== "--run-id" ||
    argv[7] !== "--output"
  ) {
    return undefined;
  }
  const legacyRuntimeRoot = argv[2];
  const runId = argv[6];
  const outputPath = argv[8];
  if (
    !legacyRuntimeRoot ||
    !path.isAbsolute(legacyRuntimeRoot) ||
    !runId?.trim() ||
    runId.includes("\0") ||
    !outputPath ||
    !path.isAbsolute(outputPath)
  ) {
    return undefined;
  }
  return Object.freeze({ legacyRuntimeRoot, runId, outputPath });
}

function safeFailure(
  runId: string,
  reasonCode: "source_unavailable" | "source_changed" | "export_failed",
  sourceStatus?: LegacyRunSourceStatusV1,
): PawNextLegacyExportCliResultV1 {
  return safeReport(
    {
      schemaVersion: PAW_NEXT_LEGACY_EXPORT_REPORT_SCHEMA_VERSION_V1,
      mode: "offline_evidence_export",
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId,
      status: "failed",
      continuable: false,
      ...(sourceStatus ? { sourceStatus } : {}),
      reasonCode,
    },
    1,
  );
}

function safeReport(
  report: SafeLegacyExportReportV1,
  exitCode: 0 | 1,
): PawNextLegacyExportCliResultV1 {
  // This serializer accepts only the fixed safe report DTO. Evidence bytes are
  // written solely by exportLegacyPawRunEvidenceV1 and can never reach stdout.
  return Object.freeze({
    exitCode,
    stream: exitCode === 0 ? "stdout" : "stderr",
    text: JSON.stringify(report),
  });
}

function isSourceChange(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("inventory changed") ||
      error.message.includes("source pair changed"))
  );
}

function isSourceStatus(value: unknown): value is LegacyRunSourceStatusV1 {
  return (
    value === "paired_unbound" ||
    value === "journal_only" ||
    value === "state_only" ||
    value === "ambiguous" ||
    value === "corrupt" ||
    value === "unsupported" ||
    value === "already_current"
  );
}

function exactHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Legacy evidence hash is invalid");
  }
  return value;
}

function parseExportResult(value: unknown): ExportLegacyPawRunEvidenceResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Legacy evidence export result is invalid");
  }
  const record = value as Record<string, unknown>;
  const status: unknown = record.status;
  const sourceStatus: unknown = record.sourceStatus;
  const continuable: unknown = record.continuable;
  const reasonCode: unknown = record.reasonCode;
  const bundleHash: unknown = record.bundleHash;
  const byteLength: unknown = record.byteLength;
  if (status === "target_exists") {
    if (
      !isSourceStatus(sourceStatus) ||
      continuable !== false ||
      reasonCode !== "target_exists"
    ) {
      throw new Error("Legacy evidence target result is invalid");
    }
    return Object.freeze({
      status: "target_exists",
      sourceStatus,
      continuable: false,
      reasonCode: "target_exists",
    });
  }
  if (
    status !== "exported" ||
    !isSourceStatus(sourceStatus) ||
    continuable !== false ||
    typeof bundleHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(bundleHash) ||
    !Number.isSafeInteger(byteLength) ||
    (byteLength as number) <= 0
  ) {
    throw new Error("Legacy evidence export result is invalid");
  }
  return Object.freeze({
    status: "exported",
    sourceStatus,
    continuable: false,
    bundleHash,
    byteLength: byteLength as number,
  });
}
