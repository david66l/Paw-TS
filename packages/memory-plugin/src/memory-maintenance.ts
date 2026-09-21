import { createOperationDeadline } from "@paw/core";
import {
  createMemoryWriterControllerV1,
  type MemoryWriterControllerOptionsV1,
  type MemoryWriterControllerV1,
} from "./memory-writer.js";
import {
  createMemoryTopicOrganizerControllerV1,
  type MemoryTopicOrganizerControllerOptionsV1,
} from "./topic-organizer.js";
import { createMemoryTopicDossierProjectorV1 } from "./topic-dossier-projector.js";
import type { MemoryTopicEvidenceStoreV1 } from "./topic-evidence-store.js";

/** One terminal operation, not a fresh timeout for every model or topic. */
export const MEMORY_MAINTENANCE_DEADLINE_MS = 30_000;
export const MEMORY_MAINTENANCE_POLICY_VERSION_V1 =
  "paw.memory-maintenance.v1:shared-30s-deadline:staged-recovery" as const;

export interface MemoryMaintenanceOptionsV1 {
  readonly writer: Omit<MemoryWriterControllerOptionsV1, "signal">;
  readonly organizer: Omit<
    MemoryTopicOrganizerControllerOptionsV1,
    "signal" | "session" | "runId" | "scope"
  >;
  readonly dossier?: Parameters<typeof createMemoryTopicDossierProjectorV1>[0];
  readonly catalog?: MemoryTopicEvidenceStoreV1;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Runs while the owning session is open. This is deliberately not a background
 * queue: session ownership must be transferred durably before that is safe.
 * Each I/O port is gated, including journal reads/CAS and recovery writes, so a
 * dependency ignoring abort cannot resume the pipeline after the caller returns.
 * An already-started external write can still commit; staged IDs reconcile it.
 */
export function createMemoryMaintenanceControllerV1(
  input: MemoryMaintenanceOptionsV1,
): MemoryWriterControllerV1 {
  let archivedThroughSeq = 0;
  return {
    async settleTerminal(outcome) {
      const started = performance.now();
      const operation = createOperationDeadline(
        input.signal,
        input.timeoutMs ?? MEMORY_MAINTENANCE_DEADLINE_MS,
      );
      const session: MemoryWriterControllerOptionsV1["session"] = {
        readInputSnapshot: () =>
          operation.run(() => input.writer.session.readInputSnapshot()),
        commitInputFacts: (tail, facts) =>
          operation.run(() =>
            input.writer.session.commitInputFacts(tail, facts),
          ),
      };
      try {
        const writer = createMemoryWriterControllerV1({
          ...input.writer,
          session,
          signal: operation.signal,
          extractor: {
            extractorVersion: input.writer.extractor.extractorVersion,
            extract: (request) =>
              operation.run((signal) =>
                input.writer.extractor.extract(request, signal),
              ),
          },
          ...(input.writer.conflictResolver
            ? {
                conflictResolver: {
                  resolverVersion:
                    input.writer.conflictResolver.resolverVersion,
                  resolve: (request) =>
                    operation.run((signal) =>
                      input.writer.conflictResolver!.resolve(request, signal),
                    ),
                },
              }
            : {}),
          store: {
            recall: (query, limit) =>
              operation.run((signal) =>
                input.writer.store.recall(query, limit, signal),
              ),
            apply: (request) =>
              operation.run((signal) =>
                input.writer.store.apply(request, signal),
              ),
          },
          ...(input.writer.evidenceArchive
            ? {
                evidenceArchive: {
                  scope: input.writer.evidenceArchive.scope,
                  async put(spans) {
                    const fresh = spans.filter(
                      (span) => span.sourceSeq > archivedThroughSeq,
                    );
                    if (fresh.length === 0) return;
                    await operation.run((signal) =>
                      input.writer.evidenceArchive!.put(fresh, signal),
                    );
                    archivedThroughSeq = Math.max(
                      archivedThroughSeq,
                      ...fresh.map((span) => span.sourceSeq),
                    );
                  },
                  resolve: (requests) =>
                    operation.run((signal) =>
                      input.writer.evidenceArchive!.resolve(requests, signal),
                    ),
                },
              }
            : {}),
        });
        const settlement = await writer.settleTerminal(outcome);
        let source = settlement;
        if (!source) {
          const snapshot = await session.readInputSnapshot();
          for (let index = snapshot.entries.length - 1; index >= 0; index--) {
            const fact = snapshot.entries[index]?.fact;
            if (fact?.type === "memory.write_settled") {
              source = fact;
              break;
            }
          }
        }
        if (!source) return settlement;
        if (input.writer.retryFailedUnstaged) {
          // Background delivery may repeat. Topic writes change the catalog
          // revision themselves; that must not turn one source write into new
          // organization jobs every time its locator is delivered again.
          const facts = (await session.readInputSnapshot()).entries.map(
            (entry) => entry.fact,
          );
          const completedSource = facts.some(
            (fact) =>
              fact.type === "memory.topic_organization_claimed" &&
              fact.sourceWriteId === source!.writeId &&
              facts.some(
                (other) =>
                  other.type === "memory.topic_organization_settled" &&
                  other.organizationId === fact.organizationId &&
                  (other.status === "completed" || other.status === "noop"),
              ),
          );
          const pendingSource = facts.some(
            (fact) =>
              fact.type === "memory.topic_organization_claimed" &&
              fact.sourceWriteId === source!.writeId &&
              !facts.some(
                (other) =>
                  other.type === "memory.topic_organization_settled" &&
                  other.organizationId === fact.organizationId,
              ),
          );
          if (completedSource && !pendingSource) return settlement;
        }
        const organizer = createMemoryTopicOrganizerControllerV1({
          ...input.organizer,
          session,
          runId: input.writer.runId,
          scope: input.writer.scope,
          signal: operation.signal,
          extractor: {
            extractorVersion: input.organizer.extractor.extractorVersion,
            extract: (request) =>
              operation.run((signal) =>
                input.organizer.extractor.extract(request, signal),
              ),
          },
          store: {
            prepare: (request) =>
              operation.run((signal) =>
                input.organizer.store.prepare(request, signal),
              ),
            apply: (request) =>
              operation.run((signal) =>
                input.organizer.store.apply(request, signal),
              ),
          },
        });
        const organized = await organizer.settleSourceWrite(source);
        const dossier = input.dossier;
        const catalog = input.catalog;
        if (organized?.status === "completed" && dossier && catalog) {
          const projector = createMemoryTopicDossierProjectorV1({
            ...dossier,
            extractor: {
              extractorVersion: dossier.extractor.extractorVersion,
              extract: (request) =>
                operation.run((signal) =>
                  dossier.extractor.extract(request, signal),
                ),
            },
            store: {
              scope: dossier.store.scope,
              getExact: (key) =>
                operation.run((signal) => dossier.store.getExact(key, signal)),
              getCurrent: (topicId) =>
                operation.run((signal) =>
                  dossier.store.getCurrent(topicId, signal),
                ),
              put: (value) =>
                operation.run((signal) => dossier.store.put(value, signal)),
            },
          });
          const entries = await operation.run((signal) => catalog.load(signal));
          for (const topicId of organized.topicIds) {
            operation.signal.throwIfAborted();
            const candidate = entries.find(
              (item) => item.projection.topic.id === topicId,
            );
            if (!candidate) continue;
            try {
              await projector.project(candidate, operation.signal);
            } catch (error) {
              // A failed derivative need not prevent other topics, but an expired
              // operation must never start another request or fallback write.
              if (operation.signal.aborted) throw error;
            }
          }
        }
        return settlement;
      } catch (error) {
        try {
          input.writer.onEvent?.({
            schemaVersion: "paw.memory-writer-event.v1",
            type: "maintenance",
            reasonCode: operation.timedOut
              ? "MemoryMaintenanceDeadlineExceeded"
              : operation.signal.aborted
                ? "MemoryMaintenanceCancelled"
                : "MemoryMaintenanceFailed",
            durationMs: Math.max(0, performance.now() - started),
          });
        } catch {
          // Observers cannot change task completion or recovery semantics.
        }
        // Internal adapters may normalize cancellation to AbortError. Preserve
        // the operation's actual cause so deadlines are not mislabeled as user
        // cancellation by the host or tests.
        throw operation.signal.aborted ? operation.signal.reason : error;
      } finally {
        operation.dispose();
      }
    },
  };
}
