import fs from "node:fs";
import path from "node:path";

export interface CanonicalPayloadIdentityV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
}

/** Canonical filesystem owner identity shared by Session and payload stores. */
export function canonicalPayloadWorkspaceRootV1(workspaceRoot: string): string {
  const canonical = fs.realpathSync.native(path.resolve(workspaceRoot));
  const normalized = canonical.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function freezeCanonicalPayloadIdentityV1(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
}): CanonicalPayloadIdentityV1 {
  return Object.freeze({
    workspaceRoot: canonicalPayloadWorkspaceRootV1(input.workspaceRoot),
    sessionId: input.sessionId,
    runId: input.runId,
  });
}
