/**
 * Symbol search: AST-based extraction of functions, classes, interfaces,
 * types, and exports from JS/TS files. More precise than grep for finding
 * definitions in large codebases.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface SymbolInfo {
  readonly name: string;
  readonly kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "variable"
    | "export"
    | "method"
    | "property";
  readonly line: number;
  readonly character: number;
}

export interface SymbolSearchResult {
  readonly file: string;
  readonly symbols: readonly SymbolInfo[];
}

export interface SymbolSearchResponse {
  readonly matches?: SymbolSearchResult[];
  readonly error?: string;
  readonly truncated?: boolean;
}

const JS_TS_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const MAX_FILES = 500;
const MAX_RESULTS_PER_FILE = 20;
const MAX_TOTAL_RESULTS = 100;

interface CachedSymbols {
  readonly mtimeMs: number;
  readonly symbols: SymbolInfo[];
}

const symbolCache = new Map<string, CachedSymbols>();

/** Invalidate the entire symbol cache (e.g., after a long idle period or explicit refresh). */
export function invalidateSymbolCache(): void {
  symbolCache.clear();
}

function isJsTsFile(filePath: string): boolean {
  return JS_TS_EXTS.has(path.extname(filePath).toLowerCase());
}

function walkAstForSymbols(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  symbols: SymbolInfo[],
  depth = 0,
): void {
  if (depth > 3) {
    // Don't recurse too deep — we care about top-level and class-level symbols
    return;
  }

  if (ts.isFunctionDeclaration(node) && node.name) {
    const pos = sourceFile.getLineAndCharacterOfPosition(
      node.name.getStart(sourceFile),
    );
    symbols.push({
      name: node.name.text,
      kind: "function",
      line: pos.line + 1,
      character: pos.character + 1,
    });
  } else if (ts.isClassDeclaration(node) && node.name) {
    const pos = sourceFile.getLineAndCharacterOfPosition(
      node.name.getStart(sourceFile),
    );
    symbols.push({
      name: node.name.text,
      kind: "class",
      line: pos.line + 1,
      character: pos.character + 1,
    });
    // Also extract method names from the class body
    for (const member of node.members) {
      if (
        (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) &&
        member.name &&
        ts.isIdentifier(member.name)
      ) {
        const mPos = sourceFile.getLineAndCharacterOfPosition(
          member.name.getStart(sourceFile),
        );
        symbols.push({
          name: `${node.name.text}.${member.name.text}`,
          kind: ts.isMethodDeclaration(member) ? "method" : "property",
          line: mPos.line + 1,
          character: mPos.character + 1,
        });
      }
    }
  } else if (ts.isInterfaceDeclaration(node)) {
    const pos = sourceFile.getLineAndCharacterOfPosition(
      node.name.getStart(sourceFile),
    );
    symbols.push({
      name: node.name.text,
      kind: "interface",
      line: pos.line + 1,
      character: pos.character + 1,
    });
  } else if (ts.isTypeAliasDeclaration(node)) {
    const pos = sourceFile.getLineAndCharacterOfPosition(
      node.name.getStart(sourceFile),
    );
    symbols.push({
      name: node.name.text,
      kind: "type",
      line: pos.line + 1,
      character: pos.character + 1,
    });
  } else if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        const pos = sourceFile.getLineAndCharacterOfPosition(
          decl.name.getStart(sourceFile),
        );
        symbols.push({
          name: decl.name.text,
          kind: "variable",
          line: pos.line + 1,
          character: pos.character + 1,
        });
      }
    }
  } else if (ts.isExportDeclaration(node)) {
    // Named exports: export { a, b }
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const elem of node.exportClause.elements) {
        const pos = sourceFile.getLineAndCharacterOfPosition(
          elem.name.getStart(sourceFile),
        );
        symbols.push({
          name: elem.name.text,
          kind: "export",
          line: pos.line + 1,
          character: pos.character + 1,
        });
      }
    }
  } else if (ts.isExportAssignment(node)) {
    // export default <expr>
    if (ts.isIdentifier(node.expression)) {
      const pos = sourceFile.getLineAndCharacterOfPosition(
        node.expression.getStart(sourceFile),
      );
      symbols.push({
        name: `default (${node.expression.text})`,
        kind: "export",
        line: pos.line + 1,
        character: pos.character + 1,
      });
    }
  }

  ts.forEachChild(node, (child) =>
    walkAstForSymbols(child, sourceFile, symbols, depth + 1),
  );
}

function extractSymbolsFromFile(filePath: string): SymbolInfo[] {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return [];
  }

  const cached = symbolCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs) {
    return cached.symbols;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, { encoding: "utf8" });
  } catch {
    return [];
  }
  // Skip files that are too large
  if (content.length > 512 * 1024) {
    return [];
  }

  const scriptKind = (() => {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case ".tsx":
        return ts.ScriptKind.TSX;
      case ".jsx":
        return ts.ScriptKind.JSX;
      case ".js":
        return ts.ScriptKind.JS;
      case ".mjs":
        return ts.ScriptKind.JS;
      case ".cjs":
        return ts.ScriptKind.JS;
      case ".json":
        return ts.ScriptKind.JSON;
      default:
        return ts.ScriptKind.TS;
    }
  })();

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const symbols: SymbolInfo[] = [];
  walkAstForSymbols(sourceFile, sourceFile, symbols);
  symbolCache.set(filePath, { mtimeMs: stats.mtimeMs, symbols });
  return symbols;
}

function findJsTsFiles(dir: string, maxFiles: number): string[] {
  const results: string[] = [];
  const queue: string[] = [dir];
  const ignoreDirs = new Set([
    ".git",
    ".paw",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    "coverage",
  ]);

  while (queue.length > 0 && results.length < maxFiles) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name) && !entry.name.startsWith(".")) {
          queue.push(full);
        }
      } else if (entry.isFile() && isJsTsFile(full)) {
        results.push(full);
      }
    }
  }
  return results;
}

/**
 * Search workspace JS/TS files for symbols matching `query`.
 * Matches symbol names case-insensitively (or by regex if `useRegex` is true).
 */
export function searchWorkspaceSymbols(
  workspaceRoot: string,
  query: string,
  options: {
    maxResults?: number;
    maxFiles?: number;
    useRegex?: boolean;
  } = {},
): SymbolSearchResponse {
  const {
    maxResults = MAX_TOTAL_RESULTS,
    maxFiles = MAX_FILES,
    useRegex = false,
  } = options;

  let matcher: (name: string) => boolean;
  if (useRegex) {
    try {
      const re = new RegExp(query, "i");
      matcher = (name) => re.test(name);
    } catch {
      return { error: "invalid regex pattern" };
    }
  } else {
    const needle = query.toLowerCase();
    matcher = (name) => name.toLowerCase().includes(needle);
  }

  const files = findJsTsFiles(workspaceRoot, maxFiles);
  const matches: SymbolSearchResult[] = [];
  let totalSymbols = 0;

  for (const filePath of files) {
    if (totalSymbols >= maxResults) {
      break;
    }
    const symbols = extractSymbolsFromFile(filePath);
    const matched = symbols.filter((s) => matcher(s.name));
    if (matched.length === 0) {
      continue;
    }
    const rel = path
      .relative(workspaceRoot, filePath)
      .split(path.sep)
      .join("/");
    const capped = matched.slice(0, MAX_RESULTS_PER_FILE);
    matches.push({ file: rel, symbols: capped });
    totalSymbols += capped.length;
  }

  return {
    matches,
    truncated: files.length >= maxFiles || totalSymbols >= maxResults,
  };
}
