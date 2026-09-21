/** Cross-fact lifecycle validation: the invariants a journal prefix must satisfy. */
import {
  type ControlDecisionActionV1,
  type InputFactV1,
  type RunJournalEnvelopeV1,
  type RunJournalRecordV1,
  isCrashRecoveryIncompleteActionV1,
} from "./facts.js";
import type { DurableJsonPayloadV1, JsonValue } from "./primitives.js";
import { assertInputFact } from "./validate-input-fact.js";
import { assertExactKeys, expectObject } from "./validate-primitives.js";
import {
  assertCheckpointSourcesInRange,
  assertDerivedDecision,
  assertTaskCheckpoint,
} from "./validate-wire.js";
import type { InputAttachmentV1 } from "./wire-model-response.js";

/**
 * 校验 journal record 的内容（两支：`input_fact` / `derived_decision`），
 * 并把收窄结果交给类型系统。
 *
 * 原先返回 `void`，唯一调用点只能自己补一次断言
 * （`parse.ts:93` 的 `envelope.record as RunJournalRecordV1`）。§R7 记的就是
 * 这类"内部校验器不告诉编译器"的签名问题 —— 同一个文件里
 * `assertRunJournalEnvelopeV1` 的公共边界写法一直是对的。
 */
export function assertRecord(value: unknown): asserts value is RunJournalRecordV1 {
  const record = expectObject(value, "record");
  if (record.kind === "input_fact") {
    assertExactKeys(record, ["kind", "fact"], [], "input record");
    assertInputFact(record.fact);
    return;
  }
  if (record.kind === "derived_decision") {
    assertExactKeys(record, ["kind", "decision"], [], "decision record");
    assertDerivedDecision(record.decision);
    return;
  }
  throw new Error("Unsupported journal record kind");
}

