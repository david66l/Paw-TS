import path from "node:path";

import { detectContainerRuntime } from "./detect-runtime.js";
import {
  DEFAULT_SANDBOX_IMAGE,
  type ShellSandboxConfig,
  type ShellSandboxNetwork,
} from "./types.js";

export interface DockerShellExecSpec {
  readonly runtime: string;
  readonly args: readonly string[];
  readonly containerCwd: string;
  readonly image: string;
  readonly network: ShellSandboxNetwork;
  readonly mode: "workspace" | "strict";
}

export function hostPathToContainerPath(
  workspaceRoot: string,
  hostPath: string,
): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(hostPath);
  const rel = path.relative(root, target);
  if (!rel || rel === ".") {
    return "/workspace";
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return "/workspace";
  }
  return `/workspace/${rel.split(path.sep).join("/")}`;
}

export function buildDockerShellExecSpec(
  config: ShellSandboxConfig & { mode: "workspace" | "strict" },
  input: {
    readonly workspaceRoot: string;
    readonly cwdPath: string;
    readonly command: string;
  },
): DockerShellExecSpec | { readonly error: string } {
  const runtime = detectContainerRuntime(config.runtime);
  if (!runtime) {
    return {
      error:
        "shell sandbox is enabled but neither docker nor podman is available",
    };
  }

  const workspaceRoot = path.resolve(input.workspaceRoot);
  const containerCwd = hostPathToContainerPath(workspaceRoot, input.cwdPath);
  const image = config.image.trim() || DEFAULT_SANDBOX_IMAGE;
  const memoryMb = config.memoryMb ?? 2048;
  const cpus = config.cpus ?? 2;

  const args: string[] = [
    "run",
    "--rm",
    "-i",
    "-w",
    containerCwd,
    "-v",
    `${workspaceRoot}:/workspace:rw`,
    "--pids-limit",
    "256",
    "--memory",
    `${memoryMb}m`,
    "--cpus",
    String(cpus),
  ];

  if (config.network === "deny") {
    args.push("--network", "none");
  }

  if (config.mode === "strict") {
    args.push(
      "--read-only",
      "--tmpfs",
      "/tmp:exec,nosuid,size=512m",
    );
  }

  args.push(image, "sh", "-lc", input.command);

  return {
    runtime,
    args,
    containerCwd,
    image,
    network: config.network,
    mode: config.mode,
  };
}
