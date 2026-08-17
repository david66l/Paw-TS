import fs from "node:fs";
import path from "node:path";

/**
 * Loop v2.1 测试守卫的代码-测试依赖图（test map）。
 *
 * 参考 TDAD（arXiv:2603.17973）的静态映射策略：从 Python 源码的
 * import 语句推导测试文件与被测源文件的关联，辅以命名约定与目录
 * 邻近性。纯投影——无模型调用，不拥有终局，只产事实。
 *
 * 用途：
 * 1. 开工安检：agent 进场前在基线上验证选中测试可执行；
 * 2. 改动即验证：产品文件被修改时，host 确定性执行受影响测试；
 * 3. 探针增强：对抗探针收到受影响测试清单与公共符号变化。
 */

export interface TestMapEntryV1 {
  /** 测试文件相对路径（如 tests/test_capture.py）。 */
  readonly testFile: string;
  /** 该测试文件 import 的源文件相对路径列表。 */
  readonly sourceFiles: readonly string[];
  /** 推荐的测试命令（如 python -m pytest tests/test_capture.py -x -q）。 */
  readonly testCommand: string;
  /** 命中来源。 */
  readonly matchedBy: readonly ("import" | "naming" | "directory")[];
}

export interface TestMapV1 {
  readonly entries: readonly TestMapEntryV1[];
  /** 源文件→测试文件的倒排索引。 */
  readonly bySource: ReadonlyMap<string, readonly TestMapEntryV1[]>;
  /** 检测到的测试 runner。 */
  readonly runner: "pytest" | "runtests" | "unittest" | "unknown";
}

const PYTHON_TEST_PATTERNS = [
  /^test_[^/]+\.py$/,
  /[^/]+_test\.py$/,
  /conftest\.py$/,
];

function isTestFile(relPath: string): boolean {
  const basename = relPath.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return PYTHON_TEST_PATTERNS.some((p) => p.test(basename));
}

/** 从 Python 源码文本中提取 import 的模块名。 */
export function extractPythonImports(source: string): readonly string[] {
  const imports: string[] = [];
  // from X import Y → X
  const fromRe = /^\s*from\s+([\w.]+)\s+import\s+/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(source)) !== null) {
    if (m[1]) imports.push(m[1]);
  }
  // import X.Y → X.Y
  const importRe = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm;
  while ((m = importRe.exec(source)) !== null) {
    if (m[1]) {
      for (const part of m[1].split(",")) {
        const trimmed = part.trim();
        if (trimmed) imports.push(trimmed);
      }
    }
  }
  return imports;
}

/** 将模块名映射到仓库内的源文件路径（试探常见布局）。 */
function moduleToSourcePaths(
  moduleName: string,
  allSourceFiles: readonly Set<string>[],
): string[] {
  const parts = moduleName.split(".");
  const paths: string[] = [];
  for (const sourceSet of allSourceFiles) {
    // django.utils.translation → django/utils/translation/__init__.py or .py
    const rel = parts.join("/");
    for (const suffix of [".py", "/__init__.py"]) {
      if (sourceSet.has(rel + suffix)) {
        paths.push(rel + suffix);
      }
    }
    // tests.i18n.tests → tests/i18n/tests.py
    if (sourceSet.has(rel + ".py")) {
      paths.push(rel + ".py");
    }
  }
  return [...new Set(paths)];
}

/** 命名约定：test_foo.py → foo.py 或 foo/__init__.py */
function namingConventionMatches(
  testFile: string,
  sourceFiles: ReadonlySet<string>,
): string[] {
  const basename = testFile.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const m = /^test_(.+)\.py$/.exec(basename);
  if (!m?.[1]) return [];
  const stem = m[1];
  const matches: string[] = [];
  for (const sf of sourceFiles) {
    const sfBase = sf.split("/").at(-1) ?? "";
    if (sfBase === `${stem}.py` || sfBase === `${stem}/__init__.py`) {
      matches.push(sf);
    }
  }
  return matches;
}

/** 目录邻近性：tests/test_foo.py 与同层或父层 foo.py 匹配。 */
function directoryProximityMatches(
  testFile: string,
  sourceFiles: ReadonlySet<string>,
): string[] {
  const testDir = path.dirname(testFile.replaceAll("\\", "/"));
  const matches: string[] = [];
  for (const sf of sourceFiles) {
    const sfDir = path.dirname(sf);
    if (sfDir === testDir || sfDir === path.dirname(testDir)) {
      matches.push(sf);
    }
  }
  return matches;
}

function detectRunner(workspaceRoot: string): TestMapV1["runner"] {
  if (fs.existsSync(path.join(workspaceRoot, "tests", "runtests.py"))) {
    return "runtests";
  }
  const pyproject = path.join(workspaceRoot, "pyproject.toml");
  const setupCfg = path.join(workspaceRoot, "setup.cfg");
  for (const cfg of [pyproject, setupCfg]) {
    try {
      if (
        fs.existsSync(cfg) &&
        fs.readFileSync(cfg, "utf8").includes("[tool:pytest]")
      ) {
        return "pytest";
      }
    } catch {
      /* best-effort */
    }
  }
  return "unknown";
}

