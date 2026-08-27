import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Paw Next tool-effect checkpoint semantics frozen into the product manifest.
 *
 * A version change covers the canonical allocation fact requirement, the
 * shared requiresToolCheckpointV1 predicate, namespace derivation, and the
 * physical no-overwrite checkpoint layout. Existing runs must compare this
 * value before restoring a checkpoint sequence.
 */
export const PAW_TOOL_EFFECT_CHECKPOINT_POLICY_VERSION_V1 =
  "paw.tool-effect-checkpoint.v1";

/**
 * Derive the physical checkpoint namespace from the canonical product owner.
 * The workspace already scopes the directory tree, while including its real
 * path in the digest prevents a namespace capability from being moved to a
 * different workspace without changing identity.
 */
export function createToolCheckpointNamespaceIdV1(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
}): string {
  assertIdentityPart(input.sessionId, "sessionId");
  assertIdentityPart(input.runId, "runId");
  const canonicalWorkspace = canonicalWorkspaceIdentity(input.workspaceRoot);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        PAW_TOOL_EFFECT_CHECKPOINT_POLICY_VERSION_V1,
        canonicalWorkspace,
        input.sessionId,
        input.runId,
      ]),
    )
    .digest("hex");
  return `pawnextv1_${digest}`;
}

function canonicalWorkspaceIdentity(workspaceRoot: string): string {
  const canonical = fs.realpathSync.native(path.resolve(workspaceRoot));
  const normalized = canonical.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function assertIdentityPart(value: string, name: string): void {
  if (!value.trim() || value.length > 1_024) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
}
