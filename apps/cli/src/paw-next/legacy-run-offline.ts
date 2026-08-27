import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type FileSessionAuthorityDiscoveryEntryV1,
  discoverFileSessionAuthoritiesV1,
} from "@paw/runtime";

import {
  hashCanonicalJsonV1,
  toFrozenJsonValueV1,
} from "./product-manifest.js";

export const LEGACY_RUN_SOURCE_KIND_V1 =
  "legacy_core_unversioned_jsonl_app_state" as const;
export const LEGACY_RUN_EVIDENCE_SCHEMA_VERSION_V1 =
  "paw.legacy-run-evidence.v1" as const;
export const LEGACY_RUN_EVIDENCE_POLICY_VERSION_V1 =
  "paw.legacy-run-evidence-policy.v1" as const;

export interface LegacyRunEvidencePolicyV1 {
  readonly policyVersion: typeof LEGACY_RUN_EVIDENCE_POLICY_VERSION_V1;
  readonly maxInventoryEntries: number;
  readonly maxSourceFileBytes: number;
  readonly maxTotalSourceBytes: number;
  readonly maxBundleBytes: number;
}

export const DEFAULT_LEGACY_RUN_EVIDENCE_POLICY_V1 = Object.freeze({
  policyVersion: LEGACY_RUN_EVIDENCE_POLICY_VERSION_V1,
  maxInventoryEntries: 4_096,
  maxSourceFileBytes: 12 * 1024 * 1024,
  maxTotalSourceBytes: 12 * 1024 * 1024,
  maxBundleBytes: 96 * 1024 * 1024,
}) satisfies LegacyRunEvidencePolicyV1;

export type LegacyRunSourceStatusV1 =
  | "paired_unbound"
  | "journal_only"
  | "state_only"
  | "ambiguous"
  | "corrupt"
  | "unsupported"
  | "already_current";

export type LegacyRunEvidenceIssueV1 =
  | "journal_missing"
  | "app_state_missing"
  | "journal_invalid"
  | "app_state_invalid"
  | "source_identity_mismatch"
  | "source_name_mismatch"
  | "sanitized_run_id_alias"
  | "app_state_workspace_untrusted"
  | "external_artifacts_not_collected"
  | "current_paw_next_run_not_migrated";

