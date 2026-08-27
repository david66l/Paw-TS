import type { ModelContextSectionV1, ModelRequestV1 } from "@paw/core";
import type { JournalContextRuntimeV1 } from "@paw/runtime";

import { hashCanonicalJsonV1, hashTextV1 } from "./canonical.js";
import type {
  SourceGroundedMemoryAtomV1,
  SourceGroundedMemorySceneInputV1,
} from "./scene-projector.js";

export const PAW_MEMORY_SCENE_NAVIGATION_VERSION_V1 =
  "paw.memory-scene-navigation.v1" as const;

export type MemoryQueryRouteKindV1 =
  | "l0_fallback"
  | "scene_causal"
  | "scene_exploratory";

export interface MemoryQueryRouteV1 {
  readonly route: MemoryQueryRouteKindV1;
  readonly confidence: number;
  readonly reasonCode:
    | "memory_route_explicit_causal"
    | "memory_route_explicit_exploratory"
    | "memory_route_exploratory_requires_profile"
    | "memory_route_conservative_fallback";
  readonly maxSceneReads: number;
  readonly maxAtomsPerScene: number;
  readonly maxDynamicChars: number;
}

export interface MemorySceneIndexEntryV1 {
  readonly path: string;
  readonly sourceId: string;
  readonly rank: number;
  readonly summary: string;
  readonly atomCount: number;
  readonly sourceFromSeq: number;
  readonly sourceThroughSeq: number;
  readonly bodyHash: string;
}

export interface MemorySceneBodyV1 {
  readonly path: string;
  readonly sourceId: string;
  readonly atoms: readonly SourceGroundedMemoryAtomV1[];
}

export interface MemorySceneSnapshotV1 {
  readonly schemaVersion: typeof PAW_MEMORY_SCENE_NAVIGATION_VERSION_V1;
  readonly snapshotKey: string;
  readonly scopeFingerprint: string;
  readonly projectionRevision: string;
  readonly indexText: string;
  readonly indexEntries: readonly MemorySceneIndexEntryV1[];
  readonly bodies: Readonly<Record<string, MemorySceneBodyV1>>;
}

export interface MemorySceneSelectionV1 {
  readonly route: MemoryQueryRouteV1;
  readonly reads: readonly Readonly<{
    path: string;
    sourceId: string;
    atomIds: readonly string[];
    sourceSeqs: readonly number[];
    text: string;
  }>[];
  readonly telemetry: Readonly<{
    stablePrefixHash: string;
    stablePrefixChars: number;
    sceneReadCount: number;
    selectedAtomCount: number;
    dynamicChars: number;
    fallback: boolean;
  }>;
}

const ROUTE_CAUSAL = [
  /\bwhy\b/iu,
  /\breason(?:s|ing)?\b/iu,
  /\bbecause\b/iu,
  /\bchanged?\b/iu,
  /\bupdates?\b/iu,
  /\bevolv(?:e|ed|es|ing|ution)\b/iu,
  /\bno longer\b/iu,
  /\bused to\b/iu,
  /为什么|原因|变化|改变|演变|不再/u,
] as const;

const ROUTE_EXPLORATORY = [
  /\brecommend(?:ation|ations|ed|ing)?\b/iu,
  /\bsuggest(?:ion|ions|ed|ing)?\b/iu,
  /\bnew ideas?\b/iu,
  /\bwhat (?:activity|option|approach|choice)\b/iu,
  /\blooking for\b/iu,
  /推荐|建议|新想法|新点子|适合/u,
] as const;

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "could",
  "from",
  "have",
  "into",
  "just",
  "more",
  "question",
  "should",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "user",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

/**
 * Creates a versioned, scope-bound L2 snapshot. The stable index is separate
 * from source-grounded bodies so callers can expose list/read without putting
 * every atom in the model prefix.
 */
