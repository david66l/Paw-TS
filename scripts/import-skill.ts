#!/usr/bin/env bun
/**
 * Convert a markdown skill file (e.g. from gstack or Claude Code) to
 * a paw-ts skill JSON file.
 *
 * Usage:
 *   bun scripts/import-skill.ts < input.md > output.json
 *   bun scripts/import-skill.ts path/to/skill.md skills/
 *
 * The markdown file should have YAML frontmatter:
 *   ---
 *   name: skill-name
 *   description: what it does
 *   ---
 *   # Skill prompt content...
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

interface Frontmatter {
  name?: string;
  description?: string;
  version?: string;
  tools?: string[];
  context?: "inline" | "fork";
}

function parseFrontmatter(text: string): { fm: Frontmatter; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fm: {}, body: text };

  const fm: Frontmatter = {};
  for (const line of match[1]!.split("\n")) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      const key = m[1]!.trim();
      const val = m[2]!.trim();
      if (key === "tools" || key === "allowedTools") {
        fm.tools = val.split(",").map((s) => s.trim()).filter(Boolean);
      } else if (key === "context") {
        fm.context = val as "inline" | "fork";
      } else {
        (fm as Record<string, string>)[key] = val;
      }
    }
  }
  return { fm, body: match[2]!.trim() };
}

function mdToJson(markdown: string, skillId: string): string {
  const { fm, body } = parseFrontmatter(markdown);

  const skill: Record<string, unknown> = {
    id: skillId,
    name: fm.name ?? skillId,
    description: fm.description ?? "",
    version: fm.version ?? "1.0.0",
    prompt: body,
    parameters: [{ name: "args", type: "string", description: "User arguments", required: false }],
  };

  if (fm.tools && fm.tools.length > 0) {
    skill.allowedTools = fm.tools;
  }
  if (fm.context) {
    skill.context = fm.context;
  }

  return JSON.stringify(skill, null, 2) + "\n";
}

// ── main ──

const args = process.argv.slice(2);

if (args.length === 0) {
  // stdin mode
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.on("end", () => {
    const md = Buffer.concat(chunks).toString("utf-8");
    process.stdout.write(mdToJson(md, "imported-skill"));
  });
} else {
  // file mode
  const inputPath = args[0]!;
  const outputDir = args[1] ?? ".";
  const md = readFileSync(inputPath, "utf-8");
  const skillId = path.basename(inputPath, path.extname(inputPath));
  const json = mdToJson(md, skillId);

  mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${skillId}.json`);
  writeFileSync(outPath, json, "utf-8");
  console.log(`Wrote ${outPath}`);
}
