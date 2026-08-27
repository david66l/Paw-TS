import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Session, SessionInputSnapshot } from "@paw/agent-loop";
import {
  type DerivedDecisionV1,
  type InputFactV1,
  type JsonValue,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  assertRunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";
import {
  canonicalJsonStringifyV1,
  immutableCanonicalJsonCloneV1,
} from "../context/canonical-json.js";
import {
  type CanonicalPayloadIdentityV1,
  freezeCanonicalPayloadIdentityV1,
} from "../payload/canonical-payload-identity.js";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  type FileSessionExecutionLeaseV1,
  type FileSessionJournalCommitIndexV1,
  type JournalCommitIndexEntryV1,
  type JournalHeadV1,
  type LinearizeJournalBatchInputV1,
  type LinearizeRecoverySnapshotInputV1,
  type RecoverySnapshotCommitIndexEntryV1,
  SessionExecutionLeaseLostError,
  type VerifiedFileSessionExecutionLeaseCapabilityV1,
  assertFileSessionExecutionLeaseCapabilityV1,
  readFileSessionAuthorityInventoryV1,
  readFileSessionJournalCommitIndexStrictV1,
  readFileSessionJournalCommitIndexV1,
} from "./session-execution-lease.js";

const SESSION_METADATA_SCHEMA_V2 = "paw.file-run-session.v2" as const;
const ARTIFACT_SCHEMA_V2 = "paw.file-run-session.batch-artifact.v2" as const;
const RECOVERY_SNAPSHOT_SCHEMA_V2 =
  "paw.file-run-session.recovery-snapshot.v2" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_FILE = /^(\d{16})-(\d{16})-([0-9a-f]{64})\.json$/;
const ARTIFACT_TEMP =
  /^\d{16}-\d{16}-[0-9a-f]{64}\.json\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECOVERY_SNAPSHOT_FILE = /^snapshot-(\d{16})-([0-9a-f]{64})\.json$/;
const RECOVERY_SNAPSHOT_TEMP =
  /^snapshot-\d{16}-[0-9a-f]{64}\.json\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METADATA_TEMP =
  /^metadata\.json\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const liveOwners = new Map<string, symbol>();

export interface FileRunSessionCommitAttemptV1 {
  readonly commitId: string;
  readonly artifactFileName: string;
  readonly startSeq: number;
  readonly endSeq: number;
}

export interface FileRunSessionCommitHooksV1 {
  /** @internal Crash/race seam after immutable artifact publication. */
  readonly afterArtifactPublished?: (
    attempt: FileRunSessionCommitAttemptV1,
  ) => void;
  /** @internal Crash seam after authority commit but before memory publication. */
  readonly afterJournalLinearized?: (
    attempt: FileRunSessionCommitAttemptV1,
  ) => void;
  /** @internal Crash/loss seam after immutable snapshot publication. */
  readonly afterSnapshotArtifactPublished?: (
    attempt: FileRunSessionSnapshotAttemptV1,
  ) => void;
  /** @internal Crash seam after snapshot authority commit, before return. */
  readonly afterSnapshotLinearized?: (
    attempt: FileRunSessionSnapshotAttemptV1,
  ) => void;
}

export interface FileRunSessionSnapshotAttemptV1 {
  readonly snapshotId: string;
  readonly artifactFileName: string;
  readonly throughSeq: number;
  readonly prefixHash: string;
}

export interface FileRunSessionOptionsV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly executionLease: FileSessionExecutionLeaseV1;
  readonly clock?: () => number;
  readonly commitHooks?: FileRunSessionCommitHooksV1;
}

export type FileRunSessionRecoveryInfoV1 =
  | Readonly<{
      mode: "full_journal";
      snapshotThroughSeq: 0;
      tailEnvelopeCount: number;
    }>
  | Readonly<{
      mode: "snapshot_plus_tail";
      snapshotThroughSeq: number;
      tailEnvelopeCount: number;
    }>;

/** Immutable prefix cache committed through the Session authority chain. */
export interface FileRunSessionSnapshotResultV1 {
  readonly status: "created" | "reused";
  readonly throughSeq: number;
  readonly prefixHash: string;
}

export interface ReadCommittedFileRunPrefixOptionsV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly expectedHead: JournalHeadV1;
}

export class CommittedFileRunPrefixStaleError extends Error {
  constructor(readonly reason: "head" | "inventory") {
    super(
      reason === "head"
        ? "Committed File Run prefix head is stale"
        : "Committed File Run authority inventory changed while reading",
    );
    this.name = "CommittedFileRunPrefixStaleError";
  }
}

interface ReadCommittedFileRunPrefixTestOptionsV1
  extends ReadCommittedFileRunPrefixOptionsV1 {
  readonly afterAuthorityInventoryRead: () => void;
}

/**
 * Strict read-only view of one authority-committed run prefix.
 *
 * It never acquires a lease, repairs a publisher temp, or creates storage. The
 * Session authority inventory is read before and after artifact validation so
 * a concurrent inventory change fails as stale instead of returning a mixed
 * snapshot.
 */
export function readCommittedFileRunPrefixV1(
  options: ReadCommittedFileRunPrefixOptionsV1,
): readonly RunJournalEnvelopeV1[] {
  return readCommittedFileRunPrefix(options);
}

/** @internal Direct-module test seam; deliberately not exported by Runtime. */
export function readCommittedFileRunPrefixForTestV1(
  options: ReadCommittedFileRunPrefixTestOptionsV1,
): readonly RunJournalEnvelopeV1[] {
  return readCommittedFileRunPrefix(options);
}

function readCommittedFileRunPrefix(
  options:
    | ReadCommittedFileRunPrefixOptionsV1
    | ReadCommittedFileRunPrefixTestOptionsV1,
): readonly RunJournalEnvelopeV1[] {
  assertStableIds(options.sessionId, options.runId);
  assertJournalHead(options.expectedHead, "expectedHead");
  const workspaceRoot = fs.realpathSync.native(
    path.resolve(options.workspaceRoot),
  );
  const workspaceStat = fs.lstatSync(workspaceRoot);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error("Paw Next workspace root must be a real directory");
  }
  const before = readFileSessionAuthorityInventoryV1({
    workspaceRoot,
    sessionId: options.sessionId,
  });
  const run = before.runs.find((item) => item.runId === options.runId);
  if (!run || !sameHead(run.head, options.expectedHead)) {
    throw new CommittedFileRunPrefixStaleError("head");
  }
  if ("afterAuthorityInventoryRead" in options) {
    options.afterAuthorityInventoryRead();
  }
  const runDir = path.join(
    workspaceRoot,
    ".paw",
    "paw-next",
    "sessions",
    stablePathKey(options.sessionId),
    stablePathKey(options.runId),
  );
  const metadataPath = path.join(runDir, "metadata.json");
  const artifactsDir = path.join(runDir, "journal-artifacts");
  const snapshotsDir = path.join(runDir, "recovery-snapshots");
  const storage = inspectExistingRunStorage(
    workspaceRoot,
    runDir,
    metadataPath,
    artifactsDir,
    snapshotsDir,
    options.sessionId,
    options.runId,
  );
  if (!storage.metadataExists || !storage.artifactsExists) {
    throw new Error("Committed File Run storage is incomplete");
  }
  const authorityIndex = readFileSessionJournalCommitIndexStrictV1({
    workspaceRoot,
    sessionId: options.sessionId,
    runId: options.runId,
  });
  if (!sameHead(authorityIndex.head, run.head)) {
    throw new CommittedFileRunPrefixStaleError("head");
  }
  const loaded = loadRecoveredJournal(
    authorityIndex,
    artifactsDir,
    snapshotsDir,
    storage.snapshotsExists,
    true,
  );
  const after = readFileSessionAuthorityInventoryV1({
    workspaceRoot,
    sessionId: options.sessionId,
  });
  if (after.inventoryHash !== before.inventoryHash) {
    throw new CommittedFileRunPrefixStaleError("inventory");
  }
  return Object.freeze(loaded.envelopes.map(immutableEnvelopeClone));
}

