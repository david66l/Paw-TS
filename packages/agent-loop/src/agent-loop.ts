import type {
  DerivedDecisionV1,
  InputFactV1,
  ModelDispatchRecordedFactV1,
  ModelSettledFactV1,
  ToolCallObservedFactV1,
  ToolDispatchRecordedFactV1,
  ToolSettledFactV1,
} from "@paw/protocol";
import { parseModelResponseV1 } from "@paw/protocol";
import type {
  AgentLoopDependencies,
  AgentLoopOptions,
  ControlDecision,
  LoopControlState,
  LoopError,
  LoopToolCall,
  ModelSettlement,
  ToolSettlement,
} from "./contracts.js";
import type {
  LoopSafeBoundary,
  SessionInputSnapshot,
  VerifiedModelResponseEvidenceV1,
} from "./ports.js";

const UNKNOWN_MODEL_REASON = "Model execution threw after dispatch intent";
const UNKNOWN_TOOL_REASON = "Tool result was not proven after dispatch intent";

/** Paw Next 的最小、无持久存储实现依赖的 Agent Loop。 */
export async function runAgentLoop<
  TRunConfig,
  TModelRequest,
  TModelStreamEvent,
  TAssistantMessage,
  TToolCall extends LoopToolCall,
  TToolResult,
  TControlState extends LoopControlState,
