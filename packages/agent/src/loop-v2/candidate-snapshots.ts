import {
  type ArtifactContentBlobV2,
  artifactContentHashV2,
} from "./artifact-materializer.js";
import {
  type CandidateSourceSnapshotV2,
  candidateSnapshotHashV2,
} from "./candidate-certification.js";
import type { WorkingDecisionStateV2 } from "./schema.js";

/** Materialize current source snapshots from the terminal mutation refs. */
export function materializeTerminalCandidateSnapshotsV2(
  state: WorkingDecisionStateV2,
  blobs: readonly ArtifactContentBlobV2[],
): readonly CandidateSourceSnapshotV2[] {
  const terminal = new Map<
    string,
    Readonly<{ contentHash: string | null; contentRef: string | null }>
  >();
  const mutations = Object.values(state.mutations).sort(
    (left, right) =>
      left.mutationRevision - right.mutationRevision || left.seq - right.seq,
  );
  for (const mutation of mutations) {
    for (const path of mutation.paths) {
      terminal.set(path, {
        contentHash: mutation.afterHashes[path] ?? null,
        contentRef: mutation.afterContentRefs[path] ?? null,
      });
    }
  }

  const blobByRef = new Map(blobs.map((blob) => [blob.ref, blob]));
  return [...terminal]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([path, source]) => {
      if (source.contentHash === null && source.contentRef === null) return [];
      if (source.contentHash === null || source.contentRef === null) {
        throw new Error(`Candidate snapshot hash/ref mismatch: ${path}`);
      }
      const blob = blobByRef.get(source.contentRef);
      if (
        !blob ||
        blob.contentHash !== source.contentHash ||
        artifactContentHashV2(blob.content) !== source.contentHash
      ) {
        throw new Error(`Candidate snapshot content mismatch: ${path}`);
      }
      return [
        {
          path,
          contentHash: candidateSnapshotHashV2(blob.content),
          content: blob.content,
        },
      ];
    });
}
