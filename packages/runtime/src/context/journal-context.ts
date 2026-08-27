import type { PortCallOptions, SessionInputSnapshot } from "@paw/agent-loop";
import type {
  Attachment,
  ChatMessage,
  ModelContextSectionV1,
  ModelRequestV1,
  NativeToolTurnResultV2,
  NativeToolTurnV2,
  ToolDefinition,
} from "@paw/core";
import { materializeModelRequestMessagesV1 } from "@paw/core";
import {
  type ContextCheckpointRecordedFactV1,
  type DurableJsonPayloadV1,
  type InputFactV1,
  type JsonValue,
  type ModelResponseToolCallV1,
  type ModelResponseV1,
  type ModelSettledFactV1,
  type TaskCheckpointItemV1,
  type TaskCheckpointV1,
  type ToolCallObservedFactV1,
  type ToolObservationV1,
  type ToolSettledFactV1,
  parseModelResponseV1,
  parseTaskCheckpointV1,
  parseToolObservationV1,
} from "@paw/protocol";
import type { CanonicalDurableJsonPayloadLocationV1 } from "../payload/canonical-payload-binding.js";
import { assertCanonicalModelResponseCarrierV1 } from "../payload/verified-canonical-payload-index.js";
import type { VerifiedCanonicalPayloadEvidenceV1 } from "../payload/verified-model-response-evidence.js";
import { projectRuntimeActivitiesV1 } from "../tools/managed-job-controller.js";
import { projectLatestWorkSegmentBoundaryV1 } from "../work-segment-boundary.js";
import {
  canonicalJsonStringifyV1,
  immutableCanonicalJsonCloneV1,
} from "./canonical-json.js";
import type {
  JournalContextPlanV1,
  JournalContextPlannerV1,
  JournalContextRuntimeV1,
} from "./journal-context-plan.js";

