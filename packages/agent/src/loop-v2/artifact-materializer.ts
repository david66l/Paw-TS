import { createHash } from "node:crypto";
import { applyPatch, formatPatch, parsePatch, structuredPatch } from "diff";
import type { CandidateArtifactEvidenceV2 } from "./candidate-certification.js";
import { sha256Canonical } from "./canonical.js";
import type { MutationJournalEntryV2 } from "./schema.js";

export interface ArtifactContentBlobV2 {
  readonly ref: string;
  readonly contentHash: string;
  readonly content: string;
}

export interface ArtifactTransitionInputV2 {
  readonly path: string;
  readonly beforeContent: string | null;
  readonly afterContent: string | null;
}

export interface ArtifactCrossCheckV2 {
  readonly status: "matched" | "unavailable" | "mismatch";
  readonly detail?: string;
}

export interface MaterializedCandidateArtifactV2 {
  readonly status: "valid" | "invalid";
  readonly source: "mutation_journal";
  readonly patch: string;
  readonly patchHash: string;
  readonly changedPaths: readonly string[];
  readonly mutationRevisions: readonly number[];
  readonly crossCheck: ArtifactCrossCheckV2;
  readonly errors: readonly string[];
}

interface PathTransitionV2 {
  readonly path: string;
  readonly beforeHash: string | null;
  readonly beforeContent: string | null;
  readonly afterHash: string | null;
  readonly afterContent: string | null;
}

export function createArtifactContentBlobV2(
  content: string,
): ArtifactContentBlobV2 {
  const contentHash = artifactContentHashV2(content);
  return {
    ref: `artifact://loop-v2/content/${contentHash.slice("sha256:".length)}`,
    contentHash,
    content,
  };
}

