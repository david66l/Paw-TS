export const PAW_MEMORY_SCENE_PROJECTOR_VERSION_V1 =
  "paw.memory-scene-projector.v1" as const;

export interface SourceGroundedMemoryAtomV1 {
  readonly id: string;
  readonly kind: "semantic" | "episodic" | "profile";
  readonly statement: string;
  readonly sourceSeqs: readonly number[];
  readonly confidence?: number;
  readonly validFrom?: string;
  readonly validTo?: string;
}

export interface SourceGroundedMemorySceneInputV1 {
  readonly sourceId: string;
  readonly rank: number;
  readonly atoms: readonly SourceGroundedMemoryAtomV1[];
}

export interface SourceGroundedMemorySceneV1 {
  readonly sourceId: string;
  readonly atomIds: readonly string[];
  readonly sourceSeqs: readonly number[];
  readonly text: string;
}

/**
 * Builds deterministic, source-grounded L2 scenes from existing L1 atoms.
 * No model call is made and no statement can cross its caller-owned source.
 */
export function projectSourceGroundedMemoryScenesV1(input: {
  readonly sources: readonly SourceGroundedMemorySceneInputV1[];
  readonly maxChars: number;
}): readonly SourceGroundedMemorySceneV1[] {
  if (!Number.isSafeInteger(input.maxChars) || input.maxChars < 1_024) {
    throw namedError("MemorySceneBudgetInvalid");
  }
  const sources = [...input.sources]
    .map(validateSource)
    .filter((source) => source.atoms.length > 0)
    .sort(
      (left, right) =>
        left.rank - right.rank || left.sourceId.localeCompare(right.sourceId),
    );
  if (sources.length === 0) return Object.freeze([]);
  const perSourceBudget = Math.floor(input.maxChars / sources.length);
  const scenes: SourceGroundedMemorySceneV1[] = [];
  for (const source of sources) {
    const atomIds: string[] = [];
    const sourceSeqs = new Set<number>();
    const lines: string[] = [];
    let used = 0;
    for (const atom of source.atoms) {
      const seqLabel =
        atom.sourceSeqs.length > 0 ? atom.sourceSeqs.join(",") : "?";
      const line = `[${atom.kind} @${seqLabel}] ${atom.statement}`;
      const separator = lines.length > 0 ? 1 : 0;
      if (used + separator + line.length > perSourceBudget) continue;
      lines.push(line);
      atomIds.push(atom.id);
      for (const seq of atom.sourceSeqs) sourceSeqs.add(seq);
      used += separator + line.length;
    }
    if (lines.length === 0) continue;
    scenes.push(
      Object.freeze({
        sourceId: source.sourceId,
        atomIds: Object.freeze(atomIds),
        sourceSeqs: Object.freeze([...sourceSeqs].sort((a, b) => a - b)),
        text: lines.join("\n"),
      }),
    );
  }
  return Object.freeze(scenes);
}

function validateSource(source: SourceGroundedMemorySceneInputV1): Readonly<{
  sourceId: string;
  rank: number;
  atoms: readonly SourceGroundedMemoryAtomV1[];
}> {
  if (
    !source.sourceId.trim() ||
    !Number.isSafeInteger(source.rank) ||
    source.rank < 0
  ) {
    throw namedError("MemorySceneSourceInvalid");
  }
  const seenIds = new Set<string>();
  const atoms = source.atoms
    .map((atom) => {
      if (!atom.id.trim() || !atom.statement.trim() || seenIds.has(atom.id)) {
        throw namedError("MemorySceneAtomInvalid");
      }
      if (!new Set(["semantic", "episodic", "profile"]).has(atom.kind)) {
        throw namedError("MemorySceneAtomInvalid");
      }
      const sourceSeqs = [...new Set(atom.sourceSeqs)];
      if (sourceSeqs.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) {
        throw namedError("MemorySceneAtomSourceInvalid");
      }
      seenIds.add(atom.id);
      if (
        atom.confidence !== undefined &&
        (!Number.isFinite(atom.confidence) ||
          atom.confidence < 0 ||
          atom.confidence > 1)
      ) {
        throw namedError("MemorySceneAtomConfidenceInvalid");
      }
      return Object.freeze({
        ...atom,
        statement: atom.statement.trim(),
        sourceSeqs: Object.freeze(sourceSeqs.sort((a, b) => a - b)),
      });
    })
    .sort((left, right) => {
      const leftSeq = left.sourceSeqs[0] ?? Number.MAX_SAFE_INTEGER;
      const rightSeq = right.sourceSeqs[0] ?? Number.MAX_SAFE_INTEGER;
      return leftSeq - rightSeq || left.id.localeCompare(right.id);
    });
  return Object.freeze({
    sourceId: source.sourceId,
    rank: source.rank,
    atoms: Object.freeze(atoms),
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