export interface LegacyRunSourceFileEvidenceV1 {
  readonly role: "session_journal" | "app_state";
  readonly entryNameHash: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface LegacyRunInventoryEntryV1 {
  readonly sourceKind:
    | typeof LEGACY_RUN_SOURCE_KIND_V1
    | "paw_next_authority_v2";
  readonly sourceId: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly status: LegacyRunSourceStatusV1;
  readonly continuable: false;
  readonly pairDigest: string;
  readonly files: readonly LegacyRunSourceFileEvidenceV1[];
  readonly issues: readonly LegacyRunEvidenceIssueV1[];
}

export interface LegacyRunInventoryV1 {
  readonly schemaVersion: "paw.legacy-run-inventory.v1";
  readonly legacyRuntimeRootIdentityHash: string;
  readonly entries: readonly LegacyRunInventoryEntryV1[];
  readonly inventoryHash: string;
}

export interface LegacyRunInspectionV1 extends LegacyRunInventoryEntryV1 {
  readonly schemaVersion: "paw.legacy-run-inspection.v1";
  readonly inventoryHash: string;
  readonly journal?: Readonly<{
    eventCount: number;
    firstSeq: number;
    lastSeq: number;
    eventTypes: readonly string[];
  }>;
  readonly appState?: Readonly<{
    turn: number;
    maxSteps: number;
    hasOutcome: boolean;
  }>;
}

export interface DiscoverLegacyPawRunsInputV1 {
  readonly legacyRuntimeRoot: string;
  readonly policy?: LegacyRunEvidencePolicyV1;
}

export interface InspectLegacyPawRunInputV1 {
  readonly legacyRuntimeRoot: string;
  readonly sourceKind: typeof LEGACY_RUN_SOURCE_KIND_V1;
  readonly runId: string;
  readonly expectedInventoryHash?: string;
  readonly policy?: LegacyRunEvidencePolicyV1;
}

export interface ExportLegacyPawRunEvidenceInputV1 {
  readonly legacyRuntimeRoot: string;
  readonly sourceKind: typeof LEGACY_RUN_SOURCE_KIND_V1;
  readonly runId: string;
  readonly outputPath: string;
  readonly expectedInventoryHash: string;
  readonly expectedPairDigest: string;
  readonly policy?: LegacyRunEvidencePolicyV1;
}

interface LegacyRunOfflineHooksV1 {
  readonly afterJournalDirectoryRead?: () => void;
  readonly afterSourcePairRead?: () => void;
  readonly afterPublisherTempFsync?: () => void;
  readonly afterPublisherLink?: () => void;
}

export type ExportLegacyPawRunEvidenceResultV1 =
  | Readonly<{
      status: "exported";
      sourceStatus: LegacyRunSourceStatusV1;
      continuable: false;
      bundleHash: string;
      byteLength: number;
    }>
  | Readonly<{
      status: "target_exists";
      sourceStatus: LegacyRunSourceStatusV1;
      continuable: false;
      reasonCode: "target_exists";
    }>;

interface StableSourceFile {
  readonly role: "session_journal" | "app_state";
  readonly entryName: string;
  readonly absolutePath: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly collected: boolean;
  readonly pathFingerprint: string;
  readonly claimedRunId?: string;
  readonly runIdHint: string;
  readonly valid: boolean;
  readonly issue?: "journal_invalid" | "app_state_invalid";
  readonly journal?: LegacyRunInspectionV1["journal"];
  readonly appState?: LegacyRunInspectionV1["appState"] & {
    readonly workspaceRoot: string;
  };
}

interface InternalEntry {
  readonly publicEntry: LegacyRunInventoryEntryV1;
  readonly sources: readonly StableSourceFile[];
  readonly journal?: LegacyRunInspectionV1["journal"];
  readonly appState?: LegacyRunInspectionV1["appState"];
}

interface InternalInventory {
  readonly publicInventory: LegacyRunInventoryV1;
  readonly entries: readonly InternalEntry[];
  readonly workspaceRoot: string;
}

interface StableDirectoryAnchor {
  readonly path: string;
  readonly stat: fs.Stats;
  readonly identityKey: string;
}

interface OptionalDirectoryAnchor {
  readonly path: string;
  readonly stat?: fs.Stats;
  readonly identityKey?: string;
}

interface LegacyDirectoryScan {
  readonly directory: string;
  readonly extension: ".jsonl" | ".json";
  readonly role: StableSourceFile["role"];
  readonly exists: boolean;
  readonly directoryStat?: fs.Stats;
  readonly directoryIdentityKey?: string;
  readonly entryNames: readonly string[];
  readonly files: ReadonlyArray<Omit<StableSourceFile, "valid">>;
}

/** Strictly read-only inventory. Missing legacy roots are reported as empty. */
export function discoverLegacyPawRunsV1(
  input: DiscoverLegacyPawRunsInputV1,
): LegacyRunInventoryV1 {
  return scanLegacySources(input).publicInventory;
}

/** @internal Direct-module deterministic filesystem seam; never used by main. */
export function discoverLegacyPawRunsForTestV1(
  input: DiscoverLegacyPawRunsInputV1,
  hooks: LegacyRunOfflineHooksV1,
): LegacyRunInventoryV1 {
  return scanLegacySources(input, hooks).publicInventory;
}

/** Inspect one internally identified legacy run; caller-provided paths are never used. */
export function inspectLegacyPawRunV1(
  input: InspectLegacyPawRunInputV1,
): LegacyRunInspectionV1 {
  assertSourceKind(input.sourceKind);
  assertRunId(input.runId);
  const scanned = scanLegacySources(input);
  if (
    input.expectedInventoryHash !== undefined &&
    input.expectedInventoryHash !== scanned.publicInventory.inventoryHash
  ) {
    throw new Error("Legacy run inventory changed");
  }
  const matches = scanned.entries.filter(
    (entry) =>
      entry.publicEntry.sourceKind === LEGACY_RUN_SOURCE_KIND_V1 &&
      entry.publicEntry.runId === input.runId,
  );
  if (matches.length !== 1) {
    throw new Error("Legacy run identity is missing or ambiguous");
  }
  const entry = matches[0];
  if (!entry) throw new Error("Legacy run identity disappeared");
  return freezeJson({
    schemaVersion: "paw.legacy-run-inspection.v1",
    ...entry.publicEntry,
    inventoryHash: scanned.publicInventory.inventoryHash,
    ...(entry.journal ? { journal: entry.journal } : {}),
    ...(entry.appState ? { appState: entry.appState } : {}),
  }) as unknown as LegacyRunInspectionV1;
}

/**
 * Publish an immutable evidence bundle. This never produces a runnable Paw Next
 * journal. Source storage paths remain read-only; only the caller's explicit
 * outputPath may be written.
 */
export function exportLegacyPawRunEvidenceV1(
  input: ExportLegacyPawRunEvidenceInputV1,
): ExportLegacyPawRunEvidenceResultV1 {
  return exportLegacyPawRunEvidenceImpl(input);
}

/** @internal Direct-module deterministic filesystem seam; never used by main. */
export function exportLegacyPawRunEvidenceForTestV1(
  input: ExportLegacyPawRunEvidenceInputV1,
  hooks: LegacyRunOfflineHooksV1,
): ExportLegacyPawRunEvidenceResultV1 {
  return exportLegacyPawRunEvidenceImpl(input, hooks);
}

function exportLegacyPawRunEvidenceImpl(
  input: ExportLegacyPawRunEvidenceInputV1,
  hooks?: LegacyRunOfflineHooksV1,
): ExportLegacyPawRunEvidenceResultV1 {
  assertSourceKind(input.sourceKind);
  assertRunId(input.runId);
  if (!path.isAbsolute(input.outputPath)) {
    throw new Error("Legacy evidence output path must be absolute");
  }
  const policy = freezePolicy(input.policy);
  const scanned = scanLegacySources(
    {
      legacyRuntimeRoot: input.legacyRuntimeRoot,
      policy,
    },
    hooks,
  );
  if (scanned.publicInventory.inventoryHash !== input.expectedInventoryHash) {
    throw new Error("Legacy run inventory changed");
  }
  const matches = scanned.entries.filter(
    (entry) =>
      entry.publicEntry.sourceKind === LEGACY_RUN_SOURCE_KIND_V1 &&
      entry.publicEntry.runId === input.runId,
  );
  if (matches.length !== 1) {
    throw new Error("Legacy run identity is missing or ambiguous");
  }
  const entry = matches[0];
  if (!entry) throw new Error("Legacy run identity disappeared");
  if (entry.publicEntry.pairDigest !== input.expectedPairDigest) {
    throw new Error("Legacy run source pair changed");
  }
  if (entry.sources.some((source) => !source.collected)) {
    throw new Error("Legacy run source evidence could not be collected safely");
  }
  const outputPath = path.resolve(input.outputPath);
  assertOutputOutsideLegacySources(scanned.workspaceRoot, outputPath);
  const totalRawBytes = entry.sources.reduce(
    (total, source) => total + source.bytes.byteLength,
    0,
  );
  const encodedUpperBound = entry.sources.reduce(
    (total, source) =>
      total + 4 * Math.ceil(source.bytes.byteLength / 3) + 1_024,
    64 * 1_024,
  );
  const provenConstructionUpperBound =
    encodedUpperBound + 4 * totalRawBytes + 2_048 * entry.sources.length;
  if (provenConstructionUpperBound > policy.maxBundleBytes) {
    throw new Error("Legacy evidence bundle exceeds its proven byte limit");
  }
  const bundle = freezeJson({
    schemaVersion: LEGACY_RUN_EVIDENCE_SCHEMA_VERSION_V1,
    evidenceKind: "legacy_core_storage_evidence",
    scope: "core_journal_and_app_state_only",
    externalArtifacts: "not_collected",
    sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
    legacyRuntimeRootIdentityHash:
      scanned.publicInventory.legacyRuntimeRootIdentityHash,
    runId: input.runId,
    sourceStatus: entry.publicEntry.status,
    continuable: false,
    pairDigest: entry.publicEntry.pairDigest,
    issues: entry.publicEntry.issues,
    inspection: {
      ...(entry.journal ? { journal: entry.journal } : {}),
      ...(entry.appState ? { appState: entry.appState } : {}),
    },
    sourceFiles: entry.sources
      .map((source) => ({
        role: source.role,
        entryNameHash: sha256Text(`${source.role}\0${source.entryName}`),
        byteLength: source.bytes.byteLength,
        sha256: source.sha256,
        encoding: "base64",
        bytesBase64: source.bytes.toString("base64"),
      }))
      .sort(compareSourceFileIdentity),
  });
  const bundleHash = hashCanonicalJsonV1(bundle);
  const serialized = `${canonicalJson(bundle)}\n`;
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > policy.maxBundleBytes) {
    throw new Error("Legacy evidence bundle exceeds its byte limit");
  }
  const publishAnchor = scanLegacySources(
    {
      legacyRuntimeRoot: input.legacyRuntimeRoot,
      policy,
    },
    hooks,
  );
  if (
    publishAnchor.publicInventory.inventoryHash !== input.expectedInventoryHash
  ) {
    throw new Error("Legacy run inventory changed before publish");
  }
  const anchoredEntry = publishAnchor.entries.filter(
    (candidate) =>
      candidate.publicEntry.sourceKind === LEGACY_RUN_SOURCE_KIND_V1 &&
      candidate.publicEntry.runId === input.runId,
  );
  if (
    anchoredEntry.length !== 1 ||
    anchoredEntry[0]?.publicEntry.pairDigest !== input.expectedPairDigest
  ) {
    throw new Error("Legacy run source pair changed before publish");
  }
  const published = publishNoOverwrite(outputPath, serialized, hooks);
  if (!published) {
    return Object.freeze({
      status: "target_exists",
      sourceStatus: entry.publicEntry.status,
      continuable: false,
      reasonCode: "target_exists",
    });
  }
  return Object.freeze({
    status: "exported",
    sourceStatus: entry.publicEntry.status,
    continuable: false,
    bundleHash,
    byteLength,
  });
}

