import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type DependencyMap = ReadonlyMap<string, readonly string[]>;

export interface SourceImportViolation {
  readonly rule:
    | "core_must_not_import_memory"
    | "protocol_relative_imports_only"
    | "agent_loop_protocol_only"
    | "runtime_allowed_dependencies_only";
  readonly file: string;
  readonly specifier: string;
}

interface PackageManifest {
  readonly name?: string;
  readonly workspaces?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

function readManifest(filePath: string): PackageManifest {
  return JSON.parse(readFileSync(filePath, "utf8")) as PackageManifest;
}

function workspaceDirectories(
  root: string,
  patterns: readonly string[],
): string[] {
  const directories: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parent = path.resolve(root, pattern.slice(0, -2));
      for (const entry of readdirSync(parent)) {
        const candidate = path.join(parent, entry);
        if (statSync(candidate).isDirectory()) directories.push(candidate);
      }
      continue;
    }
    directories.push(path.resolve(root, pattern));
  }
  return directories;
}

function productionTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionTypeScriptFiles(candidate));
      continue;
    }
    if (
      entry.isFile() &&
      /\.[cm]?tsx?$/.test(entry.name) &&
      !/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)
    ) {
      files.push(candidate);
    }
  }
  return files.sort();
}

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"';()]*?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

/** Check the narrow production-source dependency boundaries adopted so far. */
export function findWp1aSourceImportViolations(
  root: string,
): SourceImportViolation[] {
  const violations: SourceImportViolation[] = [];
  const checks = [
    {
      directory: path.join(root, "packages", "core", "src"),
      rule: "core_must_not_import_memory" as const,
      forbidden: (specifier: string) =>
        specifier === "@paw/memory" || specifier.startsWith("@paw/memory/"),
    },
    {
      directory: path.join(root, "packages", "protocol", "src"),
      rule: "protocol_relative_imports_only" as const,
      forbidden: (specifier: string) =>
        !specifier.startsWith("./") && !specifier.startsWith("../"),
    },
    {
      directory: path.join(root, "packages", "agent-loop", "src"),
      rule: "agent_loop_protocol_only" as const,
      forbidden: (specifier: string) =>
        !specifier.startsWith("./") &&
        !specifier.startsWith("../") &&
        specifier !== "@paw/protocol" &&
        !specifier.startsWith("@paw/protocol/"),
    },
    {
      directory: path.join(root, "packages", "runtime", "src"),
      rule: "runtime_allowed_dependencies_only" as const,
      forbidden: (specifier: string) => {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          return false;
        }
        if (specifier.startsWith("node:")) return false;
        return ![
          "@paw/agent-loop",
          "@paw/core",
          "@paw/harness",
          "@paw/protocol",
          "@paw/workspace",
        ].some(
          (allowed) =>
            specifier === allowed || specifier.startsWith(`${allowed}/`),
        );
      },
    },
  ];

  for (const check of checks) {
    for (const file of productionTypeScriptFiles(check.directory)) {
      for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
        const relativeEscape =
          (specifier.startsWith("./") || specifier.startsWith("../")) &&
          !isWithinDirectory(
            check.directory,
            path.resolve(path.dirname(file), specifier),
          );
        if (!relativeEscape && !check.forbidden(specifier)) continue;
        violations.push({
          rule: check.rule,
          file: path.relative(root, file).replaceAll(path.sep, "/"),
          specifier,
        });
      }
    }
  }

  return violations;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(
    path.resolve(directory),
    path.resolve(candidate),
  );
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Build the runtime workspace dependency graph from package manifests. */
export function buildWorkspaceDependencyGraph(
  root: string,
): Map<string, string[]> {
  const rootManifest = readManifest(path.join(root, "package.json"));
  const patterns = rootManifest.workspaces;
  if (!patterns)
    throw new Error("Root package.json must declare array workspaces");

  const manifests = workspaceDirectories(root, patterns)
    .map((directory) => readManifest(path.join(directory, "package.json")))
    .filter(
      (manifest): manifest is PackageManifest & { readonly name: string } =>
        Boolean(manifest.name),
    );
  const workspaceNames = new Set(manifests.map((manifest) => manifest.name));
  if (workspaceNames.size !== manifests.length) {
    throw new Error("Workspace package names must be unique");
  }

  const graph = new Map<string, string[]>();
  for (const manifest of manifests) {
    const dependencyNames = new Set<string>();
    for (const dependencies of [
      manifest.dependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const dependency of Object.keys(dependencies ?? {})) {
        if (workspaceNames.has(dependency)) dependencyNames.add(dependency);
      }
    }
    graph.set(manifest.name, [...dependencyNames].sort());
  }
  return graph;
}

/** Return one explicit node path for each runtime dependency cycle. */
export function findDependencyCycles(graph: DependencyMap): string[][] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles = new Map<string, string[]>();

  const visit = (node: string): void => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = [...stack.slice(start), node];
      const members = cycle.slice(0, -1).sort().join("\u0000");
      cycles.set(members, cycle);
      return;
    }

    visiting.add(node);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of [...graph.keys()].sort()) visit(node);
  return [...cycles.values()];
}

function countEdges(graph: DependencyMap): number {
  let edges = 0;
  for (const dependencies of graph.values()) edges += dependencies.length;
  return edges;
}

if (import.meta.main) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const graph = buildWorkspaceDependencyGraph(root);
  const cycles = findDependencyCycles(graph);
  const sourceViolations = findWp1aSourceImportViolations(root);
  if (cycles.length > 0) {
    for (const cycle of cycles) {
      console.error(`Workspace dependency cycle: ${cycle.join(" -> ")}`);
    }
  }
  for (const violation of sourceViolations) {
    console.error(
      `WP1a source boundary violation (${violation.rule}): ${violation.file} imports ${violation.specifier}`,
    );
  }
  if (cycles.length > 0 || sourceViolations.length > 0) {
    process.exitCode = 1;
  } else {
    console.log(
      `Workspace dependency graph is acyclic (${graph.size} packages, ${countEdges(graph)} edges); WP1a source boundaries pass.`,
    );
  }
}
