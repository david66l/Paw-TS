import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const IDENTITY_SCHEMA = "paw.session-execution-lease-identity.v1" as const;
const EVENT_SCHEMA = "paw.session-execution-lease-event.v1" as const;
const EVENT_WIDTH = 16;
const EVENT_FILE = /^(\d{16})\.json$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ZERO_HASH = "0".repeat(64);
export const EMPTY_RUN_JOURNAL_PREFIX_HASH_V1 = createHash("sha256")
  .update("[]")
  .digest("hex");
const JOURNAL_ARTIFACT_FILE = /^(\d{16})-(\d{16})-([0-9a-f]{64})\.json$/;
const RECOVERY_SNAPSHOT_ARTIFACT_FILE =
  /^snapshot-(\d{16})-([0-9a-f]{64})\.json$/;
/** @internal Bound operations captured at issuance; public properties are untrusted. */
export interface VerifiedFileSessionExecutionLeaseCapabilityV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly assertHeld: () => void;
  readonly renew: () => Promise<void>;
  readonly release: () => Promise<"released" | "already_released" | "lost">;
  readonly readExpiresAt: () => number;
  readonly readLeaseDurationMs: () => number;
  readonly linearizeJournalBatch: (
    input: LinearizeJournalBatchInputV1,
  ) => Promise<LinearizeJournalBatchResultV1>;
  readonly linearizeRecoverySnapshot: (
    input: LinearizeRecoverySnapshotInputV1,
  ) => Promise<LinearizeRecoverySnapshotResultV1>;
}

const issuedLeaseCapabilities = new WeakMap<
  object,
  VerifiedFileSessionExecutionLeaseCapabilityV1
>();
const TEMP_FILE =
  /^(?:identity|\d{16})\.json\.tmp-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SessionLeaseTransitionAttemptV1 {
  readonly kind:
    | "claim"
    | "heartbeat"
    | "release"
    | "journal_commit"
    | "recovery_snapshot_commit";
  readonly eventSeq: number;
  readonly fencingToken: number;
}

export interface FileSessionExecutionLeaseOptionsV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly ownerId?: string;
  readonly ttlMs: number;
  readonly baseTailSeq: number;
  readonly basePrefixHash: string;
  readonly clock?: () => number;
  /** @internal Deterministic transition-race seam. */
  readonly beforeTransitionPublish?: (
    attempt: SessionLeaseTransitionAttemptV1,
  ) => void;
  /** @internal Exposes the hard-link-before-temp-unlink visibility window. */
  readonly afterTransitionLink?: (
    attempt: SessionLeaseTransitionAttemptV1,
  ) => void;
}

export interface JournalHeadV1 {
  readonly tailSeq: number;
  readonly prefixHash: string;
}

export interface LinearizeJournalBatchInputV1 {
  readonly commitId: string;
  readonly expectedHead: JournalHeadV1;
  readonly nextHead: JournalHeadV1;
  readonly batchStartSeq: number;
  readonly batchEndSeq: number;
  /** Content-addressed id; V1 requires this to equal artifactContentHash. */
  readonly artifactId: string;
  /** Strictly derived from range + artifactId; never an arbitrary path. */
  readonly artifactFileName: string;
  readonly artifactContentHash: string;
}

export type LinearizeJournalBatchResultV1 =
  | Readonly<{
      status: "committed" | "already_committed";
      eventSeq: number;
      head: JournalHeadV1;
    }>
  | Readonly<{ status: "conflict"; head: JournalHeadV1 }>
  | Readonly<{ status: "lost" }>;

export interface LinearizeRecoverySnapshotInputV1 {
  readonly snapshotId: string;
  readonly journalCommitId: string;
  readonly journalCommitEventSeq: number;
  readonly head: JournalHeadV1;
  readonly throughSeq: number;
  readonly prefixHash: string;
  readonly artifactId: string;
  readonly artifactFileName: string;
  readonly artifactContentHash: string;
}

export type LinearizeRecoverySnapshotResultV1 =
  | Readonly<{
      status: "committed" | "already_committed";
      eventSeq: number;
      head: JournalHeadV1;
    }>
  | Readonly<{ status: "conflict"; head: JournalHeadV1 }>
  | Readonly<{ status: "lost" }>;

export interface ReadFileSessionJournalCommitIndexOptionsV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
}

export interface JournalCommitIndexEntryV1 {
  readonly eventSeq: number;
  readonly commitId: string;
  readonly committedAt: number;
  readonly fencingToken: number;
  readonly previousHead: JournalHeadV1;
  readonly head: JournalHeadV1;
  readonly batchStartSeq: number;
  readonly batchEndSeq: number;
  readonly artifactId: string;
  readonly artifactFileName: string;
  readonly artifactContentHash: string;
}

export interface FileSessionJournalCommitIndexV1 {
  readonly sessionId: string;
  readonly runId: string;
  readonly head: JournalHeadV1;
  readonly commits: readonly JournalCommitIndexEntryV1[];
  readonly latestRecoverySnapshot?: RecoverySnapshotCommitIndexEntryV1;
}

export interface RecoverySnapshotCommitIndexEntryV1 {
  readonly eventSeq: number;
  readonly snapshotId: string;
  readonly committedAt: number;
  readonly fencingToken: number;
  readonly journalCommitId: string;
  readonly journalCommitEventSeq: number;
  readonly head: JournalHeadV1;
  readonly throughSeq: number;
  readonly prefixHash: string;
  readonly artifactId: string;
  readonly artifactFileName: string;
  readonly artifactContentHash: string;
}

export interface ReadFileSessionAuthorityInventoryOptionsV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
}

export interface FileSessionAuthorityRunInventoryV1 {
  readonly runId: string;
  readonly head: JournalHeadV1;
  readonly commits: readonly JournalCommitIndexEntryV1[];
}

export interface FileSessionAuthorityInventoryV1 {
  readonly schemaVersion: "paw.file-session-authority-inventory.v1";
  readonly sessionId: string;
  readonly runs: readonly FileSessionAuthorityRunInventoryV1[];
  readonly inventoryHash: string;
}

export interface DiscoverFileSessionAuthoritiesOptionsV1 {
  readonly workspaceRoot: string;
}

export type FileSessionAuthorityDiscoveryCorruptionV1 =
  | "unrecognized_session_entry"
  | "unsafe_session_directory"
  | "identity_invalid"
  | "identity_storage_key_mismatch"
  | "authority_corrupt";

export type FileSessionAuthorityDiscoveryEntryV1 =
  | Readonly<{
      status: "discovered";
      entryName: string;
      sessionId: string;
      inventory: FileSessionAuthorityInventoryV1;
    }>
  | Readonly<{
      status: "corrupt";
      entryName: string;
      reason: FileSessionAuthorityDiscoveryCorruptionV1;
    }>;

export interface FileSessionAuthorityDiscoveryV1 {
  readonly schemaVersion: "paw.file-session-authority-discovery.v1";
  readonly entries: readonly FileSessionAuthorityDiscoveryEntryV1[];
}

export interface FileSessionLeaseBusyV1 {
  readonly status: "busy";
  readonly runId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expiresAt: number;
}

export interface FileSessionExecutionLeaseV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly baseTailSeq: number;
  readonly basePrefixHash: string;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  assertHeld(): void;
  renew(): Promise<void>;
  release(): Promise<"released" | "already_released" | "lost">;
  linearizeJournalBatch(
    input: LinearizeJournalBatchInputV1,
  ): Promise<LinearizeJournalBatchResultV1>;
  linearizeRecoverySnapshot(
    input: LinearizeRecoverySnapshotInputV1,
  ): Promise<LinearizeRecoverySnapshotResultV1>;
}

export type AcquireFileSessionExecutionLeaseResultV1 =
  | Readonly<{ status: "acquired"; lease: FileSessionExecutionLeaseV1 }>
  | FileSessionLeaseBusyV1
  | Readonly<{
      status: "anchor_conflict";
      runId: string;
      head: JournalHeadV1;
    }>;

export class SessionExecutionLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExecutionLeaseLostError";
  }
}

interface LeasePaths {
  readonly workspaceRoot: string;
  readonly ownershipDir: string;
  readonly eventsDir: string;
}

type AuthorityReadMode = "recovering" | "strict_readonly";

interface EventBase {
  readonly schemaVersion: typeof EVENT_SCHEMA;
  readonly eventSeq: number;
  readonly previousEventHash: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
}

interface ClaimEvent extends EventBase {
  readonly type: "claim";
  readonly previousFencingToken: number;
  readonly leaseDurationMs: number;
  readonly claimedAt: number;
  readonly expiresAt: number;
  readonly baseTailSeq: number;
  readonly basePrefixHash: string;
}

interface HeartbeatEvent extends EventBase {
  readonly type: "heartbeat";
  readonly renewedAt: number;
  readonly expiresAt: number;
}

interface ReleaseEvent extends EventBase {
  readonly type: "release";
  readonly releasedAt: number;
}

