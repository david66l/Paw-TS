import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { searchWorkspaceSymbols } from "../src/symbol-search.js";

describe("symbol-search", () => {
  test("finds function by name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-sym-"));
    writeFileSync(
      path.join(dir, "a.ts"),
      `export function calculateTotal(items: number[]): number {
  return items.reduce((a, b) => a + b, 0);
}`,
    );

    const r = searchWorkspaceSymbols(dir, "calculateTotal");
    expect(r.error).toBeUndefined();
    expect(r.matches?.length).toBe(1);
    expect(r.matches?.[0]?.file).toBe("a.ts");
    expect(r.matches?.[0]?.symbols[0]?.name).toBe("calculateTotal");
    expect(r.matches?.[0]?.symbols[0]?.kind).toBe("function");
  });

  test("finds class and methods", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-sym-"));
    writeFileSync(
      path.join(dir, "b.ts"),
      `class UserManager {
  private users: User[] = [];
  addUser(u: User) { this.users.push(u); }
  getCount() { return this.users.length; }
}`,
    );

    const r = searchWorkspaceSymbols(dir, "UserManager");
    expect(r.error).toBeUndefined();
    const match = r.matches?.find((m) => m.file === "b.ts");
    expect(match).toBeDefined();
    const names = match?.symbols.map((s) => s.name);
    expect(names).toContain("UserManager");
    expect(names).toContain("UserManager.addUser");
    expect(names).toContain("UserManager.getCount");
  });

  test("finds interface and type", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-sym-"));
    writeFileSync(
      path.join(dir, "c.ts"),
      `interface Config {
  port: number;
}

type Handler = (req: Request) => Response;`,
    );

    const r = searchWorkspaceSymbols(dir, "Config");
    expect(r.matches?.[0]?.symbols[0]?.kind).toBe("interface");

    const r2 = searchWorkspaceSymbols(dir, "Handler");
    expect(r2.matches?.[0]?.symbols[0]?.kind).toBe("type");
  });

  test("case-insensitive matching", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-sym-"));
    writeFileSync(path.join(dir, "d.ts"), "function doSomething() {}");

    const r = searchWorkspaceSymbols(dir, "dosomething");
    expect(r.matches?.length).toBe(1);
  });

  test("ignores non-js/ts files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-sym-"));
    writeFileSync(
      path.join(dir, "readme.md"),
      "# MyProject\nfunction foo() {}",
    );

    const r = searchWorkspaceSymbols(dir, "foo");
    expect(r.matches?.length ?? 0).toBe(0);
  });

  test("ignores dot directories", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-sym-"));
    mkdirSync(path.join(dir, ".hidden"), { recursive: true });
    writeFileSync(
      path.join(dir, ".hidden", "secret.ts"),
      "function hiddenFn() {}",
    );

    const r = searchWorkspaceSymbols(dir, "hiddenFn");
    expect(r.matches?.length ?? 0).toBe(0);
  });
});
