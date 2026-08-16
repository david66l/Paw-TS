import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildWorkspaceDependencyGraph,
  findDependencyCycles,
  findWp1aSourceImportViolations,
} from "./check-workspace-dependency-cycles.js";

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "paw-dependency-gate-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function write(root: string, relativePath: string, contents: string): void {
  const file = path.join(root, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, "utf8");
}

describe("findDependencyCycles", () => {
  test("accepts an acyclic workspace graph", () => {
    const graph = new Map<string, string[]>([
      ["@paw/protocol", []],
      ["@paw/core", ["@paw/protocol"]],
      ["@paw/memory", ["@paw/core", "@paw/protocol"]],
      ["@paw/agent", ["@paw/core", "@paw/memory"]],
    ]);

    expect(findDependencyCycles(graph)).toEqual([]);
  });

  test("reports the explicit dependency path for a cycle", () => {
    const graph = new Map<string, string[]>([
      ["@paw/core", ["@paw/memory"]],
      ["@paw/memory", ["@paw/core"]],
    ]);

    expect(findDependencyCycles(graph)).toEqual([
      ["@paw/core", "@paw/memory", "@paw/core"],
    ]);
  });

  test("detects a cycle from workspace manifest fixtures", () => {
    withFixture((root) => {
      write(
        root,
        "package.json",
        JSON.stringify({ private: true, workspaces: ["packages/*"] }),
      );
      write(
        root,
        "packages/core/package.json",
        JSON.stringify({
          name: "@paw/core",
          dependencies: { "@paw/memory": "workspace:*" },
        }),
      );
      write(
        root,
        "packages/memory/package.json",
        JSON.stringify({
          name: "@paw/memory",
          dependencies: { "@paw/core": "workspace:*" },
        }),
      );

      expect(findDependencyCycles(buildWorkspaceDependencyGraph(root))).toEqual(
        [["@paw/core", "@paw/memory", "@paw/core"]],
      );
    });
  });
});

describe("findWp1aSourceImportViolations", () => {
  test("rejects Core production imports from Memory", () => {
    withFixture((root) => {
      write(
        root,
        "packages/core/src/boundary.ts",
        'import type { MemoryRuntime } from "@paw/memory";\n',
      );

      expect(findWp1aSourceImportViolations(root)).toEqual([
        {
          rule: "core_must_not_import_memory",
          file: "packages/core/src/boundary.ts",
          specifier: "@paw/memory",
        },
      ]);
    });
  });

  test("rejects all non-relative Protocol production imports", () => {
    withFixture((root) => {
      write(
        root,
        "packages/protocol/src/boundary.ts",
        [
          'import path from "node:path";',
          'export type { RunSpec } from "@paw/core";',
          'import "postgres";',
        ].join("\n"),
      );

      expect(findWp1aSourceImportViolations(root)).toEqual([
        {
          rule: "protocol_relative_imports_only",
          file: "packages/protocol/src/boundary.ts",
          specifier: "node:path",
        },
        {
          rule: "protocol_relative_imports_only",
          file: "packages/protocol/src/boundary.ts",
          specifier: "@paw/core",
        },
        {
          rule: "protocol_relative_imports_only",
          file: "packages/protocol/src/boundary.ts",
          specifier: "postgres",
        },
      ]);
    });
  });

  test("accepts relative Protocol imports and unrelated Core imports", () => {
    withFixture((root) => {
      write(
        root,
        "packages/protocol/src/index.ts",
        'export type { LegacyDto } from "./legacy.js";\n',
      );
      write(
        root,
        "packages/core/src/model.ts",
        'import type { Model } from "@paw/models";\n',
      );

      expect(findWp1aSourceImportViolations(root)).toEqual([]);
    });
  });
});
