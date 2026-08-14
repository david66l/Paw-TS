import {
  type ArtifactContentBlobV2,
  artifactContentHashV2,
  createArtifactContentBlobV2,
  renderMutationStepPatchV2,
} from "./artifact-materializer.js";
import { canonicalJson, sha256Canonical } from "./canonical.js";
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
  | "rich_read_projected"
  | "rich_search_projected"
  | "rich_tool_failed"
  | "rich_observation_invalid"
  | "rich_concurrent_mutation_ambiguous"
  | "rich_mutation_projected"
  | "rich_mutation_no_effect"
  | "rich_mutation_capture_gap"
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
  readonly artifactBlobs: readonly ArtifactContentBlobV2[];
  readonly diagnostics: readonly LoopV2ShadowDiagnostic[];
  readonly coverage: LoopV2ShadowCoverage;
  readonly state: WorkingDecisionStateV2;
  readonly stateHash: string;
  readonly reportHash: string;
}

export interface LoopV2ShadowObserver {
  observe(envelope: LegacyRunEventEnvelopeV1): void;
  observeToolCommit(input: LoopV2ShadowToolCommitInput): void;
  snapshot(): LoopV2ShadowReport;
}

/** Minimal structural boundary; avoids coupling the v2 kernel to core's barrel. */
export interface LegacyRunEventEnvelopeV1 {
  readonly runId: string;
  readonly seq: number;
  readonly ts: number;
  readonly event: { readonly type: string };
}

export interface LoopV2ShadowToolCommitInput {
  readonly sourceSeq: number;
  readonly callId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly result: Readonly<{
    readonly ok: boolean;
    readonly payload: unknown;
    readonly summary: string;
  }>;
  readonly repositoryRevision: string;
  /** Hash of the complete file version, distinct from the observed span blob. */
  readonly sourceContentHash?: string;
  /** A sibling mutation may race a read/search in the legacy parallel batch. */
  readonly concurrentMutation: boolean;
  readonly mutationCapture?: LoopV2ShadowMutationCapture;
}

export type LoopV2ShadowMutationCapture =
  | Readonly<{
      status: "complete";
      paths: readonly string[];
      beforeContents: Readonly<Record<string, string | null>>;
      afterContents: Readonly<Record<string, string | null>>;
    }>
  | Readonly<{
      status: "gap";
      reason:
        | "parallel_mutations"
        | "unbounded_mutation_surface"
        | "unsafe_or_missing_target"
        | "capture_failed";
    }>;

export type LoopV2ShadowToolCommitPortInput = Omit<
  LoopV2ShadowToolCommitInput,
  "sourceSeq"
