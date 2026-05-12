import fs from "node:fs";
import path from "node:path";

import { PawError } from "@paw/core";

import { type PawSettingsLocal, pawSettingsLocalSchema } from "./schema.js";

export function defaultSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".paw", "settings.local.json");
}

export function loadPawSettingsLocal(filePath: string): PawSettingsLocal {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new PawError("CONFIG", `Settings file not found: ${filePath}`);
    }
    throw new PawError("CONFIG", `Cannot read settings: ${filePath}`, err);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch (e) {
    throw new PawError(
      "CONFIG",
      `Invalid JSON in settings file: ${filePath}`,
      e,
    );
  }
  const parsed = pawSettingsLocalSchema.safeParse(json);
  if (!parsed.success) {
    throw new PawError(
      "VALIDATION",
      `Settings schema invalid: ${filePath}`,
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

/** Mask secrets for terminal output (never print full API keys). */
export function redactSettingsForDisplay(
  s: PawSettingsLocal,
): Record<string, unknown> {
  const { openai_api_key: ok, anthropic_api_key: ak, ...rest } = s;
  return {
    ...rest,
    openai_api_key: maskKey(ok),
    anthropic_api_key: maskKey(ak),
  };
}

/** Write settings back to disk, preserving unknown keys. */
export function savePawSettingsLocal(
  filePath: string,
  settings: PawSettingsLocal,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function maskKey(v: string | undefined): string {
  if (!v || v.length < 8) {
    return v ? "(set, hidden)" : "(not set)";
  }
  return `(set, …${v.slice(-4)})`;
}
