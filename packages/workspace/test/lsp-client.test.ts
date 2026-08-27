import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { LspClient } from "../src/lsp-client.js";

describe("LspClient lifecycle", () => {
  test("times out an unresponsive server and can always stop it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-lsp-timeout-"));
    const server = path.join(root, "hang.mjs");
    fs.writeFileSync(server, "setInterval(() => {}, 1000);\n");
    const client = new LspClient(root, 50);

    await expect(
      client.start({ command: process.execPath, args: [server], cwd: root }),
    ).rejects.toThrow("LSP initialize timed out");
    await client.stop();

    expect(client.isInitialized).toBeFalse();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
