import type {
  LoopInputPort,
  LoopSafeBoundary,
  Session,
  SessionInputSnapshot,
} from "@paw/agent-loop";
import {
  type DerivedDecisionV1,
  type InputFactV1,
  MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
  type MemoryPersonaProjectionSettledFactV1,
} from "@paw/protocol";

import {
  type MemoryPersonaEvidenceProjectionV1,
  projectMemoryPersonaEvidenceV1,
} from "./persona-evidence-projector.js";
import type { MemoryPersonaStoreV1 } from "./persona-store.js";
import type { PawNextMemoryPluginProfileV1 } from "./profile.js";
import { memoryScopeFingerprintV1 } from "./profile.js";
import { projectCurrentMemoryQueryV1 } from "./retrieval-input-port.js";

export interface MemoryPersonaEventV1 {
  readonly schemaVersion: "paw.memory-persona-event.v1";
  readonly type: "project" | "commit" | "skip";
  readonly queryId?: string;
  readonly projectionRevision?: string;
  readonly projectionKey?: string;
  readonly claimCount?: number;
  readonly sourceCount?: number;
  readonly status?: MemoryPersonaProjectionSettledFactV1["status"];
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export interface MemoryPersonaInputPortOptionsV1 {
  readonly baseInput: LoopInputPort;
  readonly session: Pick<
    Session<InputFactV1, DerivedDecisionV1>,
    "readInputSnapshot" | "commitInputFacts"
  >;
  readonly profile: PawNextMemoryPluginProfileV1;
  readonly store: MemoryPersonaStoreV1;
  readonly signal: AbortSignal;
  readonly maxClaims: number;
  readonly maxChars: number;
  readonly minimumConfidence: number;
  readonly now?: () => number;
  readonly onEvent?: (event: MemoryPersonaEventV1) => void;
}

/** Safe-boundary middleware: stable L3 persona becomes durable before Context. */
export function createMemoryPersonaInputPortV1(
  options: MemoryPersonaInputPortOptionsV1,
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
            !hasProjection(snapshot, query.queryId)
          ) {
            const fact = await settleProjectionV1({
              queryId: query.queryId,
              options,
              now,
            });
            if (!options.signal.aborted) {
              await commitUniqueProjectionFactV1({
                initialSnapshot: snapshot,
                fact,
                readSnapshot,
                commitFacts,
              });
              emit(options.onEvent, {
                schemaVersion: "paw.memory-persona-event.v1",
                type: "commit",
                queryId: fact.queryId,
                projectionRevision: fact.projectionRevision,
                projectionKey: fact.projectionKey,
                claimCount: fact.claims.length,
                sourceCount: fact.sourceCount,
                status: fact.status,
                durationMs: Math.max(0, now() - started),
              });
            }
          }
        }
      } catch (error) {
        emit(options.onEvent, {
          schemaVersion: "paw.memory-persona-event.v1",
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

async function settleProjectionV1(
  input: Readonly<{
    queryId: string;
    options: MemoryPersonaInputPortOptionsV1;
    now: () => number;
  }>,
): Promise<MemoryPersonaProjectionSettledFactV1> {
  const started = input.now();
  try {
    const entries = await input.options.store.load(input.options.signal);
    const projection = projectMemoryPersonaEvidenceV1({
      entries,
      minimumConfidence: input.options.minimumConfidence,
      maxClaims: input.options.maxClaims,
      maxChars: input.options.maxChars,
    });
    const fact = projectionFact(
      input.queryId,
      projection,
      input.now(),
      input.options.profile,
    );
    emit(input.options.onEvent, {
      schemaVersion: "paw.memory-persona-event.v1",
      type: "project",
      queryId: input.queryId,
      projectionRevision: projection.projectionRevision,
      projectionKey: projection.projectionKey,
      claimCount: projection.claims.length,
      sourceCount: projection.sourceCount,
      status: fact.status,
      durationMs: Math.max(0, input.now() - started),
    });
    return fact;
  } catch (error) {
    return Object.freeze({
      type: "memory.persona_projection_settled",
      queryId: input.queryId,
      projectorVersion: MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.options.profile.scope),
      status: "failed",
      projectionRevision: "memory-persona-projection-unavailable",
      projectionKey: "memory-persona-projection-unavailable",
      claims: Object.freeze([]),
      sourceCount: 0,
      reasonCode: stableReasonCode(error),
      settledAt: input.now(),
    });
  }
}

function projectionFact(
  queryId: string,
  projection: MemoryPersonaEvidenceProjectionV1,
  settledAt: number,
  profile: PawNextMemoryPluginProfileV1,
): MemoryPersonaProjectionSettledFactV1 {
  const completed = projection.claims.length > 0;
  return Object.freeze({
    type: "memory.persona_projection_settled",
    queryId,
    projectorVersion: MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
    scopeFingerprint: memoryScopeFingerprintV1(profile.scope),
    status: completed ? "completed" : "noop",
    projectionRevision: projection.projectionRevision,
    projectionKey: projection.projectionKey,
    claims: projection.claims,
    sourceCount: completed ? projection.sourceCount : 0,
    ...(completed ? {} : { reasonCode: "memory_persona_no_eligible_claims" }),
    settledAt,
  });
}

async function commitUniqueProjectionFactV1(
  input: Readonly<{
    initialSnapshot: SessionInputSnapshot<InputFactV1>;
    fact: MemoryPersonaProjectionSettledFactV1;
    readSnapshot: () => Promise<SessionInputSnapshot<InputFactV1>>;
    commitFacts: MemoryPersonaInputPortOptionsV1["session"]["commitInputFacts"];
  }>,
): Promise<void> {
  let snapshot = input.initialSnapshot;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (hasProjection(snapshot, input.fact.queryId)) return;
    if (
      (await input.commitFacts(snapshot.tailSeq, [input.fact])) === "committed"
    ) {
      return;
    }
    snapshot = await input.readSnapshot();
  }
  throw new Error("Memory persona projection journal commit conflict");
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

function hasProjection(
  snapshot: SessionInputSnapshot<InputFactV1>,
  queryId: string,
): boolean {
  return snapshot.entries.some(
    (entry) =>
      entry.fact.type === "memory.persona_projection_settled" &&
      entry.fact.queryId === queryId,
  );
}

function assertExactScope(
  actual: MemoryPersonaStoreV1["scope"],
  expected: PawNextMemoryPluginProfileV1["scope"],
): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.userId !== expected.userId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId
  ) {
    throw new Error("Memory persona store scope mismatch");
  }
}

function stableReasonCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return (
    `MemoryPersona_${name}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160) ||
    "MemoryPersona_Unknown"
  );
}

function emit(
  observer: ((event: MemoryPersonaEventV1) => void) | undefined,
  event: MemoryPersonaEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Content-free observability cannot change projection semantics.
  }
}
