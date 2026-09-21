// One-off: move instance-independent module-level code out of
// packages/agent/src/orchestrator.ts into orchestrator/{support,errors}.ts and
// the three public option interfaces into orchestrator/types.ts.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const FILE = "packages/agent/src/orchestrator.ts";
const DIR = "packages/agent/src/orchestrator";

const MOVE = {
  CONSTRAINT_TASK_PIVOT_PATTERN: "support",
  CONSTRAINT_SYSTEM_INJECTED_PREFIXES: "support",
  loopV2LegacyTerminalFromRunResult: "support",
  providerProtocolRecoveryMessageV2: "support",
  providerTurnBoundaryMessageV2: "support",
  isSameRevisionCandidateExtension: "support",
  normalizeNativeControlAction: "support",
  buildMemoryLlmOptions: "support",
  isRealAdapterModel: "support",
  RetryableErrorType: "errors",
  ModelRequestTimeoutError: "errors",
  ErrorClassification: "errors",
  classifyError: "errors",
  isRetryable: "errors",
  computeRetryDelay: "errors",
  AskUserResolveInput: "types",
  ToolApprovalInput: "types",
  AgentOrchestratorOptions: "types",
};

const HEADERS = {
  support: [
    "/**",
    " * Orchestrator 的模块级辅助函数：约束模式、provider 恢复文案、工具控制动作归一化、",
    " * 记忆 LLM 选项。",
    " *",
    " * 这些都不碰实例状态，因此不属于 class body；抽出来让 `orchestrator.ts` 专注于 run 本身。",
    " */",
  ],
  errors: [
    "/**",
    " * 模型调用的错误分类与重试策略。",
    " *",
    " * `classifyError` 决定一次失败的调用是否重试、以及等多久；",
    " * `ModelRequestTimeoutError` 是 orchestrator 自己抛出的那一种失败。",
    " */",
  ],
  types: [],
};

const original = fs.readFileSync(FILE, "utf8");
const sf = ts.createSourceFile(FILE, original, ts.ScriptTarget.ESNext, true);

const fileImports = new Map();
for (const stmt of sf.statements) {
  if (!ts.isImportDeclaration(stmt)) continue;
  const clause = stmt.importClause;
  if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
  for (const spec of clause.namedBindings.elements) {
    fileImports.set(spec.name.text, {
      source: stmt.moduleSpecifier.text,
      isType: clause.isTypeOnly || spec.isTypeOnly,
    });
  }
}

const decls = [];
for (const stmt of sf.statements) {
  if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) continue;
  if (ts.isClassDeclaration(stmt) && stmt.name?.text === "AgentOrchestrator") continue;
  let name;
  if (ts.isVariableStatement(stmt)) {
    if (stmt.declarationList.declarations.length !== 1) continue;
    name = stmt.declarationList.declarations[0].name.text;
  } else if (stmt.name && ts.isIdentifier(stmt.name)) {
    name = stmt.name.text;
  }
  if (!name || !MOVE[name]) continue;
  decls.push({
    name,
    module: MOVE[name],
    stmt,
    isType: ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt),
  });
}
const missing = Object.keys(MOVE).filter((n) => !decls.some((d) => d.name === n));
if (missing.length) throw new Error(`not found: ${missing.join(", ")}`);

// text chunks: from the previous statement's end (keeps JSDoc with its declaration)
const ordered = sf.statements.filter((s) => !ts.isImportDeclaration(s));
const chunkOf = new Map();
let prevEnd = 0;
for (const stmt of ordered) {
  const d = decls.find((x) => x.stmt === stmt);
  if (d) {
    const start = prevEnd === 0 ? stmt.getStart(sf) : prevEnd;
    chunkOf.set(d.name, original.slice(start, stmt.getEnd()).replace(/^[\s\r\n]+/, ""));
  }
  prevEnd = stmt.getEnd();
}

