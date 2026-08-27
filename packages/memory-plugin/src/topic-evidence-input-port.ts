import type {
  LoopInputPort,
  LoopSafeBoundary,
  Session,
  SessionInputSnapshot,
} from "@paw/agent-loop";
import {
  type DerivedDecisionV1,
  type InputFactV1,
  MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
  type MemoryTopicEvidenceSettledFactV1,
} from "@paw/protocol";

import type { PawNextMemoryPluginProfileV1 } from "./profile.js";
import { memoryScopeFingerprintV1 } from "./profile.js";
import { projectCurrentMemoryQueryV1 } from "./retrieval-input-port.js";
import {
  type MemoryTopicEvidencePlanV1,
  planMemoryTopicEvidenceV1,
} from "./topic-evidence-planner.js";
import type { MemoryTopicEvidenceStoreV1 } from "./topic-evidence-store.js";

export interface MemoryTopicEvidenceEventV1 {
  readonly schemaVersion: "paw.memory-topic-evidence-event.v1";
  readonly type: "plan" | "commit" | "skip";
  readonly queryId?: string;
  readonly indexRevision?: string;
  readonly indexCount?: number;
  readonly selectedStateCount?: number;
  readonly status?: MemoryTopicEvidenceSettledFactV1["status"];
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export interface MemoryTopicEvidenceInputPortOptionsV1 {
  readonly baseInput: LoopInputPort;
  readonly session: Pick<
    Session<InputFactV1, DerivedDecisionV1>,
    "readInputSnapshot" | "commitInputFacts"
  >;
  readonly profile: PawNextMemoryPluginProfileV1;
  readonly store: MemoryTopicEvidenceStoreV1;
  readonly signal: AbortSignal;
  readonly maxIndexTopics: number;
  readonly maxSelectedTopics: number;
  readonly maxStates: number;
  readonly maxEvidenceChars: number;
  readonly now?: () => number;
  readonly onEvent?: (event: MemoryTopicEvidenceEventV1) => void;
}

/** Safe-boundary middleware: database evidence becomes durable before Context. */
export function createMemoryTopicEvidenceInputPortV1(
  options: MemoryTopicEvidenceInputPortOptionsV1,
): LoopInputPort {
  const report = options.baseInput.reportSafeBoundary.bind(options.baseInput);
  const consume = options.baseInput.consumePromotedInputIds.bind(
    options.baseInput,
  );
  const readSnapshot = options.session.readInputSnapshot.bind(options.session);
  const commitFacts = options.session.commitInputFacts.bind(options.session);
  const now = options.now ?? Date.now;
  assertExactScope(options.store.scope, options.profile.scope);
  return Object.freeze({
    async reportSafeBoundary(boundary: LoopSafeBoundary) {
      const started = now();
      try {
        if (!options.signal.aborted && options.profile.mode === "read_write") {
          const snapshot = await readSnapshot();
          const query = projectCurrentMemoryQueryV1(snapshot, options.profile);
          if (
            query &&
            hasRetrieval(snapshot, query.queryId) &&
            !hasPlan(snapshot, query.queryId)
          ) {
            const fact = await settleEvidencePlanV1({
              queryId: query.queryId,
              query: query.text,
              options,
              now,
            });
            if (!options.signal.aborted) {
              await commitUniqueEvidenceFactV1({
                initialSnapshot: snapshot,
                fact,
                readSnapshot,
                commitFacts,
              });
              emit(options.onEvent, {
                schemaVersion: "paw.memory-topic-evidence-event.v1",
                type: "commit",
                queryId: fact.queryId,
                indexRevision: fact.indexRevision,
                indexCount: fact.indexEntries.length,
                selectedStateCount: fact.evidenceStates.length,
                status: fact.status,
                durationMs: Math.max(0, now() - started),
              });
            }
          }
        }
      } catch (error) {
        emit(options.onEvent, {
          schemaVersion: "paw.memory-topic-evidence-event.v1",
          type: "skip",
          reasonCode: stableReasonCode(error),
          durationMs: Math.max(0, now() - started),
        });
      }
      await report(boundary);
    },
    consumePromotedInputIds: consume,
  });
}

async function settleEvidencePlanV1(
  input: Readonly<{
    queryId: string;
    query: string;
    options: MemoryTopicEvidenceInputPortOptionsV1;
    now: () => number;
  }>,
): Promise<MemoryTopicEvidenceSettledFactV1> {
  const started = input.now();
  try {
    const catalog = await input.options.store.load(input.options.signal);
    const plan = planMemoryTopicEvidenceV1({
      query: input.query,
      scopeFingerprint: memoryScopeFingerprintV1(input.options.profile.scope),
      catalog,
      maxIndexTopics: input.options.maxIndexTopics,
      maxSelectedTopics: input.options.maxSelectedTopics,
      maxStates: input.options.maxStates,
      maxEvidenceChars: input.options.maxEvidenceChars,
    });
    const fact = planFact(input.queryId, plan, input.now());
    emit(input.options.onEvent, {
      schemaVersion: "paw.memory-topic-evidence-event.v1",
      type: "plan",
      queryId: input.queryId,
      indexRevision: plan.indexRevision,
      indexCount: plan.indexEntries.length,
      selectedStateCount: plan.evidenceStates.length,
      status: fact.status,
      durationMs: Math.max(0, input.now() - started),
    });
    return fact;
  } catch (error) {
    const reasonCode = stableReasonCode(error);
    return Object.freeze({
      type: "memory.topic_evidence_settled",
      queryId: input.queryId,
      plannerVersion: MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.options.profile.scope),
      status: "failed",
      indexRevision: "memory-topic-index-unavailable",
      indexEntries: Object.freeze([]),
      evidenceStates: Object.freeze([]),
      reasonCode,
      settledAt: input.now(),
    });
  }
}