/** Artifact access and content hashing are injected; Context owns neither. */
export interface DurablePayloadResolverV1 {
  resolve(
    payload: DurableJsonPayloadV1,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  hash(value: JsonValue): string | Promise<string>;
}

/** Provider-specific token estimator selected once for one run. */
export interface ContextTokenEstimatorV1 {
  count(text: string): number;
  countMessages(messages: readonly ChatMessage[]): number;
}

export interface ToolObservationProjectionInputV1 {
  readonly callId: string;
  readonly tool: string;
  readonly carrierSeq: number;
  readonly status: ToolSettledFactV1["status"];
  readonly isError: boolean;
  readonly summary: string;
  readonly payload: DurableJsonPayloadV1;
  readonly value: JsonValue;
}

/** Optional model-view projection; canonical Journal evidence stays unchanged. */
export interface ToolObservationProjectorV1 {
  project(
    input: ToolObservationProjectionInputV1,
    signal: AbortSignal,
  ): JsonValue | Promise<JsonValue>;
}

/**
 * Frozen hard/soft request budget.
 *
 * The output reserve is never offered to input context. The estimation margin
 * is a soft buffer: protected evidence may consume it, but may never cross the
 * provider's hard input limit.
 */
export interface JournalContextBudgetV1 {
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly estimationMarginTokens: number;
  readonly estimatorId: string;
  readonly estimatorVersion: string;
  readonly estimator: ContextTokenEstimatorV1;
}

/** Frozen request fields plus the only external evidence resolver. */
export interface JournalContextOptionsV1 {
  readonly payloads: DurablePayloadResolverV1;
  /** Loaded once for each exact build snapshot; required for artifact payloads. */
  readonly loadPayloadEvidence?: (
    snapshot: SessionInputSnapshot<InputFactV1>,
    signal: AbortSignal,
  ) =>
    | VerifiedCanonicalPayloadEvidenceV1
    | Promise<VerifiedCanonicalPayloadEvidenceV1>;
  readonly toolObservationProjector?: ToolObservationProjectorV1;
  /** One run freezes one provider protocol; native reasoning cannot cross it. */
  readonly providerProtocol: ModelResponseV1["providerProtocol"];
  readonly system?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly budget: JournalContextBudgetV1;
  readonly thinkingEnabled?: boolean;
}

/**
 * Fresh, deterministic Runtime Context over one canonical InputFact snapshot.
 * It has no Session write capability and keeps model/tool turns atomic.
 */
export function createJournalContextV1(
  options: JournalContextOptionsV1,
): JournalContextRuntimeV1 {
  const planner = createJournalContextPlannerV1(options);
  return {
    plan: planner.plan.bind(planner),
    async build(snapshot, callOptions) {
      return (await planner.plan(snapshot, callOptions)).request;
    },
  };
}

/** Read-only planner shared by Context and external context policy plugins. */
export function createJournalContextPlannerV1(
  options: JournalContextOptionsV1,
): JournalContextPlannerV1 {
  const frozen = freezeOptions(options);
  return {
    async plan(snapshot, callOptions) {
      throwIfAborted(callOptions);
      const systemMessages: ChatMessage[] =
        frozen.system === undefined
          ? []
          : [{ role: "system", content: frozen.system }];
      const hardInputLimit =
        frozen.budget.contextWindowTokens - frozen.budget.reservedOutputTokens;
      const fixedTokens = estimateRequestInputTokens(
        systemMessages,
        frozen.tools,
        frozen.budget.estimator,
      );
      if (fixedTokens > hardInputLimit) {
        throw new Error("fixed context budget exceeds window");
      }

      const timeline = scanTimeline(snapshot);
      const segmentBoundary = projectLatestWorkSegmentBoundaryV1(snapshot);
      const requiresPayloadEvidence = snapshotHasContextArtifact(snapshot);
      if (requiresPayloadEvidence && !frozen.loadPayloadEvidence) {
        throw new Error(
          "Context artifact payload requires exact canonical evidence",
        );
      }
      const payloadEvidence = requiresPayloadEvidence
        ? captureCanonicalPayloadEvidence(
            await (
              frozen.loadPayloadEvidence as NonNullable<
                JournalContextOptionsV1["loadPayloadEvidence"]
              >
            )(snapshot, callOptions.signal),
          )
        : undefined;
      throwIfAborted(callOptions);
      payloadEvidence?.assertSnapshot(snapshot);
      const projected: ProjectedTimelineUnit[] = [];
      for (const unit of timeline) {
        throwIfAborted(callOptions);
        if (unit.kind === "input") {
          projected.push({
            unit,
            message: {
              role: "user",
              content: unit.fact.content,
              ...(unit.fact.attachments === undefined
                ? {}
                : {
                    attachments: await resolveAttachments(
                      unit,
                      snapshot,
                      frozen.payloads,
                      payloadEvidence,
                      callOptions.signal,
                    ),
                  }),
            },
          });
          continue;
        }
        projected.push({
          unit,
          message: await projectModelTurn(
            unit,
            snapshot,
            frozen.payloads,
            payloadEvidence,
            frozen.toolObservationProjector,
            frozen.providerProtocol,
            callOptions.signal,
          ),
        });
      }
      throwIfAborted(callOptions);
      const checkpointProjection = await projectLatestCheckpoint(
        snapshot,
        projected,
        frozen.payloads,
        payloadEvidence,
        callOptions.signal,
      );
      const activitySection = await projectRuntimeActivitySection(
        snapshot,
        frozen.payloads,
      );
      const contextSections = [
        ...(checkpointProjection?.sections ?? []),
        ...(activitySection ? [activitySection] : []),
      ];
      const eligibleProjected = checkpointProjection
        ? projected.filter(
            (_item, index) => !checkpointProjection.coveredIndices.has(index),
          )
        : projected;
      const fixedMessages = materializeModelRequestMessagesV1({
        messages: systemMessages,
        ...(contextSections.length === 0 ? {} : { contextSections }),
      });
      const expandedFixedTokens = estimateRequestInputTokens(
        fixedMessages,
        frozen.tools,
        frozen.budget.estimator,
      );
      if (expandedFixedTokens > hardInputLimit) {
        throw new Error("fixed context budget exceeds window");
      }
      const selection = selectTimelineMessages(
        eligibleProjected,
        fixedMessages,
        frozen.tools,
        frozen.budget,
        segmentBoundary?.rootPromotionSeq,
      );
      const requestOptions = {
        maxOutputTokens: frozen.budget.reservedOutputTokens,
        ...(frozen.thinkingEnabled === undefined
          ? {}
          : { thinkingEnabled: frozen.thinkingEnabled }),
        ...(frozen.tools === undefined ? {} : { tools: frozen.tools }),
      };
      const request: ModelRequestV1 = {
        messages: [...systemMessages, ...selection.messages],
        ...(contextSections.length === 0 ? {} : { contextSections }),
        ...(Object.keys(requestOptions).length === 0
          ? {}
          : { options: requestOptions }),
      };
      const checkpoint = checkpointProjection?.checkpoint;
      const omittedUnitSourceSeqs = selection.omittedIndices.map(
        (index) => eligibleProjected[index]?.unit.sourceSeq,
      );
      const selectedUnitSourceSeqs = selection.selectedIndices.map(
        (index) => eligibleProjected[index]?.unit.sourceSeq,
      );
      const protectedUnitSourceSeqs = selection.protectedIndices.map(
        (index) => eligibleProjected[index]?.unit.sourceSeq,
      );
      const protectedIndexSet = new Set(selection.protectedIndices);
      const selectedIndexSet = new Set(selection.selectedIndices);
      const plan: JournalContextPlanV1 = {
        request,
        level:
          omittedUnitSourceSeqs.length > 0
            ? "fallback_omission"
            : checkpoint
              ? "semantic_checkpoint"
              : "lossless_projection",
        tokens: {
          contextWindowTokens: frozen.budget.contextWindowTokens,
          reservedOutputTokens: frozen.budget.reservedOutputTokens,
          hardInputLimitTokens: hardInputLimit,
          softTargetTokens:
            hardInputLimit - frozen.budget.estimationMarginTokens,
          fixedInputTokens: expandedFixedTokens,
          protectedInputTokens: selection.protectedInputTokens,
          fullInputTokens: selection.fullInputTokens,
          selectedInputTokens: selection.selectedInputTokens,
          estimatedOmittedInputTokens: Math.max(
            0,
            selection.fullInputTokens - selection.selectedInputTokens,
          ),
          hardHeadroomTokens: hardInputLimit - selection.selectedInputTokens,
          softHeadroomTokens:
            hardInputLimit -
            frozen.budget.estimationMarginTokens -
            selection.selectedInputTokens,
          estimatorId: frozen.budget.estimatorId,
          estimatorVersion: frozen.budget.estimatorVersion,
        },
        selection: {
          eligibleUnits: Object.freeze(
            eligibleProjected.map((item, index) =>
              Object.freeze({
                kind: item.unit.kind,
                sourceFromSeq: item.unit.sourceSeq,
                sourceThroughSeq: timelineUnitThroughSeq(item.unit),
                protected: protectedIndexSet.has(index),
                selected: selectedIndexSet.has(index),
              }),
            ),
          ),
          eligibleUnitSourceSeqs: Object.freeze(
            eligibleProjected.map((item) => item.unit.sourceSeq),
          ),
          protectedUnitSourceSeqs: Object.freeze(
            protectedUnitSourceSeqs.filter(
              (seq): seq is number => seq !== undefined,
            ),
          ),
          selectedUnitSourceSeqs: Object.freeze(
            selectedUnitSourceSeqs.filter(
              (seq): seq is number => seq !== undefined,
            ),
          ),
          omittedUnitSourceSeqs: Object.freeze(
            omittedUnitSourceSeqs.filter(
              (seq): seq is number => seq !== undefined,
            ),
          ),
          checkpointCoveredUnitSourceSeqs: Object.freeze(
            checkpointProjection?.coveredUnitSourceSeqs ?? [],
          ),
        },
        ...(checkpoint === undefined ? {} : { checkpoint }),
      };
      return plan;
    },
  };
}

function snapshotHasContextArtifact(
  snapshot: SessionInputSnapshot<InputFactV1>,
): boolean {
  return snapshot.entries.some(({ fact }) => {
    switch (fact.type) {
      case "input.promoted":
        return (fact.attachments ?? []).some(
          (attachment) => attachment.content.kind === "artifact_ref",
        );
      case "model.settled":
        return fact.response?.kind === "artifact_ref";
      case "tool.settled":
        return fact.observation?.payload?.kind === "artifact_ref";
      case "context.checkpoint_recorded":
        return fact.checkpoint.kind === "artifact_ref";
      default:
        return false;
    }
  });
}

type TimelineUnit = InputUnit | ModelUnit;

interface ProjectedTimelineUnit {
  readonly unit: TimelineUnit;
  readonly message: ChatMessage;
}

interface InputUnit {
  readonly kind: "input";
  readonly sourceSeq: number;
  readonly fact: Extract<InputFactV1, { type: "input.promoted" }>;
}

interface ToolExchange {
  readonly observedSeq: number;
  readonly observed: ToolCallObservedFactV1;
  settledSeq?: number;
  settled?: ToolSettledFactV1;
}

interface ModelUnit {
  readonly kind: "model";
  readonly sourceSeq: number;
  readonly fact: ModelSettledFactV1;
  readonly tools: ToolExchange[];
}

function scanTimeline(
  snapshot: SessionInputSnapshot<InputFactV1>,
): readonly TimelineUnit[] {
  assertSnapshotOrder(snapshot);
  const timeline: TimelineUnit[] = [];
  const models = new Map<string, ModelUnit>();
  const calls = new Map<string, ToolExchange>();
  let activeModel:
    | { readonly modelCallId: string; readonly turn: number }
    | undefined;
  let openToolModel: ModelUnit | undefined;

  const assertSafeRequestBoundary = (sourceSeq: number): void => {
    if (activeModel) {
      throw new Error(
        `Context found visible input/model dispatch inside active model call at seq ${sourceSeq}`,
      );
    }
    if (openToolModel) {
      const fullySettled =
        openToolModel.tools.length > 0 &&
        openToolModel.tools.every((exchange) => exchange.settled !== undefined);
      if (!fullySettled) {
        throw new Error(
          `Context found visible input/model dispatch inside unsettled tool batch at seq ${sourceSeq}`,
        );
      }
      openToolModel = undefined;
    }
  };

  for (const entry of snapshot.entries) {
    const fact = entry.fact;
    switch (fact.type) {
      case "input.promoted":
        assertSafeRequestBoundary(entry.seq);
        timeline.push({ kind: "input", sourceSeq: entry.seq, fact });
        break;
      case "model.dispatch_recorded":
        assertSafeRequestBoundary(entry.seq);
        activeModel = { modelCallId: fact.modelCallId, turn: fact.turn };
        break;
      case "model.settled": {
        if (
          !activeModel ||
          activeModel.modelCallId !== fact.modelCallId ||
          activeModel.turn !== fact.turn
        ) {
          throw new Error(
            `Context cannot bind model settlement: ${fact.modelCallId}`,
          );
        }
        activeModel = undefined;
        if (models.has(fact.modelCallId)) {
          throw new Error(
            `Context found duplicate model settlement: ${fact.modelCallId}`,
          );
        }
        const model: ModelUnit = {
          kind: "model",
          sourceSeq: entry.seq,
          fact,
          tools: [],
        };
        models.set(fact.modelCallId, model);
        if (fact.status === "completed" || fact.status === "truncated") {
          timeline.push(model);
        }
        if (fact.status === "completed" && fact.hasToolCalls) {
          openToolModel = model;
        }
        break;
      }
      case "tool.call_observed": {
        if (calls.has(fact.callId)) {
          throw new Error(`Context found duplicate tool call: ${fact.callId}`);
        }
        const model = models.get(fact.modelCallId);
        if (!model || model.fact.turn !== fact.turn) {
          throw new Error(`Context cannot bind tool call: ${fact.callId}`);
        }
        if (openToolModel !== model) {
          throw new Error(`Context found late tool call: ${fact.callId}`);
        }
        if (
          model.fact.status !== "completed" &&
          model.fact.status !== "truncated"
        ) {
          throw new Error("Context tool call belongs to failed model turn");
        }
        const exchange: ToolExchange = {
          observedSeq: entry.seq,
          observed: fact,
        };
        calls.set(fact.callId, exchange);
        model.tools.push(exchange);
        break;
      }
      case "tool.settled": {
        const exchange = calls.get(fact.callId);
        if (!exchange || exchange.settled !== undefined) {
          throw new Error(
            `Context cannot bind tool settlement: ${fact.callId}`,
          );
        }
        if (openToolModel?.fact.modelCallId !== exchange.observed.modelCallId) {
          throw new Error(`Context found late tool settlement: ${fact.callId}`);
        }
        exchange.settled = fact;
        exchange.settledSeq = entry.seq;
        break;
      }
      // These are canonical audit/control facts, never message content.
      case "attempt.started":
      case "input.accepted":
      case "work.segment_started":
      case "tool.dispatch_recorded":
      case "tool.permission_resolved":
      case "tool.effect_checkpoint_allocated":
      case "abort.requested":
      case "runtime.failed":
      case "policy.request_recorded":
      case "context.checkpoint_distillation_claimed":
      case "context.checkpoint_distillation_settled":
      case "context.checkpoint_recorded":
        break;
    }
  }

  if (activeModel) {
    throw new Error(
      `Context found unsettled model dispatch: ${activeModel.modelCallId}`,
    );
  }

  for (const model of models.values()) {
    model.tools.sort(
      (left, right) => left.observed.order - right.observed.order,
    );
    model.tools.forEach((exchange, index) => {
      if (exchange.observed.order !== index) {
        throw new Error(
          `Context found non-contiguous tool order in turn ${model.fact.turn}`,
        );
      }
      if (exchange.settled === undefined || exchange.settledSeq === undefined) {
        throw new Error(
          `Context found half-settled tool batch: ${exchange.observed.callId}`,
        );
      }
    });
    const finalSettlementSeq = Math.max(
      model.sourceSeq,
      ...model.tools.map((exchange) => exchange.settledSeq ?? model.sourceSeq),
    );
    const interleavedUnit = timeline.find(
      (unit) =>
        unit !== model &&
        unit.sourceSeq > model.sourceSeq &&
        unit.sourceSeq < finalSettlementSeq,
    );
    if (interleavedUnit) {
      throw new Error(
        `Context found visible unit interleaved inside tool batch at seq ${interleavedUnit.sourceSeq}`,
      );
    }
  }

  timeline.sort((left, right) => left.sourceSeq - right.sourceSeq);
  return timeline;
}

interface CheckpointProjectionV1 {
  readonly sections: readonly ModelContextSectionV1[];
  readonly coveredIndices: ReadonlySet<number>;
  readonly coveredUnitSourceSeqs: readonly number[];
  readonly checkpoint: Readonly<{
    checkpointId: string;
    policyVersion: string;
    sourceFromSeq: number;
    sourceThroughSeq: number;
  }>;
}

const RUNTIME_ACTIVITY_CONTEXT_POLICY_V1 = "paw.runtime-activity-context.v1";
const MAX_RUNTIME_ACTIVITY_CONTEXT_ITEMS_V1 = 32;

async function projectRuntimeActivitySection(
  snapshot: SessionInputSnapshot<InputFactV1>,
  payloads: DurablePayloadResolverV1,
): Promise<ModelContextSectionV1 | undefined> {
  const sourceEntries = snapshot.entries.filter(
    ({ fact }) =>
      fact.type === "runtime.activity_started" ||
      fact.type === "runtime.activity_settled",
  );
  if (sourceEntries.length === 0) return undefined;

  const projection = projectRuntimeActivitiesV1(
    snapshot.entries.map(({ fact }) => fact),
  );
  const activities = projection.activities
    .slice(-MAX_RUNTIME_ACTIVITY_CONTEXT_ITEMS_V1)
    .map((activity) => ({
      activityId: activity.activityId,
      activityKind: activity.activityKind,
      label: activity.label,
      startedAt: activity.startedAt,
      ...(activity.metadata === undefined
        ? {}
        : { metadata: activity.metadata }),
      ...(activity.settlement === undefined
        ? { status: "running" as const }
        : {
            status: activity.settlement.status,
            settledAt: activity.settlement.settledAt,
            summary: activity.settlement.summary,
          }),
    }));
  const contentValue = immutableCanonicalJsonCloneV1({
    schemaVersion: 1,
    activities,
  } as unknown as JsonValue);
  const content = canonicalJsonStringifyV1(contentValue);
  const sourceFromSeq = sourceEntries[0]?.seq;
  const sourceThroughSeq = sourceEntries.at(-1)?.seq;
  if (sourceFromSeq === undefined || sourceThroughSeq === undefined) {
    throw new Error("Runtime activity projection lost its source range");
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "runtime_activity",
    id: `runtime-activities-${sourceThroughSeq}`,
    policyVersion: RUNTIME_ACTIVITY_CONTEXT_POLICY_V1,
    sourceFromSeq,
    sourceThroughSeq,
    contentHash: await payloads.hash(contentValue),
    content,
  });
}

