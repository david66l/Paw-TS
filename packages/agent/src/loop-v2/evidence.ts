import { sha256Canonical } from "./canonical.js";
import type {
  EvidenceObservation,
  ReadCoverageV2,
  ReadEvidenceObservation,
} from "./schema.js";

interface Interval {
  readonly start: number;
  readonly endExclusive: number;
}

export function evidenceFingerprint(observation: EvidenceObservation): string {
  return sha256Canonical(normalizeObservation(observation));
}

export function readCoverageKey(observation: ReadEvidenceObservation): string {
  return sha256Canonical({
    kind: observation.kind,
    path: normalizePath(observation.path),
    contentHash: observation.contentHash,
    repositoryRevision: observation.repositoryRevision,
  });
}

export function extendReadCoverage(
  prior: ReadCoverageV2 | undefined,
  observation: ReadEvidenceObservation,
): { readonly coverage: ReadCoverageV2; readonly meaningful: boolean } {
  validateReadRange(observation);
  const incoming = {
    start: observation.start,
    endExclusive: observation.endExclusive,
  };
  const priorIntervals = prior?.intervals ?? [];
  const meaningful = !isCovered(priorIntervals, incoming);
  const intervals = mergeIntervals([...priorIntervals, incoming]);
  return {
    coverage: {
      key: readCoverageKey(observation),
      path: normalizePath(observation.path),
      contentHash: observation.contentHash,
      repositoryRevision: observation.repositoryRevision,
      intervals,
    },
    meaningful,
  };
}

function normalizeObservation(observation: EvidenceObservation): unknown {
  if (observation.kind === "read") {
    return {
      ...observation,
      path: normalizePath(observation.path),
      artifactRef: undefined,
    };
  }
  if (observation.kind === "search") {
    return {
      ...observation,
      root: normalizePath(observation.root),
      query: observation.query.trim(),
      artifactRef: undefined,
    };
  }
  return {
    ...observation,
    cwd: normalizePath(observation.cwd),
    artifactRef: undefined,
  };
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function validateReadRange(observation: ReadEvidenceObservation): void {
  if (
    !Number.isInteger(observation.start) ||
    !Number.isInteger(observation.endExclusive) ||
    observation.start < 0 ||
    observation.endExclusive <= observation.start
  ) {
    throw new Error(
      `Invalid read range [${observation.start}, ${observation.endExclusive}) for ${observation.path}`,
    );
  }
}

function isCovered(
  intervals: readonly Interval[],
  incoming: Interval,
): boolean {
  return intervals.some(
    (interval) =>
      interval.start <= incoming.start &&
      interval.endExclusive >= incoming.endExclusive,
  );
}

function mergeIntervals(intervals: readonly Interval[]): readonly Interval[] {
  const sorted = [...intervals].sort(
    (left, right) =>
      left.start - right.start || left.endExclusive - right.endExclusive,
  );
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const tail = merged.at(-1);
    if (!tail || interval.start > tail.endExclusive) {
      merged.push({ ...interval });
      continue;
    }
    merged[merged.length - 1] = {
      start: tail.start,
      endExclusive: Math.max(tail.endExclusive, interval.endExclusive),
    };
  }
  return merged;
}