>;

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
  const artifactBlobs = new Map<string, ArtifactContentBlobV2>();
  const sourceTimestamps = new Map<number, number>();
  const consumedToolCommits = new Set<number>();

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
      sourceTimestamps.set(envelope.seq, envelope.ts);

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

    observeToolCommit(input) {
      if (input.sourceSeq !== sourceThroughSeq) {
        throw new Error(
          `Loop v2 rich tool commit must follow its source event: ${input.sourceSeq} != ${sourceThroughSeq}`,
        );
      }
      if (consumedToolCommits.has(input.sourceSeq)) {
        throw new Error(
          `Loop v2 rich tool commit already consumed source ${input.sourceSeq}`,
        );
      }
      let diagnosticIndex = -1;
      for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
        if (diagnostics[index]?.sourceSeq === input.sourceSeq) {
          diagnosticIndex = index;
          break;
        }
      }
      const diagnostic = diagnostics[diagnosticIndex];
      if (!diagnostic || diagnostic.sourceEventType !== "tool.result") {
        throw new Error(
          `Loop v2 rich tool commit has no matching tool.result at ${input.sourceSeq}`,
        );
      }
      consumedToolCommits.add(input.sourceSeq);

      if (isMutationTool(input.tool)) {
        const mutation = buildRichMutation(
          input,
          state.currentMutationRevision + 1,
          projectedEvents.length + 1,
        );
        if (mutation.kind === "gap") {
          diagnostics[diagnosticIndex] = {
            ...diagnostic,
            disposition: "gap",
            reason: "rich_mutation_capture_gap",
          };
          return;
        }
        if (mutation.kind === "unchanged") {
          diagnostics[diagnosticIndex] = {
            ...diagnostic,
            disposition: "ignored",
            reason: "rich_mutation_no_effect",
          };
          return;
        }
        for (const blob of mutation.blobs) artifactBlobs.set(blob.ref, blob);
        const projected: LoopV2Envelope = {
          schemaVersion: LOOP_V2_SCHEMA_VERSION,
          runId,
          seq: projectedEvents.length + 1,
          ts: sourceTimestamps.get(input.sourceSeq) ?? 0,
          event: { type: "mutation.recorded", mutation: mutation.record },
        };
        state = projectLoopV2Event(state, projected).state;
        projectedEvents.push(projected);
        diagnostics[diagnosticIndex] = {
          ...diagnostic,
          disposition: "projected",
          reason: "rich_mutation_projected",
        };
        return;
      }

      if (!isRichEvidenceTool(input.tool)) return;
      if (!input.result.ok) {
        diagnostics[diagnosticIndex] = {
          ...diagnostic,
          disposition: "ignored",
          reason: "rich_tool_failed",
        };
        return;
      }
      if (input.concurrentMutation) {
        diagnostics[diagnosticIndex] = {
          ...diagnostic,
          disposition: "gap",
          reason: "rich_concurrent_mutation_ambiguous",
        };
        return;
      }

      const rich = buildRichEvidence(input);
      if (!rich) {
        diagnostics[diagnosticIndex] = {
          ...diagnostic,
          disposition: "gap",
          reason: "rich_observation_invalid",
        };
        return;
      }
      artifactBlobs.set(rich.blob.ref, rich.blob);
      const projected: LoopV2Envelope = {
        schemaVersion: LOOP_V2_SCHEMA_VERSION,
        runId,
        seq: projectedEvents.length + 1,
        ts: sourceTimestamps.get(input.sourceSeq) ?? 0,
        event: {
          type: "evidence.observed",
          observation: rich.observation,
        },
      };
      state = projectLoopV2Event(state, projected).state;
      projectedEvents.push(projected);
      diagnostics[diagnosticIndex] = {
        ...diagnostic,
        disposition: "projected",
        reason:
          rich.observation.kind === "read"
            ? "rich_read_projected"
            : "rich_search_projected",
      };
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
        artifactBlobs: [...artifactBlobs.values()].sort((left, right) =>
          left.ref.localeCompare(right.ref),
        ),
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

function isRichEvidenceTool(tool: string): boolean {
  return (
    tool === "workspace.read_file" ||
    tool === "workspace.search" ||
    tool === "workspace.grep" ||
    tool === "workspace.glob"
  );
}

function isMutationTool(tool: string): boolean {
  return (
    tool === "workspace.write_file" ||
    tool === "workspace.edit_file" ||
    tool === "workspace.apply_patch" ||
    tool === "workspace.notebook_edit" ||
    tool === "workspace.run_shell"
  );
}

