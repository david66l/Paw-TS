#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function commandText(command: string, args: readonly string[]): string {
  const result = Bun.spawnSync([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const repoRoot = process.cwd();
const versionOutput = commandText("claude", ["--version"]);
const version = /^(\d+\.\d+\.\d+)\b/.exec(versionOutput)?.[1];
if (!version) {
  throw new Error(`cannot parse Claude Code version: ${versionOutput}`);
}
const destination = path.join(
  repoRoot,
  "benchmarks",
  "swe-compare",
  "runtime",
  `claude-linux-x64-${version}`,
);
const binary = path.join(destination, "claude");
if (existsSync(binary)) {
  console.log(
    JSON.stringify(
      { version, binary, sha256: sha256(binary), reused: true },
      null,
      2,
    ),
  );
  process.exit(0);
}

const scratch = mkdtempSync(path.join(tmpdir(), "paw-claude-runtime-"));
try {
  const packageName = `@anthropic-ai/claude-code-linux-x64@${version}`;
  commandText("npm", ["pack", packageName, "--pack-destination", scratch]);
  const archive = path.join(
    scratch,
    `anthropic-ai-claude-code-linux-x64-${version}.tgz`,
  );
  if (!existsSync(archive)) {
    throw new Error(`npm pack did not produce ${archive}`);
  }
  const extracted = path.join(scratch, "extracted");
  mkdirSync(extracted, { recursive: true });
  commandText("tar", ["-xf", archive, "-C", extracted]);
  const source = path.join(extracted, "package", "claude");
  if (!existsSync(source)) {
    throw new Error(`Claude Linux package has no binary: ${source}`);
  }
  mkdirSync(destination, { recursive: true });
  copyFileSync(source, binary);
  chmodSync(binary, 0o755);
  const metadata = {
    package: "@anthropic-ai/claude-code-linux-x64",
    version,
    source: "npm_registry",
    sha256: sha256(binary),
  };
  writeFileSync(
    path.join(destination, "runtime.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ ...metadata, binary, reused: false }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
