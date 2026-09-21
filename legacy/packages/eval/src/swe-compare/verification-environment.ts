import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ShellSandboxConfig } from "@paw/harness";

import type { SweCompareManifest } from "./types.js";

export function swebenchInstanceImageName(instanceId: string): string {
  if (!/^[a-zA-Z0-9_.-]+__[a-zA-Z0-9_.-]+$/.test(instanceId)) {
    throw new Error(`invalid SWE-bench instance id: ${instanceId}`);
  }
  const remoteId = instanceId.toLowerCase().replaceAll("__", "_1776_");
  return `swebench/sweb.eval.x86_64.${remoteId}:latest`;
}

export function pawInstanceImageSandbox(
  instanceId: string,
): ShellSandboxConfig {
  return {
    mode: "workspace",
    network: "deny",
    runtime: "docker",
    image: swebenchInstanceImageName(instanceId),
    memoryMb: 8192,
    cpus: 4,
    containerWorkspaceRoot: "/testbed",
    commandShell: "bash",
    pullPolicy: "never",
  };
}

function localDockerImageExists(image: string): boolean {
  const result = spawnSync("docker", ["image", "inspect", image], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  return result.status === 0;
}

export function assertPawVerificationEnvironmentReady(
  manifest: SweCompareManifest,
  instanceId: string,
  imageExists: (image: string) => boolean = localDockerImageExists,
): ShellSandboxConfig | undefined {
  if (manifest.runners.paw.verificationEnvironment !== "instance_image") {
    return undefined;
  }
  const sandbox = pawInstanceImageSandbox(instanceId);
  if (!imageExists(sandbox.image)) {
    throw new Error(
      `Paw instance image is not available locally: ${sandbox.image}; run no-model preflight with instance caching before qualification`,
    );
  }
  return sandbox;
}

function gitRun(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `seed git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr?.trim() ?? "unknown error"}`,
    );
  }
}

/**
 * Merge the instance image's /testbed content into the isolated workspace.
 *
 * The official SWE-bench images carry build-time generated files (editable
 * install artifacts such as src/_pytest/_version.py, compiled extensions)
 * that a fresh git checkout does not contain. Without them the task's test
 * runner may fail to import at all, making authoritative verification
 * environmentally impossible (observed in paw-pytest-dev__pytest-7521:
 * 40+ turns of ModuleNotFoundError before budget exhaustion).
 *
 * Copy everything except .git, then restore tracked files to the isolated
 * base checkout (the image's HEAD may sit one SWE-bench eval commit above
 * base) and drop untracked non-ignored strays; ignored generated files
 * survive, so the agent starts from the same runnable environment the
 * official verifier uses.
 */
/**
 * Pure caches regenerate automatically whenever code executes; seeding them
 * only pollutes the untracked baseline (Claude/pytest recompiling .pyc then
 * reads as "untracked baseline mutation", observed on sklearn-25102). Keep
 * the meaningful artifacts: editable-install version modules, compiled
 * extensions, .eggs.
 */
function isPureCachePath(file: string): boolean {
  const parts = file.replace(/\\/g, "/").toLowerCase().split("/");
  return parts.some((part) =>
    ["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"].includes(
      part,
    ),
  );
}

function copySeedTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copySeedTree(src, dst);
    } else if (entry.isFile() && !isPureCachePath(src)) {
      fs.copyFileSync(src, dst);
    }
  }
}

export function mergeInstanceGeneratedFiles(
  stagingRoot: string,
  workspaceRoot: string,
): void {
  copySeedTree(stagingRoot, workspaceRoot);
  gitRun(workspaceRoot, ["reset", "--hard", "HEAD"]);
  gitRun(workspaceRoot, ["clean", "-fd"]);
}

/** Seed a fresh benchmark workspace from the frozen instance image. */
export function seedWorkspaceFromInstanceImage(opts: {
  readonly image: string;
  readonly workspaceRoot: string;
  readonly label: string;
}): void {
  if (!localDockerImageExists(opts.image)) return;
  const staging = fs.mkdtempSync(
    path.join(os.tmpdir(), `paw-swe-seed-${opts.label}-`),
  );
  try {
    // 用 tar -h（解引用符号链接）在容器内打包并经卷挂载直接落盘，而不是
    // docker cp：Windows 客户端创建 symlink 需要特权，django 镜像 docs 主题
    // 内的相对链接会让 docker cp 直接失败；而宿主侧 spawnSync 的 stdout
    // 缓冲也有上限（Bun 不支持 fd 直写）。卷挂载两条都绕开。-h 把链接
    // 物化为普通文件，对 seeding 语义无损（tracked 状态随后重置）。
    const staged = path.join(staging, "testbed");
    fs.mkdirSync(staged, { recursive: true });
    const tarPath = path.join(staging, "testbed.tar");
    const mountSource = staging.replaceAll("\\", "/");
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${mountSource}:/paw-seed`,
        "--entrypoint",
        "tar",
        opts.image,
        "-c",
        "-h",
        "-f",
        "/paw-seed/testbed.tar",
        "--exclude=./.git",
        "-C",
        "/testbed",
        ".",
      ],
      { encoding: "utf8", timeout: 600_000, windowsHide: true },
    );
    if (run.status !== 0 || run.error) {
      throw new Error(
        `seed tar extraction failed: ${run.error?.message ?? run.stderr?.trim() ?? "unknown error"}`,
      );
    }
    const extract = spawnSync(
      "tar",
      // 相对路径 + cwd：GNU tar 会把 `C:\...` 当远程主机语法
      ["-xf", "testbed.tar", "-C", "testbed"],
      { cwd: staging, encoding: "utf8", timeout: 600_000, windowsHide: true },
    );
    fs.rmSync(tarPath, { force: true });
    if (extract.status !== 0 || extract.error) {
      throw new Error(
        `seed tar unpack failed: ${extract.error?.message ?? extract.stderr?.trim() ?? "unknown error"}`,
      );
    }
    if (!fs.existsSync(staged)) {
      throw new Error(`instance image has no /testbed to seed: ${opts.image}`);
    }
    mergeInstanceGeneratedFiles(staged, opts.workspaceRoot);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