function buildRichMutation(
  input: LoopV2ShadowToolCommitInput,
  mutationRevision: number,
  projectedSeq: number,
):
  | Readonly<{ kind: "gap" }>
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{
      kind: "record";
      record: import("./schema.js").MutationJournalEntryV2;
      blobs: readonly ArtifactContentBlobV2[];
    }> {
  const capture = input.mutationCapture;
  if (!capture || capture.status === "gap") return { kind: "gap" };
  if (
    capture.paths.length === 0 ||
    new Set(capture.paths).size !== capture.paths.length ||
    capture.paths.some(
      (path) =>
        !Object.hasOwn(capture.beforeContents, path) ||
        !Object.hasOwn(capture.afterContents, path),
    )
  ) {
    return { kind: "gap" };
  }
  const paths = [...new Set(capture.paths)].sort();
  const changedPaths = paths.filter(
    (path) => capture.beforeContents[path] !== capture.afterContents[path],
  );
  if (changedPaths.length === 0) return { kind: "unchanged" };

  const blobs = new Map<string, ArtifactContentBlobV2>();
  const beforeHashes: Record<string, string | null> = {};
  const afterHashes: Record<string, string | null> = {};
  const beforeContentRefs: Record<string, string | null> = {};
  const afterContentRefs: Record<string, string | null> = {};
  for (const path of changedPaths) {
    const before = capture.beforeContents[path] ?? null;
    const after = capture.afterContents[path] ?? null;
    const beforeBlob =
      before === null ? null : createArtifactContentBlobV2(before);
    const afterBlob =
      after === null ? null : createArtifactContentBlobV2(after);
    if (beforeBlob) blobs.set(beforeBlob.ref, beforeBlob);
    if (afterBlob) blobs.set(afterBlob.ref, afterBlob);
    beforeHashes[path] = beforeBlob?.contentHash ?? null;
    afterHashes[path] = afterBlob?.contentHash ?? null;
    beforeContentRefs[path] = beforeBlob?.ref ?? null;
    afterContentRefs[path] = afterBlob?.ref ?? null;
  }
  let patch: string;
  try {
    patch = renderMutationStepPatchV2(
      changedPaths.map((path) => ({
        path,
        beforeContent: capture.beforeContents[path] ?? null,
        afterContent: capture.afterContents[path] ?? null,
      })),
    );
  } catch {
    return { kind: "gap" };
  }
  return {
    kind: "record",
    blobs: [...blobs.values()],
    record: {
      seq: projectedSeq,
      callId: input.callId,
      mutationRevision,
      paths: changedPaths,
      beforeHashes,
      afterHashes,
      beforeContentRefs,
      afterContentRefs,
      patch,
      workspaceEffect: classifyWorkspaceEffect(changedPaths),
    },
  };
}

function classifyWorkspaceEffect(
  paths: readonly string[],
): "product" | "test" | "control" | "unknown" {
  if (
    paths.every((path) =>
      /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$/i.test(
        path,
      ),
    )
  ) {
    return "test";
  }
  if (paths.every((path) => /(?:^|\/)\.paw(?:\/|$)/.test(path))) {
    return "control";
  }
  return paths.length > 0 ? "product" : "unknown";
}

function buildRichEvidence(input: LoopV2ShadowToolCommitInput):
  | Readonly<{
      blob: ArtifactContentBlobV2;
      observation:
        | import("./schema.js").ReadEvidenceObservation
        | import("./schema.js").SearchEvidenceObservation;
    }>
  | undefined {
  const args = asRecord(input.args);
  const payload = asRecord(input.result.payload);
  if (!args || !payload) return undefined;

  if (input.tool === "workspace.read_file") {
    const path = readString(args, "path");
    const content = readString(payload, "content");
    const rawOffset = args.offset;
    const rawLineCount = payload.line_count;
    const start =
      rawOffset === undefined
        ? 0
        : typeof rawOffset === "number" &&
            Number.isSafeInteger(rawOffset) &&
            rawOffset >= 0
          ? rawOffset
          : undefined;
    const lineCount =
      typeof rawLineCount === "number" &&
      Number.isSafeInteger(rawLineCount) &&
      rawLineCount >= 0
        ? rawLineCount
        : undefined;
    if (
      !path ||
      content === undefined ||
      start === undefined ||
      lineCount === undefined ||
      !input.sourceContentHash
    ) {
      return undefined;
    }
    const blob = createArtifactContentBlobV2(content);
    return {
      blob,
      observation: {
        kind: "read",
        path: normalizeEvidencePath(path),
        start,
        endExclusive: start + lineCount,
        contentHash: input.sourceContentHash,
        repositoryRevision: input.repositoryRevision,
        artifactRef: blob.ref,
      },
    };
  }

  const root = readString(args, "path") ?? ".";
  const query = readString(args, "pattern");
  if (!query) return undefined;
  const serialized = canonicalJson(input.result.payload);
  const blob = createArtifactContentBlobV2(serialized);
  const options = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "path" && key !== "pattern"),
  );
  return {
    blob,
    observation: {
      kind: "search",
      root: normalizeEvidencePath(root),
      query,
      ...(Object.keys(options).length > 0 ? { options } : {}),
      resultHash: artifactContentHashV2(serialized),
      repositoryRevision: input.repositoryRevision,
      artifactRef: blob.ref,
    },
  };
}

function normalizeEvidencePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "") || ".";
}

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
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
