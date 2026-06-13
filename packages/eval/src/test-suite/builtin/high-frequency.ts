/**
 * High-frequency request test suite.
 *
 * Covers: the most common daily dev tasks — package management,
 * git operations, testing, project navigation, configuration,
 * and quick one-shot code questions.
 */

import type { TestCase } from "../types.js";

export const HIGH_FREQ_SUITE: TestCase[] = [
  // ── Package management ──
  {
    id: "hf-001",
    category: "high_freq",
    capability: "tool_calling",
    name: "Install a dependency",
    goal: "在 packages/core 中安装 zod 作为 dependency",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "npm-install"],
  },
  {
    id: "hf-002",
    category: "high_freq",
    capability: "tool_calling",
    name: "Check which packages are outdated",
    goal: "检查项目中是否有过期的依赖包",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "npm-outdated"],
  },

  // ── Git operations ──
  {
    id: "hf-003",
    category: "high_freq",
    capability: "tool_calling",
    name: "Check what changed (git diff)",
    goal: "查看当前工作区相对于最后一次 commit 的差异",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.git_diff" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "git-diff"],
  },
  {
    id: "hf-004",
    category: "high_freq",
    capability: "tool_calling",
    name: "View git log with specific range",
    goal: "查看最近 3 条 commit 的详细信息",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.git_log" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "git-log"],
  },
  {
    id: "hf-005",
    category: "high_freq",
    capability: "tool_calling",
    name: "Commit staged changes",
    goal: "帮我提交当前暂存的修改，commit message 为 'chore: update dependencies'",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "git-commit"],
  },

  // ── Testing ──
  {
    id: "hf-006",
    category: "high_freq",
    capability: "tool_calling",
    name: "Run all tests",
    goal: "运行项目的所有测试",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "testing"],
  },
  {
    id: "hf-007",
    category: "high_freq",
    capability: "tool_calling",
    name: "Run a specific test file",
    goal: "只运行 packages/core 的测试",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "testing"],
  },
  {
    id: "hf-008",
    category: "high_freq",
    capability: "tool_calling",
    name: "Run typecheck",
    goal: "运行 TypeScript 类型检查，确认没有类型错误",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "typecheck"],
  },

  // ── Project navigation ──
  {
    id: "hf-009",
    category: "high_freq",
    capability: "tool_calling",
    name: "Find where a function is defined",
    goal: "ContextManager 的 buildMessages 方法在哪里定义的？",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.grep" } },
        { type: "output_contains", params: { text: "buildMessages" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "navigation"],
  },
  {
    id: "hf-010",
    category: "high_freq",
    capability: "tool_calling",
    name: "What does this package export?",
    goal: "列出 @paw/core 包导出了哪些东西",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "output_contains", params: { text: "export" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "api-exploration"],
  },
  {
    id: "hf-011",
    category: "high_freq",
    capability: "tool_calling",
    name: "Summarize project structure",
    goal: "给我一个项目整体结构的概述",
    expected: {
      rules: [
      // brief or list_dir both acceptable for project overview
        { type: "output_contains", params: { text: "packages" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "overview"],
  },

  // ── Code understanding ──
  {
    id: "hf-012",
    category: "high_freq",
    capability: "tool_calling",
    name: "Explain a function's purpose",
    goal: "解释 packages/agent/src/orchestrator.ts 中 executeTurn 方法的作用",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 2,
    tags: ["high-freq", "explain"],
  },
  {
    id: "hf-013",
    category: "high_freq",
    capability: "tool_calling",
    name: "Find usage examples of an API",
    goal: "展示项目中所有使用 ContextCompactor 的地方",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.grep" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "api-usage"],
  },
  {
    id: "hf-014",
    category: "high_freq",
    capability: "tool_calling",
    name: "Compare two files",
    goal: "比较 packages/core/src/context-manager.ts 和 packages/core/src/context-budget.ts 的功能差异",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 2,
    tags: ["high-freq", "compare"],
  },

  // ── Configuration ──
  {
    id: "hf-015",
    category: "high_freq",
    capability: "tool_calling",
    name: "Read project settings",
    goal: "查看 .paw/settings.local.json 的当前配置",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "config"],
  },
  {
    id: "hf-016",
    category: "high_freq",
    capability: "tool_calling",
    name: "Find project root",
    goal: "这个项目的根目录在哪里？paw root 是怎么确定的？",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "output_contains", params: { text: "paw" } },
      ],
    },
    difficulty: 2,
    tags: ["high-freq", "config"],
  },

  // ── Quick fixes ──
  {
    id: "hf-017",
    category: "high_freq",
    capability: "code_generation",
    name: "Fix a TypeScript compilation error",
    goal: "packages/core/src/eval-hooks.ts 报错说 ChatMessage 未找到。请检查 import 并修复。",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
      ],
    },
    difficulty: 2,
    tags: ["high-freq", "fix-compile"],
  },
  {
    id: "hf-018",
    category: "high_freq",
    capability: "tool_calling",
    name: "Lint the project",
    goal: "运行 lint 检查并告诉我有没有问题",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "lint"],
  },
  {
    id: "hf-019",
    category: "high_freq",
    capability: "code_generation",
    name: "Add a console.log for debugging",
    goal: "在 packages/agent/src/orchestrator.ts 的 executeTurn 方法开头添加一行 console.log 打印当前 turn 编号",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.edit_file" } },
        { type: "file_contains", params: { path: "packages/agent/src/orchestrator.ts", text: "console.log" } },
      ],
    },
    difficulty: 1,
    tags: ["high-freq", "debugging"],
  },
  {
    id: "hf-020",
    category: "high_freq",
    capability: "tool_calling",
    name: "Find and report file sizes",
    goal: "列出 packages/core/src/ 下最大的 3 个 .ts 文件（按行数排序）",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 2,
    tags: ["high-freq", "analysis"],
  },
];
