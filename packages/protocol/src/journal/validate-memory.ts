/** Validators for memory pipeline wire values. */
import {
  assertExact,
  assertExactKeys,
  assertId,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertOneOf,
  assertOptionalStringField,
  assertPositiveInteger,
  assertSingleLineString,
  expectObject,
  hasOwn,
} from "./validate-primitives.js";
import { assertUniqueBoundedIds, assertUnitInterval } from "./validate-wire.js";
import {
  MEMORY_ATOM_PROPOSAL_SCHEMA_VERSION_V1,
  MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1,
} from "./versions.js";
import type { MemoryEvidenceCoverageItemV1, MemoryEvidenceRequirementV1 } from "./wire-memory.js";

export function assertMemoryCard(value: unknown): void {
  const card = expectObject(value, "memory card");
  assertExactKeys(
    card,
    [
      "id",
      "revision",
      "kind",
      "statement",
      "applicability",
      "scope",
      "sources",
      "confidence",
      "contentHash",
    ],
    [],
    "memory card",
  );
  assertId(card.id, "memory card id");
  assertPositiveInteger(card.revision, "memory card revision");
  assertOneOf(
    card.kind,
    ["semantic", "episodic", "procedural", "profile", "trial"],
    "memory card kind",
  );
  assertNonEmptyString(card.statement, "memory card statement");
  if ((card.statement as string).length > 16_384) {
    throw new Error("memory card statement is too large");
  }
  assertOneOf(
    card.applicability,
    ["applicable", "reference", "trial"],
    "memory card applicability",
  );
  const scope = expectObject(card.scope, "memory card scope");
  assertExactKeys(scope, ["repositoryId"], ["branch"], "memory card scope");
  assertNonEmptyString(scope.repositoryId, "memory card repositoryId");
  assertOptionalStringField(scope, "branch");
  if (!Array.isArray(card.sources) || card.sources.length === 0 || card.sources.length > 32) {
    throw new Error("memory card sources must be a non-empty bounded array");
  }
  for (const value of card.sources) {
    const source = expectObject(value, "memory card source");
    assertExactKeys(source, ["kind", "ref"], [], "memory card source");
    assertExact(source.kind, "memory_store_evidence", "memory source kind");
    assertNonEmptyString(source.ref, "memory source ref");
  }
  if (
    typeof card.confidence !== "number" ||
    !Number.isFinite(card.confidence) ||
    card.confidence < 0 ||
    card.confidence > 1
  ) {
    throw new Error("memory card confidence must be between 0 and 1");
  }
  assertNonEmptyString(card.contentHash, "memory card contentHash");
}

export function assertMemoryAtomProposal(value: unknown): void {
  const atom = expectObject(value, "memory atom proposal");
  assertExactKeys(
    atom,
    [
      "schemaVersion",
      "atomId",
      "kind",
      "action",
      "statement",
      "keywords",
      "authority",
      "confidence",
      "priority",
      "sourceSeqs",
      "targetIds",
      "contentHash",
    ],
    ["validFrom", "validTo"],
    "memory atom proposal",
  );
  assertExact(
    atom.schemaVersion,
    MEMORY_ATOM_PROPOSAL_SCHEMA_VERSION_V1,
    "memory atom schemaVersion",
  );
  assertId(atom.atomId, "memory atomId");
  assertOneOf(atom.kind, ["semantic", "episodic", "profile", "instruction"], "memory atom kind");
  assertOneOf(atom.action, ["store", "update", "merge", "skip"], "memory atom action");
  assertNonEmptyString(atom.statement, "memory atom statement");
  if ((atom.statement as string).length > 4_096) {
    throw new Error("memory atom statement is too large");
  }
  if (!Array.isArray(atom.keywords) || atom.keywords.length > 12) {
    throw new Error("memory atom keywords must be a bounded array");
  }
  for (const keyword of atom.keywords) {
    assertSingleLineString(keyword, "memory atom keyword");
  }
  assertOneOf(
    atom.authority,
    ["user_asserted", "agent_verified", "agent_inferred"],
    "memory atom authority",
  );
  if (
    typeof atom.confidence !== "number" ||
    !Number.isFinite(atom.confidence) ||
    atom.confidence < 0 ||
    atom.confidence > 1
  ) {
    throw new Error("memory atom confidence must be between 0 and 1");
  }
  if (
    !Number.isSafeInteger(atom.priority) ||
    (atom.priority as number) < 0 ||
    (atom.priority as number) > 100
  ) {
    throw new Error("memory atom priority must be between 0 and 100");
  }
  if (
    !Array.isArray(atom.sourceSeqs) ||
    atom.sourceSeqs.length === 0 ||
    atom.sourceSeqs.length > 32
  ) {
    throw new Error("memory atom sourceSeqs must be a non-empty bounded array");
  }
  let previousSeq = 0;
  for (const seq of atom.sourceSeqs) {
    assertPositiveInteger(seq, "memory atom sourceSeq");
    if ((seq as number) <= previousSeq) {
      throw new Error("memory atom sourceSeqs must be strictly increasing");
    }
    previousSeq = seq as number;
  }
  if (!Array.isArray(atom.targetIds) || atom.targetIds.length > 16) {
    throw new Error("memory atom targetIds must be a bounded array");
  }
  const targets = new Set<string>();
  for (const id of atom.targetIds) {
    assertId(id, "memory atom targetId");
    if (targets.has(id as string)) {
      throw new Error("memory atom targetIds must be unique");
    }
    targets.add(id as string);
  }
  if (atom.action === "store" && atom.targetIds.length > 0) {
    throw new Error("store memory atom cannot target existing ids");
  }
  if ((atom.action === "update" || atom.action === "merge") && atom.targetIds.length === 0) {
    throw new Error(`${atom.action as string} memory atom requires targets`);
  }
  assertOptionalStringField(atom, "validFrom");
  assertOptionalStringField(atom, "validTo");
  assertNonEmptyString(atom.contentHash, "memory atom contentHash");
}

