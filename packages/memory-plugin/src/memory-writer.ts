import type { Session, SessionInputSnapshot } from "@paw/agent-loop";
import { scanForSecrets } from "@paw/memory/longterm";
import {
  type DerivedDecisionV1,
  type InputFactV1,
  type JsonValue,
  MEMORY_WRITE_POLICY_VERSION_V1,
  type MemoryCandidateStagedFactV1,
  type MemoryWriteClaimedFactV1,
  type MemoryWriteSettledFactV1,
  parseModelResponseV1,
} from "@paw/protocol";

import {
  type MemoryAtomConflictResolverV1,
  reconcileMemoryAtomsV1,
} from "./atom-conflict-resolver.js";
import type {
  MemoryAtomExtractionInputV1,
  MemoryAtomExtractorV1,
  MemoryWriterSourceItemV1,
} from "./atom-extractor.js";
import type { MemoryAtomWriterStoreV1 } from "./atom-store.js";
import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";
import type {
  MemoryRawEvidenceArchiveInputV1,
  MemoryRawEvidenceArchiveV1,
} from "./raw-evidence-archive.js";

export type MemoryWriterTerminalOutcomeV1 =
  | "completed"
  | "failed"
  | "incomplete"
  | "cancelled";

export type MemoryWriterEventTypeV1 =
  | "claim"
  | "stage"
  | "reconcile"
  | "apply"
  | "archive"
  | "relation"
  | "settle"
  | "skip";

/** Content-free telemetry: hashes, IDs, counts, status, and duration only. */
export interface MemoryWriterEventV1 {
  readonly schemaVersion: "paw.memory-writer-event.v1";
  readonly type: MemoryWriterEventTypeV1;
  readonly writeId?: string;
  readonly sourceInputHash?: string;
  readonly proposalHash?: string;
  readonly atomCount?: number;
  readonly conflictCandidateCount?: number;
  readonly revisedDecisionCount?: number;
  readonly resolutionRevision?: string;
  readonly storedCount?: number;
  readonly invalidatedCount?: number;
  readonly relationCount?: number;
  readonly evidenceSpanCount?: number;
  readonly status?: MemoryWriteSettledFactV1["status"];
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export interface MemoryWriterControllerV1 {
  settleTerminal(
    outcome: MemoryWriterTerminalOutcomeV1,
  ): Promise<MemoryWriteSettledFactV1 | undefined>;
}

export interface MemoryWriterControllerOptionsV1 {
  readonly session: Pick<
    Session<InputFactV1, DerivedDecisionV1>,
    "readInputSnapshot" | "commitInputFacts"
  >;
  readonly runId: string;
  readonly scope: PawNextMemoryScopeV1;
  readonly extractor: MemoryAtomExtractorV1;
  readonly conflictResolver?: MemoryAtomConflictResolverV1;
  readonly store: MemoryAtomWriterStoreV1;
  readonly evidenceArchive?: MemoryRawEvidenceArchiveV1;
  readonly signal: AbortSignal;
  readonly maxAtoms?: number;
  readonly maxSourceChars?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: MemoryWriterEventV1) => void;
}

