import fs from "node:fs";
import path from "node:path";

import { projectPendingCompletionReviewFeedbackV1 } from "@paw/completion-review";
import type { ModelStreamChunk } from "@paw/models";
import {
  CommittedFileRunPrefixStaleError,
  type FileSessionAuthorityDiscoveryCorruptionV1,
  type JournalHeadV1,
  discoverFileSessionAuthoritiesV1,
  readCommittedFileRunPrefixV1,
  readFileSessionAuthorityInventoryV1,
} from "@paw/runtime";

import {
  PawNextPendingInputBlockedError,
  PawNextRunAnchorConflictError,
  PawNextSessionBusyError,
  PawNextSessionInventoryStaleError,
  type RunExistingPawNextTaskOptionsV1,
  classifyPawNextExistingPrefixV1,
  classifyPawNextExistingPrefixV2,
  classifyPawNextExistingPrefixV3,
  runDiscoveredPawNextTaskV1,
  runDiscoveredPawNextTaskV2,
  runDiscoveredPawNextTaskV3,
} from "./composition.js";
import { readPawNextExistingBootstrapIdentityV1 } from "./existing-run-preflight.js";
import type { PawNextProductProfileCatalogResolutionV3 } from "./product-profile-catalog-v3.js";

export interface PawNextStartupRunIdentityV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly inputId: string;
  readonly goal: string;
  readonly configHash: string;
}

export interface ScanAndResumePawNextRunsOptionsV1 {
  readonly workspaceRoot: string;
  readonly resolveOptions: (
    identity: PawNextStartupRunIdentityV1,
  ) =>
    | RunExistingPawNextTaskOptionsV1
    | undefined
    | Promise<RunExistingPawNextTaskOptionsV1 | undefined>;
}

export interface PawNextStartupCatalogExecutionV1 {
  readonly signal?: AbortSignal;
  readonly leaseScheduler?: import("@paw/runtime").SessionLeaseSchedulerV1;
  readonly onModelStreamEvent?: (
    event: ModelStreamChunk,
  ) => void | Promise<void>;
}

export interface ScanAndResumePawNextRunsWithCatalogOptionsV1 {
  readonly workspaceRoot: string;
  readonly resolveProduct: (
    identity: PawNextStartupRunIdentityV1,
  ) =>
    | PawNextProductProfileCatalogResolutionV3
    | undefined
    | Promise<PawNextProductProfileCatalogResolutionV3 | undefined>;
  /** Non-identity execution seams; the resolved product remains authoritative. */
  readonly execution?: PawNextStartupCatalogExecutionV1;
}

export interface PawNextStartupAuthorityIssueV1 {
  readonly entryName: string;
  readonly reason: FileSessionAuthorityDiscoveryCorruptionV1;
}

export type PawNextStartupRunStatusV1 =
  | "terminal"
  | "blocked_pending"
  | "blocked_unconsumed"
  | "config_unavailable"
  | "invalid"
  | "ambiguous_session"
  | "deferred"
  | "resumed"
  | "busy"
  | "anchor_conflict"
  | "inventory_stale"
  | "failed";

export interface PawNextStartupRunReportV1 {
  readonly sessionId: string;
  readonly runId: string;
  readonly status: PawNextStartupRunStatusV1;
  readonly inputIds?: readonly string[];
  readonly tailSeq?: number;
  readonly reason?: string;
}

export interface PawNextStartupScanReportV1 {
  readonly issues: readonly PawNextStartupAuthorityIssueV1[];
  readonly runs: readonly PawNextStartupRunReportV1[];
}

interface ActionableCandidateV1<TResolved> {
  readonly sessionId: string;
  readonly runId: string;
  readonly resolved: TResolved;
  readonly expectedHead: JournalHeadV1;
  readonly expectedInventoryHash: string;
}

interface MutableRunReportV1 {
  readonly sessionId: string;
  readonly runId: string;
  status: PawNextStartupRunStatusV1;
  inputIds?: readonly string[];
  tailSeq?: number;
  reason?: string;
}

type FailureStage =
  | "prefix"
  | "resolve"
  | "classify"
  | "authority_recheck"
  | "execute";