>(
  dependencies: AgentLoopDependencies<
    TRunConfig,
    TModelRequest,
    TModelStreamEvent,
    TAssistantMessage,
    TToolCall,
    TToolResult,
    TControlState
  >,
  options: AgentLoopOptions = {},
): Promise<TControlState> {
  const signal = options.signal ?? new AbortController().signal;
  if (
    options.loadStartupModelResponseEvidence !== undefined &&
    typeof options.loadStartupModelResponseEvidence !== "function"
  ) {
    throw new Error("Startup model response evidence loader is invalid");
  }
  const loadStartupModelResponseEvidence =
    typeof options.loadStartupModelResponseEvidence === "function"
      ? options.loadStartupModelResponseEvidence.bind(options)
      : undefined;

  const readReduction = async () => {
    if (!dependencies.reducerVersion.trim()) {
      throw new Error("reducerVersion must be a non-empty frozen identifier");
    }
    const snapshot = await dependencies.session.readInputSnapshot();
    const inputFacts = snapshot.entries.map((entry) => entry.fact);
    const state = dependencies.reducer.reduce(
      inputFacts,
      dependencies.runConfig,
    );
    const stateHash = hashControlState(state, dependencies.stateHasher);
    return { snapshot, state, stateHash };
  };

  const materializeDecision = (
    reduction: Awaited<ReturnType<typeof readReduction>>,
  ) => {
    const decision = dependencies.facts.derivedDecision({
      state: reduction.state,
      inputThroughSeq: reduction.snapshot.latestInputSeq,
      stateHash: reduction.stateHash,
      reducerVersion: dependencies.reducerVersion,
    });
    assertDerivedDecisionMatches(
      reduction.snapshot,
      reduction.state.decision,
      reduction.stateHash,
      dependencies.reducerVersion,
      decision,
    );
    return decision;
  };

  const reduceSnapshot = async () => {
    const reduction = await readReduction();
    return { ...reduction, decision: materializeDecision(reduction) };
  };

  const reconcileReduction = async <TProjection>(
    project: (snapshot: SessionInputSnapshot<InputFactV1>) => TProjection,
  ) => {
    while (true) {
      const reduction = await reduceSnapshot();
      const projection = project(reduction.snapshot);
      const committed = await dependencies.session.commitDerivedDecision(
        reduction.snapshot.tailSeq,
        reduction.decision,
      );
      if (committed === "committed") return { ...reduction, projection };
    }
  };

  const reconcile = async (): Promise<TControlState> =>
    (await reconcileReduction(() => undefined)).state;

  const reconcileStartup = async () => {
    const commitAbortObserved = async (
      reduction: Awaited<ReturnType<typeof readReduction>>,
    ): Promise<void> => {
      await dependencies.session.commitInputFacts(reduction.snapshot.tailSeq, [
        dependencies.facts.runAbortObserved({
          reason: abortReason(signal),
        }),
      ]);
    };
    while (true) {
      const reduction = await readReduction();
      if (reduction.state.decision.kind === "continue" && signal.aborted) {
        await commitAbortObserved(reduction);
        continue;
      }
      let modelResponses: VerifiedModelResponseEvidenceV1 | undefined;
      if (
        reduction.state.decision.kind === "continue" &&
        loadStartupModelResponseEvidence
      ) {
        try {
          modelResponses = await loadStartupModelResponseEvidence(
            reduction.snapshot,
            signal,
          );
        } catch (error) {
          if (signal.aborted) {
            await commitAbortObserved(reduction);
            continue;
          }
          throw error;
        }
        if (signal.aborted) {
          await commitAbortObserved(reduction);
          continue;
        }
      }
      const projection =
        reduction.state.decision.kind === "continue"
          ? inspectAgentLoopContinueCursorV1(reduction.snapshot, {
              modelResponses,
            })
          : undefined;
      const decision = materializeDecision(reduction);
      const committed = await dependencies.session.commitDerivedDecision(
        reduction.snapshot.tailSeq,
        decision,
      );
      if (committed === "committed") {
        return { ...reduction, decision, projection };
      }
    }
  };

  const abort = async (
    extraFacts: readonly InputFactV1[] = [],
  ): Promise<TControlState> => {
    await dependencies.session.appendInputFacts([
      ...extraFacts,
      dependencies.facts.runAbortObserved({ reason: abortReason(signal) }),
    ]);
    return reconcile();
  };

  const failRuntime = async (
    area: "input" | "context" | "runtime",
    error: unknown,
  ): Promise<TControlState> => {
    await dependencies.session.appendInputFacts([
      dependencies.facts.runtimeFailed({ area, error: describeError(error) }),
    ]);
    return reconcile();
  };

  // Startup control reconciliation is the first external action. It reads only
  // canonical input facts; persisted DerivedDecision records never feed back
  // into the reducer. Cursor reconstruction is validated before the decision
  // CAS, so a malformed production sequence cannot be extended.
  const startup = await reconcileStartup();
  if (startup.state.decision.kind !== "continue") return startup.state;
  if (!startup.projection) {
    throw new Error("Continuing startup has no canonical loop cursor");
  }
  if (startup.projection.lastModelTurn >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Canonical model turn cannot advance safely");
  }
  let turn = startup.projection.lastModelTurn;
  let nextBoundary = startup.projection.nextBoundary;

  while (true) {
    if (signal.aborted) return abort();

    let request: TModelRequest;
    let preparationArea: "input" | "context" = "input";
    try {
      await dependencies.input.reportSafeBoundary(nextBoundary);
      if (signal.aborted) return abort();

      const promotedInputIds =
        await dependencies.input.consumePromotedInputIds();
      if (signal.aborted) return abort();

      const snapshot = await dependencies.session.readInputSnapshot();
      assertPromotedInputsPersisted(promotedInputIds, snapshot);
      preparationArea = "context";
      request = await dependencies.context.build(snapshot, { signal });
      if (signal.aborted) return abort();
    } catch (error) {
      if (signal.aborted) return abort();
      const state = await failRuntime(preparationArea, error);
      if (state.decision.kind !== "continue") return state;
      continue;
    }

    turn += 1;
    const modelDispatchFact = dependencies.facts.modelRequestIntent({
      turn,
      request,
      runConfig: dependencies.runConfig,
    });
    assertModelDispatchFact(turn, modelDispatchFact);
    await dependencies.session.appendInputFacts([modelDispatchFact]);
    if (signal.aborted) {
      const cancelled: ModelSettlement<TAssistantMessage, TToolCall> = {
        status: "cancelled",
        reason: abortReason(signal),
      };
      const cancelledFact = dependencies.facts.modelSettled({
        turn,
        settlement: cancelled,
      });
      assertModelFactsMatch(
        cancelled,
        modelDispatchFact,
        cancelledFact,
        [],
        [],
      );
      return abort([cancelledFact]);
    }

    const modelSettlement = await settleModelCall(
      dependencies,
      request,
      signal,
    );
    const invalidCalls =
      modelSettlement.status === "success"
        ? invalidToolCalls(modelSettlement.toolCalls)
        : undefined;
    const observedCalls =
      modelSettlement.status === "success" && !invalidCalls
        ? modelSettlement.toolCalls
        : [];

    // 完整响应和全部合法原生工具调用必须作为一个原子事实批出现。
    const modelSettledFact = dependencies.facts.modelSettled({
      turn,
      settlement: modelSettlement,
    });
    const observedFacts = observedCalls.map((call, sourceIndex) =>
      dependencies.facts.toolCallObserved({ turn, sourceIndex, call }),
    );
    assertModelFactsMatch(
      modelSettlement,
      modelDispatchFact,
      modelSettledFact,
      observedCalls,
      observedFacts,
    );
    await dependencies.session.appendInputFacts([
      modelSettledFact,
      ...observedFacts,
    ]);

    if (invalidCalls) {
      const state = await failRuntime("runtime", invalidCalls);
      if (state.decision.kind !== "continue") return state;
      nextBoundary = "after_model_turn_without_tool_calls";
      continue;
    }

    if (signal.aborted) {
      return abort(cancelObservedCalls(dependencies, turn, observedCalls));
    }

    if (modelSettlement.status !== "success") {
      const state = await reconcile();
      if (state.decision.kind !== "continue") return state;
      nextBoundary = "after_model_turn_without_tool_calls";
      continue;
    }

    if (observedCalls.length === 0) {
      const state = await reconcile();
      if (state.decision.kind !== "continue") return state;
      nextBoundary = "after_model_turn_without_tool_calls";
      continue;
    }

    const authorization = await authorizeObservedCalls(
      dependencies,
      turn,
      observedCalls,
      observedFacts,
      reduceSnapshot,
      reconcile,
    );
    if (!authorization.dispatch) {
      if (authorization.state.decision.kind !== "continue") {
        return authorization.state;
      }
      nextBoundary = "after_tool_batch_settled";
      continue;
    }
    if (signal.aborted) {
      return abort(cancelObservedCalls(dependencies, turn, observedCalls));
    }

    const settlements = await settleToolBatch(
      dependencies,
      turn,
      observedCalls,
      signal,
    );
    await dependencies.session.appendInputFacts(
      settlements.map((settlement, sourceIndex) => {
        const call = observedCalls[sourceIndex];
        if (!call) throw new Error("Tool settlement has no source call");
        const fact = dependencies.facts.toolSettled({
          turn,
          sourceIndex,
          call,
          settlement,
        });
        assertToolSettledFact(call, settlement, fact);
        return fact;
      }),
    );

    if (signal.aborted) return abort();
    const state = await reconcile();
    if (state.decision.kind !== "continue") return state;
    nextBoundary = "after_tool_batch_settled";
  }
}

