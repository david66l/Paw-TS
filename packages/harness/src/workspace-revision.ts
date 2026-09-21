import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
type Revision = Map<string, string> | undefined;
/** Bounded content snapshot of Git-visible files; never trust a shell's claimed effects. */
export async function captureWorkspaceRevision(
  root: string,
): Promise<Revision> {
  try {
    const { stdout } = await run(
      "git",
      [
        "-C",
        root,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ],
      { windowsHide: true, timeout: 2000, maxBuffer: 512 * 1024 },
    );
    const names = [...new Set(stdout.split("\0").filter(Boolean))];
    if (names.length > 2000) return undefined;
    const canonical = await fs.realpath(root);
    const result = new Map<string, string>();
    let remaining = 16 * 1024 * 1024;
    for (const name of names.sort()) {
      if (
        name === ".paw" ||
        name.startsWith(".paw/") ||
        name.startsWith(".git/")
      )
        continue;
      const file = path.resolve(root, name);
      const relative = path.relative(canonical, file);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      )
        return undefined;
      let stat;
      try {
        stat = await fs.lstat(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          result.set(name, "missing");
          continue;
        }
        throw e;
      }
      if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
      const real = await fs.realpath(file);
      if (real !== file && path.relative(canonical, real).startsWith(".."))
        return undefined;
      remaining -= stat.size;
      if (remaining < 0) return undefined;
      result.set(
        name,
        createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex"),
      );
    }
    return result;
  } catch {
    return undefined;
  }
}
export function compareWorkspaceRevisions(before: Revision, after: Revision) {
  const paths =
    before && after
      ? [...new Set([...before.keys(), ...after.keys()])]
          .filter((p) => before.get(p) !== after.get(p))
          .sort()
      : [];
  return {
    policyVersion: "paw.workspace-effect.v1:git-visible:bounded",
    changed: before && after ? paths.length > 0 : ("unknown" as const),
    paths,
    scope: "git-visible",
  };
}