export interface TaskCheckpointReplacementPlanV1 {
  readonly coveredUnitSourceSeqs: readonly number[];
}

export type TaskCheckpointStableBoundaryV1 =
  | "after_model_turn_without_tool_calls"
  | "after_tool_batch_settled";

/**
 * Proves that semantic distillation starts only at a completed Context
 * boundary. Audit facts may follow the visible unit, but a newer promoted
 * input, model attempt, failure, or half-settled tool batch is not stable.
 */
export function assertTaskCheckpointStableBoundaryV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  boundary: TaskCheckpointStableBoundaryV1,
): void {
  const timeline = scanTimeline(snapshot);
  const segmentMarkerSeq =
    projectLatestWorkSegmentBoundaryV1(snapshot)?.markerSeq ?? 0;
  const latestUnit = timeline.at(-1);
  let latestModelSettlement: (typeof snapshot.entries)[number] | undefined;
  for (let index = snapshot.entries.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.entries[index];
    if (entry?.fact.type === "model.settled") {
      latestModelSettlement = entry;
      break;
    }
  }
  if (
    segmentMarkerSeq > 0 &&
    (latestUnit?.kind !== "model" ||
      latestUnit.sourceSeq <= segmentMarkerSeq ||
      !latestModelSettlement ||
      latestModelSettlement.seq <= segmentMarkerSeq)
  ) {
    throw new Error(
      "Task checkpoint boundary is not stable in the current work segment",
    );
  }
  if (
    latestUnit?.kind !== "model" ||
    latestUnit.sourceSeq <= segmentMarkerSeq ||
    latestModelSettlement?.fact.type !== "model.settled" ||
    latestModelSettlement.seq <= segmentMarkerSeq ||
    latestUnit.fact.modelCallId !== latestModelSettlement.fact.modelCallId ||
    latestUnit.fact.turn !== latestModelSettlement.fact.turn ||
    latestUnit.fact.status !== "completed"
  ) {
    throw new Error("Task checkpoint distillation boundary is not stable");
  }
  const actualBoundary: TaskCheckpointStableBoundaryV1 =
    latestUnit.fact.hasToolCalls && latestUnit.tools.length > 0
      ? "after_tool_batch_settled"
      : "after_model_turn_without_tool_calls";
  if (
    (latestUnit.fact.hasToolCalls && latestUnit.tools.length === 0) ||
    actualBoundary !== boundary
  ) {
    throw new Error("Task checkpoint distillation boundary does not match");
  }
  const boundaryThroughSeq = Math.max(
    latestUnit.sourceSeq,
    ...latestUnit.tools.map(
      (exchange) => exchange.settledSeq ?? latestUnit.sourceSeq,
    ),
  );
  const invalidTailFact = snapshot.entries.find(
    (entry) =>
      entry.seq > boundaryThroughSeq &&
      entry.fact.type !== "context.checkpoint_distillation_claimed" &&
      entry.fact.type !== "context.checkpoint_distillation_settled" &&
      entry.fact.type !== "context.checkpoint_recorded",
  );
  if (invalidTailFact) {
    throw new Error(
      `Task checkpoint distillation boundary is followed by ${invalidTailFact.fact.type}`,
    );
  }
}