interface StartupProductAdapterV1<TResolved> {
  readonly resolve: (
    identity: PawNextStartupRunIdentityV1,
  ) => TResolved | undefined | Promise<TResolved | undefined>;
  readonly assertIdentity: (
    workspaceRoot: string,
    sessionId: string,
    runId: string,
    resolved: TResolved,
  ) => void;
  readonly classify: (
    prefix: ReturnType<typeof readCommittedFileRunPrefixV1>,
    resolved: TResolved,
  ) => PawNextStartupClassificationV1 | Promise<PawNextStartupClassificationV1>;
  readonly execute: (
    candidate: ActionableCandidateV1<TResolved>,
  ) => Promise<{ readonly tailSeq: number }>;
  readonly recheckAfterAsyncClassification: boolean;
  readonly describeFailure: (stage: FailureStage, error: unknown) => string;
}

type PawNextStartupClassificationV1 =
  | Readonly<{ status: "terminal" }>
  | Readonly<{
      status: "blocked_pending" | "blocked_unconsumed";
      inputIds: readonly string[];
    }>
  | Readonly<{ status: "actionable_repair" | "actionable_continue" }>
  | Readonly<{ status: "deferred" }>;

/** Legacy V1 entry; its observable resolver/report behavior remains intact. */
export async function scanAndResumePawNextRunsV1(
  options: ScanAndResumePawNextRunsOptionsV1,
): Promise<PawNextStartupScanReportV1> {
  if (typeof options.resolveOptions !== "function") {
    throw new TypeError("Paw Next startup config resolver is required");
  }
  return scanAndResumePawNextRunsInternal(options.workspaceRoot, {
    resolve: options.resolveOptions,
    assertIdentity: assertResolvedOptionsIdentity,
    classify(prefix, resolved) {
      return classifyPawNextExistingPrefixV1({ prefix, options: resolved });
    },
    execute(candidate) {
      return runDiscoveredPawNextTaskV1({
        options: candidate.resolved,
        expectedHead: candidate.expectedHead,
        expectedInventoryHash: candidate.expectedInventoryHash,
      });
    },
    recheckAfterAsyncClassification: false,
    describeFailure: (_stage, error) => describeError(error),
  });
}

/** Explicit programmatic V1/V2/V3 catalog scanner; it never guesses a version. */
export async function scanAndResumePawNextRunsWithCatalogV1(
  options: ScanAndResumePawNextRunsWithCatalogOptionsV1,
): Promise<PawNextStartupScanReportV1> {
  if (typeof options.resolveProduct !== "function") {
    throw new TypeError("Paw Next startup product resolver is required");
  }
  const execution = freezeCatalogExecution(options.execution);
  return scanAndResumePawNextRunsInternal(options.workspaceRoot, {
    resolve: options.resolveProduct,
    assertIdentity: assertResolvedProductIdentity,
    classify(prefix, resolved) {
      if (resolved.productVersion === "v1") {
        return classifyPawNextExistingPrefixV1({
          prefix,
          options: resolved.options,
        });
      }
      if (resolved.productVersion === "v2") {
        return classifyPawNextExistingPrefixV2({
          prefix,
          resolution: resolved,
          ...(execution.signal === undefined
            ? {}
            : { signal: execution.signal }),
        });
      }
      if (resolved.productVersion === "v3") {
        return classifyV3StartupPrefix(prefix, resolved, execution.signal);
      }
      throw new Error("Paw Next startup product version is invalid");
    },
    execute(candidate) {
      if (candidate.resolved.productVersion === "v1") {
        return runDiscoveredPawNextTaskV1({
          options: withCatalogExecutionV1(
            candidate.resolved.options,
            execution,
          ),
          expectedHead: candidate.expectedHead,
          expectedInventoryHash: candidate.expectedInventoryHash,
        });
      }
      if (candidate.resolved.productVersion === "v2") {
        return runDiscoveredPawNextTaskV2({
          resolution: candidate.resolved,
          expectedHead: candidate.expectedHead,
          expectedInventoryHash: candidate.expectedInventoryHash,
          ...execution,
        });
      }
      if (candidate.resolved.productVersion === "v3") {
        return runDiscoveredPawNextTaskV3({
          resolution: candidate.resolved,
          expectedHead: candidate.expectedHead,
          expectedInventoryHash: candidate.expectedInventoryHash,
          ...execution,
        });
      }
      throw new Error("Paw Next startup product version is invalid");
    },
    recheckAfterAsyncClassification: true,
    describeFailure: (stage) => `startup_${stage}_failed`,
  });
}

