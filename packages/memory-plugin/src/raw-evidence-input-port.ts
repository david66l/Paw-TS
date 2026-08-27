import type {
  LoopInputPort,
  LoopSafeBoundary,
  Session,
  SessionInputSnapshot,
} from "@paw/agent-loop";
import {
  type DerivedDecisionV1,
  type InputFactV1,
  MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
  type MemoryRawEvidenceSettledFactV1,
} from "@paw/protocol";

import type { PawNextMemoryPluginProfileV1 } from "./profile.js";
import { memoryScopeFingerprintV1 } from "./profile.js";
import type { MemoryRawEvidenceArchiveV1 } from "./raw-evidence-archive.js";
import { resolveMemoryRawEvidenceV1 } from "./raw-evidence-resolver.js";
import { projectCurrentMemoryQueryV1 } from "./retrieval-input-port.js";

export interface MemoryRawEvidenceEventV1 {
  readonly schemaVersion: "paw.memory-raw-evidence-event.v1";
  readonly type: "resolve" | "commit" | "skip";
  readonly queryId?: string;
  readonly resolutionRevision?: string;
  readonly spanCount?: number;
  readonly contentChars?: number;
  readonly status?: MemoryRawEvidenceSettledFactV1["status"];
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export interface MemoryRawEvidenceInputPortOptionsV1 {
  readonly baseInput: LoopInputPort;
  readonly session: Pick<
    Session<InputFactV1, DerivedDecisionV1>,
    "readInputSnapshot" | "commitInputFacts"
  >;
  readonly profile: PawNextMemoryPluginProfileV1;
  readonly archive: MemoryRawEvidenceArchiveV1;
  readonly signal: AbortSignal;
  readonly maxSpans: number;
  readonly maxChars: number;
  readonly now?: () => number;
  readonly onEvent?: (event: MemoryRawEvidenceEventV1) => void;
}

export function createMemoryRawEvidenceInputPortV1(
  options: MemoryRawEvidenceInputPortOptionsV1,
): LoopInputPort {
  const report = options.baseInput.reportSafeBoundary.bind(options.baseInput);
  const consume = options.baseInput.consumePromotedInputIds.bind(
    options.baseInput,
  );
  const readSnapshot = options.session.readInputSnapshot.bind(options.session);
  const commitFacts = options.session.commitInputFacts.bind(options.session);
  const now = options.now ?? Date.now;
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
            hasRetrieval(snapshot, query.queryId) &&
            !hasResolution(snapshot, query.queryId)
          ) {
            const fact = await settleResolution({
              snapshot,
              queryId: query.queryId,
              options,
              now,
            });
            if (!options.signal.aborted) {
              await commitUniqueResolution({
                initialSnapshot: snapshot,
                fact,
                readSnapshot,
                commitFacts,
              });
              emit(options.onEvent, {
                schemaVersion: "paw.memory-raw-evidence-event.v1",
                type: "commit",
                queryId: fact.queryId,
                resolutionRevision: fact.resolutionRevision,
                spanCount: fact.spans.length,
                contentChars: fact.spans.reduce(
                  (total, span) => total + span.content.length,
                  0,
                ),
                status: fact.status,
                durationMs: Math.max(0, now() - started),
              });
            }
          }
        }
      } catch (error) {
        emit(options.onEvent, {
          schemaVersion: "paw.memory-raw-evidence-event.v1",
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

async function settleResolution(
  input: Readonly<{
    snapshot: SessionInputSnapshot<InputFactV1>;
    queryId: string;
    options: MemoryRawEvidenceInputPortOptionsV1;
    now: () => number;
  }>,
): Promise<MemoryRawEvidenceSettledFactV1> {
  const started = input.now();
  try {
    const resolution = await resolveMemoryRawEvidenceV1({
      snapshot: input.snapshot,
      queryId: input.queryId,
      archive: input.options.archive,
      maxSpans: input.options.maxSpans,
      maxChars: input.options.maxChars,
      signal: input.options.signal,
    });
    const completed = resolution.spans.length > 0;
    const fact = Object.freeze({
      type: "memory.raw_evidence_settled" as const,
      queryId: input.queryId,
      resolverVersion: MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.options.profile.scope),
      status: completed ? ("completed" as const) : ("noop" as const),
      resolutionRevision: resolution.resolutionRevision,
      spans: resolution.spans,
      ...(completed ? {} : { reasonCode: "memory_raw_evidence_not_archived" }),
      settledAt: input.now(),
    });
    emit(input.options.onEvent, {
      schemaVersion: "paw.memory-raw-evidence-event.v1",
      type: "resolve",
      queryId: input.queryId,
      resolutionRevision: fact.resolutionRevision,
      spanCount: fact.spans.length,
      contentChars: fact.spans.reduce(
        (total, span) => total + span.content.length,
        0,
      ),
      status: fact.status,
      durationMs: Math.max(0, input.now() - started),
    });
    return fact;
  } catch (error) {
    return Object.freeze({
      type: "memory.raw_evidence_settled",
      queryId: input.queryId,
      resolverVersion: MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.options.profile.scope),
      status: "failed",
      resolutionRevision: "memory-raw-evidence-unavailable",
      spans: Object.freeze([]),
      reasonCode: stableReasonCode(error),
      settledAt: input.now(),
    });
  }
}

async function commitUniqueResolution(
  input: Readonly<{
    initialSnapshot: SessionInputSnapshot<InputFactV1>;
    fact: MemoryRawEvidenceSettledFactV1;
    readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
    commitFacts: MemoryRawEvidenceInputPortOptionsV1["session"]["commitInputFacts"];
  }>,
): Promise<void> {
  let snapshot = input.initialSnapshot;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (hasResolution(snapshot, input.fact.queryId)) return;
    if (
      (await input.commitFacts(snapshot.tailSeq, [input.fact])) === "committed"
    ) {
      return;
    }
    snapshot = await input.readSnapshot();
  }
  throw new Error("Memory raw evidence journal commit conflict");
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

function hasResolution(
  snapshot: SessionInputSnapshot<InputFactV1>,
  queryId: string,
): boolean {
  return snapshot.entries.some(
    (entry) =>
      entry.fact.type === "memory.raw_evidence_settled" &&
      entry.fact.queryId === queryId,
  );
}

function assertExactScope(
  actual: MemoryRawEvidenceArchiveV1["scope"],
  expected: PawNextMemoryPluginProfileV1["scope"],
): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.userId !== expected.userId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId
  ) {
    throw new Error("Memory raw evidence archive scope mismatch");
  }
}

function stableReasonCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return (
    `MemoryRawEvidence_${name}`
      .replace(/[^A-Za-z0-9_.:-]/g, "_")
      .slice(0, 160) || "MemoryRawEvidence_Unknown"
  );
}

function emit(
  observer: ((event: MemoryRawEvidenceEventV1) => void) | undefined,
  event: MemoryRawEvidenceEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Content-free observability cannot affect evidence resolution.
  }
}
