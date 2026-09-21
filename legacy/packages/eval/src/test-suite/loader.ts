/**
 * Test Suite Loader — 测试套件加载器
 * =====================================
 *
 * 【是什么】
 * 管理内置测试套件的注册和按名加载。将套件名称映射到 TestCase 数组，
 * 支持单独加载、合并加载（"all" 关键字）以及未来的文件加载。
 *
 * 【为什么】
 * 评测系统需要一种方式来组织和查找测试套件。加载器作为套件的"注册表"：
 * - 解耦了套件定义和套件使用
 * - 支持 CLI 中按名称查找套件
 * - "all" 关键字让用户可以一次性运行全部评测
 * - 为未来的自定义套件（从 JSONL 文件加载）预留了接口
 *
 * 【关键设计决策】
 * 1. **静态注册表（BUILTIN_SUITES）**：内置套件通过 Record 映射存储，
 *    而非动态发现（如文件扫描）。这确保了评测的确定性——在任何环境下
 *    可用的套件列表是一致的。添加新套件时显式在 BUILDIN_SUITES 中注册。
 * 2. **"all" 关键字**：resolveSuite("all") 将全部内置套件的用例合并到一个
 *    数组中。这在 CI/CD 流水线中非常方便，无需逐一指定每个套件。
 * 3. **loadSuiteFromFile 预留**：当前抛出 "not yet implemented" 错误，
 *    这是未来支持从 JSONL 文件加载自定义测试套件的接口占位。
 */

import type { TestCase, TestSuite } from "./types.js";
import {
  CORE_TOOLS_SUITE,
  SHELL_SAFETY_SUITE,
  CONTEXT_MGMT_SUITE,
  MEMORY_RETRIEVAL_SUITE,
  CODE_GEN_SUITE,
  MULTI_STEP_SUITE,
  ADVERSARIAL_SUITE,
  HIGH_FREQ_SUITE,
} from "./builtin/index.js";

/** 内置测试套件注册表：名称 → TestCase 数组 */
const BUILTIN_SUITES: Record<string, TestCase[]> = {
  "core-tools": CORE_TOOLS_SUITE,
  "shell-safety": SHELL_SAFETY_SUITE,
  "context-mgmt": CONTEXT_MGMT_SUITE,
  "memory-retrieval": MEMORY_RETRIEVAL_SUITE,
  "code-gen": CODE_GEN_SUITE,
  "multi-step": MULTI_STEP_SUITE,
  "adversarial": ADVERSARIAL_SUITE,
  "high-frequency": HIGH_FREQ_SUITE,
};

/** 所有内置套件的测试用例总数 */
export function totalBuiltinCases(): number {
  return Object.values(BUILTIN_SUITES).reduce((sum, s) => sum + s.length, 0);
}

/** 列出所有可用的内置套件名称（按注册顺序） */
export function listBuiltinSuites(): string[] {
  return Object.keys(BUILTIN_SUITES);
}

/** 按名称加载内置套件。未找到时返回 undefined */
export function loadBuiltinSuite(name: string): TestCase[] | undefined {
  return BUILTIN_SUITES[name];
}

/**
 * 按名称解析测试套件。
 *
 * - 先查内置套件
 * - "all" 返回所有内置套件的用例合并（flat）
 * - 未找到返回 undefined
 */
export function resolveSuite(name: string): TestCase[] | undefined {
  if (name === "all") {
    return Object.values(BUILTIN_SUITES).flat();
  }
  return loadBuiltinSuite(name);
}

/**
 * 从自定义 JSONL 文件加载测试套件（未来功能）。
 *
 * 当前为占位实现，抛出错误提示尚未实现。
 * 未来的 JSONL 格式可能为每行一个 TestCase JSON 对象。
 */
export async function loadSuiteFromFile(_path: string): Promise<TestSuite> {
  throw new Error("File-based suite loading not yet implemented");
}
