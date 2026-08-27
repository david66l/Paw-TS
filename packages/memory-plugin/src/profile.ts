import { createHash } from "node:crypto";

export const PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1 =
  "paw.next-memory-plugin.v1" as const;
export const PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1 =
  "paw.memory-v2-readonly-provider.v1" as const;
export const PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1 =
  "paw.memory-v2-readonly-provider.rrf.v1" as const;
export const PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1 =
  "paw.memory-v2-readonly-provider.rrf-rerank.v1" as const;

export type PawNextMemoryProviderVersionV1 =
  | typeof PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1
  | typeof PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1
  | typeof PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1;

export interface PawNextMemoryRerankerIdentityV1 {
  readonly provider: string;
  readonly model: string;
  readonly revision: string;
}

export interface PawNextMemoryEmbeddingIdentityV1 {
  readonly model: string;
  readonly version: string;
  readonly dimensions: 1536;
}

export interface PawNextMemoryScopeV1 {
  readonly tenantId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
}

export interface PawNextMemoryPluginProfileV1 {
  readonly policyVersion: typeof PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1;
  readonly mode: "off" | "read_only" | "read_write";
  readonly providerVersion: PawNextMemoryProviderVersionV1;
  readonly scope: PawNextMemoryScopeV1;
  readonly maxCards: number;
  /** Hard cap for the complete rendered memory evidence section. */
  readonly maxInjectedTokens: number;
  readonly reranker?: PawNextMemoryRerankerIdentityV1;
  readonly embedding?: PawNextMemoryEmbeddingIdentityV1;
  readonly writer?: PawNextMemoryWriterProfileV1;
}

export interface PawNextMemoryWriterProfileV1 {
  readonly policyVersion: "paw.memory-writer.v1";
  readonly extractorVersion: "paw.memory-atom-extractor.json.v1";
  readonly maxAtoms: number;
  readonly maxSourceChars: number;
  readonly topicOrganizer: PawNextMemoryTopicOrganizerProfileV1;
  readonly personaProjector: PawNextMemoryPersonaProjectorProfileV1;
  readonly evidencePlanner: PawNextMemoryEvidencePlannerProfileV1;
  readonly rawEvidenceResolver: PawNextMemoryRawEvidenceResolverProfileV1;
  readonly coveragePlanner: PawNextMemoryCoveragePlannerProfileV1;
}

export interface PawNextMemoryPersonaProjectorProfileV1 {
  readonly policyVersion: "paw.memory-persona-evidence-projector.v1";
  readonly maxClaims: number;
  readonly maxChars: number;
  readonly minimumConfidence: number;
}

export interface PawNextMemoryRawEvidenceResolverProfileV1 {
  readonly policyVersion: "paw.memory-raw-evidence-resolver.v1";
  readonly maxSpans: number;
  readonly maxChars: number;
}

export interface PawNextMemoryCoveragePlannerProfileV1 {
  readonly policyVersion: "paw.memory-evidence-coverage-planner.v1";
  readonly extractorVersion: "paw.memory-evidence-requirement-planner.json.v1";
  readonly maxRequirements: number;
  readonly maxExpansionTopics: number;
  readonly maxSupplementalStates: number;
  readonly maxSupplementalChars: number;
}

export interface PawNextMemoryTopicOrganizerProfileV1 {
  readonly policyVersion: "paw.memory-topic-organization.v1";
  readonly extractorVersion: "paw.memory-topic-extractor.json.v1";
  readonly maxTopics: number;
}

export interface PawNextMemoryEvidencePlannerProfileV1 {
  readonly policyVersion: "paw.memory-topic-evidence-planner.v1";
  readonly maxIndexTopics: number;
  readonly maxSelectedTopics: number;
  readonly maxStates: number;
  readonly maxEvidenceChars: number;
}

export interface PawNextMemoryPluginIdentityV1 {
  readonly policyVersion: typeof PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1;
  readonly mode: PawNextMemoryPluginProfileV1["mode"];
  readonly providerVersion: PawNextMemoryProviderVersionV1;
  readonly scopeFingerprint: string;
  readonly maxCards: number;
  readonly maxInjectedTokens: number;
  readonly reranker?: PawNextMemoryRerankerIdentityV1;
  readonly embedding?: PawNextMemoryEmbeddingIdentityV1;
  readonly writer?: PawNextMemoryWriterProfileV1;
  readonly triggerPolicy: "task_and_work_segment_start";
  readonly authority: "untrusted_evidence_only";
  readonly writePolicy: "disabled" | "journal_two_phase";
}