export function assertMemoryTopicProposal(value: unknown): void {
  const topic = expectObject(value, "memory topic proposal");
  assertExactKeys(
    topic,
    [
      "schemaVersion",
      "proposalId",
      "scopeFingerprint",
      "family",
      "canonicalName",
      "normalizedName",
      "members",
      "confidence",
    ],
    ["targetTopicId"],
    "memory topic proposal",
  );
  assertExact(
    topic.schemaVersion,
    MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1,
    "memory topic schemaVersion",
  );
  assertId(topic.proposalId, "memory topic proposalId");
  assertNonEmptyString(topic.scopeFingerprint, "memory topic scopeFingerprint");
  assertOneOf(
    topic.family,
    ["semantic", "episodic", "profile", "instruction", "mixed"],
    "memory topic family",
  );
  assertSingleLineString(topic.canonicalName, "memory topic canonicalName");
  assertSingleLineString(topic.normalizedName, "memory topic normalizedName");
  if ((topic.canonicalName as string).length > 96 || (topic.normalizedName as string).length > 96) {
    throw new Error("memory topic name is too large");
  }
  if (hasOwn(topic, "targetTopicId")) {
    assertId(topic.targetTopicId, "memory topic targetTopicId");
  }
  if (!Array.isArray(topic.members) || topic.members.length === 0 || topic.members.length > 256) {
    throw new Error("memory topic members must be a non-empty bounded array");
  }
  const memberIds = new Set<string>();
  for (const value of topic.members) {
    const member = expectObject(value, "memory topic member");
    assertExactKeys(member, ["memoryId", "role", "confidence", "basis"], [], "memory topic member");
    assertId(member.memoryId, "memory topic member memoryId");
    assertOneOf(member.role, ["primary", "supporting"], "memory topic member role");
    assertUnitInterval(member.confidence, "memory topic member confidence");
    assertOneOf(
      member.basis,
      ["model_proposed", "explicit_relation", "user_asserted"],
      "memory topic member basis",
    );
    if (memberIds.has(member.memoryId as string)) {
      throw new Error("memory topic members must have unique memory ids");
    }
    memberIds.add(member.memoryId as string);
  }
  assertUnitInterval(topic.confidence, "memory topic confidence");
}

export function assertMemoryTopicIndexEntry(value: unknown): void {
  const entry = expectObject(value, "memory topic index entry");
  assertExactKeys(
    entry,
    [
      "topicId",
      "snapshotId",
      "family",
      "canonicalName",
      "normalizedName",
      "memberCount",
      "trajectoryCount",
      "projectionHash",
    ],
    [],
    "memory topic index entry",
  );
  assertId(entry.topicId, "memory topic index topicId");
  assertId(entry.snapshotId, "memory topic index snapshotId");
  assertOneOf(
    entry.family,
    ["semantic", "episodic", "profile", "instruction", "mixed"],
    "memory topic index family",
  );
  assertSingleLineString(entry.canonicalName, "memory topic index canonicalName");
  assertSingleLineString(entry.normalizedName, "memory topic index normalizedName");
  if ((entry.canonicalName as string).length > 96 || (entry.normalizedName as string).length > 96) {
    throw new Error("memory topic index name is too large");
  }
  assertNonNegativeInteger(entry.memberCount, "memory topic index memberCount");
  assertNonNegativeInteger(entry.trajectoryCount, "memory topic index trajectoryCount");
  assertNonEmptyString(entry.projectionHash, "memory topic index projectionHash");
}

