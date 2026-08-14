import { sha256Canonical } from "./canonical.js";
import {
  createWorkingDecisionStateV2,
  decisionStateHash,
  projectLoopV2Event,
} from "./projector.js";
import {
  LOOP_V2_SCHEMA_VERSION,
  type LoopV2Envelope,
  type WorkingDecisionStateV2,
} from "./schema.js";

export type LoopV2ShadowDisposition = "projected" | "gap" | "ignored";

export type LoopV2ShadowReason =
  | "task_started_projected"
  | "duplicate_run_boundary"
  | "mechanical_phase_not_semantic"
  | "legacy_evidence_missing_content_identity"
  | "legacy_mutation_missing_content_refs"
  | "legacy_verification_missing_authority_scope"
  | "legacy_candidate_missing_certification_input"
  | "legacy_compaction_missing_artifact_refs"
  | "non_decision_event";

export interface LoopV2ShadowDiagnostic {
  readonly sourceSeq: number;
  readonly sourceEventType: string;
  readonly disposition: LoopV2ShadowDisposition;
  readonly reason: LoopV2ShadowReason;
}

export interface LoopV2ShadowCoverage {
  readonly observed: number;
  readonly projected: number;
  readonly gaps: number;
  readonly ignored: number;
}

export interface LoopV2ShadowReport {
  readonly runId: string;
  readonly sourceThroughSeq: number;
  readonly projectedEvents: readonly LoopV2Envelope[];
  readonly diagnostics: readonly LoopV2ShadowDiagnostic[];
  readonly coverage: LoopV2ShadowCoverage;
  readonly state: WorkingDecisionStateV2;
  readonly stateHash: string;
  readonly reportHash: string;
}

export interface LoopV2ShadowObserver {
  observe(envelope: LegacyRunEventEnvelopeV1): void;
  snapshot(): LoopV2ShadowReport;
}

/** Minimal structural boundary; avoids coupling the v2 kernel to core's barrel. */
export interface LegacyRunEventEnvelopeV1 {
  readonly runId: string;
  readonly seq: number;
  readonly ts: number;
  readonly event: { readonly type: string };
}

/**
 * Observe the legacy loop without inventing facts that its event contract
 * cannot prove.  In particular, legacy tool results contain summaries and
 * truncated diffs rather than content identities or complete before/after
 * artifacts.  Those events remain explicit coverage gaps until a richer
 * capture seam is connected.
 */
export function createLoopV2ShadowObserver(
  runId: string,
): LoopV2ShadowObserver {
  if (!runId.trim()) throw new Error("Loop v2 shadow runId must not be empty");

  let sourceThroughSeq = 0;
  let state = createWorkingDecisionStateV2(runId);
  const projectedEvents: LoopV2Envelope[] = [];
  const diagnostics: LoopV2ShadowDiagnostic[] = [];

  const record = (
    envelope: LegacyRunEventEnvelopeV1,
    disposition: LoopV2ShadowDisposition,
    reason: LoopV2ShadowReason,
  ) => {
    diagnostics.push({
      sourceSeq: envelope.seq,
      sourceEventType: envelope.event.type,
      disposition,
      reason,
    });
  };

  return {
    observe(envelope) {
      if (envelope.runId !== runId) {
        throw new Error(
          `Loop v2 shadow run mismatch: expected ${runId}, got ${envelope.runId}`,
        );
      }
      if (
        !Number.isSafeInteger(envelope.seq) ||
        envelope.seq <= sourceThroughSeq
      ) {
        throw new Error(
          `Loop v2 shadow source sequence must increase: ${envelope.seq} <= ${sourceThroughSeq}`,
        );
      }
      sourceThroughSeq = envelope.seq;

      if (envelope.event.type === "run.started") {
        if (state.goal) {
          record(envelope, "ignored", "duplicate_run_boundary");
          return;
        }
        const goal = readString(envelope.event, "goal");
        if (!goal) {
          throw new Error("Legacy run.started event is missing a goal");
        }
        const projected: LoopV2Envelope = {
          schemaVersion: LOOP_V2_SCHEMA_VERSION,
          runId,
          seq: projectedEvents.length + 1,
          ts: envelope.ts,
          event: {
            type: "task.started",
            goal,
            sourceHash: sha256Canonical(goal),
          },
        };
        state = projectLoopV2Event(state, projected).state;
        projectedEvents.push(projected);
        record(envelope, "projected", "task_started_projected");
        return;
      }

      const classification = classifyLegacyEvent(envelope.event);
      record(envelope, classification.disposition, classification.reason);
    },

    snapshot() {
      const coverage: LoopV2ShadowCoverage = {
        observed: diagnostics.length,
        projected: diagnostics.filter(
          (diagnostic) => diagnostic.disposition === "projected",
        ).length,
        gaps: diagnostics.filter(
          (diagnostic) => diagnostic.disposition === "gap",
        ).length,
        ignored: diagnostics.filter(
          (diagnostic) => diagnostic.disposition === "ignored",
        ).length,
      };
      const reportWithoutHash = {
        runId,
        sourceThroughSeq,
        projectedEvents: [...projectedEvents],
        diagnostics: [...diagnostics],
        coverage,
        state,
        stateHash: decisionStateHash(state),
      };
      return {
        ...reportWithoutHash,
        reportHash: sha256Canonical(reportWithoutHash),
      };
    },
  };
}

