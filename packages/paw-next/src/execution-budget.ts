import type { LoopInputPort, SessionInputSnapshot } from "@paw/agent-loop";
import type { InputFactV1 } from "@paw/protocol";
import type { JournalContextAnnotationV1 } from "@paw/runtime";

export interface ExecutionDeadlineV1 {
  /** Absolute host deadline, shared with the caller's cancellation signal. */
  readonly deadlineAtMs: number;
  readonly reserveMs: number;
  readonly admissionPolicy?: "recent_round_floor_v1";
}
type Observation = Extract<InputFactV1, { type: "execution.budget_observed" }>;

export function assertExecutionDeadlineV1(value: ExecutionDeadlineV1): void {
  if (value.admissionPolicy !== undefined && value.admissionPolicy !== "recent_round_floor_v1")
    throw new Error("Invalid execution admission policy");
  for (const n of [value.deadlineAtMs, value.reserveMs])
    if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid execution deadline");
}

/** Conservative empirical floor, not a latency prediction: the fastest of the
 * last five completed model+tool rounds in this work item. No prior round means
 * no rejection. Persisted clock observations make recovery/replay identical. */
export function executionRequestFloorMsV1(snapshot: SessionInputSnapshot<InputFactV1>): number {
  const inputId = scope(snapshot);
  const rounds: number[] = [];
  let start: number | undefined;
  let completed = false;
  for (const { fact } of snapshot.entries) {
    if (fact.type === "execution.budget_observed" && fact.inputId === inputId) {
      if (start !== undefined && completed && fact.observedAtMs > start)
        rounds.push(fact.observedAtMs - start);
      start = fact.observedAtMs;
      completed = false;
    } else if (
      start !== undefined &&
      fact.type === "model.settled" &&
      fact.status === "completed"
    ) {
      completed = true;
    }
  }
  return rounds.length ? Math.min(...rounds.slice(-5)) : 0;
}

function scope(snapshot: SessionInputSnapshot<InputFactV1>): string | undefined {
  for (let i = snapshot.entries.length - 1; i >= 0; i--) {
    const fact = snapshot.entries[i]!.fact;
    if (fact.type === "work.segment_started") return fact.inputId;
    if (fact.type === "input.promoted" && fact.delivery === "initial") return fact.inputId;
  }
}
function latest(snapshot: SessionInputSnapshot<InputFactV1>) {
  const id = scope(snapshot);
  for (let i = snapshot.entries.length - 1; i >= 0; i--) {
    const entry = snapshot.entries[i]!;
    if (entry.fact.type === "execution.budget_observed" && entry.fact.inputId === id)
      return { ...entry, fact: entry.fact as Observation };
  }
}

/** Clock I/O occurs only at a host safe boundary and is persisted before Context.
 * Recovery reuses the absolute deadline; a backwards clock cannot regain time.
 * An unbounded run writes nothing and gets no invented time limit.
 */
export function withExecutionBudgetInputV1(
  delegate: LoopInputPort,
  session: {
    readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>>;
    appendInputFacts(facts: readonly InputFactV1[]): Promise<void>;
  },
  supplied: ExecutionDeadlineV1 | undefined,
  now: () => number = Date.now,
): LoopInputPort {
  if (supplied) assertExecutionDeadlineV1(supplied);
  return {
    consumePromotedInputIds: () => delegate.consumePromotedInputIds(),
    async reportSafeBoundary(boundary) {
      await delegate.reportSafeBoundary(boundary);
      const snapshot = await session.readInputSnapshot();
      const previous = latest(snapshot)?.fact;
      const deadline = previous ?? supplied;
      if (!deadline) return;
      if (
        previous &&
        supplied &&
        (previous.deadlineAtMs !== supplied.deadlineAtMs ||
          previous.reserveMs !== supplied.reserveMs ||
          previous.admissionPolicy !== supplied.admissionPolicy)
      )
        throw new Error("Execution deadline changed during recovery");
      const inputId = scope(snapshot);
      if (!inputId) throw new Error("Execution budget requires a promoted work item");
      const current = now();
      if (!Number.isSafeInteger(current) || current < 0)
        throw new Error("Invalid execution budget clock");
      const observedAtMs = Math.max(current, previous?.observedAtMs ?? 0);
      if (!previous || previous.observedAtMs !== observedAtMs)
        await session.appendInputFacts([
          {
            type: "execution.budget_observed",
            inputId,
            deadlineAtMs: deadline.deadlineAtMs,
            reserveMs: deadline.reserveMs,
            ...(deadline.admissionPolicy ? { admissionPolicy: deadline.admissionPolicy } : {}),
            observedAtMs,
          },
        ]);
      if (observedAtMs >= deadline.deadlineAtMs) throw new Error("ExecutionDeadlineExceeded");
      if (deadline.admissionPolicy === "recent_round_floor_v1") {
        const currentSnapshot = await session.readInputSnapshot();
        const floor = executionRequestFloorMsV1(currentSnapshot);
        if (deadline.deadlineAtMs - observedAtMs < floor)
          throw new Error(
            `ExecutionBudgetInsufficientForRequest: remaining=${deadline.deadlineAtMs - observedAtMs}ms, recentRoundFloor=${floor}ms`,
          );
      }
    },
  };
}

/** Pure replay: do not consult a live clock while projecting a saved request. */
export function projectExecutionBudgetV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
): JournalContextAnnotationV1 | undefined {
  const entry = latest(snapshot);
  if (!entry) return;
  const remainingMs = Math.max(0, entry.fact.deadlineAtMs - entry.fact.observedAtMs);
  const closeout = remainingMs <= entry.fact.reserveMs;
  return {
    sourceThroughSeq: entry.seq,
    placement: "tail",
    content: `[Paw execution budget v1] Host-observed remaining time: ${Math.ceil(remainingMs / 1000)} seconds at this request boundary. This decreases while the model and tools run. ${
      closeout
        ? "The verification and delivery reserve has been reached. Preserve completed work. Prioritize a direct check through the requested user-facing entry point, repair concrete failures, and cover missing required deliverables. Do not expand scope or claim unfinished requirements are complete. Report remaining gaps if the budget cannot cover them."
        : "Make incremental progress on the smallest useful end-to-end path. Allow time for its direct verification, remaining required deliverables and completion review; model-call allowance is not remaining wall time."
    } This observation changes no requirements or permissions.`,
  };
}
