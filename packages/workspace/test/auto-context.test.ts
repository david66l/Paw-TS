import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { discoverContext } from "../src/auto-context.js";

describe("discoverContext", () => {
  test("returns empty when no meaningful keywords", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-auto-"));
    const r = discoverContext(root, "fix the bug");
    expect(r.content).toBe("");
    expect(r.filesRead).toEqual([]);
    expect(r.filesNotFound).toEqual([]);
  });

  test("discovers files matching keywords", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-auto-"));
    writeFileSync(path.join(root, "auth.ts"), "export function login() { return true; }\n", "utf8");
    writeFileSync(path.join(root, "utils.ts"), "export function helper() {}\n", "utf8");
    const r = discoverContext(root, "how does login work");
    expect(r.filesRead).toContain("auth.ts");
    expect(r.filesRead).not.toContain("utils.ts");
    expect(r.content).toContain("<file path=\"auth.ts\">");
    expect(r.content).toContain("export function login()");
  });

  test("excludes files passed in excludeFiles", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-auto-"));
    writeFileSync(path.join(root, "auth.ts"), "export function login() {}\n", "utf8");
    writeFileSync(path.join(root, "login.ts"), "export function login() {}\n", "utf8");
    const r = discoverContext(root, "how does login work", ["auth.ts"]);
    expect(r.filesRead).not.toContain("auth.ts");
    expect(r.filesRead).toContain("login.ts");
  });

  test("truncates large files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-auto-"));
    // File must contain the keyword so grep finds it, and be larger than MAX_FILE_CHARS
    const bigContent = "big content " + "x".repeat(20_000);
    writeFileSync(path.join(root, "big.ts"), bigContent, "utf8");
    const r = discoverContext(root, "big content");
    expect(r.filesRead).toContain("big.ts");
    expect(r.content).toContain("... (truncated)");
    expect(r.content.length).toBeLessThan(bigContent.length + 500);
  });

  test("scores source files higher than data files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-auto-"));
    writeFileSync(path.join(root, "config.json"), '{ "login": true }\n', "utf8");
    writeFileSync(path.join(root, "auth.ts"), "export function login() {}\n", "utf8");
    const r = discoverContext(root, "login");
    // auth.ts should rank above config.json due to source extension bonus
    const authIndex = r.filesRead.indexOf("auth.ts");
    const jsonIndex = r.filesRead.indexOf("config.json");
    expect(authIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeLessThan(jsonIndex);
  });

  test("handles nested directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-auto-"));
    const nested = path.join(root, "src", "auth");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "login.ts"), "export function login() {}\n", "utf8");
    const r = discoverContext(root, "how does login work");
    expect(r.filesRead).toContain(path.join("src", "auth", "login.ts"));
    expect(r.content).toContain("export function login()");
  });

  test("ignores node_modules and other ignored dirs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-auto-"));
    const nm = path.join(root, "node_modules", "foo");
    mkdirSync(nm, { recursive: true });
    writeFileSync(path.join(nm, "login.ts"), "export function login() {}\n", "utf8");
    writeFileSync(path.join(root, "auth.ts"), "export function login() {}\n", "utf8");
    const r = discoverContext(root, "login");
    expect(r.filesRead).toContain("auth.ts");
    expect(r.filesRead).not.toContain(path.join("node_modules", "foo", "login.ts"));
  });

  test("caps max files at 8", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-auto-"));
    for (let i = 0; i < 12; i++) {
      writeFileSync(path.join(root, `file${i}.ts`), `export function login${i}() {}\n`, "utf8");
    }
    const r = discoverContext(root, "login");
    expect(r.filesRead.length).toBeLessThanOrEqual(8);
  });
});