async function authorizeObservedCalls<
  TRunConfig,
  TModelRequest,
  TModelStreamEvent,
  TAssistantMessage,
  TToolCall extends LoopToolCall,
  TToolResult,
  TControlState extends LoopControlState,
>(
  dependencies: AgentLoopDependencies<
    TRunConfig,
    TModelRequest,
    TModelStreamEvent,
    TAssistantMessage,
    TToolCall,
    TToolResult,
    TControlState
  >,
  turn: number,
  calls: readonly TToolCall[],
  observedFacts: readonly ToolCallObservedFactV1[],
  reduceSnapshot: () => Promise<{
    snapshot: SessionInputSnapshot<InputFactV1>;
    state: TControlState;
    decision: DerivedDecisionV1;
  }>,
  reconcile: () => Promise<TControlState>,
): Promise<{ readonly dispatch: boolean; readonly state: TControlState }> {
  while (true) {
    const reduction = await reduceSnapshot();
    if (reduction.state.decision.kind !== "continue") {
      await dependencies.session.appendInputFacts(
        cancelObservedCalls(dependencies, turn, calls),
      );
      return { dispatch: false, state: await reconcile() };
    }
    const dispatchFacts = calls.map((call, sourceIndex) =>
      dependencies.facts.toolDispatchIntent({ turn, sourceIndex, call }),
    );
    assertToolDispatchFacts(calls, observedFacts, dispatchFacts);
    const committed = await dependencies.session.commitDecisionAndInputFacts(
      reduction.snapshot.tailSeq,
      reduction.decision,
      dispatchFacts,
    );
    if (committed === "committed") {
      return { dispatch: true, state: reduction.state };
    }
  }
}