/** Pure replacement eligibility shared by checkpoint generation and Context. */
export function planTaskCheckpointReplacementV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  sourceFromSeq: number,
  sourceThroughSeq: number,
): TaskCheckpointReplacementPlanV1 {
  const timeline = scanTimeline(snapshot);
  const protectedIndices = protectedTimelineUnitIndices(
    timeline,
    projectLatestWorkSegmentBoundaryV1(snapshot)?.rootPromotionSeq,
  );
  const coveredUnitSourceSeqs: number[] = [];
  timeline.forEach((unit, index) => {
    const throughSeq = timelineUnitThroughSeq(unit);
    const overlaps =
      unit.sourceSeq <= sourceThroughSeq && throughSeq >= sourceFromSeq;
    if (!overlaps) return;
    const fullyCovered =
      unit.sourceSeq >= sourceFromSeq && throughSeq <= sourceThroughSeq;
    if (!fullyCovered) {
      throw new Error("Context checkpoint partially covers a timeline unit");
    }
    if (protectedIndices.has(index)) {
      throw new Error("Context checkpoint covers protected context evidence");
    }
    coveredUnitSourceSeqs.push(unit.sourceSeq);
  });
  if (coveredUnitSourceSeqs.length === 0) {
    throw new Error("Context checkpoint covers no visible timeline unit");
  }
  return { coveredUnitSourceSeqs: Object.freeze(coveredUnitSourceSeqs) };
}

