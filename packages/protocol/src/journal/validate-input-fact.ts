/** Per-fact validation for the input fact union. */
import { assertEnvironmentAuditEvidenceV1 } from "../environment-audit.js";
import type { DurableJsonPayloadV1 } from "./primitives.js";
import {
  assertMemoryAtomProposal,
  assertMemoryCard,
  assertMemoryEvidenceCoverageItem,
  assertMemoryEvidenceRequirement,
  assertMemoryPersonaClaim,
  assertMemoryRawEvidenceSpan,
  assertMemoryTopicEvidenceState,
  assertMemoryTopicIndexEntry,
  assertMemoryTopicProposal,
} from "./validate-memory.js";
import {
  assertBoolean,
  assertDurableJsonPayload,
  assertExact,
  assertExactKeys,
  assertId,
  assertJsonValue,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertOneOf,
  assertOptionalStringField,
  assertPositiveInteger,
  assertSingleLineString,
  expectObject,
  hasOwn,
} from "./validate-primitives.js";
import {
  assertCheckpointSourcesInRange,
  assertControlDecisionAction,
  assertInputAttachments,
  assertModelResponse,
  assertTaskCheckpoint,
  assertToolObservation,
  assertUniqueBoundedIds,
} from "./validate-wire.js";
import {
  COMPLETION_REVIEW_POLICY_VERSION_V1,
  MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1,
  MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
  MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
  MEMORY_RETRIEVAL_POLICY_VERSION_V1,
  MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
  MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1,
  MEMORY_WRITE_POLICY_VERSION_V1,
  WORK_SEGMENT_POLICY_VERSION_V1,
} from "./versions.js";
import type { TaskCheckpointV1 } from "./wire-task-checkpoint.js";
import type { ToolObservationV1 } from "./wire-tool.js";

