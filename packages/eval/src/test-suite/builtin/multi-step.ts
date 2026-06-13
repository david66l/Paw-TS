/**
 * Multi-step workflow test suite.
 *
 * Covers: 3+ step workflows with branching, conditional execution,
 * parallel tool use, sub-agent spawning, and complex task orchestration.
 */

import type { TestCase } from "../types.js";

export const MULTI_STEP_SUITE: TestCase[] = [
  // ── Core ──
  {
    id: "multi-001",
    category: "core",
    capability: "multi_step",
    name: "Three-step: search → read → edit",
    goal: "找到所有导入 ContextManager 的文件，选择其中一个，在它的导入语句上方添加一行注释 '// ContextManager consumer'",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.grep" } },
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "tool_called", params: { tool: "workspace.edit_file" } },
        { type: "file_contains", params: { path: "packages/agent/src/orchestrator.ts", text: "ContextManager consumer" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 4,
    tags: ["workflow", "3-step"],
  },
  {
    id: "multi-002",
    category: "core",
    capability: "multi_step",
    name: "Create + test + fix workflow",
    goal: "1) 创建 src/math-utils.ts 导出 multiply(a,b) 函数，2) 创建对应的测试文件 test/math-utils.test.ts，3) 运行测试，4) 如果测试失败修复代码",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.write_file" } },
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
        { type: "no_error", params: {} },
      ],
      llmJudgment: {
        dimensions: ["correctness", "completeness"],
        keyPoints: ["Creates both source and test files", "Runs tests and reports results"],
      },
    },
    difficulty: 5,
    tags: ["workflow", "tdd"],
  },
  {
    id: "multi-003",
    category: "core",
    capability: "multi_step",
    name: "Investigate and report bug pattern",
    goal: "项目中有一些 TypeScript 文件缺少 'readonly' 修饰符。请 1) 搜索 agent/src/orchestrator.ts 中的 public 字段，2) 搜索 core/src/context-manager.ts 中的 public 字段，3) 对比两者的 readonly 使用情况，4) 给出统一建议",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "no_error", params: {} },
      ],
      llmJudgment: {
        dimensions: ["completeness", "expertise"],
        keyPoints: ["Compares both files", "Gives actionable recommendation"],
      },
    },
    difficulty: 5,
    tags: ["workflow", "investigation"],
  },

  // ── Edge ──
  {
    id: "multi-004",
    category: "edge",
    capability: "multi_step",
    name: "Conditional branching based on tool result",
    goal: "搜索项目中所有 TODO 注释。如果找到 5 个以上，列出前 5 个；如果少于 5 个，列出全部并说 '项目很干净'",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.grep" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 3,
    tags: ["edge", "conditional"],
  },
  {
    id: "multi-005",
    category: "edge",
    capability: "multi_step",
    name: "Recover from mid-workflow error",
    goal: "1) 创建一个新目录 src/refactor-tmp/，2) 在里面创建一个文件，3) 运行 typecheck，4) 清理临时文件（删除 src/refactor-tmp/ 目录）",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.write_file" } },
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 4,
    tags: ["edge", "cleanup"],
  },
  {
    id: "multi-006",
    category: "edge",
    capability: "multi_step",
    name: "Large-scale refactoring plan execution",
    goal: "将所有 packages/core/src/ 下的 .ts 文件中的 'interface' 导出都加上 readonly 修饰符。请先列出所有文件，再逐个处理。",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.glob" } },
        { type: "no_error", params: {} },
      ],
      llmJudgment: {
        dimensions: ["completeness", "safety"],
        keyPoints: ["Should plan before executing", "Should operate on correct file set"],
      },
    },
    difficulty: 6,
    tags: ["edge", "large-refactor"],
  },

  // ── Adversarial ──
  {
    id: "multi-007",
    category: "adversarial",
    capability: "multi_step",
    name: "Circular dependency — do not infinite loop",
    goal: "A 文件导入 B，B 导入 C，C 导入 A。帮我分析这个循环依赖问题并修复。涉及的三个文件是 packages/core/src/index.ts, packages/agent/src/index.ts, packages/harness/src/index.ts",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 5,
    tags: ["adversarial", "circular-dep"],
  },
  {
    id: "multi-008",
    category: "adversarial",
    capability: "multi_step",
    name: "Task that requires all tools to fail",
    goal: "依次尝试读取 5 个不存在的文件，每失败一次就换一个路径格式再试，直到所有 5 个都失败了，然后告诉我结果",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 4,
    tags: ["adversarial", "all-fail"],
  },

  // ── High frequency ──
  {
    id: "multi-009",
    category: "high_freq",
    capability: "multi_step",
    name: "Dependency update workflow",
    goal: "检查 packages/ 下各个 package.json 的依赖版本，看是否有可以合并统一的版本号差异，给出建议",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.glob" } },
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 4,
    tags: ["high-freq", "dependencies"],
  },
  {
    id: "multi-010",
    category: "high_freq",
    capability: "multi_step",
    name: "New feature implementation workflow",
    goal: "给 paw-ts 添加一个简单的健康检查功能。需要：1) 阅读现有代码了解结构 2) 创建 health-check.ts 3) 注册到 index.ts 4) 确认没有破坏现有编译",
    expected: {
      rules: [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "tool_called", params: { tool: "workspace.write_file" } },
        { type: "tool_called", params: { tool: "workspace.edit_file" } },
        { type: "tool_called", params: { tool: "workspace.run_shell" } },
        { type: "no_error", params: {} },
      ],
    },
    difficulty: 5,
    tags: ["high-freq", "feature"],
  },
];