async function scanAndResumePawNextRunsInternal<TResolved>(
  requestedWorkspaceRoot: string,
  adapter: StartupProductAdapterV1<TResolved>,
): Promise<PawNextStartupScanReportV1> {
  const workspaceRoot = fs.realpathSync.native(
    path.resolve(requestedWorkspaceRoot),
  );
  const discovery = discoverFileSessionAuthoritiesV1({ workspaceRoot });
  const issues = discovery.entries.flatMap((entry) =>
    entry.status === "corrupt"
      ? [Object.freeze({ entryName: entry.entryName, reason: entry.reason })]
      : [],
  );
  const discoveredRuns = discovery.entries
    .flatMap((entry) =>
      entry.status === "discovered"
        ? entry.inventory.runs.map((run) => ({
            sessionId: entry.sessionId,
            inventoryHash: entry.inventory.inventoryHash,
            run,
          }))
        : [],
    )
    .sort((left, right) =>
      compareIdentity(
        left.sessionId,
        left.run.runId,
        right.sessionId,
        right.run.runId,
      ),
    );
  const reports: MutableRunReportV1[] = [];
  const candidates: ActionableCandidateV1<TResolved>[] = [];
  const blockedSessions = new Set<string>();

  for (const discovered of discoveredRuns) {
    const report: MutableRunReportV1 = {
      sessionId: discovered.sessionId,
      runId: discovered.run.runId,
      status: "invalid",
    };
    reports.push(report);
    let prefix: ReturnType<typeof readCommittedFileRunPrefixV1>;
    let bootstrap: ReturnType<typeof readPawNextExistingBootstrapIdentityV1>;
    try {
      prefix = readCommittedFileRunPrefixV1({
        workspaceRoot,
        sessionId: discovered.sessionId,
        runId: discovered.run.runId,
        expectedHead: discovered.run.head,
      });
      bootstrap = readPawNextExistingBootstrapIdentityV1(prefix);
    } catch (error) {
      classifyReadFailure(report, error, adapter, "prefix");
      blockedSessions.add(discovered.sessionId);
      continue;
    }

    let resolved: TResolved | undefined;
    try {
      resolved = await adapter.resolve({
        workspaceRoot,
        sessionId: discovered.sessionId,
        runId: discovered.run.runId,
        inputId: bootstrap.inputId,
        goal: bootstrap.goal,
        configHash: bootstrap.configHash,
      });
    } catch (error) {
      if (
        !postClassificationAnchorIsCurrent(
          workspaceRoot,
          discovered,
          report,
          adapter,
        )
      ) {
        blockedSessions.add(discovered.sessionId);
        continue;
      }
      report.status = "invalid";
      report.reason = adapter.describeFailure("resolve", error);
      blockedSessions.add(discovered.sessionId);
      continue;
    }
    if (!resolved) {
      if (
        !postClassificationAnchorIsCurrent(
          workspaceRoot,
          discovered,
          report,
          adapter,
        )
      ) {
        blockedSessions.add(discovered.sessionId);
        continue;
      }
      report.status = "config_unavailable";
      blockedSessions.add(discovered.sessionId);
      continue;
    }

    let classification: PawNextStartupClassificationV1;
    try {
      adapter.assertIdentity(
        workspaceRoot,
        discovered.sessionId,
        discovered.run.runId,
        resolved,
      );
      classification = await adapter.classify(prefix, resolved);
    } catch (error) {
      if (
        !postClassificationAnchorIsCurrent(
          workspaceRoot,
          discovered,
          report,
          adapter,
        )
      ) {
        blockedSessions.add(discovered.sessionId);
        continue;
      }
      classifyReadFailure(report, error, adapter, "classify");
      blockedSessions.add(discovered.sessionId);
      continue;
    }
    if (
      !postClassificationAnchorIsCurrent(
        workspaceRoot,
        discovered,
        report,
        adapter,
      )
    ) {
      blockedSessions.add(discovered.sessionId);
      continue;
    }

    switch (classification.status) {
      case "deferred":
        report.status = "deferred";
        break;
      case "terminal":
        report.status = "terminal";
        break;
      case "blocked_pending":
      case "blocked_unconsumed":
        report.status = classification.status;
        report.inputIds = classification.inputIds;
        break;
      case "actionable_repair":
      case "actionable_continue":
        report.status = "deferred";
        candidates.push({
          sessionId: discovered.sessionId,
          runId: discovered.run.runId,
          resolved,
          expectedHead: discovered.run.head,
          expectedInventoryHash: discovered.inventoryHash,
        });
        break;
    }
  }

  const candidatesBySession = new Map<
    string,
    ActionableCandidateV1<TResolved>[]
  >();
  for (const candidate of candidates) {
    const values = candidatesBySession.get(candidate.sessionId) ?? [];
    values.push(candidate);
    candidatesBySession.set(candidate.sessionId, values);
  }
  for (const values of candidatesBySession.values()) {
    if (values.length < 2) continue;
    blockedSessions.add(values[0]?.sessionId ?? "");
    for (const candidate of values) {
      requiredReport(reports, candidate).status = "ambiguous_session";
    }
  }

  const eligible = candidates.filter(
    (candidate) =>
      !blockedSessions.has(candidate.sessionId) &&
      requiredReport(reports, candidate).status !== "ambiguous_session",
  );
  if (eligible.length > 0) {
    const selected = eligible[0] as ActionableCandidateV1<TResolved>;
    const report = requiredReport(reports, selected);
    try {
      const result = await adapter.execute(selected);
      report.status = "resumed";
      report.tailSeq = result.tailSeq;
    } catch (error) {
      if (error instanceof PawNextSessionBusyError) {
        report.status = "busy";
      } else if (error instanceof PawNextRunAnchorConflictError) {
        report.status = "anchor_conflict";
      } else if (error instanceof PawNextSessionInventoryStaleError) {
        report.status = "inventory_stale";
      } else if (error instanceof PawNextPendingInputBlockedError) {
        report.status =
          error.kind === "pending" ? "blocked_pending" : "blocked_unconsumed";
        report.inputIds = error.inputIds;
      } else {
        report.status = "failed";
        report.reason = adapter.describeFailure("execute", error);
      }
    }
  }

  return Object.freeze({
    issues: Object.freeze(issues),
    runs: Object.freeze(
      reports.map((report) =>
        Object.freeze({
          sessionId: report.sessionId,
          runId: report.runId,
          status: report.status,
          ...(report.inputIds
            ? { inputIds: Object.freeze([...report.inputIds]) }
            : {}),
          ...(report.tailSeq === undefined ? {} : { tailSeq: report.tailSeq }),
          ...(report.reason === undefined ? {} : { reason: report.reason }),
        }),
      ),
    ),
  });
}