export function assertInputFact(value: unknown): void {
  const fact = expectObject(value, "input fact");
  switch (fact.type) {
    case "execution.budget_observed":
      assertExactKeys(
        fact,
        ["type", "inputId", "deadlineAtMs", "observedAtMs", "reserveMs"],
        ["admissionPolicy"],
        fact.type,
      );
      if (fact.admissionPolicy !== undefined && fact.admissionPolicy !== "recent_round_floor_v1")
        throw new Error("Invalid execution admission policy");
      assertId(fact.inputId, "inputId");
      for (const key of ["deadlineAtMs", "observedAtMs", "reserveMs"]) {
        assertNonNegativeInteger(fact[key], key);
        if (!Number.isSafeInteger(fact[key])) throw new Error(`Invalid execution budget ${key}`);
      }
      return;
    case "attempt.started":
      assertExactKeys(fact, ["type", "goalHash", "configHash"], [], fact.type);
      assertNonEmptyString(fact.goalHash, "goalHash");
      assertNonEmptyString(fact.configHash, "configHash");
      return;
    case "input.accepted":
      assertExactKeys(
        fact,
        ["type", "inputId", "delivery", "content", "contentHash", "callerId"],
        ["attachments"],
        fact.type,
      );
      assertId(fact.inputId, "inputId");
      assertOneOf(fact.delivery, ["steer", "queue"], "delivery");
      assertNonEmptyString(fact.content, "content");
      assertNonEmptyString(fact.contentHash, "contentHash");
      assertId(fact.callerId, "callerId");
      if (hasOwn(fact, "attachments")) {
        assertInputAttachments(fact.attachments);
      }
      return;
    case "input.promoted":
      assertExactKeys(
        fact,
        ["type", "inputId", "delivery", "content", "contentHash"],
        ["attachments"],
        fact.type,
      );
      assertId(fact.inputId, "inputId");
      assertOneOf(fact.delivery, ["initial", "steer", "queue"], "delivery");
      assertNonEmptyString(fact.content, "content");
      assertNonEmptyString(fact.contentHash, "contentHash");
      if (hasOwn(fact, "attachments")) {
        assertInputAttachments(fact.attachments);
      }
      return;
    case "work.segment_started":
      assertExactKeys(
        fact,
        [
          "type",
          "segmentIndex",
          "inputId",
          "reducerVersion",
          "previousDecisionStateHash",
          "previousAction",
          "policyVersion",
        ],
        [],
        fact.type,
      );
      assertPositiveInteger(fact.segmentIndex, "segmentIndex");
      assertId(fact.inputId, "inputId");
      assertNonEmptyString(fact.reducerVersion, "reducerVersion");
      assertNonEmptyString(fact.previousDecisionStateHash, "previousDecisionStateHash");
      assertControlDecisionAction(fact.previousAction, "previousAction");
      assertExact(fact.policyVersion, WORK_SEGMENT_POLICY_VERSION_V1, "policyVersion");
      return;
    case "memory.retrieval_settled":
      assertExactKeys(
        fact,
        ["type", "queryId", "trigger", "providerVersion", "policyVersion", "status", "cards"],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "queryId");
      assertOneOf(fact.trigger, ["task_start", "work_segment_start"], "memory trigger");
      assertNonEmptyString(fact.providerVersion, "providerVersion");
      assertExact(fact.policyVersion, MEMORY_RETRIEVAL_POLICY_VERSION_V1, "policyVersion");
      assertOneOf(fact.status, ["completed", "degraded", "failed", "disabled"], "memory status");
      if (!Array.isArray(fact.cards) || fact.cards.length > 64) {
        throw new Error("memory cards must be a bounded array");
      }
      for (const card of fact.cards) assertMemoryCard(card);
      assertOptionalStringField(fact, "reasonCode");
      if ((fact.status === "failed" || fact.status === "disabled") && fact.cards.length > 0) {
        throw new Error(`${fact.status} memory retrieval cannot contain cards`);
      }
      return;
    case "memory.write_claimed":
      assertExactKeys(
        fact,
        [
          "type",
          "writeId",
          "trigger",
          "policyVersion",
          "extractorVersion",
          "scopeFingerprint",
          "sourceFromSeq",
          "sourceThroughSeq",
          "sourceInputHash",
          "claimedAt",
        ],
        [],
        fact.type,
      );
      assertId(fact.writeId, "memory writeId");
      assertOneOf(
        fact.trigger,
        ["task_terminal", "work_segment_terminal", "explicit_user_request"],
        "memory write trigger",
      );
      assertExact(fact.policyVersion, MEMORY_WRITE_POLICY_VERSION_V1, "memory write policyVersion");
      assertNonEmptyString(fact.extractorVersion, "memory extractorVersion");
      assertNonEmptyString(fact.scopeFingerprint, "memory scopeFingerprint");
      assertPositiveInteger(fact.sourceFromSeq, "memory sourceFromSeq");
      assertPositiveInteger(fact.sourceThroughSeq, "memory sourceThroughSeq");
      if ((fact.sourceFromSeq as number) > (fact.sourceThroughSeq as number)) {
        throw new Error("memory source range is reversed");
      }
      assertNonEmptyString(fact.sourceInputHash, "memory sourceInputHash");
      assertNonNegativeInteger(fact.claimedAt, "memory claimedAt");
      return;
    case "memory.candidate_staged":
      assertExactKeys(fact, ["type", "writeId", "proposalHash", "atoms"], [], fact.type);
      assertId(fact.writeId, "memory writeId");
      assertNonEmptyString(fact.proposalHash, "memory proposalHash");
      if (!Array.isArray(fact.atoms) || fact.atoms.length > 16) {
        throw new Error("memory atoms must be a bounded array");
      }
      for (const atom of fact.atoms) assertMemoryAtomProposal(atom);
      return;
    case "memory.write_settled":
      assertExactKeys(
        fact,
        ["type", "writeId", "status", "storedIds", "invalidatedIds", "skippedAtomIds", "settledAt"],
        ["proposalHash", "reasonCode"],
        fact.type,
      );
      assertId(fact.writeId, "memory writeId");
      assertOneOf(
        fact.status,
        ["completed", "noop", "failed", "interrupted"],
        "memory write status",
      );
      assertOptionalStringField(fact, "proposalHash");
      assertOptionalStringField(fact, "reasonCode");
      for (const field of ["storedIds", "invalidatedIds", "skippedAtomIds"] as const) {
        const ids = fact[field];
        if (!Array.isArray(ids) || ids.length > 32) {
          throw new Error(`${field} must be a bounded array`);
        }
        const seen = new Set<string>();
        for (const id of ids) {
          assertId(id, field);
          if (seen.has(id as string)) {
            throw new Error(`${field} must not contain duplicate ids`);
          }
          seen.add(id as string);
        }
      }
      assertNonNegativeInteger(fact.settledAt, "memory settledAt");
      return;
    case "memory.topic_organization_claimed":
      assertExactKeys(
        fact,
        [
          "type",
          "organizationId",
          "policyVersion",
          "extractorVersion",
          "scopeFingerprint",
          "sourceWriteId",
          "sourceProposalHash",
          "sourceMemoryIds",
          "sourceRevision",
          "claimedAt",
        ],
        [],
        fact.type,
      );
      assertId(fact.organizationId, "memory topic organizationId");
      assertExact(
        fact.policyVersion,
        MEMORY_TOPIC_ORGANIZATION_POLICY_VERSION_V1,
        "memory topic organization policyVersion",
      );
      assertNonEmptyString(fact.extractorVersion, "memory topic extractorVersion");
      assertNonEmptyString(fact.scopeFingerprint, "memory topic scopeFingerprint");
      assertId(fact.sourceWriteId, "memory topic sourceWriteId");
      assertNonEmptyString(fact.sourceProposalHash, "memory topic sourceProposalHash");
      assertUniqueBoundedIds(fact.sourceMemoryIds, 64, "memory topic sourceMemoryIds", true);
      assertNonEmptyString(fact.sourceRevision, "memory topic sourceRevision");
      assertNonNegativeInteger(fact.claimedAt, "memory topic claimedAt");
      return;
    case "memory.topic_candidate_staged":
      assertExactKeys(fact, ["type", "organizationId", "proposalHash", "topics"], [], fact.type);
      assertId(fact.organizationId, "memory topic organizationId");
      assertNonEmptyString(fact.proposalHash, "memory topic proposalHash");
      if (!Array.isArray(fact.topics) || fact.topics.length > 16) {
        throw new Error("memory topics must be a bounded array");
      }
      for (const topic of fact.topics) assertMemoryTopicProposal(topic);
      return;
    case "memory.topic_organization_settled":
      assertExactKeys(
        fact,
        ["type", "organizationId", "status", "topicIds", "snapshotIds", "settledAt"],
        ["proposalHash", "reasonCode"],
        fact.type,
      );
      assertId(fact.organizationId, "memory topic organizationId");
      assertOneOf(
        fact.status,
        ["completed", "noop", "failed", "interrupted"],
        "memory topic organization status",
      );
      assertOptionalStringField(fact, "proposalHash");
      assertOptionalStringField(fact, "reasonCode");
      assertUniqueBoundedIds(fact.topicIds, 16, "memory topicIds", false);
      assertUniqueBoundedIds(fact.snapshotIds, 16, "memory topic snapshotIds", false);
      if (fact.topicIds.length !== fact.snapshotIds.length) {
        throw new Error("memory topicIds and snapshotIds must have equal length");
      }
      if (fact.status !== "completed" && fact.topicIds.length > 0) {
        throw new Error("non-completed memory topic organization cannot publish ids");
      }
      assertNonNegativeInteger(fact.settledAt, "memory topic organization settledAt");
      return;
    case "memory.topic_evidence_settled": {
      assertExactKeys(
        fact,
        [
          "type",
          "queryId",
          "plannerVersion",
          "scopeFingerprint",
          "status",
          "indexRevision",
          "indexEntries",
          "evidenceStates",
          "settledAt",
        ],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "memory topic evidence queryId");
      assertExact(
        fact.plannerVersion,
        MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
        "memory topic evidence plannerVersion",
      );
      assertNonEmptyString(fact.scopeFingerprint, "memory topic evidence scopeFingerprint");
      assertOneOf(fact.status, ["completed", "noop", "failed"], "memory topic evidence status");
      assertNonEmptyString(fact.indexRevision, "memory topic evidence indexRevision");
      if (!Array.isArray(fact.indexEntries) || fact.indexEntries.length > 128) {
        throw new Error("memory topic index entries must be a bounded array");
      }
      const topicIds = new Set<string>();
      const snapshotIds = new Set<string>();
      for (const entry of fact.indexEntries) {
        assertMemoryTopicIndexEntry(entry);
        if (topicIds.has(entry.topicId) || snapshotIds.has(entry.snapshotId)) {
          throw new Error("memory topic index identities must be unique");
        }
        topicIds.add(entry.topicId);
        snapshotIds.add(entry.snapshotId);
      }
      if (!Array.isArray(fact.evidenceStates) || fact.evidenceStates.length > 32) {
        throw new Error("memory topic evidence states must be a bounded array");
      }
      const evidenceIds = new Set<string>();
      for (const state of fact.evidenceStates) {
        assertMemoryTopicEvidenceState(state);
        if (!topicIds.has(state.topicId) || !snapshotIds.has(state.snapshotId)) {
          throw new Error("memory topic evidence is outside the settled index");
        }
        const identity = `${state.topicId}\n${state.trajectoryId}\n${state.memoryId}`;
        if (evidenceIds.has(identity)) {
          throw new Error("memory topic evidence states must be unique");
        }
        evidenceIds.add(identity);
      }
      assertOptionalStringField(fact, "reasonCode");
      if (fact.status === "completed" && fact.evidenceStates.length === 0) {
        throw new Error("completed memory topic evidence requires states");
      }
      if (fact.status !== "completed" && fact.evidenceStates.length > 0) {
        throw new Error("non-completed memory topic evidence cannot contain states");
      }
      if (fact.status === "failed" && fact.indexEntries.length > 0) {
        throw new Error("failed memory topic evidence cannot contain an index");
      }
      assertNonNegativeInteger(fact.settledAt, "memory topic evidence settledAt");
      return;
    }
    case "memory.persona_projection_settled": {
      assertExactKeys(
        fact,
        [
          "type",
          "queryId",
          "projectorVersion",
          "scopeFingerprint",
          "status",
          "projectionRevision",
          "projectionKey",
          "claims",
          "sourceCount",
          "settledAt",
        ],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "memory persona projection queryId");
      assertExact(
        fact.projectorVersion,
        MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
        "memory persona projection projectorVersion",
      );
      assertNonEmptyString(fact.scopeFingerprint, "memory persona projection scopeFingerprint");
      assertOneOf(fact.status, ["completed", "noop", "failed"], "memory persona projection status");
      assertNonEmptyString(fact.projectionRevision, "memory persona projection revision");
      assertNonEmptyString(fact.projectionKey, "memory persona projection key");
      if (!Array.isArray(fact.claims) || fact.claims.length > 64) {
        throw new Error("memory persona claims must be a bounded array");
      }
      const claimIds = new Set<string>();
      for (const claim of fact.claims) {
        assertMemoryPersonaClaim(claim);
        if (claimIds.has(claim.memoryId)) {
          throw new Error("memory persona claim identities must be unique");
        }
        claimIds.add(claim.memoryId);
      }
      assertNonNegativeInteger(fact.sourceCount, "memory persona projection sourceCount");
      if ((fact.sourceCount as number) > 128) {
        throw new Error("memory persona projection sourceCount is too large");
      }
      assertOptionalStringField(fact, "reasonCode");
      if (fact.status === "completed" && fact.claims.length === 0) {
        throw new Error("completed memory persona projection requires claims");
      }
      if (fact.status !== "completed" && fact.claims.length > 0) {
        throw new Error("non-completed memory persona projection cannot contain claims");
      }
      if (fact.status !== "completed" && fact.sourceCount !== 0) {
        throw new Error("non-completed memory persona projection cannot contain sources");
      }
      assertNonNegativeInteger(fact.settledAt, "memory persona projection settledAt");
      return;
    }
    case "memory.raw_evidence_settled": {
      assertExactKeys(
        fact,
        [
          "type",
          "queryId",
          "resolverVersion",
          "scopeFingerprint",
          "status",
          "resolutionRevision",
          "spans",
          "settledAt",
        ],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "memory raw evidence queryId");
      assertExact(
        fact.resolverVersion,
        MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
        "memory raw evidence resolverVersion",
      );
      assertNonEmptyString(fact.scopeFingerprint, "memory raw evidence scopeFingerprint");
      assertOneOf(fact.status, ["completed", "noop", "failed"], "memory raw evidence status");
      assertNonEmptyString(fact.resolutionRevision, "memory raw evidence resolutionRevision");
      if (!Array.isArray(fact.spans) || fact.spans.length > 16) {
        throw new Error("memory raw evidence spans must be a bounded array");
      }
      const refs = new Set<string>();
      let totalChars = 0;
      for (const span of fact.spans) {
        assertMemoryRawEvidenceSpan(span);
        if (refs.has(span.evidenceRef)) {
          throw new Error("memory raw evidence refs must be unique");
        }
        refs.add(span.evidenceRef);
        totalChars += span.content.length;
      }
      if (totalChars > 16_384) {
        throw new Error("memory raw evidence content is too large");
      }
      assertOptionalStringField(fact, "reasonCode");
      if (fact.status === "completed" && fact.spans.length === 0) {
        throw new Error("completed memory raw evidence requires spans");
      }
      if (fact.status !== "completed" && fact.spans.length > 0) {
        throw new Error("non-completed memory raw evidence cannot contain spans");
      }
      assertNonNegativeInteger(fact.settledAt, "memory raw evidence settledAt");
      return;
    }
    case "memory.evidence_coverage_settled": {
      assertExactKeys(
        fact,
        [
          "type",
          "queryId",
          "plannerVersion",
          "scopeFingerprint",
          "status",
          "planRevision",
          "requirements",
          "coverage",
          "supplementalStates",
          "spans",
          "settledAt",
        ],
        ["reasonCode"],
        fact.type,
      );
      assertId(fact.queryId, "memory evidence coverage queryId");
      assertExact(
        fact.plannerVersion,
        MEMORY_EVIDENCE_COVERAGE_POLICY_VERSION_V1,
        "memory evidence coverage plannerVersion",
      );
      assertNonEmptyString(fact.scopeFingerprint, "memory evidence coverage scopeFingerprint");
      assertOneOf(fact.status, ["completed", "noop", "failed"], "memory evidence coverage status");
      assertNonEmptyString(fact.planRevision, "memory evidence coverage planRevision");
      if (!Array.isArray(fact.requirements) || fact.requirements.length > 6) {
        throw new Error("memory evidence requirements must be a bounded array");
      }
      const requirementIds = new Set<string>();
      let requirementChars = 0;
      for (const requirement of fact.requirements) {
        assertMemoryEvidenceRequirement(requirement);
        if (requirementIds.has(requirement.requirementId)) {
          throw new Error("memory evidence requirement ids must be unique");
        }
        requirementIds.add(requirement.requirementId);
        requirementChars += requirement.description.length;
      }
      if (requirementChars > 4_096) {
        throw new Error("memory evidence requirements are too large");
      }
      if (!Array.isArray(fact.coverage) || fact.coverage.length !== fact.requirements.length) {
        throw new Error("memory evidence coverage must match requirements");
      }
      const coverageRequirementIds = new Set<string>();
      const coveredMemoryIds = new Set<string>();
      const expandedTopicIds = new Set<string>();
      for (const item of fact.coverage) {
        assertMemoryEvidenceCoverageItem(item);
        if (
          !requirementIds.has(item.requirementId) ||
          coverageRequirementIds.has(item.requirementId)
        ) {
          throw new Error("memory evidence coverage requirement is invalid");
        }
        coverageRequirementIds.add(item.requirementId);
        for (const id of item.memoryIds) coveredMemoryIds.add(id);
        for (const id of item.topicIds) expandedTopicIds.add(id);
      }
      if (!Array.isArray(fact.supplementalStates) || fact.supplementalStates.length > 16) {
        throw new Error("memory supplemental states must be a bounded array");
      }
      const supplementalIds = new Set<string>();
      let supplementalChars = 0;
      for (const state of fact.supplementalStates) {
        assertMemoryTopicEvidenceState(state);
        if (
          supplementalIds.has(state.memoryId) ||
          !expandedTopicIds.has(state.topicId) ||
          !coveredMemoryIds.has(state.memoryId)
        ) {
          throw new Error("memory supplemental state is outside coverage");
        }
        supplementalIds.add(state.memoryId);
        supplementalChars += state.statement.length;
      }
      if (supplementalChars > 8_192) {
        throw new Error("memory supplemental states are too large");
      }
      if (!Array.isArray(fact.spans) || fact.spans.length > 16) {
        throw new Error("memory coverage spans must be a bounded array");
      }
      const spanRefs = new Set<string>();
      let spanChars = 0;
      for (const span of fact.spans) {
        assertMemoryRawEvidenceSpan(span);
        if (
          spanRefs.has(span.evidenceRef) ||
          span.memoryIds.some((id: unknown) => typeof id !== "string" || !coveredMemoryIds.has(id))
        ) {
          throw new Error("memory coverage span is outside covered evidence");
        }
        spanRefs.add(span.evidenceRef);
        spanChars += span.content.length;
      }
      if (spanChars > 16_384) {
        throw new Error("memory coverage span content is too large");
      }
      assertOptionalStringField(fact, "reasonCode");
      if (fact.status === "completed" && fact.requirements.length === 0) {
        throw new Error("completed memory evidence coverage requires a plan");
      }
      if (
        fact.status !== "completed" &&
        (fact.requirements.length > 0 ||
          fact.coverage.length > 0 ||
          fact.supplementalStates.length > 0 ||
          fact.spans.length > 0)
      ) {
        throw new Error("non-completed memory evidence coverage cannot contain a plan");
      }
      assertNonNegativeInteger(fact.settledAt, "memory evidence coverage settledAt");
      return;
    }
    case "model.dispatch_recorded":
      assertExactKeys(fact, ["type", "modelCallId", "turn", "requestHash"], [], fact.type);
      assertId(fact.modelCallId, "modelCallId");
      assertPositiveInteger(fact.turn, "turn");
      assertNonEmptyString(fact.requestHash, "requestHash");
      return;
    case "model.settled":
      assertExactKeys(
        fact,
        ["type", "modelCallId", "turn", "status", "hasToolCalls", "hasVisibleOutput"],
        ["response", "finishReason", "errorCode"],
        fact.type,
      );
      assertId(fact.modelCallId, "modelCallId");
      assertPositiveInteger(fact.turn, "turn");
      assertOneOf(
        fact.status,
        ["completed", "truncated", "failed", "cancelled", "unknown", "rejected"],
        "model status",
      );
      assertBoolean(fact.hasToolCalls, "hasToolCalls");
      assertBoolean(fact.hasVisibleOutput, "hasVisibleOutput");
      if (hasOwn(fact, "response")) {
        assertDurableJsonPayload(fact.response, "response");
        const response = fact.response as DurableJsonPayloadV1;
        if (response.kind === "inline") {
          assertModelResponse(response.value);
        }
      }
      assertOptionalStringField(fact, "finishReason");
      assertOptionalStringField(fact, "errorCode");
      if (
        (fact.status === "completed" || fact.status === "truncated") &&
        fact.response === undefined
      ) {
        throw new Error(`${fact.status} model settlement requires a durable response`);
      }
      if (
        (fact.status === "failed" || fact.status === "rejected") &&
        fact.errorCode === undefined
      ) {
        throw new Error(`${fact.status} model settlement requires errorCode`);
      }
      return;
    case "tool.call_observed":
      assertExactKeys(
        fact,
        ["type", "callId", "modelCallId", "turn", "tool", "args", "order"],
        [],
        fact.type,
      );
      assertId(fact.callId, "callId");
      assertId(fact.modelCallId, "modelCallId");
      assertPositiveInteger(fact.turn, "turn");
      assertNonEmptyString(fact.tool, "tool");
      assertJsonValue(fact.args, "args");
      assertNonNegativeInteger(fact.order, "order");
      return;
    case "tool.dispatch_recorded":
      assertExactKeys(
        fact,
        ["type", "callId", "turn", "sourceIndex", "batchId", "mode"],
        [],
        fact.type,
      );
      assertId(fact.callId, "callId");
      assertPositiveInteger(fact.turn, "turn");
      assertNonNegativeInteger(fact.sourceIndex, "sourceIndex");
      assertId(fact.batchId, "batchId");
      assertOneOf(fact.mode, ["serial", "parallel"], "dispatch mode");
      return;
    case "tool.permission_resolved":
      assertExactKeys(
        fact,
        ["type", "turn", "sourceIndex", "callId", "tool", "policyVersion", "resolution", "source"],
        ["ruleId"],
        fact.type,
      );
      assertPositiveInteger(fact.turn, "turn");
      assertNonNegativeInteger(fact.sourceIndex, "sourceIndex");
      assertId(fact.callId, "callId");
      assertNonEmptyString(fact.tool, "tool");
      assertNonEmptyString(fact.policyVersion, "policyVersion");
      assertOneOf(fact.resolution, ["allow_once", "allow_rule", "deny"], "permission resolution");
      assertOneOf(fact.source, ["base_policy", "user_prompt", "run_rule"], "permission source");
      if (hasOwn(fact, "ruleId")) assertId(fact.ruleId, "ruleId");
      if (fact.resolution === "allow_rule" && !hasOwn(fact, "ruleId")) {
        throw new Error("allow_rule permission requires ruleId");
      }
      if (fact.source === "run_rule" && fact.resolution !== "allow_rule") {
        throw new Error("run_rule source requires allow_rule resolution");
      }
      if (fact.source === "base_policy" && fact.resolution === "allow_rule") {
        throw new Error("base_policy cannot create allow_rule permission");
      }
      return;
    case "tool.effect_checkpoint_allocated":
      assertExactKeys(
        fact,
        ["type", "callId", "turn", "sourceIndex", "checkpointSeq"],
        [],
        fact.type,
      );
      assertId(fact.callId, "callId");
      assertPositiveInteger(fact.turn, "turn");
      assertNonNegativeInteger(fact.sourceIndex, "sourceIndex");
      assertPositiveInteger(fact.checkpointSeq, "checkpointSeq");
      return;
    case "tool.settled":
      assertExactKeys(
        fact,
        ["type", "callId", "status"],
        ["result", "resultHash", "errorCode", "observation"],
        fact.type,
      );
      assertId(fact.callId, "callId");
      assertOneOf(
        fact.status,
        ["completed", "failed", "cancelled", "unknown", "rejected"],
        "tool status",
      );
      if (hasOwn(fact, "result")) assertJsonValue(fact.result, "result");
      assertOptionalStringField(fact, "resultHash");
      assertOptionalStringField(fact, "errorCode");
      if (hasOwn(fact, "observation")) {
        assertToolObservation(fact.observation, "observation");
        const observation = fact.observation as ToolObservationV1;
        if (fact.status !== "completed" && !observation.isError) {
          throw new Error(`${fact.status} tool settlement observation must be an error`);
        }
      }
      if (
        (fact.status === "failed" || fact.status === "rejected") &&
        fact.errorCode === undefined
      ) {
        throw new Error(`${fact.status} tool settlement requires errorCode`);
      }
      return;
    case "runtime.activity_started":
      assertExactKeys(
        fact,
        ["type", "activityId", "activityKind", "label", "startedAt"],
        ["metadata"],
        fact.type,
      );
      assertId(fact.activityId, "activityId");
      assertId(fact.activityKind, "activityKind");
      assertSingleLineString(fact.label, "label");
      assertNonNegativeInteger(fact.startedAt, "startedAt");
      if (hasOwn(fact, "metadata")) {
        assertJsonValue(fact.metadata, "metadata");
      }
      return;
    case "runtime.activity_settled":
      assertExactKeys(
        fact,
        ["type", "activityId", "status", "settledAt", "summary"],
        ["result"],
        fact.type,
      );
      assertId(fact.activityId, "activityId");
      assertOneOf(
        fact.status,
        ["completed", "failed", "cancelled", "unknown"],
        "runtime activity status",
      );
      assertNonNegativeInteger(fact.settledAt, "settledAt");
      assertSingleLineString(fact.summary, "summary");
      if (fact.result !== undefined) {
        assertJsonValue(fact.result, "activity result");
        if (JSON.stringify(fact.result).length > 32000)
          throw new Error("Activity result too large");
      }
      return;
    case "abort.requested":
      assertExactKeys(fact, ["type", "source"], ["reason"], fact.type);
      assertOneOf(fact.source, ["user", "host", "signal"], "abort source");
      assertOptionalStringField(fact, "reason");
      return;
    case "runtime.failed":
      assertExactKeys(fact, ["type", "area", "errorCode", "message", "retryable"], [], fact.type);
      assertOneOf(fact.area, ["input", "context", "runtime"], "failure area");
      assertId(fact.errorCode, "errorCode");
      assertNonEmptyString(fact.message, "message");
      assertBoolean(fact.retryable, "retryable");
      return;
    case "policy.request_recorded":
      assertExactKeys(
        fact,
        ["type", "policyId", "policyVersion", "request", "reasonCode"],
        [],
        fact.type,
      );
      assertId(fact.policyId, "policyId");
      assertNonEmptyString(fact.policyVersion, "policyVersion");
      assertOneOf(fact.request, ["continue", "wait", "complete", "incomplete"], "policy request");
      assertId(fact.reasonCode, "reasonCode");
      return;
    case "completion.review_claimed":
      assertExactKeys(
        fact,
        [
          "type",
          "reviewId",
          "candidateHash",
          "policyVersion",
          "reviewerId",
          "triggers",
          "sourceThroughSeq",
          "claimedAt",
        ],
        [],
        fact.type,
      );
      assertId(fact.reviewId, "reviewId");
      if (typeof fact.candidateHash !== "string" || !/^[0-9a-f]{64}$/u.test(fact.candidateHash)) {
        throw new Error("completion review candidateHash must be sha256 hex");
      }
      assertExact(fact.policyVersion, COMPLETION_REVIEW_POLICY_VERSION_V1, "policyVersion");
      assertId(fact.reviewerId, "reviewerId");
      if (!Array.isArray(fact.triggers) || fact.triggers.length === 0) {
        throw new Error("completion review triggers must be non-empty");
      }
      for (const trigger of fact.triggers) {
        assertOneOf(
          trigger,
          [
            "user_requested",
            "project_required",
            "non_trivial_change",
            "delivery_without_observation",
            "missing_fresh_verification",
            "fresh_verification_failed",
            "fresh_verification_inconclusive",
            "model_requested",
          ],
          "completion review trigger",
        );
      }
      if (new Set(fact.triggers).size !== fact.triggers.length) {
        throw new Error("completion review triggers must be unique");
      }
      assertPositiveInteger(fact.sourceThroughSeq, "sourceThroughSeq");
      assertNonNegativeInteger(fact.claimedAt, "claimedAt");
      return;
    case "completion.review_settled":
      assertExactKeys(
        fact,
        ["type", "reviewId", "status", "verdict", "reasonCode", "summary", "settledAt"],
        ["environmentAudit"],
        fact.type,
      );
      assertId(fact.reviewId, "reviewId");
      assertOneOf(
        fact.status,
        ["completed", "failed", "cancelled", "unknown"],
        "completion review status",
      );
      assertOneOf(
        fact.verdict,
        ["allow", "block", "await_user", "unknown"],
        "completion review verdict",
      );
      assertId(fact.reasonCode, "reasonCode");
      assertSingleLineString(fact.summary, "summary");
      assertNonNegativeInteger(fact.settledAt, "settledAt");
      if (fact.status === "completed" && fact.verdict === "unknown") {
        throw new Error("completed completion review requires a verdict");
      }
      if (fact.status !== "completed" && fact.verdict !== "unknown") {
        throw new Error("non-completed completion review must be unknown");
      }
      if (fact.environmentAudit !== undefined) {
        assertEnvironmentAuditEvidenceV1(fact.environmentAudit);
        if (
          fact.verdict === "allow" &&
          (fact.environmentAudit.integrity !== "clean" ||
            fact.environmentAudit.inspected.length === 0 ||
            fact.environmentAudit.unmetCriteria.length > 0)
        )
          throw new Error("Environment audit cannot allow unverified evidence");
      }
      return;
    case "context.checkpoint_distillation_claimed": {
      assertExactKeys(
        fact,
        [
          "type",
          "claimId",
          "checkpointId",
          "boundary",
          "policyVersion",
          "sourceFromSeq",
          "sourceThroughSeq",
          "sourceInputHash",
        ],
        ["supersedesCheckpointId"],
        fact.type,
      );
      assertId(fact.claimId, "claimId");
      assertId(fact.checkpointId, "checkpointId");
      assertOneOf(
        fact.boundary,
        ["after_model_turn_without_tool_calls", "after_tool_batch_settled"],
        "checkpoint distillation boundary",
      );
      if (hasOwn(fact, "supersedesCheckpointId")) {
        assertId(fact.supersedesCheckpointId, "supersedesCheckpointId");
      }
      assertId(fact.policyVersion, "policyVersion");
      assertPositiveInteger(fact.sourceFromSeq, "sourceFromSeq");
      assertPositiveInteger(fact.sourceThroughSeq, "sourceThroughSeq");
      if ((fact.sourceFromSeq as number) > (fact.sourceThroughSeq as number)) {
        throw new Error("context checkpoint distillation source range is invalid");
      }
      assertSingleLineString(fact.sourceInputHash, "sourceInputHash");
      return;
    }
    case "context.checkpoint_distillation_settled": {
      assertExactKeys(fact, ["type", "claimId", "status"], ["checkpoint", "errorCode"], fact.type);
      assertId(fact.claimId, "claimId");
      assertOneOf(
        fact.status,
        ["completed", "failed", "cancelled", "unknown", "truncated"],
        "checkpoint distillation status",
      );
      if (hasOwn(fact, "checkpoint")) {
        assertDurableJsonPayload(fact.checkpoint, "checkpoint");
        const checkpoint = fact.checkpoint as DurableJsonPayloadV1;
        if (checkpoint.kind === "inline") {
          assertTaskCheckpoint(checkpoint.value, "checkpoint.value");
        }
      }
      assertOptionalStringField(fact, "errorCode");
      if (fact.status === "completed" && !hasOwn(fact, "checkpoint")) {
        throw new Error("completed checkpoint distillation requires checkpoint");
      }
      if (fact.status !== "completed" && hasOwn(fact, "checkpoint")) {
        throw new Error("non-completed checkpoint distillation cannot persist checkpoint");
      }
      if (fact.status !== "completed" && !hasOwn(fact, "errorCode")) {
        throw new Error("non-completed checkpoint distillation requires errorCode");
      }
      if (fact.status === "completed" && hasOwn(fact, "errorCode")) {
        throw new Error("completed checkpoint distillation cannot carry errorCode");
      }
      return;
    }
    case "context.checkpoint_recorded": {
      assertExactKeys(
        fact,
        [
          "type",
          "checkpointId",
          "policyVersion",
          "sourceFromSeq",
          "sourceThroughSeq",
          "sourceInputHash",
          "checkpoint",
        ],
        ["distillationClaimId", "supersedesCheckpointId"],
        fact.type,
      );
      assertId(fact.checkpointId, "checkpointId");
      if (hasOwn(fact, "distillationClaimId")) {
        assertId(fact.distillationClaimId, "distillationClaimId");
      }
      if (hasOwn(fact, "supersedesCheckpointId")) {
        assertId(fact.supersedesCheckpointId, "supersedesCheckpointId");
      }
      assertId(fact.policyVersion, "policyVersion");
      assertPositiveInteger(fact.sourceFromSeq, "sourceFromSeq");
      assertPositiveInteger(fact.sourceThroughSeq, "sourceThroughSeq");
      if ((fact.sourceFromSeq as number) > (fact.sourceThroughSeq as number)) {
        throw new Error("context checkpoint source range is invalid");
      }
      assertSingleLineString(fact.sourceInputHash, "sourceInputHash");
      assertDurableJsonPayload(fact.checkpoint, "checkpoint");
      const payload = fact.checkpoint as DurableJsonPayloadV1;
      if (payload.kind === "inline") {
        assertTaskCheckpoint(payload.value, "checkpoint.value");
        assertCheckpointSourcesInRange(
          payload.value as unknown as TaskCheckpointV1,
          fact.sourceFromSeq as number,
          fact.sourceThroughSeq as number,
        );
      }
      return;
    }
    default:
      throw new Error("Unsupported input fact type");
  }
}