export function createMemoryWriterControllerV1(
  options: MemoryWriterControllerOptionsV1,
): MemoryWriterControllerV1 {
  if (!options.runId.trim()) throw new Error("Memory writer runId is invalid");
  if (
    !options.extractor?.extract ||
    !options.extractor.extractorVersion.trim()
  ) {
    throw new Error("Memory writer extractor is invalid");
  }
  if (!options.store?.recall || !options.store.apply) {
    throw new Error("Memory writer store is invalid");
  }
  if (options.evidenceArchive) {
    assertExactScope(options.evidenceArchive.scope, options.scope);
  }
  const readSnapshot = options.session.readInputSnapshot.bind(options.session);
  const commitFacts = options.session.commitInputFacts.bind(options.session);
  const now = options.now ?? Date.now;
  const maxAtoms = options.maxAtoms ?? 8;
  const maxSourceChars = options.maxSourceChars ?? 24_000;
  let episodeArchiveThroughSeq = 0;
  if (!Number.isSafeInteger(maxAtoms) || maxAtoms < 1 || maxAtoms > 16) {
    throw new Error("Memory writer maxAtoms is invalid");
  }
  if (
    !Number.isSafeInteger(maxSourceChars) ||
    maxSourceChars < 1_024 ||
    maxSourceChars > 128_000
  ) {
    throw new Error("Memory writer maxSourceChars is invalid");
  }

  return Object.freeze({
    async settleTerminal(
      outcome: MemoryWriterTerminalOutcomeV1,
    ): Promise<MemoryWriteSettledFactV1 | undefined> {
      if (options.evidenceArchive) {
        const archiveStart = now();
        const snapshot = await readSnapshot();
        const sourceFromSeq = episodeArchiveThroughSeq + 1;
        const spans =
          sourceFromSeq > snapshot.tailSeq
            ? Object.freeze([])
            : projectMemoryEpisodeArchiveInputsV1({
                snapshot,
                runId: options.runId,
                sourceFromSeq,
                sourceThroughSeq: snapshot.tailSeq,
                observedAt: new Date(archiveStart).toISOString(),
              });
        if (spans.length > 0) {
          await options.evidenceArchive.put(spans, options.signal);
          episodeArchiveThroughSeq = Math.max(
            episodeArchiveThroughSeq,
            ...spans.map((span) => span.sourceSeq),
          );
          emit(options.onEvent, {
            schemaVersion: "paw.memory-writer-event.v1",
            type: "archive",
            evidenceSpanCount: spans.length,
            reasonCode: "stable_episode_capture",
            durationMs: Math.max(0, now() - archiveStart),
          });
        }
      }
      const recovered = await recoverUnsettledWriteV1({
        readSnapshot,
        commitFacts,
        options,
        now,
      });
      if (recovered) return recovered;
      if (options.signal.aborted) return undefined;

      const snapshot = await readSnapshot();
      const source = projectMemoryWriteSourceV1(
        snapshot,
        outcome,
        maxSourceChars,
      );
      if (!source) {
        emit(options.onEvent, {
          schemaVersion: "paw.memory-writer-event.v1",
          type: "skip",
          reasonCode: "memory_write_no_stable_trigger",
          durationMs: 0,
        });
        return undefined;
      }
      const scopeFingerprint = memoryScopeFingerprintV1(options.scope);
      const writeId = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-write-identity.v1",
        repositoryId: options.scope.repositoryId,
        scopeFingerprint,
        runId: options.runId,
        sourceThroughSeq: source.sourceThroughSeq,
        sourceInputHash: source.sourceInputHash,
        policyVersion: MEMORY_WRITE_POLICY_VERSION_V1,
        extractorVersion: options.extractor.extractorVersion,
        conflictResolverVersion:
          options.conflictResolver?.resolverVersion ?? "not_configured",
      } as JsonValue);
      const claimedAt = now();
      const claim: MemoryWriteClaimedFactV1 = Object.freeze({
        type: "memory.write_claimed",
        writeId,
        trigger: source.trigger,
        policyVersion: MEMORY_WRITE_POLICY_VERSION_V1,
        extractorVersion: options.extractor.extractorVersion,
        scopeFingerprint,
        sourceFromSeq: source.sourceFromSeq,
        sourceThroughSeq: source.sourceThroughSeq,
        sourceInputHash: source.sourceInputHash,
        claimedAt,
      });
      const claimStart = now();
      const claimed = await commitUniqueMemoryFactV1({
        initialSnapshot: snapshot,
        fact: claim,
        readSnapshot,
        commitFacts,
      });
      emit(options.onEvent, {
        schemaVersion: "paw.memory-writer-event.v1",
        type: "claim",
        writeId,
        sourceInputHash: source.sourceInputHash,
        durationMs: Math.max(0, now() - claimStart),
      });
      if (!claimed || options.signal.aborted) return undefined;

      try {
        const conflicts = await options.store.recall(
          source.searchText,
          Math.max(maxAtoms * 2, 8),
          options.signal,
        );
        const extractionInput: MemoryAtomExtractionInputV1 = Object.freeze({
          writeId,
          runId: options.runId,
          repositoryId: options.scope.repositoryId,
          sourceFromSeq: source.sourceFromSeq,
          sourceThroughSeq: source.sourceThroughSeq,
          source: source.items,
          conflicts,
          maxAtoms,
        });
        const extractedAtoms = await options.extractor.extract(
          extractionInput,
          options.signal,
        );
        const reconciliationStart = now();
        const reconciliation = await reconcileMemoryAtomsV1({
          atoms: extractedAtoms,
          seedCandidates: conflicts,
          store: options.store,
          ...(options.conflictResolver === undefined
            ? {}
            : { resolver: options.conflictResolver }),
          observedAt: new Date(claimedAt).toISOString(),
          signal: options.signal,
        });
        const atoms = reconciliation.atoms;
        if (options.conflictResolver) {
          emit(options.onEvent, {
            schemaVersion: "paw.memory-writer-event.v1",
            type: "reconcile",
            writeId,
            atomCount: atoms.length,
            conflictCandidateCount: reconciliation.candidateCount,
            revisedDecisionCount: reconciliation.revisedDecisionCount,
            ...(reconciliation.resolutionRevision === undefined
              ? {}
              : { resolutionRevision: reconciliation.resolutionRevision }),
            ...(reconciliation.reasonCode === undefined
              ? {}
              : { reasonCode: reconciliation.reasonCode }),
            durationMs: Math.max(0, now() - reconciliationStart),
          });
        }
        const proposalHash = hashCanonicalJsonV1(atoms as unknown as JsonValue);
        const staged: MemoryCandidateStagedFactV1 = Object.freeze({
          type: "memory.candidate_staged",
          writeId,
          proposalHash,
          atoms: Object.freeze([...atoms]),
        });
        const stageStart = now();
        await commitUniqueMemoryFactV1({
          initialSnapshot: await readSnapshot(),
          fact: staged,
          readSnapshot,
          commitFacts,
        });
        emit(options.onEvent, {
          schemaVersion: "paw.memory-writer-event.v1",
          type: "stage",
          writeId,
          proposalHash,
          atomCount: atoms.length,
          durationMs: Math.max(0, now() - stageStart),
        });
        return applyStagedWriteV1({
          claim,
          staged,
          options,
          readSnapshot,
          commitFacts,
          now,
        });
      } catch (error) {
        const status = options.signal.aborted ? "interrupted" : "failed";
        return settleWithoutStageV1({
          claim,
          status,
          reasonCode: stableReasonCode(error),
          readSnapshot,
          commitFacts,
          now,
          onEvent: options.onEvent,
        });
      }
    },
  });
}

