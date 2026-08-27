import type {
  LoopInputPort,
  LoopSafeBoundary,
  Session,
  SessionInputSnapshot,
} from "@paw/agent-loop";
import {
  type DerivedDecisionV1,
  type InputFactV1,
  MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1,
  type MemoryEvidenceCoverageSettledFactV1,
} from "@paw/protocol";

import {
  type MemoryEvidenceCoveragePlannerV1,
  planMemoryEvidenceCoverageV1,
} from "./evidence-coverage-planner.js";
import type { PawNextMemoryPluginProfileV1 } from "./profile.js";
import { memoryScopeFingerprintV1 } from "./profile.js";
import type { MemoryRawEvidenceArchiveV1 } from "./raw-evidence-archive.js";
import { projectCurrentMemoryQueryV1 } from "./retrieval-input-port.js";
import type { MemoryTopicEvidenceStoreV1 } from "./topic-evidence-store.js";

export interface MemoryEvidenceCoverageEventV1 {
  readonly schemaVersion: "paw.memory-evidence-coverage-event.v1";
  readonly type: "plan" | "commit" | "skip";
  readonly queryId?: string;
  readonly planRevision?: string;
  readonly requirementCount?: number;
  readonly coveredCount?: number;
  readonly partialCount?: number;
  readonly missingCount?: number;
  readonly expansionTopicCount?: number;
  readonly supplementalStateCount?: number;
  readonly spanCount?: number;
  readonly contentChars?: number;
  readonly status?: MemoryEvidenceCoverageSettledFactV1["status"];
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export interface MemoryEvidenceCoverageInputPortOptionsV1 {
  readonly baseInput: LoopInputPort;
  readonly session: Pick<
    Session<InputFactV1, DerivedDecisionV1>,
    "readInputSnapshot" | "commitInputFacts"
  >;
  readonly profile: PawNextMemoryPluginProfileV1;
  readonly topicStore: MemoryTopicEvidenceStoreV1;
  readonly archive: MemoryRawEvidenceArchiveV1;
  readonly planner: MemoryEvidenceCoveragePlannerV1;
  readonly signal: AbortSignal;
  readonly maxRequirements: number;
  readonly maxExpansionTopics: number;
  readonly maxSupplementalStates: number;
  readonly maxSupplementalChars: number;
  readonly maxRawSpans: number;
  readonly maxRawChars: number;
  readonly now?: () => number;
  readonly onEvent?: (event: MemoryEvidenceCoverageEventV1) => void;
}

/** Runs after L1/L2/L3 and L0 receipts, before the base safe boundary. */
export function createMemoryEvidenceCoverageInputPortV1(
  options: MemoryEvidenceCoverageInputPortOptionsV1,
): LoopInputPort {
  const report = options.baseInput.reportSafeBoundary.bind(options.baseInput);
  const consume = options.baseInput.consumePromotedInputIds.bind(
    options.baseInput,
  );
  const readSnapshot = options.session.readInputSnapshot.bind(options.session);
  const commitFacts = options.session.commitInputFacts.bind(options.session);
  const now = options.now ?? Date.now;
  assertExactScope(options.topicStore.scope, options.profile.scope);
  assertExactScope(options.archive.scope, options.profile.scope);
  return Object.freeze({
    async reportSafeBoundary(boundary: LoopSafeBoundary) {
      const started = now();
      try {
        if (!options.signal.aborted && options.profile.mode === "read_write") {
          const snapshot = await readSnapshot();
          const query = projectCurrentMemoryQueryV1(snapshot, options.profile);
          if (
            query &&
            hasPriorEvidence(snapshot, query.queryId) &&
            !hasCoverage(snapshot, query.queryId)
          ) {
            const fact = await settleCoverage({
              snapshot,
              queryId: query.queryId,
              query: query.text,
              options,
              now,
            });
            if (!options.signal.aborted) {
              await commitUniqueCoverage({
                initialSnapshot: snapshot,
                fact,
                readSnapshot,
                commitFacts,
              });
              emit(
                options.onEvent,
                eventFromFact("commit", fact, now() - started),
              );
            }
          }
        }
      } catch (error) {
        emit(options.onEvent, {
          schemaVersion: "paw.memory-evidence-coverage-event.v1",
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

async function settleCoverage(
  input: Readonly<{
    snapshot: SessionInputSnapshot<InputFactV1>;
    queryId: string;
    query: string;
    options: MemoryEvidenceCoverageInputPortOptionsV1;
    now: () => number;
  }>,
): Promise<MemoryEvidenceCoverageSettledFactV1> {
  const started = input.now();
  try {
    const catalog = await input.options.topicStore.load(input.options.signal);
    const plan = await planMemoryEvidenceCoverageV1({
      queryId: input.queryId,
      query: input.query,
      scopeFingerprint: memoryScopeFingerprintV1(input.options.profile.scope),
      snapshot: input.snapshot,
      catalog,
      archive: input.options.archive,
      planner: input.options.planner,
      maxRequirements: input.options.maxRequirements,
      maxExpansionTopics: input.options.maxExpansionTopics,
      maxSupplementalStates: input.options.maxSupplementalStates,
      maxSupplementalChars: input.options.maxSupplementalChars,
      maxRawSpans: input.options.maxRawSpans,
      maxRawChars: input.options.maxRawChars,
      signal: input.options.signal,
    });
    const completed = plan.requirements.length > 0;
    const fact = Object.freeze({
      type: "memory.evidence_coverage_settled" as const,
      queryId: input.queryId,
      plannerVersion: MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.options.profile.scope),
      status: completed ? ("completed" as const) : ("noop" as const),
      planRevision: plan.planRevision,
      requirements: plan.requirements,
      coverage: plan.coverage,
      supplementalStates: plan.supplementalStates,
      spans: plan.spans,
      ...(completed
        ? {}
        : { reasonCode: "memory_evidence_coverage_not_needed" }),
      settledAt: input.now(),
    });
    emit(
      input.options.onEvent,
      eventFromFact("plan", fact, input.now() - started),
    );
    return fact;
  } catch (error) {
    return Object.freeze({
      type: "memory.evidence_coverage_settled",
      queryId: input.queryId,
      plannerVersion: MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.options.profile.scope),
      status: "failed",
      planRevision: "memory-evidence-coverage-unavailable",
      requirements: Object.freeze([]),
      coverage: Object.freeze([]),
      supplementalStates: Object.freeze([]),
      spans: Object.freeze([]),
      reasonCode: stableReasonCode(error),
      settledAt: input.now(),
    });
  }
}

function eventFromFact(
  type: "plan" | "commit",
  fact: MemoryEvidenceCoverageSettledFactV1,
  durationMs: number,
): MemoryEvidenceCoverageEventV1 {
  const topics = new Set(fact.coverage.flatMap((item) => item.topicIds));
  return Object.freeze({
    schemaVersion: "paw.memory-evidence-coverage-event.v1",
    type,
    queryId: fact.queryId,
    planRevision: fact.planRevision,
    requirementCount: fact.requirements.length,
    coveredCount: fact.coverage.filter((item) => item.status === "covered")
      .length,
    partialCount: fact.coverage.filter((item) => item.status === "partial")
      .length,
    missingCount: fact.coverage.filter((item) => item.status === "missing")
      .length,
    expansionTopicCount: topics.size,
    supplementalStateCount: fact.supplementalStates.length,
    spanCount: fact.spans.length,
    contentChars: fact.spans.reduce(
      (sum, span) => sum + span.content.length,
      0,
    ),
    status: fact.status,
    durationMs: Math.max(0, durationMs),
  });
}

async function commitUniqueCoverage(
  input: Readonly<{
    initialSnapshot: SessionInputSnapshot<InputFactV1>;
    fact: MemoryEvidenceCoverageSettledFactV1;
    readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
    commitFacts: MemoryEvidenceCoverageInputPortOptionsV1["session"]["commitInputFacts"];
  }>,
): Promise<void> {
  let snapshot = input.initialSnapshot;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (hasCoverage(snapshot, input.fact.queryId)) return;
    if (
      (await input.commitFacts(snapshot.tailSeq, [input.fact])) === "committed"
    ) {
      return;
    }
    snapshot = await input.readSnapshot();
  }
  throw new Error("Memory evidence coverage journal commit conflict");
}

function hasPriorEvidence(
  snapshot: SessionInputSnapshot<InputFactV1>,
  queryId: string,
): boolean {
  let topic = false;
  let raw = false;
  for (const entry of snapshot.entries) {
    if (
      entry.fact.type === "memory.topic_evidence_settled" &&
      entry.fact.queryId === queryId
    ) {
      topic = true;
    }
    if (
      entry.fact.type === "memory.raw_evidence_settled" &&
      entry.fact.queryId === queryId
    ) {
      raw = true;
    }
  }
  return topic && raw;
}

function hasCoverage(
  snapshot: SessionInputSnapshot<InputFactV1>,
  queryId: string,
): boolean {
  return snapshot.entries.some(
    (entry) =>
      entry.fact.type === "memory.evidence_coverage_settled" &&
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
    throw new Error("Memory evidence coverage scope mismatch");
  }
}

function stableReasonCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return (
    `MemoryEvidenceCoverage_${name}`
      .replace(/[^A-Za-z0-9_.:-]/g, "_")
      .slice(0, 160) || "MemoryEvidenceCoverage_Unknown"
  );
}

function emit(
  observer: ((event: MemoryEvidenceCoverageEventV1) => void) | undefined,
  event: MemoryEvidenceCoverageEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Content-free observability cannot affect evidence planning.
  }
}
