import type { ModelContextSectionV1, ModelRequestV1 } from "@paw/core";
import type { JournalContextRuntimeV1 } from "@paw/runtime";

import { hashCanonicalJsonV1, hashTextV1 } from "./canonical.js";
import type {
  MemorySceneIndexEntryV1,
  MemorySceneSnapshotV1,
} from "./scene-navigation.js";
import type { SourceGroundedMemoryAtomV1 } from "./scene-projector.js";

export const PAW_MEMORY_PERSONA_PROJECTOR_VERSION_V1 =
  "paw.memory-persona-projector.v1" as const;

export interface SourceGroundedPersonaClaimV1 {
  readonly path: string;
  readonly sourceId: string;
  readonly atomId: string;
  readonly kind: "profile" | "semantic";
  readonly statement: string;
  readonly sourceSeqs: readonly number[];
  readonly confidence: number;
}

export interface MemoryPersonaProjectionV1 {
  readonly schemaVersion: typeof PAW_MEMORY_PERSONA_PROJECTOR_VERSION_V1;
  readonly projectionKey: string;
  readonly scopeFingerprint: string;
  readonly projectionRevision: string;
  readonly claims: readonly SourceGroundedPersonaClaimV1[];
  readonly text: string;
  readonly sourceCount: number;
}

const PREFERENCE_SIGNALS = [
  /\bprefer(?:s|red|ring)?\b/iu,
  /\blike(?:s|d)?\b/iu,
  /\bdislike(?:s|d)?\b/iu,
  /\benjoy(?:s|ed|ing)?\b/iu,
  /\bavoid(?:s|ed|ing)?\b/iu,
  /\bvalue(?:s|d)?\b/iu,
  /\binterest(?:s|ed)?\b/iu,
  /\bpassion(?:s|ate)?\b/iu,
  /\bno longer\b/iu,
  /\bstopped?\b/iu,
  /\bgoal\b/iu,
  /喜欢|偏好|不喜欢|避免|重视|兴趣|热爱|目标|不再/u,
] as const;

/**
 * Builds a compact, query-independent L3 projection from active L1 evidence.
 * Claims remain source-addressable and are selected round-robin across scenes
 * so one long history cannot crowd every other preference out of the profile.
 */
export function projectSourceGroundedPersonaV1(input: {
  readonly snapshot: MemorySceneSnapshotV1;
  readonly maxChars?: number;
  readonly maxClaims?: number;
  readonly minimumConfidence?: number;
}): MemoryPersonaProjectionV1 {
  const maxChars = boundedInteger(
    input.maxChars ?? 4_000,
    512,
    16_000,
    "MemoryPersonaBudgetInvalid",
  );
  const maxClaims = boundedInteger(
    input.maxClaims ?? 24,
    1,
    64,
    "MemoryPersonaClaimBudgetInvalid",
  );
  const minimumConfidence = input.minimumConfidence ?? 0.55;
  if (
    !Number.isFinite(minimumConfidence) ||
    minimumConfidence < 0 ||
    minimumConfidence > 1
  ) {
    throw namedError("MemoryPersonaConfidenceInvalid");
  }
  const entries = new Map(
    input.snapshot.indexEntries.map((entry) => [entry.path, entry] as const),
  );
  const queues = input.snapshot.indexEntries.map((entry) =>
    personaCandidates(
      entry,
      input.snapshot.bodies[entry.path]?.atoms ?? [],
      minimumConfidence,
    ),
  );
  const claims: SourceGroundedPersonaClaimV1[] = [];
  const normalizedStatements = new Set<string>();
  let usedChars = 0;
  for (let depth = 0; claims.length < maxClaims; depth += 1) {
    let found = false;
    for (const queue of queues) {
      const candidate = queue[depth];
      if (!candidate) continue;
      found = true;
      const normalized = normalizeStatement(candidate.statement);
      if (normalizedStatements.has(normalized)) continue;
      const line = renderClaim(candidate);
      const separator = claims.length > 0 ? 1 : 0;
      if (usedChars + separator + line.length > maxChars) continue;
      claims.push(candidate);
      normalizedStatements.add(normalized);
      usedChars += separator + line.length;
      if (claims.length >= maxClaims) break;
    }
    if (!found) break;
  }
  const text = claims.map(renderClaim).join("\n");
  const projectionKey = hashCanonicalJsonV1({
    schemaVersion: PAW_MEMORY_PERSONA_PROJECTOR_VERSION_V1,
    scopeFingerprint: input.snapshot.scopeFingerprint,
    projectionRevision: input.snapshot.projectionRevision,
    claims: claims.map((claim) => ({
      path: claim.path,
      atomId: claim.atomId,
      kind: claim.kind,
      statement: claim.statement,
      sourceSeqs: [...claim.sourceSeqs],
      confidence: claim.confidence,
    })),
  });
  const sourceCount = new Set(
    claims
      .map((claim) => entries.get(claim.path)?.sourceId)
      .filter((value): value is string => typeof value === "string"),
  ).size;
  return Object.freeze({
    schemaVersion: PAW_MEMORY_PERSONA_PROJECTOR_VERSION_V1,
    projectionKey,
    scopeFingerprint: input.snapshot.scopeFingerprint,
    projectionRevision: input.snapshot.projectionRevision,
    claims: Object.freeze(claims),
    text,
    sourceCount,
  });
}