async function projectLatestCheckpoint(
  snapshot: SessionInputSnapshot<InputFactV1>,
  projected: readonly ProjectedTimelineUnit[],
  payloads: DurablePayloadResolverV1,
  payloadEvidence: VerifiedCanonicalPayloadEvidenceV1 | undefined,
  signal: AbortSignal,
): Promise<CheckpointProjectionV1 | undefined> {
  const checkpointEntries = snapshot.entries.filter(
    (
      candidate,
    ): candidate is {
      readonly seq: number;
      readonly fact: ContextCheckpointRecordedFactV1;
    } => candidate.fact.type === "context.checkpoint_recorded",
  );
  assertCheckpointChain(checkpointEntries);
  const entry = checkpointEntries.at(-1);
  if (!entry) return undefined;
  const fact = entry.fact;
  const checkpointValue = await resolveVerified(
    fact.checkpoint,
    {
      kind: "task_checkpoint",
      carrierType: "context.checkpoint_recorded",
      carrierSeq: entry.seq,
      checkpointId: fact.checkpointId,
      ...(fact.distillationClaimId === undefined
        ? {}
        : { distillationClaimId: fact.distillationClaimId }),
    },
    snapshot,
    payloads,
    payloadEvidence,
    signal,
  );
  const checkpoint = parseTaskCheckpointV1(checkpointValue);
  const sourceEntries = snapshot.entries.filter(
    (candidate) =>
      candidate.seq >= fact.sourceFromSeq &&
      candidate.seq <= fact.sourceThroughSeq,
  );
  if (sourceEntries.length === 0) {
    throw new Error("Context checkpoint source range has no input facts");
  }
  const sourceSeqs = new Set(sourceEntries.map((candidate) => candidate.seq));
  for (const item of checkpointItems(checkpoint)) {
    for (const sourceSeq of item.sourceSeqs) {
      if (!sourceSeqs.has(sourceSeq)) {
        throw new Error(
          `Context checkpoint references missing input fact seq ${sourceSeq}`,
        );
      }
    }
  }
  const sourceValue = immutableCanonicalJsonCloneV1(
    sourceEntries.map((candidate) => ({
      seq: candidate.seq,
      fact: candidate.fact,
    })) as unknown as JsonValue,
  );
  if ((await payloads.hash(sourceValue)) !== fact.sourceInputHash) {
    throw new Error("Context checkpoint source input hash mismatch");
  }

  const replacement = planTaskCheckpointReplacementV1(
    snapshot,
    fact.sourceFromSeq,
    fact.sourceThroughSeq,
  );
  const coveredSourceSeqs = new Set(replacement.coveredUnitSourceSeqs);
  const coveredIndices = new Set<number>();
  projected.forEach((item, index) => {
    if (coveredSourceSeqs.has(item.unit.sourceSeq)) coveredIndices.add(index);
  });
  const section: ModelContextSectionV1 = Object.freeze({
    schemaVersion: 1,
    kind: "task_checkpoint",
    id: fact.checkpointId,
    policyVersion: fact.policyVersion,
    sourceFromSeq: fact.sourceFromSeq,
    sourceThroughSeq: fact.sourceThroughSeq,
    contentHash: fact.checkpoint.hash,
    content: canonicalJsonStringifyV1(checkpoint as unknown as JsonValue),
  });
  return {
    sections: Object.freeze([section]),
    coveredIndices,
    coveredUnitSourceSeqs: replacement.coveredUnitSourceSeqs,
    checkpoint: Object.freeze({
      checkpointId: fact.checkpointId,
      policyVersion: fact.policyVersion,
      sourceFromSeq: fact.sourceFromSeq,
      sourceThroughSeq: fact.sourceThroughSeq,
    }),
  };
}

function assertCheckpointChain(
  entries: readonly {
    readonly seq: number;
    readonly fact: ContextCheckpointRecordedFactV1;
  }[],
): void {
  const ids = new Set<string>();
  let previous: ContextCheckpointRecordedFactV1 | undefined;
  for (const entry of entries) {
    const fact = entry.fact;
    if (ids.has(fact.checkpointId)) {
      throw new Error(
        `Context found duplicate checkpoint: ${fact.checkpointId}`,
      );
    }
    if (!previous && fact.supersedesCheckpointId !== undefined) {
      throw new Error("Context first checkpoint cannot supersede another");
    }
    if (previous) {
      if (fact.supersedesCheckpointId !== previous.checkpointId) {
        throw new Error("Context checkpoint supersession is stale");
      }
      if (
        fact.sourceFromSeq > previous.sourceFromSeq ||
        fact.sourceThroughSeq < previous.sourceThroughSeq
      ) {
        throw new Error("Context checkpoint source range is not monotonic");
      }
    }
    ids.add(fact.checkpointId);
    previous = fact;
  }
}

function checkpointItems(
  checkpoint: TaskCheckpointV1,
): readonly TaskCheckpointItemV1[] {
  return [
    ...(checkpoint.goal ? [checkpoint.goal] : []),
    ...checkpoint.confirmedFacts,
    ...checkpoint.currentHypotheses,
    ...checkpoint.ruledOut,
    ...checkpoint.changedFiles,
    ...checkpoint.verification,
    ...checkpoint.unresolved,
    ...(checkpoint.nextAction ? [checkpoint.nextAction] : []),
  ];
}