export function createMemorySceneSnapshotV1(input: {
  readonly scopeFingerprint: string;
  readonly projectionRevision: string;
  readonly sources: readonly SourceGroundedMemorySceneInputV1[];
  readonly maxIndexChars?: number;
  readonly summaryMaxChars?: number;
}): MemorySceneSnapshotV1 {
  const scopeFingerprint = stableIdentity(input.scopeFingerprint, "scope");
  const projectionRevision = stableIdentity(
    input.projectionRevision,
    "projection revision",
  );
  const maxIndexChars = boundedInteger(
    input.maxIndexChars ?? 4_096,
    512,
    32_768,
    "MemorySceneIndexBudgetInvalid",
  );
  const summaryMaxChars = boundedInteger(
    input.summaryMaxChars ?? 240,
    64,
    512,
    "MemorySceneSummaryBudgetInvalid",
  );
  const sources = [...input.sources]
    .map(normalizeSource)
    .filter((source) => source.atoms.length > 0)
    .sort(
      (left, right) =>
        left.rank - right.rank || left.sourceId.localeCompare(right.sourceId),
    );
  const bodies: Record<string, MemorySceneBodyV1> = {};
  const candidates = sources.map((source) => {
    const path = `scene/${hashTextV1(source.sourceId).slice(0, 20)}`;
    const atoms = Object.freeze([...source.atoms]);
    const sourceSeqs = atoms.flatMap((atom) => atom.sourceSeqs);
    const bodyHash = hashCanonicalJsonV1({
      path,
      sourceId: source.sourceId,
      atoms: atoms.map((atom) => ({
        id: atom.id,
        kind: atom.kind,
        statement: atom.statement,
        sourceSeqs: [...atom.sourceSeqs],
        confidence: atom.confidence ?? 1,
        validFrom: atom.validFrom ?? null,
        validTo: atom.validTo ?? null,
      })),
    });
    bodies[path] = Object.freeze({ path, sourceId: source.sourceId, atoms });
    return Object.freeze({
      path,
      sourceId: source.sourceId,
      rank: source.rank,
      summary: summarizeAtoms(atoms, summaryMaxChars),
      atomCount: atoms.length,
      sourceFromSeq: sourceSeqs.length > 0 ? Math.min(...sourceSeqs) : 1,
      sourceThroughSeq: sourceSeqs.length > 0 ? Math.max(...sourceSeqs) : 1,
      bodyHash,
    });
  });
  const indexEntries: MemorySceneIndexEntryV1[] = [];
  const indexLines: string[] = [];
  let used = 0;
  for (const candidate of candidates) {
    const fixed = `${candidate.path} seq=${candidate.sourceFromSeq}-${candidate.sourceThroughSeq} atoms=${candidate.atomCount}`;
    const separator = indexLines.length > 0 ? 1 : 0;
    const remaining = maxIndexChars - used - separator - fixed.length - 1;
    if (remaining < 16) continue;
    const summary = truncate(candidate.summary, remaining);
    const line = `${fixed} ${summary}`;
    indexEntries.push(Object.freeze({ ...candidate, summary }));
    indexLines.push(line);
    used += separator + line.length;
  }
  const indexText = indexLines.join("\n");
  const snapshotKey = hashCanonicalJsonV1({
    schemaVersion: PAW_MEMORY_SCENE_NAVIGATION_VERSION_V1,
    scopeFingerprint,
    projectionRevision,
    entries: indexEntries.map((entry) => ({
      path: entry.path,
      rank: entry.rank,
      summary: entry.summary,
      atomCount: entry.atomCount,
      sourceFromSeq: entry.sourceFromSeq,
      sourceThroughSeq: entry.sourceThroughSeq,
      bodyHash: entry.bodyHash,
    })),
  });
  return Object.freeze({
    schemaVersion: PAW_MEMORY_SCENE_NAVIGATION_VERSION_V1,
    snapshotKey,
    scopeFingerprint,
    projectionRevision,
    indexText,
    indexEntries: Object.freeze(indexEntries),
    bodies: Object.freeze(bodies),
  });
}

/** Conservative by design: ambiguous queries remain on the proven L0/L1 path. */
export function routeMemoryQueryV1(
  query: string,
  options: Readonly<{ allowExploratoryScenes?: boolean }> = {},
): MemoryQueryRouteV1 {
  const normalized = query.trim();
  if (!normalized) throw namedError("MemorySceneQueryInvalid");
  const surface = querySurface(normalized);
  if (ROUTE_CAUSAL.some((pattern) => pattern.test(surface))) {
    return Object.freeze({
      route: "scene_causal",
      confidence: 0.9,
      reasonCode: "memory_route_explicit_causal",
      maxSceneReads: 2,
      maxAtomsPerScene: 10,
      maxDynamicChars: 4_800,
    });
  }
  if (ROUTE_EXPLORATORY.some((pattern) => pattern.test(surface))) {
    if (options.allowExploratoryScenes !== true) {
      return Object.freeze({
        route: "l0_fallback",
        confidence: 1,
        reasonCode: "memory_route_exploratory_requires_profile",
        maxSceneReads: 0,
        maxAtomsPerScene: 0,
        maxDynamicChars: 0,
      });
    }
    return Object.freeze({
      route: "scene_exploratory",
      confidence: 0.75,
      reasonCode: "memory_route_explicit_exploratory",
      maxSceneReads: 1,
      maxAtomsPerScene: 6,
      maxDynamicChars: 3_200,
    });
  }
  return Object.freeze({
    route: "l0_fallback",
    confidence: 1,
    reasonCode: "memory_route_conservative_fallback",
    maxSceneReads: 0,
    maxAtomsPerScene: 0,
    maxDynamicChars: 0,
  });
}

