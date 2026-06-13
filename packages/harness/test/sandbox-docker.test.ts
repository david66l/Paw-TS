import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildDockerShellExecSpec,
  detectContainerRuntime,
  hostPathToContainerPath,
} from "../src/sandbox/index.js";

describe("hostPathToContainerPath", () => {
  const root = path.resolve("/tmp/paw-workspace");

  test("maps workspace root to /workspace", () => {
    expect(hostPathToContainerPath(root, root)).toBe("/workspace");
  });

  test("maps nested paths under /workspace", () => {
    expect(hostPathToContainerPath(root, path.join(root, "src", "app.ts"))).toBe(
      "/workspace/src/app.ts",
    );
  });

  test("falls back to /workspace for paths outside root", () => {
    expect(hostPathToContainerPath(root, "/etc/passwd")).toBe("/workspace");
  });
});

describe("buildDockerShellExecSpec", () => {
  test("builds strict sandbox args when runtime exists", () => {
    const runtime = detectContainerRuntime("docker");
    if (!runtime) {
      return;
    }

    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-sandbox-"));
    mkdirSync(path.join(workspaceRoot, "pkg"));
    const spec = buildDockerShellExecSpec(
      {
        mode: "strict",
        network: "deny",
        image: "debian:bookworm-slim",
        memoryMb: 1024,
        cpus: 1,
      },
      {
        workspaceRoot,
        cwdPath: path.join(workspaceRoot, "pkg"),
        command: "pwd",
      },
    );

    expect("runtime" in spec).toBe(true);
    if (!("runtime" in spec)) {
      return;
    }

    expect(spec.runtime).toBe(runtime);
    expect(spec.containerCwd).toBe("/workspace/pkg");
    expect(spec.args).toContain("--network");
    expect(spec.args).toContain("none");
    expect(spec.args).toContain("--read-only");
    expect(spec.args.some((a) => a.startsWith("--tmpfs"))).toBe(true);
    expect(spec.args.at(-3)).toBe("debian:bookworm-slim");
    expect(spec.args.at(-1)).toBe("pwd");
  });
});
