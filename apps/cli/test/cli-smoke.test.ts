import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainTs = path.resolve(__dirname, "../src/main.ts");

describe("paw-ts CLI", () => {
  test("--version exits 0 with expected line", () => {
    const r = spawnSync("bun", [mainTs, "--version"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(r.status).toBe(0);
    expect(r.stdout?.trim()).toBe("0.0.1-ts.0");
  });

  test("--help exits 2 (usage on stderr)", () => {
    const r = spawnSync("bun", [mainTs, "--help"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(r.status).toBe(2);
    expect(r.stderr ?? "").toContain("Usage:");
  });
});