interface JournalCommitEvent extends EventBase {
  readonly type: "journal_commit";
  readonly commitId: string;
  readonly committedAt: number;
  readonly previousTailSeq: number;
  readonly previousPrefixHash: string;
  readonly tailSeq: number;
  readonly prefixHash: string;
  readonly batchStartSeq: number;
  readonly batchEndSeq: number;
  readonly artifactId: string;
  readonly artifactFileName: string;
  readonly artifactContentHash: string;
}

interface RecoverySnapshotCommitEvent extends EventBase {
  readonly type: "recovery_snapshot_commit";
  readonly snapshotId: string;
  readonly committedAt: number;
  readonly journalCommitId: string;
  readonly journalCommitEventSeq: number;
  readonly journalTailSeq: number;
  readonly journalPrefixHash: string;
  readonly throughSeq: number;
  readonly prefixHash: string;
  readonly artifactId: string;
  readonly artifactFileName: string;
  readonly artifactContentHash: string;
}

type TransitionEvent =
  | ClaimEvent
  | HeartbeatEvent
  | ReleaseEvent
  | JournalCommitEvent
  | RecoverySnapshotCommitEvent;

interface Projection {
  readonly claim: ClaimEvent;
  readonly expiresAt: number;
  readonly released: boolean;
}

interface Authority {
  readonly events: readonly TransitionEvent[];
  readonly current?: Projection;
  readonly lastEventHash: string;
  readonly lastEventTime?: number;
  readonly headsByRunId: ReadonlyMap<string, JournalHeadV1>;
  readonly commitsByRunId: ReadonlyMap<
    string,
    ReadonlyMap<string, JournalCommitEvent>
  >;
  readonly snapshotsByRunId: ReadonlyMap<
    string,
    ReadonlyMap<string, RecoverySnapshotCommitEvent>
  >;
  readonly latestSnapshotByRunId: ReadonlyMap<
    string,
    RecoverySnapshotCommitEvent
  >;
}

/**
 * Acquire the sole executor lease for one canonical workspace + Session.
 *
 * Claim, heartbeat, release, journal commit and recovery-snapshot commit all
 * CAS the same immutable S+1 event slot. Only claims increment fencingToken.
 * Snapshot commits are cache refs: they never advance the journal head or the
 * scanner inventory. FileRunSession uses issued, workspace-bound capabilities
 * and committed artifact refs from this authority; recovery coordination and
 * automatic heartbeat remain outer Runtime concerns.
 */
export function acquireFileSessionExecutionLeaseV1(
  options: FileSessionExecutionLeaseOptionsV1,
): AcquireFileSessionExecutionLeaseResultV1 {
  assertId(options.sessionId, "sessionId");
  assertId(options.runId, "runId");
  const ownerId = options.ownerId ?? randomUUID();
  assertId(ownerId, "ownerId");
  assertPositiveInteger(options.ttlMs, "ttlMs");
  assertNonNegativeInteger(options.baseTailSeq, "baseTailSeq");
  assertHash(options.basePrefixHash, "basePrefixHash");
  const clock = options.clock ?? Date.now;
  const paths = preparePaths(options.workspaceRoot, options.sessionId);
  ensureIdentity(paths, options.sessionId);

  for (;;) {
    const now = readClock(clock);
    const authority = readAuthority(paths, options.sessionId);
    assertClockNotBehind(authority, now);
    if (authority.current && isActive(authority.current, now)) {
      return busy(authority.current);
    }
    const journalHead = journalHeadForRun(authority, options.runId);
    if (
      !sameJournalHead(journalHead, {
        tailSeq: options.baseTailSeq,
        prefixHash: options.basePrefixHash,
      })
    ) {
      return {
        status: "anchor_conflict",
        runId: options.runId,
        head: journalHead,
      };
    }
    const fencingToken = (authority.current?.claim.fencingToken ?? 0) + 1;
    assertPositiveInteger(fencingToken, "fencingToken");
    const event: ClaimEvent = {
      schemaVersion: EVENT_SCHEMA,
      type: "claim",
      eventSeq: authority.events.length + 1,
      previousEventHash: authority.lastEventHash,
      sessionId: options.sessionId,
      runId: options.runId,
      ownerId,
      fencingToken,
      previousFencingToken: fencingToken - 1,
      leaseDurationMs: options.ttlMs,
      claimedAt: now,
      expiresAt: addDuration(now, options.ttlMs),
      baseTailSeq: options.baseTailSeq,
      basePrefixHash: options.basePrefixHash,
    };
    const attempt = transitionAttempt(event);
    options.beforeTransitionPublish?.(attempt);
    if (
      publishEvent(paths, event, () => options.afterTransitionLink?.(attempt))
    ) {
      return {
        status: "acquired",
        lease: new FileLease(
          paths,
          event,
          clock,
          options.beforeTransitionPublish,
          options.afterTransitionLink,
        ),
      };
    }
    // The single S+1 slot was won by another transition. Reloading turns a
    // winning heartbeat into busy, a winning claim into busy, and a winning
    // release into a legitimate S+2 claim attempt.
  }
}

/**
 * Read projection for one run. It never creates paths, but ordinary lease
 * recovery may remove a strictly recognized publisher temp hardlink.
 */
export function readFileSessionJournalCommitIndexV1(
  options: ReadFileSessionJournalCommitIndexOptionsV1,
): FileSessionJournalCommitIndexV1 {
  assertId(options.sessionId, "sessionId");
  assertId(options.runId, "runId");
  const paths = resolvePaths(options.workspaceRoot, options.sessionId);
  if (!existingOwnershipTree(paths)) {
    return immutableJournalCommitIndex(
      options.sessionId,
      options.runId,
      emptyJournalHead(),
      [],
      undefined,
    );
  }
  validatePathTree(paths);
  const identityPath = path.join(paths.ownershipDir, "identity.json");
  if (!fs.existsSync(identityPath)) {
    throw new Error("Session lease identity is missing");
  }
  readAndValidateIdentity(paths, options.sessionId);
  const authority = readAuthority(paths, options.sessionId);
  const commits = [
    ...(authority.commitsByRunId.get(options.runId)?.values() ?? []),
  ]
    .sort((left, right) => left.eventSeq - right.eventSeq)
    .map(journalCommitIndexEntry);
  return immutableJournalCommitIndex(
    options.sessionId,
    options.runId,
    journalHeadForRun(authority, options.runId),
    commits,
    latestRecoverySnapshotEntry(authority, options.runId),
  );
}

/** @internal Strict-readonly recovery projection used by FileRunSession readers. */
export function readFileSessionJournalCommitIndexStrictV1(
  options: ReadFileSessionJournalCommitIndexOptionsV1,
): FileSessionJournalCommitIndexV1 {
  assertId(options.sessionId, "sessionId");
  assertId(options.runId, "runId");
  const paths = resolvePaths(options.workspaceRoot, options.sessionId);
  assertCanonicalWorkspaceDirectory(paths.workspaceRoot);
  if (!strictReadonlyOwnershipTreeExists(paths)) {
    return immutableJournalCommitIndex(
      options.sessionId,
      options.runId,
      emptyJournalHead(),
      [],
      undefined,
    );
  }
  validatePathTree(paths, "strict_readonly");
  readAndValidateIdentity(paths, options.sessionId, "strict_readonly");
  const authority = readAuthority(paths, options.sessionId, "strict_readonly");
  return immutableJournalCommitIndex(
    options.sessionId,
    options.runId,
    journalHeadForRun(authority, options.runId),
    [...(authority.commitsByRunId.get(options.runId)?.values() ?? [])]
      .sort((left, right) => left.eventSeq - right.eventSeq)
      .map(journalCommitIndexEntry),
    latestRecoverySnapshotEntry(authority, options.runId),
  );
}

/**
 * Strictly read-only projection of every non-empty run journal in a Session.
 * Unlike the ordinary lease reader, this never repairs publisher temp links or
 * creates missing storage. A partially present authority is corruption.
 */
export function readFileSessionAuthorityInventoryV1(
  options: ReadFileSessionAuthorityInventoryOptionsV1,
): FileSessionAuthorityInventoryV1 {
  assertId(options.sessionId, "sessionId");
  const paths = resolvePaths(options.workspaceRoot, options.sessionId);
  assertCanonicalWorkspaceDirectory(paths.workspaceRoot);
  if (!strictReadonlyOwnershipTreeExists(paths)) {
    return immutableAuthorityInventory(options.sessionId, []);
  }
  validatePathTree(paths, "strict_readonly");
  readAndValidateIdentity(paths, options.sessionId, "strict_readonly");
  const authority = readAuthority(paths, options.sessionId, "strict_readonly");
  const runs = [...authority.headsByRunId.entries()]
    .filter(([, head]) => head.tailSeq > 0)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([runId, head]) =>
      immutableAuthorityRunInventory(
        runId,
        head,
        [...(authority.commitsByRunId.get(runId)?.values() ?? [])]
          .sort((left, right) => left.eventSeq - right.eventSeq)
          .map(journalCommitIndexEntry),
      ),
    );
  return immutableAuthorityInventory(options.sessionId, runs);
}

/**
 * Strictly read-only discovery of Session authorities below one workspace.
 * A corrupt Session is isolated as data; an unsafe shared root fails the scan.
 */
