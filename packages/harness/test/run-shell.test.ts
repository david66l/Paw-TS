import { describe, expect, test } from "bun:test";

import { classifyShellCommand, interpretShellExitCode } from "../src/run-shell.js";

describe("classifyShellCommand", () => {
  test("read-only commands", () => {
    expect(classifyShellCommand("ls -la")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "list",
    });
    expect(classifyShellCommand("cat file.txt")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "read",
    });
    expect(classifyShellCommand("grep foo *.ts")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "search",
    });
    expect(classifyShellCommand("find . -name '*.js'")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "search",
    });
    expect(classifyShellCommand("pwd")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "read",
    });
    expect(classifyShellCommand("env | grep PATH")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "search",
    });
  });

  test("compound read-only commands", () => {
    expect(classifyShellCommand("ls -la && cat file.txt")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "list",
    });
    expect(classifyShellCommand("echo '---' && grep foo *.ts")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "search",
    });
    expect(classifyShellCommand("pwd && env && echo done")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "read",
    });
  });

  test("mutating commands", () => {
    expect(classifyShellCommand("rm file.txt")).toEqual({
      isReadOnly: false,
      isSilent: true,
      commandType: "write",
    });
    expect(classifyShellCommand("mv a b")).toEqual({
      isReadOnly: false,
      isSilent: true,
      commandType: "write",
    });
    expect(classifyShellCommand("mkdir dir")).toEqual({
      isReadOnly: false,
      isSilent: true,
      commandType: "write",
    });
    expect(classifyShellCommand("git push")).toEqual({
      isReadOnly: false,
      isSilent: false,
      commandType: "write",
    });
    expect(classifyShellCommand("npm install")).toEqual({
      isReadOnly: false,
      isSilent: false,
      commandType: "write",
    });
  });

  test("compound commands with mixed read/write", () => {
    expect(classifyShellCommand("cat file.txt && rm file.txt")).toEqual({
      isReadOnly: false,
      isSilent: false,
      commandType: "write",
    });
    expect(classifyShellCommand("ls -la | grep foo")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "search",
    });
    expect(classifyShellCommand("mkdir dir && cd dir && ls")).toEqual({
      isReadOnly: false,
      isSilent: false,
      commandType: "write",
    });
  });

  test("empty or neutral commands", () => {
    expect(classifyShellCommand("")).toEqual({
      isReadOnly: false,
      isSilent: false,
      commandType: "unknown",
    });
    expect(classifyShellCommand("echo hello")).toEqual({
      isReadOnly: false,
      isSilent: false,
      commandType: "unknown",
    });
    expect(classifyShellCommand("printf '%s' ok")).toEqual({
      isReadOnly: false,
      isSilent: false,
      commandType: "unknown",
    });
  });

  test("commands with env vars and flags", () => {
    expect(classifyShellCommand("FOO=bar ls -la")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "list",
    });
    expect(classifyShellCommand("NODE_ENV=test cat file.json")).toEqual({
      isReadOnly: true,
      isSilent: false,
      commandType: "read",
    });
    expect(classifyShellCommand("git -C subdir status")).toEqual({
      isReadOnly: false,
      isSilent: false,
      commandType: "write",
    });
    expect(classifyShellCommand("mv a b")).toEqual({
      isReadOnly: false,
      isSilent: true,
      commandType: "write",
    });
  });
});

describe("interpretShellExitCode", () => {
  test("exit code 0 is always success", () => {
    expect(interpretShellExitCode("grep foo file", 0)).toEqual({ isError: false });
    expect(interpretShellExitCode("rm file", 0)).toEqual({ isError: false });
    expect(interpretShellExitCode("npm test", 0)).toEqual({ isError: false });
  });

  test("grep / rg semantics", () => {
    expect(interpretShellExitCode("grep foo file.txt", 1)).toEqual({
      isError: false,
      message: "No matches found",
    });
    expect(interpretShellExitCode("grep foo file.txt", 2)).toEqual({
      isError: true,
    });
    expect(interpretShellExitCode("rg foo", 1)).toEqual({
      isError: false,
      message: "No matches found",
    });
  });

  test("find semantics", () => {
    expect(interpretShellExitCode("find . -name '*.ts'", 1)).toEqual({
      isError: false,
      message: "Some directories were inaccessible",
    });
    expect(interpretShellExitCode("find . -name '*.ts'", 2)).toEqual({
      isError: true,
    });
  });

  test("diff semantics", () => {
    expect(interpretShellExitCode("diff a b", 1)).toEqual({
      isError: false,
      message: "Files differ",
    });
    expect(interpretShellExitCode("diff a b", 2)).toEqual({
      isError: true,
    });
  });

  test("test / [ semantics", () => {
    expect(interpretShellExitCode("test -f file", 1)).toEqual({
      isError: false,
      message: "Condition is false",
    });
    expect(interpretShellExitCode("[ -d dir ]", 1)).toEqual({
      isError: false,
      message: "Condition is false",
    });
    expect(interpretShellExitCode("test -f file", 2)).toEqual({
      isError: true,
    });
  });

  test("default semantics for unknown commands", () => {
    expect(interpretShellExitCode("npm test", 1)).toEqual({
      isError: true,
      message: "Command failed with exit code 1",
    });
    expect(interpretShellExitCode("cat missing", 1)).toEqual({
      isError: true,
      message: "Command failed with exit code 1",
    });
    expect(interpretShellExitCode("git push", 128)).toEqual({
      isError: true,
      message: "Command failed with exit code 128",
    });
  });

  test("pipelines use last command for semantics", () => {
    expect(interpretShellExitCode("cat file | grep foo", 1)).toEqual({
      isError: false,
      message: "No matches found",
    });
    expect(interpretShellExitCode("echo hello | wc -l", 0)).toEqual({
      isError: false,
    });
  });

  test("null/undefined exit code", () => {
    expect(interpretShellExitCode("cmd", null)).toEqual({
      isError: true,
      message: "Command did not produce an exit code",
    });
    expect(interpretShellExitCode("cmd", undefined)).toEqual({
      isError: true,
      message: "Command did not produce an exit code",
    });
  });
});