interface JournalBatchArtifactV2 {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_V2;
  readonly sessionId: string;
  readonly runId: string;
  readonly previousTailSeq: number;
  readonly previousPrefixHash: string;
  readonly startSeq: number;
  readonly endSeq: number;
  readonly envelopes: readonly RunJournalEnvelopeV1[];
}

interface RecoverySnapshotArtifactV2 {
  readonly schemaVersion: typeof RECOVERY_SNAPSHOT_SCHEMA_V2;
  readonly sessionId: string;
  readonly runId: string;
  readonly throughSeq: number;
  readonly prefixHash: string;
  readonly envelopes: readonly RunJournalEnvelopeV1[];
}

/**
 * Paw Next's sole durable File Session writer.
 *
 * Artifact files contain protocol facts; the execution-lease event chain only
 * decides which immutable artifact refs are committed. There is no unfenced
 * write mode and no directory scan may promote an orphan into journal truth.
 */
export class FileRunSessionV1
  implements Session<InputFactV1, DerivedDecisionV1>
{
  private readonly sessionId: string;
  private readonly runId: string;
  private readonly workspaceRoot: string;
  private readonly runDir: string;
  private readonly artifactsDir: string;
  private readonly snapshotsDir: string;
  private readonly metadataPath: string;
  private readonly clock: () => number;
  private readonly leaseCapability: VerifiedFileSessionExecutionLeaseCapabilityV1;
  private readonly commitHooks: FileRunSessionCommitHooksV1 | undefined;
  private readonly owner = Symbol("file-run-session-owner");
  private readonly coordinatorIdentity: string;
  private envelopes: RunJournalEnvelopeV1[];
  private prefixHashValue: string;
  private recoveryInfoValue: FileRunSessionRecoveryInfoV1;
  private mutationQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: FileRunSessionOptionsV1) {
    assertStableIds(options.sessionId, options.runId);
    const workspaceRoot = fs.realpathSync.native(
      path.resolve(options.workspaceRoot),
    );
    const leaseCapability = assertFileSessionExecutionLeaseCapabilityV1(
      options.executionLease,
      workspaceRoot,
      options.sessionId,
      options.runId,
    );
    leaseCapability.assertHeld();

    this.sessionId = options.sessionId;
    this.runId = options.runId;
    this.workspaceRoot = workspaceRoot;
    this.leaseCapability = leaseCapability;
    this.clock = options.clock ?? Date.now;
    this.commitHooks = options.commitHooks;

    const sessionsRoot = path.join(
      workspaceRoot,
      ".paw",
      "paw-next",
      "sessions",
    );
    this.runDir = path.join(
      sessionsRoot,
      stablePathKey(this.sessionId),
      stablePathKey(this.runId),
    );
    this.artifactsDir = path.join(this.runDir, "journal-artifacts");
    this.snapshotsDir = path.join(this.runDir, "recovery-snapshots");
    this.metadataPath = path.join(this.runDir, "metadata.json");
    this.coordinatorIdentity = hashText(
      `${sessionsRoot}\u0000${this.sessionId}`,
    );
    if (liveOwners.has(this.runDir)) {
      throw new Error(
        "Paw Next run already has a live in-process Session owner",
      );
    }
    liveOwners.set(this.runDir, this.owner);

    try {
      const index = readFileSessionJournalCommitIndexV1({
        workspaceRoot,
        sessionId: this.sessionId,
        runId: this.runId,
      });
      const existing = inspectExistingRunStorage(
        this.workspaceRoot,
        this.runDir,
        this.metadataPath,
        this.artifactsDir,
        this.snapshotsDir,
        this.sessionId,
        this.runId,
      );
      if (
        index.commits.length > 0 &&
        (!existing.metadataExists || !existing.artifactsExists)
      ) {
        throw new Error("Fenced File Session storage is incomplete");
      }
      const recovered = existing.artifactsExists
        ? loadRecoveredJournal(
            index,
            this.artifactsDir,
            this.snapshotsDir,
            existing.snapshotsExists,
          )
        : emptyRecoveredJournal(index);
      // No filesystem mutation occurs before every existing entry, metadata,
      // artifact ref and protocol prefix above has passed strict validation.
      recoverMetadataPublication(
        existing,
        this.metadataPath,
        this.runDir,
        this.sessionId,
        this.runId,
      );
      if (!existing.artifactsExists) {
        ensureSafeDirectoryTree(this.workspaceRoot, this.artifactsDir);
      }
      if (!existing.metadataExists) {
        ensureFencedMetadata(
          this.metadataPath,
          this.sessionId,
          this.runId,
          index.commits.length === 0,
        );
      }
      this.envelopes = recovered.envelopes;
      this.prefixHashValue = recovered.prefixHash;
      this.recoveryInfoValue = recovered.recoveryInfo;
    } catch (error) {
      liveOwners.delete(this.runDir);
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    if (liveOwners.get(this.runDir) === this.owner) {
      liveOwners.delete(this.runDir);
    }
    this.closed = true;
  }

  readRecoveryInfo(): FileRunSessionRecoveryInfoV1 {
    this.assertActive();
    return { ...this.recoveryInfoValue };
  }

  /** @internal Same-process coordinator identity; not execution authority. */
  readCoordinatorOwnershipIdentity(): string {
    this.assertActive();
    return this.coordinatorIdentity;
  }

  /** Canonical journal owner used by location-aware Runtime decorators. */
  readCanonicalJournalIdentity(): CanonicalPayloadIdentityV1 {
    this.assertActive();
    return freezeCanonicalPayloadIdentityV1({
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      runId: this.runId,
    });
  }

  createRecoverySnapshot(): Promise<FileRunSessionSnapshotResultV1> {
    return this.serializeMutation(async () => {
      this.assertActive();
      const head = this.currentHead();
      if (head.tailSeq === 0) {
        throw new Error("Recovery snapshot requires a non-empty journal");
      }
      const index = readFileSessionJournalCommitIndexV1({
        workspaceRoot: this.workspaceRoot,
        sessionId: this.sessionId,
        runId: this.runId,
      });
      if (!sameHead(index.head, head)) {
        throw new Error("Recovery snapshot journal head changed");
      }
      const journalCommit = index.commits.at(-1);
      if (!journalCommit || !sameHead(journalCommit.head, head)) {
        throw new Error("Recovery snapshot has no current journal commit");
      }
      if (index.latestRecoverySnapshot) {
        validateExistingDirectoryTree(this.workspaceRoot, this.snapshotsDir);
        const latest = index.latestRecoverySnapshot;
        if (sameHead(latest.head, head)) {
          readRecoverySnapshotArtifact(
            this.snapshotsDir,
            latest,
            this.sessionId,
            this.runId,
            false,
          );
          this.recoveryInfoValue = {
            mode: "snapshot_plus_tail",
            snapshotThroughSeq: latest.throughSeq,
            tailEnvelopeCount: 0,
          };
          return {
            status: "reused",
            throughSeq: latest.throughSeq,
            prefixHash: latest.prefixHash,
          };
        }
      }
      ensureSafeDirectoryTree(this.workspaceRoot, this.snapshotsDir);
      const artifact: RecoverySnapshotArtifactV2 = {
        schemaVersion: RECOVERY_SNAPSHOT_SCHEMA_V2,
        sessionId: this.sessionId,
        runId: this.runId,
        throughSeq: head.tailSeq,
        prefixHash: head.prefixHash,
        envelopes: this.envelopes.map(immutableEnvelopeClone),
      };
      // Preserve the exact immutable envelope key order used by the journal
      // prefix hash. The artifact's own field order is fixed by this schema.
      const content = `${JSON.stringify(artifact)}\n`;
      const artifactHash = hashText(content);
      const artifactFileName = recoverySnapshotArtifactFileName(
        head.tailSeq,
        artifactHash,
      );
      const attempt: FileRunSessionSnapshotAttemptV1 = {
        snapshotId: artifactHash,
        artifactFileName,
        throughSeq: head.tailSeq,
        prefixHash: head.prefixHash,
      };
      publishContentAddressedSnapshot(
        this.snapshotsDir,
        artifactFileName,
        content,
      );
      this.commitHooks?.afterSnapshotArtifactPublished?.(attempt);
      this.assertActive();
      try {
        assertPublishedSnapshotStable(
          this.workspaceRoot,
          this.snapshotsDir,
          artifactFileName,
          artifactHash,
          content,
          head.tailSeq,
        );
      } catch (error) {
        this.failClosed(error);
      }
      const input: LinearizeRecoverySnapshotInputV1 = {
        snapshotId: artifactHash,
        journalCommitId: journalCommit.commitId,
        journalCommitEventSeq: journalCommit.eventSeq,
        head,
        throughSeq: head.tailSeq,
        prefixHash: head.prefixHash,
        artifactId: artifactHash,
        artifactFileName,
        artifactContentHash: artifactHash,
      };
      const result =
        await this.leaseCapability.linearizeRecoverySnapshot(input);
      if (result.status === "lost") {
        this.failClosed(
          new SessionExecutionLeaseLostError(
            "File Session lost execution lease during recovery snapshot commit",
          ),
        );
      }
      if (result.status === "conflict") {
        this.failClosed(
          new SessionExecutionLeaseLostError(
            "File Session recovery snapshot lost journal head CAS",
          ),
        );
      }
      try {
        this.commitHooks?.afterSnapshotLinearized?.(attempt);
      } catch (error) {
        this.failClosed(error);
      }
      this.recoveryInfoValue = {
        mode: "snapshot_plus_tail",
        snapshotThroughSeq: head.tailSeq,
        tailEnvelopeCount: 0,
      };
      return {
        status: result.status === "already_committed" ? "reused" : "created",
        throughSeq: head.tailSeq,
        prefixHash: head.prefixHash,
      };
    });
  }

  async readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>> {
    this.assertActive();
    const entries = this.envelopes.flatMap((envelope) =>
      envelope.record.kind === "input_fact"
        ? [{ seq: envelope.seq, fact: envelope.record.fact }]
        : [],
    );
    return {
      entries,
      tailSeq: this.tailSeq(),
      latestInputSeq: entries.at(-1)?.seq ?? 0,
    };
  }

  /** Canonical durable prefix for fenced recovery classification. */
  async readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]> {
    this.assertActive();
    return Object.freeze(this.envelopes.map(immutableEnvelopeClone));
  }

  appendInputFacts(facts: readonly InputFactV1[]): Promise<void> {
    const immutableFacts = facts.map(canonicalInputFactClone);
    return this.serializeMutation(async () => {
      this.assertActive();
      if (immutableFacts.length === 0) return;
      const status = await this.commitRecords(
        immutableFacts.map((fact) => ({ kind: "input_fact" as const, fact })),
      );
      if (status === "conflict") {
        throw new Error("Fenced File Session append lost journal head CAS");
      }
    });
  }

  commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    assertExpectedTailSeq(expectedTailSeq);
    const immutableFacts = facts.map(canonicalInputFactClone);
    return this.serializeMutation(async () => {
      this.assertActive();
      if (this.tailSeq() !== expectedTailSeq) return "conflict";
      if (immutableFacts.length === 0) {
        throw new Error("Input fact CAS commit requires at least one fact");
      }
      return this.commitRecords(
        immutableFacts.map((fact) => ({ kind: "input_fact" as const, fact })),
      );
    });
  }

  commitDerivedDecision(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
  ): Promise<"committed" | "conflict"> {
    assertExpectedTailSeq(expectedTailSeq);
    const immutableDecision = canonicalDerivedDecisionClone(decision);
    return this.serializeMutation(async () => {
      this.assertActive();
      if (this.tailSeq() !== expectedTailSeq) return "conflict";
      const latest = this.envelopes.at(-1);
      if (latest?.record.kind === "derived_decision") {
        if (sameDerivedDecision(latest.record.decision, immutableDecision)) {
          return "committed";
        }
        throw new Error(
          "Fenced File Session tail has a conflicting derived decision",
        );
      }
      return this.commitRecords([
        { kind: "derived_decision", decision: immutableDecision },
      ]);
    });
  }

  commitDecisionAndInputFacts(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    assertExpectedTailSeq(expectedTailSeq);
    const immutableDecision = canonicalDerivedDecisionClone(decision);
    const immutableFacts = facts.map(canonicalInputFactClone);
    return this.serializeMutation(async () => {
      this.assertActive();
      if (this.tailSeq() !== expectedTailSeq) return "conflict";
      if (this.envelopes.at(-1)?.record.kind === "derived_decision") {
        throw new Error(
          "Fenced File Session cannot append decision and facts after a derived decision",
        );
      }
      if (immutableFacts.length === 0) {
        throw new Error(
          "Decision-and-input commit requires at least one input fact",
        );
      }
      return this.commitRecords([
        { kind: "derived_decision", decision: immutableDecision },
        ...immutableFacts.map((fact) => ({
          kind: "input_fact" as const,
          fact,
        })),
      ]);
    });
  }

  private async commitRecords(
    records: readonly RunJournalEnvelopeV1["record"][],
  ): Promise<"committed" | "conflict"> {
    this.assertActive();
    validateExistingDirectoryTree(this.workspaceRoot, this.artifactsDir);
    const previousHead = this.currentHead();
    const startSeq = previousHead.tailSeq + 1;
    const envelopes = records.map((record, index): RunJournalEnvelopeV1 => {
      const envelope = {
        schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
        sessionId: this.sessionId,
        runId: this.runId,
        seq: startSeq + index,
        ts: this.readTimestamp(),
        record,
      };
      assertRunJournalEnvelopeV1(envelope);
      return immutableEnvelopeClone(envelope);
    });
    const nextPrefix = parseRunJournalPrefixV1([
      ...this.envelopes,
      ...envelopes,
    ]).map(immutableEnvelopeClone);
    const endSeq = nextPrefix.at(-1)?.seq ?? 0;
    const nextHead = {
      tailSeq: endSeq,
      prefixHash: hashEnvelopes(nextPrefix),
    };
    const artifact: JournalBatchArtifactV2 = {
      schemaVersion: ARTIFACT_SCHEMA_V2,
      sessionId: this.sessionId,
      runId: this.runId,
      previousTailSeq: previousHead.tailSeq,
      previousPrefixHash: previousHead.prefixHash,
      startSeq,
      endSeq,
      envelopes,
    };
    const content = `${JSON.stringify(artifact)}\n`;
    const artifactHash = hashText(content);
    const artifactFileName = journalArtifactFileName(
      startSeq,
      endSeq,
      artifactHash,
    );
    const commitId = artifactHash;
    const attempt = { commitId, artifactFileName, startSeq, endSeq };
    publishContentAddressedArtifact(
      this.artifactsDir,
      artifactFileName,
      content,
    );
    this.commitHooks?.afterArtifactPublished?.(attempt);
    this.assertActive();
    try {
      assertPublishedArtifactStable(
        this.workspaceRoot,
        this.artifactsDir,
        artifactFileName,
        artifactHash,
        content,
        startSeq,
        endSeq,
      );
    } catch (error) {
      this.failClosed(error);
    }
    const input: LinearizeJournalBatchInputV1 = {
      commitId,
      expectedHead: previousHead,
      nextHead,
      batchStartSeq: startSeq,
      batchEndSeq: endSeq,
      artifactId: artifactHash,
      artifactFileName,
      artifactContentHash: artifactHash,
    };
    const result = await this.leaseCapability.linearizeJournalBatch(input);
    if (result.status === "lost") {
      this.failClosed(
        new SessionExecutionLeaseLostError(
          "File Session lost execution lease during journal commit",
        ),
      );
    }
    if (result.status === "conflict") return "conflict";
    try {
      this.commitHooks?.afterJournalLinearized?.(attempt);
    } catch (error) {
      this.failClosed(error);
    }
    this.envelopes = [...nextPrefix];
    this.prefixHashValue = nextHead.prefixHash;
    this.recoveryInfoValue =
      this.recoveryInfoValue.mode === "snapshot_plus_tail"
        ? {
            mode: "snapshot_plus_tail",
            snapshotThroughSeq: this.recoveryInfoValue.snapshotThroughSeq,
            tailEnvelopeCount:
              this.envelopes.length - this.recoveryInfoValue.snapshotThroughSeq,
          }
        : {
            mode: "full_journal",
            snapshotThroughSeq: 0,
            tailEnvelopeCount: this.envelopes.length,
          };
    return "committed";
  }

  private serializeMutation<T>(action: () => Promise<T>): Promise<T> {
    const prior = this.mutationQueue;
    let unlock!: () => void;
    this.mutationQueue = new Promise((resolve) => {
      unlock = resolve;
    });
    return prior.then(action).finally(unlock);
  }

  private currentHead(): JournalHeadV1 {
    return { tailSeq: this.tailSeq(), prefixHash: this.prefixHashValue };
  }

  private readTimestamp(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Session clock must return a non-negative safe integer");
    }
    return value;
  }

  private tailSeq(): number {
    return this.envelopes.at(-1)?.seq ?? 0;
  }

  private assertActive(): void {
    this.assertOpen();
    if (this.leaseCapability.signal.aborted) {
      this.failClosed(
        new SessionExecutionLeaseLostError(
          "File Session execution lease aborted",
        ),
      );
    }
    try {
      this.leaseCapability.assertHeld();
    } catch (error) {
      this.failClosed(error);
    }
  }

  private failClosed(error: unknown): never {
    this.close();
    if (error instanceof SessionExecutionLeaseLostError) throw error;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new SessionExecutionLeaseLostError(
      `File Session failed closed${detail}`,
    );
  }

  private assertOpen(): void {
    if (this.closed || liveOwners.get(this.runDir) !== this.owner) {
      throw new Error("Paw Next Session is closed or no longer owns the run");
    }
  }
}