function timelineUnitThroughSeq(unit: TimelineUnit): number {
  if (unit.kind === "input") return unit.sourceSeq;
  return Math.max(
    unit.sourceSeq,
    ...unit.tools.map((exchange) => exchange.settledSeq ?? unit.sourceSeq),
  );
}

async function projectModelTurn(
  unit: ModelUnit,
  snapshot: SessionInputSnapshot<InputFactV1>,
  payloads: DurablePayloadResolverV1,
  payloadEvidence: VerifiedCanonicalPayloadEvidenceV1 | undefined,
  toolObservationProjector: ToolObservationProjectorV1 | undefined,
  providerProtocol: ModelResponseV1["providerProtocol"],
  signal: AbortSignal,
): Promise<ChatMessage> {
  if (unit.fact.response === undefined) {
    throw new Error(
      `Context-visible model settlement lacks response: ${unit.fact.modelCallId}`,
    );
  }
  const responseValue = await resolveVerified(
    unit.fact.response,
    {
      kind: "model_response",
      carrierType: "model.settled",
      carrierSeq: unit.sourceSeq,
      modelCallId: unit.fact.modelCallId,
    },
    snapshot,
    payloads,
    payloadEvidence,
    signal,
  );
  const response = parseModelResponseV1(responseValue);
  if (response.providerProtocol !== providerProtocol) {
    throw new Error(
      `Context provider protocol mismatch: expected ${providerProtocol}, got ${response.providerProtocol}`,
    );
  }
  assertModelResponseMatches(unit, response);

  // Truncated native calls are audit evidence only and never replayed as calls.
  if (unit.fact.status === "truncated" || response.toolCalls.length === 0) {
    if (unit.tools.length !== 0) {
      throw new Error("Context found observed tools on a truncated/plain turn");
    }
    return {
      role: "assistant",
      content: response.assistantContent,
      ...(unit.fact.status === "completed" && response.reasoningPassback
        ? { reasoningPassback: response.reasoningPassback }
        : {}),
    };
  }

  const calls = response.toolCalls.map((call) => ({
    callId: call.callId,
    providerName: call.name,
    rawArguments: call.rawArguments,
  }));
  const results: NativeToolTurnResultV2[] = [];
  for (let index = 0; index < response.toolCalls.length; index += 1) {
    const nativeCall = response.toolCalls[index];
    const exchange = unit.tools[index];
    if (!nativeCall || !exchange || !exchange.settled) {
      throw new Error("Context found incomplete atomic tool turn");
    }
    assertToolIdentity(nativeCall, exchange.observed);
    if (exchange.settled.observation === undefined) {
      throw new Error(
        `Context tool settlement lacks model-visible observation: ${nativeCall.callId}`,
      );
    }
    const observation = parseToolObservationV1(exchange.settled.observation);
    if (exchange.settled.status !== "completed" && !observation.isError) {
      throw new Error(
        `Context tool observation status mismatch: ${nativeCall.callId}`,
      );
    }
    results.push({
      callId: nativeCall.callId,
      status: exchange.settled.status,
      isError: observation.isError,
      content: await observationContent(
        observation,
        exchange.settled.status,
        exchange,
        snapshot,
        payloads,
        payloadEvidence,
        toolObservationProjector,
        signal,
      ),
    });
  }
  const nativeToolTurn: NativeToolTurnV2 = {
    schemaVersion: 2,
    protocol: "provider-neutral",
    assistantContent: response.assistantContent,
    ...(response.reasoningPassback === undefined
      ? {}
      : { reasoningPassback: response.reasoningPassback }),
    calls,
    results,
  };
  return {
    role: "assistant",
    content: response.assistantContent,
    nativeToolTurn,
  };
}

function assertModelResponseMatches(
  unit: ModelUnit,
  response: ModelResponseV1,
): void {
  assertCanonicalModelResponseCarrierV1(unit.fact, response);
  if (
    unit.fact.status === "completed" &&
    unit.tools.length !== response.toolCalls.length
  ) {
    throw new Error("Context model response/observation call count mismatch");
  }
}

function assertToolIdentity(
  nativeCall: ModelResponseToolCallV1,
  observed: ToolCallObservedFactV1,
): void {
  if (
    nativeCall.callId !== observed.callId ||
    nativeCall.name !== observed.tool ||
    nativeCall.sourceIndex !== observed.order ||
    nativeCall.argumentsValid !== true ||
    !sameJson(nativeCall.args, observed.args)
  ) {
    throw new Error(
      `Context native tool identity mismatch: ${observed.callId}`,
    );
  }
}

async function observationContent(
  observation: ToolObservationV1,
  status: ToolSettledFactV1["status"],
  exchange: ToolExchange,
  snapshot: SessionInputSnapshot<InputFactV1>,
  payloads: DurablePayloadResolverV1,
  payloadEvidence: VerifiedCanonicalPayloadEvidenceV1 | undefined,
  toolObservationProjector: ToolObservationProjectorV1 | undefined,
  signal: AbortSignal,
): Promise<string> {
  const resolvedValue =
    observation.payload === undefined
      ? undefined
      : await resolveVerified(
          observation.payload,
          {
            kind: "tool_observation",
            carrierType: "tool.settled",
            carrierSeq: requiredSettledSeq(exchange),
            callId: exchange.observed.callId,
          },
          snapshot,
          payloads,
          payloadEvidence,
          signal,
        );
  const value =
    resolvedValue === undefined ||
    observation.payload === undefined ||
    toolObservationProjector === undefined
      ? resolvedValue
      : immutableCanonicalJsonCloneV1(
          await toolObservationProjector.project(
            Object.freeze({
              callId: exchange.observed.callId,
              tool: exchange.observed.tool,
              carrierSeq: requiredSettledSeq(exchange),
              status,
              isError: observation.isError,
              summary: observation.summary,
              payload: observation.payload,
              value: resolvedValue,
            }),
            signal,
          ),
        );
  // Always JSON: hostile fields such as newMessages never become ChatMessage objects.
  return canonicalJsonStringifyV1({
    status,
    isError: observation.isError,
    summary: observation.summary,
    ...(value === undefined ? {} : { payload: value }),
  });
}

