import { parsePatch } from "diff";
import type {
  CandidateReviewPayloadV2,
  SemanticReviewerV2,
} from "./candidate-certification.js";
import { canonicalJson } from "./canonical.js";

export interface SemanticReviewUsageV2 {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
}

/** Minimal model port; the loop kernel does not depend on a provider package. */
export interface SemanticReviewModelV2 {
  readonly label: string;
  complete(
    messages: readonly Readonly<{
      readonly role: "system" | "user";
      readonly content: string;
    }>[],
    options?: Readonly<{ readonly signal?: AbortSignal }>,
  ): Promise<
    Readonly<{
      readonly text: string;
      readonly usage?: SemanticReviewUsageV2;
      readonly finishReason?: string;
      readonly toolCalls?: readonly unknown[];
    }>
  >;
}

export interface ModelSemanticReviewerOptionsV2 {
  readonly model: SemanticReviewModelV2;
  readonly onUsage?: (modelLabel: string, usage: SemanticReviewUsageV2) => void;
  readonly signal?: AbortSignal;
  readonly maxInputChars?: number;
}

export function createModelSemanticReviewerV2(
  options: ModelSemanticReviewerOptionsV2,
): SemanticReviewerV2 {
  return async (payload) => {
    const messages = buildSemanticReviewMessagesV2(
      payload,
      options.maxInputChars,
    );
    const result = await options.model.complete(
      messages,
      options.signal ? { signal: options.signal } : undefined,
    );
    if (result.usage) {
      options.onUsage?.(options.model.label, result.usage);
    }
    if (result.toolCalls && result.toolCalls.length > 0) {
      throw new Error("Semantic reviewer attempted to call a tool");
    }
    if (
      result.finishReason === "length" ||
      result.finishReason === "max_tokens"
    ) {
      throw new Error("Semantic reviewer response was truncated");
    }
    return parseReviewerJson(result.text);
  };
}

export function buildSemanticReviewMessagesV2(
  payload: CandidateReviewPayloadV2,
  maxInputChars = 120_000,
): readonly Readonly<{
  readonly role: "system" | "user";
  readonly content: string;
}>[] {
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 1_000) {
    throw new Error("Semantic reviewer maxInputChars must be at least 1000");
  }
  const material = buildBoundedSemanticReviewMaterialV2(payload, maxInputChars);
  return [
    {
      role: "system",
      content:
        "You are an independent, read-only semantic reviewer. You have no tools. Judge only the supplied complete goal and contract, the baseline-to-terminal consolidated patch, host facts, mutation manifest, and bounded final-source windows. Historical intermediate patch bodies are intentionally absent because they may describe code that was later reverted. The implementing agent's final summary and hidden reasoning are also absent. Source-window omissions are explicit; do not claim to have seen omitted source. Verification context is mandatory: when authority=external, local verification is diagnostic evidence, not a pass and not final acceptance authority; a local code_failed record alone is not a blocking finding because the configured external verifier owns the final contract. You may still block a concrete semantic defect visible in the supplied patch/contract. Do not infer failure from hypothetical hidden tests. Every blocking finding must bind a supplied criterion or invariant and visible evidence. When a public or unknown surface changed, compare it with a materially smaller alternative. Return one JSON object and no prose.",
    },
    {
      role: "user",
      content: `Review this candidate. Preserve candidateInputHash and mutationRevision exactly. Schema: {"candidateInputHash":string,"mutationRevision":number,"verdict":"pass"|"fail"|"partial","findings":[{"severity":"blocking"|"warning","criterionId"?:string,"invariantId"?:string,"file"?:string,"line"?:number,"observedChange":string,"risk":string,"minimalAlternative"?:string,"evidenceRefs":string[]}]}. Evidence refs must be one of mutation:<callId>, surface:<surfaceId>, a supplied verification id, or snapshot:<path>.\n\n${material}`,
    },
  ];
}

interface ReviewLineRangeV2 {
  readonly start: number;
  readonly endExclusive: number;
}

interface ReviewSourceWindowV2 {
  readonly path: string;
  readonly contentHash: string;
  readonly hunkStartLine: number;
  readonly hunkEndLine: number;
  readonly windowStartLine: number;
  readonly windowEndLine: number;
  readonly excerpt: string;
}