function loadRecoveredJournal(
  index: FileSessionJournalCommitIndexV1,
  artifactsDir: string,
  snapshotsDir: string,
  snapshotsExists: boolean,
  readOnly = false,
): {
  readonly envelopes: RunJournalEnvelopeV1[];
  readonly prefixHash: string;
  readonly recoveryInfo: FileRunSessionRecoveryInfoV1;
} {
  const snapshot = index.latestRecoverySnapshot;
  if (!snapshot) {
    if (snapshotsExists) listRecoverySnapshotFiles(snapshotsDir, readOnly);
    const loaded = loadCommittedArtifacts(index, artifactsDir, readOnly);
    return {
      ...loaded,
      recoveryInfo: {
        mode: "full_journal",
        snapshotThroughSeq: 0,
        tailEnvelopeCount: loaded.envelopes.length,
      },
    };
  }
  if (!snapshotsExists) {
    throw new Error("Committed recovery snapshot storage is missing");
  }
  const artifact = readRecoverySnapshotArtifact(
    snapshotsDir,
    snapshot,
    index.sessionId,
    index.runId,
    readOnly,
  );
  const loaded = loadCommittedArtifacts(index, artifactsDir, readOnly, {
    envelopes: artifact.envelopes.map(immutableEnvelopeClone),
    head: snapshot.head,
  });
  return {
    ...loaded,
    recoveryInfo: {
      mode: "snapshot_plus_tail",
      snapshotThroughSeq: snapshot.throughSeq,
      tailEnvelopeCount: loaded.envelopes.length - snapshot.throughSeq,
    },
  };
}