export function discoverFileSessionAuthoritiesV1(
  options: DiscoverFileSessionAuthoritiesOptionsV1,
): FileSessionAuthorityDiscoveryV1 {
  const workspaceRoot = fs.realpathSync.native(
    path.resolve(options.workspaceRoot),
  );
  const workspaceStat = fs.lstatSync(workspaceRoot);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error("Session authority workspace must be a real directory");
  }
  const sessionsRoot = path.join(workspaceRoot, ".paw", "paw-next", "sessions");
  const rootStat = strictReadonlyDirectoryIfPresent(
    workspaceRoot,
    sessionsRoot,
  );
  if (!rootStat) return immutableAuthorityDiscovery([]);
  const names = fs.readdirSync(sessionsRoot).sort(compareText);
  const entries = names.map((entryName) =>
    discoverAuthorityEntry(workspaceRoot, sessionsRoot, entryName),
  );
  assertDiscoveryRootUnchanged(workspaceRoot, sessionsRoot, rootStat, names);
  return immutableAuthorityDiscovery(entries);
}

function assertCanonicalWorkspaceDirectory(workspaceRoot: string): void {
  const stat = fs.lstatSync(workspaceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Paw Next workspace root must be a real directory");
  }
}

class FileLease implements FileSessionExecutionLeaseV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly baseTailSeq: number;
  readonly basePrefixHash: string;
  readonly signal: AbortSignal;
  private readonly abortController = new AbortController();
  private expiresAtValue: number;
  private lost = false;
  private released = false;
  private transitionQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: LeasePaths,
    private readonly claim: ClaimEvent,
    private readonly clock: () => number,
    private readonly beforePublish:
      | ((attempt: SessionLeaseTransitionAttemptV1) => void)
      | undefined,
    private readonly afterLink:
      | ((attempt: SessionLeaseTransitionAttemptV1) => void)
      | undefined,
  ) {
    this.workspaceRoot = paths.workspaceRoot;
    this.sessionId = claim.sessionId;
    this.runId = claim.runId;
    this.ownerId = claim.ownerId;
    this.fencingToken = claim.fencingToken;
    this.baseTailSeq = claim.baseTailSeq;
    this.basePrefixHash = claim.basePrefixHash;
    this.expiresAtValue = claim.expiresAt;
    this.signal = this.abortController.signal;
    issuedLeaseCapabilities.set(
      this,
      Object.freeze({
        workspaceRoot: paths.workspaceRoot,
        sessionId: claim.sessionId,
        runId: claim.runId,
        signal: this.abortController.signal,
        assertHeld: this.assertHeld.bind(this),
        renew: this.renew.bind(this),
        release: this.release.bind(this),
        readExpiresAt: () => this.expiresAtValue,
        readLeaseDurationMs: () => this.claim.leaseDurationMs,
        linearizeJournalBatch: this.linearizeJournalBatch.bind(this),
        linearizeRecoverySnapshot: this.linearizeRecoverySnapshot.bind(this),
      }),
    );
  }

  get expiresAt(): number {
    return this.expiresAtValue;
  }

  assertHeld(): void {
    if (this.released || this.lost) throw this.lostError("is not held");
    try {
      const current = this.ownedActiveProjection(readClock(this.clock));
      this.expiresAtValue = current.expiresAt;
    } catch (error) {
      throw this.markLost(error);
    }
  }

  renew(): Promise<void> {
    return this.serializeTransition(() => this.renewTransition());
  }

  release(): Promise<"released" | "already_released" | "lost"> {
    return this.serializeTransition(() => this.releaseTransition());
  }

  linearizeJournalBatch(
    input: LinearizeJournalBatchInputV1,
  ): Promise<LinearizeJournalBatchResultV1> {
    assertLinearizeInput(input);
    return this.serializeTransition(() => this.linearizeTransition(input));
  }

  linearizeRecoverySnapshot(
    input: LinearizeRecoverySnapshotInputV1,
  ): Promise<LinearizeRecoverySnapshotResultV1> {
    assertLinearizeRecoverySnapshotInput(input);
    return this.serializeTransition(() =>
      this.linearizeRecoverySnapshotTransition(input),
    );
  }

  private async renewTransition(): Promise<void> {
    for (;;) {
      if (this.released || this.lost) throw this.lostError("cannot renew");
      const now = readClock(this.clock);
      let authority: Authority;
      try {
        authority = readAuthority(this.paths, this.sessionId);
      } catch (error) {
        throw this.markLost(error);
      }
      const current = authority.current;
      if (!current || !sameClaim(current.claim, this.claim)) {
        throw this.markLost(new Error("lease was superseded before renewal"));
      }
      try {
        assertClockNotBehind(authority, now);
      } catch (error) {
        throw this.markLost(error);
      }
      if (!isActive(current, now)) {
        throw this.markLost(new Error("expired lease cannot be renewed"));
      }
      const event: HeartbeatEvent = {
        schemaVersion: EVENT_SCHEMA,
        type: "heartbeat",
        eventSeq: authority.events.length + 1,
        previousEventHash: authority.lastEventHash,
        sessionId: this.sessionId,
        runId: this.runId,
        ownerId: this.ownerId,
        fencingToken: this.fencingToken,
        renewedAt: now,
        expiresAt: addDuration(now, this.claim.leaseDurationMs),
      };
      const attempt = transitionAttempt(event);
      this.beforePublish?.(attempt);
      if (!publishEvent(this.paths, event, () => this.afterLink?.(attempt))) {
        continue;
      }
      try {
        this.expiresAtValue = this.ownedActiveProjection(
          readClock(this.clock),
        ).expiresAt;
        return;
      } catch (error) {
        throw this.markLost(error);
      }
    }
  }

  private async releaseTransition(): Promise<
    "released" | "already_released" | "lost"
  > {
    if (this.released) return "already_released";
    if (this.lost) return "lost";
    for (;;) {
      const now = readClock(this.clock);
      let authority: Authority;
      try {
        authority = readAuthority(this.paths, this.sessionId);
      } catch (error) {
        this.markLost(error);
        throw error;
      }
      const current = authority.current;
      if (!current || !sameClaim(current.claim, this.claim)) {
        this.markLost(new Error("stale lease cannot release its successor"));
        return "lost";
      }
      try {
        assertClockNotBehind(authority, now);
      } catch (error) {
        this.markLost(error);
        throw error;
      }
      if (current.released) {
        this.finishRelease();
        return "already_released";
      }
      if (!isActive(current, now)) {
        this.markLost(new Error("expired lease cannot be released"));
        return "lost";
      }
      const event: ReleaseEvent = {
        schemaVersion: EVENT_SCHEMA,
        type: "release",
        eventSeq: authority.events.length + 1,
        previousEventHash: authority.lastEventHash,
        sessionId: this.sessionId,
        runId: this.runId,
        ownerId: this.ownerId,
        fencingToken: this.fencingToken,
        releasedAt: now,
      };
      const attempt = transitionAttempt(event);
      this.beforePublish?.(attempt);
      if (!publishEvent(this.paths, event, () => this.afterLink?.(attempt))) {
        continue;
      }
      this.finishRelease();
      return "released";
    }
  }

  private async linearizeTransition(
    input: LinearizeJournalBatchInputV1,
  ): Promise<LinearizeJournalBatchResultV1> {
    for (;;) {
      const now = readClock(this.clock);
      let authority: Authority;
      try {
        authority = readAuthority(this.paths, this.sessionId);
      } catch (error) {
        throw this.markLost(error);
      }
      if (this.released || this.lost) {
        this.markLost(new Error("lease cannot linearize a journal batch"));
        return { status: "lost" };
      }
      try {
        assertClockNotBehind(authority, now);
      } catch (error) {
        this.markLost(error);
        return { status: "lost" };
      }
      const current = authority.current;
      if (
        !current ||
        !sameClaim(current.claim, this.claim) ||
        !isActive(current, now)
      ) {
        this.markLost(new Error("lease cannot linearize a journal batch"));
        return { status: "lost" };
      }
      const existing = commitForRun(authority, this.runId, input.commitId);
      if (existing) {
        if (!sameJournalCommit(existing, input)) {
          throw new Error("Journal commitId was reused with different content");
        }
        const head = journalHeadForRun(authority, this.runId);
        if (!sameJournalHead(head, journalHeadFromCommit(existing))) {
          return { status: "conflict", head };
        }
        return {
          status: "already_committed",
          eventSeq: existing.eventSeq,
          head,
        };
      }
      const head = journalHeadForRun(authority, this.runId);
      if (!sameJournalHead(head, input.expectedHead)) {
        return { status: "conflict", head };
      }
      const event: JournalCommitEvent = {
        schemaVersion: EVENT_SCHEMA,
        type: "journal_commit",
        eventSeq: authority.events.length + 1,
        previousEventHash: authority.lastEventHash,
        sessionId: this.sessionId,
        runId: this.runId,
        ownerId: this.ownerId,
        fencingToken: this.fencingToken,
        commitId: input.commitId,
        committedAt: now,
        previousTailSeq: input.expectedHead.tailSeq,
        previousPrefixHash: input.expectedHead.prefixHash,
        tailSeq: input.nextHead.tailSeq,
        prefixHash: input.nextHead.prefixHash,
        batchStartSeq: input.batchStartSeq,
        batchEndSeq: input.batchEndSeq,
        artifactId: input.artifactId,
        artifactFileName: input.artifactFileName,
        artifactContentHash: input.artifactContentHash,
      };
      const attempt = transitionAttempt(event);
      this.beforePublish?.(attempt);
      if (!publishEvent(this.paths, event, () => this.afterLink?.(attempt))) {
        continue;
      }
      return {
        status: "committed",
        eventSeq: event.eventSeq,
        head: journalHeadFromCommit(event),
      };
    }
  }

  private async linearizeRecoverySnapshotTransition(
    input: LinearizeRecoverySnapshotInputV1,
  ): Promise<LinearizeRecoverySnapshotResultV1> {
    for (;;) {
      const now = readClock(this.clock);
      let authority: Authority;
      try {
        authority = readAuthority(this.paths, this.sessionId);
      } catch (error) {
        throw this.markLost(error);
      }
      if (this.released || this.lost) {
        this.markLost(new Error("lease cannot linearize a recovery snapshot"));
        return { status: "lost" };
      }
      try {
        assertClockNotBehind(authority, now);
      } catch (error) {
        this.markLost(error);
        return { status: "lost" };
      }
      const current = authority.current;
      if (
        !current ||
        !sameClaim(current.claim, this.claim) ||
        !isActive(current, now)
      ) {
        this.markLost(new Error("lease cannot linearize a recovery snapshot"));
        return { status: "lost" };
      }
      const existing = snapshotForRun(authority, this.runId, input.snapshotId);
      const head = journalHeadForRun(authority, this.runId);
      if (existing) {
        if (!sameRecoverySnapshotCommit(existing, input)) {
          throw new Error(
            "Recovery snapshotId was reused with different content",
          );
        }
        if (!sameJournalHead(head, input.head)) {
          return { status: "conflict", head };
        }
        return {
          status: "already_committed",
          eventSeq: existing.eventSeq,
          head,
        };
      }
      if (!sameJournalHead(head, input.head)) {
        return { status: "conflict", head };
      }
      const journalCommit = commitForRun(
        authority,
        this.runId,
        input.journalCommitId,
      );
      if (
        !journalCommit ||
        journalCommit.eventSeq !== input.journalCommitEventSeq ||
        !sameJournalHead(journalHeadFromCommit(journalCommit), head)
      ) {
        throw new Error("Recovery snapshot journal commit anchor is invalid");
      }
      const event: RecoverySnapshotCommitEvent = {
        schemaVersion: EVENT_SCHEMA,
        type: "recovery_snapshot_commit",
        eventSeq: authority.events.length + 1,
        previousEventHash: authority.lastEventHash,
        sessionId: this.sessionId,
        runId: this.runId,
        ownerId: this.ownerId,
        fencingToken: this.fencingToken,
        snapshotId: input.snapshotId,
        committedAt: now,
        journalCommitId: input.journalCommitId,
        journalCommitEventSeq: input.journalCommitEventSeq,
        journalTailSeq: input.head.tailSeq,
        journalPrefixHash: input.head.prefixHash,
        throughSeq: input.throughSeq,
        prefixHash: input.prefixHash,
        artifactId: input.artifactId,
        artifactFileName: input.artifactFileName,
        artifactContentHash: input.artifactContentHash,
      };
      const attempt = transitionAttempt(event);
      this.beforePublish?.(attempt);
      if (!publishEvent(this.paths, event, () => this.afterLink?.(attempt))) {
        continue;
      }
      return {
        status: "committed",
        eventSeq: event.eventSeq,
        head,
      };
    }
  }

  private serializeTransition<T>(action: () => Promise<T>): Promise<T> {
    const prior = this.transitionQueue;
    let unlock!: () => void;
    this.transitionQueue = new Promise((resolve) => {
      unlock = resolve;
    });
    return prior.then(action).finally(unlock);
  }

  private ownedActiveProjection(now: number): Projection {
    const authority = readAuthority(this.paths, this.sessionId);
    assertClockNotBehind(authority, now);
    const current = authority.current;
    if (!current || !sameClaim(current.claim, this.claim)) {
      throw new Error("fencing token is stale");
    }
    if (!isActive(current, now)) throw new Error("lease expired or released");
    return current;
  }

  private finishRelease(): void {
    this.released = true;
    if (!this.signal.aborted) this.abortController.abort("lease released");
  }

  private markLost(error: unknown): SessionExecutionLeaseLostError {
    this.lost = true;
    const detail = error instanceof Error ? `: ${error.message}` : "";
    const result = new SessionExecutionLeaseLostError(
      `Session lease lost${detail}`,
    );
    if (!this.signal.aborted) this.abortController.abort(result);
    return result;
  }

  private lostError(detail: string): SessionExecutionLeaseLostError {
    return new SessionExecutionLeaseLostError(`Session lease ${detail}`);
  }
}

