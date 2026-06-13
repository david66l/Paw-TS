/**
 * Test suite loader — resolves suite names to TestCase arrays.
 */

import type { TestCase, TestSuite } from "./types.js";
import { CORE_TOOLS_SUITE, SHELL_SAFETY_SUITE } from "./builtin/index.js";

const BUILTIN_SUITES: Record<string, TestCase[]> = {
  "core-tools": CORE_TOOLS_SUITE,
  "shell-safety": SHELL_SAFETY_SUITE,
};

/** List all available built-in suite names. */
export function listBuiltinSuites(): string[] {
  return Object.keys(BUILTIN_SUITES);
}

/** Load a built-in suite by name. Returns undefined if not found. */
export function loadBuiltinSuite(name: string): TestCase[] | undefined {
  return BUILTIN_SUITES[name];
}

/** Resolve a suite name — first checks builtins, then falls back to file loading. */
export function resolveSuite(name: string): TestCase[] | undefined {
  return loadBuiltinSuite(name);
}

/** Load test cases from a custom JSONL file path (future). */
export async function loadSuiteFromFile(_path: string): Promise<TestSuite> {
  throw new Error("File-based suite loading not yet implemented");
}
