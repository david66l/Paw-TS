import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

interface Annotation {
  readonly query: string;
  readonly hit: boolean;
}

describe("memory retrieval annotations", () => {
  it("loads workspace annotations and reports baseline hit rate", () => {
    const fp = path.join(
      process.cwd(),
      ".paw",
      "memory-retrieval-annotations.json",
    );
    if (!fs.existsSync(fp)) {
      console.warn("Skipping: no .paw/memory-retrieval-annotations.json");
      return;
    }
    const annotations = JSON.parse(
      fs.readFileSync(fp, "utf-8"),
    ) as Annotation[];
    expect(annotations.length).toBeGreaterThan(10);
    const hits = annotations.filter((a) => a.hit).length;
    const hitRate = hits / annotations.length;
    expect(hitRate).toBeGreaterThan(0);
    expect(hitRate).toBeLessThanOrEqual(1);
  });
});
