import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveShellSandboxConfig } from "../src/resolve-shell-sandbox.js";

describe("resolveShellSandboxConfig", () => {
  test("defaults to off when settings missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-sandbox-settings-"));
    const cfg = resolveShellSandboxConfig(root);
    expect(cfg.mode).toBe("off");
  });

  test("reads workspace mode from settings.local.json", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-sandbox-settings-"));
    mkdirSync(path.join(root, ".paw"), { recursive: true });
    writeFileSync(
      path.join(root, ".paw", "settings.local.json"),
      JSON.stringify({
        sandbox: { mode: "workspace", network: "deny", image: "paw/sandbox:dev" },
      }),
    );

    const cfg = resolveShellSandboxConfig(root);
    expect(cfg.mode).toBe("workspace");
    expect(cfg.network).toBe("deny");
    expect(cfg.image).toBe("paw/sandbox:dev");
  });
});