function cancelObservedCalls<
  TRunConfig,
  TModelRequest,
  TModelStreamEvent,
  TAssistantMessage,
  TToolCall extends LoopToolCall,
  TToolResult,
  TControlState extends LoopControlState,
>(
  dependencies: AgentLoopDependencies<
    TRunConfig,
    TModelRequest,
    TModelStreamEvent,
    TAssistantMessage,
    TToolCall,
    TToolResult,
    TControlState
  >,
  turn: number,
  calls: readonly TToolCall[],
): readonly InputFactV1[] {
  return calls.map((call, sourceIndex) => {
    const settlement = {
      status: "cancelled" as const,
      callId: call.id,
      reason: "Control reducer blocked tool dispatch",
    };
    const fact = dependencies.facts.toolSettled({
      turn,
      sourceIndex,
      call,
      settlement,
    });
    assertToolSettledFact(call, settlement, fact);
    return fact;
  });
}

async function settleModelCall<
  TRunConfig,
  TModelRequest,
  TModelStreamEvent,
  TAssistantMessage,
  TToolCall extends LoopToolCall,
  TToolResult,
  TControlState extends LoopControlState,
>(
  dependencies: AgentLoopDependencies<
    TRunConfig,
    TModelRequest,
    TModelStreamEvent,
    TAssistantMessage,
    TToolCall,
    TToolResult,
    TControlState
  >,
  request: TModelRequest,
  signal: AbortSignal,
): Promise<ModelSettlement<TAssistantMessage, TToolCall>> {
  try {
    return await dependencies.model.execute(request, {
      signal,
      onStreamEvent: async (event) => {
        await dependencies.onModelStreamEvent?.(event);
      },
    });
  } catch (error) {
    const description = describeError(error);
    return {
      status: "unknown",
      reason: `${UNKNOWN_MODEL_REASON}: ${description.message}`,
    };
  }
}

async function settleToolBatch<
  TRunConfig,
  TModelRequest,
  TModelStreamEvent,
  TAssistantMessage,
  TToolCall extends LoopToolCall,
  TToolResult,
  TControlState extends LoopControlState,
>(
  dependencies: AgentLoopDependencies<
    TRunConfig,
    TModelRequest,
    TModelStreamEvent,
    TAssistantMessage,
    TToolCall,
    TToolResult,
    TControlState
  >,
  turn: number,
  calls: readonly TToolCall[],
  signal: AbortSignal,
): Promise<readonly ToolSettlement<TToolResult>[]> {
  let returned: readonly ToolSettlement<TToolResult>[];
  try {
    returned = await dependencies.tools.executeSettled(calls, {
      signal,
      turn,
    });
  } catch (error) {
    const description = describeError(error);
    return calls.map((call) => unknownToolSettlement(call, description));
  }

  const sourceIds = new Set(calls.map((call) => call.id));
  const unexpected = returned.find(
    (settlement) => !sourceIds.has(settlement.callId),
  );
  if (unexpected) {
    const error = {
      name: "UnexpectedToolSettlement",
      message: `Tool executor returned unknown call ID: ${unexpected.callId}`,
    };
    return calls.map((call) => unknownToolSettlement(call, error));
  }

  const byCallId = new Map<string, ToolSettlement<TToolResult>[]>();
  for (const settlement of returned) {
    const matches = byCallId.get(settlement.callId) ?? [];
    matches.push(settlement);
    byCallId.set(settlement.callId, matches);
  }
  const sourceIdCounts = new Map<string, number>();
  for (const call of calls) {
    sourceIdCounts.set(call.id, (sourceIdCounts.get(call.id) ?? 0) + 1);
  }

  return calls.map((call) => {
    const matches = byCallId.get(call.id) ?? [];
    const onlyMatch = matches[0];
    if (
      sourceIdCounts.get(call.id) === 1 &&
      matches.length === 1 &&
      onlyMatch
    ) {
      return onlyMatch;
    }
    return unknownToolSettlement(call, {
      name: "AmbiguousToolSettlement",
      message:
        matches.length === 0
          ? "Tool executor returned no settlement for this call"
          : "Tool executor returned ambiguous settlements for this call",
    });
  });
}