interface ReviewSourceOmissionV2 {
  readonly path: string;
  readonly contentHash: string | null;
  readonly hunkStartLine: number;
  readonly hunkEndLine: number;
  readonly reason: "source_window_budget" | "terminal_path_has_no_snapshot";
}

function buildBoundedSemanticReviewMaterialV2(
  payload: CandidateReviewPayloadV2,
  maxInputChars: number,
): string {
  const mandatory = {
    candidateInputHash: payload.candidateInputHash,
    mutationRevision: payload.input.mutationRevision,
    goal: payload.goal,
    verificationContext: payload.verificationContext,
    criteria: payload.input.criteria,
    invariants: payload.input.invariants,
    changedPublicSurface: payload.input.changedPublicSurface,
    currentVerification: payload.input.currentVerification,
    unresolvedRisks: payload.input.unresolvedRisks,
    terminalPatch: payload.terminalPatch,
    mutationManifest: payload.input.mutationJournal.map((mutation) => ({
      callId: mutation.callId,
      mutationRevision: mutation.mutationRevision,
      paths: mutation.paths,
      patchHash: mutation.patchHash,
    })),
    projection: {
      schemaVersion: "paw.semantic-review-projection.v2",
      mandatoryEvidence: "complete",
      historicalPatchBodies: "omitted_by_design",
    },
  };
  const mandatoryOnly = canonicalJson({
    ...mandatory,
    sourceContext: { windows: [], omissions: [] },
  });
  if (mandatoryOnly.length > maxInputChars) {
    throw new Error(
      `Semantic reviewer mandatory evidence exceeds maxInputChars (${mandatoryOnly.length} > ${maxInputChars})`,
    );
  }
  const candidates = sourceWindowCandidatesV2(payload);
  const windows: ReviewSourceWindowV2[] = [];
  let omissions: ReviewSourceOmissionV2[] = candidates.map(
    ({ expanded: _expanded, minimum: _minimum, ...omission }) => omission,
  );
  let rendered = canonicalJson({
    ...mandatory,
    sourceContext: { windows, omissions },
  });
  if (rendered.length > maxInputChars) {
    throw new Error(
      `Semantic reviewer omission manifest exceeds maxInputChars (${rendered.length} > ${maxInputChars})`,
    );
  }
  for (const candidate of candidates) {
    for (const window of [candidate.expanded, candidate.minimum]) {
      if (!window) continue;
      const nextWindows = [...windows, window];
      const nextOmissions = omissions.filter(
        (omission) => !sameSourceRangeV2(omission, candidate),
      );
      const next = canonicalJson({
        ...mandatory,
        sourceContext: { windows: nextWindows, omissions: nextOmissions },
      });
      if (next.length <= maxInputChars) {
        windows.push(window);
        omissions = nextOmissions;
        rendered = next;
        break;
      }
    }
  }
  return rendered;
}