/** @internal Rejects duck-typed or cross-workspace lease capabilities. */
export function assertFileSessionExecutionLeaseCapabilityV1(
  value: FileSessionExecutionLeaseV1,
  workspaceRoot: string,
  sessionId: string,
  runId: string,
): VerifiedFileSessionExecutionLeaseCapabilityV1 {
  const capability = issuedLeaseCapabilities.get(value as object);
  if (!capability) {
    throw new Error(
      "File Session requires an issued execution lease capability",
    );
  }
  const canonicalWorkspace = fs.realpathSync.native(
    path.resolve(workspaceRoot),
  );
  if (
    capability.workspaceRoot !== canonicalWorkspace ||
    capability.sessionId !== sessionId ||
    capability.runId !== runId ||
    value.workspaceRoot !== capability.workspaceRoot ||
    value.sessionId !== capability.sessionId ||
    value.runId !== capability.runId
  ) {
    throw new Error("File Session execution lease identity mismatch");
  }
  return capability;
}

/**
 * Release an issued lease through its captured operation. Public methods on the
 * lease object are intentionally not trusted because callers can shadow them.
 */
export async function releaseFileSessionExecutionLeaseV1(
  value: FileSessionExecutionLeaseV1,
  workspaceRoot: string,
  sessionId: string,
  runId: string,
): Promise<"released" | "already_released" | "lost"> {
  const capability = assertFileSessionExecutionLeaseCapabilityV1(
    value,
    workspaceRoot,
    sessionId,
    runId,
  );
  return capability.release();
}

function preparePaths(workspaceInput: string, sessionId: string): LeasePaths {
  const paths = resolvePaths(workspaceInput, sessionId);
  const identityPath = path.join(paths.ownershipDir, "identity.json");
  if (fs.existsSync(identityPath)) {
    validateExistingDirectoryTree(paths.workspaceRoot, paths.eventsDir);
  } else {
    ensureSafeDirectoryTree(paths.workspaceRoot, paths.eventsDir);
  }
  assertOwnershipEntries(paths);
  return paths;
}

function resolvePaths(workspaceInput: string, sessionId: string): LeasePaths {
  const workspaceRoot = fs.realpathSync.native(path.resolve(workspaceInput));
  const ownershipDir = path.join(
    workspaceRoot,
    ".paw",
    "paw-next",
    "sessions",
    hashText(sessionId),
    "ownership",
  );
  return {
    workspaceRoot,
    ownershipDir,
    eventsDir: path.join(ownershipDir, "events"),
  };
}

function existingOwnershipTree(paths: LeasePaths): boolean {
  const relative = path.relative(paths.workspaceRoot, paths.ownershipDir);
  let current = paths.workspaceRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) return false;
    validateDirectoryPath(paths.workspaceRoot, current);
  }
  return true;
}

function validatePathTree(
  paths: LeasePaths,
  mode: AuthorityReadMode = "recovering",
): void {
  validateExistingDirectoryTree(paths.workspaceRoot, paths.eventsDir);
  assertOwnershipEntries(paths, mode);
}

function strictReadonlyOwnershipTreeExists(paths: LeasePaths): boolean {
  const sessionDir = path.dirname(paths.ownershipDir);
  const relative = path.relative(paths.workspaceRoot, sessionDir);
  let current = paths.workspaceRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (fsError(error, "ENOENT")) return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Session lease storage contains a symbolic link");
    }
    validateDirectoryPath(paths.workspaceRoot, current);
  }
  for (const required of [paths.ownershipDir, paths.eventsDir]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(required);
    } catch (error) {
      if (fsError(error, "ENOENT")) {
        throw new Error("Session lease authority is partially missing");
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Session lease storage contains a symbolic link");
    }
    validateDirectoryPath(paths.workspaceRoot, required);
  }
  const identity = path.join(paths.ownershipDir, "identity.json");
  try {
    fs.lstatSync(identity);
  } catch (error) {
    if (fsError(error, "ENOENT")) {
      throw new Error("Session lease identity is missing");
    }
    throw error;
  }
  return true;
}

