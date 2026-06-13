import fs from "node:fs";
import path from "node:path";

/** Walk up from `startDir` to find the nearest directory containing `.paw/`. */
export function findPawRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, ".paw"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
