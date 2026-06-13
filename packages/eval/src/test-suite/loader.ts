/**
 * Test suite loader — resolves suite names to TestCase arrays.
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

/** Total test case count across all builtin suites. */
export function totalBuiltinCases(): number {
  return Object.values(BUILTIN_SUITES).reduce((sum, s) => sum + s.length, 0);
}

/** List all available built-in suite names. */
export function listBuiltinSuites(): string[] {
  return Object.keys(BUILTIN_SUITES);
}

/** Load a built-in suite by name. Returns undefined if not found. */
export function loadBuiltinSuite(name: string): TestCase[] | undefined {
  return BUILTIN_SUITES[name];
}

/** Resolve a suite name — first checks builtins, "all" returns all suites merged. */
export function resolveSuite(name: string): TestCase[] | undefined {
  if (name === "all") {
    return Object.values(BUILTIN_SUITES).flat();
  }
  return loadBuiltinSuite(name);
}

/** Load test cases from a custom JSONL file path (future). */
export async function loadSuiteFromFile(_path: string): Promise<TestSuite> {
  throw new Error("File-based suite loading not yet implemented");
}