export function createMemoryPersonaSectionV1(
  persona: MemoryPersonaProjectionV1,
  sourceSeq = 1,
): ModelContextSectionV1 | undefined {
  if (persona.claims.length === 0) return undefined;
  const content = JSON.stringify({
    claims: persona.claims.map((claim) => ({
      atomId: claim.atomId,
      confidence: claim.confidence,
      kind: claim.kind,
      path: claim.path,
      sourceSeqs: [...claim.sourceSeqs],
      statement: claim.statement,
    })),
    projectionKey: persona.projectionKey,
    projectionRevision: persona.projectionRevision,
    schemaVersion: persona.schemaVersion,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "memory_cards",
    id: `memory-persona:${persona.projectionKey.slice(0, 24)}`,
    policyVersion: PAW_MEMORY_PERSONA_PROJECTOR_VERSION_V1,
    sourceFromSeq: sourceSeq,
    sourceThroughSeq: sourceSeq,
    contentHash: hashTextV1(content),
    content,
  });
}

/** Plugin-owned decorator: pins L3 before any dynamic memory evidence. */
export function createMemoryPersonaContextV1(
  base: JournalContextRuntimeV1,
  persona: MemoryPersonaProjectionV1,
  sourceSeq = 1,
): JournalContextRuntimeV1 {
  const plan = base.plan.bind(base);
  const build = base.build.bind(base);
  const section = createMemoryPersonaSectionV1(persona, sourceSeq);
  if (!section) return base;
  return Object.freeze({
    plan,
    async build(
      state: Parameters<JournalContextRuntimeV1["build"]>[0],
      options: Parameters<JournalContextRuntimeV1["build"]>[1],
    ): Promise<ModelRequestV1> {
      const request = await build(state, options);
      if (request.contextSections?.some((item) => item.id === section.id)) {
        return request;
      }
      return Object.freeze({
        ...request,
        contextSections: Object.freeze([
          section,
          ...(request.contextSections ?? []),
        ]),
      });
    },
  });
}

function personaCandidates(
  entry: MemorySceneIndexEntryV1,
  atoms: readonly SourceGroundedMemoryAtomV1[],
  minimumConfidence: number,
): SourceGroundedPersonaClaimV1[] {
  return atoms
    .filter(
      (
        atom,
      ): atom is SourceGroundedMemoryAtomV1 & {
        readonly kind: "profile" | "semantic";
      } =>
        (atom.kind === "profile" || atom.kind === "semantic") &&
        atom.validTo === undefined &&
        (atom.confidence ?? 1) >= minimumConfidence,
    )
    .map((atom, order) => ({
      claim: Object.freeze({
        path: entry.path,
        sourceId: entry.sourceId,
        atomId: atom.id,
        kind: atom.kind,
        statement: atom.statement.trim(),
        sourceSeqs: Object.freeze([...atom.sourceSeqs]),
        confidence: atom.confidence ?? 1,
      }),
      order,
      preference: PREFERENCE_SIGNALS.some((pattern) =>
        pattern.test(atom.statement),
      ),
    }))
    .sort((left, right) => {
      if (left.preference !== right.preference) return left.preference ? -1 : 1;
      if (left.claim.kind !== right.claim.kind) {
        return left.claim.kind === "profile" ? -1 : 1;
      }
      return left.order - right.order;
    })
    .map(({ claim }) => claim);
}

function renderClaim(claim: SourceGroundedPersonaClaimV1): string {
  const seq = claim.sourceSeqs.join(",") || "?";
  return `[${claim.kind} ${claim.path} @${seq}] ${claim.statement}`;
}

function normalizeStatement(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  errorName: string,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw namedError(errorName);
  }
  return value;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
