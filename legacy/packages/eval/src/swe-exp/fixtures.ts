/**
 * SWE-Exp builtin 迷你配对夹具（无 Docker / 无 HF）
 *
 * 每对：broken workspace + 历史失败经验（episodic 形态 seed）+ 已知补丁。
 * deterministic 模式：memory on 且召回 → 应用补丁 → 跑测试；off → 不打补丁。
 * 核心指标仍是「最终测试是否通过」。
 */

export interface SweExpWorkspaceFile {
  readonly path: string;
  readonly content: string;
}

export interface SweExpHistoryLesson {
  readonly title: string;
  /** 写入 memory summary；须与 probe goal 共享检索 trigram */
  readonly summary: string;
  readonly whenToUse: string;
  readonly perspective: string;
  readonly modification: string;
}

export interface SweExpBuiltinPair {
  readonly id: string;
  readonly repo: string;
  readonly historyId: string;
  readonly probeId: string;
  readonly goal: string;
  readonly lesson: SweExpHistoryLesson;
  readonly workspaceFiles: readonly SweExpWorkspaceFile[];
  /** 相对 workspace 的补丁文件覆盖（memory on 确定性求解器用） */
  readonly fixFiles: readonly SweExpWorkspaceFile[];
  /** 测试入口：node 执行，exit 0 = resolved */
  readonly testScript: string;
  /** fake 模式预设结局（不跑真实测试） */
  readonly fakeOffResolved: boolean;
  readonly fakeOnResolved: boolean;
}

const SUM_SCRIPT = `const assert = require("node:assert");
const { add } = require("./calc.js");
assert.strictEqual(add(2, 2), 4);
assert.strictEqual(add(-1, 1), 0);
console.log("ok");
`;

const BOUND_SCRIPT = `const assert = require("node:assert");
const { clamp } = require("./clamp.js");
assert.strictEqual(clamp(5, 0, 10), 5);
assert.strictEqual(clamp(-1, 0, 10), 0);
assert.strictEqual(clamp(99, 0, 10), 10);
console.log("ok");
`;

export const SWE_EXP_BUILTIN_PAIRS: readonly SweExpBuiltinPair[] = [
  {
    id: "pair-add-off-by-one",
    repo: "demo/calc",
    historyId: "demo__calc-hist-add",
    probeId: "demo__calc-probe-add",
    goal: "Fix add() so unit tests for integer addition pass",
    lesson: {
      title: "add off-by-one in calc",
      summary:
        "Fix add() so unit tests for integer addition pass: bug was returning a+b+1; correct modification is return a + b.",
      whenToUse: "add() unit tests fail or integer addition returns wrong sum",
      perspective:
        "Prior similar issue: tests expected a+b but implementation added an extra +1.",
      modification: "In calc.js export function add(a,b){ return a + b; }",
    },
    workspaceFiles: [
      {
        path: "calc.js",
        content: "exports.add = function add(a, b) {\n  return a + b + 1;\n};\n",
      },
      { path: "test-add.js", content: SUM_SCRIPT },
      {
        path: "package.json",
        content: JSON.stringify({ name: "demo-calc", type: "commonjs" }, null, 2),
      },
    ],
    fixFiles: [
      {
        path: "calc.js",
        content: "exports.add = function add(a, b) {\n  return a + b;\n};\n",
      },
    ],
    testScript: "test-add.js",
    fakeOffResolved: false,
    fakeOnResolved: true,
  },
  {
    id: "pair-clamp-bounds",
    repo: "demo/clamp",
    historyId: "demo__clamp-hist",
    probeId: "demo__clamp-probe",
    goal: "Fix clamp() so values outside [lo, hi] are bounded correctly",
    lesson: {
      title: "clamp missing upper bound",
      summary:
        "Fix clamp() so values outside [lo, hi] are bounded correctly: use Math.min(hi, Math.max(lo, x)). Use when clamp unit tests fail.",
      whenToUse: "clamp() unit tests fail on upper or lower bound",
      perspective:
        "Prior issue only applied Math.max(lo, x) and forgot the hi cap.",
      modification:
        "exports.clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));",
    },
    workspaceFiles: [
      {
        path: "clamp.js",
        content:
          "exports.clamp = function clamp(x, lo, hi) {\n  return Math.max(lo, x);\n};\n",
      },
      { path: "test-clamp.js", content: BOUND_SCRIPT },
      {
        path: "package.json",
        content: JSON.stringify({ name: "demo-clamp", type: "commonjs" }, null, 2),
      },
    ],
    fixFiles: [
      {
        path: "clamp.js",
        content:
          "exports.clamp = function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x));\n};\n",
      },
    ],
    testScript: "test-clamp.js",
    fakeOffResolved: false,
    fakeOnResolved: true,
  },
];

/** goal 与 lesson.summary 至少共享 2 个长度≥3 token（检索门槛启发式） */
export function lessonGoalOverlap(goal: string, summary: string): number {
  const tok = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3),
    );
  const A = tok(goal);
  const B = tok(summary);
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n;
}