function strictReadonlyDirectoryIfPresent(
  workspaceRoot: string,
  target: string,
): fs.Stats | undefined {
  const relative = path.relative(workspaceRoot, target);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error("Session authority discovery escaped the workspace root");
  }
  let current = workspaceRoot;
  let targetStat: fs.Stats | undefined;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (fsError(error, "ENOENT")) return undefined;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        "Session authority discovery root contains a symbolic link",
      );
    }
    validateDirectoryPath(workspaceRoot, current);
    targetStat = stat;
  }
  return targetStat;
}

function discoverAuthorityEntry(
  workspaceRoot: string,
  sessionsRoot: string,
  entryName: string,
): FileSessionAuthorityDiscoveryEntryV1 {
  if (!SHA256.test(entryName)) {
    return corruptDiscoveryEntry(entryName, "unrecognized_session_entry");
  }
  const sessionDir = path.join(sessionsRoot, entryName);
  let sessionStat: fs.Stats;
  try {
    sessionStat = fs.lstatSync(sessionDir);
  } catch (error) {
    if (fsError(error, "ENOENT")) {
      throw new Error("Session authority discovery changed while reading");
    }
    throw error;
  }
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
    return corruptDiscoveryEntry(entryName, "unsafe_session_directory");
  }
  try {
    validateDirectoryPath(workspaceRoot, sessionDir);
  } catch {
    return corruptDiscoveryEntry(entryName, "unsafe_session_directory");
  }
  let sessionId: string;
  try {
    sessionId = readDiscoveredSessionIdentity(workspaceRoot, sessionDir);
  } catch {
    return corruptDiscoveryEntry(entryName, "identity_invalid");
  }
  if (hashText(sessionId) !== entryName) {
    return corruptDiscoveryEntry(entryName, "identity_storage_key_mismatch");
  }
  let inventory: FileSessionAuthorityInventoryV1;
  try {
    inventory = readFileSessionAuthorityInventoryV1({
      workspaceRoot,
      sessionId,
    });
  } catch {
    return corruptDiscoveryEntry(entryName, "authority_corrupt");
  }
  const finalStat = fs.lstatSync(sessionDir);
  if (
    !finalStat.isDirectory() ||
    finalStat.isSymbolicLink() ||
    finalStat.dev !== sessionStat.dev ||
    finalStat.ino !== sessionStat.ino
  ) {
    throw new Error("Session authority discovery changed while reading");
  }
  return Object.freeze({
    status: "discovered",
    entryName,
    sessionId,
    inventory,
  });
}

function readDiscoveredSessionIdentity(
  workspaceRoot: string,
  sessionDir: string,
): string {
  const ownershipDir = path.join(sessionDir, "ownership");
  const ownershipStat = fs.lstatSync(ownershipDir);
  if (!ownershipStat.isDirectory() || ownershipStat.isSymbolicLink()) {
    throw new Error("Session lease ownership must be a real directory");
  }
  validateDirectoryPath(workspaceRoot, ownershipDir);
  const identity = readJsonFile(
    path.join(ownershipDir, "identity.json"),
    "Session lease identity",
    "strict_readonly",
  );
  exactKeys(identity, ["schemaVersion", "sessionId"], "identity");
  if (identity.schemaVersion !== IDENTITY_SCHEMA) {
    throw new Error("Session lease identity schema is invalid");
  }
  assertId(identity.sessionId, "identity.sessionId");
  return identity.sessionId;
}

function assertDiscoveryRootUnchanged(
  workspaceRoot: string,
  sessionsRoot: string,
  before: fs.Stats,
  names: readonly string[],
): void {
  validateExistingDirectoryTree(workspaceRoot, sessionsRoot);
  const after = fs.lstatSync(sessionsRoot);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    !sameTextList(names, fs.readdirSync(sessionsRoot).sort(compareText))
  ) {
    throw new Error("Session authority discovery changed while reading");
  }
}

function sameTextList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function corruptDiscoveryEntry(
  entryName: string,
  reason: FileSessionAuthorityDiscoveryCorruptionV1,
): FileSessionAuthorityDiscoveryEntryV1 {
  return Object.freeze({ status: "corrupt", entryName, reason });
}

function ensureIdentity(paths: LeasePaths, sessionId: string): void {
  validatePathTree(paths);
  const identityPath = path.join(paths.ownershipDir, "identity.json");
  const expected = { schemaVersion: IDENTITY_SCHEMA, sessionId };
  if (!fs.existsSync(identityPath)) {
    if (fs.readdirSync(paths.eventsDir).length > 0) {
      throw new Error(
        "Session lease identity is missing beside existing authority",
      );
    }
    atomicPublishNewFile(identityPath, `${JSON.stringify(expected)}\n`);
  }
  const parsed = readJsonFile(identityPath, "Session lease identity");
  exactKeys(parsed, ["schemaVersion", "sessionId"], "identity");
  if (
    parsed.schemaVersion !== IDENTITY_SCHEMA ||
    parsed.sessionId !== sessionId
  ) {
    throw new Error("Session lease identity mismatch");
  }
  assertOwnershipEntries(paths);
}

function readAndValidateIdentity(
  paths: LeasePaths,
  sessionId: string,
  mode: AuthorityReadMode = "recovering",
): void {
  const identity = readJsonFile(
    path.join(paths.ownershipDir, "identity.json"),
    "Session lease identity",
    mode,
  );
  exactKeys(identity, ["schemaVersion", "sessionId"], "identity");
  if (
    identity.schemaVersion !== IDENTITY_SCHEMA ||
    identity.sessionId !== sessionId
  ) {
    throw new Error("Session lease identity mismatch");
  }
}

function readAuthority(
  paths: LeasePaths,
  sessionId: string,
  mode: AuthorityReadMode = "recovering",
): Authority {
  validatePathTree(paths, mode);
  const names = eventFileNames(paths.eventsDir, mode);
  const events: TransitionEvent[] = [];
  let current: Projection | undefined;
  let previousHash = ZERO_HASH;
  let lastEventTime: number | undefined;
  const headsByRunId = new Map<string, JournalHeadV1>();
  const commitsByRunId = new Map<string, Map<string, JournalCommitEvent>>();
  const snapshotsByRunId = new Map<
    string,
    Map<string, RecoverySnapshotCommitEvent>
  >();
  const latestSnapshotByRunId = new Map<string, RecoverySnapshotCommitEvent>();
  for (const [index, name] of names.entries()) {
    const eventSeq = eventSeqFromName(name);
    if (eventSeq !== index + 1)
      throw new Error("lease eventSeq is not contiguous");
    const { value, contentHash } = readEventFile(
      path.join(paths.eventsDir, name),
      mode,
    );
    const event = parseEvent(value, sessionId, eventSeq);
    if (event.previousEventHash !== previousHash) {
      throw new Error("lease previousEventHash chain is invalid");
    }
    const time = eventTime(event);
    if (lastEventTime !== undefined && time < lastEventTime) {
      throw new Error("lease event time moved backwards");
    }
    current = reduceEvent(
      current,
      event,
      headsByRunId,
      commitsByRunId,
      snapshotsByRunId,
      latestSnapshotByRunId,
    );
    events.push(event);
    previousHash = contentHash;
    lastEventTime = time;
  }
  return {
    events,
    ...(current ? { current } : {}),
    lastEventHash: previousHash,
    ...(lastEventTime === undefined ? {} : { lastEventTime }),
    headsByRunId,
    commitsByRunId,
    snapshotsByRunId,
    latestSnapshotByRunId,
  };
}