function testCommandFor(runner: TestMapV1["runner"], testFile: string): string {
  switch (runner) {
    case "runtests":
      return `python tests/runtests.py ${testFile.replace(/^tests\//, "").replace(/\.py$/, "")} -v 1`;
    case "pytest":
    case "unknown":
    default:
      return `python -m pytest ${testFile} -x -q`;
  }
}

/**
 * 构建工作区的代码-测试依赖图。纯文件系统分析，无网络/模型调用。
 * 结果缓存在调用方（内存即可——一次 run 构建一次）。
 */
export function buildTestMapV1(workspaceRoot: string): TestMapV1 {
  const normalizedRoot = path.resolve(workspaceRoot);
  const allFiles = collectPythonFiles(normalizedRoot, normalizedRoot);
  const sourceSet = new Set(allFiles.filter((f) => !isTestFile(f)));
  const testFiles = allFiles.filter(
    (f) => isTestFile(f) && !f.includes("conftest"),
  );

  const entries: TestMapEntryV1[] = [];
  for (const testFile of testFiles) {
    const full = path.join(normalizedRoot, testFile);
    let source: string;
    try {
      source = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const matchedBy = new Set<TestMapEntryV1["matchedBy"][number]>();
    const linkedSources = new Set<string>();

    // 策略 1：import 分析
    const imports = extractPythonImports(source);
    for (const imp of imports) {
      for (const sf of moduleToSourcePaths(imp, [sourceSet])) {
        linkedSources.add(sf);
        matchedBy.add("import");
      }
    }

    // 策略 2：命名约定
    for (const sf of namingConventionMatches(testFile, sourceSet)) {
      linkedSources.add(sf);
      matchedBy.add("naming");
    }

    // 策略 3：目录邻近性（仅当其他策略未命中时）
    if (linkedSources.size === 0) {
      for (const sf of directoryProximityMatches(testFile, sourceSet)) {
        linkedSources.add(sf);
        matchedBy.add("directory");
      }
    }

    if (linkedSources.size > 0) {
      const runner = detectRunner(normalizedRoot);
      entries.push({
        testFile,
        sourceFiles: [...linkedSources].sort(),
        testCommand: testCommandFor(runner, testFile),
        matchedBy: [...matchedBy],
      });
    }
  }

  // 倒排索引
  const bySource = new Map<string, TestMapEntryV1[]>();
  for (const entry of entries) {
    for (const sf of entry.sourceFiles) {
      const existing = bySource.get(sf) ?? [];
      existing.push(entry);
      bySource.set(sf, existing);
    }
  }

  return {
    entries,
    bySource,
    runner: detectRunner(normalizedRoot),
  };
}

function collectPythonFiles(
  root: string,
  base: string,
  maxDepth = 5,
): string[] {
  const results: string[] = [];
  const skipDirs = new Set([
    ".git",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".eggs",
    "node_modules",
    ".paw",
  ]);
  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let items: fs.Dirent[];
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.isDirectory()) {
        if (!skipDirs.has(item.name)) {
          walk(path.join(dir, item.name), depth + 1);
        }
      } else if (item.name.endsWith(".py")) {
        const full = path.join(dir, item.name);
        results.push(path.relative(base, full).replaceAll("\\", "/"));
      }
    }
  }
  walk(root, 0);
  return results.sort();
}

/**
 * 查找被改动源文件影响的测试（含传递：目录级映射）。
 * 返回去重后的受影响测试条目。
 */
export function findImpactedTests(
  testMap: TestMapV1,
  changedFiles: readonly string[],
): readonly TestMapEntryV1[] {
  const impacted = new Map<string, TestMapEntryV1>();
  for (const changed of changedFiles) {
    const normalized = changed.replaceAll("\\", "/");
    // 精确匹配
    for (const entry of testMap.bySource.get(normalized) ?? []) {
      impacted.set(entry.testFile, entry);
    }
    // 包级前缀匹配：改 django/utils/translation/trans_real.py → 命中
    // import django.utils.translation（映射到 __init__.py）的测试。
    // 只匹配包入口（__init__.py），不匹配同目录所有文件。
    const parts = normalized.split("/");
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const pkgInit = [...parts.slice(0, i), "__init__.py"].join("/");
      for (const entry of testMap.bySource.get(pkgInit) ?? []) {
        impacted.set(entry.testFile, entry);
      }
    }
  }
  return [...impacted.values()].sort((a, b) =>
    a.testFile.localeCompare(b.testFile),
  );
}

/**
 * 渲染受影响测试清单（事实陈述，无行为命令）。
 * 供探针增强与模型上下文使用。
 */
export function renderImpactedTests(
  impacted: readonly TestMapEntryV1[],
): string | undefined {
  if (impacted.length === 0) return undefined;
  const tests = impacted
    .slice(0, 12)
    .map((t) => t.testFile)
    .join(", ");
  return `[ImpactedTests] ${impacted.length} test file(s) linked to the change surface: ${tests}${impacted.length > 12 ? ` (and ${impacted.length - 12} more)` : ""}`;
}