function scanLegacySources(
  input: DiscoverLegacyPawRunsInputV1,
  hooks?: LegacyRunOfflineHooksV1,
): InternalInventory {
  const policy = freezePolicy(input.policy);
  const rootAnchor = canonicalLegacyRuntimeRoot(input.legacyRuntimeRoot);
  const workspaceRoot = rootAnchor.path;
  const pawAnchor = captureOptionalDirectoryAnchor(
    workspaceRoot,
    path.join(workspaceRoot, ".paw"),
  );
  const legacyRuntimeRootIdentityHash = sha256Text(
    canonicalPathIdentity(workspaceRoot),
  );
  const totalSourceBytes = { value: 0 };
  const journalScan = readLegacyDirectory(
    workspaceRoot,
    path.join(workspaceRoot, ".paw", "sessions"),
    ".jsonl",
    "session_journal",
    policy,
    totalSourceBytes,
  );
  hooks?.afterJournalDirectoryRead?.();
  const stateScan = readLegacyDirectory(
    workspaceRoot,
    path.join(workspaceRoot, ".paw", "states"),
    ".json",
    "app_state",
    policy,
    totalSourceBytes,
  );
  if (
    journalScan.files.length + stateScan.files.length >
    policy.maxInventoryEntries
  ) {
    throw new Error("Legacy run inventory exceeds its entry limit");
  }
  const parsed = [
    ...journalScan.files.map((file) => parseJournalSource(file)),
    ...stateScan.files.map((file) => parseAppStateSource(file)),
  ];
  hooks?.afterSourcePairRead?.();
  revalidateLegacyDirectoryScan(workspaceRoot, journalScan, policy);
  revalidateLegacyDirectoryScan(workspaceRoot, stateScan, policy);
  assertStableDirectoryAnchor(rootAnchor, "Legacy runtime root changed");
  assertOptionalDirectoryAnchor(pawAnchor, "Legacy .paw root changed");
  const groups = new Map<string, StableSourceFile[]>();
  for (const source of parsed) {
    const key = source.claimedRunId ?? source.runIdHint;
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  const aliases = new Map<string, Set<string>>();
  for (const [runId, sources] of groups) {
    if (!sources.some((source) => source.valid)) continue;
    const safe = legacySanitizeRunId(runId);
    const values = aliases.get(safe) ?? new Set<string>();
    values.add(runId);
    aliases.set(safe, values);
  }
  const internalEntries: InternalEntry[] = [];
  for (const [runId, sources] of [...groups].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    internalEntries.push(
      buildCoreEntry(
        legacyRuntimeRootIdentityHash,
        runId,
        sources,
        (aliases.get(legacySanitizeRunId(runId))?.size ?? 0) > 1,
      ),
    );
  }
  const pawNextEntries = discoverPawNextStorage(
    workspaceRoot,
    policy.maxInventoryEntries,
  );
  if (
    internalEntries.length + pawNextEntries.length >
    policy.maxInventoryEntries
  ) {
    throw new Error("Legacy run inventory exceeds its entry limit");
  }
  internalEntries.push(...pawNextEntries);
  assertStableDirectoryAnchor(rootAnchor, "Legacy runtime root changed");
  assertOptionalDirectoryAnchor(pawAnchor, "Legacy .paw root changed");
  const sorted = internalEntries.sort((left, right) =>
    compareText(left.publicEntry.sourceId, right.publicEntry.sourceId),
  );
  const inventoryCore = {
    schemaVersion: "paw.legacy-run-inventory.v1" as const,
    legacyRuntimeRootIdentityHash,
    entries: sorted.map((entry) => entry.publicEntry),
  };
  const publicInventory = freezeJson({
    ...inventoryCore,
    inventoryHash: hashCanonicalJsonV1(inventoryCore),
  }) as unknown as LegacyRunInventoryV1;
  return { publicInventory, entries: sorted, workspaceRoot };
}

function buildCoreEntry(
  legacyRuntimeRootIdentityHash: string,
  runId: string,
  sources: readonly StableSourceFile[],
  hasSanitizedAlias: boolean,
): InternalEntry {
  const journals = sources.filter(
    (source) => source.role === "session_journal",
  );
  const states = sources.filter((source) => source.role === "app_state");
  const issues = new Set<LegacyRunEvidenceIssueV1>();
  if (journals.length === 0) issues.add("journal_missing");
  if (states.length === 0) issues.add("app_state_missing");
  for (const source of sources) if (source.issue) issues.add(source.issue);
  if (hasSanitizedAlias) issues.add("sanitized_run_id_alias");
  if (journals.length > 1 || states.length > 1) {
    issues.add("source_identity_mismatch");
  }
  for (const source of sources) {
    if (source.claimedRunId !== undefined && source.claimedRunId !== runId) {
      issues.add("source_identity_mismatch");
    }
    const expectedName =
      source.role === "session_journal"
        ? `${legacySanitizeRunId(runId)}.jsonl`
        : `${runId}.json`;
    if (source.entryName !== expectedName) issues.add("source_name_mismatch");
  }
  const validState =
    states.length === 1 && states[0]?.valid ? states[0] : undefined;
  if (validState?.appState) issues.add("app_state_workspace_untrusted");
  issues.add("external_artifacts_not_collected");
  let status: LegacyRunSourceStatusV1;
  if (sources.some((source) => !source.valid)) status = "corrupt";
  else if (
    issues.has("source_identity_mismatch") ||
    issues.has("source_name_mismatch") ||
    issues.has("sanitized_run_id_alias")
  ) {
    status = "ambiguous";
  } else if (journals.length === 1 && states.length === 1) {
    status = "paired_unbound";
  } else if (journals.length === 1) status = "journal_only";
  else status = "state_only";
  const files = sources
    .map((source) => ({
      role: source.role,
      entryNameHash: sha256Text(`${source.role}\0${source.entryName}`),
      byteLength: source.bytes.byteLength,
      sha256: source.sha256,
    }))
    .sort(compareSourceFileIdentity);
  const pairDigest = hashCanonicalJsonV1({
    sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
    legacyRuntimeRootIdentityHash,
    runId,
    files,
  });
  const publicEntry = freezeJson({
    sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
    sourceId: hashCanonicalJsonV1({
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId,
      pairDigest,
    }),
    runId,
    status,
    continuable: false,
    pairDigest,
    files,
    issues: [...issues].sort(compareText),
  }) as unknown as LegacyRunInventoryEntryV1;
  return {
    publicEntry,
    sources,
    ...(journals.length === 1 && journals[0]?.journal
      ? { journal: journals[0].journal }
      : {}),
    ...(states.length === 1 && states[0]?.appState
      ? {
          appState: {
            turn: states[0].appState.turn,
            maxSteps: states[0].appState.maxSteps,
            hasOutcome: states[0].appState.hasOutcome,
          },
        }
      : {}),
  };
}

function readLegacyDirectory(
  workspaceRoot: string,
  directory: string,
  extension: ".jsonl" | ".json",
  role: StableSourceFile["role"],
  policy: LegacyRunEvidencePolicyV1,
  totalSourceBytes: { value: number },
): LegacyDirectoryScan {
  const state = strictReadonlyDirectory(workspaceRoot, directory);
  if (!state) {
    return {
      directory,
      extension,
      role,
      exists: false,
      entryNames: [],
      files: [],
    };
  }
  const beforeNames = readBoundedDirectoryNames(
    directory,
    policy.maxInventoryEntries,
  );
  const selected = beforeNames.filter((name) => name.endsWith(extension));
  const files = selected.map((entryName) => {
    const filePath = path.join(directory, entryName);
    let bytes: Buffer = Buffer.from([]);
    let collected = false;
    try {
      bytes = readStableSingleLinkFile(
        workspaceRoot,
        filePath,
        policy.maxSourceFileBytes,
      );
      collected = true;
    } catch {
      // Keep a corrupt isolated inventory entry without following or copying
      // an unsafe source. Export refuses entries whose bytes were not collected.
    }
    if (collected) {
      totalSourceBytes.value += bytes.byteLength;
      if (totalSourceBytes.value > policy.maxTotalSourceBytes) {
        throw new Error("Legacy sources exceed their aggregate byte limit");
      }
    }
    return {
      role,
      entryName,
      absolutePath: filePath,
      bytes,
      sha256: sha256Bytes(bytes),
      collected,
      pathFingerprint: sourcePathFingerprintFromPath(filePath),
      runIdHint: entryName.slice(0, -extension.length),
    };
  });
  const afterNames = readBoundedDirectoryNames(
    directory,
    policy.maxInventoryEntries,
  );
  const afterStat = fs.lstatSync(directory);
  if (
    beforeNames.join("\0") !== afterNames.join("\0") ||
    !sameFileIdentity(state, afterStat)
  ) {
    throw new Error("Legacy source directory changed during inventory");
  }
  return {
    directory,
    extension,
    role,
    exists: true,
    directoryStat: state,
    directoryIdentityKey: directoryIdentityKey(directory),
    entryNames: selected,
    files,
  };
}

function parseJournalSource(
  source: Omit<StableSourceFile, "valid">,
): StableSourceFile {
  if (!source.collected) {
    return { ...source, valid: false, issue: "journal_invalid" };
  }
  try {
    const text = decodeUtf8(source.bytes, "legacy session journal");
    const lines = text.split("\n");
    let claimedRunId: string | undefined;
    let priorSeq = 0;
    const eventTypes = new Set<string>();
    let count = 0;
    let firstSeq = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as unknown;
      const record = asRecord(value, "legacy session envelope");
      const runId = requiredText(record.runId, "legacy session runId");
      const seq = positiveSafeInteger(record.seq, "legacy session seq");
      if (seq !== priorSeq + 1) {
        throw new Error("legacy session sequence is not contiguous from one");
      }
      if (claimedRunId !== undefined && claimedRunId !== runId) {
        throw new Error("legacy session contains multiple run identities");
      }
      const ts = record.ts;
      if (typeof ts !== "number" || !Number.isFinite(ts)) {
        throw new Error("legacy session timestamp is invalid");
      }
      const event = asRecord(record.event, "legacy session event");
      eventTypes.add(requiredText(event.type, "legacy session event type"));
      claimedRunId = runId;
      if (count === 0) firstSeq = seq;
      priorSeq = seq;
      count += 1;
    }
    if (count === 0 || claimedRunId === undefined) {
      throw new Error("legacy session journal is empty");
    }
    return {
      ...source,
      claimedRunId,
      valid: true,
      journal: Object.freeze({
        eventCount: count,
        firstSeq,
        lastSeq: priorSeq,
        eventTypes: Object.freeze([...eventTypes].sort(compareText)),
      }),
    };
  } catch {
    return { ...source, valid: false, issue: "journal_invalid" };
  }
}

