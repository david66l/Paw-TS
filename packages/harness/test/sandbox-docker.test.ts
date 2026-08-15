import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildDockerShellExecSpec,
  containerPathToHostPath,
  detectContainerRuntime,
  hostPathToContainerPath,
} from "../src/sandbox/index.js";

describe("hostPathToContainerPath", () => {
  const root = path.resolve("/tmp/paw-workspace");

  test("maps workspace root to /workspace", () => {
    expect(hostPathToContainerPath(root, root)).toBe("/workspace");
  });

  test("maps nested paths under /workspace", () => {
    expect(
      hostPathToContainerPath(root, path.join(root, "src", "app.ts")),
    ).toBe("/workspace/src/app.ts");
  });

  test("maps a trusted instance-image workspace to /testbed", () => {
    expect(
      hostPathToContainerPath(
        root,
        path.join(root, "src", "app.ts"),
        "/testbed",
      ),
    ).toBe("/testbed/src/app.ts");
  });

  test("falls back to /workspace for paths outside root", () => {
    expect(hostPathToContainerPath(root, "/etc/passwd")).toBe("/workspace");
  });
});

describe("containerPathToHostPath", () => {
  const root = path.resolve("C:/paw/workspace");

  test("maps the configured container root and descendants to the host workspace", () => {
    expect(containerPathToHostPath(root, "/testbed", "/testbed")).toBe(root);
    expect(
      containerPathToHostPath(root, "/testbed/pkg/tests", "/testbed"),
    ).toBe(path.join(root, "pkg", "tests"));
  });

  test("rejects absolute container paths outside the mounted workspace", () => {
    expect(containerPathToHostPath(root, "/tmp", "/testbed")).toBeUndefined();
    expect(
      containerPathToHostPath(root, "/testbed/../etc", "/testbed"),
    ).toBeUndefined();
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
        containerWorkspaceRoot: "/testbed",
        commandShell: "bash",
        pullPolicy: "never",
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
    expect(spec.containerCwd).toBe("/testbed/pkg");
    expect(spec.args).toContain("--network");
    expect(spec.args).toContain("none");
    expect(spec.args).toContain("--read-only");
    expect(spec.containerName).toStartWith("paw-shell-");
    expect(spec.args).toContain(spec.containerName);
    expect(spec.args).toContain("--pull");
    expect(spec.args).toContain("never");
    expect(spec.args.some((a) => a.startsWith("--tmpfs"))).toBe(true);
    expect(spec.args.at(-4)).toBe("debian:bookworm-slim");
    expect(spec.args.at(-3)).toBe("bash");
    expect(spec.args.at(-1)).toBe("pwd");
  });

  test("rejects an unsafe container workspace root", () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-sandbox-"));
    const spec = buildDockerShellExecSpec(
      {
        mode: "workspace",
        network: "deny",
        image: "local-only:test",
        containerWorkspaceRoot: "/",
      },
      { workspaceRoot, cwdPath: workspaceRoot, command: "pwd" },
    );
    expect(spec).toEqual({ error: 'invalid container workspace root: "/"' });
  });
});
