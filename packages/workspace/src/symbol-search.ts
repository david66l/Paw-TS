/**
 * symbol-search.ts — 基于 AST 的符号搜索引擎
 *
 * 【是什么】
 * 使用 TypeScript 编译器 API 对 JS/TS 文件进行 AST（抽象语法树）解析，
 * 提取函数、类、接口、类型别名、变量声明和导出等符号定义。支持按名称
 * 搜索（子串匹配或正则匹配）。
 *
 * 【为什么需要】
 * 在大型代码库中，grep 只能做文本匹配，无法区分"声明"和"引用"，
 * 也无法理解代码的语义结构。AST 级别的符号搜索可以精确定位定义位置，
 * 并区分函数、类、接口等不同种类的符号。这对于 AI Agent 进行代码
 * 理解、重构和导航至关重要。
 *
 * 【关键设计决策】
 * 1. 基于 TypeScript 编译器：直接使用 `typescript` 包的编译器 API
 *    （ts.createSourceFile + ts.forEachChild），不依赖 LSP 服务端。
 *    优势是无需启动外部进程，纯内存操作，速度快。
 *
 * 2. 递归深度限制（depth ≤ 3）：walkAstForSymbols 只遍历顶层和类级别的
 *    符号。函数的局部变量不被提取，因为我们关心的是"可被外部引用的符号"。
 *
 * 3. 文件大小限制（512KB）：超过此大小的文件跳过不解析，避免解析
 *    压缩后的 bundle 文件或大型生成文件拖慢性能。
 *
 * 4. 缓存机制：symbolCache 以文件路径为 key，存储解析结果和 mtime。
 *    只有文件被修改后才重新解析，大幅提升重复搜索的性能。
 *
 * 5. 结果上限：MAX_FILES=500（最多扫描的文件数）、
 *    MAX_RESULTS_PER_FILE=20（每文件最多返回的符号数）、
 *    MAX_TOTAL_RESULTS=100（总计最多返回的符号数）。
 *    这些上限防止在大型 monorepo 中搜索时间过长。
 *
 * 6. BFS 文件遍历：使用队列进行广度优先遍历，而非递归，避免深层目录
 *    导致调用栈溢出。
 *
 * 7. 忽略隐藏目录：以 "." 开头的目录会被跳过（除了 .git、node_modules
 *    等显式忽略的目录外，这是额外的安全策略）。
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** 单个符号的信息 */
export interface SymbolInfo {
  /** 符号名称（类方法格式为 ClassName.methodName） */
  readonly name: string;
  /** 符号种类 */
  readonly kind:
    | "function"
    | "class"
    | "interface"
    | "type"
    | "variable"
    | "export"
    | "method"
    | "property";
  /** 符号定义所在的行号（1-based） */
  readonly line: number;
  /** 符号定义所在的列号（1-based） */
  readonly character: number;
}

/** 单个文件的符号搜索结果 */
export interface SymbolSearchResult {
  /** 文件路径（相对于工作区） */
  readonly file: string;
  /** 该文件中匹配到的符号列表 */
  readonly symbols: readonly SymbolInfo[];
}

/** 符号搜索的整体响应 */
export interface SymbolSearchResponse {
  /** 匹配到的符号结果列表 */
  readonly matches?: SymbolSearchResult[];
  /** 错误信息（如有） */
  readonly error?: string;
  /** 结果是否因达到上限而被截断 */
  readonly truncated?: boolean;
}

/** 支持的 JS/TS 文件扩展名 */
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

/** 最多扫描的文件数 */
const MAX_FILES = 500;
/** 每个文件最多返回的匹配符号数 */
const MAX_RESULTS_PER_FILE = 20;
/** 总共最多返回的匹配符号数 */
const MAX_TOTAL_RESULTS = 100;

/** 缓存的符号数据：mtime 用于判断文件是否被修改 */
interface CachedSymbols {
  readonly mtimeMs: number;
  readonly symbols: SymbolInfo[];
}

/** 全局符号缓存（以文件绝对路径为 key） */
const symbolCache = new Map<string, CachedSymbols>();

/**
 * 清空整个符号缓存。
 * 一般在长时间空闲后或显式刷新时调用，确保下次搜索使用最新数据。
 */
export function invalidateSymbolCache(): void {
  symbolCache.clear();
}

/** 判断文件扩展名是否为 JS/TS 文件 */
function isJsTsFile(filePath: string): boolean {
  return JS_TS_EXTS.has(path.extname(filePath).toLowerCase());
}

