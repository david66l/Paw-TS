import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildCodeIndex, selectCodeContext } from "../src/code-index.js";

describe("code index", () => {
  test("builds cache files and finds function symbols", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-code-index-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "auth.ts"),
      "export function loginUser() { return true; }\n",
      "utf8",
    );

    buildCodeIndex(root);
    const blocks = selectCodeContext(root, "fix loginUser bug");

    expect(existsSync(path.join(root, ".paw", "code-index", "repo-map.json"))).toBe(true);
    expect(existsSync(path.join(root, ".paw", "code-index", "symbols.json"))).toBe(true);
    expect(existsSync(path.join(root, ".paw", "code-index", "test-map.json"))).toBe(true);
    expect(blocks[0]?.path).toBe("src/auth.ts");
    expect(blocks[0]?.symbols).toContain("loginUser");
  });

  test("finds test names", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-code-index-"));
    writeFileSync(
      path.join(root, "auth.test.ts"),
      "describe('auth flow', () => { test('rejects bad token', () => {}); });\n",
      "utf8",
    );

    const blocks = selectCodeContext(root, "rejects bad token test");

    expect(blocks[0]?.path).toBe("auth.test.ts");
    expect(blocks[0]?.tests).toContain("rejects bad token");
  });

  test("falls back to discoverContext when index has no match", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-code-index-"));
    writeFileSync(
      path.join(root, "notes.ts"),
      "export const needle = 'rareword';\n",
      "utf8",
    );
    buildCodeIndex(root);

    const blocks = selectCodeContext(root, "rareword");

    expect(blocks[0]?.path).toBe("notes.ts");
  });
});