export function projectMemoryWriteSourceV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  outcome: MemoryWriterTerminalOutcomeV1,
  maxSourceChars = 24_000,
):
  | Readonly<{
      trigger: MemoryWriteClaimedFactV1["trigger"];
      sourceFromSeq: number;
      sourceThroughSeq: number;
      sourceInputHash: string;
      items: readonly MemoryWriterSourceItemV1[];
      searchText: string;
    }>
  | undefined {
  const lastThrough = snapshot.entries.reduce(
    (max, entry) =>
      entry.fact.type === "memory.write_claimed"
        ? Math.max(max, entry.fact.sourceThroughSeq)
        : max,
    0,
  );
  const sourceEntries = snapshot.entries.filter(
    (entry) =>
      entry.seq > lastThrough && !entry.fact.type.startsWith("memory."),
  );
  const [firstSourceEntry] = sourceEntries;
  const lastSourceEntry = sourceEntries.at(-1);
  if (!firstSourceEntry || !lastSourceEntry) return undefined;
  const sourceFromSeq = firstSourceEntry.seq;
  const sourceThroughSeq = lastSourceEntry.seq;
  const rangeEntries = snapshot.entries.filter(
    (entry) => entry.seq >= sourceFromSeq && entry.seq <= sourceThroughSeq,
  );
  const projected: MemoryWriterSourceItemV1[] = [];
  for (const entry of sourceEntries) {
    const item = projectSourceItem(entry.seq, entry.fact, outcome);
    if (item) projected.push(item);
  }
  const explicit = projected.some(
    (item) => item.kind === "user_input" && explicitMemorySignal(item.content),
  );
  const hasVerification = projected.some(
    (item) => item.kind === "verification",
  );
  const hasMutationEvidence = sourceEntries.some(
    (entry) => entry.fact.type === "tool.effect_checkpoint_allocated",
  );
  const verifiedTerminal =
    outcome === "completed" && hasVerification && hasMutationEvidence;
  if (!explicit && !verifiedTerminal) return undefined;

  const boundedItems: MemoryWriterSourceItemV1[] = [];
  let remaining = maxSourceChars;
  for (const item of projected) {
    if (remaining <= 0) break;
    const content = item.content.slice(0, remaining);
    if (!content) continue;
    boundedItems.push(Object.freeze({ ...item, content }));
    remaining -= content.length;
  }
  if (boundedItems.length === 0) return undefined;
  const searchText = boundedItems
    .filter((item) => item.kind === "user_input" || item.kind === "outcome")
    .map((item) => item.content)
    .join("\n")
    .slice(0, 8_192);
  return Object.freeze({
    trigger: explicit
      ? "explicit_user_request"
      : snapshot.entries.some(
            (entry) =>
              entry.seq >= sourceFromSeq &&
              entry.fact.type === "work.segment_started",
          )
        ? "work_segment_terminal"
        : "task_terminal",
    sourceFromSeq,
    sourceThroughSeq,
    sourceInputHash: hashCanonicalJsonV1(
      rangeEntries.map((entry) => ({
        seq: entry.seq,
        fact: entry.fact,
      })) as unknown as JsonValue,
    ),
    items: Object.freeze(boundedItems),
    searchText,
  });
}