function loadCommittedArtifacts(
  index: FileSessionJournalCommitIndexV1,
  artifactsDir: string,
  readOnly = false,
  base?: Readonly<{
    envelopes: RunJournalEnvelopeV1[];
    head: JournalHeadV1;
  }>,
): { readonly envelopes: RunJournalEnvelopeV1[]; readonly prefixHash: string } {
  const artifacts = listArtifactFiles(artifactsDir, readOnly);
  let envelopes: RunJournalEnvelopeV1[] = base?.envelopes ?? [];
  let head: JournalHeadV1 = base?.head ?? {
    tailSeq: 0,
    prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  };
  for (const commit of index.commits) {
    if (commit.batchEndSeq <= head.tailSeq) {
      const coveredArtifactPath = artifacts.get(commit.artifactFileName);
      if (!coveredArtifactPath) {
        throw new Error(
          `Snapshot-covered journal artifact is missing: ${commit.artifactFileName}`,
        );
      }
      validateCoveredJournalArtifactBytes(
        coveredArtifactPath,
        commit.artifactContentHash,
        readOnly,
      );
      continue;
    }
    if (!sameHead(head, commit.previousHead)) {
      throw new Error("Committed journal artifact refs have a head gap");
    }
    const artifactPath = artifacts.get(commit.artifactFileName);
    if (!artifactPath) {
      throw new Error(
        `Committed journal artifact is missing: ${commit.artifactFileName}`,
      );
    }
    const artifact = readArtifact(
      artifactPath,
      commit,
      index.sessionId,
      index.runId,
      readOnly,
    );
    const nextPrefix = parseRunJournalPrefixV1([
      ...envelopes,
      ...artifact.envelopes,
    ]).map(immutableEnvelopeClone);
    for (const envelope of nextPrefix) {
      if (
        envelope.sessionId !== index.sessionId ||
        envelope.runId !== index.runId
      ) {
        throw new Error(
          "Journal artifact protocol metadata does not match its run",
        );
      }
    }
    const computedHead = {
      tailSeq: nextPrefix.at(-1)?.seq ?? 0,
      prefixHash: hashEnvelopes(nextPrefix),
    };
    if (!sameHead(computedHead, commit.head)) {
      throw new Error("Committed journal artifact head is invalid");
    }
    envelopes = nextPrefix;
    head = computedHead;
  }
  if (!sameHead(head, index.head)) {
    throw new Error("Committed journal index head is inconsistent");
  }
  return { envelopes, prefixHash: head.prefixHash };
}

