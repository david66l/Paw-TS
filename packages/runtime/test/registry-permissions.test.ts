import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { OFF_SHELL_SANDBOX } from "@paw/harness";

import {
  FrozenPermissionEngineV1,
  type RuntimeToolCallV1,
  createCodeIntelligenceToolPluginV1,
  createFrozenToolRegistryV1,
  createWorkspaceInspectionToolPluginV1,
  createWorkspaceInspectionToolPluginV2,
  createWorkspaceMutationToolPluginV1,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next frozen tool registry", () => {
  test("installs workspace inspection tools only through an explicit plugin", () => {
    const base = createFrozenToolRegistryV1();
    const plugin = createWorkspaceInspectionToolPluginV1();
    const installed = createFrozenToolRegistryV1({ plugins: [plugin] });
    const rebuilt = createFrozenToolRegistryV1({
      plugins: [createWorkspaceInspectionToolPluginV1()],
    });

    expect(base.resolveProviderName("workspace_list_dir")).toBeUndefined();
    expect(installed.plugins).toEqual([
      {
        pluginId: "paw.workspace-inspection",
        pluginVersion: "paw.workspace-inspection.v1",
      },
    ]);
    expect(
      installed.entries
        .filter((entry) => entry.pluginId === "paw.workspace-inspection")
        .map((entry) => entry.internalName),
    ).toEqual([
      "workspace.git_diff",
      "workspace.git_status",
      "workspace.glob",
      "workspace.list_dir",
      "workspace.search",
    ]);
    expect(installed.registryHash).not.toBe(base.registryHash);
    expect(installed.registryHash).toBe(rebuilt.registryHash);
    expect(() =>
      createFrozenToolRegistryV1({ plugins: [plugin, plugin] }),
    ).toThrow("Duplicate runtime tool plugin");
  });

  test("plugin tools use read permissions and workspace-scoped resources", () => {
    const root = workspace();
    const registry = createFrozenToolRegistryV1({
      plugins: [createWorkspaceInspectionToolPluginV1()],
    });
    for (const [name, args] of [
      ["workspace_list_dir", { path: "." }],
      ["workspace_search", { path: ".", pattern: "needle" }],
      ["workspace_glob", { path: ".", pattern: "**/*.ts" }],
      ["workspace_git_status", {}],
      ["workspace_git_diff", {}],
    ] as const) {
      const result = registry.validateAndClassify(call(name, name, args), root);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.classification).toMatchObject({
          effectClass: "read",
          permissionCategory: "read",
          concurrencyMode: "parallel",
        });
        expect(result.value.entry.pluginId).toBe("paw.workspace-inspection");
      }
    }
    const escaped = registry.validateAndClassify(
      call("escaped", "workspace_search", {
        path: "../outside",
        pattern: "needle",
      }),
      root,
    );
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) {
      expect(escaped.result.payload).toMatchObject({
        code: "E_TOOL_CLASSIFICATION",
        executed: false,
      });
    }
  });

  test("classifies phase-one and code-intelligence plugins before execution", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.ts"), "export const before = 1;\n");
    const registry = createFrozenToolRegistryV1({
      plugins: [
        createWorkspaceInspectionToolPluginV2(),
        createWorkspaceMutationToolPluginV1(),
        createCodeIntelligenceToolPluginV1(),
      ],
    });
    const patch =
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const before = 1;\n+export const after = 1;\n";
    const cases = [
      ["workspace_git_log", { max_count: 10 }, "read", "parallel"],
      ["workspace_symbol_search", { query: "after" }, "read", "parallel"],
      [
        "workspace_lsp",
        { file: "a.ts", method: "hover", line: 0, character: 0 },
        "read",
        "exclusive",
      ],
      ["workspace_apply_patch", { patch }, "write", "exclusive"],
    ] as const;
    for (const [name, args, permissionCategory, concurrencyMode] of cases) {
      const result = registry.validateAndClassify(call(name, name, args), root);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.classification).toMatchObject({
          permissionCategory,
          concurrencyMode,
        });
      }
    }

    for (const [name, args] of [
      ["workspace_git_log", { max_count: 101 }],
      ["workspace_symbol_search", { query: "x", max_results: 0 }],
      ["workspace_lsp", { file: "../outside.ts" }],
      [
        "workspace_apply_patch",
        {
          patch:
            "--- a/../outside.ts\n+++ b/../outside.ts\n@@ -1 +1 @@\n-a\n+b\n",
        },
      ],
    ] as const) {
      const result = registry.validateAndClassify(call(name, name, args), root);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.result.payload).toMatchObject({
          code: "E_TOOL_CLASSIFICATION",
          executed: false,
        });
      }
    }
  });

  test("has stable ordering, provider names, and a repeatable inventory hash", () => {
    const first = createFrozenToolRegistryV1();
    const second = createFrozenToolRegistryV1();

    expect(first.entries.map((entry) => entry.internalName)).toEqual([
      "workspace.edit_file",
      "workspace.job_kill",
      "workspace.job_list",
      "workspace.job_read",
      "workspace.job_start",
      "workspace.job_wait",
      "workspace.read_file",
      "workspace.run_shell",
      "workspace.write_file",
    ]);
    expect(first.entries.map((entry) => entry.providerName)).toEqual([
      "workspace_edit_file",
      "workspace_job_kill",
      "workspace_job_list",
      "workspace_job_read",
      "workspace_job_start",
      "workspace_job_wait",
      "workspace_read_file",
      "workspace_run_shell",
      "workspace_write_file",
    ]);
    expect(first.registryHash).toBe(second.registryHash);
    expect(first.registryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("deep-freezes the exact provider schema covered by the registry hash", () => {
    const registry = createFrozenToolRegistryV1();
    const definition = registry.definitions[0] as unknown as {
      function: {
        description: string;
        parameters: {
          required: string[];
          properties: Record<string, unknown>;
        };
      };
    };
    const before = structuredClone(definition);

    expect(Reflect.set(definition.function, "description", "tampered")).toBe(
      false,
    );
    expect(
      Reflect.set(definition.function.parameters.properties, "evil", {
        type: "string",
      }),
    ).toBe(false);
    expect(() =>
      definition.function.parameters.required.push("evil"),
    ).toThrow();
    expect(definition).toEqual(before);

    const rebuilt = createFrozenToolRegistryV1();
    expect(rebuilt.registryHash).toBe(registry.registryHash);
    expect(rebuilt.definitions).toEqual(registry.definitions);
  });

  test("resolves provider names, validates before classify, and normalizes scopes", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.txt"), "before");
    const registry = createFrozenToolRegistryV1();

    const read = registry.validateAndClassify(
      call("read-1", "workspace_read_file", { path: "x/../a.txt" }),
      root,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.internalName).toBe("workspace.read_file");
    expect(read.value.classification).toMatchObject({
      effectClass: "read",
      permissionCategory: "read",
      concurrencyMode: "parallel",
    });
    expect(read.value.classification.resources[0]?.key).toBe(
      canonical(path.join(root, "a.txt")),
    );

    const bad = registry.validateAndClassify(
      call("edit-1", "workspace_edit_file", { path: "a.txt" }),
      root,
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.result.ok).toBe(false);
    expect(bad.result.payload).toMatchObject({
      error_code: "E_SCHEMA_INVALID",
    });

    const unknown = registry.validateAndClassify(
      call("ghost", "workspace_unknown", {}),
      root,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.result.payload).toMatchObject({ code: "E_TOOL_UNKNOWN" });
    }
  });

  test("rejects escaped and sensitive paths before permission or execution", () => {
    const root = workspace();
    const registry = createFrozenToolRegistryV1();
    for (const target of ["../outside.txt", ".paw/secret.txt"]) {
      const result = registry.validateAndClassify(
        call("read", "workspace_read_file", { path: target }),
        root,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.result.payload).toMatchObject({
          code: "E_TOOL_CLASSIFICATION",
          executed: false,
        });
      }
    }
  });

  test("enforces frozen child path and shell boundaries before permission", () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export {};");
    fs.writeFileSync(path.join(root, "test", "a.test.ts"), "export {};");
    const registry = createFrozenToolRegistryV1({
      pathPolicy: {
        readRoots: ["src"],
        writeRoots: [],
      },
      shellBoundary: "verification",
    });

    expect(
      registry.validateAndClassify(
        call("read-ok", "workspace_read_file", { path: "src/a.ts" }),
        root,
      ).ok,
    ).toBe(true);
    expect(
      registry.validateAndClassify(
        call("read-out", "workspace_read_file", { path: "test/a.test.ts" }),
        root,
      ).ok,
    ).toBe(false);
    expect(
      registry.validateAndClassify(
        call("write-denied", "workspace_write_file", {
          path: "src/a.ts",
          content: "changed",
        }),
        root,
      ).ok,
    ).toBe(false);
    expect(
      registry.validateAndClassify(
        call("shell-read", "workspace_run_shell", { command: "rg needle src" }),
        root,
      ).ok,
    ).toBe(true);
    expect(
      registry.validateAndClassify(
        call("shell-test", "workspace_run_shell", { command: "npm test" }),
        root,
      ).ok,
    ).toBe(true);
    expect(
      registry.validateAndClassify(
        call("shell-write", "workspace_run_shell", {
          command: "echo changed > src/a.ts",
        }),
        root,
      ).ok,
    ).toBe(false);
    expect(registry.registryHash).not.toBe(
      createFrozenToolRegistryV1().registryHash,
    );
  });

  test("classifies managed job operations through the shared shell policy", () => {
    const root = workspace();
    const registry = createFrozenToolRegistryV1();
    const start = registry.validateAndClassify(
      call("start", "workspace_job_start", { command: "npm run dev" }),
      root,
    );
    expect(start.ok).toBe(true);
    if (start.ok) {
      expect(start.value.classification).toMatchObject({
        permissionCategory: "shell",
        concurrencyMode: "exclusive",
      });
    }
    const read = registry.validateAndClassify(
      call("read", "workspace_job_read", { id: "shell-1" }),
      root,
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.classification).toMatchObject({
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "parallel",
      });
    }
  });

  test("binds the frozen visible sandbox to the real execution context", () => {
    const registry = createFrozenToolRegistryV1({
      shellSandbox: OFF_SHELL_SANDBOX,
    });
    expect(() => registry.assertCompatibleShellSandbox(undefined)).toThrow(
      "does not match",
    );
    expect(() =>
      registry.assertCompatibleShellSandbox(OFF_SHELL_SANDBOX),
    ).not.toThrow();
    expect(registry.registryHash).toBe(
      createFrozenToolRegistryV1({ shellSandbox: OFF_SHELL_SANDBOX })
        .registryHash,
    );
  });
});

