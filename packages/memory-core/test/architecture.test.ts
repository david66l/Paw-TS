import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import {
  createEvidenceFirstMemoryContextResolverV1,
  createJsonMemoryEvidenceQueryPlannerV3,
  createJsonMemoryEvidenceSupportSelectorV1,
  createMemoryEvidenceResolverV1,
  createProductMemoryEvidenceIndexV1,
} from "../src/index.js";

const sourceRoot = resolve(import.meta.dir, "../src");
const productEntry = resolve(sourceRoot, "index.ts");

describe("evidence-first product architecture", () => {
  test("exposes the complete product read path through a narrow subpath", () => {
    expect(createEvidenceFirstMemoryContextResolverV1).toBeFunction();
    expect(createJsonMemoryEvidenceQueryPlannerV3).toBeFunction();
    expect(createJsonMemoryEvidenceSupportSelectorV1).toBeFunction();
    expect(createMemoryEvidenceResolverV1).toBeFunction();
    expect(createProductMemoryEvidenceIndexV1).toBeFunction();
  });

  test("has no Aspect, Facet, or temporal-graph module in its dependency closure", () => {
    const closure = localDependencyClosure(productEntry);
    const files = closure.map((file) =>
      relative(sourceRoot, file).replaceAll("\\", "/"),
    );
    const forbidden = files.filter(
      (file) =>
        /(^|\/)(?:aspect|facet)-/u.test(file) ||
        /(^|\/)temporal-graph\.ts$/u.test(file),
    );
    expect(files).toContain("state-observation.ts");
    expect(forbidden).toEqual([]);
  });

  test("keeps the complete standalone closure free of Paw package imports", () => {
    const closure = localDependencyClosure(productEntry, true);
    const violations = closure.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/from\s+["'](@paw\/[^"']+)["']/gu)].map(
        (match) =>
          `${relative(sourceRoot, file).replaceAll("\\", "/")}: ${match[1]}`,
      );
    });
    expect(violations).toEqual([]);
  });
});

function localDependencyClosure(
  entry: string,
  includeTypeOnly = false,
): readonly string[] {
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const source = readFileSync(current, "utf8");
    for (const specifier of relativeSpecifiers(source, includeTypeOnly)) {
      const dependency = resolveTypeScriptImport(current, specifier);
      if (dependency && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return Object.freeze([...visited].sort());
}

function relativeSpecifiers(
  source: string,
  includeTypeOnly: boolean,
): readonly string[] {
  const values: string[] = [];
  const fromPattern =
    /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s+from\s+["'](\.[^"']+)["'];?/gu;
  for (const match of source.matchAll(fromPattern)) {
    const clause = match[1]?.trim();
    const value = match[2];
    if (!clause || !value || (!includeTypeOnly && isTypeOnlyClause(clause))) {
      continue;
    }
    values.push(value);
  }
  const barePattern = /(?:^|\n)\s*import\s+["'](\.[^"']+)["'];?/gu;
  for (const match of source.matchAll(barePattern)) {
    const value = match[1];
    if (value) values.push(value);
  }
  return values;
}

function isTypeOnlyClause(clause: string): boolean {
  if (clause.startsWith("type ")) return true;
  if (!clause.startsWith("{")) return false;
  const closing = clause.lastIndexOf("}");
  if (closing < 0) return false;
  const members = clause
    .slice(1, closing)
    .split(",")
    .map((member) => member.trim())
    .filter(Boolean);
  return (
    members.length > 0 && members.every((member) => member.startsWith("type "))
  );
}

function resolveTypeScriptImport(
  importer: string,
  specifier: string,
): string | null {
  const raw = resolve(dirname(importer), specifier);
  const candidates = [
    raw,
    raw.replace(/\.js$/u, ".ts"),
    `${raw}.ts`,
    resolve(raw, "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