export function assertMemoryTopicEvidenceState(value: unknown): void {
  const state = expectObject(value, "memory topic evidence state");
  assertExactKeys(
    state,
    [
      "topicId",
      "snapshotId",
      "trajectoryId",
      "memoryId",
      "state",
      "statement",
      "validFrom",
      "evidenceRefs",
    ],
    ["validTo"],
    "memory topic evidence state",
  );
  assertId(state.topicId, "memory topic evidence topicId");
  assertId(state.snapshotId, "memory topic evidence snapshotId");
  assertId(state.trajectoryId, "memory topic evidence trajectoryId");
  assertId(state.memoryId, "memory topic evidence memoryId");
  assertOneOf(state.state, ["current", "historical"], "memory topic evidence state kind");
  assertNonEmptyString(state.statement, "memory topic evidence statement");
  if ((state.statement as string).length > 4_096) {
    throw new Error("memory topic evidence statement is too large");
  }
  assertNonEmptyString(state.validFrom, "memory topic evidence validFrom");
  assertOptionalStringField(state, "validTo");
  if (!Array.isArray(state.evidenceRefs) || state.evidenceRefs.length > 32) {
    throw new Error("memory topic evidence refs must be a bounded array");
  }
  const refs = new Set<string>();
  for (const ref of state.evidenceRefs) {
    assertNonEmptyString(ref, "memory topic evidence ref");
    if (refs.has(ref as string)) {
      throw new Error("memory topic evidence refs must be unique");
    }
    refs.add(ref as string);
  }
}

export function assertMemoryPersonaClaim(value: unknown): void {
  const claim = expectObject(value, "memory persona claim");
  assertExactKeys(
    claim,
    ["memoryId", "kind", "statement", "confidence", "validFrom", "evidenceRefs"],
    [],
    "memory persona claim",
  );
  assertId(claim.memoryId, "memory persona claim memoryId");
  assertOneOf(claim.kind, ["profile"], "memory persona claim kind");
  assertNonEmptyString(claim.statement, "memory persona claim statement");
  if ((claim.statement as string).length > 4_096) {
    throw new Error("memory persona claim statement is too large");
  }
  assertUnitInterval(claim.confidence, "memory persona claim confidence");
  assertNonEmptyString(claim.validFrom, "memory persona claim validFrom");
  if (!Array.isArray(claim.evidenceRefs) || claim.evidenceRefs.length > 32) {
    throw new Error("memory persona claim refs must be a bounded array");
  }
  const refs = new Set<string>();
  for (const ref of claim.evidenceRefs) {
    assertNonEmptyString(ref, "memory persona claim ref");
    if ((ref as string).length > 1_024) {
      throw new Error("memory persona claim ref is too large");
    }
    if (refs.has(ref as string)) {
      throw new Error("memory persona claim refs must be unique");
    }
    refs.add(ref as string);
  }
}

export function assertMemoryRawEvidenceSpan(value: unknown): void {
  const span = expectObject(value, "memory raw evidence span");
  assertExactKeys(
    span,
    ["evidenceRef", "memoryIds", "content", "contentHash"],
    [],
    "memory raw evidence span",
  );
  assertNonEmptyString(span.evidenceRef, "memory raw evidence ref");
  if ((span.evidenceRef as string).length > 1_024) {
    throw new Error("memory raw evidence ref is too large");
  }
  assertUniqueBoundedIds(span.memoryIds, 32, "memory raw evidence memoryIds", true);
  assertNonEmptyString(span.content, "memory raw evidence content");
  if ((span.content as string).length > 8_192) {
    throw new Error("memory raw evidence span content is too large");
  }
  assertNonEmptyString(span.contentHash, "memory raw evidence contentHash");
}

export function assertMemoryEvidenceRequirement(
  value: unknown,
): asserts value is MemoryEvidenceRequirementV1 {
  const requirement = expectObject(value, "memory evidence requirement");
  assertExactKeys(
    requirement,
    ["requirementId", "description", "priority", "minimumEvidence"],
    [],
    "memory evidence requirement",
  );
  assertId(requirement.requirementId, "memory evidence requirementId");
  assertSingleLineString(requirement.description, "memory evidence requirement description");
  if ((requirement.description as string).length > 1_024) {
    throw new Error("memory evidence requirement description is too large");
  }
  assertOneOf(
    requirement.priority,
    ["required", "supporting"],
    "memory evidence requirement priority",
  );
  assertPositiveInteger(requirement.minimumEvidence, "memory evidence minimumEvidence");
  if ((requirement.minimumEvidence as number) > 3) {
    throw new Error("memory evidence minimumEvidence is too large");
  }
}

export function assertMemoryEvidenceCoverageItem(
  value: unknown,
): asserts value is MemoryEvidenceCoverageItemV1 {
  const item = expectObject(value, "memory evidence coverage item");
  assertExactKeys(
    item,
    ["requirementId", "status", "memoryIds", "topicIds"],
    [],
    "memory evidence coverage item",
  );
  assertId(item.requirementId, "memory evidence coverage requirementId");
  assertOneOf(
    item.status,
    ["covered", "partial", "missing"],
    "memory evidence coverage item status",
  );
  assertUniqueBoundedIds(item.memoryIds, 16, "memory evidence coverage memoryIds", false);
  assertUniqueBoundedIds(item.topicIds, 8, "memory evidence coverage topicIds", false);
  if (item.status === "missing" && item.memoryIds.length > 0) {
    throw new Error("missing memory evidence coverage cannot contain memoryIds");
  }
  if (item.status === "covered" && item.memoryIds.length === 0) {
    throw new Error("covered memory evidence coverage requires memoryIds");
  }
}