function parseAppStateSource(
  source: Omit<StableSourceFile, "valid">,
): StableSourceFile {
  if (!source.collected) {
    return { ...source, valid: false, issue: "app_state_invalid" };
  }
  try {
    const text = decodeUtf8(source.bytes, "legacy app state");
    const record = asRecord(JSON.parse(text) as unknown, "legacy app state");
    const claimedRunId = requiredText(record.runId, "legacy app state runId");
    const workspaceRoot = requiredText(
      record.workspaceRoot,
      "legacy app state workspaceRoot",
    );
    requiredText(record.goal, "legacy app state goal");
    const turn = nonNegativeSafeInteger(record.turn, "legacy app state turn");
    const maxSteps = positiveSafeInteger(
      record.maxSteps,
      "legacy app state maxSteps",
    );
    if (!Array.isArray(record.messages)) {
      throw new Error("legacy app state messages are invalid");
    }
    if (
      typeof record.savedAt !== "number" ||
      !Number.isFinite(record.savedAt)
    ) {
      throw new Error("legacy app state savedAt is invalid");
    }
    return {
      ...source,
      claimedRunId,
      valid: true,
      appState: Object.freeze({
        turn,
        maxSteps,
        hasOutcome: record.outcome !== undefined,
        workspaceRoot,
      }),
    };
  } catch {
    return { ...source, valid: false, issue: "app_state_invalid" };
  }
}

