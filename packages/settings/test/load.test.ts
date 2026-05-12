import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PawError } from "@paw/core";

import { loadPawSettingsLocal, redactSettingsForDisplay } from "../src/load.js";

describe("loadPawSettingsLocal", () => {
  test("parses valid JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-set-"));
    const p = path.join(dir, "settings.local.json");
    fs.writeFileSync(
      p,
      JSON.stringify({
        provider: "openai",
        model: "gpt-test",
        openai_api_key: "sk-testkeyvalue",
        max_steps: 40,
      }),
      "utf8",
    );
    const s = loadPawSettingsLocal(p);
    expect(s.provider).toBe("openai");
    expect(s.model).toBe("gpt-test");
    const red = redactSettingsForDisplay(s);
    expect(red.openai_api_key).toContain("…");
    expect(String(red.openai_api_key)).not.toContain("testkeyvalue");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("throws on missing file", () => {
    expect(() =>
      loadPawSettingsLocal(path.join(os.tmpdir(), "nope-paw-settings.json")),
    ).toThrow(PawError);
  });
});