function reduceEvent(
  current: Projection | undefined,
  event: TransitionEvent,
  headsByRunId: Map<string, JournalHeadV1>,
  commitsByRunId: Map<string, Map<string, JournalCommitEvent>>,
  snapshotsByRunId: Map<string, Map<string, RecoverySnapshotCommitEvent>>,
  latestSnapshotByRunId: Map<string, RecoverySnapshotCommitEvent>,
): Projection {
  if (event.type === "claim") {
    const token = (current?.claim.fencingToken ?? 0) + 1;
    if (
      event.fencingToken !== token ||
      event.previousFencingToken !== token - 1
    ) {
      throw new Error("lease fencingToken is not contiguous");
    }
    if (current && !current.released && event.claimedAt < current.expiresAt) {
      throw new Error("lease claim replaced an active owner");
    }
    if (
      !sameJournalHead(journalHeadFromMap(headsByRunId, event.runId), {
        tailSeq: event.baseTailSeq,
        prefixHash: event.basePrefixHash,
      })
    ) {
      throw new Error("lease claim journal anchor is stale");
    }
    return { claim: event, expiresAt: event.expiresAt, released: false };
  }
  if (!current) throw new Error("lease transition has no claim");
  if (!sameEventOwner(event, current.claim)) {
    throw new Error("lease transition owner mismatch");
  }
  if (event.type === "journal_commit") {
    if (current.released || event.committedAt >= current.expiresAt) {
      throw new Error("journal commit requires an active lease");
    }
    const runCommits = commitsByRunId.get(event.runId) ?? new Map();
    if (runCommits.has(event.commitId)) {
      throw new Error("journal commitId is duplicated");
    }
    const head = journalHeadFromMap(headsByRunId, event.runId);
    if (
      !sameJournalHead(head, {
        tailSeq: event.previousTailSeq,
        prefixHash: event.previousPrefixHash,
      })
    ) {
      throw new Error("journal commit head CAS is invalid");
    }
    const nextHead = journalHeadFromCommit(event);
    headsByRunId.set(event.runId, nextHead);
    runCommits.set(event.commitId, event);
    commitsByRunId.set(event.runId, runCommits);
    return current;
  }
  if (event.type === "recovery_snapshot_commit") {
    if (current.released || event.committedAt >= current.expiresAt) {
      throw new Error("recovery snapshot commit requires an active lease");
    }
    const head = journalHeadFromMap(headsByRunId, event.runId);
    if (
      !sameJournalHead(head, {
        tailSeq: event.journalTailSeq,
        prefixHash: event.journalPrefixHash,
      }) ||
      event.throughSeq !== event.journalTailSeq ||
      event.prefixHash !== event.journalPrefixHash
    ) {
      throw new Error("recovery snapshot journal head anchor is invalid");
    }
    const journalCommit = commitsByRunId
      .get(event.runId)
      ?.get(event.journalCommitId);
    if (
      !journalCommit ||
      journalCommit.eventSeq !== event.journalCommitEventSeq ||
      !sameJournalHead(journalHeadFromCommit(journalCommit), head)
    ) {
      throw new Error("recovery snapshot journal commit anchor is invalid");
    }
    const snapshots = snapshotsByRunId.get(event.runId) ?? new Map();
    if (snapshots.has(event.snapshotId)) {
      throw new Error("recovery snapshotId is duplicated");
    }
    snapshots.set(event.snapshotId, event);
    snapshotsByRunId.set(event.runId, snapshots);
    latestSnapshotByRunId.set(event.runId, event);
    return current;
  }
  if (event.type === "heartbeat") {
    if (current.released || event.renewedAt >= current.expiresAt) {
      throw new Error("lease heartbeat requires an active lease");
    }
    if (event.expiresAt !== event.renewedAt + current.claim.leaseDurationMs) {
      throw new Error("lease heartbeat expiry is invalid");
    }
    return { ...current, expiresAt: event.expiresAt };
  }
  if (current.released || event.releasedAt >= current.expiresAt) {
    throw new Error("lease release requires an active lease");
  }
  return { ...current, released: true };
}

function parseEvent(
  value: Record<string, unknown>,
  sessionId: string,
  eventSeq: number,
): TransitionEvent {
  if (
    value.schemaVersion !== EVENT_SCHEMA ||
    value.sessionId !== sessionId ||
    value.eventSeq !== eventSeq
  ) {
    throw new Error("lease event identity is invalid");
  }
  assertId(value.runId, "event.runId");
  assertId(value.ownerId, "event.ownerId");
  assertPositiveInteger(value.fencingToken, "event.fencingToken");
  assertHash(value.previousEventHash, "event.previousEventHash");
  if (value.type === "claim") {
    exactKeys(value, CLAIM_KEYS, "claim event");
    assertNonNegativeInteger(
      value.previousFencingToken,
      "previousFencingToken",
    );
    assertPositiveInteger(value.leaseDurationMs, "leaseDurationMs");
    assertNonNegativeInteger(value.claimedAt, "claimedAt");
    assertNonNegativeInteger(value.expiresAt, "expiresAt");
    assertNonNegativeInteger(value.baseTailSeq, "baseTailSeq");
    assertHash(value.basePrefixHash, "basePrefixHash");
    if (value.expiresAt !== value.claimedAt + value.leaseDurationMs) {
      throw new Error("lease claim expiry is invalid");
    }
    return value as unknown as ClaimEvent;
  }
  if (value.type === "heartbeat") {
    exactKeys(value, HEARTBEAT_KEYS, "heartbeat event");
    assertNonNegativeInteger(value.renewedAt, "renewedAt");
    assertNonNegativeInteger(value.expiresAt, "expiresAt");
    return value as unknown as HeartbeatEvent;
  }
  if (value.type === "release") {
    exactKeys(value, RELEASE_KEYS, "release event");
    assertNonNegativeInteger(value.releasedAt, "releasedAt");
    return value as unknown as ReleaseEvent;
  }
  if (value.type === "journal_commit") {
    exactKeys(value, JOURNAL_COMMIT_KEYS, "journal commit event");
    assertId(value.commitId, "commitId");
    assertNonNegativeInteger(value.committedAt, "committedAt");
    assertNonNegativeInteger(value.previousTailSeq, "previousTailSeq");
    assertHash(value.previousPrefixHash, "previousPrefixHash");
    assertPositiveInteger(value.tailSeq, "tailSeq");
    assertHash(value.prefixHash, "prefixHash");
    assertPositiveInteger(value.batchStartSeq, "batchStartSeq");
    assertPositiveInteger(value.batchEndSeq, "batchEndSeq");
    assertHash(value.artifactId, "artifactId");
    assertId(value.artifactFileName, "artifactFileName");
    assertHash(value.artifactContentHash, "artifactContentHash");
    assertJournalCommitShape(value as unknown as JournalCommitEvent);
    return value as unknown as JournalCommitEvent;
  }
  if (value.type === "recovery_snapshot_commit") {
    exactKeys(
      value,
      RECOVERY_SNAPSHOT_COMMIT_KEYS,
      "recovery snapshot commit event",
    );
    assertHash(value.snapshotId, "snapshotId");
    assertNonNegativeInteger(value.committedAt, "committedAt");
    assertId(value.journalCommitId, "journalCommitId");
    assertPositiveInteger(value.journalCommitEventSeq, "journalCommitEventSeq");
    assertPositiveInteger(value.journalTailSeq, "journalTailSeq");
    assertHash(value.journalPrefixHash, "journalPrefixHash");
    assertPositiveInteger(value.throughSeq, "throughSeq");
    assertHash(value.prefixHash, "prefixHash");
    assertHash(value.artifactId, "artifactId");
    assertId(value.artifactFileName, "artifactFileName");
    assertHash(value.artifactContentHash, "artifactContentHash");
    assertRecoverySnapshotCommitShape(
      value as unknown as RecoverySnapshotCommitEvent,
    );
    return value as unknown as RecoverySnapshotCommitEvent;
  }
  throw new Error("lease event type is invalid");
}

const BASE_KEYS = [
  "eventSeq",
  "fencingToken",
  "ownerId",
  "previousEventHash",
  "runId",
  "schemaVersion",
  "sessionId",
  "type",
] as const;
const CLAIM_KEYS = [
  ...BASE_KEYS,
  "basePrefixHash",
  "baseTailSeq",
  "claimedAt",
  "expiresAt",
  "leaseDurationMs",
  "previousFencingToken",
] as const;
const HEARTBEAT_KEYS = [...BASE_KEYS, "expiresAt", "renewedAt"] as const;
const RELEASE_KEYS = [...BASE_KEYS, "releasedAt"] as const;
const JOURNAL_COMMIT_KEYS = [
  ...BASE_KEYS,
  "artifactContentHash",
  "artifactFileName",
  "artifactId",
  "batchEndSeq",
  "batchStartSeq",
  "commitId",
  "committedAt",
  "prefixHash",
  "previousPrefixHash",
  "previousTailSeq",
  "tailSeq",
] as const;
const RECOVERY_SNAPSHOT_COMMIT_KEYS = [
  ...BASE_KEYS,
  "artifactContentHash",
  "artifactFileName",
  "artifactId",
  "committedAt",
  "journalCommitEventSeq",
  "journalCommitId",
  "journalPrefixHash",
  "journalTailSeq",
  "snapshotId",
  "prefixHash",
  "throughSeq",
] as const;

function publishEvent(
  paths: LeasePaths,
  event: TransitionEvent,
  afterLink: () => void,
): boolean {
  validatePathTree(paths);
  return atomicPublishNewFile(
    path.join(paths.eventsDir, eventFileName(event.eventSeq)),
    `${JSON.stringify(event)}\n`,
    afterLink,
  );
}

function readEventFile(
  filePath: string,
  mode: AuthorityReadMode = "recovering",
): {
  readonly value: Record<string, unknown>;
  readonly contentHash: string;
} {
  assertStableAuthorityFile(filePath, "Session lease event", mode);
  const content = fs.readFileSync(filePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("Session lease event is not valid JSON");
  }
  if (!plainObject(value))
    throw new Error("Session lease event must be an object");
  if (content !== `${JSON.stringify(value)}\n`) {
    throw new Error("Session lease event encoding is not canonical");
  }
  return { value, contentHash: hashText(content) };
}

function eventFileNames(
  directory: string,
  mode: AuthorityReadMode = "recovering",
): string[] {
  const committed: string[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    if (EVENT_FILE.test(name)) {
      assertStableAuthorityFile(full, "Session lease event", mode);
      committed.push(name);
    } else if (TEMP_FILE.test(name) && !name.startsWith("identity")) {
      assertStrictTemporaryFile(full, "Session lease temporary event");
    } else {
      throw new Error(`Unrecognized Session lease event entry: ${name}`);
    }
  }
  return committed;
}