function discoverPawNextStorage(
  workspaceRoot: string,
  maxEntries: number,
): InternalEntry[] {
  const sessionsRoot = path.join(workspaceRoot, ".paw", "paw-next", "sessions");
  if (strictReadonlyDirectory(workspaceRoot, sessionsRoot)) {
    readBoundedDirectoryNames(sessionsRoot, maxEntries);
  }
  const discovery = discoverFileSessionAuthoritiesV1({ workspaceRoot });
  return discovery.entries.flatMap((entry) => pawNextDiscoveryEntry(entry));
}

function pawNextDiscoveryEntry(
  entry: FileSessionAuthorityDiscoveryEntryV1,
): InternalEntry[] {
  if (entry.status === "discovered") {
    const runs =
      entry.inventory.runs.length > 0 ? entry.inventory.runs : [undefined];
    return runs.map((run) =>
      opaqueEntry({
        sourceKind: "paw_next_authority_v2",
        sourceKey: `${entry.entryName}\0${run?.runId ?? ""}`,
        ...(run ? { runId: run.runId } : {}),
        sessionId: entry.sessionId,
        status: "already_current",
        issue: "current_paw_next_run_not_migrated",
      }),
    );
  }
  return [
    opaqueEntry({
      sourceKind: "paw_next_authority_v2",
      sourceKey: entry.entryName,
      status: "corrupt",
      issue: "current_paw_next_run_not_migrated",
    }),
  ];
}

