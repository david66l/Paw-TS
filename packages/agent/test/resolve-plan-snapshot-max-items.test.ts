import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolvePlanSnapshotMaxItems } from "../src/resolve-plan-snapshot-max-items.js";

describe("resolvePlanSnapshotMaxItems", () => {
  test("returns undefined when settings file missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-plsnap-"));
    expect(resolvePlanSnapshotMaxItems(dir)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reads plan_snapshot_max_items from .paw/settings.local.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-plsnap2-"));
    const paw = path.join(dir, ".paw");
    fs.mkdirSync(paw, { recursive: true });
    fs.writeFileSync(
      path.join(paw, "settings.local.json"),
      JSON.stringify({
        provider: "openai",
        plan_snapshot_max_items: 12,
      }),
      "utf8",
    );
    expect(resolvePlanSnapshotMaxItems(dir)).toBe(12);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("treats zero as unlimited flag", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-plsnap3-"));
    const paw = path.join(dir, ".paw");
    fs.mkdirSync(paw, { recursive: true });
    fs.writeFileSync(
      path.join(paw, "settings.local.json"),
      JSON.stringify({ plan_snapshot_max_items: 0 }),
      "utf8",
    );
    expect(resolvePlanSnapshotMaxItems(dir)).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