function validateCoveredJournalArtifactBytes(
  artifactPath: string,
  expectedContentHash: string,
  readOnly: boolean,
): void {
  assertStableArtifactFile(
    artifactPath,
    "snapshot-covered journal artifact",
    readOnly,
  );
  if (hashText(fs.readFileSync(artifactPath, "utf8")) !== expectedContentHash) {
    throw new Error(
      "Snapshot-covered journal artifact content hash is invalid",
    );
  }
  recoverArtifactPublisherAlias(artifactPath, readOnly);
}

function readArtifact(
  artifactPath: string,
  commit: JournalCommitIndexEntryV1,
  sessionId: string,
  runId: string,
  readOnly: boolean,
): JournalBatchArtifactV2 {
  const parsed = parseArtifactBytes(
    artifactPath,
    commit.artifactContentHash,
    sessionId,
    runId,
    readOnly,
  );
  if (
    parsed.previousTailSeq !== commit.previousHead.tailSeq ||
    parsed.previousPrefixHash !== commit.previousHead.prefixHash ||
    parsed.startSeq !== commit.batchStartSeq ||
    parsed.endSeq !== commit.batchEndSeq
  ) {
    throw new Error("Committed journal artifact schema is invalid");
  }
  return parsed;
}

function readRecoverySnapshotArtifact(
  snapshotsDir: string,
  snapshot: RecoverySnapshotCommitIndexEntryV1,
  sessionId: string,
  runId: string,
  readOnly: boolean,
): RecoverySnapshotArtifactV2 {
  const files = listRecoverySnapshotFiles(snapshotsDir, readOnly);
  const artifactPath = files.get(snapshot.artifactFileName);
  if (!artifactPath) {
    throw new Error(
      `Committed recovery snapshot is missing: ${snapshot.artifactFileName}`,
    );
  }
  if (
    snapshot.snapshotId !== snapshot.artifactId ||
    snapshot.artifactId !== snapshot.artifactContentHash ||
    snapshot.throughSeq !== snapshot.head.tailSeq ||
    snapshot.prefixHash !== snapshot.head.prefixHash ||
    snapshot.artifactFileName !==
      recoverySnapshotArtifactFileName(snapshot.throughSeq, snapshot.artifactId)
  ) {
    throw new Error("Committed recovery snapshot authority is invalid");
  }
  assertStableSnapshotFile(
    artifactPath,
    "recovery snapshot artifact",
    readOnly,
  );
  const content = fs.readFileSync(artifactPath, "utf8");
  if (hashText(content) !== snapshot.artifactContentHash) {
    throw new Error("Committed recovery snapshot content hash is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Recovery snapshot is not valid JSON");
  }
  if (!plainObject(parsed) || content !== `${JSON.stringify(parsed)}\n`) {
    throw new Error("Recovery snapshot encoding is not canonical");
  }
  if (
    Object.keys(parsed).sort().join(",") !==
      "envelopes,prefixHash,runId,schemaVersion,sessionId,throughSeq" ||
    parsed.schemaVersion !== RECOVERY_SNAPSHOT_SCHEMA_V2 ||
    parsed.sessionId !== sessionId ||
    parsed.runId !== runId ||
    !Number.isSafeInteger(parsed.throughSeq) ||
    (parsed.throughSeq as number) <= 0 ||
    parsed.throughSeq !== snapshot.throughSeq ||
    typeof parsed.prefixHash !== "string" ||
    parsed.prefixHash !== snapshot.prefixHash ||
    !Array.isArray(parsed.envelopes) ||
    parsed.envelopes.length !== snapshot.throughSeq
  ) {
    throw new Error("Recovery snapshot schema is invalid");
  }
  const prefix = parseRunJournalPrefixV1(parsed.envelopes).map(
    immutableEnvelopeClone,
  );
  for (const [index, envelope] of prefix.entries()) {
    if (
      envelope.sessionId !== sessionId ||
      envelope.runId !== runId ||
      envelope.seq !== index + 1
    ) {
      throw new Error("Recovery snapshot envelope identity is invalid");
    }
  }
  if (
    (prefix.at(-1)?.seq ?? 0) !== snapshot.throughSeq ||
    hashEnvelopes(prefix) !== snapshot.prefixHash
  ) {
    throw new Error("Recovery snapshot journal prefix is invalid");
  }
  recoverSnapshotPublisherAlias(artifactPath, readOnly);
  return {
    schemaVersion: RECOVERY_SNAPSHOT_SCHEMA_V2,
    sessionId,
    runId,
    throughSeq: snapshot.throughSeq,
    prefixHash: snapshot.prefixHash,
    envelopes: Object.freeze(prefix),
  };
}

function listRecoverySnapshotFiles(
  directory: string,
  readOnly: boolean,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const name of fs.readdirSync(directory).sort()) {
    const fullPath = path.join(directory, name);
    if (RECOVERY_SNAPSHOT_FILE.test(name)) {
      assertStableSnapshotFile(
        fullPath,
        "recovery snapshot artifact",
        readOnly,
      );
      result.set(name, fullPath);
    } else if (RECOVERY_SNAPSHOT_TEMP.test(name)) {
      assertSnapshotTemp(fullPath, readOnly);
    } else {
      throw new Error(`Unrecognized recovery snapshot entry: ${name}`);
    }
  }
  return result;
}

function parseArtifactBytes(
  artifactPath: string,
  expectedContentHash: string,
  sessionId: string,
  runId: string,
  readOnly: boolean,
): JournalBatchArtifactV2 {
  assertStableArtifactFile(artifactPath, "journal artifact", readOnly);
  const content = fs.readFileSync(artifactPath, "utf8");
  if (hashText(content) !== expectedContentHash) {
    throw new Error("Committed journal artifact content hash is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Journal artifact is not valid JSON");
  }
  if (!plainObject(parsed) || content !== `${JSON.stringify(parsed)}\n`) {
    throw new Error("Journal artifact encoding is not canonical");
  }
  if (
    Object.keys(parsed).sort().join(",") !==
      "endSeq,envelopes,previousPrefixHash,previousTailSeq,runId,schemaVersion,sessionId,startSeq" ||
    parsed.schemaVersion !== ARTIFACT_SCHEMA_V2 ||
    parsed.sessionId !== sessionId ||
    parsed.runId !== runId ||
    !Number.isSafeInteger(parsed.previousTailSeq) ||
    (parsed.previousTailSeq as number) < 0 ||
    typeof parsed.previousPrefixHash !== "string" ||
    !SHA256.test(parsed.previousPrefixHash) ||
    !Number.isSafeInteger(parsed.startSeq) ||
    !Number.isSafeInteger(parsed.endSeq) ||
    (parsed.startSeq as number) !== (parsed.previousTailSeq as number) + 1 ||
    (parsed.endSeq as number) < (parsed.startSeq as number) ||
    !Array.isArray(parsed.envelopes) ||
    parsed.envelopes.length !==
      (parsed.endSeq as number) - (parsed.startSeq as number) + 1
  ) {
    throw new Error("Journal artifact schema is invalid");
  }
  for (const [index, envelope] of parsed.envelopes.entries()) {
    assertRunJournalEnvelopeV1(envelope);
    if (
      envelope.sessionId !== sessionId ||
      envelope.runId !== runId ||
      envelope.seq !== (parsed.startSeq as number) + index
    ) {
      throw new Error("Journal artifact envelope range is invalid");
    }
  }
  recoverArtifactPublisherAlias(artifactPath, readOnly);
  return parsed as unknown as JournalBatchArtifactV2;
}