export function freezePawNextMemoryPluginProfileV1(
  value: unknown,
): PawNextMemoryPluginProfileV1 {
  const raw = objectRecord(value, "Paw Next memory plugin profile");
  const expectsReranker =
    raw.providerVersion === PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1;
  const hasEmbedding = Object.prototype.hasOwnProperty.call(raw, "embedding");
  const hasWriter = Object.prototype.hasOwnProperty.call(raw, "writer");
  if (
    hasEmbedding &&
    raw.providerVersion === PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1
  ) {
    throw new Error(
      "Legacy memory provider cannot bind a dense embedding identity",
    );
  }
  const record = exactRecord(value, "Paw Next memory plugin profile", [
    "policyVersion",
    "mode",
    "providerVersion",
    "scope",
    "maxCards",
    "maxInjectedTokens",
    ...(expectsReranker ? ["reranker"] : []),
    ...(hasEmbedding ? ["embedding"] : []),
    ...(hasWriter ? ["writer"] : []),
  ]);
  if (record.policyVersion !== PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1) {
    throw new Error("Unsupported Paw Next memory plugin policy version");
  }
  if (
    record.mode !== "off" &&
    record.mode !== "read_only" &&
    record.mode !== "read_write"
  ) {
    throw new Error("Paw Next memory plugin mode is invalid");
  }
  if ((record.mode === "read_write") !== hasWriter) {
    throw new Error(
      "Paw Next read-write memory requires an exclusive writer profile",
    );
  }
  if (
    record.providerVersion !== PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1 &&
    record.providerVersion !== PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1 &&
    record.providerVersion !== PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1
  ) {
    throw new Error("Unsupported Paw Next memory provider version");
  }
  if (
    !Number.isSafeInteger(record.maxCards) ||
    (record.maxCards as number) <= 0 ||
    (record.maxCards as number) > 16 ||
    !Number.isSafeInteger(record.maxInjectedTokens) ||
    (record.maxInjectedTokens as number) < 64 ||
    (record.maxInjectedTokens as number) > 4_096
  ) {
    throw new Error("Paw Next memory plugin budget is invalid");
  }
  const scopeRecord = exactRecord(record.scope, "Paw Next memory scope", [
    "tenantId",
    "userId",
    "workspaceId",
    "repositoryId",
  ]);
  const scope = Object.freeze({
    tenantId: scopePart(scopeRecord.tenantId, "tenantId"),
    userId: scopePart(scopeRecord.userId, "userId"),
    workspaceId: scopePart(scopeRecord.workspaceId, "workspaceId"),
    repositoryId: scopePart(scopeRecord.repositoryId, "repositoryId"),
  });
  const reranker = expectsReranker
    ? freezeRerankerIdentity(record.reranker)
    : undefined;
  const embedding = hasEmbedding
    ? freezeEmbeddingIdentity(record.embedding)
    : undefined;
  const writer = hasWriter ? freezeWriterProfile(record.writer) : undefined;
  return Object.freeze({
    policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
    mode: record.mode,
    providerVersion: record.providerVersion as PawNextMemoryProviderVersionV1,
    scope,
    maxCards: record.maxCards as number,
    maxInjectedTokens: record.maxInjectedTokens as number,
    ...(reranker ? { reranker } : {}),
    ...(embedding ? { embedding } : {}),
    ...(writer ? { writer } : {}),
  });
}

export function memoryScopeFingerprintV1(scope: PawNextMemoryScopeV1): string {
  const frozen = freezeScope(scope);
  return createHash("sha256")
    .update(
      `${frozen.tenantId}\n${frozen.userId}\n${frozen.workspaceId}\n${frozen.repositoryId}`,
    )
    .digest("hex")
    .slice(0, 20);
}

export function createPawNextMemoryPluginIdentityV1(
  profile: PawNextMemoryPluginProfileV1,
): PawNextMemoryPluginIdentityV1 {
  const frozen = freezePawNextMemoryPluginProfileV1(profile);
  return Object.freeze({
    policyVersion: frozen.policyVersion,
    mode: frozen.mode,
    providerVersion: frozen.providerVersion,
    scopeFingerprint: memoryScopeFingerprintV1(frozen.scope),
    maxCards: frozen.maxCards,
    maxInjectedTokens: frozen.maxInjectedTokens,
    ...(frozen.reranker ? { reranker: frozen.reranker } : {}),
    ...(frozen.embedding ? { embedding: frozen.embedding } : {}),
    ...(frozen.writer ? { writer: frozen.writer } : {}),
    triggerPolicy: "task_and_work_segment_start",
    authority: "untrusted_evidence_only",
    writePolicy:
      frozen.mode === "read_write" ? "journal_two_phase" : "disabled",
  });
}

function freezeScope(scope: PawNextMemoryScopeV1): PawNextMemoryScopeV1 {
  return freezePawNextMemoryPluginProfileV1({
    policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
    mode: "off",
    providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
    scope,
    maxCards: 1,
    maxInjectedTokens: 64,
  }).scope;
}

