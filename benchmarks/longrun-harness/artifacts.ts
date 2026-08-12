/**
 * Long-run harness artifacts (Anthropic-style handoff).
 * Disk is the source of truth across sessions — not chat history.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export type FeatureCategory = "functional" | "style" | "ux" | "data" | "infra";

export type E2eAction =
  | { readonly type: "goto"; readonly path: string }
  | { readonly type: "click"; readonly selector: string }
  | { readonly type: "fill"; readonly selector: string; readonly value: string }
  | {
      readonly type: "expect_text";
      readonly selector: string;
      readonly text: string;
    }
  | {
      readonly type: "expect_visible";
      readonly selector: string;
    }
  | {
      readonly type: "expect_count";
      readonly selector: string;
      readonly count: number;
    };

export interface FeatureItem {
  readonly id: string;
  readonly category: FeatureCategory;
  readonly description: string;
  readonly steps: readonly string[];
  passes: boolean;
  /** Machine-checkable desktop E2E (harness runs Playwright). */
  readonly e2e?: {
    readonly actions: readonly E2eAction[];
  };
}

export interface LongrunArtifacts {
  readonly workspaceRoot: string;
  readonly featureListPath: string;
  readonly progressPath: string;
  readonly appSpecPath: string;
  readonly initScriptPath: string;
  readonly harnessLedgerPath: string;
  readonly harnessLedgerBackupPath: string;
}

export function artifactPaths(workspaceRoot: string): LongrunArtifacts {
  return {
    workspaceRoot,
    featureListPath: path.join(workspaceRoot, "feature_list.json"),
    progressPath: path.join(workspaceRoot, "paw-progress.md"),
    appSpecPath: path.join(workspaceRoot, "app_spec.txt"),
    initScriptPath: path.join(workspaceRoot, "init.mjs"),
    harnessLedgerPath: path.join(
      workspaceRoot,
      ".paw",
      "longrun-feature-ledger.json",
    ),
    harnessLedgerBackupPath: path.join(
      workspaceRoot,
      ".paw",
      "longrun-feature-ledger.backup.json",
    ),
  };
}

const LEDGER_SCHEMA = "paw.longrun-feature-ledger";
const LEDGER_VERSION = 1;

interface HarnessLedgerEnvelope {
  readonly schema: typeof LEDGER_SCHEMA;
  readonly version: typeof LEDGER_VERSION;
  readonly updatedAt: string;
  readonly featuresSha256: string;
  readonly features: readonly FeatureItem[];
}

function featuresHash(features: readonly FeatureItem[]): string {
  return createHash("sha256").update(JSON.stringify(features)).digest("hex");
}

function assertFeatureList(value: unknown, source: string): FeatureItem[] {
  if (!Array.isArray(value)) throw new Error(`${source} must contain a feature array`);
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object") {
      throw new Error(`${source} feature[${index}] must be an object`);
    }
    const feature = item as Partial<FeatureItem>;
    if (typeof feature.id !== "string" || feature.id.length === 0) {
      throw new Error(`${source} feature[${index}].id must be non-empty`);
    }
    if (ids.has(feature.id)) throw new Error(`${source} duplicate feature id: ${feature.id}`);
    ids.add(feature.id);
    if (
      !["functional", "style", "ux", "data", "infra"].includes(
        String(feature.category),
      ) ||
      typeof feature.description !== "string" ||
      !Array.isArray(feature.steps) ||
      !feature.steps.every((step) => typeof step === "string") ||
      typeof feature.passes !== "boolean"
    ) {
      throw new Error(`${source} feature contract invalid: ${feature.id}`);
    }
  }
  return value as FeatureItem[];
}

