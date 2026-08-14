export type ToolExecutionModeV2 =
  | { readonly kind: "parallel" }
  | { readonly kind: "exclusive"; readonly scope?: readonly string[] };

export interface ScheduledToolCallV2 {
  readonly callId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export type ToolPreparationV2<TPrepared, TResult> =
  | { readonly kind: "dispatch"; readonly prepared: TPrepared }
  | { readonly kind: "settled"; readonly result: TResult };

export interface ToolSchedulerHooksV2<
  TPrepared,
  TResult,
  TCommitted = TResult,
> {
  /** Missing, invalid, or throwing classifiers fail closed to exclusive. */
  readonly classify?: (
    call: ScheduledToolCallV2,
  ) => ToolExecutionModeV2 | undefined;
  /** Ordered preflight: authority/approval may return an explicit result. */
  readonly prepare: (
    call: ScheduledToolCallV2,
    index: number,
  ) => Promise<ToolPreparationV2<TPrepared, TResult>>;
  /** Only tool bodies overlap. This promise must settle to an in-band result. */
  readonly dispatch: (
    prepared: TPrepared,
    call: ScheduledToolCallV2,
    index: number,
  ) => Promise<TResult>;
  /**
   * Ordered finalization boundary. For exclusive calls the barrier remains held
   * until this includes after-effect audit, durable events, and projection.
   */
  readonly commit: (
    call: ScheduledToolCallV2,
    result: TResult,
    index: number,
    mode: ToolExecutionModeV2,
  ) => Promise<TCommitted>;
  /** Produce the explicit ordered result for a call skipped after cancellation. */
  readonly skip: (
    call: ScheduledToolCallV2,
    index: number,
    reason: "aborted_before_dispatch",
  ) => Promise<TResult>;
}

export interface ToolSchedulerOptionsV2 {
  readonly maxParallel?: number;
  readonly signal?: AbortSignal;
}

export interface CommittedToolCallV2<TCommitted> {
  readonly index: number;
  readonly callId: string;
  readonly tool: string;
  readonly mode: ToolExecutionModeV2;
  readonly value: TCommitted;
}

export interface ToolSchedulerResultV2<TCommitted> {
  readonly committed: readonly CommittedToolCallV2<TCommitted>[];
  readonly aborted: boolean;
}

interface SettledSlot<TResult> {
  readonly result: TResult;
  readonly mode: ToolExecutionModeV2;
}

/**
 * Execute one model-ordered tool batch. Parallel-safe bodies may overlap;
 * exclusive calls are barriers; every final result commits in source order.
 */
export async function executeToolBatchV2<TPrepared, TResult, TCommitted>(
  calls: readonly ScheduledToolCallV2[],
  hooks: ToolSchedulerHooksV2<TPrepared, TResult, TCommitted>,
  options: ToolSchedulerOptionsV2 = {},
): Promise<ToolSchedulerResultV2<TCommitted>> {
  assertCalls(calls);
  const maxParallel = options.maxParallel ?? 4;
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
    throw new Error("Tool scheduler maxParallel must be a positive integer");
  }

  const committed: CommittedToolCallV2<TCommitted>[] = [];
  let next = 0;
  while (next < calls.length) {
    if (options.signal?.aborted) {
      await commitSkippedTail(calls, next, hooks, committed);
      return { committed, aborted: true };
    }
    const first = requiredCall(calls, next);
    const mode = safeExecutionMode(hooks.classify, first);
    if (mode.kind === "exclusive") {
      const prepared = await hooks.prepare(first, next);
      const result =
        prepared.kind === "settled"
          ? prepared.result
          : options.signal?.aborted
            ? await hooks.skip(first, next, "aborted_before_dispatch")
            : await hooks.dispatch(prepared.prepared, first, next);
      const value = await hooks.commit(first, result, next, mode);
      committed.push({
        index: next,
        callId: first.callId,
        tool: first.tool,
        mode,
        value,
      });
      next += 1;
      continue;
    }

    const group = await runParallelGroup(
      calls,
      next,
      hooks,
      maxParallel,
      options.signal,
      committed,
    );
    next = group.next;
    if (group.aborted) {
      await commitSkippedTail(calls, next, hooks, committed);
      return { committed, aborted: true };
    }
  }
  return { committed, aborted: false };
}

