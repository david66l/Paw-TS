import type { Session, SessionInputSnapshot } from "@paw/agent-loop";
import {
  type DerivedDecisionV1,
  type InputFactV1,
  type JsonValue,
  MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1,
  type MemoryTopicCandidateStagedFactV1,
  type MemoryTopicOrganizationClaimedFactV1,
  type MemoryTopicOrganizationSettledFactV1,
  type MemoryTopicProposalV1,
  type MemoryWriteSettledFactV1,
} from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";
import type {
  MemoryTopicExtractionEntryV1,
  MemoryTopicExtractionExistingTopicV1,
  MemoryTopicExtractorV1,
} from "./topic-extractor.js";

export interface MemoryTopicOrganizationSourceV1 {
  readonly sourceRevision: string;
  readonly entries: readonly MemoryTopicExtractionEntryV1[];
  readonly existingTopics: readonly MemoryTopicExtractionExistingTopicV1[];
}

export interface MemoryTopicOrganizationApplyResultV1 {
  readonly topicIds: readonly string[];
  readonly snapshotIds: readonly string[];
}

/** Storage and projection work stays behind this plugin-owned port. */
export interface MemoryTopicOrganizerStoreV1 {
  prepare(
    input: Readonly<{
      scope: PawNextMemoryScopeV1;
      sourceMemoryIds: readonly string[];
    }>,
    signal: AbortSignal,
  ): Promise<MemoryTopicOrganizationSourceV1>;
  apply(
    input: Readonly<{
      organizationId: string;
      scope: PawNextMemoryScopeV1;
      claimedAt: number;
      proposals: readonly MemoryTopicProposalV1[];
    }>,
    signal: AbortSignal,
  ): Promise<MemoryTopicOrganizationApplyResultV1>;
}

export interface MemoryTopicOrganizerEventV1 {
  readonly schemaVersion: "paw.memory-topic-organizer-event.v1";
  readonly type: "claim" | "stage" | "apply" | "settle" | "skip";
  readonly organizationId?: string;
  readonly sourceWriteId?: string;
  readonly sourceRevision?: string;
  readonly proposalHash?: string;
  readonly topicCount?: number;
  readonly status?: MemoryTopicOrganizationSettledFactV1["status"];
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export interface MemoryTopicOrganizerControllerV1 {
  settleSourceWrite(
    settlement: MemoryWriteSettledFactV1,
  ): Promise<MemoryTopicOrganizationSettledFactV1 | undefined>;
}

export interface MemoryTopicOrganizerControllerOptionsV1 {
  readonly session: Pick<
    Session<InputFactV1, DerivedDecisionV1>,
    "readInputSnapshot" | "commitInputFacts"
  >;
  readonly runId: string;
  readonly scope: PawNextMemoryScopeV1;
  readonly extractor: MemoryTopicExtractorV1;
  readonly store: MemoryTopicOrganizerStoreV1;
  readonly signal: AbortSignal;
  readonly maxTopics?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: MemoryTopicOrganizerEventV1) => void;
}