function parseLedger(raw: string, source: string): FeatureItem[] {
  const parsed = JSON.parse(raw) as unknown;
  // One-time migration from the pre-versioned array format.
  if (Array.isArray(parsed)) return assertFeatureList(parsed, source);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${source} must be an object`);
  }
  const envelope = parsed as Partial<HarnessLedgerEnvelope>;
  if (envelope.schema !== LEDGER_SCHEMA || envelope.version !== LEDGER_VERSION) {
    throw new Error(`${source} schema/version unsupported`);
  }
  const features = assertFeatureList(envelope.features, source);
  if (envelope.featuresSha256 !== featuresHash(features)) {
    throw new Error(`${source} integrity hash mismatch`);
  }
  return features;
}

function atomicWriteFile(targetPath: string, text: string): void {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, "wx");
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, targetPath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function serializeLedger(features: readonly FeatureItem[]): string {
  const envelope: HarnessLedgerEnvelope = {
    schema: LEDGER_SCHEMA,
    version: LEDGER_VERSION,
    updatedAt: new Date().toISOString(),
    featuresSha256: featuresHash(features),
    features,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function persistHarnessLedger(
  workspaceRoot: string,
  features: readonly FeatureItem[],
  rotateBackup: boolean,
): void {
  const paths = artifactPaths(workspaceRoot);
  mkdirSync(path.dirname(paths.harnessLedgerPath), { recursive: true });
  if (rotateBackup && existsSync(paths.harnessLedgerPath)) {
    // The caller only reaches normal saves after a verified load, so the
    // previous canonical file is safe to retain as last-known-good recovery.
    atomicWriteFile(
      paths.harnessLedgerBackupPath,
      readFileSync(paths.harnessLedgerPath, "utf8"),
    );
  }
  atomicWriteFile(paths.harnessLedgerPath, serializeLedger(features));
  // Mirror is intentionally second: a crash can leave it stale, but never
  // authoritative. The next harness run will refresh it from canonical.
  atomicWriteFile(
    paths.featureListPath,
    `${JSON.stringify(features, null, 2)}\n`,
  );
}

export function ensureWorkspace(workspaceRoot: string): void {
  mkdirSync(workspaceRoot, { recursive: true });
  // Anchor .paw so accidental findPawRoot from cwd tools stays here, not monorepo.
  mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
}

export function hasFeatureList(workspaceRoot: string): boolean {
  return existsSync(artifactPaths(workspaceRoot).featureListPath);
}

export function loadFeatureList(workspaceRoot: string): FeatureItem[] {
  const p = artifactPaths(workspaceRoot).featureListPath;
  if (!existsSync(p)) return [];
  const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
  return assertFeatureList(raw, "feature_list.json");
}

export function saveFeatureList(
  workspaceRoot: string,
  features: readonly FeatureItem[],
): void {
  const p = artifactPaths(workspaceRoot).featureListPath;
  writeFileSync(p, `${JSON.stringify(features, null, 2)}\n`, "utf8");
}

export function countRemaining(features: readonly FeatureItem[]): number {
  return features.filter((f) => !f.passes).length;
}

export function countPassing(features: readonly FeatureItem[]): number {
  return features.filter((f) => f.passes).length;
}

export function nextOpenFeature(
  features: readonly FeatureItem[],
  preferredIds?: readonly string[],
): FeatureItem | undefined {
  if (preferredIds) {
    for (const id of preferredIds) {
      const preferred = features.find((f) => f.id === id && !f.passes);
      if (preferred) return preferred;
    }
    return undefined;
  }
  return features.find((f) => !f.passes);
}

/** Load the verifier-owned ledger, seeding it once from the visible contract. */
export function loadHarnessLedger(workspaceRoot: string): FeatureItem[] {
  const paths = artifactPaths(workspaceRoot);
  if (existsSync(paths.harnessLedgerPath)) {
    try {
      const features = parseLedger(
        readFileSync(paths.harnessLedgerPath, "utf8"),
        "canonical harness ledger",
      );
      // Migrate legacy arrays to the versioned envelope on first read.
      const raw = JSON.parse(readFileSync(paths.harnessLedgerPath, "utf8"));
      if (Array.isArray(raw)) persistHarnessLedger(workspaceRoot, features, false);
      return features;
    } catch (canonicalError) {
      if (existsSync(paths.harnessLedgerBackupPath)) {
        try {
          const recovered = parseLedger(
            readFileSync(paths.harnessLedgerBackupPath, "utf8"),
            "backup harness ledger",
          );
          persistHarnessLedger(workspaceRoot, recovered, false);
          return recovered;
        } catch (backupError) {
          throw new Error(
            `canonical ledger invalid (${canonicalError instanceof Error ? canonicalError.message : String(canonicalError)}); backup invalid (${backupError instanceof Error ? backupError.message : String(backupError)})`,
          );
        }
      }
      throw canonicalError;
    }
  }
  const initial = loadFeatureList(workspaceRoot);
  saveHarnessLedger(workspaceRoot, initial);
  return initial;
}

/** Persist authoritative state and refresh the agent-visible read-only mirror. */
export function saveHarnessLedger(
  workspaceRoot: string,
  features: readonly FeatureItem[],
): void {
  assertFeatureList(features, "harness feature ledger");
  persistHarnessLedger(workspaceRoot, features, true);
}

export interface FeatureLedgerAudit {
  readonly changedPassClaims: readonly string[];
  readonly contractViolations: readonly string[];
}

export function setFeaturePasses(
  features: FeatureItem[],
  id: string,
  passes: boolean,
): FeatureItem[] {
  return features.map((f) => (f.id === id ? { ...f, passes } : f));
}

/**
 * Compare the agent-visible ledger with the harness-owned canonical snapshot.
 * The agent may read it, but neither pass claims nor contracts are authoritative.
 */
export function auditFeatureLedger(
  canonical: readonly FeatureItem[],
  candidate: readonly FeatureItem[],
): FeatureLedgerAudit {
  const changedPassClaims: string[] = [];
  const contractViolations: string[] = [];
  const byId = new Map(candidate.map((feature) => [feature.id, feature]));
  const duplicateIds = candidate
    .map((feature) => feature.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);

  for (const id of new Set(duplicateIds)) {
    contractViolations.push(`duplicate feature id: ${id}`);
  }

  if (canonical.length !== candidate.length) {
    contractViolations.push(
      `feature count changed ${canonical.length} -> ${candidate.length}`,
    );
  }
  for (const expected of canonical) {
    const actual = byId.get(expected.id);
    if (!actual) {
      contractViolations.push(`feature removed: ${expected.id}`);
      continue;
    }
    if (actual.passes !== expected.passes) changedPassClaims.push(expected.id);
    const expectedContract = JSON.stringify({
      id: expected.id,
      category: expected.category,
      description: expected.description,
      steps: expected.steps,
      e2e: expected.e2e,
    });
    const actualContract = JSON.stringify({
      id: actual.id,
      category: actual.category,
      description: actual.description,
      steps: actual.steps,
      e2e: actual.e2e,
    });
    if (actualContract !== expectedContract) {
      contractViolations.push(`feature contract changed: ${expected.id}`);
    }
  }
  for (const actual of candidate) {
    if (!canonical.some((feature) => feature.id === actual.id)) {
      contractViolations.push(`feature added: ${actual.id}`);
    }
  }
  return { changedPassClaims, contractViolations };
}

export function readProgress(workspaceRoot: string): string {
  const p = artifactPaths(workspaceRoot).progressPath;
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

export function appendProgressSession(
  workspaceRoot: string,
  session: {
    readonly sessionIndex: number;
    readonly role: "initializer" | "coding";
    readonly summary: string;
    readonly featureId?: string;
    readonly status: string;
  },
): void {
  const p = artifactPaths(workspaceRoot).progressPath;
  const stamp = new Date().toISOString();
  const block = [
    ``,
    `## Session ${session.sessionIndex} (${session.role}) — ${stamp}`,
    ``,
    `- status: ${session.status}`,
    session.featureId ? `- feature: ${session.featureId}` : null,
    ``,
    session.summary.trim() || "(no summary)",
    ``,
  ]
    .filter((x) => x !== null)
    .join("\n");
  if (!existsSync(p)) {
    writeFileSync(
      p,
      `# paw-progress\n\nCross-session handoff log for long-run harness.\n`,
      "utf8",
    );
  }
  appendFileSync(p, block, "utf8");
}

export function writeInitialProgress(workspaceRoot: string): void {
  const p = artifactPaths(workspaceRoot).progressPath;
  if (existsSync(p)) return;
  writeFileSync(
    p,
    [
      `# paw-progress`,
      ``,
      `Cross-session handoff log. Next coding agents: read this first, then feature_list.json and git log.`,
      ``,
      `## What's done`,
      ``,
      `(empty)`,
      ``,
      `## What's next`,
      ``,
      `Run initializer / implement first open feature.`,
      ``,
      `## Notes for the next session`,
      ``,
      `- Prefer editing existing tracked source; do not invent helper scripts that never run.`,
      `- Treat feature_list.json as read-only; the outer Playwright verifier owns pass/fail.`,
      ``,
    ].join("\n"),
    "utf8",
  );
}
