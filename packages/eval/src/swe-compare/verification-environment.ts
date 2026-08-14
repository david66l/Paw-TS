import { spawnSync } from "node:child_process";

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
