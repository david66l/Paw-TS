import fs from "node:fs";
import path from "node:path";

/** Path segments blocked for read/list (V2 path guard). */
export const SENSITIVE_PATH_SEGMENTS = new Set([
  ".git",
  ".paw",
  ".env",
  ".ssh",
  "id_rsa",
  "id_ed25519",
  "credentials",
  "secrets",
  ".aws",
  ".gcloud",
  ".netrc",
  ".npmrc",
  "authorized_keys",
  "known_hosts",
]);

export type PathRisk = "safe" | "sensitive" | "escaped" | "invalid";

export interface PathDecision {
  readonly allowed: boolean;
  readonly resolvedPath: string;
  readonly risk: PathRisk;
  readonly reason: string;
}

export function isPathInsideRoot(
  rootResolved: string,
  targetResolved: string,
): boolean {
  const root = path.resolve(rootResolved);
  const target = path.resolve(targetResolved);
  if (root === target) {
    return true;
  }
  const rel = path.relative(root, target);
  return (
    rel !== "" &&
    !rel.startsWith(`..${path.sep}`) &&
    rel !== ".." &&
    !path.isAbsolute(rel)
  );
}

function nearestExistingPath(absPath: string, rootAbs: string): string {
  let current = absPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    if (!isPathInsideRoot(rootAbs, parent) && parent !== rootAbs) {
      return parent;
    }
    current = parent;
  }
  return current;
}

function realpathExisting(absPath: string): string {
  return fs.realpathSync.native?.(absPath) ?? fs.realpathSync(absPath);
}

function segments(absPath: string): string[] {
  return absPath.split(path.sep).filter((p) => p.length > 0);
}

function hasSensitiveSegment(absPath: string): string | undefined {
  const parts = segments(absPath);
  for (const part of parts) {
    if (SENSITIVE_PATH_SEGMENTS.has(part)) {
      return part;
    }
  }
  return undefined;
}

/**
 * Resolve `userPath` (relative or absolute) against `workspaceRoot` and enforce
 * workspace boundary + sensitive segment deny list.
 */
export function checkWorkspacePath(
  workspaceRoot: string,
  userPath: string,
): PathDecision {
  let rootAbs: string;
  let rootReal: string;
  try {
    rootAbs = path.resolve(workspaceRoot);
    rootReal = realpathExisting(rootAbs);
  } catch {
    return {
      allowed: false,
      resolvedPath: "",
      risk: "invalid",
      reason: "Workspace root could not be resolved",
    };
  }

  let candidate: string;
  try {
    candidate = path.isAbsolute(userPath)
      ? path.resolve(userPath)
      : path.resolve(rootAbs, userPath);
  } catch {
    return {
      allowed: false,
      resolvedPath: "",
      risk: "invalid",
      reason: "Path could not be resolved",
    };
  }

  if (!isPathInsideRoot(rootAbs, candidate)) {
    return {
      allowed: false,
      resolvedPath: candidate,
      risk: "escaped",
      reason: `Path escapes workspace root: ${rootAbs}`,
    };
  }

  try {
    const existing = nearestExistingPath(candidate, rootAbs);
    const existingReal = realpathExisting(existing);
    if (!isPathInsideRoot(rootReal, existingReal)) {
      return {
        allowed: false,
        resolvedPath: candidate,
        risk: "escaped",
        reason: `Path escapes workspace root via symlink: ${rootReal}`,
      };
    }
  } catch {
    return {
      allowed: false,
      resolvedPath: candidate,
      risk: "invalid",
      reason: "Path could not be checked against real workspace path",
    };
  }

  const bad = hasSensitiveSegment(candidate);
  if (bad) {
    return {
      allowed: false,
      resolvedPath: candidate,
      risk: "sensitive",
      reason: `Path contains sensitive segment: ${bad}`,
    };
  }

  return { allowed: true, resolvedPath: candidate, risk: "safe", reason: "" };
}
