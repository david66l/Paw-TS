import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";
import type { MemoryTopicDossierStoreV1 } from "./topic-dossier-store.js";
import {
  type MemoryTopicDossierExtractorV1,
  type MemoryTopicDossierV1,
  PAW_MEMORY_TOPIC_DOSSIER_POLICY_VERSION_V1,
  createBoundedMemoryTopicDossierProposalV1,
  createCompleteMemoryTopicDossierProposalV1,
  materializeMemoryTopicDossierV1,
} from "./topic-dossier.js";
import type { MemoryTopicEvidenceCatalogItemV1 } from "./topic-evidence-planner.js";

export interface MemoryTopicDossierProjectorEventV1 {
  readonly schemaVersion: "paw.memory-topic-dossier-projector-event.v1";
  readonly type:
    | "cache_hit"
    | "deterministic"
    | "extract"
    | "fallback"
    | "commit"
    | "failed";
  readonly topicId: string;
  readonly projectionHash: string;
  readonly selectedCurrent?: number;
  readonly selectedEvolutions?: number;
  readonly selectedConflicts?: number;
  readonly inserted?: boolean;
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export interface MemoryTopicDossierProjectorV1 {
  project(
    source: MemoryTopicEvidenceCatalogItemV1,
    signal: AbortSignal,
  ): Promise<MemoryTopicDossierV1>;
}

/**
 * Query-independent L2 projection. Exact revision hits bypass the model, so a
 * resumed organization does not pay for or alter an already-built dossier.
 */
export function createMemoryTopicDossierProjectorV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    extractor: MemoryTopicDossierExtractorV1;
    store: MemoryTopicDossierStoreV1;
    maxCurrentConclusions?: number;
    maxEvolutions?: number;
    maxConflicts?: number;
    now?: () => number;
    onEvent?: (event: MemoryTopicDossierProjectorEventV1) => void;
  }>,
): MemoryTopicDossierProjectorV1 {
  const scopeFingerprint = memoryScopeFingerprintV1(input.scope);
  if (
    memoryScopeFingerprintV1(input.store.scope) !== scopeFingerprint ||
    !input.extractor.extractorVersion.trim()
  ) {
    throw namedError("MemoryTopicDossierProjectorDependencyInvalid");
  }
  const maxCurrentConclusions = budget(input.maxCurrentConclusions ?? 12);
  const maxEvolutions = budget(input.maxEvolutions ?? 12);
  const maxConflicts = budget(input.maxConflicts ?? 8);
  const now = input.now ?? Date.now;

  return Object.freeze({
    async project(
      source: MemoryTopicEvidenceCatalogItemV1,
      signal: AbortSignal,
    ) {
      const started = now();
      const { topic, snapshot } = source.projection;
      try {
        if (signal.aborted) throw abortError();
        if (snapshot.scopeFingerprint !== scopeFingerprint) {
          throw namedError("MemoryTopicDossierProjectorScopeMismatch");
        }
        const exactKey = {
          topicId: topic.id,
          projectionHash: topic.projectionHash,
          policyVersion: PAW_MEMORY_TOPIC_DOSSIER_POLICY_VERSION_V1,
          extractorVersion: input.extractor.extractorVersion,
        };
        const cached = await input.store.getExact(exactKey, signal);
        if (cached) {
          emit(input.onEvent, {
            schemaVersion: "paw.memory-topic-dossier-projector-event.v1",
            type: "cache_hit",
            topicId: topic.id,
            projectionHash: topic.projectionHash,
            durationMs: Math.max(0, now() - started),
          });
          return cached;
        }
        const extractionInput = {
          projection: source.projection,
          entries: source.entries,
          maxCurrentConclusions,
          maxEvolutions,
          maxConflicts,
        };
        const extractionStarted = now();
        const complete =
          createCompleteMemoryTopicDossierProposalV1(extractionInput);
        let proposal = complete;
        let proposalEvent: "deterministic" | "extract" | "fallback" =
          "deterministic";
        let fallbackReason: string | undefined;
        if (!proposal) {
          try {
            proposal = await input.extractor.extract(extractionInput, signal);
            proposalEvent = "extract";
          } catch (error) {
            if (signal.aborted || stableReasonCode(error) === "AbortError") {
              throw error;
            }
            proposal =
              createBoundedMemoryTopicDossierProposalV1(extractionInput);
            proposalEvent = "fallback";
            fallbackReason = stableReasonCode(error);
          }
        }
        emit(input.onEvent, {
          schemaVersion: "paw.memory-topic-dossier-projector-event.v1",
          type: proposalEvent,
          topicId: topic.id,
          projectionHash: topic.projectionHash,
          selectedCurrent: proposal.currentMemoryIds.length,
          selectedEvolutions: proposal.evolutionRelationIds.length,
          selectedConflicts: proposal.conflictRelationIds.length,
          ...(fallbackReason === undefined
            ? {}
            : { reasonCode: fallbackReason }),
          durationMs: Math.max(0, now() - extractionStarted),
        });
        const dossier = materializeMemoryTopicDossierV1({
          projection: source.projection,
          entries: source.entries,
          proposal,
          extractorVersion: input.extractor.extractorVersion,
          createdAt: new Date(now()).toISOString(),
        });
        const commitStarted = now();
        const committed = await input.store.put(dossier, signal);
        const durable = committed.inserted
          ? dossier
          : await input.store.getExact(exactKey, signal);
        if (!durable) {
          throw namedError("MemoryTopicDossierCommitWinnerMissing");
        }
        emit(input.onEvent, {
          schemaVersion: "paw.memory-topic-dossier-projector-event.v1",
          type: "commit",
          topicId: topic.id,
          projectionHash: topic.projectionHash,
          inserted: committed.inserted,
          durationMs: Math.max(0, now() - commitStarted),
        });
        return durable;
      } catch (error) {
        emit(input.onEvent, {
          schemaVersion: "paw.memory-topic-dossier-projector-event.v1",
          type: "failed",
          topicId: topic.id,
          projectionHash: topic.projectionHash,
          reasonCode: stableReasonCode(error),
          durationMs: Math.max(0, now() - started),
        });
        throw error;
      }
    },
  });
}

function budget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw namedError("MemoryTopicDossierProjectorBudgetInvalid");
  }
  return value;
}

function emit(
  observer: ((event: MemoryTopicDossierProjectorEventV1) => void) | undefined,
  event: MemoryTopicDossierProjectorEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Observability cannot change projection behavior.
  }
}

function abortError(): Error {
  const error = new Error("Memory topic dossier projection aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function stableReasonCode(value: unknown): string {
  const raw = value instanceof Error ? value.name : "Unknown";
  return raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) || "Unknown";
}