async function recoverUnsettledWriteV1(input: {
  readonly readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
  readonly commitFacts: MemoryWriterControllerOptionsV1["session"]["commitInputFacts"];
  readonly options: MemoryWriterControllerOptionsV1;
  readonly now: () => number;
}): Promise<MemoryWriteSettledFactV1 | undefined> {
  const snapshot = await input.readSnapshot();
  const claims = snapshot.entries.filter(
    (entry) => entry.fact.type === "memory.write_claimed",
  );
  for (const entry of claims) {
    if (entry.fact.type !== "memory.write_claimed") continue;
    const claim = entry.fact;
    const settled = snapshot.entries.some(
      (candidate) =>
        candidate.fact.type === "memory.write_settled" &&
        candidate.fact.writeId === claim.writeId,
    );
    if (settled) continue;
    const stagedEntry = snapshot.entries.find(
      (candidate) =>
        candidate.fact.type === "memory.candidate_staged" &&
        candidate.fact.writeId === claim.writeId,
    );
    if (stagedEntry?.fact.type === "memory.candidate_staged") {
      return applyStagedWriteV1({
        claim,
        staged: stagedEntry.fact,
        options: input.options,
        readSnapshot: input.readSnapshot,
        commitFacts: input.commitFacts,
        now: input.now,
      });
    }
    return settleWithoutStageV1({
      claim,
      status: "interrupted",
      reasonCode: "memory_write_claim_interrupted_before_stage",
      readSnapshot: input.readSnapshot,
      commitFacts: input.commitFacts,
      now: input.now,
      onEvent: input.options.onEvent,
    });
  }
  return undefined;
}

