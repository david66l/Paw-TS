import { createHash } from "node:crypto";

import type { SessionInputSnapshot } from "@paw/agent-loop";
import { projectCompletionReviewToolEvidenceV1 } from "@paw/completion-review";
import { projectWorkspaceEffect } from "@paw/core";
import type { DurableJsonPayloadV1, InputFactV1, JsonValue } from "@paw/protocol";

export const PROGRESS_ADVISOR_POLICY_VERSION_V1 =
  "paw.progress-advisor.v8:r3-5-8:n4-8-16:v4-8-16:repair2:closeout2:g16-18:e8:independent-closeout:journal-anchor" as const;

const REPEAT_THRESHOLDS = new Set([3, 5, 8]);
const MAX_TIMELINE_EVENTS = 8;
const MUTATION_TOOLS = new Set([
  "workspace_write_file",
  "workspace_edit_file",
  "workspace_apply_patch",
  "workspace_notebook_edit",
  "workspace.write_file",
  "workspace.edit_file",
  "workspace.apply_patch",
  "workspace.notebook_edit",
]);
const TRANSPARENT_TOOLS = new Set([
  "workspace_todo_write",
  "workspace_acceptance_update",
  "workspace.todo_write",
  "workspace.acceptance_update",
  "workspace_progress_read",
]);
const DELEGATION_TOOLS = new Set(["workspace_delegate", "workspace.run_agent"]);

export type ProgressAdviceKindV1 =
  | "exact_repeat"
  | "inspect_gap"
  | "hypothesis_stale"
  | "no_progress_checkpoint"
  | "verification_repair"
  | "convergence_checkpoint"
  | "verification_due";

export interface ProgressAdviceBudgetV1 {
  readonly maxModelTurns: number;
  readonly maxTotalModelTurns: number;
}

export interface ProgressAdviceV1 {
  readonly policyVersion: typeof PROGRESS_ADVISOR_POLICY_VERSION_V1;
  readonly kind: ProgressAdviceKindV1;
  readonly sourceFromSeq: number;
  readonly sourceThroughSeq: number;
  readonly modelTurnsWithoutProgress: number;
  readonly delegationAttemptsSinceProgress: number;
  /** Distinct mutation turns since the latest settled verification attempt. */
  readonly unverifiedMutationTurns?: number;
  readonly evidenceKey?: string;
  readonly message: string;
  readonly repeatedTool?: Readonly<{ tool: string; count: number }>;
}