function exactRecord(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort().join("\0");
  const expected = [...keys].sort().join("\0");
  if (actual !== expected) throw new Error(`${label} fields are invalid`);
  return record;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function freezeRerankerIdentity(
  value: unknown,
): PawNextMemoryRerankerIdentityV1 {
  const record = exactRecord(value, "Paw Next memory reranker identity", [
    "provider",
    "model",
    "revision",
  ]);
  return Object.freeze({
    provider: identityPart(record.provider, "provider"),
    model: identityPart(record.model, "model"),
    revision: identityPart(record.revision, "revision"),
  });
}

function freezeEmbeddingIdentity(
  value: unknown,
): PawNextMemoryEmbeddingIdentityV1 {
  const record = exactRecord(value, "Paw Next memory embedding identity", [
    "model",
    "version",
    "dimensions",
  ]);
  if (record.dimensions !== 1536) {
    throw new Error("Paw Next memory embedding dimensions are invalid");
  }
  return Object.freeze({
    model: identityPart(record.model, "embedding model"),
    version: identityPart(record.version, "embedding version"),
    dimensions: 1536 as const,
  });
}

function freezeWriterProfile(value: unknown): PawNextMemoryWriterProfileV1 {
  const record = exactRecord(value, "Paw Next memory writer profile", [
    "policyVersion",
    "extractorVersion",
    "maxAtoms",
    "maxSourceChars",
    "topicOrganizer",
    "personaProjector",
    "evidencePlanner",
    "rawEvidenceResolver",
    "coveragePlanner",
  ]);
  if (record.policyVersion !== "paw.memory-writer.v1") {
    throw new Error("Unsupported Paw Next memory writer policy version");
  }
  if (record.extractorVersion !== "paw.memory-atom-extractor.json.v1") {
    throw new Error("Unsupported Paw Next memory extractor version");
  }
  if (
    !Number.isSafeInteger(record.maxAtoms) ||
    (record.maxAtoms as number) < 1 ||
    (record.maxAtoms as number) > 16 ||
    !Number.isSafeInteger(record.maxSourceChars) ||
    (record.maxSourceChars as number) < 1_024 ||
    (record.maxSourceChars as number) > 128_000
  ) {
    throw new Error("Paw Next memory writer budget is invalid");
  }
  return Object.freeze({
    policyVersion: "paw.memory-writer.v1",
    extractorVersion: "paw.memory-atom-extractor.json.v1",
    maxAtoms: record.maxAtoms as number,
    maxSourceChars: record.maxSourceChars as number,
    topicOrganizer: freezeTopicOrganizerProfile(record.topicOrganizer),
    personaProjector: freezePersonaProjectorProfile(record.personaProjector),
    evidencePlanner: freezeEvidencePlannerProfile(record.evidencePlanner),
    rawEvidenceResolver: freezeRawEvidenceResolverProfile(
      record.rawEvidenceResolver,
    ),
    coveragePlanner: freezeCoveragePlannerProfile(record.coveragePlanner),
  });
}

function freezeCoveragePlannerProfile(
  value: unknown,
): PawNextMemoryCoveragePlannerProfileV1 {
  const record = exactRecord(
    value,
    "Paw Next memory coverage planner profile",
    [
      "policyVersion",
      "extractorVersion",
      "maxRequirements",
      "maxExpansionTopics",
      "maxSupplementalStates",
      "maxSupplementalChars",
    ],
  );
  if (record.policyVersion !== "paw.memory-evidence-coverage-planner.v1") {
    throw new Error(
      "Unsupported Paw Next memory coverage planner policy version",
    );
  }
  if (
    record.extractorVersion !==
    "paw.memory-evidence-requirement-planner.json.v1"
  ) {
    throw new Error(
      "Unsupported Paw Next memory coverage planner extractor version",
    );
  }
  return Object.freeze({
    policyVersion: "paw.memory-evidence-coverage-planner.v1",
    extractorVersion: "paw.memory-evidence-requirement-planner.json.v1",
    maxRequirements: boundedProfileInteger(record.maxRequirements, 1, 6),
    maxExpansionTopics: boundedProfileInteger(record.maxExpansionTopics, 1, 8),
    maxSupplementalStates: boundedProfileInteger(
      record.maxSupplementalStates,
      1,
      16,
    ),
    maxSupplementalChars: boundedProfileInteger(
      record.maxSupplementalChars,
      256,
      8_192,
    ),
  });
}

function freezeRawEvidenceResolverProfile(
  value: unknown,
): PawNextMemoryRawEvidenceResolverProfileV1 {
  const record = exactRecord(
    value,
    "Paw Next memory raw evidence resolver profile",
    ["policyVersion", "maxSpans", "maxChars"],
  );
  if (record.policyVersion !== "paw.memory-raw-evidence-resolver.v1") {
    throw new Error(
      "Unsupported Paw Next memory raw evidence resolver policy version",
    );
  }
  return Object.freeze({
    policyVersion: "paw.memory-raw-evidence-resolver.v1",
    maxSpans: boundedProfileInteger(record.maxSpans, 1, 16),
    maxChars: boundedProfileInteger(record.maxChars, 256, 16_384),
  });
}

function freezePersonaProjectorProfile(
  value: unknown,
): PawNextMemoryPersonaProjectorProfileV1 {
  const record = exactRecord(
    value,
    "Paw Next memory persona projector profile",
    ["policyVersion", "maxClaims", "maxChars", "minimumConfidence"],
  );
  if (record.policyVersion !== "paw.memory-persona-evidence-projector.v1") {
    throw new Error(
      "Unsupported Paw Next memory persona projector policy version",
    );
  }
  const maxClaims = boundedProfileInteger(record.maxClaims, 1, 64);
  const maxChars = boundedProfileInteger(record.maxChars, 512, 16_384);
  if (
    typeof record.minimumConfidence !== "number" ||
    !Number.isFinite(record.minimumConfidence) ||
    record.minimumConfidence < 0 ||
    record.minimumConfidence > 1
  ) {
    throw new Error("Paw Next memory persona projector confidence is invalid");
  }
  return Object.freeze({
    policyVersion: "paw.memory-persona-evidence-projector.v1",
    maxClaims,
    maxChars,
    minimumConfidence: record.minimumConfidence,
  });
}

function freezeEvidencePlannerProfile(
  value: unknown,
): PawNextMemoryEvidencePlannerProfileV1 {
  const record = exactRecord(
    value,
    "Paw Next memory evidence planner profile",
    [
      "policyVersion",
      "maxIndexTopics",
      "maxSelectedTopics",
      "maxStates",
      "maxEvidenceChars",
    ],
  );
  if (record.policyVersion !== "paw.memory-topic-evidence-planner.v1") {
    throw new Error(
      "Unsupported Paw Next memory evidence planner policy version",
    );
  }
  const maxIndexTopics = boundedProfileInteger(record.maxIndexTopics, 1, 128);
  const maxSelectedTopics = boundedProfileInteger(
    record.maxSelectedTopics,
    1,
    8,
  );
  const maxStates = boundedProfileInteger(record.maxStates, 1, 32);
  const maxEvidenceChars = boundedProfileInteger(
    record.maxEvidenceChars,
    1_024,
    32_768,
  );
  return Object.freeze({
    policyVersion: "paw.memory-topic-evidence-planner.v1",
    maxIndexTopics,
    maxSelectedTopics,
    maxStates,
    maxEvidenceChars,
  });
}

function boundedProfileInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error("Paw Next memory evidence planner budget is invalid");
  }
  return value as number;
}

