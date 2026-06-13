/**
 * LongBench-compatible adapter using paw-ts's own long files as the corpus.
 *
 * Instead of downloading external datasets (which requires HuggingFace access),
 * we take the longest TypeScript files in the repo, insert a "needle" fact,
 * and test whether the context compression pipeline preserves it.
 *
 * Format matches LongBench "code" subset so real data can be swapped in later.
 */

import fs from "node:fs";
import path from "node:path";

export interface LongBenchRecord {
  readonly id: string;
  readonly file: string;
  /** The full file content with needle inserted. */
  readonly context: string;
  /** The question to answer from the context. */
  readonly question: string;
  /** The expected answer (the needle). */
  readonly answer: string;
  /** 0-based line index where needle was inserted. */
  readonly needleLine: number;
}

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Find the longest .ts files (excluding tests). */
function findLongFiles(minLines: number = 300): { file: string; lines: string[] }[] {
  const result: { file: string; lines: string[] }[] = [];
  const dirs = ["packages", "apps"];

  for (const dir of dirs) {
    const fullDir = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(fullDir)) continue;
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const content = fs.readFileSync(full, "utf-8");
          const lines = content.split("\n");
          if (lines.length >= minLines) {
            result.push({
              file: path.relative(REPO_ROOT, full),
              lines,
            });
          }
        }
      }
    };
    walk(fullDir);
  }

  return result.sort((a, b) => b.lines.length - a.lines.length);
}

const NEEDLES = [
  {
    question: "What is the secret passphrase for the compression pipeline?",
    answer: "needle-compress-42",
    insert: (lines: string[], idx: number) => {
      lines.splice(idx, 0, `// SECRET: The passphrase is "needle-compress-42"`);
      return lines;
    },
  },
  {
    question: "What is the maximum history size for the footer state?",
    answer: "1000",
    insert: (lines: string[], idx: number) => {
      lines.splice(idx, 0, `const MAX_HISTORY = 1000; // footer state limit`);
      return lines;
    },
  },
  {
    question: "What token threshold triggers the L2 compaction warning?",
    answer: "0.75",
    insert: (lines: string[], idx: number) => {
      lines.splice(idx, 0, `const COMPACT_WARNING_THRESHOLD = 0.75; // L2 trigger`);
      return lines;
    },
  },
];

export function loadLocalLongBench(): LongBenchRecord[] {
  const longFiles = findLongFiles(300);
  const records: LongBenchRecord[] = [];

  for (let i = 0; i < Math.min(NEEDLES.length, longFiles.length); i++) {
    const file = longFiles[i];
    const needle = NEEDLES[i];
    // Insert needle at roughly 2/3 of the file (deep in the haystack)
    const insertLine = Math.floor(file.lines.length * 0.67);
    const modifiedLines = needle.insert([...file.lines], insertLine);
    records.push({
      id: `long-${i}`,
      file: file.file,
      context: modifiedLines.join("\n"),
      question: needle.question,
      answer: needle.answer,
      needleLine: insertLine,
    });
  }

  return records;
}
