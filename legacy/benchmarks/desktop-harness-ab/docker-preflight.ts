import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShellInWorkspaceStreaming } from "../../packages/harness/src/shell/execute.js";
import type { ShellSandboxConfig } from "../../packages/harness/src/sandbox/types.js";

export const benchmarkSandbox = {
  mode: "strict",
  network: "deny",
  runtime: "docker",
  image: "node:24-alpine",
  memory_mb: 1024,
  cpus: 2,
  container_workspace_root: "/workspace",
  command_shell: "sh",
  pull_policy: "never",
} as const;

export const benchmarkShellConfig: ShellSandboxConfig = {
  mode: "strict",
  network: "deny",
  runtime: "docker",
  image: benchmarkSandbox.image,
  memoryMb: 1024,
  cpus: 2,
  containerWorkspaceRoot: "/workspace",
  commandShell: "sh",
  pullPolicy: "never",
};

// Fixed probes only. The same production shell backend is used by the desktop.
export async function verifyDockerIsolation(image = benchmarkSandbox.image as string) {
  const selectedShell = { ...benchmarkShellConfig, image };
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "paw-docker-preflight-"),
  );
  const root = path.join(parent, "workspace");
  fs.mkdirSync(root);
  const sentinel = path.join(parent, "host-sentinel.txt");
  fs.writeFileSync(sentinel, "HOST_UNCHANGED\n");
  fs.writeFileSync(
    path.join(root, "probe.cjs"),
    `
const fs = require('node:fs'); const assert = require('node:assert/strict');
assert.equal(process.platform, 'linux');
assert.equal(process.cwd(), '/workspace');
assert.equal(fs.existsSync('/var/run/docker.sock'), false);
assert.equal(fs.existsSync(${JSON.stringify(sentinel)}), false);
assert.equal(fs.existsSync('../host-sentinel.txt'), false);
assert.throws(() => fs.writeFileSync('/host-sentinel.txt', 'changed'));
fs.symlinkSync('/host-sentinel.txt', 'escape-link');
try { assert.throws(() => fs.writeFileSync('escape-link', 'changed')); }
finally { fs.unlinkSync('escape-link'); }
process.chdir('/tmp'); fs.writeFileSync('ephemeral.txt', 'container only');
fs.writeFileSync('/workspace/ok.txt', 'ISOLATED_OK');
console.log('ISOLATED_OK');
`,
  );
  const result = await runShellInWorkspaceStreaming(root, "node probe.cjs", {
    shellSandbox: selectedShell,
    skipApprovalGate: true,
    timeoutMs: 30000,
  });
  assert.equal(result.exit_code, 0, JSON.stringify(result));
  assert.equal(result.sandbox?.mode, "strict");
  assert.equal(
    fs.readFileSync(path.join(root, "ok.txt"), "utf8"),
    "ISOLATED_OK",
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "HOST_UNCHANGED\n");

  const unavailable = await runShellInWorkspaceStreaming(
    root,
    "node probe.cjs",
    {
      shellSandbox: {
        ...selectedShell,
        image: "paw-benchmark-missing:never",
      },
      skipApprovalGate: true,
      timeoutMs: 15000,
    },
  );
  assert.equal(
    unavailable.exit_code,
    125,
    "Missing image must not fall back to host",
  );
  assert.equal(unavailable.sandbox?.mode, "strict");
  const timeout = await runShellInWorkspaceStreaming(root, "sleep 30", {
    shellSandbox: selectedShell,
    skipApprovalGate: true,
    timeoutMs: 1000,
  });
  assert.equal(timeout.timed_out, true);
  assert.ok(timeout.sandbox?.containerName);
  const remaining = spawnSync(
    "docker",
    ["ps", "-aq", "--filter", `name=${timeout.sandbox?.containerName}`],
    { encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  assert.equal(remaining.status, 0, remaining.stderr);
  assert.equal(
    remaining.stdout.trim(),
    "",
    "Timed out container must be removed",
  );
  const info = spawnSync(
    "docker",
    ["image", "inspect", image, "--format", "{{.Id}}"],
    { encoding: "utf8", timeout: 10000, windowsHide: true },
  );
  assert.equal(info.status, 0, info.stderr);
  return {
    ok: true,
    root,
    sentinel,
    imageId: info.stdout.trim(),
    checks: [
      "production shell container execution",
      "workspace writable",
      "host sibling invisible and unchanged",
      "root read-only",
      "symlink escape blocked",
      "temporary files container-local",
      "no Docker socket mount",
      "missing image fails closed",
      "timeout removes container",
    ],
    sandbox: { ...benchmarkSandbox, image },
  };
}

if (import.meta.main)
  console.log(JSON.stringify(await verifyDockerIsolation(), null, 2));