async function applyStagedWriteV1(input: {
  readonly claim: MemoryWriteClaimedFactV1;
  readonly staged: MemoryCandidateStagedFactV1;
  readonly options: MemoryWriterControllerOptionsV1;
  readonly readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
  readonly commitFacts: MemoryWriterControllerOptionsV1["session"]["commitInputFacts"];
  readonly now: () => number;
}): Promise<MemoryWriteSettledFactV1> {
  const started = input.now();
  try {
    const result = await input.options.store.apply(
      {
        writeId: input.claim.writeId,
        runId: input.options.runId,
        repositoryId: input.options.scope.repositoryId,
        claimedAt: input.claim.claimedAt,
        atoms: input.staged.atoms,
      },
      input.options.signal,
    );
    emit(input.options.onEvent, {
      schemaVersion: "paw.memory-writer-event.v1",
      type: "apply",
      writeId: input.claim.writeId,
      proposalHash: input.staged.proposalHash,
      storedCount: result.storedIds.length,
      invalidatedCount: result.invalidatedIds.length,
      durationMs: Math.max(0, input.now() - started),
    });
    const settlement: MemoryWriteSettledFactV1 = Object.freeze({
      type: "memory.write_settled",
      writeId: input.claim.writeId,
      status: input.staged.atoms.length === 0 ? "noop" : "completed",
      proposalHash: input.staged.proposalHash,
      storedIds: result.storedIds,
      invalidatedIds: result.invalidatedIds,
      skippedAtomIds: result.skippedAtomIds,
      settledAt: input.now(),
    });
    await commitUniqueMemoryFactV1({
      initialSnapshot: await input.readSnapshot(),
      fact: settlement,
      readSnapshot: input.readSnapshot,
      commitFacts: input.commitFacts,
    });
    emit(input.options.onEvent, {
      schemaVersion: "paw.memory-writer-event.v1",
      type: "settle",
      writeId: input.claim.writeId,
      proposalHash: input.staged.proposalHash,
      status: settlement.status,
      durationMs: Math.max(0, input.now() - started),
    });
    return settlement;
  } catch (error) {
    return settleWithoutStageV1({
      claim: input.claim,
      staged: input.staged,
      status: input.options.signal.aborted ? "interrupted" : "failed",
      reasonCode: stableReasonCode(error),
      readSnapshot: input.readSnapshot,
      commitFacts: input.commitFacts,
      now: input.now,
      onEvent: input.options.onEvent,
    });
  }
}

export function projectRawEvidenceArchiveInputsV1(
  input: Readonly<{
    snapshot: SessionInputSnapshot<InputFactV1>;
    claim: MemoryWriteClaimedFactV1;
    staged: MemoryCandidateStagedFactV1;
    runId: string;
  }>,
): readonly MemoryRawEvidenceArchiveInputV1[] {
  return projectMemoryEpisodeArchiveInputsV1({
    snapshot: input.snapshot,
    runId: input.runId,
    sourceFromSeq: input.claim.sourceFromSeq,
    sourceThroughSeq: input.claim.sourceThroughSeq,
    observedAt: new Date(input.claim.claimedAt).toISOString(),
  });
}

/**
 * Projects an immutable L0 episode independently of selective L1 extraction.
 * Raw experience is captured first; semantic atoms remain optional derived
 * navigation that may be skipped or rebuilt without losing the evidence.
 */
export function projectMemoryEpisodeArchiveInputsV1(
  input: Readonly<{
    snapshot: SessionInputSnapshot<InputFactV1>;
    runId: string;
    sourceFromSeq: number;
    sourceThroughSeq: number;
    observedAt: string;
  }>,
): readonly MemoryRawEvidenceArchiveInputV1[] {
  if (
    !input.runId.trim() ||
    !Number.isSafeInteger(input.sourceFromSeq) ||
    !Number.isSafeInteger(input.sourceThroughSeq) ||
    input.sourceFromSeq < 1 ||
    input.sourceThroughSeq < input.sourceFromSeq ||
    !Number.isFinite(Date.parse(input.observedAt))
  ) {
    throw new Error("Memory episode archive range is invalid");
  }
  const spans: MemoryRawEvidenceArchiveInputV1[] = [];
  for (const entry of input.snapshot.entries) {
    if (
      entry.seq < input.sourceFromSeq ||
      entry.seq > input.sourceThroughSeq
    ) {
      continue;
    }
    const source = projectArchiveSourceItem(entry.seq, entry.fact);
    if (!source) continue;
    spans.push(
      Object.freeze({
        evidenceRef: `journal:${input.runId}#input-fact-${entry.seq}`,
        sourceKind: source.kind,
        sourceSeq: entry.seq,
        content: source.content,
        createdAt: input.observedAt,
      }),
    );
  }
  return Object.freeze(spans);
}