/** Pure projection over the current work segment's canonical Journal facts. */
export function projectProgressAdviceV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  budget?: ProgressAdviceBudgetV1,
  lane: "ordinary" | "closeout" | "all" = "all",
): ProgressAdviceV1 | undefined {
  const segmentStart = latestSegmentStart(snapshot);
  const entries = snapshot.entries.filter((entry) => entry.seq > segmentStart);
  const modelTurns = entries.flatMap((entry) =>
    entry.fact.type === "model.settled" ? [entry.fact.turn] : [],
  );
  const latestTurn = Math.max(0, ...modelTurns);
  if (latestTurn === 0 || entries.length === 0) return undefined;

  const settled = new Map(
    entries.flatMap((entry) =>
      entry.fact.type === "tool.settled" ? [[entry.fact.callId, entry.fact] as const] : [],
    ),
  );
  const calls = entries.flatMap((entry) =>
    entry.fact.type === "tool.call_observed" ? [{ seq: entry.seq, fact: entry.fact }] : [],
  );
  const mutation = (call: (typeof calls)[number]["fact"]) => {
    const result = settled.get(call.callId);
    return (
      result &&
      result.status !== "rejected" &&
      projectWorkspaceEffect(
        call.tool,
        inlinePayload(result.observation?.payload),
        result.observation?.isError === true,
      ).changed !== false
    );
  };
  const verificationEvidence = projectCompletionReviewToolEvidenceV1({
    calls: calls.flatMap(({ seq, fact }) => {
      const result = settled.get(fact.callId);
      if (!result) return [];
      return [
        {
          seq,
          callId: fact.callId,
          tool: fact.tool,
          status: result.status,
          args: fact.args,
          summary: result.observation?.summary ?? result.status,
          ...(result.observation?.isError === undefined
            ? {}
            : { isError: result.observation.isError }),
          ...(result.observation?.payload === undefined
            ? {}
            : { payload: inlinePayload(result.observation.payload) }),
        },
      ];
    }),
    latestMutationSeq: 0,
  });
  const passingVerificationCalls = new Set(
    verificationEvidence.flatMap((evidence) =>
      evidence.verificationKind !== "none" && evidence.outcome === "passed"
        ? [evidence.callId]
        : [],
    ),
  );
  const meaningfulTurns = calls.flatMap(({ fact }) => {
    const result = settled.get(fact.callId);
    if (!result || result.status !== "completed") return [];
    if (MUTATION_TOOLS.has(fact.tool) && result.observation?.isError !== true) {
      return [fact.turn];
    }
    if (DELEGATION_TOOLS.has(fact.tool) && result.observation?.isError !== true) {
      return [fact.turn];
    }
    return passingVerificationCalls.has(fact.callId) ? [fact.turn] : [];
  });
  const firstTurn = Math.min(...modelTurns);
  const baselineTurn = Math.max(firstTurn - 1, ...meaningfulTurns);
  const gap = latestTurn - baselineTurn;
  const delegationAttempts = calls.filter(
    ({ fact }) => fact.turn > baselineTurn && DELEGATION_TOOLS.has(fact.tool),
  ).length;

  const latestMutationSeq = Math.max(
    0,
    ...calls.filter(({ fact }) => mutation(fact)).map(({ seq }) => seq),
  );
  const checks = verificationEvidence.filter((item) => item.verificationKind !== "none");
  const latestCheck = checks.at(-1);
  const checkCall = calls.find(({ fact }) => fact.callId === latestCheck?.callId);
  // Migrate the legacy convergence guidance for untrusted verification status.
  // A different output filter is not new evidence; remind once per source/check baseline.
  if (
    lane !== "closeout" &&
    latestCheck?.outcome === "indeterminate" &&
    latestCheck.executionStatus === "completed" &&
    checkCall?.fact.turn === latestTurn
  ) {
    const directBaseline = checks
      .filter((item) => item.outcome === "passed" || item.outcome === "failed")
      .at(-1);
    return Object.freeze({
      ...advice(
        snapshot,
        segmentStart,
        "verification_repair",
        gap,
        "The latest verification has no trustworthy pass/fail outcome. Inspect its error or timeout, then run one materially simpler direct command from the same test-runner family. Remove display-only pipes, fallbacks and trailing commands, or explicitly preserve the runner's exit status. Read the complete failure summary; do not repeat the check just to try different output filters. A downstream command's exit zero is not a test pass.",
        undefined,
        delegationAttempts,
      ),
      evidenceKey: `repair:${latestMutationSeq}:${directBaseline?.callId ?? "none"}:${latestCheck.verificationKind}`,
    });
  }
  if (lane !== "ordinary" && budget && latestMutationSeq > 0 && budget.maxModelTurns >= 8) {
    const totalTurns = snapshot.entries.filter(
      (entry) => entry.fact.type === "model.settled",
    ).length;
    const remaining = Math.min(
      budget.maxModelTurns - modelTurns.length,
      budget.maxTotalModelTurns - totalTurns,
    );
    const window = Math.min(12, Math.max(4, Math.ceil(budget.maxModelTurns * 0.2)));
    if (remaining > 0 && remaining <= window) {
      // Same evidence-sensitive closeout intent as legacy convergenceGuidance,
      // expressed against Journal facts without depending on the old TaskState.
      const fresh =
        checkCall && checkCall.seq > latestMutationSeq && !checkCall.fact.tool.includes("job_wait");
      const next =
        !fresh || !latestCheck || latestCheck.outcome === "indeterminate"
          ? "Run a direct, high-signal check of the current revision, preferably the project's declared test command; filtered output or an earlier revision is insufficient."
          : latestCheck.outcome === "failed"
            ? "Use the exact current failure to repair the implementation or a test that contradicts the requirements, then rerun the declared check. Do not weaken valid tests to obtain a pass."
            : "The latest check passed for its covered scope. Inspect the final changes and remaining user requirements, including documentation and the documented test entry point; a passing subset is not full completion.";
      return Object.freeze({
        ...advice(
          snapshot,
          segmentStart,
          "convergence_checkpoint",
          gap,
          `${remaining} model calls remain in this work budget. Preserve the implementation and reserve a call for the final response. ${next} Avoid building extra diagnostic helpers or expanding scope. Finish with the evidence and any unresolved requirements; do not claim unfinished work is complete.`,
          undefined,
          delegationAttempts,
        ),
        evidenceKey: `closeout:${segmentStart}:${remaining <= 2 ? "final" : "window"}`,
      });
    }
  }
  if (lane === "closeout") return undefined;

  const repeated = consecutiveRepeat(calls.map(({ fact }) => fact));
  if (repeated && REPEAT_THRESHOLDS.has(repeated.count)) {
    return advice(
      snapshot,
      segmentStart,
      "exact_repeat",
      gap,
      `The exact ${repeated.tool} call has occurred ${repeated.count} consecutive times. Inspect the latest result, then use materially different evidence or finish if ready. The call was not blocked.`,
      repeated,
      delegationAttempts,
    );
  }

  // File activity and validation are separate. A failed check is useful
  // feedback for this cadence, but must not reset the passing-progress baseline.
  const attemptedChecks = new Set(
    verificationEvidence.flatMap((evidence) =>
      evidence.verificationKind !== "none" &&
      (evidence.outcome === "passed" || evidence.outcome === "failed")
        ? [evidence.callId]
        : [],
    ),
  );
  // Use dispatch order, not job completion time: an old background check
  // finishing after an edit does not validate that edit.
  const jobStarts = new Map<string, number>();
  for (const { seq, fact } of calls) {
    if (fact.tool !== "workspace_job_start" && fact.tool !== "workspace.job_start") continue;
    const jobId = stringField(
      inlinePayload(settled.get(fact.callId)?.observation?.payload),
      "jobId",
    );
    if (jobId) jobStarts.set(jobId, seq);
  }
  const lastCheckSeq = Math.max(
    0,
    ...calls
      .filter(({ fact }) => attemptedChecks.has(fact.callId))
      .map(({ seq, fact }) =>
        fact.tool === "workspace_job_wait" || fact.tool === "workspace.job_wait"
          ? (jobStarts.get(stringField(fact.args, "id") ?? "") ?? 0)
          : seq,
      ),
  );
  const mutationsSinceCheck = calls.filter(({ seq, fact }) => {
    return seq > lastCheckSeq && mutation(fact);
  });
  const mutationTurns = new Set(mutationsSinceCheck.map(({ fact }) => fact.turn));
  if (mutationTurns.size >= 4 && mutationsSinceCheck.at(-1)?.fact.turn === latestTurn) {
    return Object.freeze({
      ...advice(
        snapshot,
        segmentStart,
        "verification_due",
        gap,
        `${mutationTurns.size} mutation turns since the latest observed test/build/lint/typecheck attempt. Before expanding further, validate the current slice with a relevant check, or finish its missing prerequisite first. For non-executable changes, inspect the resulting artifact instead; do not invent tests. Passing checks cover their tested behavior, not every requirement. Review what remains, then continue or finish with evidence.`,
        undefined,
        delegationAttempts,
      ),
      unverifiedMutationTurns: mutationTurns.size,
    });
  }

  const kind = noProgressKind(gap);
  if (!kind) return undefined;
  return advice(
    snapshot,
    segmentStart,
    kind,
    gap,
    noProgressMessage(kind, gap, recentToolClasses(calls.map(({ fact }) => fact))),
    undefined,
    delegationAttempts,
  );
}