/**
 * 递归遍历 AST，提取函数、类、接口、类型、变量和导出等符号定义。
 *
 * 支持的符号类型：
 * - FunctionDeclaration → function
 * - ClassDeclaration → class（同时提取 member 中的 method 和 property）
 * - InterfaceDeclaration → interface
 * - TypeAliasDeclaration → type
 * - VariableStatement → variable（仅顶层 const/let/var 声明）
 * - ExportDeclaration（named exports）→ export
 * - ExportAssignment（default export）→ export
 *
 * @param node 当前 AST 节点
 * @param sourceFile 所属的源文件（用于计算行列位置）
 * @param symbols 累积的符号列表（输出参数）
 * @param depth 当前递归深度，最大 3 层
 */
function walkAstForSymbols(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  symbols: SymbolInfo[],
  depth = 0,
): void {
  if (depth > 3) {
    // 不递归过深：我们只关心顶层和类级别的符号
    return;
  }

  // 函数声明
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
    // 提取类成员中的方法和属性名称
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
          // 类成员名称格式：ClassName.memberName
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
    // 变量声明（顶层的 const/let/var）
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
    // 命名导出：export { a, b }
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
    // 默认导出：export default <expr>
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

  // 递归遍历子节点
  ts.forEachChild(node, (child) =>
    walkAstForSymbols(child, sourceFile, symbols, depth + 1),
  );
}

/**
 * 从 JS/TS 文件中提取所有顶层符号。
 *
 * 包含缓存逻辑：
 * - 如果文件未修改（mtime 未变），直接返回缓存结果
 * - 文件超过 512KB 则跳过
 * - 根据扩展名确定 ScriptKind（TSX/JSX/JS/TS 等）
 *
 * @param filePath 文件的绝对路径
 * @returns 该文件中提取到的符号列表
 */
function extractSymbolsFromFile(filePath: string): SymbolInfo[] {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return [];
  }

  // 检查缓存：mtime 相同则直接返回缓存结果
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
  // 跳过过大的文件（如压缩后的 bundle）
  if (content.length > 512 * 1024) {
    return [];
  }

  // 根据文件扩展名选择正确的 ScriptKind
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
  // 缓存解析结果
  symbolCache.set(filePath, { mtimeMs: stats.mtimeMs, symbols });
  return symbols;
}

/**
 * 使用 BFS（广度优先搜索）查找工作区中的 JS/TS 文件。
 *
 * 忽略目录：
 * - 显式忽略的目录：.git, .paw, node_modules, __pycache__, .venv, venv,
 *   dist, build, target, .next, .nuxt, coverage
 * - 隐藏目录（以 "." 开头）也会被跳过
 *
 * @param dir 搜索起始目录
 * @param maxFiles 最大文件数上限
 * @returns 找到的 JS/TS 文件绝对路径列表
 */
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

  // BFS 遍历：使用队列，避免递归导致的调用栈溢出
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
        // 跳过显式忽略的目录和所有隐藏目录
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
 * 在工作区 JS/TS 文件中搜索匹配的符号定义。
 *
 * 搜索策略：
 * - 默认模式：大小写不敏感的子串匹配
 * - 正则模式（useRegex=true）：按正则表达式匹配符号名
 * - 结果受 MAX_FILES、MAX_RESULTS_PER_FILE、MAX_TOTAL_RESULTS 三层上限约束
 *
 * @param workspaceRoot 工作区根目录绝对路径
 * @param query 搜索关键词（子串或正则表达式）
 * @param options 可选配置：maxResults、maxFiles、useRegex
 * @returns 匹配的符号列表，包含 truncated 标志指示是否被截断
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

  // 构造匹配函数
  let matcher: (name: string) => boolean;
  if (useRegex) {
    try {
      const re = new RegExp(query, "i");
      matcher = (name) => re.test(name);
    } catch {
      return { error: "invalid regex pattern" };
    }
  } else {
    // 默认：大小写不敏感的子串匹配
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
    // 将绝对路径转为相对于工作区的路径（统一使用正斜杠）
    const rel = path
      .relative(workspaceRoot, filePath)
      .split(path.sep)
      .join("/");
    // 每个文件最多返回 MAX_RESULTS_PER_FILE 个符号
    const capped = matched.slice(0, MAX_RESULTS_PER_FILE);
    matches.push({ file: rel, symbols: capped });
    totalSymbols += capped.length;
  }

  return {
    matches,
    // 判断是否被截断：文件数达上限 或 符号总数达上限
    truncated: files.length >= maxFiles || totalSymbols >= maxResults,
  };
}
