import { sha256Canonical } from "./canonical.js";
import type {
  PolicyAdviceV2,
  ProgressAdvisorCycleV2,
  ProgressAdvisorStateV2,
  WorkingDecisionStateV2,
} from "./schema.js";

export const PROGRESS_ADVISOR_POLICY_VERSION =
  "paw-progress-advisor-v1" as const;

export interface ProgressAdvisorConfigV2 {
  readonly policyVersion: typeof PROGRESS_ADVISOR_POLICY_VERSION;
  readonly repeatThresholds: readonly number[];
  readonly noDeltaThresholds: Readonly<{
    readonly inspectGap: number;
    readonly changeHypothesis: number;
    readonly safetyWarning: number;
  }>;
}

export const DEFAULT_PROGRESS_ADVISOR_CONFIG_V2: ProgressAdvisorConfigV2 = {
  policyVersion: PROGRESS_ADVISOR_POLICY_VERSION,
  repeatThresholds: [3, 5, 8],
  noDeltaThresholds: {
    inspectGap: 4,
    changeHypothesis: 8,
    safetyWarning: 16,
  },
};

export interface ProgressAdvisorResultV2 {
  readonly state: ProgressAdvisorStateV2;
  readonly advice: readonly PolicyAdviceV2[];
}

export function createProgressAdvisorStateV2(
  runId: string,
): ProgressAdvisorStateV2 {
  if (!runId.trim())
    throw new Error("Progress advisor runId must not be empty");
  return {
    policyVersion: PROGRESS_ADVISOR_POLICY_VERSION,
    runId,
    lastCycle: 0,
    consecutiveNoDeltaCycles: 0,
  };
}

/**
 * Observe one committed model cycle. This function can enrich the next model
 * context, but cannot authorize, deny, cancel, or reorder any tool call.
 */
export function advanceProgressAdvisorV2(
  prior: ProgressAdvisorStateV2,
  cycle: ProgressAdvisorCycleV2,
  decisionState: WorkingDecisionStateV2,
  config: ProgressAdvisorConfigV2 = DEFAULT_PROGRESS_ADVISOR_CONFIG_V2,
): ProgressAdvisorResultV2 {
  validateInputs(prior, cycle, decisionState, config);
  const advice: PolicyAdviceV2[] = [];
  let repeat = prior.repeat;

  for (const action of cycle.actions) {
    if (action.repeatTracking === "transparent") continue;
    const key = sha256Canonical({ tool: action.tool, args: action.args });
    repeat = {
      key,
      tool: action.tool,
      count: repeat?.key === key ? repeat.count + 1 : 1,
    };
    if (config.repeatThresholds.includes(repeat.count)) {
      advice.push(
        repeatAdvice(
          repeat.tool,
          repeat.count,
          recentEvidenceRefs(decisionState),
        ),
      );
    }
  }

  const meaningful = cycle.deltas.some((delta) => delta.meaningful);
  const consecutiveNoDeltaCycles = meaningful
    ? 0
    : prior.consecutiveNoDeltaCycles + 1;
  const evidenceRefs = unique(
    cycle.deltas.flatMap((delta) => delta.evidenceAdded),
  );
  const noDeltaAdvice = stallAdvice(
    consecutiveNoDeltaCycles,
    decisionState,
    config,
    unique([...evidenceRefs, ...recentEvidenceRefs(decisionState)]),
  );
  if (noDeltaAdvice) advice.push(noDeltaAdvice);

  return {
    state: {
      policyVersion: PROGRESS_ADVISOR_POLICY_VERSION,
      runId: prior.runId,
      lastCycle: cycle.cycle,
      consecutiveNoDeltaCycles,
      ...(repeat ? { repeat } : {}),
    },
    advice,
  };
}

function repeatAdvice(
  tool: string,
  count: number,
  evidenceRefs: readonly string[],
): PolicyAdviceV2 {
  const priority = count >= 8 ? "urgent" : count >= 5 ? "warning" : "info";
  return {
    kind: "repeat_observed",
    priority,
    evidenceRefs,
    message: `The exact ${tool} call has occurred ${count} consecutive times. It was observed and not blocked; inspect the latest result, then use materially different evidence or finish if ready.`,
  };
}