function postClassificationAnchorIsCurrent<TResolved>(
  workspaceRoot: string,
  discovered: {
    readonly sessionId: string;
    readonly inventoryHash: string;
    readonly run: { readonly runId: string; readonly head: JournalHeadV1 };
  },
  report: MutableRunReportV1,
  adapter: StartupProductAdapterV1<TResolved>,
): boolean {
  if (!adapter.recheckAfterAsyncClassification) return true;
  try {
    const current = readFileSessionAuthorityInventoryV1({
      workspaceRoot,
      sessionId: discovered.sessionId,
    });
    const run = current.runs.find(
      (candidate) => candidate.runId === discovered.run.runId,
    );
    if (!run) {
      report.status = "inventory_stale";
      return false;
    }
    if (!sameHead(run.head, discovered.run.head)) {
      report.status = "anchor_conflict";
      return false;
    }
    if (current.inventoryHash !== discovered.inventoryHash) {
      report.status = "inventory_stale";
      return false;
    }
    return true;
  } catch (error) {
    report.status = "invalid";
    report.reason = adapter.describeFailure("authority_recheck", error);
    return false;
  }
}

function sameHead(left: JournalHeadV1, right: JournalHeadV1): boolean {
  return left.tailSeq === right.tailSeq && left.prefixHash === right.prefixHash;
}

function classifyReadFailure<TResolved>(
  report: MutableRunReportV1,
  error: unknown,
  adapter: StartupProductAdapterV1<TResolved>,
  stage: FailureStage,
): void {
  if (error instanceof CommittedFileRunPrefixStaleError) {
    report.status =
      error.reason === "head" ? "anchor_conflict" : "inventory_stale";
  } else {
    report.status = "invalid";
    report.reason = adapter.describeFailure(stage, error);
  }
}

function assertResolvedOptionsIdentity(
  workspaceRoot: string,
  sessionId: string,
  runId: string,
  resolved: RunExistingPawNextTaskOptionsV1,
): void {
  assertRunIdentity(
    workspaceRoot,
    sessionId,
    runId,
    resolved.workspaceRoot,
    resolved.sessionId,
    resolved.runId,
  );
}

