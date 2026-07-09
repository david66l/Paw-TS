/**
 * Shared test fixtures for `@paw/agent`.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

/** 写入 settings，强制旧 file 记忆路径（单元测试隔离默认 db）。 */
export function writeFileMemorySettings(workspaceRoot: string): void {
  const paw = path.join(workspaceRoot, ".paw");
  mkdirSync(paw, { recursive: true });
  writeFileSync(
    path.join(paw, "settings.local.json"),
    JSON.stringify({ memory_backend: "file" }, null, 2),
    "utf8",
  );
}
