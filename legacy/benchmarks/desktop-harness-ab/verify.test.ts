import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tasks } from "./tasks.js";

test("external verifier rejects absent interfaces and only credits existing baseline behavior", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "paw-ab-verifier-selftest-"),
  );
  try {
    for (const kind of ["queue", "ledger"] as const) {
      const workspace = path.join(root, kind);
      fs.mkdirSync(workspace);
      const verify = () => {
        const result = spawnSync(
          "node",
          [path.join(import.meta.dir, "verify.mjs"), kind, workspace],
          { encoding: "utf8", timeout: 15000 },
        );
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout);
      };
      expect(verify().passed).toBe(0);
      for (const [name, content] of Object.entries(tasks[kind].seed)) {
        fs.mkdirSync(path.dirname(path.join(workspace, name)), {
          recursive: true,
        });
        fs.writeFileSync(path.join(workspace, name), content);
      }
      const baseline = verify();
      expect(baseline.total).toBe(15);
      expect(baseline.passed).toBe(kind === "ledger" ? 1 : 0);
    }
  } finally {
    const resolved = fs.realpathSync(root);
    expect(path.dirname(resolved)).toBe(fs.realpathSync(os.tmpdir()));
    expect(
      path.basename(resolved).startsWith("paw-ab-verifier-selftest-"),
    ).toBe(true);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