function opaqueEntry(input: {
  readonly sourceKind: LegacyRunInventoryEntryV1["sourceKind"];
  readonly sourceKey: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly status: "unsupported" | "already_current" | "corrupt";
  readonly issue: LegacyRunEvidenceIssueV1;
}): InternalEntry {
  const pairDigest = hashCanonicalJsonV1({
    sourceKind: input.sourceKind,
    sourceKey: input.sourceKey,
    status: input.status,
  });
  return {
    publicEntry: freezeJson({
      sourceKind: input.sourceKind,
      sourceId: hashCanonicalJsonV1({
        sourceKind: input.sourceKind,
        sourceKey: input.sourceKey,
      }),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      status: input.status,
      continuable: false,
      pairDigest,
      files: [],
      issues: [input.issue],
    }) as unknown as LegacyRunInventoryEntryV1,
    sources: [],
  };
}

function freezePolicy(
  policy: LegacyRunEvidencePolicyV1 | undefined,
): LegacyRunEvidencePolicyV1 {
  const value = policy ?? DEFAULT_LEGACY_RUN_EVIDENCE_POLICY_V1;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      "maxBundleBytes\0maxInventoryEntries\0maxSourceFileBytes\0maxTotalSourceBytes\0policyVersion" ||
    value.policyVersion !== LEGACY_RUN_EVIDENCE_POLICY_VERSION_V1 ||
    !positiveSafe(value.maxInventoryEntries) ||
    !positiveSafe(value.maxSourceFileBytes) ||
    !positiveSafe(value.maxTotalSourceBytes) ||
    value.maxSourceFileBytes > value.maxTotalSourceBytes ||
    value.maxTotalSourceBytes > value.maxBundleBytes ||
    !positiveSafe(value.maxBundleBytes)
  ) {
    throw new Error("Legacy run evidence policy is invalid");
  }
  return Object.freeze({ ...value });
}

function canonicalLegacyRuntimeRoot(
  legacyRuntimeRoot: string,
): StableDirectoryAnchor {
  if (
    typeof legacyRuntimeRoot !== "string" ||
    !path.isAbsolute(legacyRuntimeRoot)
  ) {
    throw new Error("Legacy runtime root must be absolute");
  }
  const resolved = path.resolve(legacyRuntimeRoot);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Legacy runtime root must be a real directory");
  }
  const canonical = fs.realpathSync.native(resolved);
  if (canonicalPathIdentity(resolved) !== canonicalPathIdentity(canonical)) {
    throw new Error("Legacy runtime root must not contain linked ancestors");
  }
  return {
    path: canonical,
    stat,
    identityKey: directoryIdentityKey(canonical),
  };
}

function strictReadonlyDirectory(
  workspaceRoot: string,
  directory: string,
): fs.Stats | undefined {
  const relative = path.relative(workspaceRoot, directory);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error("Legacy source directory escaped the workspace");
  }
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (fsError(error, "ENOENT")) return undefined;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Legacy source path contains an unsafe directory");
    }
    const canonical = fs.realpathSync.native(current);
    if (!isWithin(workspaceRoot, canonical)) {
      throw new Error("Legacy source directory escaped the workspace");
    }
  }
  return fs.lstatSync(directory);
}

