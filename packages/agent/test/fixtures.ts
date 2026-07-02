/**
 * Shared test fixtures for `@paw/agent`.
 */

import { existsSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}