function refsOf(stmt) {
  const found = new Set();
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) || ts.isQualifiedName(node)) {
      ts.forEachChild(node.expression, visit);
      return;
    }
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node) ||
        (ts.isPropertySignature(p) && p.name === node) ||
        (ts.isPropertyDeclaration(p) && p.name === node) ||
        (ts.isMethodDeclaration(p) && p.name === node) ||
        (ts.isMethodSignature(p) && p.name === node) ||
        (ts.isVariableDeclaration(p) && p.name === node) ||
        (ts.isParameter(p) && p.name === node) ||
        (ts.isFunctionDeclaration(p) && p.name === node) ||
        (ts.isClassDeclaration(p) && p.name === node) ||
        (ts.isInterfaceDeclaration(p) && p.name === node) ||
        (ts.isTypeAliasDeclaration(p) && p.name === node) ||
        (ts.isTypeParameterDeclaration(p) && p.name === node);
      if (!isName) found.add(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(stmt);
  return found;
}

const byModule = new Map();
for (const d of decls) {
  if (!byModule.has(d.module)) byModule.set(d.module, []);
  byModule.get(d.module).push(d);
}

for (const [module, list] of byModule) {
  const own = new Set(list.map((d) => d.name));
  const refs = new Set();
  for (const d of list) for (const r of refsOf(d.stmt)) refs.add(r);

  const external = new Map();
  const internal = new Map();
  for (const r of refs) {
    if (own.has(r)) continue;
    if (fileImports.has(r)) {
      const info = fileImports.get(r);
      if (!external.has(info.source)) external.set(info.source, { type: new Set(), value: new Set() });
      external.get(info.source)[info.isType ? "type" : "value"].add(r);
      continue;
    }
    const owner = decls.find((d) => d.name === r);
    if (owner) {
      if (!internal.has(owner.module)) internal.set(owner.module, { type: new Set(), value: new Set() });
      internal.get(owner.module)[owner.isType ? "type" : "value"].add(r);
    }
  }

  const blocks = [];
  const emitBlock = (source, sets) => {
    const parts = [...[...sets.type].sort().map((t) => `type ${t}`), ...[...sets.value].sort()];
    if (parts.length) blocks.push(`import { ${parts.join(", ")} } from "${source}";`);
  };
  for (const [s, sets] of [...external].sort((a, b) => a[0].localeCompare(b[0]))) emitBlock(s, sets);
  for (const [m, sets] of [...internal].sort((a, b) => a[0].localeCompare(b[0]))) emitBlock(`./${m}.js`, sets);

  const lines = [...(HEADERS[module] ?? [])];
  if (blocks.length) lines.push(...blocks, "");
  for (const d of list) lines.push(chunkOf.get(d.name).trimEnd(), "");
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  const out = path.join(DIR, `${module}.ts`);
  const existing = fs.existsSync(out) ? fs.readFileSync(out, "utf8").trimEnd() : "";
  fs.writeFileSync(out, existing ? `${existing}\n\n${body}\n` : `${body}\n`);
  console.log(`  ${module}.ts <- ${list.length} declaration(s)`);
}

// ---- remove moved statements: merge overlapping spans first -----------------
const rawSpans = decls
  .map((d) => ({ start: d.stmt.getFullStart(), end: d.stmt.getEnd() }))
  .sort((a, b) => a.start - b.start);
const merged = [];
for (const s of rawSpans) {
  const last = merged[merged.length - 1];
  if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
  else merged.push({ ...s });
}
let out = original;
for (const { start, end } of [...merged].reverse()) out = out.slice(0, start) + out.slice(end);
out = out.replace(/\n{3,}/g, "\n\n");

const anchor = "export class AgentOrchestrator {";
if (!out.includes(anchor)) throw new Error("class anchor missing");
out = out.replace(
  anchor,
  `export type {\n  AgentOrchestratorOptions,\n  AskUserResolveInput,\n  ToolApprovalInput,\n} from "./orchestrator/types.js";\n\n${anchor}`,
);
fs.writeFileSync(FILE, out);

console.log(`orchestrator.ts: ${original.split("\n").length} -> ${out.split("\n").length} lines`);
console.log(`removed ${merged.length} merged span(s) for ${decls.length} declarations`);