function assertOwnershipEntries(
  paths: LeasePaths,
  mode: AuthorityReadMode = "recovering",
): void {
  for (const name of fs.readdirSync(paths.ownershipDir).sort()) {
    const full = path.join(paths.ownershipDir, name);
    if (name === "events") {
      const stat = fs.lstatSync(full);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Session lease events must be a real directory");
      }
    } else if (name === "identity.json") {
      assertStableAuthorityFile(full, "Session lease identity", mode);
    } else if (TEMP_FILE.test(name) && name.startsWith("identity")) {
      assertStrictTemporaryFile(full, "Session lease temporary identity");
    } else {
      throw new Error(`Unrecognized Session lease ownership entry: ${name}`);
    }
  }
}

function assertStableAuthorityFile(
  filePath: string,
  kind: string,
  mode: AuthorityReadMode = "recovering",
): void {
  for (;;) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${kind} must be a regular non-symlink file`);
    }
    if (stat.nlink === 1) return;
    const publisherTemps = matchingPublisherTemps(filePath, stat.dev, stat.ino);
    if (stat.nlink !== 2 || publisherTemps.length !== 1) {
      throw new Error(`${kind} must not have an external hardlink`);
    }
    if (mode === "strict_readonly") return;
    try {
      fs.rmSync(publisherTemps[0] as string);
    } catch (error) {
      if (!fsError(error, "ENOENT")) throw error;
    }
    // The publisher may concurrently remove the same strictly named sibling.
    // Re-read the formal path and require the surviving authority to have one
    // link before trusting its content.
  }
}

function assertStrictTemporaryFile(filePath: string, kind: string): void {
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
    stat.nlink < 1 ||
    stat.nlink > 2
  ) {
    throw new Error(`${kind} is invalid`);
  }
  if (
    stat.nlink === 2 &&
    !hasMatchingCommittedSibling(filePath, stat.dev, stat.ino)
  ) {
    throw new Error(`${kind} hardlink is not owned by the publisher`);
  }
}

function matchingPublisherTemps(
  authorityPath: string,
  device: number,
  inode: number,
): string[] {
  const prefix = `${path.basename(authorityPath)}.tmp-`;
  return fs.readdirSync(path.dirname(authorityPath)).flatMap((name) => {
    if (!name.startsWith(prefix) || !TEMP_FILE.test(name)) return [];
    const candidate = path.join(path.dirname(authorityPath), name);
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

function hasMatchingCommittedSibling(
  tempPath: string,
  device: number,
  inode: number,
): boolean {
  const name = path.basename(tempPath);
  const marker = name.indexOf(".tmp-");
  if (marker < 0) return false;
  const committed = path.join(path.dirname(tempPath), name.slice(0, marker));
  if (!fs.existsSync(committed)) return false;
  const stat = fs.lstatSync(committed);
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.dev === device &&
    stat.ino === inode
  );
}

function readJsonFile(
  filePath: string,
  kind: string,
  mode: AuthorityReadMode = "recovering",
): Record<string, unknown> {
  assertStableAuthorityFile(filePath, kind, mode);
  const content = fs.readFileSync(filePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`${kind} is not valid JSON`);
  }
  if (!plainObject(value)) throw new Error(`${kind} must be an object`);
  if (content !== `${JSON.stringify(value)}\n`) {
    throw new Error(`${kind} encoding is not canonical`);
  }
  return value;
}

function atomicPublishNewFile(
  finalPath: string,
  content: string,
  afterLink?: () => void,
): boolean {
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
      if (fsError(error, "EEXIST")) return false;
      throw error;
    }
    afterLink?.();
    fsyncDirectoryBestEffort(path.dirname(finalPath));
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Strictly named regular temps are ignored but never trusted as authority.
    }
  }
}

function validateDirectoryPath(workspaceRoot: string, current: string): void {
  const stat = fs.lstatSync(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Session lease storage contains a symbolic link");
  }
  const canonical = fs.realpathSync.native(current);
  const relative = path.relative(workspaceRoot, canonical);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error("Session lease storage escaped the workspace root");
  }
}

function ensureSafeDirectoryTree(workspaceRoot: string, target: string): void {
  const relative = path.relative(workspaceRoot, target);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error("Session lease storage escaped the workspace root");
  }
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      try {
        fs.mkdirSync(current);
      } catch (error) {
        if (!fsError(error, "EEXIST")) throw error;
      }
    }
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
    throw new Error("Session lease storage escaped the workspace root");
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
    // Windows and some filesystems do not permit directory fsync.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function busy(state: Projection): FileSessionLeaseBusyV1 {
  return {
    status: "busy",
    runId: state.claim.runId,
    ownerId: state.claim.ownerId,
    fencingToken: state.claim.fencingToken,
    expiresAt: state.expiresAt,
  };
}

function emptyJournalHead(): JournalHeadV1 {
  return { tailSeq: 0, prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1 };
}

function journalHeadForRun(authority: Authority, runId: string): JournalHeadV1 {
  return journalHeadFromMap(authority.headsByRunId, runId);
}

function journalHeadFromMap(
  headsByRunId: ReadonlyMap<string, JournalHeadV1>,
  runId: string,
): JournalHeadV1 {
  const head = headsByRunId.get(runId) ?? emptyJournalHead();
  return { ...head };
}

function journalHeadFromCommit(event: JournalCommitEvent): JournalHeadV1 {
  return { tailSeq: event.tailSeq, prefixHash: event.prefixHash };
}

function journalCommitIndexEntry(
  event: JournalCommitEvent,
): JournalCommitIndexEntryV1 {
  return Object.freeze({
    eventSeq: event.eventSeq,
    commitId: event.commitId,
    committedAt: event.committedAt,
    fencingToken: event.fencingToken,
    previousHead: Object.freeze({
      tailSeq: event.previousTailSeq,
      prefixHash: event.previousPrefixHash,
    }),
    head: Object.freeze(journalHeadFromCommit(event)),
    batchStartSeq: event.batchStartSeq,
    batchEndSeq: event.batchEndSeq,
    artifactId: event.artifactId,
    artifactFileName: event.artifactFileName,
    artifactContentHash: event.artifactContentHash,
  });
}

function immutableJournalCommitIndex(
  sessionId: string,
  runId: string,
  head: JournalHeadV1,
  commits: readonly JournalCommitIndexEntryV1[],
  latestRecoverySnapshot: RecoverySnapshotCommitIndexEntryV1 | undefined,
): FileSessionJournalCommitIndexV1 {
  return Object.freeze({
    sessionId,
    runId,
    head: Object.freeze({ ...head }),
    commits: Object.freeze([...commits]),
    ...(latestRecoverySnapshot === undefined ? {} : { latestRecoverySnapshot }),
  });
}

function latestRecoverySnapshotEntry(
  authority: Authority,
  runId: string,
): RecoverySnapshotCommitIndexEntryV1 | undefined {
  const event = authority.latestSnapshotByRunId.get(runId);
  if (!event) return undefined;
  return Object.freeze({
    eventSeq: event.eventSeq,
    snapshotId: event.snapshotId,
    committedAt: event.committedAt,
    fencingToken: event.fencingToken,
    journalCommitId: event.journalCommitId,
    journalCommitEventSeq: event.journalCommitEventSeq,
    head: Object.freeze({
      tailSeq: event.journalTailSeq,
      prefixHash: event.journalPrefixHash,
    }),
    throughSeq: event.throughSeq,
    prefixHash: event.prefixHash,
    artifactId: event.artifactId,
    artifactFileName: event.artifactFileName,
    artifactContentHash: event.artifactContentHash,
  });
}

function immutableAuthorityRunInventory(
  runId: string,
  head: JournalHeadV1,
  commits: readonly JournalCommitIndexEntryV1[],
): FileSessionAuthorityRunInventoryV1 {
  return Object.freeze({
    runId,
    head: Object.freeze({ ...head }),
    commits: Object.freeze([...commits]),
  });
}

function immutableAuthorityInventory(
  sessionId: string,
  runs: readonly FileSessionAuthorityRunInventoryV1[],
): FileSessionAuthorityInventoryV1 {
  const body = Object.freeze({
    schemaVersion: "paw.file-session-authority-inventory.v1" as const,
    sessionId,
    runs: Object.freeze([...runs]),
  });
  return Object.freeze({
    ...body,
    inventoryHash: hashText(JSON.stringify(body)),
  });
}

function immutableAuthorityDiscovery(
  entries: readonly FileSessionAuthorityDiscoveryEntryV1[],
): FileSessionAuthorityDiscoveryV1 {
  return Object.freeze({
    schemaVersion: "paw.file-session-authority-discovery.v1" as const,
    entries: Object.freeze([...entries]),
  });
}

function sameJournalHead(left: JournalHeadV1, right: JournalHeadV1): boolean {
  return left.tailSeq === right.tailSeq && left.prefixHash === right.prefixHash;
}

function commitForRun(
  authority: Authority,
  runId: string,
  commitId: string,
): JournalCommitEvent | undefined {
  return authority.commitsByRunId.get(runId)?.get(commitId);
}

function snapshotForRun(
  authority: Authority,
  runId: string,
  snapshotId: string,
): RecoverySnapshotCommitEvent | undefined {
  return authority.snapshotsByRunId.get(runId)?.get(snapshotId);
}

function sameJournalCommit(
  event: JournalCommitEvent,
  input: LinearizeJournalBatchInputV1,
): boolean {
  return (
    event.commitId === input.commitId &&
    event.previousTailSeq === input.expectedHead.tailSeq &&
    event.previousPrefixHash === input.expectedHead.prefixHash &&
    event.tailSeq === input.nextHead.tailSeq &&
    event.prefixHash === input.nextHead.prefixHash &&
    event.batchStartSeq === input.batchStartSeq &&
    event.batchEndSeq === input.batchEndSeq &&
    event.artifactId === input.artifactId &&
    event.artifactFileName === input.artifactFileName &&
    event.artifactContentHash === input.artifactContentHash
  );
}

function assertLinearizeInput(input: LinearizeJournalBatchInputV1): void {
  assertId(input.commitId, "commitId");
  assertNonNegativeInteger(input.expectedHead.tailSeq, "expectedHead.tailSeq");
  assertHash(input.expectedHead.prefixHash, "expectedHead.prefixHash");
  assertPositiveInteger(input.nextHead.tailSeq, "nextHead.tailSeq");
  assertHash(input.nextHead.prefixHash, "nextHead.prefixHash");
  assertPositiveInteger(input.batchStartSeq, "batchStartSeq");
  assertPositiveInteger(input.batchEndSeq, "batchEndSeq");
  assertHash(input.artifactId, "artifactId");
  assertId(input.artifactFileName, "artifactFileName");
  assertHash(input.artifactContentHash, "artifactContentHash");
  assertJournalCommitShape({
    batchStartSeq: input.batchStartSeq,
    batchEndSeq: input.batchEndSeq,
    previousTailSeq: input.expectedHead.tailSeq,
    tailSeq: input.nextHead.tailSeq,
    artifactId: input.artifactId,
    artifactFileName: input.artifactFileName,
    artifactContentHash: input.artifactContentHash,
  });
}

function assertLinearizeRecoverySnapshotInput(
  input: LinearizeRecoverySnapshotInputV1,
): void {
  assertHash(input.snapshotId, "snapshotId");
  assertId(input.journalCommitId, "journalCommitId");
  assertPositiveInteger(input.journalCommitEventSeq, "journalCommitEventSeq");
  assertPositiveInteger(input.head.tailSeq, "head.tailSeq");
  assertHash(input.head.prefixHash, "head.prefixHash");
  assertPositiveInteger(input.throughSeq, "throughSeq");
  assertHash(input.prefixHash, "prefixHash");
  assertHash(input.artifactId, "artifactId");
  assertId(input.artifactFileName, "artifactFileName");
  assertHash(input.artifactContentHash, "artifactContentHash");
  assertRecoverySnapshotCommitShape({
    snapshotId: input.snapshotId,
    journalTailSeq: input.head.tailSeq,
    journalPrefixHash: input.head.prefixHash,
    throughSeq: input.throughSeq,
    prefixHash: input.prefixHash,
    artifactId: input.artifactId,
    artifactFileName: input.artifactFileName,
    artifactContentHash: input.artifactContentHash,
  });
}

function assertRecoverySnapshotCommitShape(
  value: Pick<
    RecoverySnapshotCommitEvent,
    | "snapshotId"
    | "journalTailSeq"
    | "journalPrefixHash"
    | "prefixHash"
    | "throughSeq"
    | "artifactId"
    | "artifactFileName"
    | "artifactContentHash"
  >,
): void {
  if (
    value.throughSeq !== value.journalTailSeq ||
    value.prefixHash !== value.journalPrefixHash ||
    value.snapshotId !== value.artifactId ||
    value.artifactId !== value.artifactContentHash ||
    value.artifactFileName !==
      recoverySnapshotArtifactFileName(value.throughSeq, value.artifactId)
  ) {
    throw new Error("Recovery snapshot artifact identity is invalid");
  }
}

function sameRecoverySnapshotCommit(
  event: RecoverySnapshotCommitEvent,
  input: LinearizeRecoverySnapshotInputV1,
): boolean {
  return (
    event.snapshotId === input.snapshotId &&
    event.journalCommitId === input.journalCommitId &&
    event.journalCommitEventSeq === input.journalCommitEventSeq &&
    event.journalTailSeq === input.head.tailSeq &&
    event.journalPrefixHash === input.head.prefixHash &&
    event.throughSeq === input.throughSeq &&
    event.prefixHash === input.prefixHash &&
    event.artifactId === input.artifactId &&
    event.artifactFileName === input.artifactFileName &&
    event.artifactContentHash === input.artifactContentHash
  );
}

function assertJournalCommitShape(
  value: Pick<
    JournalCommitEvent,
    | "batchStartSeq"
    | "batchEndSeq"
    | "previousTailSeq"
    | "tailSeq"
    | "artifactId"
    | "artifactFileName"
    | "artifactContentHash"
  >,
): void {
  if (
    value.batchStartSeq !== value.previousTailSeq + 1 ||
    value.batchEndSeq !== value.tailSeq ||
    value.batchEndSeq < value.batchStartSeq
  ) {
    throw new Error("Journal commit batch range is invalid");
  }
  if (
    value.artifactId !== value.artifactContentHash ||
    value.artifactFileName !==
      journalArtifactFileName(
        value.batchStartSeq,
        value.batchEndSeq,
        value.artifactId,
      )
  ) {
    throw new Error("Journal commit artifact identity is invalid");
  }
}

function journalArtifactFileName(
  startSeq: number,
  endSeq: number,
  artifactId: string,
): string {
  const fileName = `${String(startSeq).padStart(16, "0")}-${String(
    endSeq,
  ).padStart(16, "0")}-${artifactId}.json`;
  const match = JOURNAL_ARTIFACT_FILE.exec(fileName);
  if (
    !match ||
    Number(match[1]) !== startSeq ||
    Number(match[2]) !== endSeq ||
    match[3] !== artifactId
  ) {
    throw new Error("Journal commit artifact filename is invalid");
  }
  return fileName;
}

function recoverySnapshotArtifactFileName(
  throughSeq: number,
  artifactId: string,
): string {
  const fileName = `snapshot-${String(throughSeq).padStart(
    EVENT_WIDTH,
    "0",
  )}-${artifactId}.json`;
  const match = RECOVERY_SNAPSHOT_ARTIFACT_FILE.exec(fileName);
  if (!match || Number(match[1]) !== throughSeq || match[2] !== artifactId) {
    throw new Error("Recovery snapshot artifact filename is invalid");
  }
  return fileName;
}

function isActive(state: Projection, now: number): boolean {
  return !state.released && now < state.expiresAt;
}

function sameClaim(left: ClaimEvent, right: ClaimEvent): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.ownerId === right.ownerId &&
    left.fencingToken === right.fencingToken
  );
}

function sameEventOwner(
  event:
    | HeartbeatEvent
    | ReleaseEvent
    | JournalCommitEvent
    | RecoverySnapshotCommitEvent,
  claim: ClaimEvent,
): boolean {
  return (
    event.sessionId === claim.sessionId &&
    event.runId === claim.runId &&
    event.ownerId === claim.ownerId &&
    event.fencingToken === claim.fencingToken
  );
}

function transitionAttempt(
  event: TransitionEvent,
): SessionLeaseTransitionAttemptV1 {
  return {
    kind: event.type,
    eventSeq: event.eventSeq,
    fencingToken: event.fencingToken,
  };
}

function eventTime(event: TransitionEvent): number {
  if (event.type === "claim") return event.claimedAt;
  if (event.type === "heartbeat") return event.renewedAt;
  if (event.type === "release") return event.releasedAt;
  return event.committedAt;
}

function assertClockNotBehind(authority: Authority, now: number): void {
  if (authority.lastEventTime !== undefined && now < authority.lastEventTime) {
    throw new Error("Session lease clock moved behind the last transition");
  }
}

function eventFileName(eventSeq: number): string {
  assertPositiveInteger(eventSeq, "eventSeq");
  const text = String(eventSeq);
  if (text.length > EVENT_WIDTH)
    throw new Error("eventSeq persisted width exceeded");
  return `${text.padStart(EVENT_WIDTH, "0")}.json`;
}

function eventSeqFromName(name: string): number {
  const value = Number(EVENT_FILE.exec(name)?.[1]);
  assertPositiveInteger(value, "eventSeq filename");
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  kind: string,
): void {
  if (Object.keys(value).sort().join(",") !== [...expected].sort().join(",")) {
    throw new Error(`Session lease ${kind} fields are invalid`);
  }
}

function assertId(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(value)
  ) {
    throw new Error(`${field} must be a stable protocol id`);
  }
}

function assertHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${field} must be a lowercase sha256 hash`);
  }
}

function assertPositiveInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(
  value: unknown,
  field: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function readClock(clock: () => number): number {
  const value = clock();
  assertNonNegativeInteger(value, "lease clock");
  return value;
}

function addDuration(now: number, duration: number): number {
  const value = now + duration;
  if (!Number.isSafeInteger(value)) throw new Error("lease expiry overflowed");
  return value;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fsError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: string }).code === code
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