function assertPromotedInputsPersisted(
  inputIds: readonly string[],
  snapshot: SessionInputSnapshot<InputFactV1>,
): void {
  const unique = new Set(inputIds);
  if (unique.size !== inputIds.length || inputIds.some((id) => !id.trim())) {
    throw new Error("Promoted input IDs must be non-empty and unique");
  }
  const persisted = new Set(
    snapshot.entries.flatMap((entry) =>
      entry.fact.type === "input.promoted" ? [entry.fact.inputId] : [],
    ),
  );
  for (const inputId of inputIds) {
    if (!persisted.has(inputId)) {
      throw new Error(
        `Promoted input ${inputId} is not present in the canonical session`,
      );
    }
  }
}

export interface AgentLoopContinueCursorV1 {
  readonly lastModelTurn: number;
  readonly nextBoundary: LoopSafeBoundary;
}

export interface InspectAgentLoopContinueCursorOptionsV1 {
  readonly modelResponses?: VerifiedModelResponseEvidenceV1;
}

/**
 * Pure proof that a continuing canonical prefix has one resumable Loop cursor.
 * Product startup classification reuses this exact check before taking a lease.
 */
export function inspectAgentLoopContinueCursorV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  options: InspectAgentLoopContinueCursorOptionsV1 = {},
): AgentLoopContinueCursorV1 {
  const modelResponses = captureModelResponseEvidence(options.modelResponses);
  modelResponses?.assertSnapshot(snapshot);
  const dispatches = snapshot.entries.flatMap((entry) =>
    entry.fact.type === "model.dispatch_recorded" ? [entry.fact] : [],
  );
  const modelCallIds = new Set<string>();
  dispatches.forEach((dispatch, index) => {
    const expectedTurn = index + 1;
    if (
      dispatch.turn !== expectedTurn ||
      modelCallIds.has(dispatch.modelCallId)
    ) {
      throw new Error(
        "Canonical model dispatch turns must be unique and contiguous from turn 1",
      );
    }
    modelCallIds.add(dispatch.modelCallId);
  });
  if (dispatches.length === 0) {
    return {
      lastModelTurn: 0,
      nextBoundary: "before_first_model_request",
    };
  }
  const latestSegmentMarkerSeq = snapshot.entries.reduce(
    (latest, entry) =>
      entry.fact.type === "work.segment_started" ? entry.seq : latest,
    0,
  );
  const settledCallIds = new Set(
    snapshot.entries.flatMap((entry) =>
      entry.fact.type === "tool.settled" ? [entry.fact.callId] : [],
    ),
  );
  const observedByModel = new Map<string, ToolCallObservedFactV1[]>();
  const observedCallIds = new Set<string>();
  for (const entry of snapshot.entries) {
    if (entry.fact.type !== "tool.call_observed") continue;
    if (!modelCallIds.has(entry.fact.modelCallId)) {
      throw new Error("Canonical tool observation has no model dispatch");
    }
    if (observedCallIds.has(entry.fact.callId)) {
      throw new Error("Canonical tool call identities must be unique");
    }
    observedCallIds.add(entry.fact.callId);
    const calls = observedByModel.get(entry.fact.modelCallId) ?? [];
    calls.push(entry.fact);
    observedByModel.set(entry.fact.modelCallId, calls);
  }
  for (const dispatch of dispatches) {
    const settlements = snapshot.entries.flatMap((entry) =>
      entry.fact.type === "model.settled" &&
      entry.fact.modelCallId === dispatch.modelCallId
        ? [entry.fact]
        : [],
    );
    if (settlements.length !== 1) {
      throw new Error(
        `Canonical model turn ${dispatch.turn} is not settled exactly once`,
      );
    }
    const settlement = settlements[0] as ModelSettledFactV1;
    const observed = observedByModel.get(dispatch.modelCallId) ?? [];
    if (
      settlement.turn !== dispatch.turn ||
      observed.some(
        (call, index) => call.turn !== dispatch.turn || call.order !== index,
      )
    ) {
      throw new Error(
        `Canonical model turn ${dispatch.turn} has inconsistent lifecycle identity`,
      );
    }
    if (observed.length > 0 && settlement.status !== "completed") {
      throw new Error(
        `Canonical model turn ${dispatch.turn} has non-production tool observations`,
      );
    }
    if (observed.some((call) => !settledCallIds.has(call.callId))) {
      throw new Error(
        `Canonical model turn ${dispatch.turn} has an unsettled tool batch`,
      );
    }
  }
  const segmentDispatches = snapshot.entries.flatMap((entry) =>
    entry.seq > latestSegmentMarkerSeq &&
    entry.fact.type === "model.dispatch_recorded"
      ? [entry.fact]
      : [],
  );
  const latestGlobalDispatch = dispatches.at(-1) as ModelDispatchRecordedFactV1;
  if (segmentDispatches.length === 0) {
    return {
      lastModelTurn: latestGlobalDispatch.turn,
      nextBoundary: "before_first_model_request",
    };
  }
  const latestDispatch = segmentDispatches.at(
    -1,
  ) as ModelDispatchRecordedFactV1;
  const observed = observedByModel.get(latestDispatch.modelCallId) ?? [];
  const latestSettlementEntry = snapshot.entries.find(
    (entry) =>
      entry.fact.type === "model.settled" &&
      entry.fact.modelCallId === latestDispatch.modelCallId,
  );
  if (
    !latestSettlementEntry ||
    latestSettlementEntry.fact.type !== "model.settled"
  ) {
    throw new Error("Canonical latest model turn has no settlement");
  }
  assertLatestModelObservations(
    latestSettlementEntry.seq,
    latestSettlementEntry.fact,
    observed,
    snapshot,
    modelResponses,
  );
  return {
    lastModelTurn: latestDispatch.turn,
    nextBoundary:
      observed.length > 0
        ? "after_tool_batch_settled"
        : "after_model_turn_without_tool_calls",
  };
}

