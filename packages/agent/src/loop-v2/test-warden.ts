import type { ShellSandboxConfig } from "@paw/harness";
import { runShellInWorkspace } from "@paw/harness";

import {
  type TestMapEntryV1,
  type TestMapV1,
  buildTestMapV1,
  findImpactedTests,
  renderImpactedTests,
} from "./test-map.js";

/**
 * Loop v2.1 测试守卫：基于代码-测试依赖图的确定性验证层。
 *
 * 三层结构（全部 host 执行，无模型调用，不拥有终局）：
 * 1. 开工安检：agent 进场前在基线上验证选中测试可执行；
 * 2. 改动即验证：产品文件被修改后，host 确定性执行受影响测试；
 * 3. 探针增强（在 verification-probe.ts 中使用 test map 上下文）。
 *
 * 参考：TDAD（arXiv:2603.17973）的静态映射 + 影响分析策略。
 * 动机（astropy-13977 两臂同坑）：改动 quantity.py 时，ufunc 契约
 * 测试未被模型自选——依赖图点名的确定性执行消除了自选偏差。
 */

export interface PreFlightResultV1 {
  readonly runnerExecutable: boolean;
  readonly environmentIssues: readonly string[];
  /** 基线可执行的测试文件（用于后续改动即验证的基线）。 */
  readonly runnableTestFiles: readonly string[];
  readonly note?: string;
}

export interface MutationVerificationResultV1 {
  readonly changedFiles: readonly string[];
  readonly impactedTests: readonly TestMapEntryV1[];
  readonly executed: readonly {
    readonly testFile: string;
    readonly command: string;
    readonly passed: boolean;
    readonly exitCode?: number;
    readonly output: string;
  }[];
  /** 全部通过则为 true；有失败则为 false；无受影响测试则为 true（免检）。 */
  readonly allPassed: boolean;
  readonly renderedSummary: string;
}

const PREFLIGHT_TIMEOUT_MS = 120_000;
const VERIFICATION_TIMEOUT_MS = 180_000;
const MAX_TESTS_PER_MUTATION = 5;

/**
 * Layer 1：开工安检。在 agent 开始工作前验证测试基础设施。
 * 环境问题在第一分钟暴露，而不是让模型烧 40 回合自己撞上去。
 */
export function preFlightTestInfrastructure(opts: {
  readonly workspaceRoot: string;
  readonly shellSandbox?: ShellSandboxConfig;
}): PreFlightResultV1 {
  const testMap = buildTestMapV1(opts.workspaceRoot);

  if (testMap.entries.length === 0) {
    return {
      runnerExecutable: false,
      environmentIssues: ["No test files found in the workspace"],
      runnableTestFiles: [],
      note: "[TestWarden] No Python test files detected; the test warden is inactive for this workspace.",
    };
  }

  // 选一个代表性测试做基线验证
  const sample = testMap.entries.slice(0, 1)[0]!;
  const result = runShellInWorkspace(opts.workspaceRoot, sample.testCommand, {
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    ...(opts.shellSandbox ? { shellSandbox: opts.shellSandbox } : {}),
    skipApprovalGate: true,
  });

  if (result.error) {
    return {
      runnerExecutable: false,
      environmentIssues: [`Test runner could not execute: ${result.error}`],
      runnableTestFiles: [],
      note: `[TestWarden] Attempted: ${sample.testCommand}. Environment issue detected before agent start.`,
    };
  }

  const output = [
    typeof result.stdout === "string" ? result.stdout : "",
    typeof result.stderr === "string" ? result.stderr : "",
  ].join("\n");

  // 检查是否含环境类错误
  const environmentIssues: string[] = [];
  if (/ModuleNotFoundError|ImportError/i.test(output)) {
    environmentIssues.push(
      `Import error during pre-flight: ${output.match(/(?:ModuleNotFoundError|ImportError)[^\n]{0,120}/)?.[0] ?? "unknown"}`,
    );
  }
  if (/no tests (?:ran|collected)/i.test(output)) {
    environmentIssues.push("No tests were collected; test discovery failed");
  }

  return {
    runnerExecutable: environmentIssues.length === 0,
    environmentIssues,
    runnableTestFiles: testMap.entries.map((e) => e.testFile),
    ...(environmentIssues.length > 0
      ? {
          note: `[TestWarden] Pre-flight: tests exist (${testMap.entries.length} files) but the runner has environment issues. These are workspace conditions, not code defects.`,
        }
      : {}),
  };
}

/**
 * Layer 2：改动即验证。产品文件被修改后，host 确定性执行受影响测试。
 * 由 mutation 事件触发（非时间表/非阈值），无模型调用。
 */
export function verifyImpactedTests(opts: {
  readonly workspaceRoot: string;
  readonly changedFiles: readonly string[];
  readonly shellSandbox?: ShellSandboxConfig;
  readonly testMap?: TestMapV1;
}): MutationVerificationResultV1 {
  const testMap = opts.testMap ?? buildTestMapV1(opts.workspaceRoot);
  const impacted = findImpactedTests(testMap, opts.changedFiles);

  if (impacted.length === 0) {
    return {
      changedFiles: opts.changedFiles,
      impactedTests: [],
      executed: [],
      allPassed: true,
      renderedSummary:
        "[TestWarden] No existing tests are linked to the changed files; deterministic regression check skipped.",
    };
  }

  const selected = impacted.slice(0, MAX_TESTS_PER_MUTATION);
  const executed: {
    testFile: string;
    command: string;
    passed: boolean;
    exitCode?: number;
    output: string;
  }[] = [];

  for (const entry of selected) {
    const result = runShellInWorkspace(opts.workspaceRoot, entry.testCommand, {
      timeoutMs: VERIFICATION_TIMEOUT_MS,
      ...(opts.shellSandbox ? { shellSandbox: opts.shellSandbox } : {}),
      skipApprovalGate: true,
    });

    if (result.error) {
      executed.push({
        testFile: entry.testFile,
        command: entry.testCommand,
        passed: false,
        output: `could not execute: ${result.error}`.slice(0, 600),
      });
      continue;
    }

    const output = [
      typeof result.stdout === "string" ? result.stdout : "",
      typeof result.stderr === "string" ? result.stderr : "",
    ].join("\n");

    executed.push({
      testFile: entry.testFile,
      command: entry.testCommand,
      passed: result.exit_code === 0,
      ...(typeof result.exit_code === "number"
        ? { exitCode: result.exit_code }
        : {}),
      output: output.slice(-1200),
    });
  }

  const failures = executed.filter((e) => !e.passed);
  const allPassed = failures.length === 0;

  const summaryParts: string[] = [];
  if (allPassed) {
    summaryParts.push(
      `[TestWarden] ${executed.length} impacted test file(s) all passed.`,
    );
  } else {
    summaryParts.push(
      `[TestWarden] ${failures.length}/${executed.length} impacted test file(s) FAILED:`,
    );
    for (const failure of failures) {
      summaryParts.push(
        `  FAIL ${failure.testFile} (exit=${failure.exitCode ?? "?"}): ${failure.output.slice(0, 300)}`,
      );
    }
  }
  const rendered = renderImpactedTests(impacted);
  if (rendered) {
    summaryParts.push(rendered);
  }

  return {
    changedFiles: opts.changedFiles,
    impactedTests: impacted,
    executed,
    allPassed,
    renderedSummary: summaryParts.join("\n"),
  };
}