export function assertLifecycleIdentities(envelopes: readonly RunJournalEnvelopeV1[]): void {
  const acceptedInputs = new Map<string, Extract<InputFactV1, { type: "input.accepted" }>>();
  const promotedInputIds = new Set<string>();
  const executionBudgets = new Map<
    string,
    Extract<InputFactV1, { type: "execution.budget_observed" }>
  >();
  const models = new Map<
    string,
    {
      readonly turn: number;
      settled: boolean;
      hasToolCalls: boolean;
      nextToolOrder: number;
    }
  >();
  const tools = new Map<
    string,
    {
      readonly turn: number;
      readonly sourceIndex: number;
      readonly tool: string;
      dispatched: boolean;
      settled: boolean;
      permissionResolution?: "allow_once" | "allow_rule" | "deny";
      checkpointSeq?: number;
    }
  >();
  let latestEffectCheckpointSeq = 0;
  let latestModelTurn = 0;
  const checkpointIds = new Set<string>();
  const checkpointClaimIds = new Set<string>();
  const claimedCheckpointIds = new Set<string>();
  const checkpointClaims = new Map<
    string,
    {
      readonly checkpointId: string;
      readonly supersedesCheckpointId?: string;
      readonly policyVersion: string;
      readonly sourceFromSeq: number;
      readonly sourceThroughSeq: number;
      readonly sourceInputHash: string;
      settlement?: Extract<InputFactV1, { type: "context.checkpoint_distillation_settled" }>;
      recorded: boolean;
    }
  >();
  let openCheckpointClaimId: string | undefined;
  let completedUnrecordedClaimId: string | undefined;
  let latestCheckpoint:
    | {
        readonly checkpointId: string;
        readonly sourceFromSeq: number;
        readonly sourceThroughSeq: number;
      }
    | undefined;
  let terminalDecisionBoundaryOpen = false;
  let terminalBoundaryReducerVersion: string | undefined;
  let terminalBoundaryAction: ControlDecisionActionV1 | undefined;
  const unauthorizedPromotionReducerVersions = new Set<string>();
  const enabledSegmentReducerVersions = new Set<string>();
  const memoryQueryIds = new Set<string>();
  const memoryPersonaProjectionQueryIds = new Set<string>();
  const memoryRawEvidenceQueryIds = new Set<string>();
  const memoryTopicEvidenceQueryIds = new Set<string>();
  const memoryEvidenceCoverageQueryIds = new Set<string>();
  const memoryWrites = new Map<
    string,
    {
      readonly sourceFromSeq: number;
      readonly sourceThroughSeq: number;
      proposalHash?: string;
      staged: boolean;
      settled: boolean;
      settlementStatus?: "completed" | "noop" | "failed" | "interrupted";
      settlementIds?: ReadonlySet<string>;
    }
  >();
  const topicOrganizations = new Map<
    string,
    {
      readonly sourceWriteId: string;
      readonly scopeFingerprint: string;
      proposalHash?: string;
      topicCount?: number;
      staged: boolean;
      settled: boolean;
    }
  >();
  const activities = new Map<string, { readonly activityKind: string; settled: boolean }>();
  const completionReviews = new Map<
    string,
    {
      readonly candidateHash: string;
      readonly reviewerId: string;
      settled: boolean;
    }
  >();
  let expectedSegmentIndex = 1;

  for (let envelopeIndex = 0; envelopeIndex < envelopes.length; envelopeIndex += 1) {
    const envelope = envelopes[envelopeIndex] as RunJournalEnvelopeV1;
    if (envelope.record.kind === "derived_decision") {
      const action = envelope.record.decision.action;
      if (
        action.kind === "complete" &&
        [...activities.values()].some((activity) => !activity.settled)
      ) {
        throw new Error("completed decision cannot abandon active activities");
      }
      if (action.kind !== "continue") {
        terminalDecisionBoundaryOpen = true;
        terminalBoundaryReducerVersion = envelope.record.decision.reducerVersion;
        terminalBoundaryAction = action;
      }
      continue;
    }
    const fact = envelope.record.fact;
    switch (fact.type) {
      case "execution.budget_observed": {
        if (!promotedInputIds.has(fact.inputId))
          throw new Error("Execution budget requires promoted input");
        const previous = executionBudgets.get(fact.inputId);
        if (
          previous &&
          (previous.deadlineAtMs !== fact.deadlineAtMs ||
            previous.reserveMs !== fact.reserveMs ||
            previous.admissionPolicy !== fact.admissionPolicy ||
            fact.observedAtMs < previous.observedAtMs)
        )
          throw new Error("Execution budget cannot reset or move its clock backwards");
        executionBudgets.set(fact.inputId, fact);
        break;
      }
      case "input.accepted": {
        if (acceptedInputs.has(fact.inputId) || promotedInputIds.has(fact.inputId)) {
          throw new Error(`duplicate accepted input: ${fact.inputId}`);
        }
        acceptedInputs.set(fact.inputId, fact);
        break;
      }
      case "input.promoted": {
        if (promotedInputIds.has(fact.inputId)) {
          throw new Error(`duplicate promoted input: ${fact.inputId}`);
        }
        const accepted = acceptedInputs.get(fact.inputId);
        if (fact.delivery !== "initial" && !accepted) {
          throw new Error(
            `promoted ${fact.delivery} input has no durable admission: ${fact.inputId}`,
          );
        }
        if (accepted && !sameAcceptedInputPromotion(accepted, fact)) {
          throw new Error(`promoted input identity mismatch: ${fact.inputId}`);
        }
        promotedInputIds.add(fact.inputId);
        if (
          fact.delivery !== "initial" &&
          terminalDecisionBoundaryOpen &&
          terminalBoundaryReducerVersion !== undefined
        ) {
          if (enabledSegmentReducerVersions.has(terminalBoundaryReducerVersion)) {
            throw new Error("terminal promotion requires a work segment marker");
          }
          unauthorizedPromotionReducerVersions.add(terminalBoundaryReducerVersion);
        }
        break;
      }
      case "work.segment_started": {
        if (fact.segmentIndex !== expectedSegmentIndex) {
          throw new Error("work segment indexes must be contiguous from 1");
        }
        const previous = envelopes[envelopeIndex - 1];
        if (!previous || previous.record.kind !== "derived_decision") {
          throw new Error("work segment must immediately follow a decision");
        }
        const decision = previous.record.decision;
        if (
          decision.action.kind !== "complete" &&
          !(decision.action.kind === "wait" && decision.action.waitFor === "user") &&
          !isCrashRecoveryIncompleteActionV1(decision.action)
        ) {
          throw new Error("work segment requires an eligible terminal decision");
        }
        if (fact.reducerVersion !== decision.reducerVersion) {
          throw new Error("work segment reducerVersion does not match decision");
        }
        if (fact.previousDecisionStateHash !== decision.stateHash) {
          throw new Error("work segment previous decision stateHash mismatch");
        }
        if (!sameControlDecisionAction(fact.previousAction, decision.action)) {
          throw new Error("work segment previous action mismatch");
        }
        if (unauthorizedPromotionReducerVersions.has(fact.reducerVersion)) {
          throw new Error("terminal promotion requires a work segment marker");
        }
        if (!acceptedInputs.has(fact.inputId)) {
          throw new Error(`work segment input has no durable admission: ${fact.inputId}`);
        }
        if (promotedInputIds.has(fact.inputId)) {
          throw new Error(`work segment input is already promoted: ${fact.inputId}`);
        }
        const next = envelopes[envelopeIndex + 1];
        if (
          !next ||
          next.record.kind !== "input_fact" ||
          next.record.fact.type !== "input.promoted" ||
          next.record.fact.inputId !== fact.inputId
        ) {
          throw new Error("work segment must immediately precede its promotion");
        }
        if ([...models.values()].some((model) => !model.settled)) {
          throw new Error("work segment cannot cross an unsettled model call");
        }
        if ([...tools.values()].some((tool) => !tool.settled)) {
          throw new Error("work segment cannot cross an unsettled tool lifecycle");
        }
        if (openCheckpointClaimId || completedUnrecordedClaimId) {
          throw new Error("work segment cannot cross pending checkpoint distillation");
        }
        expectedSegmentIndex += 1;
        enabledSegmentReducerVersions.add(fact.reducerVersion);
        terminalDecisionBoundaryOpen = false;
        terminalBoundaryReducerVersion = undefined;
        terminalBoundaryAction = undefined;
        unauthorizedPromotionReducerVersions.delete(fact.reducerVersion);
        break;
      }
      case "memory.retrieval_settled": {
        if (memoryQueryIds.has(fact.queryId)) {
          throw new Error(`duplicate memory retrieval query: ${fact.queryId}`);
        }
        memoryQueryIds.add(fact.queryId);
        break;
      }
      case "memory.persona_projection_settled": {
        if (!memoryQueryIds.has(fact.queryId)) {
          throw new Error("memory persona projection requires a retrieval query");
        }
        if (memoryPersonaProjectionQueryIds.has(fact.queryId)) {
          throw new Error(`duplicate memory persona projection query: ${fact.queryId}`);
        }
        memoryPersonaProjectionQueryIds.add(fact.queryId);
        break;
      }
      case "memory.raw_evidence_settled": {
        if (!memoryQueryIds.has(fact.queryId)) {
          throw new Error("memory raw evidence requires a retrieval query");
        }
        if (memoryRawEvidenceQueryIds.has(fact.queryId)) {
          throw new Error(`duplicate memory raw evidence query: ${fact.queryId}`);
        }
        memoryRawEvidenceQueryIds.add(fact.queryId);
        break;
      }
      case "memory.topic_evidence_settled": {
        if (!memoryQueryIds.has(fact.queryId)) {
          throw new Error("memory topic evidence requires a retrieval query");
        }
        if (memoryTopicEvidenceQueryIds.has(fact.queryId)) {
          throw new Error(`duplicate memory topic evidence query: ${fact.queryId}`);
        }
        memoryTopicEvidenceQueryIds.add(fact.queryId);
        break;
      }
      case "memory.evidence_coverage_settled": {
        if (!memoryQueryIds.has(fact.queryId)) {
          throw new Error("memory evidence coverage requires a retrieval query");
        }
        if (
          !memoryTopicEvidenceQueryIds.has(fact.queryId) ||
          !memoryRawEvidenceQueryIds.has(fact.queryId)
        ) {
          throw new Error("memory evidence coverage requires prior topic and raw evidence");
        }
        if (memoryEvidenceCoverageQueryIds.has(fact.queryId)) {
          throw new Error(`duplicate memory evidence coverage query: ${fact.queryId}`);
        }
        memoryEvidenceCoverageQueryIds.add(fact.queryId);
        break;
      }
      case "memory.write_claimed": {
        if (memoryWrites.has(fact.writeId)) {
          throw new Error(`duplicate memory write claim: ${fact.writeId}`);
        }
        if (fact.sourceThroughSeq >= envelope.seq) {
          throw new Error("memory write cannot cover itself or future facts");
        }
        memoryWrites.set(fact.writeId, {
          sourceFromSeq: fact.sourceFromSeq,
          sourceThroughSeq: fact.sourceThroughSeq,
          staged: false,
          settled: false,
        });
        break;
      }
      case "memory.candidate_staged": {
        const write = memoryWrites.get(fact.writeId);
        if (!write) {
          throw new Error(`memory candidate has no write claim: ${fact.writeId}`);
        }
        if (write.staged || write.settled) {
          throw new Error(`duplicate memory candidate stage: ${fact.writeId}`);
        }
        for (const atom of fact.atoms) {
          if (
            atom.sourceSeqs.some((seq) => seq < write.sourceFromSeq || seq > write.sourceThroughSeq)
          ) {
            throw new Error(`memory atom source is outside claimed range: ${atom.atomId}`);
          }
        }
        write.proposalHash = fact.proposalHash;
        write.staged = true;
        break;
      }
      case "memory.write_settled": {
        const write = memoryWrites.get(fact.writeId);
        if (!write) {
          throw new Error(`memory write settlement has no claim: ${fact.writeId}`);
        }
        if (write.settled) {
          throw new Error(`duplicate memory write settlement: ${fact.writeId}`);
        }
        if ((fact.status === "completed" || fact.status === "noop") && !write.staged) {
          throw new Error(`memory ${fact.status} settlement requires staged candidates`);
        }
        if (fact.proposalHash !== undefined && fact.proposalHash !== write.proposalHash) {
          throw new Error("memory write proposal hash mismatch");
        }
        if (write.staged && fact.status !== "interrupted" && fact.proposalHash === undefined) {
          throw new Error("staged memory settlement requires proposal hash");
        }
        write.settled = true;
        write.settlementStatus = fact.status;
        write.settlementIds = new Set([...fact.storedIds, ...fact.invalidatedIds]);
        break;
      }
      case "memory.topic_organization_claimed": {
        if (topicOrganizations.has(fact.organizationId)) {
          throw new Error(`duplicate memory topic organization claim: ${fact.organizationId}`);
        }
        const sourceWrite = memoryWrites.get(fact.sourceWriteId);
        if (
          !sourceWrite?.settled ||
          (sourceWrite.settlementStatus !== "completed" && sourceWrite.settlementStatus !== "noop")
        ) {
          throw new Error("memory topic organization requires a completed source write");
        }
        if (
          fact.sourceProposalHash !== sourceWrite.proposalHash ||
          fact.sourceMemoryIds.some((id) => !sourceWrite.settlementIds?.has(id))
        ) {
          throw new Error("memory topic organization source mismatch");
        }
        topicOrganizations.set(fact.organizationId, {
          sourceWriteId: fact.sourceWriteId,
          scopeFingerprint: fact.scopeFingerprint,
          staged: false,
          settled: false,
        });
        break;
      }
      case "memory.topic_candidate_staged": {
        const organization = topicOrganizations.get(fact.organizationId);
        if (!organization) {
          throw new Error("memory topic candidate has no organization claim");
        }
        if (organization.staged || organization.settled) {
          throw new Error("duplicate memory topic candidate stage");
        }
        if (fact.topics.some((topic) => topic.scopeFingerprint !== organization.scopeFingerprint)) {
          throw new Error("memory topic candidate scope mismatch");
        }
        organization.proposalHash = fact.proposalHash;
        organization.topicCount = fact.topics.length;
        organization.staged = true;
        break;
      }
      case "memory.topic_organization_settled": {
        const organization = topicOrganizations.get(fact.organizationId);
        if (!organization) {
          throw new Error("memory topic settlement has no organization claim");
        }
        if (organization.settled) {
          throw new Error("duplicate memory topic organization settlement");
        }
        if ((fact.status === "completed" || fact.status === "noop") && !organization.staged) {
          throw new Error("successful memory topic settlement requires stage");
        }
        if (fact.proposalHash !== undefined && fact.proposalHash !== organization.proposalHash) {
          throw new Error("memory topic proposal hash mismatch");
        }
        if (
          organization.staged &&
          fact.status !== "interrupted" &&
          fact.proposalHash === undefined
        ) {
          throw new Error("staged memory topic settlement requires proposal hash");
        }
        if (
          fact.status === "completed" &&
          (organization.topicCount === 0 || fact.topicIds.length !== organization.topicCount)
        ) {
          throw new Error("completed memory topic settlement count mismatch");
        }
        if (
          fact.status === "noop" &&
          (organization.topicCount !== 0 || fact.topicIds.length !== 0)
        ) {
          throw new Error("noop memory topic settlement must have no topics");
        }
        organization.settled = true;
        break;
      }
      case "model.dispatch_recorded": {
        if (terminalDecisionBoundaryOpen) {
          throw new Error("model dispatch requires a work segment after terminal decision");
        }
        if (models.has(fact.modelCallId)) {
          throw new Error(`duplicate model dispatch: ${fact.modelCallId}`);
        }
        if (fact.turn <= latestModelTurn) {
          throw new Error("model dispatch turns must be strictly increasing");
        }
        models.set(fact.modelCallId, {
          turn: fact.turn,
          settled: false,
          hasToolCalls: false,
          nextToolOrder: 0,
        });
        latestModelTurn = fact.turn;
        break;
      }
      case "model.settled": {
        const model = models.get(fact.modelCallId);
        if (!model) {
          throw new Error(`model settlement has no dispatch: ${fact.modelCallId}`);
        }
        if (model.turn !== fact.turn) {
          throw new Error(`model settlement turn mismatch: ${fact.modelCallId}`);
        }
        if (model.settled) {
          throw new Error(`duplicate model settlement: ${fact.modelCallId}`);
        }
        model.settled = true;
        model.hasToolCalls = fact.hasToolCalls;
        break;
      }
      case "tool.call_observed": {
        const model = models.get(fact.modelCallId);
        if (!model) {
          throw new Error(`observed tool call has no model dispatch: ${fact.modelCallId}`);
        }
        if (!model.settled) {
          throw new Error(`observed tool call precedes model settlement: ${fact.modelCallId}`);
        }
        if (model.turn !== fact.turn) {
          throw new Error(`observed tool call turn mismatch: ${fact.modelCallId}`);
        }
        if (!model.hasToolCalls) {
          throw new Error(`observed tool call contradicts model settlement: ${fact.modelCallId}`);
        }
        if (fact.order !== model.nextToolOrder) {
          throw new Error(`observed tool call order is not contiguous: ${fact.modelCallId}`);
        }
        if (tools.has(fact.callId)) {
          throw new Error(`duplicate observed tool call: ${fact.callId}`);
        }
        tools.set(fact.callId, {
          turn: fact.turn,
          sourceIndex: fact.order,
          tool: fact.tool,
          dispatched: false,
          settled: false,
        });
        model.nextToolOrder += 1;
        break;
      }
      case "tool.dispatch_recorded": {
        const tool = tools.get(fact.callId);
        if (!tool) {
          throw new Error(`tool dispatch has no observed call: ${fact.callId}`);
        }
        if (tool.turn !== fact.turn || tool.sourceIndex !== fact.sourceIndex) {
          throw new Error(`tool dispatch identity mismatch: ${fact.callId}`);
        }
        if (tool.dispatched) {
          throw new Error(`duplicate tool dispatch: ${fact.callId}`);
        }
        if (tool.settled) {
          throw new Error(`tool dispatch follows settlement: ${fact.callId}`);
        }
        tool.dispatched = true;
        break;
      }
      case "tool.permission_resolved": {
        const tool = tools.get(fact.callId);
        if (!tool) {
          throw new Error(`tool permission has no observed call: ${fact.callId}`);
        }
        if (!tool.dispatched) {
          throw new Error(`tool permission has no dispatch: ${fact.callId}`);
        }
        if (tool.settled) {
          throw new Error(`tool permission follows settlement: ${fact.callId}`);
        }
        if (
          tool.turn !== fact.turn ||
          tool.sourceIndex !== fact.sourceIndex ||
          tool.tool !== fact.tool
        ) {
          throw new Error(`tool permission identity mismatch: ${fact.callId}`);
        }
        if (tool.permissionResolution !== undefined) {
          throw new Error(`duplicate tool permission: ${fact.callId}`);
        }
        tool.permissionResolution = fact.resolution;
        break;
      }
      case "tool.effect_checkpoint_allocated": {
        const tool = tools.get(fact.callId);
        if (!tool) {
          throw new Error(`tool effect checkpoint has no observed call: ${fact.callId}`);
        }
        if (!tool.dispatched) {
          throw new Error(`tool effect checkpoint has no dispatch: ${fact.callId}`);
        }
        if (tool.settled) {
          throw new Error(`tool effect checkpoint follows settlement: ${fact.callId}`);
        }
        if (tool.turn !== fact.turn || tool.sourceIndex !== fact.sourceIndex) {
          throw new Error(`tool effect checkpoint identity mismatch: ${fact.callId}`);
        }
        if (
          tool.permissionResolution !== "allow_once" &&
          tool.permissionResolution !== "allow_rule"
        ) {
          throw new Error(`tool effect checkpoint requires allowed permission: ${fact.callId}`);
        }
        if (tool.checkpointSeq !== undefined) {
          throw new Error(`duplicate tool effect checkpoint: ${fact.callId}`);
        }
        if (fact.checkpointSeq <= latestEffectCheckpointSeq) {
          throw new Error("tool effect checkpoint sequence must be strictly increasing");
        }
        tool.checkpointSeq = fact.checkpointSeq;
        latestEffectCheckpointSeq = fact.checkpointSeq;
        break;
      }
      case "tool.settled": {
        const tool = tools.get(fact.callId);
        if (!tool) {
          throw new Error(`tool settlement has no observed call: ${fact.callId}`);
        }
        if (tool.settled) {
          throw new Error(`duplicate tool settlement: ${fact.callId}`);
        }
        const maySettleWithoutDispatch = fact.status === "cancelled" || fact.status === "rejected";
        if (!tool.dispatched && !maySettleWithoutDispatch) {
          throw new Error(`tool settlement has no dispatch: ${fact.callId}`);
        }
        if (tool.permissionResolution === "deny" && fact.status !== "rejected") {
          throw new Error(`denied tool permission requires rejected settlement: ${fact.callId}`);
        }
        if (
          (fact.status === "completed" || fact.status === "unknown") &&
          tool.permissionResolution !== "allow_once" &&
          tool.permissionResolution !== "allow_rule"
        ) {
          throw new Error(`executed tool settlement requires allowed permission: ${fact.callId}`);
        }
        tool.settled = true;
        break;
      }
      case "runtime.activity_started": {
        if (terminalDecisionBoundaryOpen) {
          throw new Error(
            `runtime activity cannot start after a terminal decision: ${fact.activityId}`,
          );
        }
        if (activities.has(fact.activityId)) {
          throw new Error(`duplicate runtime activity: ${fact.activityId}`);
        }
        activities.set(fact.activityId, {
          activityKind: fact.activityKind,
          settled: false,
        });
        break;
      }
      case "runtime.activity_settled": {
        const activity = activities.get(fact.activityId);
        if (!activity) {
          throw new Error(`runtime activity settlement has no start: ${fact.activityId}`);
        }
        if (activity.settled) {
          throw new Error(`duplicate runtime activity settlement: ${fact.activityId}`);
        }
        activity.settled = true;
        if (
          terminalBoundaryAction?.kind === "wait" &&
          terminalBoundaryAction.waitFor === "external"
        ) {
          terminalDecisionBoundaryOpen = false;
          terminalBoundaryReducerVersion = undefined;
          terminalBoundaryAction = undefined;
        }
        break;
      }
      case "completion.review_claimed": {
        if (completionReviews.has(fact.reviewId)) {
          throw new Error(`duplicate completion review: ${fact.reviewId}`);
        }
        if (fact.sourceThroughSeq >= envelope.seq) {
          throw new Error("completion review cannot cover itself or future facts");
        }
        completionReviews.set(fact.reviewId, {
          candidateHash: fact.candidateHash,
          reviewerId: fact.reviewerId,
          settled: false,
        });
        break;
      }
      case "completion.review_settled": {
        const review = completionReviews.get(fact.reviewId);
        if (!review) {
          throw new Error(`completion review settlement has no claim: ${fact.reviewId}`);
        }
        if (review.settled) {
          throw new Error(`duplicate completion review settlement: ${fact.reviewId}`);
        }
        if (
          review.reviewerId === "paw.environment-audit.v1" &&
          fact.verdict === "allow" &&
          !fact.environmentAudit
        )
          throw new Error("Environment audit allow requires evidence");
        if (fact.environmentAudit && review.reviewerId !== "paw.environment-audit.v1")
          throw new Error("Environment audit reviewer mismatch");
        if (fact.environmentAudit && fact.environmentAudit.candidateHash !== review.candidateHash)
          throw new Error("Environment audit candidate binding mismatch");
        review.settled = true;
        break;
      }
      case "context.checkpoint_distillation_claimed": {
        if (openCheckpointClaimId || completedUnrecordedClaimId) {
          throw new Error("checkpoint distillation already has pending work");
        }
        if (checkpointClaimIds.has(fact.claimId)) {
          throw new Error(`duplicate checkpoint distillation claim: ${fact.claimId}`);
        }
        if (checkpointIds.has(fact.checkpointId) || claimedCheckpointIds.has(fact.checkpointId)) {
          throw new Error(`duplicate context checkpoint: ${fact.checkpointId}`);
        }
        if (fact.sourceThroughSeq >= envelope.seq) {
          throw new Error("checkpoint distillation cannot cover itself or future facts");
        }
        if (!latestCheckpoint && fact.supersedesCheckpointId !== undefined) {
          throw new Error("first checkpoint distillation cannot supersede another");
        }
        if (latestCheckpoint && fact.supersedesCheckpointId !== latestCheckpoint.checkpointId) {
          throw new Error("checkpoint distillation supersession is stale");
        }
        if (
          latestCheckpoint &&
          (fact.sourceFromSeq > latestCheckpoint.sourceFromSeq ||
            fact.sourceThroughSeq < latestCheckpoint.sourceThroughSeq)
        ) {
          throw new Error("checkpoint distillation source range must be monotonic");
        }
        checkpointClaimIds.add(fact.claimId);
        claimedCheckpointIds.add(fact.checkpointId);
        checkpointClaims.set(fact.claimId, {
          checkpointId: fact.checkpointId,
          ...(fact.supersedesCheckpointId === undefined
            ? {}
            : { supersedesCheckpointId: fact.supersedesCheckpointId }),
          policyVersion: fact.policyVersion,
          sourceFromSeq: fact.sourceFromSeq,
          sourceThroughSeq: fact.sourceThroughSeq,
          sourceInputHash: fact.sourceInputHash,
          recorded: false,
        });
        openCheckpointClaimId = fact.claimId;
        break;
      }
      case "context.checkpoint_distillation_settled": {
        const claim = checkpointClaims.get(fact.claimId);
        if (!claim) {
          throw new Error(`checkpoint distillation settlement has no claim: ${fact.claimId}`);
        }
        if (openCheckpointClaimId !== fact.claimId) {
          throw new Error(`checkpoint distillation settlement is not active: ${fact.claimId}`);
        }
        if (claim.settlement) {
          throw new Error(`duplicate checkpoint distillation settlement: ${fact.claimId}`);
        }
        if (fact.status === "completed") {
          // 这里原先写 `fact.checkpoint as DurableJsonPayloadV1` 与
          // `checkpoint.value as unknown as TaskCheckpointV1` —— 两个断言都在替
          // **另一个文件里**做过的校验撒谎：`validate-input-fact.ts` 的同一事实
          // 分支已经先 assertDurableJsonPayload 再 assertTaskCheckpoint。就地
          // 重校验一次（O(items)），换来这段代码不再依赖"上游校验过"这个类型
          // 系统看不见的前提（§R7）。少了这层显式校验时，`checkpoint.value`
          // 若是任意 JSON，`taskCheckpointItems` 会在展开 `undefined` 时抛
          // TypeError，而不是给出干净的校验错误。
          const checkpoint = fact.checkpoint;
          if (!checkpoint) {
            // 原先的 `as DurableJsonPayloadV1` 顺手把这个可选字段断言成了必填。
            // 上游（`validate-input-fact.ts:917`）确实要求 completed 必须带
            // checkpoint，但那是另一个文件的前提；这里给出干净的校验错误，
            // 而不是让 `checkpoint.kind` 抛 TypeError。
            throw new Error(
              `completed checkpoint distillation settlement has no checkpoint: ${fact.claimId}`,
            );
          }
          if (checkpoint.kind === "inline") {
            assertTaskCheckpoint(checkpoint.value, "checkpoint.value");
            assertCheckpointSourcesInRange(
              checkpoint.value,
              claim.sourceFromSeq,
              claim.sourceThroughSeq,
            );
          }
          completedUnrecordedClaimId = fact.claimId;
        }
        claim.settlement = fact;
        openCheckpointClaimId = undefined;
        break;
      }
      case "context.checkpoint_recorded": {
        if (openCheckpointClaimId) {
          throw new Error("context checkpoint cannot bypass active distillation");
        }
        if (completedUnrecordedClaimId) {
          if (fact.distillationClaimId !== completedUnrecordedClaimId) {
            throw new Error("context checkpoint must record the completed distillation");
          }
        } else if (fact.distillationClaimId !== undefined) {
          throw new Error("context checkpoint has no completed distillation");
        }
        if (checkpointIds.has(fact.checkpointId)) {
          throw new Error(`duplicate context checkpoint: ${fact.checkpointId}`);
        }
        if (fact.sourceThroughSeq >= envelope.seq) {
          throw new Error("context checkpoint cannot cover itself or future facts");
        }
        if (!latestCheckpoint && fact.supersedesCheckpointId !== undefined) {
          throw new Error("first context checkpoint cannot supersede another");
        }
        if (latestCheckpoint && fact.supersedesCheckpointId !== latestCheckpoint.checkpointId) {
          throw new Error("context checkpoint supersession is stale");
        }
        if (
          latestCheckpoint &&
          (fact.sourceFromSeq > latestCheckpoint.sourceFromSeq ||
            fact.sourceThroughSeq < latestCheckpoint.sourceThroughSeq)
        ) {
          throw new Error("context checkpoint source range must be monotonic");
        }
        if (fact.distillationClaimId !== undefined) {
          const claim = checkpointClaims.get(fact.distillationClaimId);
          const settlement = claim?.settlement;
          if (
            !claim ||
            !settlement ||
            settlement.status !== "completed" ||
            settlement.checkpoint === undefined ||
            claim.recorded
          ) {
            throw new Error("context checkpoint distillation binding is incomplete");
          }
          if (
            claim.checkpointId !== fact.checkpointId ||
            claim.supersedesCheckpointId !== fact.supersedesCheckpointId ||
            claim.policyVersion !== fact.policyVersion ||
            claim.sourceFromSeq !== fact.sourceFromSeq ||
            claim.sourceThroughSeq !== fact.sourceThroughSeq ||
            claim.sourceInputHash !== fact.sourceInputHash ||
            !sameDurableJsonPayload(settlement.checkpoint, fact.checkpoint)
          ) {
            throw new Error("context checkpoint distillation binding mismatch");
          }
          claim.recorded = true;
          completedUnrecordedClaimId = undefined;
        } else if (claimedCheckpointIds.has(fact.checkpointId)) {
          throw new Error("context checkpoint cannot bypass its distillation claim");
        }
        checkpointIds.add(fact.checkpointId);
        latestCheckpoint = {
          checkpointId: fact.checkpointId,
          sourceFromSeq: fact.sourceFromSeq,
          sourceThroughSeq: fact.sourceThroughSeq,
        };
        break;
      }
    }
  }
}