async function runParallelGroup<TPrepared, TResult, TCommitted>(
  calls: readonly ScheduledToolCallV2[],
  start: number,
  hooks: ToolSchedulerHooksV2<TPrepared, TResult, TCommitted>,
  maxParallel: number,
  signal: AbortSignal | undefined,
  committedOutput: CommittedToolCallV2<TCommitted>[],
): Promise<{ readonly next: number; readonly aborted: boolean }> {
  const slots = new Map<number, SettledSlot<TResult>>();
  const inFlight = new Map<number, Promise<number>>();
  let nextToStart = start;
  let nextToCommit = start;
  let schedulerFailure: unknown;

  const commitReady = async (): Promise<void> => {
    while (slots.has(nextToCommit)) {
      const slot = slots.get(nextToCommit);
      if (!slot) throw new Error("Tool scheduler missing settled slot");
      const call = requiredCall(calls, nextToCommit);
      const value = await hooks.commit(
        call,
        slot.result,
        nextToCommit,
        slot.mode,
      );
      committedOutput.push({
        index: nextToCommit,
        callId: call.callId,
        tool: call.tool,
        mode: slot.mode,
        value,
      });
      slots.delete(nextToCommit);
      nextToCommit += 1;
    }
  };

  const startReadyCalls = async (): Promise<void> => {
    while (
      !signal?.aborted &&
      schedulerFailure === undefined &&
      nextToStart < calls.length &&
      inFlight.size < maxParallel
    ) {
      const call = requiredCall(calls, nextToStart);
      const mode =
        nextToStart === start
          ? { kind: "parallel" as const }
          : safeExecutionMode(hooks.classify, call);
      if (mode.kind !== "parallel") break;
      const index = nextToStart;
      const prepared = await hooks.prepare(call, index);
      nextToStart += 1;
      if (prepared.kind === "settled") {
        slots.set(index, { result: prepared.result, mode });
        await commitReady();
        continue;
      }
      if (signal?.aborted) {
        const result = await hooks.skip(call, index, "aborted_before_dispatch");
        slots.set(index, { result, mode });
        await commitReady();
        continue;
      }
      const body = hooks.dispatch(prepared.prepared, call, index).then(
        (result) => {
          slots.set(index, { result, mode });
          return index;
        },
        (error: unknown) => {
          schedulerFailure ??= error;
          return index;
        },
      );
      inFlight.set(index, body);
    }
  };

  try {
    await startReadyCalls();
    while (inFlight.size > 0) {
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled);
      if (schedulerFailure !== undefined) break;
      await commitReady();
      await startReadyCalls();
    }
  } catch (error) {
    schedulerFailure ??= error;
  }
  if (schedulerFailure !== undefined) {
    await Promise.allSettled(inFlight.values());
    throw schedulerFailure;
  }
  await commitReady();
  return { next: nextToStart, aborted: signal?.aborted === true };
}

async function commitSkippedTail<TPrepared, TResult, TCommitted>(
  calls: readonly ScheduledToolCallV2[],
  start: number,
  hooks: ToolSchedulerHooksV2<TPrepared, TResult, TCommitted>,
  committed: CommittedToolCallV2<TCommitted>[],
): Promise<void> {
  for (let index = start; index < calls.length; index += 1) {
    const call = requiredCall(calls, index);
    const mode = safeExecutionMode(hooks.classify, call);
    const skipped = await hooks.skip(call, index, "aborted_before_dispatch");
    const value = await hooks.commit(call, skipped, index, mode);
    committed.push({
      index,
      callId: call.callId,
      tool: call.tool,
      mode,
      value,
    });
  }
}

function safeExecutionMode(
  classify: ToolSchedulerHooksV2<unknown, unknown>["classify"],
  call: ScheduledToolCallV2,
): ToolExecutionModeV2 {
  try {
    const mode = classify?.(call);
    if (mode?.kind === "parallel") return { kind: "parallel" };
    if (mode?.kind === "exclusive") {
      if (
        mode.scope === undefined ||
        (Array.isArray(mode.scope) &&
          mode.scope.every(
            (path) => typeof path === "string" && path.length > 0,
          ))
      ) {
        return mode.scope
          ? { kind: "exclusive", scope: [...mode.scope] }
          : { kind: "exclusive" };
      }
    }
  } catch {
    // Classification is an authority boundary: ambiguity is exclusive.
  }
  return { kind: "exclusive" };
}

function assertCalls(calls: readonly ScheduledToolCallV2[]): void {
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.callId.trim())
      throw new Error("Tool scheduler callId must not be empty");
    if (!call.tool.trim())
      throw new Error("Tool scheduler tool must not be empty");
    if (ids.has(call.callId)) {
      throw new Error(`Tool scheduler duplicate callId: ${call.callId}`);
    }
    ids.add(call.callId);
  }
}

function requiredCall(
  calls: readonly ScheduledToolCallV2[],
  index: number,
): ScheduledToolCallV2 {
  const call = calls[index];
  if (!call) throw new Error(`Tool scheduler missing call at index ${index}`);
  return call;
}
