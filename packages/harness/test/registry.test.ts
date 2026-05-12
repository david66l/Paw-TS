import { describe, expect, test } from "bun:test";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeTool, toolRequiresApproval } from "../src/registry.js";

describe("executeTool", () => {
  test("workspace.read_file reads a relative file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-"));
    writeFileSync(path.join(root, "x.txt"), "hello");
    const r = await executeTool({ workspaceRoot: root }, "workspace.read_file", {
      path: "x.txt",
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("x.txt");
    expect(JSON.stringify(r.payload)).toContain("hello");
  });

  test("workspace.read_file rejects missing path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-"));
    const r = await executeTool({ workspaceRoot: root }, "workspace.read_file", {});
    expect(r.ok).toBe(false);
  });

  test("workspace.write_file creates file", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-w-"));
    const r = await executeTool({ workspaceRoot: root }, "workspace.write_file", {
      path: "w.txt",
      content: "ok",
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("write_file");
  });

  test("toolRequiresApproval is true for write_file", () => {
    expect(toolRequiresApproval("workspace.write_file")).toBe(true);
    expect(toolRequiresApproval("workspace.run_shell")).toBe(true);
    expect(toolRequiresApproval("workspace.read_file")).toBe(false);
    expect(toolRequiresApproval("workspace.search")).toBe(false);
  });

  test("toolRequiresApproval for shell considers command content", () => {
    // Read-only shell commands skip approval
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "ls -la" })).toBe(false);
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "cat file.txt" })).toBe(false);
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "grep foo *.ts" })).toBe(false);
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "find . -name '*.js'" })).toBe(false);
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "pwd && env" })).toBe(false);
    // Mutating shell commands require approval
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "rm file.txt" })).toBe(true);
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "git push" })).toBe(true);
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "npm install" })).toBe(true);
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "mkdir dir && cd dir" })).toBe(true);
    // Without args, defaults to requiring approval
    expect(toolRequiresApproval("workspace.run_shell")).toBe(true);
    expect(toolRequiresApproval("workspace.run_shell", undefined, {})).toBe(true);
    expect(toolRequiresApproval("workspace.run_shell", undefined, { command: "" })).toBe(true);
  });

  test("workspace.run_shell runs echo", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-harness-sh-"));
    const r = await executeTool({ workspaceRoot: root }, "workspace.run_shell", {
      command: "echo paw-shell-ok",
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("exit");
    expect(JSON.stringify(r.payload)).toContain("paw-shell-ok");
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
    expect(r.summary).toContain("missing old_string");
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