function listArtifactFiles(
  directory: string,
  readOnly: boolean,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const name of fs.readdirSync(directory).sort()) {
    const fullPath = path.join(directory, name);
    if (ARTIFACT_FILE.test(name)) {
      assertStableArtifactFile(fullPath, "journal artifact", readOnly);
      result.set(name, fullPath);
    } else if (ARTIFACT_TEMP.test(name)) {
      assertArtifactTemp(fullPath, readOnly);
    } else {
      throw new Error(`Unrecognized fenced journal artifact entry: ${name}`);
    }
  }
  return result;
}

function publishContentAddressedArtifact(
  directory: string,
  fileName: string,
  content: string,
): void {
  const finalPath = path.join(directory, fileName);
  if (fs.existsSync(finalPath)) {
    assertStableArtifactFile(finalPath, "journal artifact");
    if (fs.readFileSync(finalPath, "utf8") !== content) {
      throw new Error("Content-addressed journal artifact identity collision");
    }
    recoverArtifactPublisherAlias(finalPath, false);
    return;
  }
  const tempPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, "wx");
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(tempPath, finalPath);
    } catch (error) {
      if (!fsError(error, "EEXIST")) throw error;
      assertStableArtifactFile(finalPath, "journal artifact");
      if (fs.readFileSync(finalPath, "utf8") !== content) {
        throw new Error(
          "Journal artifact target was occupied by different bytes",
        );
      }
    }
    fsyncDirectoryBestEffort(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    // A publisher that cannot remove its hard-link sibling must not make the
    // artifact authoritative. Recovery only repairs a temp left by a crashed
    // process; a live writer treats cleanup failure as a failed publication.
    fs.rmSync(tempPath, { force: true });
  }
}

function publishContentAddressedSnapshot(
  directory: string,
  fileName: string,
  content: string,
): void {
  const finalPath = path.join(directory, fileName);
  if (fileExists(finalPath)) {
    assertStableSnapshotFile(finalPath, "recovery snapshot artifact");
    if (fs.readFileSync(finalPath, "utf8") !== content) {
      throw new Error("Content-addressed recovery snapshot identity collision");
    }
    recoverSnapshotPublisherAlias(finalPath, false);
    return;
  }
  const tempPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, "wx");
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(tempPath, finalPath);
    } catch (error) {
      if (!fsError(error, "EEXIST")) throw error;
      assertStableSnapshotFile(finalPath, "recovery snapshot artifact");
      if (fs.readFileSync(finalPath, "utf8") !== content) {
        throw new Error(
          "Recovery snapshot target was occupied by different bytes",
        );
      }
    }
    fsyncDirectoryBestEffort(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
  }
}

function assertPublishedArtifactStable(
  workspaceRoot: string,
  artifactsDir: string,
  fileName: string,
  expectedHash: string,
  expectedContent: string,
  startSeq: number,
  endSeq: number,
): void {
  validateExistingDirectoryTree(workspaceRoot, artifactsDir);
  const expectedName = journalArtifactFileName(startSeq, endSeq, expectedHash);
  if (fileName !== expectedName || !ARTIFACT_FILE.test(fileName)) {
    throw new Error("Published journal artifact file name is invalid");
  }
  const finalPath = path.join(artifactsDir, fileName);
  assertStableArtifactFile(finalPath, "published journal artifact");
  const content = fs.readFileSync(finalPath, "utf8");
  if (content !== expectedContent || hashText(content) !== expectedHash) {
    throw new Error("Published journal artifact bytes changed before commit");
  }
}

function assertPublishedSnapshotStable(
  workspaceRoot: string,
  snapshotsDir: string,
  fileName: string,
  expectedHash: string,
  expectedContent: string,
  throughSeq: number,
): void {
  validateExistingDirectoryTree(workspaceRoot, snapshotsDir);
  const expectedName = recoverySnapshotArtifactFileName(
    throughSeq,
    expectedHash,
  );
  if (fileName !== expectedName || !RECOVERY_SNAPSHOT_FILE.test(fileName)) {
    throw new Error("Published recovery snapshot file name is invalid");
  }
  const finalPath = path.join(snapshotsDir, fileName);
  assertStableSnapshotFile(finalPath, "published recovery snapshot");
  const content = fs.readFileSync(finalPath, "utf8");
  if (content !== expectedContent || hashText(content) !== expectedHash) {
    throw new Error("Published recovery snapshot bytes changed before commit");
  }
}

interface ExistingRunStorage {
  readonly metadataExists: boolean;
  readonly artifactsExists: boolean;
  readonly snapshotsExists: boolean;
  readonly metadataTempsToRemove: readonly string[];
}

function inspectExistingRunStorage(
  workspaceRoot: string,
  runDir: string,
  metadataPath: string,
  artifactsDir: string,
  snapshotsDir: string,
  sessionId: string,
  runId: string,
): ExistingRunStorage {
  let runStat: fs.Stats;
  try {
    runStat = fs.lstatSync(runDir);
  } catch (error) {
    if (fsError(error, "ENOENT")) {
      return {
        metadataExists: false,
        artifactsExists: false,
        snapshotsExists: false,
        metadataTempsToRemove: [],
      };
    }
    throw error;
  }
  if (!runStat.isDirectory() || runStat.isSymbolicLink()) {
    throw new Error("Paw Next File Session run path must be a real directory");
  }
  validateExistingDirectoryTree(workspaceRoot, runDir);
  const names = fs.readdirSync(runDir).sort();
  const metadataExists = names.includes("metadata.json");
  const metadataTempPaths = names
    .filter((name) => METADATA_TEMP.test(name))
    .map((name) => path.join(runDir, name));
  let artifactsExists = false;
  let snapshotsExists = false;
  for (const name of names) {
    if (name === "batches" || name === "snapshots") {
      throw new Error(
        "Legacy File Session storage requires explicit migration",
      );
    }
    if (name === "metadata.json") {
      continue;
    }
    if (METADATA_TEMP.test(name)) continue;
    if (name === "journal-artifacts") {
      const stat = fs.lstatSync(artifactsDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Paw Next journal artifacts must be a real directory");
      }
      validateExistingDirectoryTree(workspaceRoot, artifactsDir);
      artifactsExists = true;
      continue;
    }
    if (name === "recovery-snapshots") {
      const stat = fs.lstatSync(snapshotsDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Paw Next recovery snapshots must be a real directory");
      }
      validateExistingDirectoryTree(workspaceRoot, snapshotsDir);
      snapshotsExists = true;
      continue;
    }
    throw new Error(`Unrecognized fenced File Session entry: ${name}`);
  }
  const metadataTempsToRemove = inspectMetadataPublication(
    metadataPath,
    metadataTempPaths,
    metadataExists,
    sessionId,
    runId,
  );
  return {
    metadataExists,
    artifactsExists,
    snapshotsExists,
    metadataTempsToRemove,
  };
}