export function sameControlDecisionAction(
  left: ControlDecisionActionV1,
  right: ControlDecisionActionV1,
): boolean {
  return (
    left.kind === right.kind &&
    left.reasonCode === right.reasonCode &&
    (left.kind !== "wait" || (right.kind === "wait" && left.waitFor === right.waitFor))
  );
}

export function sameDurableJsonPayload(
  left: DurableJsonPayloadV1,
  right: DurableJsonPayloadV1,
): boolean {
  if (left.kind !== right.kind || left.hash !== right.hash) return false;
  if (left.kind === "artifact_ref" && right.kind === "artifact_ref") {
    return left.artifactRef === right.artifactRef;
  }
  if (left.kind === "inline" && right.kind === "inline") {
    return sameJsonValue(left.value, right.value);
  }
  return false;
}

export function sameAcceptedInputPromotion(
  accepted: Extract<InputFactV1, { type: "input.accepted" }>,
  promoted: Extract<InputFactV1, { type: "input.promoted" }>,
): boolean {
  return (
    accepted.delivery === promoted.delivery &&
    accepted.content === promoted.content &&
    accepted.contentHash === promoted.contentHash &&
    sameInputAttachments(accepted.attachments, promoted.attachments)
  );
}

export function sameInputAttachments(
  left: readonly InputAttachmentV1[] | undefined,
  right: readonly InputAttachmentV1[] | undefined,
): boolean {
  const leftItems = left ?? [];
  const rightItems = right ?? [];
  return (
    leftItems.length === rightItems.length &&
    leftItems.every((item, index) => {
      const other = rightItems[index];
      return (
        other !== undefined &&
        item.attachmentId === other.attachmentId &&
        item.type === other.type &&
        item.name === other.name &&
        item.mimeType === other.mimeType &&
        sameDurableJsonPayload(item.content, other.content)
      );
    })
  );
}

export function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index] as JsonValue))
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
        sameJsonValue(leftRecord[key] as JsonValue, rightRecord[key] as JsonValue),
    )
  );
}