async function resolveAttachments(
  unit: InputUnit,
  snapshot: SessionInputSnapshot<InputFactV1>,
  payloads: DurablePayloadResolverV1,
  payloadEvidence: VerifiedCanonicalPayloadEvidenceV1 | undefined,
  signal: AbortSignal,
): Promise<readonly Attachment[]> {
  const resolved: Attachment[] = [];
  for (const [attachmentIndex, attachment] of (
    unit.fact.attachments ?? []
  ).entries()) {
    const content = await resolveVerified(
      attachment.content,
      {
        kind: "input_attachment",
        carrierType: "input.promoted",
        carrierSeq: unit.sourceSeq,
        attachmentIndex,
        inputId: unit.fact.inputId,
        attachmentId: attachment.attachmentId,
      },
      snapshot,
      payloads,
      payloadEvidence,
      signal,
    );
    if (typeof content !== "string") {
      throw new Error(
        `Context attachment did not resolve to string: ${attachment.attachmentId}`,
      );
    }
    resolved.push({
      type: attachment.type,
      name: attachment.name,
      content,
      ...(attachment.mimeType === undefined
        ? {}
        : { mimeType: attachment.mimeType }),
    });
  }
  return resolved;
}

async function resolveVerified(
  payload: DurableJsonPayloadV1,
  location: CanonicalDurableJsonPayloadLocationV1,
  snapshot: SessionInputSnapshot<InputFactV1>,
  payloads: DurablePayloadResolverV1,
  payloadEvidence: VerifiedCanonicalPayloadEvidenceV1 | undefined,
  signal: AbortSignal,
): Promise<JsonValue> {
  if (payload.kind === "artifact_ref") {
    if (!payloadEvidence) {
      throw new Error(
        "Context artifact payload requires exact canonical evidence",
      );
    }
    return payloadEvidence.requirePayload({ snapshot, location, payload });
  }
  const value = await payloads.resolve(payload, signal);
  const actualHash = await payloads.hash(value);
  if (actualHash !== payload.hash) {
    throw new Error(`Context durable payload hash mismatch: ${payload.hash}`);
  }
  return value;
}

function requiredSettledSeq(exchange: ToolExchange): number {
  if (exchange.settledSeq === undefined) {
    throw new Error("Context tool settlement carrier is missing");
  }
  return exchange.settledSeq;
}

function assertSnapshotOrder(
  snapshot: SessionInputSnapshot<InputFactV1>,
): void {
  let previousSeq = 0;
  for (const entry of snapshot.entries) {
    if (entry.seq <= previousSeq || entry.seq > snapshot.tailSeq) {
      throw new Error("Context snapshot input seq order is invalid");
    }
    previousSeq = entry.seq;
  }
  if (
    snapshot.tailSeq < snapshot.latestInputSeq ||
    snapshot.latestInputSeq !== previousSeq
  ) {
    throw new Error("Context snapshot latestInputSeq is inconsistent");
  }
}

function freezeOptions(
  options: JournalContextOptionsV1,
): JournalContextOptionsV1 {
  assertBudget(options.budget);
  if (
    options.loadPayloadEvidence !== undefined &&
    typeof options.loadPayloadEvidence !== "function"
  ) {
    throw new Error("Context payload evidence loader is invalid");
  }
  const loadPayloadEvidence = options.loadPayloadEvidence?.bind(options);
  const toolObservationProjector = captureToolObservationProjector(
    options.toolObservationProjector,
  );
  const payloads = capturePayloadResolver(options.payloads);
  const tools = options.tools?.map((tool) =>
    deepFreeze({
      type: tool.type,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: cloneUnknown(tool.function.parameters),
      },
    }),
  );
  return Object.freeze({
    payloads,
    ...(loadPayloadEvidence === undefined ? {} : { loadPayloadEvidence }),
    ...(toolObservationProjector === undefined
      ? {}
      : { toolObservationProjector }),
    providerProtocol: options.providerProtocol,
    budget: Object.freeze({
      contextWindowTokens: options.budget.contextWindowTokens,
      reservedOutputTokens: options.budget.reservedOutputTokens,
      estimationMarginTokens: options.budget.estimationMarginTokens,
      estimatorId: options.budget.estimatorId,
      estimatorVersion: options.budget.estimatorVersion,
      estimator: options.budget.estimator,
    }),
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(tools === undefined ? {} : { tools: Object.freeze(tools) }),
    ...(options.thinkingEnabled === undefined
      ? {}
      : { thinkingEnabled: options.thinkingEnabled }),
  });
}

function captureToolObservationProjector(
  projector: ToolObservationProjectorV1 | undefined,
): ToolObservationProjectorV1 | undefined {
  if (projector === undefined) return undefined;
  if (!projector || typeof projector.project !== "function") {
    throw new Error("Context tool observation projector is invalid");
  }
  return Object.freeze({ project: projector.project.bind(projector) });
}

function capturePayloadResolver(
  payloads: DurablePayloadResolverV1,
): DurablePayloadResolverV1 {
  if (
    !payloads ||
    typeof payloads.resolve !== "function" ||
    typeof payloads.hash !== "function"
  ) {
    throw new Error("Context durable payload resolver is invalid");
  }
  return Object.freeze({
    resolve: payloads.resolve.bind(payloads),
    hash: payloads.hash.bind(payloads),
  });
}

function captureCanonicalPayloadEvidence(
  evidence: VerifiedCanonicalPayloadEvidenceV1,
): VerifiedCanonicalPayloadEvidenceV1 {
  if (
    !evidence ||
    typeof evidence.assertSnapshot !== "function" ||
    typeof evidence.requireModelResponse !== "function" ||
    typeof evidence.requirePayload !== "function"
  ) {
    throw new Error("Context canonical payload evidence is invalid");
  }
  return Object.freeze({
    assertSnapshot: evidence.assertSnapshot.bind(evidence),
    requireModelResponse: evidence.requireModelResponse.bind(evidence),
    requirePayload: evidence.requirePayload.bind(evidence),
  });
}