function sourceWindowCandidatesV2(
  payload: CandidateReviewPayloadV2,
): readonly Readonly<{
  path: string;
  contentHash: string | null;
  hunkStartLine: number;
  hunkEndLine: number;
  reason: ReviewSourceOmissionV2["reason"];
  expanded?: ReviewSourceWindowV2;
  minimum?: ReviewSourceWindowV2;
}>[] {
  const snapshots = new Map(
    payload.snapshots.map((snapshot) => [snapshot.path, snapshot]),
  );
  let files: ReturnType<typeof parsePatch>;
  try {
    files = parsePatch(payload.terminalPatch.patch);
  } catch {
    throw new Error("Candidate terminal patch is not parseable");
  }
  const candidatesByPath = new Map<
    string,
    Array<ReturnType<typeof sourceWindowCandidateV2>>
  >();
  for (const file of files) {
    const rawPath =
      file.newFileName && file.newFileName !== "/dev/null"
        ? file.newFileName
        : file.oldFileName;
    const path = normalizePatchPathV2(rawPath);
    if (!path)
      throw new Error("Candidate terminal patch contains an invalid path");
    const pathCandidates = candidatesByPath.get(path) ?? [];
    for (const hunk of file.hunks) {
      const start = Math.max(0, (hunk.newStart || 1) - 1);
      const range = {
        start,
        endExclusive: start + Math.max(1, hunk.newLines),
      };
      pathCandidates.push(
        sourceWindowCandidateV2(path, range, snapshots.get(path)),
      );
    }
    candidatesByPath.set(path, pathCandidates);
  }
  const paths = [...candidatesByPath.keys()].sort();
  const candidates: Array<ReturnType<typeof sourceWindowCandidateV2>> = [];
  const maximumHunks = Math.max(
    0,
    ...paths.map((path) => candidatesByPath.get(path)?.length ?? 0),
  );
  // Round-robin prevents a many-hunk file from consuming the source-window
  // allowance before another changed file receives any final-state context.
  for (let index = 0; index < maximumHunks; index += 1) {
    for (const path of paths) {
      const candidate = candidatesByPath.get(path)?.[index];
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function sourceWindowCandidateV2(
  path: string,
  range: ReviewLineRangeV2,
  snapshot: CandidateReviewPayloadV2["snapshots"][number] | undefined,
): Readonly<{
  path: string;
  contentHash: string | null;
  hunkStartLine: number;
  hunkEndLine: number;
  reason: ReviewSourceOmissionV2["reason"];
  expanded?: ReviewSourceWindowV2;
  minimum?: ReviewSourceWindowV2;
}> {
  const base = {
    path,
    contentHash: snapshot?.contentHash ?? null,
    hunkStartLine: range.start + 1,
    hunkEndLine: range.endExclusive,
    reason: snapshot
      ? ("source_window_budget" as const)
      : ("terminal_path_has_no_snapshot" as const),
  };
  if (!snapshot) return base;
  const windowBase = {
    path,
    contentHash: snapshot.contentHash,
    hunkStartLine: base.hunkStartLine,
    hunkEndLine: base.hunkEndLine,
  };
  const lines = snapshot.content.replace(/\r\n?/g, "\n").split("\n");
  const minimumRange = {
    start: Math.min(range.start, Math.max(0, lines.length - 1)),
    endExclusive: Math.min(
      lines.length,
      Math.max(range.start + 1, range.endExclusive),
    ),
  };
  const expandedRange = {
    start: Math.max(0, minimumRange.start - 12),
    endExclusive: Math.min(lines.length, minimumRange.endExclusive + 12),
  };
  return {
    ...base,
    expanded: renderSourceWindowV2(windowBase, expandedRange, lines),
    minimum:
      expandedRange.start === minimumRange.start &&
      expandedRange.endExclusive === minimumRange.endExclusive
        ? undefined
        : renderSourceWindowV2(windowBase, minimumRange, lines),
  };
}

function renderSourceWindowV2(
  base: Omit<
    ReviewSourceWindowV2,
    "windowStartLine" | "windowEndLine" | "excerpt"
  >,
  range: ReviewLineRangeV2,
  lines: readonly string[],
): ReviewSourceWindowV2 {
  return {
    ...base,
    windowStartLine: range.start + 1,
    windowEndLine: range.endExclusive,
    excerpt: lines
      .slice(range.start, range.endExclusive)
      .map((line, index) => `${range.start + index + 1}: ${line}`)
      .join("\n"),
  };
}

function sameSourceRangeV2(
  left: Pick<ReviewSourceOmissionV2, "path" | "hunkStartLine" | "hunkEndLine">,
  right: Pick<ReviewSourceOmissionV2, "path" | "hunkStartLine" | "hunkEndLine">,
): boolean {
  return (
    left.path === right.path &&
    left.hunkStartLine === right.hunkStartLine &&
    left.hunkEndLine === right.hunkEndLine
  );
}

function normalizePatchPathV2(value: string | undefined): string | undefined {
  const normalized = value
    ?.replace(/^[ab]\//, "")
    .replace(/^"|"$/g, "")
    .replace(/\\/g, "/");
  return normalized && normalized !== "/dev/null" ? normalized : undefined;
}

function parseReviewerJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Returning the original value lets the certification protocol validator
    // record one durable protocol_partial rather than opening a recovery loop.
    return text;
  }
}