function classifyLegacyEvent(
  event: LegacyRunEventEnvelopeV1["event"],
): Readonly<{
  disposition: Exclude<LoopV2ShadowDisposition, "projected">;
  reason: Exclude<LoopV2ShadowReason, "task_started_projected">;
}> {
  if (event.type === "phase") {
    return {
      disposition: "ignored",
      reason: "mechanical_phase_not_semantic",
    };
  }

  if (
    event.type === "agent.action" &&
    readString(readRecord(event, "action"), "type") === "final_answer"
  ) {
    return {
      disposition: "gap",
      reason: "legacy_candidate_missing_certification_input",
    };
  }

  if (event.type === "tool.result") {
    const workspaceEffect = readRecord(event, "workspaceEffect");
    const fileChanges = readArray(event, "fileChanges");
    if (workspaceEffect?.changed === true || (fileChanges?.length ?? 0) > 0) {
      return {
        disposition: "gap",
        reason: "legacy_mutation_missing_content_refs",
      };
    }
    const tool = readString(event, "tool") ?? "";
    if (isReadOrSearchTool(tool)) {
      return {
        disposition: "gap",
        reason: "legacy_evidence_missing_content_identity",
      };
    }
    if (isDiagnosticTool(tool)) {
      return {
        disposition: "gap",
        reason: "legacy_verification_missing_authority_scope",
      };
    }
  }

  if (event.type === "compression.auto_compact.done") {
    return {
      disposition: "gap",
      reason: "legacy_compaction_missing_artifact_refs",
    };
  }

  return { disposition: "ignored", reason: "non_decision_event" };
}

function isReadOrSearchTool(tool: string): boolean {
  return /(?:^|\.)(?:read_file|list_dir|search|grep|glob|find)$/.test(tool);
}

function isDiagnosticTool(tool: string): boolean {
  return /(?:^|\.)(?:shell|exec|run_command|terminal)$/.test(tool);
}

function readRecord(
  value: object | undefined,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  if (!value) return undefined;
  const candidate = (value as Readonly<Record<string, unknown>>)[key];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  return candidate as Readonly<Record<string, unknown>>;
}

function readString(
  value: object | undefined,
  key: string,
): string | undefined {
  if (!value) return undefined;
  const candidate = (value as Readonly<Record<string, unknown>>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function readArray(
  value: object | undefined,
  key: string,
): readonly unknown[] | undefined {
  if (!value) return undefined;
  const candidate = (value as Readonly<Record<string, unknown>>)[key];
  return Array.isArray(candidate) ? candidate : undefined;
}