function inspectMetadataPublication(
  metadataPath: string,
  tempPaths: readonly string[],
  metadataExists: boolean,
  sessionId: string,
  runId: string,
): readonly string[] {
  if (tempPaths.length > 1) {
    throw new Error("Paw Next Session metadata has multiple publisher temps");
  }
  const tempPath = tempPaths[0];
  const tempStat = tempPath === undefined ? undefined : fs.lstatSync(tempPath);
  if (tempStat && (!tempStat.isFile() || tempStat.isSymbolicLink())) {
    throw new Error("Paw Next Session metadata temp is unsafe");
  }
  if (!metadataExists) {
    if (tempStat && tempStat.nlink !== 1) {
      throw new Error(
        "Paw Next Session metadata temp has an external hardlink",
      );
    }
    return tempPath === undefined ? [] : [tempPath];
  }
  const metadataStat = fs.lstatSync(metadataPath);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
    throw new Error("Paw Next Session metadata must be a regular file");
  }
  validateFencedMetadataContent(metadataPath, sessionId, runId);
  if (!tempStat || !tempPath) {
    if (metadataStat.nlink !== 1) {
      throw new Error("Paw Next Session metadata has an external hardlink");
    }
    return [];
  }
  if (
    metadataStat.nlink !== 2 ||
    tempStat.nlink !== 2 ||
    metadataStat.dev !== tempStat.dev ||
    metadataStat.ino !== tempStat.ino
  ) {
    throw new Error("Paw Next Session metadata temp is not its publisher link");
  }
  return [tempPath];
}

function recoverMetadataPublication(
  storage: ExistingRunStorage,
  metadataPath: string,
  runDir: string,
  sessionId: string,
  runId: string,
): void {
  for (const tempPath of storage.metadataTempsToRemove) {
    fs.rmSync(tempPath);
  }
  if (storage.metadataTempsToRemove.length > 0) {
    fsyncDirectoryBestEffort(runDir);
  }
  if (storage.metadataExists) {
    assertRegularSingleLinkFile(metadataPath, "Session metadata");
    validateFencedMetadataContent(metadataPath, sessionId, runId);
    return;
  }
  try {
    fs.lstatSync(metadataPath);
  } catch (error) {
    if (fsError(error, "ENOENT")) return;
    throw error;
  }
  throw new Error("Paw Next Session metadata appeared during recovery");
}

function emptyRecoveredJournal(index: FileSessionJournalCommitIndexV1): {
  readonly envelopes: RunJournalEnvelopeV1[];
  readonly prefixHash: string;
  readonly recoveryInfo: FileRunSessionRecoveryInfoV1;
} {
  const emptyHead = {
    tailSeq: 0,
    prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  };
  if (index.commits.length !== 0 || !sameHead(index.head, emptyHead)) {
    throw new Error("Fenced File Session artifact directory is missing");
  }
  if (index.latestRecoverySnapshot !== undefined) {
    throw new Error("Empty File Session cannot reference a recovery snapshot");
  }
  return {
    envelopes: [],
    prefixHash: emptyHead.prefixHash,
    recoveryInfo: {
      mode: "full_journal",
      snapshotThroughSeq: 0,
      tailEnvelopeCount: 0,
    },
  };
}

function ensureFencedMetadata(
  metadataPath: string,
  sessionId: string,
  runId: string,
  mayCreate: boolean,
): void {
  const expected = {
    schemaVersion: SESSION_METADATA_SCHEMA_V2,
    sessionId,
    runId,
  };
  if (!fs.existsSync(metadataPath)) {
    if (!mayCreate) throw new Error("Fenced File Session metadata is missing");
    atomicPublishNewFile(metadataPath, `${JSON.stringify(expected)}\n`);
  }
  assertRegularSingleLinkFile(metadataPath, "Session metadata");
  validateFencedMetadataContent(metadataPath, sessionId, runId);
}

function validateFencedMetadataContent(
  metadataPath: string,
  sessionId: string,
  runId: string,
): void {
  const expected = {
    schemaVersion: SESSION_METADATA_SCHEMA_V2,
    sessionId,
    runId,
  };
  const content = fs.readFileSync(metadataPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Paw Next Session metadata is not valid JSON");
  }
  if (
    !plainObject(parsed) ||
    content !== `${JSON.stringify(parsed)}\n` ||
    Object.keys(parsed).sort().join(",") !== "runId,schemaVersion,sessionId" ||
    parsed.schemaVersion !== expected.schemaVersion ||
    parsed.sessionId !== sessionId ||
    parsed.runId !== runId
  ) {
    throw new Error("Paw Next fenced Session metadata is invalid");
  }
}

function atomicPublishNewFile(finalPath: string, content: string): void {
  const tempPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, "wx");
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(tempPath, finalPath);
    } catch (error) {
      if (!fsError(error, "EEXIST")) throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
  }
}

function assertStableArtifactFile(
  filePath: string,
  kind: string,
  _readOnly = false,
): void {
  for (;;) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Paw Next ${kind} must be a regular non-symlink file`);
    }
    if (stat.nlink === 1) return;
    const temps = matchingArtifactTemps(filePath, stat.dev, stat.ino);
    if (stat.nlink !== 2 || temps.length !== 1) {
      throw new Error(`Paw Next ${kind} must not have an external hardlink`);
    }
    return;
  }
}

function assertStableSnapshotFile(
  filePath: string,
  kind: string,
  _readOnly = false,
): void {
  for (;;) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Paw Next ${kind} must be a regular non-symlink file`);
    }
    if (stat.nlink === 1) return;
    const temps = matchingSnapshotTemps(filePath, stat.dev, stat.ino);
    if (stat.nlink !== 2 || temps.length !== 1) {
      throw new Error(`Paw Next ${kind} must not have an external hardlink`);
    }
    return;
  }
}

function matchingArtifactTemps(
  artifactPath: string,
  device: number,
  inode: number,
): string[] {
  const prefix = `${path.basename(artifactPath)}.tmp-`;
  return fs.readdirSync(path.dirname(artifactPath)).flatMap((name) => {
    if (!name.startsWith(prefix) || !ARTIFACT_TEMP.test(name)) return [];
    const candidate = path.join(path.dirname(artifactPath), name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (fsError(error, "ENOENT")) return [];
      throw error;
    }
    return stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev === device &&
      stat.ino === inode
      ? [candidate]
      : [];
  });
}

function matchingSnapshotTemps(
  artifactPath: string,
  device: number,
  inode: number,
): string[] {
  const prefix = `${path.basename(artifactPath)}.tmp-`;
  return fs.readdirSync(path.dirname(artifactPath)).flatMap((name) => {
    if (!name.startsWith(prefix) || !RECOVERY_SNAPSHOT_TEMP.test(name)) {
      return [];
    }
    const candidate = path.join(path.dirname(artifactPath), name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (fsError(error, "ENOENT")) return [];
      throw error;
    }
    return stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.dev === device &&
      stat.ino === inode
      ? [candidate]
      : [];
  });
}

function assertArtifactTemp(filePath: string, _readOnly: boolean): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (fsError(error, "ENOENT")) return;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.nlink !== 1 && !isOwnedArtifactPublisherTemp(filePath, stat))
  ) {
    throw new Error("Paw Next journal artifact temp is unsafe");
  }
}

function recoverArtifactPublisherAlias(
  artifactPath: string,
  readOnly: boolean,
): void {
  const stat = fs.lstatSync(artifactPath);
  if (stat.nlink === 1 || readOnly) return;
  const temps = matchingArtifactTemps(artifactPath, stat.dev, stat.ino);
  if (stat.nlink !== 2 || temps.length !== 1) {
    throw new Error(
      "Paw Next journal artifact must not have an external hardlink",
    );
  }
  try {
    fs.rmSync(temps[0] as string);
  } catch (error) {
    if (!fsError(error, "ENOENT")) throw error;
  }
  assertRegularSingleLinkFile(artifactPath, "journal artifact");
  fsyncDirectoryBestEffort(path.dirname(artifactPath));
}

function assertSnapshotTemp(filePath: string, _readOnly: boolean): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (fsError(error, "ENOENT")) return;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.nlink !== 1 && !isOwnedSnapshotPublisherTemp(filePath, stat))
  ) {
    throw new Error("Paw Next recovery snapshot temp is unsafe");
  }
}