async function settleWithoutStageV1(input: {
  readonly claim: MemoryWriteClaimedFactV1;
  readonly staged?: MemoryCandidateStagedFactV1;
  readonly status: "failed" | "interrupted";
  readonly reasonCode: string;
  readonly readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
  readonly commitFacts: MemoryWriterControllerOptionsV1["session"]["commitInputFacts"];
  readonly now: () => number;
  readonly onEvent?: (event: MemoryWriterEventV1) => void;
}): Promise<MemoryWriteSettledFactV1> {
  const settlement: MemoryWriteSettledFactV1 = Object.freeze({
    type: "memory.write_settled",
    writeId: input.claim.writeId,
    status: input.status,
    ...(input.staged ? { proposalHash: input.staged.proposalHash } : {}),
    storedIds: Object.freeze([]),
    invalidatedIds: Object.freeze([]),
    skippedAtomIds: Object.freeze([]),
    reasonCode: input.reasonCode,
    settledAt: input.now(),
  });
  await commitUniqueMemoryFactV1({
    initialSnapshot: await input.readSnapshot(),
    fact: settlement,
    readSnapshot: input.readSnapshot,
    commitFacts: input.commitFacts,
  });
  emit(input.onEvent, {
    schemaVersion: "paw.memory-writer-event.v1",
    type: "settle",
    writeId: input.claim.writeId,
    ...(input.staged ? { proposalHash: input.staged.proposalHash } : {}),
    status: input.status,
    reasonCode: input.reasonCode,
    durationMs: 0,
  });
  return settlement;
}

async function commitUniqueMemoryFactV1(input: {
  readonly initialSnapshot: SessionInputSnapshot<InputFactV1>;
  readonly fact:
    | MemoryWriteClaimedFactV1
    | MemoryCandidateStagedFactV1
    | MemoryWriteSettledFactV1;
  readonly readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
  readonly commitFacts: MemoryWriterControllerOptionsV1["session"]["commitInputFacts"];
}): Promise<boolean> {
  let snapshot = input.initialSnapshot;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (hasEquivalentMemoryFact(snapshot, input.fact)) return false;
    if (
      (await input.commitFacts(snapshot.tailSeq, [input.fact])) === "committed"
    ) {
      return true;
    }
    snapshot = await input.readSnapshot();
  }
  throw new Error("Memory write journal commit conflict");
}

function hasEquivalentMemoryFact(
  snapshot: SessionInputSnapshot<InputFactV1>,
  fact:
    | MemoryWriteClaimedFactV1
    | MemoryCandidateStagedFactV1
    | MemoryWriteSettledFactV1,
): boolean {
  return snapshot.entries.some((entry) => {
    if (entry.fact.type !== fact.type) return false;
    if (
      entry.fact.type === "memory.write_claimed" &&
      fact.type === "memory.write_claimed"
    ) {
      return entry.fact.writeId === fact.writeId;
    }
    if (
      entry.fact.type === "memory.candidate_staged" &&
      fact.type === "memory.candidate_staged"
    ) {
      return entry.fact.writeId === fact.writeId;
    }
    return (
      entry.fact.type === "memory.write_settled" &&
      fact.type === "memory.write_settled" &&
      entry.fact.writeId === fact.writeId
    );
  });
}

function projectSourceItem(
  seq: number,
  fact: InputFactV1,
  outcome: MemoryWriterTerminalOutcomeV1,
): MemoryWriterSourceItemV1 | undefined {
  if (fact.type === "input.promoted") {
    return sanitizedSourceItem(seq, "user_input", fact.content);
  }
  const assistant = assistantSourceItem(seq, fact, 1_600);
  if (assistant) return assistant;
  if (fact.type === "tool.settled" && fact.observation) {
    return sanitizedSourceItem(
      seq,
      "tool_observation",
      `${fact.status}: ${fact.observation.summary}`,
    );
  }
  if (
    fact.type === "completion.review_settled" &&
    fact.status === "completed" &&
    fact.verdict === "allow"
  ) {
    return sanitizedSourceItem(
      seq,
      "verification",
      `completion review allowed: ${fact.reasonCode}; ${fact.summary}`,
    );
  }
  if (fact.type === "policy.request_recorded") {
    return sanitizedSourceItem(
      seq,
      "outcome",
      `terminal request=${fact.request}; outcome=${outcome}; reason=${fact.reasonCode}`,
    );
  }
  return undefined;
}