function captureModelResponseEvidence(
  evidence: VerifiedModelResponseEvidenceV1 | undefined,
): VerifiedModelResponseEvidenceV1 | undefined {
  if (evidence === undefined) return undefined;
  if (
    !evidence ||
    typeof evidence.assertSnapshot !== "function" ||
    typeof evidence.requireModelResponse !== "function"
  ) {
    throw new Error("Verified model response evidence port is invalid");
  }
  return Object.freeze({
    assertSnapshot: evidence.assertSnapshot.bind(evidence),
    requireModelResponse: evidence.requireModelResponse.bind(evidence),
  });
}

function assertLatestModelObservations(
  carrierSeq: number,
  settlement: ModelSettledFactV1,
  observed: readonly ToolCallObservedFactV1[],
  snapshot: SessionInputSnapshot<InputFactV1>,
  modelResponses?: VerifiedModelResponseEvidenceV1,
): void {
  if (!settlement.response) return;
  const response = modelResponses
    ? modelResponses.requireModelResponse({
        snapshot,
        carrierSeq,
        modelCallId: settlement.modelCallId,
        payload: settlement.response,
      })
    : settlement.response.kind === "inline"
      ? parseModelResponseV1(settlement.response.value)
      : undefined;
  if (!response) {
    throw new Error(
      "Canonical artifact-backed model response requires exact verified evidence",
    );
  }
  if (settlement.hasToolCalls !== response.toolCalls.length > 0) {
    throw new Error("Canonical model response has a tool-call flag drift");
  }
  if (settlement.status !== "completed") {
    if (observed.length > 0) {
      throw new Error(
        "Canonical non-completed inline model response has tool observations",
      );
    }
    return;
  }
  if (response.toolCalls.some((call) => !call.argumentsValid)) {
    if (observed.length > 0) {
      throw new Error(
        "Canonical invalid native tool batch has executable observations",
      );
    }
    throw new Error(
      "Canonical invalid native tool batch has no resumable safe boundary, regardless of runtime.failed evidence",
    );
  }
  if (response.toolCalls.length !== observed.length) {
    throw new Error(
      "Canonical inline model response has an incomplete tool observation batch",
    );
  }
  response.toolCalls.forEach((call, index) => {
    const fact = observed[index];
    if (
      !fact ||
      call.callId !== fact.callId ||
      call.name !== fact.tool ||
      call.sourceIndex !== fact.order ||
      !sameJsonValue(call.args, fact.args)
    ) {
      throw new Error(
        `Canonical inline model tool observation ${index} has identity drift`,
      );
    }
  });
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function invalidToolCalls(
  calls: readonly LoopToolCall[],
): LoopError | undefined {
  const ids = new Set<string>();
  for (const call of calls) {
    if (!call.id.trim() || !call.name.trim()) {
      return {
        name: "InvalidToolCall",
        message: "Tool call ID and name must be non-empty",
      };
    }
    if (ids.has(call.id)) {
      return {
        name: "DuplicateToolCall",
        message: `Duplicate tool call ID: ${call.id}`,
      };
    }
    if (call.argumentsValid === false) {
      return {
        name: "InvalidToolArguments",
        message: `Tool call arguments failed adapter validation: ${call.id}`,
      };
    }
    ids.add(call.id);
  }
  return undefined;
}

function assertModelFactsMatch<
  TAssistantMessage,
  TToolCall extends LoopToolCall,
>(
  settlement: ModelSettlement<TAssistantMessage, TToolCall>,
  dispatchFact: ModelDispatchRecordedFactV1,
  modelFact: ModelSettledFactV1,
  observedCalls: readonly TToolCall[],
  observedFacts: readonly ToolCallObservedFactV1[],
): void {
  if (
    modelFact.modelCallId !== dispatchFact.modelCallId ||
    modelFact.turn !== dispatchFact.turn
  ) {
    throw new Error(
      "Model settlement identity does not match its dispatch intent",
    );
  }
  const expectedStatus =
    settlement.status === "success" ? undefined : settlement.status;
  if (
    settlement.status === "success" &&
    modelFact.status !== "completed" &&
    modelFact.status !== "truncated"
  ) {
    throw new Error("Successful model settlement mapped to a non-success fact");
  }
  if (expectedStatus && modelFact.status !== expectedStatus) {
    throw new Error(
      "Model settlement status does not match its canonical fact",
    );
  }
  if (settlement.status === "success" || settlement.status === "truncated") {
    if (!modelFact.response) {
      throw new Error(
        "Completed or truncated model settlement requires a response payload",
      );
    }
    if (modelFact.hasToolCalls !== settlement.toolCalls.length > 0) {
      throw new Error(
        "Model settlement tool-call flag does not match the response",
      );
    }
  }
  if (
    settlement.status === "truncated" &&
    modelFact.finishReason !== settlement.finishReason
  ) {
    throw new Error(
      "Truncated model settlement finishReason does not match its canonical fact",
    );
  }
  if (settlement.status === "truncated" && observedFacts.length > 0) {
    throw new Error("Truncated model tool calls cannot be authorized");
  }
  if (observedCalls.length !== observedFacts.length) {
    throw new Error(
      "Every valid model tool call must have one observation fact",
    );
  }
  observedCalls.forEach((call, index) => {
    const fact = observedFacts[index];
    if (
      !fact ||
      fact.callId !== call.id ||
      fact.tool !== call.name ||
      fact.order !== index ||
      fact.turn !== modelFact.turn ||
      fact.modelCallId !== modelFact.modelCallId
    ) {
      throw new Error(
        "Tool observation fact does not preserve native call identity",
      );
    }
  });
}

function assertModelDispatchFact(
  turn: number,
  fact: ModelDispatchRecordedFactV1,
): void {
  if (fact.turn !== turn || !fact.modelCallId.trim()) {
    throw new Error("Model dispatch fact does not preserve loop turn identity");
  }
}

function assertToolDispatchFacts<TToolCall extends LoopToolCall>(
  calls: readonly TToolCall[],
  observedFacts: readonly ToolCallObservedFactV1[],
  dispatchFacts: readonly ToolDispatchRecordedFactV1[],
): void {
  const batchIds = new Set(dispatchFacts.map((fact) => fact.batchId));
  const modes = new Set(dispatchFacts.map((fact) => fact.mode));
  if (
    dispatchFacts.length !== calls.length ||
    observedFacts.length !== calls.length ||
    batchIds.size !== 1 ||
    modes.size !== 1
  ) {
    throw new Error("Tool dispatch facts do not describe one complete batch");
  }
  calls.forEach((call, index) => {
    if (
      observedFacts[index]?.callId !== call.id ||
      observedFacts[index]?.turn !== dispatchFacts[index]?.turn ||
      dispatchFacts[index]?.callId !== call.id ||
      dispatchFacts[index]?.sourceIndex !== index
    ) {
      throw new Error(
        "Tool dispatch identity does not match the observed call",
      );
    }
  });
}

function assertToolSettledFact<TToolResult>(
  call: LoopToolCall,
  settlement: ToolSettlement<TToolResult>,
  fact: ToolSettledFactV1,
): void {
  const expectedStatus =
    settlement.status === "success"
      ? "completed"
      : settlement.status === "denied"
        ? "rejected"
        : settlement.status;
  if (fact.callId !== call.id || fact.callId !== settlement.callId) {
    throw new Error("Tool settlement identity does not match the active call");
  }
  if (fact.status !== expectedStatus) {
    throw new Error("Tool settlement status does not match the canonical fact");
  }
}

function assertDerivedDecisionMatches(
  snapshot: SessionInputSnapshot<InputFactV1>,
  state: ControlDecision,
  stateHash: string,
  reducerVersion: string,
  decision: DerivedDecisionV1,
): void {
  if (decision.inputThroughSeq !== snapshot.latestInputSeq) {
    throw new Error(
      "Derived decision inputThroughSeq does not match the latest input fact",
    );
  }
  if (decision.stateHash !== stateHash) {
    throw new Error(
      "Derived decision stateHash does not match the canonical reducer state",
    );
  }
  if (decision.reducerVersion !== reducerVersion) {
    throw new Error(
      "Derived decision reducerVersion does not match the frozen reducer version",
    );
  }
  const matches =
    (state.kind === "continue" && decision.action.kind === "continue") ||
    (state.kind === "await_user" &&
      decision.action.kind === "wait" &&
      decision.action.waitFor === "user") ||
    (state.kind === "await_external" &&
      decision.action.kind === "wait" &&
      decision.action.waitFor === "external") ||
    (state.kind === "completed" && decision.action.kind === "complete") ||
    (state.kind === "incomplete" && decision.action.kind === "incomplete") ||
    (state.kind === "failed" && decision.action.kind === "failed") ||
    (state.kind === "aborted" && decision.action.kind === "abort");
  if (!matches) {
    throw new Error("Derived decision action does not match reducer state");
  }
  if (
    state.kind !== "continue" &&
    decision.action.reasonCode !== state.reason
  ) {
    throw new Error("Derived decision reason does not match reducer state");
  }
}

function hashControlState<TControlState extends LoopControlState>(
  state: TControlState,
  stateHasher: { hash(state: TControlState): string },
): string {
  const stateHash = stateHasher.hash(state);
  if (!stateHash.trim()) {
    throw new Error("StateHasher must return a non-empty canonical state hash");
  }
  return stateHash;
}

function unknownToolSettlement<TToolResult>(
  call: LoopToolCall,
  error: LoopError,
): ToolSettlement<TToolResult> {
  return {
    status: "unknown",
    callId: call.id,
    reason: `${UNKNOWN_TOOL_REASON}: ${error.message}`,
  };
}

function describeError(error: unknown): LoopError {
  if (error instanceof Error)
    return { name: error.name, message: error.message };
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

function abortReason(signal: AbortSignal): string {
  if (signal.reason instanceof Error) return signal.reason.message;
  if (signal.reason !== undefined) return String(signal.reason);
  return "Run aborted";
}
