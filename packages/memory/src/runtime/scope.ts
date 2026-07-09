/**
 * workspaceRoot → Memory scope 映射。
 *
 * 规则（与 cutover plan §4.4 一致）：
 * - userId: options / PAW_USER_ID / "local"
 * - repositoryId: options / git remote hash / sha256(workspaceRoot).slice(0,16)
 * - workspaceId: options / repositoryId
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { MemoryRuntimeOptions } from "./types.js";

export interface ResolvedScope {
  readonly userId: string;
  readonly repositoryId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
}

function sha16(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function tryGitRemote(workspaceRoot: string): string | null {
  try {
    const out = execSync("git remote get-url origin", {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function readSettingsOverrides(
  workspaceRoot: string,
): Partial<Pick<MemoryRuntimeOptions, "userId" | "repositoryId" | "workspaceId">> {
  try {
    const p = path.join(workspaceRoot, ".paw", "settings.local.json");
    if (!fs.existsSync(p)) return {};
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    return {
      userId:
        typeof raw.user_id === "string"
          ? raw.user_id
          : typeof raw.userId === "string"
            ? raw.userId
            : undefined,
      repositoryId:
        typeof raw.repository_id === "string"
          ? raw.repository_id
          : typeof raw.repositoryId === "string"
            ? raw.repositoryId
            : undefined,
      workspaceId:
        typeof raw.workspace_id === "string"
          ? raw.workspace_id
          : typeof raw.workspaceId === "string"
            ? raw.workspaceId
            : undefined,
    };
  } catch {
    return {};
  }
}

export function resolveScope(opts: MemoryRuntimeOptions): ResolvedScope {
  const workspaceRoot = path.resolve(opts.workspaceRoot);
  const file = readSettingsOverrides(workspaceRoot);

  const userId =
    opts.userId?.trim() ||
    file.userId?.trim() ||
    process.env.PAW_USER_ID?.trim() ||
    "local";

  const gitRemote = tryGitRemote(workspaceRoot);
  const repositoryId =
    opts.repositoryId?.trim() ||
    file.repositoryId?.trim() ||
    (gitRemote ? `git:${sha16(gitRemote)}` : `ws:${sha16(workspaceRoot)}`);

  const workspaceId =
    opts.workspaceId?.trim() || file.workspaceId?.trim() || repositoryId;

  return { userId, repositoryId, workspaceId, workspaceRoot };
}