function revalidateLegacyDirectoryScan(
  workspaceRoot: string,
  scan: LegacyDirectoryScan,
  policy: LegacyRunEvidencePolicyV1,
): void {
  const current = strictReadonlyDirectory(workspaceRoot, scan.directory);
  if (!scan.exists) {
    if (current !== undefined) {
      throw new Error("Legacy source directory appeared during inventory");
    }
    return;
  }
  if (!current) throw new Error("Legacy source directory disappeared");
  if (
    !scan.directoryStat ||
    !sameFileIdentity(scan.directoryStat, current) ||
    scan.directoryIdentityKey !== directoryIdentityKey(scan.directory)
  ) {
    throw new Error("Legacy source directory identity changed");
  }
  const names = readBoundedDirectoryNames(
    scan.directory,
    policy.maxInventoryEntries,
  )
    .filter((name) => name.endsWith(scan.extension))
    .sort(compareText);
  if (names.join("\0") !== scan.entryNames.join("\0")) {
    throw new Error("Legacy source directory changed after paired read");
  }
  for (const source of scan.files) {
    if (
      sourcePathFingerprintFromPath(source.absolutePath) !==
      source.pathFingerprint
    ) {
      throw new Error("Legacy source identity changed after paired read");
    }
    if (!source.collected) {
      continue;
    }
    const reread = readStableSingleLinkFile(
      workspaceRoot,
      source.absolutePath,
      policy.maxSourceFileBytes,
    );
    if (sha256Bytes(reread) !== source.sha256) {
      throw new Error("Legacy source changed after paired read");
    }
  }
}

function sourcePathFingerprintFromPath(filePath: string): string {
  const stat = fs.lstatSync(filePath, { bigint: true });
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
    stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    stat.isSymbolicLink() ? "link" : "nonlink",
  ].join(":");
}

function readStableSingleLinkFile(
  workspaceRoot: string,
  filePath: string,
  maxBytes: number,
): Buffer {
  assertSafeSourceAncestors(workspaceRoot, filePath);
  const pathBefore = fs.lstatSync(filePath);
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.nlink !== 1
  ) {
    throw new Error("Legacy source must be a single-link regular file");
  }
  if (pathBefore.size > maxBytes) {
    throw new Error("Legacy source exceeds its byte limit");
  }
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileIdentity(pathBefore, openedBefore)) {
      throw new Error("Legacy source changed before read");
    }
    const bytes = fs.readFileSync(descriptor);
    if (bytes.byteLength > maxBytes) {
      throw new Error("Legacy source exceeds its byte limit");
    }
    const openedAfter = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(filePath);
    if (
      !sameStableFile(openedBefore, openedAfter) ||
      !sameStableFile(openedAfter, pathAfter) ||
      openedAfter.size !== bytes.byteLength
    ) {
      throw new Error("Legacy source changed during read");
    }
    assertSafeSourceAncestors(workspaceRoot, filePath);
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertOutputOutsideLegacySources(
  workspaceRoot: string,
  outputPath: string,
): void {
  const forbidden = [path.join(workspaceRoot, ".paw")];
  if (forbidden.some((root) => isWithin(root, outputPath))) {
    throw new Error("Legacy evidence output must be outside source storage");
  }
}