describe("Paw Next frozen permission engine", () => {
  test("rejects malformed runtime policy values instead of trusting TypeScript", () => {
    for (const config of [
      { policyVersion: "bad", defaultAction: "allow", rules: [] },
      {
        policyVersion: "bad",
        defaultAction: "deny",
        rules: [
          { id: "bad", layer: "user", category: "read", action: "permit" },
        ],
      },
      {
        policyVersion: "bad",
        defaultAction: "deny",
        rules: [
          { id: "bad", layer: "user", category: "network", action: "deny" },
        ],
      },
    ]) {
      expect(() => new FrozenPermissionEngineV1(config as never)).toThrow();
    }
  });

  test("rejects ambiguous rules instead of letting array order decide authority", () => {
    expect(
      () =>
        new FrozenPermissionEngineV1({
          policyVersion: "ambiguous-v1",
          defaultAction: "deny",
          rules: [
            { id: "first", layer: "user", category: "write", action: "allow" },
            { id: "second", layer: "user", category: "write", action: "deny" },
          ],
        }),
    ).toThrow("Ambiguous permission rules");
  });

  test("hard and administrator denials cannot be reversed by user allow", async () => {
    const value = validatedEdit(workspace());
    for (const layer of ["hard", "admin"] as const) {
      const engine = new FrozenPermissionEngineV1({
        policyVersion: `policy-${layer}`,
        defaultAction: "ask",
        rules: [
          { id: `${layer}-deny`, layer, category: "write", action: "deny" },
          {
            id: "user-allow",
            layer: "user",
            category: "write",
            action: "allow",
          },
        ],
      });
      let prompts = 0;
      const result = await engine.resolve(
        value,
        async () => {
          prompts += 1;
          return { decision: "allow_once" };
        },
        new AbortController().signal,
      );
      expect(result.resolution).toBe("deny");
      expect(result.ruleId).toBe(`${layer}-deny`);
      expect(prompts).toBe(0);
    }
  });

  test("ask without a channel denies, while allow_rule is reused only for the run", async () => {
    const value = validatedEdit(workspace());
    const config = {
      policyVersion: "permission-v1",
      defaultAction: "ask" as const,
      rules: [] as const,
    };
    const noChannel = new FrozenPermissionEngineV1(config);
    expect(
      (await noChannel.resolve(value, undefined, new AbortController().signal))
        .resolution,
    ).toBe("deny");

    const engine = new FrozenPermissionEngineV1(config);
    let prompts = 0;
    const first = await engine.resolve(
      value,
      async () => {
        prompts += 1;
        return { decision: "allow_rule" };
      },
      new AbortController().signal,
    );
    engine.commitRecordedResolution(value, first);
    const second = await engine.resolve(
      { ...value, call: { ...value.call, id: "edit-2" } },
      async () => {
        prompts += 1;
        return { decision: "deny" };
      },
      new AbortController().signal,
    );
    expect(first).toMatchObject({
      resolution: "allow_rule",
      source: "user_prompt",
    });
    expect(second).toMatchObject({
      resolution: "allow_rule",
      source: "run_rule",
      ruleId: first.ruleId,
    });
    expect(prompts).toBe(1);

    const nextRun = new FrozenPermissionEngineV1(config);
    expect(
      (await nextRun.resolve(value, undefined, new AbortController().signal))
        .resolution,
    ).toBe("deny");
  });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-runtime-registry-"));
  roots.push(root);
  return root;
}

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
): RuntimeToolCallV1 {
  return { id, name, arguments: args, argumentsValid: true };
}

function validatedEdit(root: string) {
  const registry = createFrozenToolRegistryV1();
  const result = registry.validateAndClassify(
    call("edit-1", "workspace_edit_file", {
      path: "a.txt",
      old_string: "before",
      new_string: "after",
    }),
    root,
  );
  if (!result.ok) throw new Error("fixture failed validation");
  return result.value;
}

function canonical(input: string): string {
  const value = path.normalize(fs.realpathSync(input));
  return process.platform === "win32" ? value.toLowerCase() : value;
}