function assertBudget(budget: JournalContextBudgetV1): void {
  if (
    !Number.isSafeInteger(budget.contextWindowTokens) ||
    budget.contextWindowTokens <= 0 ||
    !Number.isSafeInteger(budget.reservedOutputTokens) ||
    budget.reservedOutputTokens <= 0 ||
    budget.reservedOutputTokens >= budget.contextWindowTokens ||
    !Number.isSafeInteger(budget.estimationMarginTokens) ||
    budget.estimationMarginTokens < 0 ||
    budget.estimatorId.trim().length === 0 ||
    budget.estimatorVersion.trim().length === 0 ||
    typeof budget.estimator?.count !== "function" ||
    typeof budget.estimator?.countMessages !== "function"
  ) {
    throw new Error("Context budget configuration is invalid");
  }
}

interface TimelineMessageSelectionV1 {
  readonly messages: readonly ChatMessage[];
  readonly protectedIndices: readonly number[];
  readonly selectedIndices: readonly number[];
  readonly omittedIndices: readonly number[];
  readonly protectedInputTokens: number;
  readonly fullInputTokens: number;
  readonly selectedInputTokens: number;
}

function selectTimelineMessages(
  projected: readonly ProjectedTimelineUnit[],
  systemMessages: readonly ChatMessage[],
  tools: readonly ToolDefinition[] | undefined,
  budget: JournalContextBudgetV1,
  segmentRootPromotionSeq?: number,
): TimelineMessageSelectionV1 {
  const protectedIndices = protectedTimelineIndices(
    projected,
    segmentRootPromotionSeq,
  );
  const hardInputLimit =
    budget.contextWindowTokens - budget.reservedOutputTokens;
  const softTarget = hardInputLimit - budget.estimationMarginTokens;
  const estimateSelected = (indices: ReadonlySet<number>): number =>
    estimateRequestInputTokens(
      [
        ...systemMessages,
        ...[...indices]
          .sort((left, right) => left - right)
          .map((index) => projected[index]?.message)
          .filter((message): message is ChatMessage => message !== undefined),
      ],
      tools,
      budget.estimator,
    );

  const protectedTokens = estimateSelected(protectedIndices);
  if (protectedTokens > hardInputLimit) {
    throw new Error("protected context budget exceeds window");
  }

  const selected = new Set(protectedIndices);
  if (protectedTokens <= softTarget) {
    for (let index = projected.length - 1; index >= 0; index -= 1) {
      if (selected.has(index)) continue;
      const candidate = new Set(selected);
      candidate.add(index);
      if (estimateSelected(candidate) > softTarget) break;
      selected.add(index);
    }
  }

  if (estimateSelected(selected) > hardInputLimit) {
    throw new Error("selected context budget exceeds window");
  }
  const selectedIndices = [...selected].sort((left, right) => left - right);
  const protectedIndicesInOrder = [...protectedIndices].sort(
    (left, right) => left - right,
  );
  const omittedIndices = projected.flatMap((_item, index) =>
    selected.has(index) ? [] : [index],
  );
  const fullInputTokens = estimateSelected(
    new Set(projected.map((_item, index) => index)),
  );
  const selectedInputTokens = estimateSelected(selected);
  return {
    messages: Object.freeze(
      selectedIndices
        .map((index) => projected[index]?.message)
        .filter((message): message is ChatMessage => message !== undefined),
    ),
    protectedIndices: Object.freeze(protectedIndicesInOrder),
    selectedIndices: Object.freeze(selectedIndices),
    omittedIndices: Object.freeze(omittedIndices),
    protectedInputTokens: protectedTokens,
    fullInputTokens,
    selectedInputTokens,
  };
}

function protectedTimelineIndices(
  projected: readonly ProjectedTimelineUnit[],
  segmentRootPromotionSeq?: number,
): ReadonlySet<number> {
  return protectedTimelineUnitIndices(
    projected.map((item) => item.unit),
    segmentRootPromotionSeq,
  );
}

function protectedTimelineUnitIndices(
  timeline: readonly TimelineUnit[],
  segmentRootPromotionSeq?: number,
): ReadonlySet<number> {
  const protectedIndices = new Set<number>();
  if (timeline.length === 0) return protectedIndices;
  const initialInputIndex = timeline.findIndex(
    (unit) => unit.kind === "input" && unit.fact.delivery === "initial",
  );
  const firstInputIndex = timeline.findIndex((unit) => unit.kind === "input");
  if (initialInputIndex >= 0) protectedIndices.add(initialInputIndex);
  else if (firstInputIndex >= 0) protectedIndices.add(firstInputIndex);
  if (segmentRootPromotionSeq !== undefined) {
    const segmentRootIndex = timeline.findIndex(
      (unit) =>
        unit.kind === "input" && unit.sourceSeq === segmentRootPromotionSeq,
    );
    if (segmentRootIndex < 0) {
      throw new Error("Context current work segment root is not visible");
    }
    protectedIndices.add(segmentRootIndex);
  }

  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const unit = timeline[index];
    if (unit?.kind === "input") {
      protectedIndices.add(index);
      break;
    }
  }
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const unit = timeline[index];
    if (
      unit?.kind === "model" &&
      unit.fact.status === "completed" &&
      unit.fact.hasToolCalls &&
      unit.tools.length > 0
    ) {
      protectedIndices.add(index);
      break;
    }
  }
  protectedIndices.add(timeline.length - 1);
  return protectedIndices;
}

function estimateRequestInputTokens(
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[] | undefined,
  estimator: ContextTokenEstimatorV1,
): number {
  const messagesTokens = assertTokenEstimate(
    estimator.countMessages(messages),
    "messages",
  );
  const toolTokens =
    tools === undefined || tools.length === 0
      ? 0
      : assertTokenEstimate(
          estimator.count(canonicalUnknownStringify(tools)),
          "tools",
        );
  return messagesTokens + toolTokens;
}

function assertTokenEstimate(value: number, source: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Context ${source} token estimate is invalid`);
  }
  return value;
}

function canonicalUnknownStringify(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalUnknownStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalUnknownStringify(record[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("Context tool definition is not JSON-serializable");
}

function throwIfAborted(options: PortCallOptions): void {
  if (options.signal.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(String(options.signal.reason ?? "Context build aborted"));
  }
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index] as JsonValue))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Readonly<Record<string, JsonValue>>;
  const rightRecord = right as Readonly<Record<string, JsonValue>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameJson(leftRecord[key] as JsonValue, rightRecord[key] as JsonValue),
    )
  );
}

function cloneUnknown<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneUnknown) as T;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneUnknown(item)]),
  ) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
