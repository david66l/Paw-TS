import { createHash } from "node:crypto";
import type {
  LoopInputPort,
  LoopSafeBoundary,
  Session,
  SessionInputSnapshot,
} from "@paw/agent-loop";
import type {
  DerivedDecisionV1,
  InputAcceptedFactV1,
  InputAttachmentV1,
  InputFactV1,
  InputPromotedFactV1,
} from "@paw/protocol";
import { projectLatestWorkSegmentBoundaryV1 } from "../work-segment-boundary.js";

export interface AcceptInputRequestV1 {
  readonly inputId: string;
  readonly delivery: "steer" | "queue";
  readonly content: string;
  readonly callerId: string;
  readonly attachments?: readonly InputAttachmentV1[];
}

export interface AcceptInputResultV1 {
  readonly status: "accepted" | "already_accepted";
  readonly inputId: string;
}

export interface DurableInputInboxStateV1 {
  readonly acceptedCount: number;
  readonly promotedCount: number;
  readonly pendingSteerIds: readonly string[];
  readonly pendingQueueIds: readonly string[];
}

/**
 * Rebuild the durable Inbox view from one canonical Session snapshot.
 *
 * This is the same FIFO/idempotency projection used by the live Inbox. It is
 * deliberately pure so startup classification can inspect pending work
 * without constructing a Session-backed port or acquiring execution authority.
 */
export function projectDurableInputInboxStateV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
): DurableInputInboxStateV1 {
  const projection = projectInbox(snapshot.entries);
  return Object.freeze({
    acceptedCount: projection.accepted.length,
    promotedCount: projection.promotedIds.size,
    pendingSteerIds: Object.freeze(
      projection.pending
        .filter((entry) => entry.fact.delivery === "steer")
        .map((entry) => entry.fact.inputId),
    ),
    pendingQueueIds: Object.freeze(
      projection.pending
        .filter((entry) => entry.fact.delivery === "queue")
        .map((entry) => entry.fact.inputId),
    ),
  });
}

interface AcceptedEntryV1 {
  readonly seq: number;
  readonly fact: InputAcceptedFactV1;
}

const liveCoordinatorOwners = new Map<object | string, symbol>();

interface CoordinatorIdentitySessionV1 {
  readCoordinatorOwnershipIdentity(): string;
}

/**
 * Durable input admission and promotion over the canonical Session journal.
 *
 * The inbox owns no independent queue database. Every retry, FIFO decision and
 * crash recovery is projected from input.accepted/input.promoted facts.
 */
export class DurableInputInboxV1 implements LoopInputPort {
  private readonly coordinatorIdentity: object | string;

  constructor(
    private readonly session: Session<InputFactV1, DerivedDecisionV1>,
  ) {
    this.coordinatorIdentity = hasCoordinatorIdentity(session)
      ? session.readCoordinatorOwnershipIdentity()
      : session;
  }

  async accept(request: AcceptInputRequestV1): Promise<AcceptInputResultV1> {
    const fact = createInputAcceptedFactV1(request);
    while (true) {
      const snapshot = await this.session.readInputSnapshot();
      const existing = snapshot.entries.find(
        (entry) =>
          (entry.fact.type === "input.accepted" ||
            entry.fact.type === "input.promoted") &&
          entry.fact.inputId === fact.inputId,
      )?.fact;
      if (existing) {
        if (
          existing.type !== "input.accepted" ||
          !sameAcceptedInput(existing, fact)
        ) {
          throw new Error(`Input idempotency conflict: ${fact.inputId}`);
        }
        return { status: "already_accepted", inputId: fact.inputId };
      }
      const committed = await this.session.commitInputFacts(snapshot.tailSeq, [
        fact,
      ]);
      if (committed === "committed") {
        return { status: "accepted", inputId: fact.inputId };
      }
    }
  }

  async inspect(): Promise<DurableInputInboxStateV1> {
    return projectDurableInputInboxStateV1(
      await this.session.readInputSnapshot(),
    );
  }

  async reportSafeBoundary(boundary: LoopSafeBoundary): Promise<void> {
    while (true) {
      const snapshot = await this.session.readInputSnapshot();
      assertJournalSafeBoundary(snapshot, boundary);
      const projection = projectInbox(snapshot.entries);
      const steers = projection.pending.filter(
        (entry) => entry.fact.delivery === "steer",
      );
      const selected = steers;
      if (selected.length === 0) {
        return;
      }
      const promotions = selected.map(({ fact }) =>
        createInputPromotionFactV1(fact),
      );
      const committed = await this.session.commitInputFacts(
        snapshot.tailSeq,
        promotions,
      );
      if (committed === "committed") {
        return;
      }
    }
  }