export function createMemoryTopicOrganizerControllerV1(
  options: MemoryTopicOrganizerControllerOptionsV1,
): MemoryTopicOrganizerControllerV1 {
  if (!options.runId.trim())
    throw new Error("Memory topic organizer runId is invalid");
  if (
    !options.extractor?.extract ||
    !options.extractor.extractorVersion.trim()
  ) {
    throw new Error("Memory topic organizer extractor is invalid");
  }
  if (!options.store?.prepare || !options.store.apply) {
    throw new Error("Memory topic organizer store is invalid");
  }
  const maxTopics = options.maxTopics ?? 8;
  if (!Number.isSafeInteger(maxTopics) || maxTopics < 1 || maxTopics > 16) {
    throw new Error("Memory topic organizer maxTopics is invalid");
  }
  const readSnapshot = options.session.readInputSnapshot.bind(options.session);
  const commitFacts = options.session.commitInputFacts.bind(options.session);
  const now = options.now ?? Date.now;

  return Object.freeze({
    async settleSourceWrite(settlement: MemoryWriteSettledFactV1) {
      const recovered = await recoverUnsettledOrganizationV1({
        options,
        readSnapshot,
        commitFacts,
        now,
      });
      if (recovered) return recovered;
      if (
        options.signal.aborted ||
        settlement.status !== "completed" ||
        settlement.proposalHash === undefined ||
        settlement.storedIds.length === 0
      ) {
        emit(options.onEvent, {
          schemaVersion: "paw.memory-topic-organizer-event.v1",
          type: "skip",
          sourceWriteId: settlement.writeId,
          reasonCode: "memory_topic_source_write_not_applicable",
          durationMs: 0,
        });
        return undefined;
      }

      const prepared = await options.store.prepare(
        { scope: options.scope, sourceMemoryIds: settlement.storedIds },
        options.signal,
      );
      if (!prepared.sourceRevision.trim()) {
        throw new Error("Memory topic source revision is invalid");
      }
      if (prepared.entries.length === 0) {
        emit(options.onEvent, {
          schemaVersion: "paw.memory-topic-organizer-event.v1",
          type: "skip",
          sourceWriteId: settlement.writeId,
          sourceRevision: prepared.sourceRevision,
          reasonCode: "memory_topic_source_empty",
          durationMs: 0,
        });
        return undefined;
      }

      const scopeFingerprint = memoryScopeFingerprintV1(options.scope);
      const sourceMemoryIds = Object.freeze([...settlement.storedIds].sort());
      const organizationId = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-topic-organization-identity.v1",
        runId: options.runId,
        scopeFingerprint,
        sourceWriteId: settlement.writeId,
        sourceProposalHash: settlement.proposalHash,
        sourceMemoryIds,
        sourceRevision: prepared.sourceRevision,
        policyVersion: MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1,
        extractorVersion: options.extractor.extractorVersion,
      } as JsonValue);
      const claim: MemoryTopicOrganizationClaimedFactV1 = Object.freeze({
        type: "memory.topic_organization_claimed",
        organizationId,
        policyVersion: MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1,
        extractorVersion: options.extractor.extractorVersion,
        scopeFingerprint,
        sourceWriteId: settlement.writeId,
        sourceProposalHash: settlement.proposalHash,
        sourceMemoryIds,
        sourceRevision: prepared.sourceRevision,
        claimedAt: now(),
      });
      const claimStarted = now();
      const claimed = await commitUniqueTopicFactV1({
        initialSnapshot: await readSnapshot(),
        fact: claim,
        readSnapshot,
        commitFacts,
      });
      emit(options.onEvent, {
        schemaVersion: "paw.memory-topic-organizer-event.v1",
        type: "claim",
        organizationId,
        sourceWriteId: settlement.writeId,
        sourceRevision: prepared.sourceRevision,
        durationMs: Math.max(0, now() - claimStarted),
      });
      if (!claimed || options.signal.aborted) {
        return recoverUnsettledOrganizationV1({
          options,
          readSnapshot,
          commitFacts,
          now,
        });
      }

      try {
        const proposals = await options.extractor.extract(
          {
            scope: options.scope,
            sourceRevision: prepared.sourceRevision,
            entries: prepared.entries,
            existingTopics: prepared.existingTopics,
            maxTopics,
          },
          options.signal,
        );
        const proposalHash = hashCanonicalJsonV1(
          proposals as unknown as JsonValue,
        );
        const staged: MemoryTopicCandidateStagedFactV1 = Object.freeze({
          type: "memory.topic_candidate_staged",
          organizationId,
          proposalHash,
          topics: Object.freeze([...proposals]),
        });
        const stageStarted = now();
        await commitUniqueTopicFactV1({
          initialSnapshot: await readSnapshot(),
          fact: staged,
          readSnapshot,
          commitFacts,
        });
        emit(options.onEvent, {
          schemaVersion: "paw.memory-topic-organizer-event.v1",
          type: "stage",
          organizationId,
          proposalHash,
          topicCount: proposals.length,
          durationMs: Math.max(0, now() - stageStarted),
        });
        return applyStagedOrganizationV1({
          claim,
          staged,
          options,
          readSnapshot,
          commitFacts,
          now,
        });
      } catch (error) {
        return settleTopicFailureV1({
          claim,
          status: options.signal.aborted ? "interrupted" : "failed",
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

async function recoverUnsettledOrganizationV1(
  input: Readonly<{
    options: MemoryTopicOrganizerControllerOptionsV1;
    readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
    commitFacts: MemoryTopicOrganizerControllerOptionsV1["session"]["commitInputFacts"];
    now: () => number;
  }>,
): Promise<MemoryTopicOrganizationSettledFactV1 | undefined> {
  const snapshot = await input.readSnapshot();
  for (const entry of snapshot.entries) {
    if (entry.fact.type !== "memory.topic_organization_claimed") continue;
    const claim = entry.fact;
    const settled = snapshot.entries.some(
      (candidate) =>
        candidate.fact.type === "memory.topic_organization_settled" &&
        candidate.fact.organizationId === claim.organizationId,
    );
    if (settled) continue;
    const staged = snapshot.entries.find(
      (candidate) =>
        candidate.fact.type === "memory.topic_candidate_staged" &&
        candidate.fact.organizationId === claim.organizationId,
    );
    if (staged?.fact.type === "memory.topic_candidate_staged") {
      return applyStagedOrganizationV1({
        claim,
        staged: staged.fact,
        options: input.options,
        readSnapshot: input.readSnapshot,
        commitFacts: input.commitFacts,
        now: input.now,
      });
    }
    return settleTopicFailureV1({
      claim,
      status: "interrupted",
      reasonCode: "memory_topic_claim_interrupted_before_stage",
      readSnapshot: input.readSnapshot,
      commitFacts: input.commitFacts,
      now: input.now,
      onEvent: input.options.onEvent,
    });
  }
  return undefined;
}

async function applyStagedOrganizationV1(
  input: Readonly<{
    claim: MemoryTopicOrganizationClaimedFactV1;
    staged: MemoryTopicCandidateStagedFactV1;
    options: MemoryTopicOrganizerControllerOptionsV1;
    readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
    commitFacts: MemoryTopicOrganizerControllerOptionsV1["session"]["commitInputFacts"];
    now: () => number;
  }>,
): Promise<MemoryTopicOrganizationSettledFactV1> {
  const started = input.now();
  try {
    const result = await input.options.store.apply(
      {
        organizationId: input.claim.organizationId,
        scope: input.options.scope,
        claimedAt: input.claim.claimedAt,
        proposals: input.staged.topics,
      },
      input.options.signal,
    );
    if (
      result.topicIds.length !== result.snapshotIds.length ||
      result.topicIds.length !== input.staged.topics.length
    ) {
      throw new Error("Memory topic apply result is inconsistent");
    }
    emit(input.options.onEvent, {
      schemaVersion: "paw.memory-topic-organizer-event.v1",
      type: "apply",
      organizationId: input.claim.organizationId,
      proposalHash: input.staged.proposalHash,
      topicCount: result.topicIds.length,
      durationMs: Math.max(0, input.now() - started),
    });
    const settlement: MemoryTopicOrganizationSettledFactV1 = Object.freeze({
      type: "memory.topic_organization_settled",
      organizationId: input.claim.organizationId,
      status: input.staged.topics.length === 0 ? "noop" : "completed",
      proposalHash: input.staged.proposalHash,
      topicIds: Object.freeze([...result.topicIds]),
      snapshotIds: Object.freeze([...result.snapshotIds]),
      settledAt: input.now(),
    });
    await commitUniqueTopicFactV1({
      initialSnapshot: await input.readSnapshot(),
      fact: settlement,
      readSnapshot: input.readSnapshot,
      commitFacts: input.commitFacts,
    });
    emit(input.options.onEvent, {
      schemaVersion: "paw.memory-topic-organizer-event.v1",
      type: "settle",
      organizationId: input.claim.organizationId,
      proposalHash: input.staged.proposalHash,
      topicCount: result.topicIds.length,
      status: settlement.status,
      durationMs: Math.max(0, input.now() - started),
    });
    return settlement;
  } catch (error) {
    return settleTopicFailureV1({
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

async function settleTopicFailureV1(
  input: Readonly<{
    claim: MemoryTopicOrganizationClaimedFactV1;
    staged?: MemoryTopicCandidateStagedFactV1;
    status: "failed" | "interrupted";
    reasonCode: string;
    readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
    commitFacts: MemoryTopicOrganizerControllerOptionsV1["session"]["commitInputFacts"];
    now: () => number;
    onEvent?: (event: MemoryTopicOrganizerEventV1) => void;
  }>,
): Promise<MemoryTopicOrganizationSettledFactV1> {
  const settlement: MemoryTopicOrganizationSettledFactV1 = Object.freeze({
    type: "memory.topic_organization_settled",
    organizationId: input.claim.organizationId,
    status: input.status,
    ...(input.staged ? { proposalHash: input.staged.proposalHash } : {}),
    topicIds: Object.freeze([]),
    snapshotIds: Object.freeze([]),
    reasonCode: input.reasonCode,
    settledAt: input.now(),
  });
  await commitUniqueTopicFactV1({
    initialSnapshot: await input.readSnapshot(),
    fact: settlement,
    readSnapshot: input.readSnapshot,
    commitFacts: input.commitFacts,
  });
  emit(input.onEvent, {
    schemaVersion: "paw.memory-topic-organizer-event.v1",
    type: "settle",
    organizationId: input.claim.organizationId,
    ...(input.staged ? { proposalHash: input.staged.proposalHash } : {}),
    status: input.status,
    reasonCode: input.reasonCode,
    durationMs: 0,
  });
  return settlement;
}

type TopicJournalFactV1 =
  | MemoryTopicOrganizationClaimedFactV1
  | MemoryTopicCandidateStagedFactV1
  | MemoryTopicOrganizationSettledFactV1;

async function commitUniqueTopicFactV1(
  input: Readonly<{
    initialSnapshot: SessionInputSnapshot<InputFactV1>;
    fact: TopicJournalFactV1;
    readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
    commitFacts: MemoryTopicOrganizerControllerOptionsV1["session"]["commitInputFacts"];
  }>,
): Promise<boolean> {
  let snapshot = input.initialSnapshot;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (hasEquivalentTopicFact(snapshot, input.fact)) return false;
    if (
      (await input.commitFacts(snapshot.tailSeq, [input.fact])) === "committed"
    ) {
      return true;
    }
    snapshot = await input.readSnapshot();
  }
  throw new Error("Memory topic journal commit conflict");
}

function hasEquivalentTopicFact(
  snapshot: SessionInputSnapshot<InputFactV1>,
  fact: TopicJournalFactV1,
): boolean {
  return snapshot.entries.some((entry) => {
    if (entry.fact.type !== fact.type) return false;
    if (
      entry.fact.type === "memory.topic_organization_claimed" &&
      fact.type === "memory.topic_organization_claimed"
    ) {
      return entry.fact.organizationId === fact.organizationId;
    }
    if (
      entry.fact.type === "memory.topic_candidate_staged" &&
      fact.type === "memory.topic_candidate_staged"
    ) {
      return entry.fact.organizationId === fact.organizationId;
    }
    return (
      entry.fact.type === "memory.topic_organization_settled" &&
      fact.type === "memory.topic_organization_settled" &&
      entry.fact.organizationId === fact.organizationId
    );
  });
}

function stableReasonCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return (
    `MemoryTopicOrganizer_${name}`
      .replace(/[^A-Za-z0-9_.:-]/g, "_")
      .slice(0, 160) || "MemoryTopicOrganizer_Unknown"
  );
}

function emit(
  observer: ((event: MemoryTopicOrganizerEventV1) => void) | undefined,
  event: MemoryTopicOrganizerEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Caller-owned telemetry never changes organization semantics.
  }
}
