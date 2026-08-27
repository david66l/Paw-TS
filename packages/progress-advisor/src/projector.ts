import { createHash } from "node:crypto";

import type { SessionInputSnapshot } from "@paw/agent-loop";
import { projectCompletionReviewToolEvidenceV1 } from "@paw/completion-review";
import type { InputFactV1, JsonValue } from "@paw/protocol";

export const PROGRESS_ADVISOR_POLICY_VERSION_V1 =
  "paw.progress-advisor.v5:r3-5-8:n4-8-16:g16-18:e8:verified-pass:main-owned-replan:journal-anchor" as const;

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
  | "no_progress_checkpoint";

export interface ProgressAdviceV1 {
  readonly policyVersion: typeof PROGRESS_ADVISOR_POLICY_VERSION_V1;
  readonly kind: ProgressAdviceKindV1;
  readonly sourceFromSeq: number;
  readonly sourceThroughSeq: number;
  readonly modelTurnsWithoutProgress: number;
  readonly delegationAttemptsSinceProgress: number;
  readonly message: string;
  readonly repeatedTool?: Readonly<{ tool: string; count: number }>;
}

/** Pure projection over the current work segment's canonical Journal facts. */
export function projectProgressAdviceV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
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
      entry.fact.type === "tool.settled"
        ? [[entry.fact.callId, entry.fact] as const]
        : [],
    ),
  );
  const calls = entries.flatMap((entry) =>
    entry.fact.type === "tool.call_observed"
      ? [{ seq: entry.seq, fact: entry.fact }]
      : [],
  );
  const passingVerificationCalls = new Set(
    projectCompletionReviewToolEvidenceV1({
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
              : { payload: result.observation.payload }),
          },
        ];
      }),
      latestMutationSeq: 0,
    }).flatMap((evidence) =>
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
    if (
      DELEGATION_TOOLS.has(fact.tool) &&
      result.observation?.isError !== true
    ) {
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

  const kind = noProgressKind(gap);
  if (!kind) return undefined;
  return advice(
    snapshot,
    segmentStart,
    kind,
    gap,
    noProgressMessage(
      kind,
      gap,
      recentToolClasses(calls.map(({ fact }) => fact)),
    ),
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
    (left, right) =>
      left.turn - right.turn || left.throughSeq - right.throughSeq,
  );
  for (const boundary of boundaries) {
    const prefixEntries = snapshot.entries.filter(
      (entry) => entry.seq <= boundary.throughSeq,
    );
    const projected = projectProgressAdviceV1({
      entries: prefixEntries,
      latestInputSeq: boundary.throughSeq,
      tailSeq: boundary.throughSeq,
    });
    if (!projected || !isTimelineThreshold(projected)) continue;
    const key = `${projected.kind}:${projected.sourceThroughSeq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(projected);
    if (events.length >= MAX_TIMELINE_EVENTS) break;
  }
  return Object.freeze(events);
}

function isTimelineThreshold(advice: ProgressAdviceV1): boolean {
  return (
    advice.kind === "exact_repeat" ||
    advice.modelTurnsWithoutProgress === 4 ||
    advice.modelTurnsWithoutProgress === 8 ||
    advice.modelTurnsWithoutProgress === 16
  );
}

function latestSegmentStart(
  snapshot: SessionInputSnapshot<InputFactV1>,
): number {
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
): Exclude<ProgressAdviceKindV1, "exact_repeat"> | undefined {
  if (gap >= 16) return "no_progress_checkpoint";
  if (gap >= 8) return "hypothesis_stale";
  if (gap >= 4) return "inspect_gap";
  return undefined;
}

function noProgressMessage(
  kind: Exclude<ProgressAdviceKindV1, "exact_repeat">,
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
      .sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )
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
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}