/** Selects L2 bodies using only the stable index, then bounds atoms and chars. */
export function selectMemorySceneEvidenceV1(input: {
  readonly snapshot: MemorySceneSnapshotV1;
  readonly query: string;
  readonly route?: MemoryQueryRouteV1;
}): MemorySceneSelectionV1 {
  const route = input.route ?? routeMemoryQueryV1(input.query);
  if (route.route === "l0_fallback") {
    return emptySelection(input.snapshot, route);
  }
  const queryTerms = terms(querySurface(input.query));
  const ranked = input.snapshot.indexEntries
    .map((entry) => ({
      entry,
      score: overlapScore(queryTerms, terms(entry.summary)),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.entry.rank - right.entry.rank,
    )
    .slice(0, route.maxSceneReads);
  const reads: MemorySceneSelectionV1["reads"][number][] = [];
  let usedChars = 0;
  for (const candidate of ranked) {
    const body = input.snapshot.bodies[candidate.entry.path];
    if (!body) continue;
    const selected = selectAtoms(body.atoms, queryTerms, route).slice(
      0,
      route.maxAtomsPerScene,
    );
    const lines: string[] = [];
    const atomIds: string[] = [];
    const sourceSeqs = new Set<number>();
    for (const atom of selected) {
      const seqLabel = atom.sourceSeqs.join(",") || "?";
      const line = `[${atom.kind} @${seqLabel}] ${atom.statement}`;
      const separator = lines.length > 0 ? 1 : 0;
      if (usedChars + separator + line.length > route.maxDynamicChars) continue;
      lines.push(line);
      atomIds.push(atom.id);
      for (const seq of atom.sourceSeqs) sourceSeqs.add(seq);
      usedChars += separator + line.length;
    }
    if (lines.length === 0) continue;
    reads.push(
      Object.freeze({
        path: body.path,
        sourceId: body.sourceId,
        atomIds: Object.freeze(atomIds),
        sourceSeqs: Object.freeze([...sourceSeqs].sort((a, b) => a - b)),
        text: lines.join("\n"),
      }),
    );
  }
  return Object.freeze({
    route,
    reads: Object.freeze(reads),
    telemetry: Object.freeze({
      stablePrefixHash: input.snapshot.snapshotKey,
      stablePrefixChars: input.snapshot.indexText.length,
      sceneReadCount: reads.length,
      selectedAtomCount: reads.reduce(
        (total, read) => total + read.atomIds.length,
        0,
      ),
      dynamicChars: reads.reduce((total, read) => total + read.text.length, 0),
      fallback: false,
    }),
  });
}

/** Produces the stable system evidence section without changing Runtime. */
export function createMemorySceneIndexSectionV1(
  snapshot: MemorySceneSnapshotV1,
  sourceSeq = 1,
): ModelContextSectionV1 | undefined {
  if (snapshot.indexEntries.length === 0) return undefined;
  const content = JSON.stringify({
    entries: snapshot.indexEntries.map((entry) => ({
      atomCount: entry.atomCount,
      path: entry.path,
      sourceFromSeq: entry.sourceFromSeq,
      sourceThroughSeq: entry.sourceThroughSeq,
      summary: entry.summary,
    })),
    projectionRevision: snapshot.projectionRevision,
    schemaVersion: snapshot.schemaVersion,
    snapshotKey: snapshot.snapshotKey,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "memory_cards",
    id: `memory-scene-index:${snapshot.snapshotKey.slice(0, 24)}`,
    policyVersion: PAW_MEMORY_SCENE_NAVIGATION_VERSION_V1,
    sourceFromSeq: sourceSeq,
    sourceThroughSeq: sourceSeq,
    contentHash: hashTextV1(content),
    content,
  });
}

/** Plugin-owned decorator that pins one snapshot for the caller-owned session. */
export function createMemorySceneSnapshotContextV1(
  base: JournalContextRuntimeV1,
  snapshot: MemorySceneSnapshotV1,
  sourceSeq = 1,
): JournalContextRuntimeV1 {
  const plan = base.plan.bind(base);
  const build = base.build.bind(base);
  const section = createMemorySceneIndexSectionV1(snapshot, sourceSeq);
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

function emptySelection(
  snapshot: MemorySceneSnapshotV1,
  route: MemoryQueryRouteV1,
): MemorySceneSelectionV1 {
  return Object.freeze({
    route,
    reads: Object.freeze([]),
    telemetry: Object.freeze({
      stablePrefixHash: snapshot.snapshotKey,
      stablePrefixChars: snapshot.indexText.length,
      sceneReadCount: 0,
      selectedAtomCount: 0,
      dynamicChars: 0,
      fallback: true,
    }),
  });
}

function normalizeSource(source: SourceGroundedMemorySceneInputV1) {
  if (
    !source.sourceId.trim() ||
    !Number.isSafeInteger(source.rank) ||
    source.rank < 0
  ) {
    throw namedError("MemorySceneSourceInvalid");
  }
  const ids = new Set<string>();
  const atoms = source.atoms
    .map((atom) => {
      if (!atom.id.trim() || !atom.statement.trim() || ids.has(atom.id)) {
        throw namedError("MemorySceneAtomInvalid");
      }
      const sourceSeqs = [...new Set(atom.sourceSeqs)].sort((a, b) => a - b);
      if (sourceSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) {
        throw namedError("MemorySceneAtomSourceInvalid");
      }
      if (
        atom.confidence !== undefined &&
        (!Number.isFinite(atom.confidence) ||
          atom.confidence < 0 ||
          atom.confidence > 1)
      ) {
        throw namedError("MemorySceneAtomConfidenceInvalid");
      }
      ids.add(atom.id);
      return Object.freeze({
        id: atom.id,
        kind: atom.kind,
        statement: atom.statement.trim(),
        sourceSeqs: Object.freeze(sourceSeqs),
        ...(atom.confidence === undefined
          ? {}
          : { confidence: atom.confidence }),
        ...(atom.validFrom === undefined ? {} : { validFrom: atom.validFrom }),
        ...(atom.validTo === undefined ? {} : { validTo: atom.validTo }),
      });
    })
    .sort(
      (left, right) =>
        (left.sourceSeqs[0] ?? Number.MAX_SAFE_INTEGER) -
          (right.sourceSeqs[0] ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    );
  return Object.freeze({
    sourceId: source.sourceId.trim(),
    rank: source.rank,
    atoms: Object.freeze(atoms),
  });
}

function summarizeAtoms(
  atoms: readonly SourceGroundedMemoryAtomV1[],
  maxChars: number,
): string {
  const prioritized = [...atoms].sort((left, right) => {
    const weight = (kind: SourceGroundedMemoryAtomV1["kind"]) =>
      kind === "profile" ? 0 : kind === "semantic" ? 1 : 2;
    return weight(left.kind) - weight(right.kind);
  });
  const pieces: string[] = [];
  for (const atom of prioritized) {
    const candidate =
      pieces.length > 0
        ? `${pieces.join("; ")}; ${atom.statement}`
        : atom.statement;
    if (candidate.length > maxChars) {
      if (pieces.length === 0) pieces.push(truncate(atom.statement, maxChars));
      break;
    }
    pieces.push(atom.statement);
    if (pieces.length >= 2) break;
  }
  return pieces.join("; ");
}

function selectAtoms(
  atoms: readonly SourceGroundedMemoryAtomV1[],
  queryTerms: ReadonlySet<string>,
  route: MemoryQueryRouteV1,
): SourceGroundedMemoryAtomV1[] {
  return [...atoms]
    .map((atom, order) => {
      let score = overlapScore(queryTerms, terms(atom.statement)) * 10;
      if (route.route === "scene_causal") {
        if (atom.kind === "episodic") score += 4;
        if (atom.kind === "semantic") score += 3;
      } else if (route.route === "scene_exploratory") {
        if (atom.kind === "profile") score += 5;
        if (atom.kind === "semantic") score += 3;
      }
      return { atom, order, score };
    })
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, route.maxAtomsPerScene)
    .map(({ atom }) => atom)
    .sort(
      (left, right) =>
        (left.sourceSeqs[0] ?? Number.MAX_SAFE_INTEGER) -
          (right.sourceSeqs[0] ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    );
}

function terms(text: string): ReadonlySet<string> {
  const tokens =
    text.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu) ?? [];
  return new Set(
    tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function querySurface(query: string): string {
  return query.split(/\n\s*\([a-z]\)\s*/iu, 1)[0] ?? query;
}

function overlapScore(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let score = 0;
  for (const value of left) if (right.has(value)) score += 1;
  return score;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function stableIdentity(value: string, label: string): string {
  if (!value.trim() || value.length > 512 || hasControlCharacter(value)) {
    throw namedError(`MemoryScene${label.replace(/\W+/g, "")}Invalid`);
  }
  return value.trim();
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
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