function planFact(
  queryId: string,
  plan: MemoryTopicEvidencePlanV1,
  settledAt: number,
): MemoryTopicEvidenceSettledFactV1 {
  const completed = plan.evidenceStates.length > 0;
  return Object.freeze({
    type: "memory.topic_evidence_settled",
    queryId,
    plannerVersion: MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
    scopeFingerprint: plan.scopeFingerprint,
    status: completed ? "completed" : "noop",
    indexRevision: plan.indexRevision,
    indexEntries: plan.indexEntries,
    evidenceStates: plan.evidenceStates,
    ...(completed ? {} : { reasonCode: "memory_topic_no_matching_evidence" }),
    settledAt,
  });
}

async function commitUniqueEvidenceFactV1(
  input: Readonly<{
    initialSnapshot: SessionInputSnapshot<InputFactV1>;
    fact: MemoryTopicEvidenceSettledFactV1;
    readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
    commitFacts: MemoryTopicEvidenceInputPortOptionsV1["session"]["commitInputFacts"];
  }>,
): Promise<void> {
  let snapshot = input.initialSnapshot;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (hasPlan(snapshot, input.fact.queryId)) return;
    if (
      (await input.commitFacts(snapshot.tailSeq, [input.fact])) === "committed"
    ) {
      return;
    }
    snapshot = await input.readSnapshot();
  }
  throw new Error("Memory topic evidence journal commit conflict");
}

function hasRetrieval(
  snapshot: SessionInputSnapshot<InputFactV1>,
  queryId: string,
): boolean {
  return snapshot.entries.some(
    (entry) =>
      entry.fact.type === "memory.retrieval_settled" &&
      entry.fact.queryId === queryId,
  );
}

function hasPlan(
  snapshot: SessionInputSnapshot<InputFactV1>,
  queryId: string,
): boolean {
  return snapshot.entries.some(
    (entry) =>
      entry.fact.type === "memory.topic_evidence_settled" &&
      entry.fact.queryId === queryId,
  );
}

function assertExactScope(
  actual: MemoryTopicEvidenceStoreV1["scope"],
  expected: PawNextMemoryPluginProfileV1["scope"],
): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.userId !== expected.userId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId
  ) {
    throw new Error("Memory topic evidence store scope mismatch");
  }
}

function stableReasonCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return (
    `MemoryTopicEvidence_${name}`
      .replace(/[^A-Za-z0-9_.:-]/g, "_")
      .slice(0, 160) || "MemoryTopicEvidence_Unknown"
  );
}

function emit(
  observer: ((event: MemoryTopicEvidenceEventV1) => void) | undefined,
  event: MemoryTopicEvidenceEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Content-free observability cannot change planning semantics.
  }
}