function recoverSnapshotPublisherAlias(
  artifactPath: string,
  readOnly: boolean,
): void {
  const stat = fs.lstatSync(artifactPath);
  if (stat.nlink === 1 || readOnly) return;
  const temps = matchingSnapshotTemps(artifactPath, stat.dev, stat.ino);
  if (stat.nlink !== 2 || temps.length !== 1) {
    throw new Error(
      "Paw Next recovery snapshot must not have an external hardlink",
    );
  }
  try {
    fs.rmSync(temps[0] as string);
  } catch (error) {
    if (!fsError(error, "ENOENT")) throw error;
  }
  assertRegularSingleLinkFile(artifactPath, "recovery snapshot artifact");
  fsyncDirectoryBestEffort(path.dirname(artifactPath));
}

function isOwnedSnapshotPublisherTemp(
  tempPath: string,
  tempStat: fs.Stats,
): boolean {
  if (tempStat.nlink !== 2) return false;
  const name = path.basename(tempPath);
  const marker = name.indexOf(".json.tmp-");
  if (marker < 0) return false;
  const formalName = name.slice(0, marker + ".json".length);
  if (!RECOVERY_SNAPSHOT_FILE.test(formalName)) return false;
  const formalPath = path.join(path.dirname(tempPath), formalName);
  let formalStat: fs.Stats;
  try {
    formalStat = fs.lstatSync(formalPath);
  } catch (error) {
    if (fsError(error, "ENOENT")) return false;
    throw error;
  }
  return (
    formalStat.isFile() &&
    !formalStat.isSymbolicLink() &&
    formalStat.nlink === 2 &&
    formalStat.dev === tempStat.dev &&
    formalStat.ino === tempStat.ino
  );
}

function isOwnedArtifactPublisherTemp(
  tempPath: string,
  tempStat: fs.Stats,
): boolean {
  if (tempStat.nlink !== 2) return false;
  const name = path.basename(tempPath);
  const marker = name.indexOf(".json.tmp-");
  if (marker < 0) return false;
  const formalName = name.slice(0, marker + ".json".length);
  if (!ARTIFACT_FILE.test(formalName)) return false;
  const formalPath = path.join(path.dirname(tempPath), formalName);
  let formalStat: fs.Stats;
  try {
    formalStat = fs.lstatSync(formalPath);
  } catch (error) {
    if (fsError(error, "ENOENT")) return false;
    throw error;
  }
  return (
    formalStat.isFile() &&
    !formalStat.isSymbolicLink() &&
    formalStat.nlink === 2 &&
    formalStat.dev === tempStat.dev &&
    formalStat.ino === tempStat.ino
  );
}

function assertRegularSingleLinkFile(filePath: string, kind: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`Paw Next ${kind} must be a single-link regular file`);
  }
}

function journalArtifactFileName(
  startSeq: number,
  endSeq: number,
  hash: string,
): string {
  return `${String(startSeq).padStart(16, "0")}-${String(endSeq).padStart(
    16,
    "0",
  )}-${hash}.json`;
}

function recoverySnapshotArtifactFileName(
  throughSeq: number,
  artifactHash: string,
): string {
  if (!Number.isSafeInteger(throughSeq) || throughSeq <= 0) {
    throw new Error("Recovery snapshot throughSeq is invalid");
  }
  if (!SHA256.test(artifactHash)) {
    throw new Error("Recovery snapshot artifact hash is invalid");
  }
  const fileName = `snapshot-${String(throughSeq).padStart(
    16,
    "0",
  )}-${artifactHash}.json`;
  const match = RECOVERY_SNAPSHOT_FILE.exec(fileName);
  if (!match || Number(match[1]) !== throughSeq || match[2] !== artifactHash) {
    throw new Error("Recovery snapshot artifact filename is invalid");
  }
  return fileName;
}

function hashEnvelopes(envelopes: readonly RunJournalEnvelopeV1[]): string {
  return hashText(JSON.stringify(envelopes));
}

function hashText(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameHead(left: JournalHeadV1, right: JournalHeadV1): boolean {
  return left.tailSeq === right.tailSeq && left.prefixHash === right.prefixHash;
}

function canonicalInputFactClone(fact: InputFactV1): InputFactV1 {
  assertProtocolRecord({ kind: "input_fact", fact });
  return immutableCanonicalJsonCloneV1(
    fact as unknown as JsonValue,
  ) as InputFactV1;
}

function canonicalDerivedDecisionClone(
  decision: DerivedDecisionV1,
): DerivedDecisionV1 {
  assertProtocolRecord({ kind: "derived_decision", decision });
  return immutableCanonicalJsonCloneV1(
    decision as unknown as JsonValue,
  ) as unknown as DerivedDecisionV1;
}

function sameDerivedDecision(
  left: DerivedDecisionV1,
  right: DerivedDecisionV1,
): boolean {
  return (
    canonicalJsonStringifyV1(left as unknown as JsonValue) ===
    canonicalJsonStringifyV1(right as unknown as JsonValue)
  );
}

function assertProtocolRecord(record: RunJournalEnvelopeV1["record"]): void {
  assertRunJournalEnvelopeV1({
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "validation-session",
    runId: "validation-run",
    seq: Number.MAX_SAFE_INTEGER,
    ts: 0,
    record,
  });
}

function assertExpectedTailSeq(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      "Session expectedTailSeq must be a non-negative safe integer",
    );
  }
}

function assertJournalHead(value: JournalHeadV1, label: string): void {
  if (
    !value ||
    !Number.isSafeInteger(value.tailSeq) ||
    value.tailSeq < 0 ||
    typeof value.prefixHash !== "string" ||
    !SHA256.test(value.prefixHash)
  ) {
    throw new Error(
      `${label} must contain a non-negative tailSeq and lowercase sha256 prefixHash`,
    );
  }
}

function assertStableIds(sessionId: string, runId: string): void {
  assertRunJournalEnvelopeV1({
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId,
    runId,
    seq: 1,
    ts: 0,
    record: {
      kind: "input_fact",
      fact: {
        type: "attempt.started",
        goalHash: "id-check",
        configHash: "id-check",
      },
    },
  });
}

function stablePathKey(value: string): string {
  return hashText(value);
}

function validateDirectoryPath(workspaceRoot: string, current: string): void {
  const stat = fs.lstatSync(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Paw Next Session storage contains a symbolic link");
  }
  const canonical = fs.realpathSync.native(current);
  const relative = path.relative(workspaceRoot, canonical);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error("Paw Next Session storage escaped the workspace root");
  }
}

function ensureSafeDirectoryTree(workspaceRoot: string, target: string): void {
  const relative = path.relative(workspaceRoot, target);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error("Paw Next Session storage escaped the workspace root");
  }
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current);
    validateDirectoryPath(workspaceRoot, current);
  }
}

function validateExistingDirectoryTree(
  workspaceRoot: string,
  target: string,
): void {
  const relative = path.relative(workspaceRoot, target);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error("Paw Next Session storage escaped the workspace root");
  }
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    validateDirectoryPath(workspaceRoot, current);
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Windows and some filesystems do not support directory fsync.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: string }).code === code
  );
}

function fileExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (fsError(error, "ENOENT")) return false;
    throw error;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function immutableEnvelopeClone(
  envelope: RunJournalEnvelopeV1,
): RunJournalEnvelopeV1 {
  const value = JSON.parse(JSON.stringify(envelope)) as unknown;
  assertRunJournalEnvelopeV1(value);
  return deepFreeze(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