export function artifactContentHashV2(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/** Render one complete, source-ordered mutation step from captured contents. */
export function renderMutationStepPatchV2(
  transitions: readonly ArtifactTransitionInputV2[],
): string {
  const paths = new Set<string>();
  const normalized: PathTransitionV2[] = [];
  for (const transition of transitions) {
    const path = normalizeArtifactPath(transition.path);
    if (!path || paths.has(path)) {
      throw new Error(
        `Invalid or duplicate mutation transition: ${transition.path}`,
      );
    }
    paths.add(path);
    normalized.push({
      path,
      beforeHash:
        transition.beforeContent === null
          ? null
          : artifactContentHashV2(transition.beforeContent),
      beforeContent: transition.beforeContent,
      afterHash:
        transition.afterContent === null
          ? null
          : artifactContentHashV2(transition.afterContent),
      afterContent: transition.afterContent,
    });
  }
  const patch = normalized
    .filter((transition) => transition.beforeHash !== transition.afterHash)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(renderTransitionPatch)
    .filter(Boolean)
    .join("\n");
  if (!patch.trim())
    throw new Error("Mutation transition has no content change");
  return patch;
}

export function materializeCandidateArtifactV2(
  mutations: readonly MutationJournalEntryV2[],
  blobs: readonly ArtifactContentBlobV2[],
  crossCheck: ArtifactCrossCheckV2,
): MaterializedCandidateArtifactV2 {
  const errors: string[] = [];
  const ordered = [...mutations].sort(
    (left, right) =>
      left.mutationRevision - right.mutationRevision || left.seq - right.seq,
  );
  const blobByRef = new Map<string, ArtifactContentBlobV2>();
  for (const blob of blobs) {
    if (!blob.ref.trim() || blobByRef.has(blob.ref)) {
      errors.push(`duplicate or empty artifact content ref: ${blob.ref}`);
      continue;
    }
    if (artifactContentHashV2(blob.content) !== blob.contentHash) {
      errors.push(`artifact content hash mismatch: ${blob.ref}`);
      continue;
    }
    blobByRef.set(blob.ref, blob);
  }

  if (ordered.length === 0) errors.push("mutation journal is empty");
  for (let index = 0; index < ordered.length; index += 1) {
    const mutation = ordered[index];
    if (!mutation) continue;
    if (mutation.mutationRevision !== index + 1) {
      errors.push(
        `mutation revisions are not contiguous at r${mutation.mutationRevision}`,
      );
    }
    if (!mutation.patch.trim()) {
      errors.push(`mutation r${mutation.mutationRevision} has an empty patch`);
    }
  }

  const terminalByPath = new Map<string, PathTransitionV2>();
  for (const mutation of ordered) {
    const uniquePaths = new Set(mutation.paths);
    if (uniquePaths.size !== mutation.paths.length || uniquePaths.size === 0) {
      errors.push(
        `mutation r${mutation.mutationRevision} has duplicate or empty paths`,
      );
    }
    const stepContents = new Map<
      string,
      Readonly<{
        before: string | null;
        after: string | null;
      }>
    >();
    for (const rawPath of uniquePaths) {
      const path = normalizeArtifactPath(rawPath);
      if (!path) {
        errors.push(
          `mutation r${mutation.mutationRevision} has unsafe path: ${rawPath}`,
        );
        continue;
      }
      const before = resolveContent(
        mutation.beforeHashes,
        mutation.beforeContentRefs,
        path,
        blobByRef,
        `r${mutation.mutationRevision} before`,
        errors,
      );
      const after = resolveContent(
        mutation.afterHashes,
        mutation.afterContentRefs,
        path,
        blobByRef,
        `r${mutation.mutationRevision} after`,
        errors,
      );
      if (!before.present || !after.present) continue;
      stepContents.set(path, {
        before: before.content,
        after: after.content,
      });
      const prior = terminalByPath.get(path);
      if (prior && prior.afterHash !== before.hash) {
        errors.push(
          `mutation continuity mismatch for ${path}: ${prior.afterHash ?? "missing"} -> ${before.hash ?? "missing"}`,
        );
      }
      terminalByPath.set(path, {
        path,
        beforeHash: prior?.beforeHash ?? before.hash,
        beforeContent: prior?.beforeContent ?? before.content,
        afterHash: after.hash,
        afterContent: after.content,
      });
    }
    validateFullStepPatch(mutation, stepContents, errors);
  }

  if (crossCheck.status === "mismatch") {
    errors.push(
      `Git cross-check mismatch${crossCheck.detail ? `: ${crossCheck.detail}` : ""}`,
    );
  }

  const transitions = [...terminalByPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const effective = transitions.filter(
    (transition) => transition.beforeHash !== transition.afterHash,
  );
  const patch =
    errors.length === 0
      ? effective.map(renderTransitionPatch).filter(Boolean).join("\n")
      : "";
  if (errors.length === 0 && !patch.trim()) {
    errors.push("mutation journal has no terminal content change");
  }
  const valid = errors.length === 0;
  return {
    status: valid ? "valid" : "invalid",
    source: "mutation_journal",
    patch: valid ? patch : "",
    patchHash: sha256Canonical(valid ? patch : ""),
    changedPaths: valid ? effective.map((transition) => transition.path) : [],
    mutationRevisions: ordered.map((mutation) => mutation.mutationRevision),
    crossCheck,
    errors,
  };
}

export function artifactEvidenceV2(
  artifact: MaterializedCandidateArtifactV2,
  artifactRef?: string,
): CandidateArtifactEvidenceV2 {
  return {
    reconstructible: artifact.status === "valid" && !!artifact.patch.trim(),
    crossCheck: artifact.crossCheck.status,
    ...(artifactRef ? { artifactRef } : {}),
  };
}

function resolveContent(
  hashes: Readonly<Record<string, string | null>>,
  refs: Readonly<Record<string, string | null>>,
  path: string,
  blobByRef: ReadonlyMap<string, ArtifactContentBlobV2>,
  label: string,
  errors: string[],
): Readonly<{
  readonly present: boolean;
  readonly hash: string | null;
  readonly content: string | null;
}> {
  if (!Object.hasOwn(hashes, path) || !Object.hasOwn(refs, path)) {
    errors.push(`${label} content metadata missing for ${path}`);
    return { present: false, hash: null, content: null };
  }
  const hash = hashes[path] ?? null;
  const ref = refs[path] ?? null;
  if (hash === null || ref === null) {
    if (hash !== null || ref !== null) {
      errors.push(`${label} hash/ref nullability mismatch for ${path}`);
      return { present: false, hash, content: null };
    }
    return { present: true, hash: null, content: null };
  }
  const blob = blobByRef.get(ref);
  if (!blob) {
    errors.push(`${label} content ref not found for ${path}: ${ref}`);
    return { present: false, hash, content: null };
  }
  if (
    blob.contentHash !== hash ||
    artifactContentHashV2(blob.content) !== hash
  ) {
    errors.push(`${label} content hash mismatch for ${path}`);
    return { present: false, hash, content: null };
  }
  return { present: true, hash, content: blob.content };
}

function renderTransitionPatch(transition: PathTransitionV2): string {
  if (transition.beforeContent === null && transition.afterContent === null) {
    return "";
  }
  const oldName =
    transition.beforeContent === null ? "/dev/null" : `a/${transition.path}`;
  const newName =
    transition.afterContent === null ? "/dev/null" : `b/${transition.path}`;
  const patch = structuredPatch(
    oldName,
    newName,
    normalizePatchContent(transition.beforeContent ?? ""),
    normalizePatchContent(transition.afterContent ?? ""),
    undefined,
    undefined,
    { context: 3 },
  );
  return formatPatch(patch).trimEnd();
}

function validateFullStepPatch(
  mutation: MutationJournalEntryV2,
  stepContents: ReadonlyMap<
    string,
    Readonly<{ before: string | null; after: string | null }>
  >,
  errors: string[],
): void {
  let parsed: ReturnType<typeof parsePatch>;
  try {
    parsed = parsePatch(mutation.patch);
  } catch {
    errors.push(
      `mutation r${mutation.mutationRevision} patch is not parseable`,
    );
    return;
  }
  const patchByPath = new Map<string, (typeof parsed)[number]>();
  for (const filePatch of parsed) {
    const rawName =
      filePatch.newFileName && filePatch.newFileName !== "/dev/null"
        ? filePatch.newFileName
        : filePatch.oldFileName;
    const path = rawName
      ? normalizeArtifactPath(rawName.replace(/^[ab]\//, ""))
      : undefined;
    if (!path || patchByPath.has(path)) {
      errors.push(
        `mutation r${mutation.mutationRevision} patch has an invalid or duplicate file`,
      );
      continue;
    }
    patchByPath.set(path, filePatch);
  }
  for (const [path, contents] of stepContents) {
    const filePatch = patchByPath.get(path);
    if (!filePatch) {
      errors.push(`mutation r${mutation.mutationRevision} patch omits ${path}`);
      continue;
    }
    const applied = applyPatch(
      normalizePatchContent(contents.before ?? ""),
      filePatch,
      {
        autoConvertLineEndings: true,
      },
    );
    if (
      applied === false ||
      applied !== normalizePatchContent(contents.after ?? "")
    ) {
      errors.push(
        `mutation r${mutation.mutationRevision} patch does not reproduce ${path}`,
      );
    }
  }
  for (const path of patchByPath.keys()) {
    if (!stepContents.has(path)) {
      errors.push(
        `mutation r${mutation.mutationRevision} patch includes undeclared ${path}`,
      );
    }
  }
}

function normalizePatchContent(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeArtifactPath(value: string): string | undefined {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return undefined;
  }
  return normalized;
}