/**
 * Rebuild every advisory threshold crossing from the current work segment.
 *
 * Each event is projected from the snapshot prefix ending at the model/tool
 * timeline unit that first made the threshold true. Its sourceThroughSeq and
 * message therefore never move when later turns are appended. Runtime Context
 * may anchor these events beside the matching selected timeline unit and omit
 * them together when that unit is checkpoint-covered or budget-omitted.
 */
export function projectProgressAdviceTimelineV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  budget?: ProgressAdviceBudgetV1,
): readonly ProgressAdviceV1[] {
  const segmentStart = latestSegmentStart(snapshot);
  const entries = snapshot.entries.filter((entry) => entry.seq > segmentStart);
  const modelTurns = new Map<string, { turn: number; throughSeq: number }>();
  const callModels = new Map<string, string>();

  for (const entry of entries) {
    const fact = entry.fact;
    if (fact.type === "model.settled") {
      modelTurns.set(fact.modelCallId, {
        turn: fact.turn,
        throughSeq: entry.seq,
      });
      continue;
    }
    if (fact.type === "tool.call_observed") {
      callModels.set(fact.callId, fact.modelCallId);
      const model = modelTurns.get(fact.modelCallId);
      if (model) model.throughSeq = Math.max(model.throughSeq, entry.seq);
      continue;
    }
    if (fact.type === "tool.settled") {
      const modelCallId = callModels.get(fact.callId);
      const model = modelCallId ? modelTurns.get(modelCallId) : undefined;
      if (model) model.throughSeq = Math.max(model.throughSeq, entry.seq);
    }
  }

  const events: ProgressAdviceV1[] = [];
  const seen = new Set<string>();
  const boundaries = [...modelTurns.values()].sort(
    (left, right) => left.turn - right.turn || left.throughSeq - right.throughSeq,
  );
  for (const boundary of boundaries) {
    const prefixEntries = snapshot.entries.filter((entry) => entry.seq <= boundary.throughSeq);
    for (const lane of ["ordinary", "closeout"] as const) {
      const projected = projectProgressAdviceV1(
        {
          entries: prefixEntries,
          latestInputSeq: boundary.throughSeq,
          tailSeq: boundary.throughSeq,
        },
        budget,
        lane,
      );
      if (!projected || !isTimelineThreshold(projected)) continue;
      const key = projected.evidenceKey ?? `${projected.kind}:${projected.sourceThroughSeq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const special =
        projected.kind === "verification_repair" || projected.kind === "convergence_checkpoint";
      const count = events.filter((item) =>
        special
          ? item.kind === projected.kind
          : item.kind !== "verification_repair" && item.kind !== "convergence_checkpoint",
      ).length;
      if (count < (special ? 2 : MAX_TIMELINE_EVENTS)) events.push(projected);
    }
  }
  return Object.freeze(events);
}

function isTimelineThreshold(advice: ProgressAdviceV1): boolean {
  if (advice.kind === "verification_repair" || advice.kind === "convergence_checkpoint")
    return true;
  if (advice.kind === "verification_due") {
    return [4, 8, 16].includes(advice.unverifiedMutationTurns ?? 0);
  }
  return (
    advice.kind === "exact_repeat" ||
    advice.modelTurnsWithoutProgress === 4 ||
    advice.modelTurnsWithoutProgress === 8 ||
    advice.modelTurnsWithoutProgress === 16
  );
}

function latestSegmentStart(snapshot: SessionInputSnapshot<InputFactV1>): number {
  let value = 0;
  for (const entry of snapshot.entries) {
    if (entry.fact.type === "work.segment_started") value = entry.seq;
  }
  return value;
}

function consecutiveRepeat(
  calls: readonly Extract<InputFactV1, { type: "tool.call_observed" }>[],
): Readonly<{ tool: string; count: number }> | undefined {
  let key: string | undefined;
  let tool = "";
  let count = 0;
  for (const call of calls) {
    if (TRANSPARENT_TOOLS.has(call.tool)) continue;
    const next = createHash("sha256")
      .update(call.tool)
      .update("\0")
      .update(canonicalJson(call.args))
      .digest("hex");
    count = next === key ? count + 1 : 1;
    key = next;
    tool = call.tool;
  }
  return count > 1 ? Object.freeze({ tool, count }) : undefined;
}

function noProgressKind(
  gap: number,
):
  | Exclude<
      ProgressAdviceKindV1,
      "exact_repeat" | "verification_due" | "verification_repair" | "convergence_checkpoint"
    >
  | undefined {
  if (gap >= 16) return "no_progress_checkpoint";
  if (gap >= 8) return "hypothesis_stale";
  if (gap >= 4) return "inspect_gap";
  return undefined;
}

function noProgressMessage(
  kind: Exclude<
    ProgressAdviceKindV1,
    "exact_repeat" | "verification_due" | "verification_repair" | "convergence_checkpoint"
  >,
  gap: number,
  recentTools: string,
): string {
  const fact = `${gap} model turns have produced no source mutation or verification result. Recent evidence classes: ${recentTools}.`;
  if (kind === "inspect_gap") {
    return `${fact} State one current hypothesis, the exact missing evidence, and take one materially different falsifying action.`;
  }
  if (kind === "hypothesis_stale") {
    return `${fact} Change or reject the current hypothesis. Prefer a minimal direct reproduction, an existing contract test, or the relevant implementation branch over broader browsing.`;
  }
  return `${fact} Stop enumerating variants. Summarize confirmed facts and contradictions, then choose one smallest discriminating action from a different evidence class. This is advice, not a forced edit or stop.`;
}

function recentToolClasses(
  calls: readonly Extract<InputFactV1, { type: "tool.call_observed" }>[],
): string {
  const counts = new Map<string, number>();
  for (const call of calls.slice(-16)) {
    const key = call.tool.replace(/^workspace[._]/u, "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 3)
      .map(([tool, count]) => `${tool}=${count}`)
      .join(", ") || "none"
  );
}

function advice(
  snapshot: SessionInputSnapshot<InputFactV1>,
  segmentStart: number,
  kind: ProgressAdviceKindV1,
  gap: number,
  message: string,
  repeatedTool?: Readonly<{ tool: string; count: number }>,
  delegationAttemptsSinceProgress = 0,
): ProgressAdviceV1 {
  return Object.freeze({
    policyVersion: PROGRESS_ADVISOR_POLICY_VERSION_V1,
    kind,
    sourceFromSeq: Math.max(1, segmentStart + 1),
    sourceThroughSeq: snapshot.latestInputSeq,
    modelTurnsWithoutProgress: gap,
    delegationAttemptsSinceProgress,
    message,
    ...(repeatedTool ? { repeatedTool } : {}),
  });
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as JsonValue)}`)
    .join(",")}}`;
}

function stringField(value: JsonValue | undefined, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Readonly<Record<string, JsonValue>>)[key];
  return typeof field === "string" ? field : undefined;
}

// The projector is synchronous and read-only. Unresolved artifact references
// are not evidence of job completion and cannot discharge validation cadence.
function inlinePayload(payload: DurableJsonPayloadV1 | undefined): JsonValue | undefined {
  return payload?.kind === "inline" ? payload.value : undefined;
}