function freezeTopicOrganizerProfile(
  value: unknown,
): PawNextMemoryTopicOrganizerProfileV1 {
  const record = exactRecord(value, "Paw Next memory topic organizer profile", [
    "policyVersion",
    "extractorVersion",
    "maxTopics",
  ]);
  if (record.policyVersion !== "paw.memory-topic-organization.v1") {
    throw new Error(
      "Unsupported Paw Next memory topic organizer policy version",
    );
  }
  if (record.extractorVersion !== "paw.memory-topic-extractor.json.v1") {
    throw new Error("Unsupported Paw Next memory topic extractor version");
  }
  if (
    !Number.isSafeInteger(record.maxTopics) ||
    (record.maxTopics as number) < 1 ||
    (record.maxTopics as number) > 16
  ) {
    throw new Error("Paw Next memory topic organizer budget is invalid");
  }
  return Object.freeze({
    policyVersion: "paw.memory-topic-organization.v1",
    extractorVersion: "paw.memory-topic-extractor.json.v1",
    maxTopics: record.maxTopics as number,
  });
}

function identityPart(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid memory identity ${name}`);
  }
  const normalized = value.trim();
  const invalid = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (!normalized || normalized.length > 256 || invalid) {
    throw new Error(`Invalid memory identity ${name}`);
  }
  return normalized;
}

function scopePart(value: unknown, name: string): string {
  if (typeof value !== "string")
    throw new Error(`Invalid memory scope ${name}`);
  const normalized = value.trim();
  const invalid = [...normalized].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (!normalized || normalized.length > 256 || invalid) {
    throw new Error(`Invalid memory scope ${name}`);
  }
  return normalized;
}