function stallAdvice(
  count: number,
  state: WorkingDecisionStateV2,
  config: ProgressAdvisorConfigV2,
  evidenceRefs: readonly string[],
): PolicyAdviceV2 | undefined {
  const thresholds = config.noDeltaThresholds;
  if (count === thresholds.inspectGap) {
    return {
      kind: "evidence_gap",
      priority: "warning",
      evidenceRefs,
      message:
        "No meaningful state or evidence delta has been observed. State the current hypothesis, the missing evidence, and one materially different falsifying action.",
    };
  }
  if (count === thresholds.changeHypothesis) {
    const active = Object.values(state.hypotheses).find(
      (hypothesis) =>
        hypothesis.status === "candidate" || hypothesis.status === "supported",
    );
    return {
      kind: "hypothesis_stale",
      priority: "urgent",
      evidenceRefs: active
        ? unique([...active.supports, ...active.contradicts])
        : evidenceRefs,
      message: active
        ? `The active hypothesis (${active.id}) has not produced progress. Change or reject it and perform a different falsifying action.`
        : "No active hypothesis has produced progress. Record a falsifiable hypothesis and take a materially different action.",
    };
  }
  if (count === thresholds.safetyWarning) {
    return {
      kind: "cost_warning",
      priority: "urgent",
      evidenceRefs,
      message:
        "The configured no-progress safety line has been reached. Preserve the decision state and prepare an honest incomplete/stalled handoff unless new evidence is available.",
    };
  }
  return undefined;
}

function validateInputs(
  prior: ProgressAdvisorStateV2,
  cycle: ProgressAdvisorCycleV2,
  state: WorkingDecisionStateV2,
  config: ProgressAdvisorConfigV2,
): void {
  if (prior.policyVersion !== PROGRESS_ADVISOR_POLICY_VERSION) {
    throw new Error(
      `Unsupported progress advisor policy: ${prior.policyVersion}`,
    );
  }
  if (prior.runId !== state.runId) {
    throw new Error(
      `Progress advisor run mismatch: ${prior.runId} != ${state.runId}`,
    );
  }
  if (config.policyVersion !== PROGRESS_ADVISOR_POLICY_VERSION) {
    throw new Error(
      `Unsupported progress advisor config: ${config.policyVersion}`,
    );
  }
  const expectedCycle = prior.lastCycle + 1;
  if (!Number.isSafeInteger(cycle.cycle) || cycle.cycle !== expectedCycle) {
    throw new Error(
      `Progress advisor cycle must be contiguous; expected ${expectedCycle}, received ${cycle.cycle}`,
    );
  }
  if (state.lastSeq !== cycle.projectedThroughSeq) {
    throw new Error(
      `Progress advisor state/event mismatch: ${state.lastSeq} != ${cycle.projectedThroughSeq}`,
    );
  }
  const repeat = config.repeatThresholds;
  if (
    repeat.length === 0 ||
    repeat.some(
      (value, index) =>
        !Number.isSafeInteger(value) ||
        value < 2 ||
        (index > 0 && value <= (repeat[index - 1] ?? 0)),
    )
  ) {
    throw new Error(
      "Progress advisor repeat thresholds must strictly increase",
    );
  }
  const { inspectGap, changeHypothesis, safetyWarning } =
    config.noDeltaThresholds;
  if (
    !Number.isSafeInteger(inspectGap) ||
    !Number.isSafeInteger(changeHypothesis) ||
    !Number.isSafeInteger(safetyWarning) ||
    inspectGap < 1 ||
    changeHypothesis <= inspectGap ||
    safetyWarning <= changeHypothesis
  ) {
    throw new Error(
      "Progress advisor no-delta thresholds must strictly increase",
    );
  }
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function recentEvidenceRefs(state: WorkingDecisionStateV2): readonly string[] {
  return Object.values(state.evidence)
    .sort(
      (left, right) =>
        right.lastObservedSeq - left.lastObservedSeq ||
        left.id.localeCompare(right.id),
    )
    .slice(0, 3)
    .map((record) => record.id);
}
