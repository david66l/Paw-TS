import { describe, expect, test } from "bun:test";

import { validateShellCommand } from "../src/shell-guard.js";

describe("validateShellCommand", () => {
  test("allows benign commands", () => {
    expect(validateShellCommand("echo hello").allowed).toBe(true);
    expect(validateShellCommand("npm test").allowed).toBe(true);
  });

  test("blocks rm", () => {
    const r = validateShellCommand("rm foo");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/rm|disallowed/i);
  });

  test("blocks injection markers", () => {
    expect(validateShellCommand("echo $(whoami)").allowed).toBe(false);
  });

  test("blocks destructive literals", () => {
    expect(validateShellCommand("rm -rf /").allowed).toBe(false);
  });
});
