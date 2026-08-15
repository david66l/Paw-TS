import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ManagedJobRegistryV1,
  startManagedShellInWorkspaceV1,
} from "../src/index.js";
import { resolveShellCwd } from "../src/shell/execute.js";

function runtimeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} ${script}`;
}

async function waitForJobOutput(
  registry: ManagedJobRegistryV1,
  ownerId: string,
  jobId: string,
  needle: string,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  while (Date.now() < deadline) {
    output += registry.read(ownerId, jobId).text;
    if (output.includes(needle)) return output;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return output;
}

describe("managed shell producer v1", () => {
  test("streams bounded output through the registry cursor", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-managed-shell-output-"));
    writeFileSync(
      path.join(root, "emit.mjs"),
      "process.stdout.write('x'.repeat(8192)); process.stderr.write('tail-error');\n",
    );
    const registry = new ManagedJobRegistryV1();
    registry.attachController("run-a");
    const id = registry.start({
      ownerId: "run-a",
      kind: "shell",
      label: "emit output",
      outputLimitBytes: 1024,
      run: () =>
        startManagedShellInWorkspaceV1(root, runtimeCommand("emit.mjs"), {
          skipApprovalGate: true,
          outputLimitBytes: 1024,
        }).hooks,
    });

    const settled = await registry.wait("run-a", id, 5_000);
    expect(settled.timedOut).toBe(false);
    expect(settled.snapshot.status).toBe("completed");
    const read = registry.read("run-a", id);
    expect(read.text).toContain("managed output truncated");
    expect(Buffer.byteLength(read.text)).toBeLessThan(1200);
    expect(registry.read("run-a", id).text).toBe("");
    await registry.close();
  });

  test("kill terminates the descendant process tree", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-managed-shell-tree-"));
    writeFileSync(
      path.join(root, "child.mjs"),
      "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync('orphan.txt', 'alive'), 2000); setInterval(() => {}, 1000);\n",
    );
    writeFileSync(
      path.join(root, "parent.mjs"),
      "import { spawn } from 'node:child_process'; spawn(process.execPath, ['child.mjs'], { stdio: 'ignore' }); console.log('child-started'); setInterval(() => {}, 1000);\n",
    );
    const registry = new ManagedJobRegistryV1();
    registry.attachController("run-tree");
    const id = registry.start({
      ownerId: "run-tree",
      kind: "shell",
      label: "tree",
      run: () =>
        startManagedShellInWorkspaceV1(root, runtimeCommand("parent.mjs"), {
          skipApprovalGate: true,
          terminationGraceMs: 100,
        }).hooks,
    });
    expect(
      await waitForJobOutput(registry, "run-tree", id, "child-started"),
    ).toContain("child-started");
    expect(registry.kill("run-tree", id, "test complete")).toBe("requested");
    const settled = await registry.wait("run-tree", id, 5_000);
    expect(settled.snapshot.status).toBe("killed");
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(existsSync(path.join(root, "orphan.txt"))).toBe(false);
    await registry.close();
  });

  test("reuses foreground guard and workspace cwd preflight", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-managed-shell-guard-"));
    expect(() =>
      startManagedShellInWorkspaceV1(root, "rm -rf /", {
        skipApprovalGate: true,
      }),
    ).toThrow();
    expect(() =>
      startManagedShellInWorkspaceV1(root, "echo x", {
        cwd: "../outside",
        skipApprovalGate: true,
      }),
    ).toThrow("escapes workspace");
  });

  test("maps model-facing container cwd through the shared foreground/background preflight", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-managed-shell-cwd-"));
    const sandbox = {
      mode: "workspace" as const,
      network: "deny" as const,
      image: "local-only:test",
      containerWorkspaceRoot: "/testbed",
    };
    expect(resolveShellCwd(root, "/testbed", sandbox)).toEqual({
      cwdPath: path.resolve(root),
    });
    expect(resolveShellCwd(root, "/testbed/pkg", sandbox)).toEqual({
      cwdPath: path.resolve(root, "pkg"),
    });
    expect(resolveShellCwd(root, "/tmp", sandbox).error).toContain(
      "escapes container workspace",
    );
  });
});