  /** Promote exactly one queued item before an idle executor is started. */
  async prepareIdleExecution(): Promise<readonly string[]> {
    while (true) {
      const snapshot = await this.session.readInputSnapshot();
      const segment = projectLatestWorkSegmentBoundaryV1(snapshot);
      const currentSegmentHasDispatch = snapshot.entries.some(
        (entry) =>
          entry.seq > (segment?.markerSeq ?? 0) &&
          entry.fact.type === "model.dispatch_recorded",
      );
      if (segment !== undefined && currentSegmentHasDispatch) {
        assertJournalSafeBoundary(
          snapshot,
          currentSettledBoundary(snapshot, segment?.markerSeq ?? 0),
        );
        projectInbox(snapshot.entries);
        return [];
      }
      assertJournalSafeBoundary(snapshot, "before_first_model_request");
      const projection = projectInbox(snapshot.entries);
      if (segment !== undefined) return [];
      const unconsumed = promotedSinceLatestModelDispatch(
        snapshot.entries,
      ).filter(
        (inputId) => projection.acceptedById.get(inputId)?.delivery === "queue",
      );
      if (unconsumed.length > 0) return unconsumed;
      const next = projection.pending.find(
        (entry) => entry.fact.delivery === "queue",
      );
      if (!next) return [];
      const promotion = createInputPromotionFactV1(next.fact);
      const committed = await this.session.commitInputFacts(snapshot.tailSeq, [
        promotion,
      ]);
      if (committed === "committed") {
        return [promotion.inputId];
      }
    }
  }

  async consumePromotedInputIds(): Promise<readonly string[]> {
    return promotedSinceLatestModelDispatch(
      (await this.session.readInputSnapshot()).entries,
    );
  }

  /** @internal Binds coordinator ownership to the actual Session object. */
  claimCoordinator(owner: symbol): void {
    if (liveCoordinatorOwners.has(this.coordinatorIdentity)) {
      throw new Error("Paw Next session already has an in-process coordinator");
    }
    liveCoordinatorOwners.set(this.coordinatorIdentity, owner);
  }

  /** @internal Releases only the coordinator that owns this Session object. */
  releaseCoordinator(owner: symbol): void {
    if (liveCoordinatorOwners.get(this.coordinatorIdentity) === owner) {
      liveCoordinatorOwners.delete(this.coordinatorIdentity);
    }
  }
}

function currentSettledBoundary(
  snapshot: SessionInputSnapshot<InputFactV1>,
  markerSeq: number,
): Exclude<LoopSafeBoundary, "before_first_model_request"> {
  const latestModel = [...snapshot.entries]
    .reverse()
    .find(
      (entry) => entry.seq > markerSeq && entry.fact.type === "model.settled",
    );
  if (!latestModel || latestModel.fact.type !== "model.settled") {
    return "after_model_turn_without_tool_calls";
  }
  const latestModelCallId = latestModel.fact.modelCallId;
  const hasObservedTools = snapshot.entries.some(
    (entry) =>
      entry.seq > latestModel.seq &&
      entry.fact.type === "tool.call_observed" &&
      entry.fact.modelCallId === latestModelCallId,
  );
  return latestModel.fact.hasToolCalls || hasObservedTools
    ? "after_tool_batch_settled"
    : "after_model_turn_without_tool_calls";
}

function hasCoordinatorIdentity(
  session: Session<InputFactV1, DerivedDecisionV1>,
): session is Session<InputFactV1, DerivedDecisionV1> &
  CoordinatorIdentitySessionV1 {
  return (
    "readCoordinatorOwnershipIdentity" in session &&
    typeof session.readCoordinatorOwnershipIdentity === "function"
  );
}

/** Pure, detached request-to-fact mapping shared by Inbox transactions. */
export function createInputAcceptedFactV1(
  request: AcceptInputRequestV1,
): InputAcceptedFactV1 {
  assertId(request.inputId, "inputId");
  assertId(request.callerId, "callerId");
  if (request.delivery !== "steer" && request.delivery !== "queue") {
    throw new Error("Input delivery must be steer or queue");
  }
  if (!request.content.trim())
    throw new Error("Input content must be non-empty");
  const attachments = cloneAttachments(request.attachments);
  return deepFreeze({
    type: "input.accepted",
    inputId: request.inputId,
    delivery: request.delivery,
    content: request.content,
    contentHash: createHash("sha256").update(request.content).digest("hex"),
    callerId: request.callerId,
    ...(attachments === undefined ? {} : { attachments }),
  });
}