function assertResolvedProductIdentity(
  workspaceRoot: string,
  sessionId: string,
  runId: string,
  resolved: PawNextProductProfileCatalogResolutionV3,
): void {
  if (
    !resolved ||
    (resolved.productVersion !== "v1" &&
      resolved.productVersion !== "v2" &&
      resolved.productVersion !== "v3")
  ) {
    throw new Error(
      "Paw Next startup product resolver returned an invalid product",
    );
  }
  const identity =
    resolved.productVersion === "v1" ? resolved.options : resolved.taskOptions;
  assertRunIdentity(
    workspaceRoot,
    sessionId,
    runId,
    identity.workspaceRoot,
    identity.sessionId,
    identity.runId,
  );
}

async function classifyV3StartupPrefix(
  prefix: ReturnType<typeof readCommittedFileRunPrefixV1>,
  resolved: Extract<
    PawNextProductProfileCatalogResolutionV3,
    { productVersion: "v3" }
  >,
  signal: AbortSignal | undefined,
): Promise<PawNextStartupClassificationV1> {
  const classification = await classifyPawNextExistingPrefixV3({
    prefix,
    resolution: resolved,
    ...(signal === undefined ? {} : { signal }),
  });
  if (
    classification.status === "blocked_pending" &&
    projectPendingCompletionReviewFeedbackV1(
      prefix.flatMap((envelope) =>
        envelope.record.kind === "input_fact" ? [envelope.record.fact] : [],
      ),
    ) !== undefined
  ) {
    return Object.freeze({ status: "actionable_continue" });
  }
  if (
    classification.status === "actionable_continue" &&
    !prefix.some(
      (envelope) =>
        envelope.record.kind === "input_fact" &&
        envelope.record.fact.type === "work.segment_started",
    )
  ) {
    return Object.freeze({ status: "deferred" });
  }
  return classification;
}

function assertRunIdentity(
  workspaceRoot: string,
  sessionId: string,
  runId: string,
  resolvedWorkspaceRoot: string,
  resolvedSessionId: string,
  resolvedRunId: string,
): void {
  const resolvedRoot = fs.realpathSync.native(
    path.resolve(resolvedWorkspaceRoot),
  );
  if (
    resolvedRoot !== workspaceRoot ||
    resolvedSessionId !== sessionId ||
    resolvedRunId !== runId
  ) {
    throw new Error(
      "Paw Next startup config resolver returned another run identity",
    );
  }
}

function freezeCatalogExecution(
  value: PawNextStartupCatalogExecutionV1 | undefined,
): PawNextStartupCatalogExecutionV1 {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Paw Next startup catalog execution seams are invalid");
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "signal" &&
      key !== "leaseScheduler" &&
      key !== "onModelStreamEvent"
    ) {
      throw new TypeError(
        "Paw Next startup catalog execution seams are invalid",
      );
    }
  }
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) {
    throw new TypeError("Paw Next startup catalog signal is invalid");
  }
  if (
    value.onModelStreamEvent !== undefined &&
    typeof value.onModelStreamEvent !== "function"
  ) {
    throw new TypeError("Paw Next startup stream observer is invalid");
  }
  return Object.freeze({
    ...(value.signal === undefined ? {} : { signal: value.signal }),
    ...(value.leaseScheduler === undefined
      ? {}
      : { leaseScheduler: value.leaseScheduler }),
    ...(value.onModelStreamEvent === undefined
      ? {}
      : { onModelStreamEvent: value.onModelStreamEvent }),
  });
}

function withCatalogExecutionV1(
  options: RunExistingPawNextTaskOptionsV1,
  execution: PawNextStartupCatalogExecutionV1,
): RunExistingPawNextTaskOptionsV1 {
  return Object.freeze({ ...options, ...execution });
}

function requiredReport<TResolved>(
  reports: readonly MutableRunReportV1[],
  identity: Pick<ActionableCandidateV1<TResolved>, "sessionId" | "runId">,
): MutableRunReportV1 {
  const report = reports.find(
    (value) =>
      value.sessionId === identity.sessionId && value.runId === identity.runId,
  );
  if (!report) throw new Error("Paw Next startup report identity is missing");
  return report;
}

function compareIdentity(
  leftSessionId: string,
  leftRunId: string,
  rightSessionId: string,
  rightRunId: string,
): number {
  if (leftSessionId !== rightSessionId) {
    return leftSessionId < rightSessionId ? -1 : 1;
  }
  return leftRunId === rightRunId ? 0 : leftRunId < rightRunId ? -1 : 1;
}

function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
