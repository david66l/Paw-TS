import path from "node:path";

/** Resolve workspace root: `--root <dir>` from argv, else `cwd`. */
export function parseRootFromArgv(
  cwd: string,
  argv: readonly string[],
): string {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) {
    return path.resolve(argv[i + 1] ?? cwd);
  }
  return cwd;
}

/** Positional args after a subcommand (skip `--root <v>`, `--recursive`, other flags). */
export function tailPositionalArgs(
  argv: readonly string[],
  subcommand: string,
): string[] {
  const i = argv.indexOf(subcommand);
  if (i === -1) {
    return [];
  }
  const rest = argv.slice(i + 1);
  const out: string[] = [];
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (!a) {
      continue;
    }
    if (a === "--root") {
      j++;
      continue;
    }
    if (a === "--recursive" || a.startsWith("--")) {
      continue;
    }
    out.push(a);
  }
  return out;
}
