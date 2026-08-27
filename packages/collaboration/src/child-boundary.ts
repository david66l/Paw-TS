import type { WorkspacePathPolicyV1 } from "@paw/workspace";

import type {
  CollaborationAgentSpecV1,
  CollaborationEffectProfileV1,
} from "./roster.js";

export const COLLABORATION_CHILD_BOUNDARY_VERSION_V1 =
  "paw.collaboration-child-boundary.v1" as const;

export type CollaborationChildWorkspaceModeV1 =
  | "shared_readonly"
  | "shared_exclusive"
  | "isolated_worktree";

export type CollaborationChildShellPolicyV1 =
  | "deny"
  | "read_only"
  | "verification"
  | "allow";

/** Trusted runtime authority. Delegation scope text never grants permission. */
export interface CollaborationChildBoundaryV1 {
  readonly schemaVersion: typeof COLLABORATION_CHILD_BOUNDARY_VERSION_V1;
  readonly effect: CollaborationEffectProfileV1;
  readonly workspaceMode: CollaborationChildWorkspaceModeV1;
  readonly shellPolicy: CollaborationChildShellPolicyV1;
  readonly pathPolicy: WorkspacePathPolicyV1;
}

export function createCollaborationChildBoundaryV1(input: {
  readonly agent: CollaborationAgentSpecV1;
  /** True only when the shell is already fenced by an enabled sandbox. */
  readonly sandboxedShell: boolean;
  /** Reserved for the worktree execution adapter. */
  readonly isolatedWorktree?: boolean;
}): CollaborationChildBoundaryV1 {
  const effect = input.agent.effect;
  const isolated = input.isolatedWorktree === true;
  const workspaceMode: CollaborationChildWorkspaceModeV1 = isolated
    ? "isolated_worktree"
    : effect === "mutate"
      ? "shared_exclusive"
      : "shared_readonly";
  const shellPolicy: CollaborationChildShellPolicyV1 =
    effect === "inspect"
      ? "deny"
      : effect === "mutate" || input.sandboxedShell || isolated
        ? "allow"
        : "verification";
  return Object.freeze({
    schemaVersion: COLLABORATION_CHILD_BOUNDARY_VERSION_V1,
    effect,
    workspaceMode,
    shellPolicy,
    pathPolicy: Object.freeze({
      readRoots: Object.freeze(["."]),
      writeRoots: Object.freeze(effect === "mutate" ? ["."] : []),
      denyPaths: Object.freeze([".git", ".paw"]),
    }),
  });
}