function projectArchiveSourceItem(
  seq: number,
  fact: InputFactV1,
): MemoryWriterSourceItemV1 | undefined {
  if (fact.type === "input.promoted") {
    return sanitizedSourceItem(seq, "user_input", fact.content);
  }
  const assistant = assistantSourceItem(seq, fact, 8_192);
  if (assistant) return assistant;
  if (fact.type === "tool.settled" && fact.observation) {
    return sanitizedSourceItem(
      seq,
      "tool_observation",
      `${fact.status}: ${fact.observation.summary}`,
    );
  }
  if (
    fact.type === "completion.review_settled" &&
    fact.status === "completed" &&
    fact.verdict === "allow"
  ) {
    return sanitizedSourceItem(
      seq,
      "verification",
      `completion review allowed: ${fact.reasonCode}; ${fact.summary}`,
    );
  }
  if (fact.type === "policy.request_recorded") {
    return sanitizedSourceItem(
      seq,
      "outcome",
      `terminal request=${fact.request}; reason=${fact.reasonCode}`,
    );
  }
  return undefined;
}

function assistantSourceItem(
  seq: number,
  fact: InputFactV1,
  maxChars: number,
): MemoryWriterSourceItemV1 | undefined {
  if (
    fact.type !== "model.settled" ||
    (fact.status !== "completed" && fact.status !== "truncated") ||
    fact.response?.kind !== "inline"
  ) {
    return undefined;
  }
  try {
    const response = parseModelResponseV1(fact.response.value);
    if (!response.assistantContent.trim()) return undefined;
    const sanitized = sanitizedSourceItem(
      seq,
      "assistant_output",
      response.assistantContent,
    );
    return Object.freeze({
      ...sanitized,
      content: compactAssistantContext(sanitized.content, maxChars),
    });
  } catch {
    return undefined;
  }
}

function compactAssistantContext(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = "\n[… assistant context omitted …]\n";
  const headChars = Math.min(256, Math.floor((maxChars - marker.length) / 3));
  const tailChars = maxChars - marker.length - headChars;
  return `${content.slice(0, headChars)}${marker}${content.slice(-tailChars)}`;
}

function assertExactScope(
  actual: PawNextMemoryScopeV1,
  expected: PawNextMemoryScopeV1,
): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.userId !== expected.userId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId
  ) {
    throw new Error("Memory raw evidence archive requires exact scope");
  }
}

function sanitizedSourceItem(
  seq: number,
  kind: MemoryWriterSourceItemV1["kind"],
  content: string,
): MemoryWriterSourceItemV1 {
  const scan = scanForSecrets(content);
  const safe =
    scan.action === "reject"
      ? "[SECRET_BLOCKED]"
      : scan.action === "redact"
        ? scan.text
        : content;
  return Object.freeze({ seq, kind, content: safe.slice(0, 8_192) });
}

function explicitMemorySignal(text: string): boolean {
  return /(?:记住|以后(?:都|请)?|始终|总是|永远|不要再|我(?:叫|是|喜欢|偏好|习惯|不喜欢|不允许)|remember\b|from now on\b|always\b|never\b|i (?:am|prefer|like|dislike)\b)/iu.test(
    text,
  );
}

function stableReasonCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return (
    `MemoryWriter_${name}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160) ||
    "MemoryWriter_Unknown"
  );
}

function emit(
  observer: ((event: MemoryWriterEventV1) => void) | undefined,
  event: MemoryWriterEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Caller-owned telemetry never changes write semantics.
  }
}
