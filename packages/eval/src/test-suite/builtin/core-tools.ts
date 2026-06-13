/**
 * Core tool-calling test suite.
 *
 * Covers: file reading, writing, editing, searching (grep/glob),
 * directory listing, git status, and basic multi-tool workflows.
 */

import type { TestCase } from "../types.js";

export const CORE_TOOLS_SUITE: TestCase[] = [
  // ── File reading ──
  {
    id: "core-tools-001",
    category: "core",
    capability: "tool_calling",
    name: "Read a known file",
    goal: "读取 packages/core/src/index.ts 的内容",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        {
          type: "tool_args_match",
          params: { path: "packages/core/src/index.ts" },
        },
      ],
    },
    difficulty: 1,
    tags: ["read", "basic"],
  },
  {
    id: "core-tools-002",
    category: "core",
    capability: "tool_calling",
    name: "Read a file that doesn't exist",
    goal: "读取不存在的文件 packages/core/src/nonexistent.ts，告诉我结果",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "output_contains", params: { text: "not found" } },
      ],
    },
    difficulty: 2,
    tags: ["read", "error"],
  },
  {
    id: "core-tools-003",
    category: "core",
    capability: "tool_calling",
    name: "Read file with offset and limit",
    goal: '读取 packages/core/src/context-manager.ts 的第100行到第150行',
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        {
          type: "tool_args_match",
          params: { path: "packages/core/src/context-manager.ts" },
        },
      ],
    },
    difficulty: 2,
    tags: ["read", "offset"],
  },

  // ── File writing ──
  {
    id: "core-tools-004",
    category: "core",
    capability: "tool_calling",
    name: "Create a simple file",
    goal: "在项目根目录下创建一个名为 hello.txt 的文件，内容为 'Hello, Paw!'",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.write_file" } },
        { type: "file_created", params: { path: "hello.txt" } },
        { type: "file_contains", params: { path: "hello.txt", text: "Hello, Paw!" } },
      ],
    },
    difficulty: 1,
    tags: ["write", "basic"],
  },
  {
    id: "core-tools-005",
    category: "core",
    capability: "tool_calling",
    name: "Write TypeScript file with proper syntax",
    goal: "在 src/ 下创建一个 utils.ts 文件，导出一个 add(a: number, b: number): number 函数",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.write_file" } },
        { type: "file_created", params: { path: "src/utils.ts" } },
        { type: "file_contains", params: { path: "src/utils.ts", text: "export function add" } },
      ],
    },
    difficulty: 2,
    tags: ["write", "typescript"],
  },

  // ── File editing ──
  {
    id: "core-tools-006",
    category: "core",
    capability: "tool_calling",
    name: "Edit a file — add export",
    goal: "在 packages/core/src/index.ts 最末尾添加一行: export * from './eval-hooks.js';",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.edit_file" } },
        { type: "file_contains", params: { path: "packages/core/src/index.ts", text: "export * from './eval-hooks.js'" } },
      ],
    },
    difficulty: 2,
    tags: ["edit", "basic"],
  },
  {
    id: "core-tools-007",
    category: "core",
    capability: "tool_calling",
    name: "Edit with context — replace function body",
    goal: "在 packages/core/src/errors.ts 中，找到 makeToolError 函数，将其返回值改为包含 timestamp 字段（使用 Date.now()）",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.edit_file" } },
        { type: "file_contains", params: { path: "packages/core/src/errors.ts", text: "timestamp" } },
        { type: "file_contains", params: { path: "packages/core/src/errors.ts", text: "Date.now()" } },
      ],
    },
    difficulty: 3,
    tags: ["edit", "typescript"],
  },

  // ── Search (grep) ──
  {
    id: "core-tools-008",
    category: "core",
    capability: "tool_calling",
    name: "Grep for a function definition",
    goal: "搜索项目中所有定义了 'executeTurn' 函数的位置",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.grep" } },
        { type: "output_contains", params: { text: "executeTurn" } },
      ],
    },
    difficulty: 1,
    tags: ["grep", "basic"],
  },
  {
    id: "core-tools-009",
    category: "core",
    capability: "tool_calling",
    name: "Grep with regex pattern",
    goal: "搜索所有包含 'TODO|FIXME|HACK' 注释的 .ts 文件",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.grep" } },
      ],
    },
    difficulty: 2,
    tags: ["grep", "regex"],
  },

  // ── Glob ──
  {
    id: "core-tools-010",
    category: "core",
    capability: "tool_calling",
    name: "Glob for TypeScript files",
    goal: "列出 packages/core/src/ 下所有 .ts 文件",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.glob" } },
        { type: "output_contains", params: { text: ".ts" } },
      ],
    },
    difficulty: 1,
    tags: ["glob", "basic"],
  },
  {
    id: "core-tools-011",
    category: "core",
    capability: "tool_calling",
    name: "Glob recursive with nested pattern",
    goal: "递归列出 packages/ 下所有名为 index.ts 的文件",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.glob" } },
        { type: "output_contains", params: { text: "index.ts" } },
      ],
    },
    difficulty: 2,
    tags: ["glob", "recursive"],
  },

  // ── Directory listing ──
  {
    id: "core-tools-012",
    category: "core",
    capability: "tool_calling",
    name: "List project root directory",
    goal: "列出项目根目录下的文件和目录",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.list_dir" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 1,
    tags: ["list", "basic"],
  },

  // ── Git operations ──
  {
    id: "core-tools-013",
    category: "core",
    capability: "tool_calling",
    name: "Check git status",
    goal: "查看当前的 git 状态",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.git_status" } },
      ],
    },
    difficulty: 1,
    tags: ["git", "basic"],
  },
  {
    id: "core-tools-014",
    category: "core",
    capability: "tool_calling",
    name: "Check recent git log",
    goal: "查看最近 5 条 git commit",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.git_log" } },
      ],
    },
    difficulty: 1,
    tags: ["git", "basic"],
  },

  // ── Multi-tool workflows ──
  {
    id: "core-tools-015",
    category: "core",
    capability: "tool_calling",
    name: "Read then edit (2-step workflow)",
    goal: "读取 packages/core/src/errors.ts，然后在文件末尾添加一行注释 // END",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "tool_called", params: { tool: "workspace.edit_file" } },
        { type: "file_contains", params: { path: "packages/core/src/errors.ts", text: "// END" } },
      ],
    },
    difficulty: 3,
    tags: ["workflow", "multi-step"],
  },
  {
    id: "core-tools-016",
    category: "core",
    capability: "tool_calling",
    name: "Search then read (information gathering)",
    goal: "先搜索项目中有哪些地方使用了 ContextManager，然后读取其中一个文件的相关代码",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.grep" } },
        { type: "tool_called", params: { tool: "workspace.read_file" } },
      ],
    },
    difficulty: 3,
    tags: ["workflow", "multi-step"],
  },
  {
    id: "core-tools-017",
    category: "core",
    capability: "tool_calling",
    name: "Write then verify (create + read-back)",
    goal: "创建一个文件 test-output.txt，写入 'verification test'，然后读取它确认内容正确",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.write_file" } },
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "output_contains", params: { text: "verification test" } },
      ],
    },
    difficulty: 3,
    tags: ["workflow", "verify"],
  },

  // ── Brief (project overview) ──
  {
    id: "core-tools-018",
    category: "core",
    capability: "tool_calling",
    name: "Get project overview",
    goal: "给我一个 packages/core/src/ 目录的概览",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.brief" } },
        { type: "output_contains", params: { text: ".ts" } },
      ],
    },
    difficulty: 1,
    tags: ["brief", "basic"],
  },

  // ── High-frequency scenarios ──
  {
    id: "core-tools-019",
    category: "high_freq",
    capability: "tool_calling",
    name: "Find and fix a typo (common dev task)",
    goal: "这个项目中有个拼写错误 'recieve'，帮我找到并改成 'receive'",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.grep" } },
        { type: "tool_called", params: { tool: "workspace.edit_file" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 2,
    tags: ["high-freq", "refactor"],
  },
  {
    id: "core-tools-020",
    category: "high_freq",
    capability: "tool_calling",
    name: "Add a TODO item and update plan",
    goal: "我需要重构 context-manager.ts，帮我把这个任务添加到 TODO 列表，然后创建一个计划",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.todo_write" } },
      ],
    },
    difficulty: 2,
    tags: ["high-freq", "planning"],
  },

  // ── Edge cases ──
  {
    id: "core-tools-021",
    category: "edge",
    capability: "tool_calling",
    name: "Read a very long file — should handle sensibly",
    goal: "读取 packages/agent/src/orchestrator.ts 的完整内容",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 2,
    tags: ["edge", "large-file"],
  },
  {
    id: "core-tools-022",
    category: "edge",
    capability: "tool_calling",
    name: "Grep with no matches",
    goal: "搜索项目中包含 'xyznonexistent12345' 的代码",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.grep" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 1,
    tags: ["edge", "no-match"],
  },
];