/** Pure accepted-to-promoted mapping shared by Inbox and work-segment CAS. */
export function createInputPromotionFactV1(
  accepted: InputAcceptedFactV1,
): InputPromotedFactV1 {
  const promotion: InputPromotedFactV1 = {
    type: "input.promoted",
    inputId: accepted.inputId,
    delivery: accepted.delivery,
    content: accepted.content,
    contentHash: accepted.contentHash,
    ...(accepted.attachments === undefined
      ? {}
      : { attachments: cloneAttachments(accepted.attachments) }),
  };
  return deepFreeze(promotion);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function projectInbox(
  entries: readonly {
    readonly seq: number;
    readonly fact: InputFactV1;
  }[],
): {
  readonly accepted: readonly AcceptedEntryV1[];
  readonly acceptedById: ReadonlyMap<string, InputAcceptedFactV1>;
  readonly promotedIds: ReadonlySet<string>;
  readonly pending: readonly AcceptedEntryV1[];
} {
  const accepted: AcceptedEntryV1[] = [];
  const acceptedIds = new Set<string>();
  const promotedIds = new Set<string>();
  let activeModelId: string | undefined;
  let queuePromotionsSinceDispatch = 0;
  const promotionSeqs: number[] = [];
  const modelBatches = new Map<
    string,
    {
      readonly settledSeq: number;
      readonly expectsTools: boolean;
      readonly callIds: string[];
    }
  >();
  const callSettlements = new Map<string, number>();
  for (const entry of entries) {
    if (entry.fact.type === "input.accepted") {
      if (
        acceptedIds.has(entry.fact.inputId) ||
        promotedIds.has(entry.fact.inputId)
      ) {
        throw new Error(`Duplicate inbox input: ${entry.fact.inputId}`);
      }
      acceptedIds.add(entry.fact.inputId);
      accepted.push({ seq: entry.seq, fact: entry.fact });
    } else if (entry.fact.type === "input.promoted") {
      if (activeModelId) {
        throw new Error(
          "Inbox history promotes input inside an active model call",
        );
      }
      if (promotedIds.has(entry.fact.inputId)) {
        throw new Error(`Duplicate promoted input: ${entry.fact.inputId}`);
      }
      if (entry.fact.delivery === "queue") {
        const expected = accepted.find(
          (candidate) =>
            candidate.fact.delivery === "queue" &&
            !promotedIds.has(candidate.fact.inputId),
        );
        if (expected?.fact.inputId !== entry.fact.inputId) {
          throw new Error("Inbox queue promotion is not FIFO");
        }
        queuePromotionsSinceDispatch += 1;
        if (queuePromotionsSinceDispatch > 1) {
          throw new Error(
            "Inbox history promotes more than one queue item per model request",
          );
        }
      }
      promotedIds.add(entry.fact.inputId);
      promotionSeqs.push(entry.seq);
    } else if (entry.fact.type === "model.dispatch_recorded") {
      activeModelId = entry.fact.modelCallId;
      queuePromotionsSinceDispatch = 0;
    } else if (entry.fact.type === "model.settled") {
      activeModelId = undefined;
      modelBatches.set(entry.fact.modelCallId, {
        settledSeq: entry.seq,
        expectsTools:
          entry.fact.status === "completed" && entry.fact.hasToolCalls,
        callIds: [],
      });
    } else if (entry.fact.type === "tool.call_observed") {
      const batch = modelBatches.get(entry.fact.modelCallId);
      batch?.callIds.push(entry.fact.callId);
    } else if (entry.fact.type === "tool.settled") {
      callSettlements.set(entry.fact.callId, entry.seq);
    }
  }
  for (const [modelCallId, batch] of modelBatches) {
    if (!batch.expectsTools) continue;
    const incomplete =
      batch.callIds.length === 0 ||
      batch.callIds.some((callId) => !callSettlements.has(callId));
    const throughSeq = incomplete
      ? Number.POSITIVE_INFINITY
      : Math.max(
          ...batch.callIds.map((callId) => callSettlements.get(callId) ?? 0),
        );
    if (
      promotionSeqs.some((seq) => seq > batch.settledSeq && seq <= throughSeq)
    ) {
      throw new Error(
        `Inbox history promotes input inside tool batch ${modelCallId}`,
      );
    }
  }
  return {
    accepted,
    acceptedById: new Map(
      accepted.map((entry) => [entry.fact.inputId, entry.fact]),
    ),
    promotedIds,
    pending: accepted.filter((entry) => !promotedIds.has(entry.fact.inputId)),
  };
}

function promotedSinceLatestModelDispatch(
  entries: readonly { readonly seq: number; readonly fact: InputFactV1 }[],
): readonly string[] {
  let latestDispatchSeq = 0;
  for (const entry of entries) {
    if (entry.fact.type === "model.dispatch_recorded") {
      latestDispatchSeq = entry.seq;
    }
  }
  return entries.flatMap((entry) =>
    entry.seq > latestDispatchSeq && entry.fact.type === "input.promoted"
      ? [entry.fact.inputId]
      : [],
  );
}

function assertJournalSafeBoundary(
  snapshot: SessionInputSnapshot<InputFactV1>,
  boundary: LoopSafeBoundary,
): void {
  const entries = snapshot.entries;
  const segment = projectLatestWorkSegmentBoundaryV1(snapshot);
  const segmentMarkerSeq = segment?.markerSeq ?? 0;
  let activeModel:
    | { readonly modelCallId: string; readonly turn: number }
    | undefined;
  let latestModel: Extract<InputFactV1, { type: "model.settled" }> | undefined;
  let latestModelSettlementSeq = 0;
  let segmentDispatches = 0;
  const calls = new Map<string, boolean>();
  let latestModelCallIds: string[] = [];
  for (const entry of entries) {
    const fact = entry.fact;
    if (fact.type === "model.dispatch_recorded") {
      if (activeModel || [...calls.values()].some((settled) => !settled)) {
        throw new Error("Inbox boundary crosses unfinished model or tool work");
      }
      activeModel = { modelCallId: fact.modelCallId, turn: fact.turn };
      if (entry.seq > segmentMarkerSeq) segmentDispatches += 1;
      latestModelCallIds = [];
    } else if (fact.type === "model.settled") {
      if (
        !activeModel ||
        activeModel.modelCallId !== fact.modelCallId ||
        activeModel.turn !== fact.turn
      ) {
        throw new Error("Inbox cannot bind the latest model settlement");
      }
      activeModel = undefined;
      latestModel = fact;
      latestModelSettlementSeq = entry.seq;
    } else if (fact.type === "tool.call_observed") {
      latestModelCallIds.push(fact.callId);
      calls.set(fact.callId, false);
    } else if (fact.type === "tool.settled") {
      if (!calls.has(fact.callId) || calls.get(fact.callId)) {
        throw new Error("Inbox cannot bind the latest tool settlement");
      }
      calls.set(fact.callId, true);
    }
  }
  if (activeModel || [...calls.values()].some((settled) => !settled)) {
    throw new Error("Inbox safe boundary has unfinished model or tool work");
  }
  if (boundary === "before_first_model_request") {
    if (segment !== undefined && segmentDispatches !== 0) {
      throw new Error(
        "Inbox before-first boundary has a current-segment model turn",
      );
    }
    return;
  }
  if (!latestModel || latestModelSettlementSeq <= segmentMarkerSeq) {
    throw new Error("Inbox safe boundary has no current-segment model turn");
  }
  const hasObservedTools = latestModelCallIds.length > 0;
  if (
    boundary === "after_model_turn_without_tool_calls" &&
    (latestModel.hasToolCalls || hasObservedTools)
  ) {
    throw new Error("Inbox safe boundary does not match the model turn");
  }
  if (
    boundary === "after_tool_batch_settled" &&
    (!latestModel.hasToolCalls || !hasObservedTools)
  ) {
    throw new Error("Inbox safe boundary does not match the tool batch");
  }
}

function sameAcceptedInput(
  left: InputAcceptedFactV1,
  right: InputAcceptedFactV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function cloneAttachments(
  attachments: readonly InputAttachmentV1[] | undefined,
): readonly InputAttachmentV1[] | undefined {
  if (attachments === undefined) return undefined;
  return JSON.parse(JSON.stringify(attachments)) as InputAttachmentV1[];
}

function assertId(value: string, label: string): void {
  const containsControl = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
  if (!value.trim() || value.length > 256 || containsControl) {
    throw new Error(`${label} must be a bounded printable identifier`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new Error("Inbox identity must be JSON-safe");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