function publishNoOverwrite(
  outputPath: string,
  bytes: string,
  hooks?: LegacyRunOfflineHooksV1,
): boolean {
  const parent = path.dirname(outputPath);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error("Legacy evidence output parent must be a real directory");
  }
  const canonicalParent = fs.realpathSync.native(parent);
  if (
    canonicalPathIdentity(canonicalParent) !== canonicalPathIdentity(parent)
  ) {
    throw new Error("Legacy evidence output parent is not canonical");
  }
  const parentAnchor: StableDirectoryAnchor = {
    path: canonicalParent,
    stat: parentStat,
    identityKey: directoryIdentityKey(canonicalParent),
  };
  try {
    fs.lstatSync(outputPath);
    return false;
  } catch (error) {
    if (!fsError(error, "ENOENT")) throw error;
  }
  const tempPath = path.join(
    parent,
    `.${path.basename(outputPath)}.paw-legacy-publish-${process.pid}-${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  let tempIdentity: fs.BigIntStats | undefined;
  let linked = false;
  let targetExists = false;
  let cleanupError: unknown;
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    tempIdentity = fs.fstatSync(descriptor, { bigint: true });
    if (
      !tempIdentity.isFile() ||
      tempIdentity.isSymbolicLink() ||
      tempIdentity.nlink !== 1n
    ) {
      throw new Error("Legacy evidence publisher temp identity is invalid");
    }
    fs.writeFileSync(descriptor, bytes, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    hooks?.afterPublisherTempFsync?.();
    assertStableDirectoryAnchor(
      parentAnchor,
      "Legacy evidence output parent changed",
    );
    assertPublisherPath(tempPath, tempIdentity, 1);
    try {
      fs.linkSync(tempPath, outputPath);
      linked = true;
    } catch (error) {
      if (fsError(error, "EEXIST")) targetExists = true;
      else throw error;
    }
    if (linked) {
      hooks?.afterPublisherLink?.();
      assertPublisherPath(tempPath, tempIdentity, 2);
      assertPublisherPath(outputPath, tempIdentity, 2);
    }
    assertStableDirectoryAnchor(
      parentAnchor,
      "Legacy evidence output parent changed",
    );
    if (linked) fsyncDirectoryForPublish(parent);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      if (tempIdentity !== undefined) {
        assertPublisherPath(tempPath, tempIdentity, linked ? 2 : 1);
        fs.unlinkSync(tempPath);
        fsyncDirectoryForPublish(parent);
      }
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (cleanupError !== undefined) {
    throw new Error("Legacy evidence publisher cleanup failed", {
      cause: cleanupError,
    });
  }
  if (targetExists) return false;
  assertStableDirectoryAnchor(
    parentAnchor,
    "Legacy evidence output parent changed",
  );
  const published = readStableSingleLinkFile(
    canonicalParent,
    outputPath,
    Buffer.byteLength(bytes, "utf8"),
  );
  if (published.toString("utf8") !== bytes) {
    throw new Error("Legacy evidence output verification failed");
  }
  assertStableDirectoryAnchor(
    parentAnchor,
    "Legacy evidence output parent changed",
  );
  return true;
}

function assertPublisherPath(
  filePath: string,
  identity: fs.BigIntStats,
  expectedLinks: number,
): void {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== BigInt(expectedLinks) ||
    identity.dev !== stat.dev ||
    identity.ino !== stat.ino
  ) {
    throw new Error("Legacy evidence publisher path identity changed");
  }
}

function assertStableDirectoryAnchor(
  anchor: StableDirectoryAnchor,
  message: string,
): void {
  const stat = fs.lstatSync(anchor.path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !sameFileIdentity(anchor.stat, stat) ||
    anchor.identityKey !== directoryIdentityKey(anchor.path) ||
    canonicalPathIdentity(fs.realpathSync.native(anchor.path)) !==
      canonicalPathIdentity(anchor.path)
  ) {
    throw new Error(message);
  }
}

function captureOptionalDirectoryAnchor(
  workspaceRoot: string,
  directory: string,
): OptionalDirectoryAnchor {
  const stat = strictReadonlyDirectory(workspaceRoot, directory);
  return stat
    ? { path: directory, stat, identityKey: directoryIdentityKey(directory) }
    : { path: directory };
}

function assertOptionalDirectoryAnchor(
  anchor: OptionalDirectoryAnchor,
  message: string,
): void {
  let current: fs.Stats | undefined;
  try {
    current = fs.lstatSync(anchor.path);
  } catch (error) {
    if (!fsError(error, "ENOENT")) throw error;
  }
  if (anchor.stat === undefined) {
    if (current !== undefined) throw new Error(message);
    return;
  }
  if (
    current === undefined ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameFileIdentity(anchor.stat, current) ||
    anchor.identityKey !== directoryIdentityKey(anchor.path) ||
    canonicalPathIdentity(fs.realpathSync.native(anchor.path)) !==
      canonicalPathIdentity(anchor.path)
  ) {
    throw new Error(message);
  }
}

function assertSafeSourceAncestors(
  workspaceRoot: string,
  filePath: string,
): void {
  const parent = path.dirname(filePath);
  const relative = path.relative(workspaceRoot, parent);
  if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error("Legacy source file escaped its root");
  }
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Legacy source ancestor is unsafe");
    }
    if (!isWithin(workspaceRoot, fs.realpathSync.native(current))) {
      throw new Error("Legacy source ancestor escaped its root");
    }
  }
}

function fsyncDirectoryForPublish(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (
      process.platform === "win32" &&
      ["EINVAL", "EPERM", "EACCES", "EBADF", "EISDIR"].some((code) =>
        fsError(error, code),
      )
    ) {
      return;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function canonicalJson(value: unknown): string {
  return canonicalJsonValue(toFrozenJsonValueV1(value));
}

function canonicalJsonValue(
  value: ReturnType<typeof toFrozenJsonValueV1>,
): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonValue(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonValue(item)}`)
    .join(",")}}`;
}

function freezeJson(value: unknown): unknown {
  return toFrozenJsonValueV1(value);
}

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function canonicalPathIdentity(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.split(path.sep).includes(".."))
  );
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryIdentityKey(directory: string): string {
  const stat = fs.lstatSync(directory, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function sameStableFile(left: fs.Stats, right: fs.Stats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    right.nlink === 1
  );
}

function legacySanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function assertSourceKind(value: unknown): void {
  if (value !== LEGACY_RUN_SOURCE_KIND_V1) {
    throw new Error("Legacy run source kind is unsupported");
  }
}

function assertRunId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error("Legacy run id is invalid");
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!positiveSafe(value)) throw new Error(`${label} is invalid`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

function positiveSafe(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sha256Bytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readBoundedDirectoryNames(
  directory: string,
  maxEntries: number,
): string[] {
  const handle = fs.opendirSync(directory);
  const names: string[] = [];
  try {
    while (true) {
      const entry = handle.readSync();
      if (!entry) break;
      names.push(entry.name);
      if (names.length > maxEntries) {
        throw new Error("Legacy source directory exceeds its entry limit");
      }
    }
  } finally {
    handle.closeSync();
  }
  return names.sort(compareText);
}

function compareSourceFileIdentity(
  left: { readonly role: string; readonly entryNameHash: string },
  right: { readonly role: string; readonly entryNameHash: string },
): number {
  return (
    compareText(left.role, right.role) ||
    compareText(left.entryNameHash, right.entryNameHash)
  );
}

function fsError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
