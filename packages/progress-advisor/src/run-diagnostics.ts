import type { SessionInputSnapshot } from "@paw/agent-loop";
import { projectCompletionReviewToolEvidenceV1 } from "@paw/completion-review";
import { projectWorkspaceEffect } from "@paw/core";
import type { InputFactV1 } from "@paw/protocol";

import { type ProgressAdviceBudgetV1, projectProgressAdviceTimelineV1 } from "./projector.js";

/**
 * Run-level diagnostics for benchmark accounting (mechanism-matrix).
 *
 * Everything here is a deterministic projection of the durable journal — no
 * model calls. The overthinking-style indicators reuse the same
 * progress-advisor semantics the live loop applies, so a run's report can be
 * compared against what the agent was actually told mid-run
 * (paper basis: The Danger of Overthinking, arXiv 2502.08235 — higher
 * overthinking correlates with lower resolution; measure before governing).
 */
export const RUN_DIAGNOSTICS_POLICY_VERSION_V1 = "paw.run-diagnostics.v1" as const;

export interface RunDiagnosticsV1 {
  readonly policyVersion: typeof RUN_DIAGNOSTICS_POLICY_VERSION_V1;
  /** model.settled count in the snapshot window. */
  readonly modelTurns: number;
  /** Settled turns that produced no tool call (excluding none — counted as-is). */
  readonly textOnlyTurns: number;
  readonly toolCallsSettled: number;
  readonly failedToolCalls: number;
  readonly mutationCalls: number;
  readonly verificationPassed: number;
  readonly verificationFailed: number;
  /** Longest run of consecutive turns with tool activity but no completed
   * mutation, delegation, or passing verification (analysis-paralysis proxy). */
  readonly maxConsecutiveStallTurns: number;
  /** Times the same (tool, args) call repeated back-to-back. */
  readonly exactRepeatCalls: number;
  /** Advice events the live loop would have emitted, by kind. */
  readonly adviceEvents: Readonly<Record<string, number>>;
  readonly completionReviewsClaimed: number;
  readonly completionReviewBlocked: number;
  readonly checkpointsRecorded: number;
}

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

const DELEGATION_TOOLS = new Set(["workspace_delegate", "workspace.run_agent"]);

export function projectRunDiagnosticsV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  budget?: ProgressAdviceBudgetV1,
): RunDiagnosticsV1 {
  const entries = snapshot.entries;
  const settled = new Map<string, Extract<InputFactV1, { type: "tool.settled" }>>();
  for (const entry of entries) {
    if (entry.fact.type === "tool.settled") {
      settled.set(entry.fact.callId, entry.fact);
    }
  }
  const calls = entries.flatMap((entry) =>
    entry.fact.type === "tool.call_observed" ? [{ seq: entry.seq, fact: entry.fact }] : [],
  );

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
            : { payload: result.observation.payload }),
        },
      ];
    }),
    latestMutationSeq: 0,
  });
  const verificationByCall = new Map(
    verificationEvidence.flatMap((evidence) => [[evidence.callId, evidence] as const]),
  );

  let toolCallsSettled = 0;
  let failedToolCalls = 0;
  let mutationCalls = 0;
  let verificationPassed = 0;
  let verificationFailed = 0;
  let exactRepeatCalls = 0;
  const progressingTurns = new Set<number>();
  const turnsWithTools = new Set<number>();
  let previousSignature: string | undefined;

  for (const { fact } of calls) {
    const result = settled.get(fact.callId);
    if (!result) continue;
    toolCallsSettled += 1;
    turnsWithTools.add(fact.turn);
    if (result.status !== "completed") failedToolCalls += 1;
    const signature = `${fact.tool}:${String(fact.args)}`;
    if (signature === previousSignature) exactRepeatCalls += 1;
    previousSignature = signature;
    const evidence = verificationByCall.get(fact.callId);
    if (evidence && evidence.verificationKind !== "none") {
      if (evidence.outcome === "passed") verificationPassed += 1;
      else if (evidence.outcome === "failed") verificationFailed += 1;
    }
    if (
      result.status === "completed" &&
      result.observation?.isError !== true &&
      (MUTATION_TOOLS.has(fact.tool) || DELEGATION_TOOLS.has(fact.tool))
    ) {
      mutationCalls += MUTATION_TOOLS.has(fact.tool) ? 1 : 0;
      progressingTurns.add(fact.turn);
    } else if (evidence && evidence.verificationKind !== "none" && evidence.outcome === "passed") {
      progressingTurns.add(fact.turn);
    } else if (
      result.status === "completed" &&
      result.observation?.isError !== true &&
      projectWorkspaceEffect(fact.tool, result.observation?.payload, false).changed !== false
    ) {
      progressingTurns.add(fact.turn);
    }
  }

  const modelTurnSettledTurns = entries.flatMap((entry) =>
    entry.fact.type === "model.settled" ? [entry.fact.turn] : [],
  );
  const orderedTurns = [...new Set(modelTurnSettledTurns)].sort((left, right) => left - right);
  let maxConsecutiveStallTurns = 0;
  let currentStall = 0;
  for (const turn of orderedTurns) {
    const stalled = turnsWithTools.has(turn) && !progressingTurns.has(turn);
    if (stalled) {
      currentStall += 1;
      maxConsecutiveStallTurns = Math.max(maxConsecutiveStallTurns, currentStall);
    } else {
      currentStall = 0;
    }
  }

  const adviceEvents: Record<string, number> = {};
  for (const advice of projectProgressAdviceTimelineV1(snapshot, budget)) {
    adviceEvents[advice.kind] = (adviceEvents[advice.kind] ?? 0) + 1;
  }

  let completionReviewsClaimed = 0;
  let completionReviewBlocked = 0;
  let checkpointsRecorded = 0;
  for (const entry of entries) {
    const fact = entry.fact;
    if (fact.type === "completion.review_claimed") completionReviewsClaimed += 1;
    else if (fact.type === "completion.review_settled" && fact.verdict !== "allow")
      completionReviewBlocked += 1;
    else if (fact.type === "context.checkpoint_recorded") checkpointsRecorded += 1;
  }

  return Object.freeze({
    policyVersion: RUN_DIAGNOSTICS_POLICY_VERSION_V1,
    modelTurns: orderedTurns.length,
    textOnlyTurns: orderedTurns.filter((turn) => !turnsWithTools.has(turn)).length,
    toolCallsSettled,
    failedToolCalls,
    mutationCalls,
    verificationPassed,
    verificationFailed,
    maxConsecutiveStallTurns,
    exactRepeatCalls,
    adviceEvents: Object.freeze(adviceEvents),
    completionReviewsClaimed,
    completionReviewBlocked,
    checkpointsRecorded,
  });
}
