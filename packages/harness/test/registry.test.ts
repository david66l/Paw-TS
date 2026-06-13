import { describe, expect, test } from "bun:test";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AutoMemoryStore } from "@paw/core";
import { executeTool, toolRequiresApproval } from "../src/registry.js";

describe("executeTool", () => {
  test("workspace.read_file reads a relative file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-"));
    writeFileSync(path.join(root, "x.txt"), "hello");
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.read_file",
      {
        path: "x.txt",
      },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("x.txt");
    expect(JSON.stringify(r.payload)).toContain("hello");
  });

  test("workspace.read_file rejects missing path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-"));
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.read_file",
      {},
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.payload)).toContain("E_SCHEMA_INVALID");
    expect(r.summary).toContain("missing required field: path");
  });

  test("workspace.read_file missing file returns E_USER", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-"));
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.read_file",
      {
        path: "missing.txt",
      },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.payload)).toContain("E_USER");
  });

  test("workspace.read_file rejects wrong arg type before execution", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-"));
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.read_file",
      {
        path: 123,
      },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.payload)).toContain("E_SCHEMA_INVALID");
    expect(r.summary).toContain("field path must be string");
  });

  test("workspace.write_file creates file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-w-"));
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.write_file",
      {
        path: "w.txt",
        content: "ok",
      },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("write_file");
  });

  test("toolRequiresApproval is true for write_file", () => {
    expect(toolRequiresApproval("workspace.write_file")).toBe(true);
    expect(toolRequiresApproval("workspace.run_shell")).toBe(true);
    expect(toolRequiresApproval("workspace.read_file")).toBe(false);
    expect(toolRequiresApproval("workspace.search")).toBe(false);
    expect(toolRequiresApproval("workspace.brief")).toBe(false);
    expect(toolRequiresApproval("workspace.git_status")).toBe(false);
    expect(toolRequiresApproval("workspace.symbol_search")).toBe(false);
  });

  test("toolRequiresApproval for shell considers command content", () => {
    // Read-only shell commands skip approval
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, {
        command: "ls -la",
      }),
    ).toBe(false);
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, {
        command: "cat file.txt",
      }),
    ).toBe(false);
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, {
        command: "grep foo *.ts",
      }),
    ).toBe(false);
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, {
        command: "find . -name '*.js'",
      }),
    ).toBe(false);
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, {
        command: "pwd && env",
      }),
    ).toBe(false);
    // Mutating shell commands require approval
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, {
        command: "rm file.txt",
      }),
    ).toBe(true);
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, {
        command: "git push",
      }),
    ).toBe(true);
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, {
        command: "npm install",
      }),
    ).toBe(true);
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, {
        command: "mkdir dir && cd dir",
      }),
    ).toBe(true);
    // Without args, defaults to requiring approval
    expect(toolRequiresApproval("workspace.run_shell")).toBe(true);
    expect(toolRequiresApproval("workspace.run_shell", undefined, {})).toBe(
      true,
    );
    expect(
      toolRequiresApproval("workspace.run_shell", undefined, { command: "" }),
    ).toBe(true);
  });

  test("workspace.run_shell runs echo", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-sh-"));
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.run_shell",
      {
        command: "echo paw-shell-ok",
      },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("exit");
    expect(JSON.stringify(r.payload)).toContain("paw-shell-ok");
  });

  test("workspace.run_shell policy rejection returns E_POLICY_DENIED", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-sh-"));
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.run_shell",
      {
        command: "rm -rf /",
      },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.payload)).toContain("E_POLICY_DENIED");
  });

  test("workspace.search finds matches", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-search-"));
    writeFileSync(path.join(root, "x.txt"), "alpha\nbeta\n", "utf8");
    const r = await executeTool({ workspaceRoot: root }, "workspace.search", {
      pattern: "beta",
      path: ".",
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("match");
  });

  test("workspace.edit_file replaces unique match", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-edit-"));
    writeFileSync(path.join(root, "x.txt"), "hello world\n", "utf8");
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.edit_file",
      { path: "x.txt", old_string: "world", new_string: "paw" },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("edit_file");
    const content = fs.readFileSync(path.join(root, "x.txt"), "utf8");
    expect(content).toBe("hello paw\n");
  });

  test("workspace.edit_file rejects missing old_string", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-edit-"));
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.edit_file",
      { path: "x.txt", new_string: "x" },
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("E_SCHEMA_INVALID");
    expect(r.summary).toContain("old_string");
  });

  test("workspace.edit_file rejects ambiguous match", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-edit-"));
    writeFileSync(path.join(root, "x.txt"), "dup dup\n", "utf8");
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.edit_file",
      { path: "x.txt", old_string: "dup", new_string: "x" },
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("appears 2 times");
  });
});

describe("executeTool streaming", () => {
  test("workspace.run_shell with onShellChunk streams chunks", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-chunk-"));
    const chunks: { tool: string; chunk: string; isStderr: boolean }[] = [];
    const r = await executeTool(
      {
        workspaceRoot: root,
        onShellChunk: (tool, chunk, isStderr) => {
          chunks.push({ tool, chunk, isStderr });
        },
      },
      "workspace.run_shell",
      { command: "echo registry-chunk" },
    );
    expect(r.ok).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(
      chunks.some((c) => !c.isStderr && c.chunk.includes("registry-chunk")),
    ).toBe(true);
    expect(chunks.every((c) => c.tool === "workspace.run_shell")).toBe(true);
  });

  test("workspace.run_shell without onShellChunk still works", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-nochunk-"));
    const r = await executeTool(
      { workspaceRoot: root },
      "workspace.run_shell",
      { command: "echo no-chunk" },
    );
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r.payload)).toContain("no-chunk");
  });

  test("memory.list and memory.read access project memory store", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-mem-"));
    const store = new AutoMemoryStore({ workspaceRoot: root });
    store.save({
      name: "test_pref",
      description: "User prefers concise replies",
      type: "user",
      content: "Keep answers short.",
    });

    const listed = await executeTool(
      { workspaceRoot: root },
      "memory.list",
      {},
    );
    expect(listed.ok).toBe(true);
    expect(listed.summary).toContain("1 entr");
    expect(JSON.stringify(listed.payload)).toContain("test_pref");

    const read = await executeTool({ workspaceRoot: root }, "memory.read", {
      name: "test_pref",
    });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read.payload)).toContain("Keep answers short");

    const missing = await executeTool({ workspaceRoot: root }, "memory.read", {
      name: "nope",
    });
    expect(missing.ok).toBe(false);
  });

  test("memory tools skip approval", () => {
    expect(toolRequiresApproval("memory.list")).toBe(false);
    expect(toolRequiresApproval("memory.read")).toBe(false);
  });
});
