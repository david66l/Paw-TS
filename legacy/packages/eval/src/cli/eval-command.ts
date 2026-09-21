/**
 * 评测 CLI 命令 — `paw eval run|list`
 * ========================================
 *
 * 【是什么】
 * 这是 paw-ts 评测系统（eval）的命令行入口，通过 `paw eval run|list` 子命令
 * 来触发评测的完整流程：运行测试套件、生成报告、导出训练数据。
 *
 * 【为什么】
 * 评测系统需要一个统一的 CLI 入口来调度整个评测流水线。通过命令行驱动，
 * 用户可以灵活指定套件名称、模型、重复次数、输出格式等参数，而无需
 * 直接编写代码调用内部 API。
 *
 * 【关键设计决策】
 * 1. **子命令路由**：通过 `subcommand` 字段分发到 `run`（执行评测）或
 *    `list`（列出可用套件），结构清晰易扩展。
 * 2. **模型解析策略**：优先从 settings.local.json 中按 provider 名称匹配
 *    模型配置（apiKey/baseUrl/model），找不到时回退到 `createDefaultLanguageModel`。
 *    这样既支持 DeepSeek、Qwen 等多厂商，也保证任何环境下都有兜底模型。
 * 3. **训练数据导出**：成功的评测运行可以通过 `--save-traces` 标志导出为
 *    ChatML JSONL 格式，用于微调模型。默认只导出 100% 满分的运行结果，
 *    确保训练数据质量。
 * 4. **通过率判定**：整体通过率 >= 70 视为 `ok: true`，这是 CLI 的退出码依据，
 *    可用于 CI/CD 流水线中的门禁判断。
 *
 * 接入位置：apps/cli/src/main.ts 通过 `eval` 子命令接入。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listBuiltinSuites, resolveSuite } from "../test-suite/loader.js";
import { EvalRunner, type EvalRunnerOptions } from "../runner.js";
import type { ReportFormat } from "../scorer/reporter.js";
import { exportSuccessfulRuns, toJsonl } from "../training-data-exporter.js";
import { createDefaultLanguageModel, OpenAICompatibleModel } from "@paw/models";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  resolveApiKey,
  resolveBaseUrl,
  resolveModel,
} from "@paw/settings";
import type { LanguageModel } from "@paw/models";
import {
  ChatClient,
  resolveLlmConfig,
  type LlmStats,
} from "@paw/memory/longterm";
import {
  runMemoryAdversarial,
  renderMemoryAdversarialReport,
} from "../memory-adversarial/index.js";
import {
  runSweExpBuiltin,
  renderSweExpReport,
  type SweExpMode,
} from "../swe-exp/index.js";

/** CLI 命令参数，由命令行解析后传入 */
export interface EvalCommandArgs {
  /** 子命令：'run' | 'list' | 'memory-adversarial' | 'swe-exp' */
  readonly subcommand: string;
  /** 要运行的测试套件名称 */
  readonly suite?: string;
  /** 每个测试用例的重复次数（稳定性测试） */
  readonly repetitions?: number;
  /** 指定模型名称/provider，如 "deepseek"、"qwen" */
  readonly model?: string;
  /** 输出格式：console|markdown|json */
  readonly output?: string;
  /** 并行运行上限（默认 4） */
  readonly parallel?: number;
  /** 工作区根目录（默认为当前目录） */
  readonly workspaceRoot?: string;
  /** 是否在隔离的 git worktree 中运行（沙箱模式） */
  readonly sandbox?: boolean;
  /** 训练数据导出路径（JSONL 格式） */
  readonly saveTraces?: string;
  /** memory-adversarial：judge 模型 provider（默认同 --model） */
  readonly judgeProvider?: string;
  /** memory-adversarial / swe-exp：JSON 输出 */
  readonly json?: boolean;
  /** memory-adversarial / swe-exp：保留 DB 数据与临时工作区 */
  readonly keep?: boolean;
  /** memory-adversarial / swe-exp：最多运行夹具/对数 */
  readonly maxSamples?: number;
  /** memory-adversarial：per-fixture 超时（毫秒） */
  readonly timeoutMs?: number;
  /** swe-exp：fake | deterministic | agent（默认 deterministic） */
  readonly sweExpMode?: SweExpMode;
  /** swe-exp：报告写出路径 */
  readonly reportPath?: string;
  /** swe-exp agent：续跑 suite run id */
  readonly suiteRunId?: string;
  /** swe-exp agent：跳过 Docker harness */
  readonly skipHarness?: boolean;
  /** swe-exp agent：max steps */
  readonly maxSteps?: number;
}

/**
 * 评测命令的主入口函数。
 *
 * 根据 subcommand 分发到具体的处理函数：
 * - `run`：执行指定测试套件
 * - `list`：列出所有内置测试套件
 *
 * @returns 包含 ok（是否成功）和 text（输出文本）的结果对象
 */
export async function runEvalCommand(
  args: EvalCommandArgs,
): Promise<{ ok: boolean; text: string }> {
  switch (args.subcommand) {
    case "run":
      return runEval(args);
    case "list":
      return listSuites();
    case "memory-adversarial":
      return runMemoryAdversarialCommand(args);
    case "swe-exp":
      return runSweExpCommand(args);
    default:
      return {
        ok: false,
        text: `Unknown eval subcommand: ${args.subcommand}\nUsage: paw eval run|list|memory-adversarial|swe-exp`,
      };
  }
}

/**
 * 执行评测的核心流程：
 * 1. 解析并加载测试套件
 * 2. 确定报告格式
 * 3. 解析/创建语言模型
 * 4. 通过 EvalRunner 运行套件
 * 5. 可选：导出训练数据（ChatML JSONL）
 * 6. 返回结果
 */
async function runEval(
  args: EvalCommandArgs,
): Promise<{ ok: boolean; text: string }> {
  const suiteName = args.suite;
  if (!suiteName) {
    return { ok: false, text: "Usage: paw eval run --suite <name>" };
  }

  const cases = resolveSuite(suiteName);
  if (!cases || cases.length === 0) {
    const available = listBuiltinSuites().join(", ");
    return {
      ok: false,
      text: `Suite "${suiteName}" not found. Available: ${available || "(none)"}`,
    };
  }

  // 根据 --output 参数映射到 ReportFormat 枚举
  const reportFormat: ReportFormat = (() => {
    switch (args.output) {
      case "markdown":
        return "markdown";
      case "json":
        return "json";
      default:
        return "console";
    }
  })();

  // 解析模型：优先从 settings 中按 provider 名称匹配具体配置，
  // 未指定时使用默认检测（环境变量/配置文件自动发现）
  const model = resolveEvalModel(args.workspaceRoot ?? process.cwd(), args.model);

  // 构建 EvalRunner 配置
  const runnerOpts: EvalRunnerOptions = {
    model,
    workspaceRoot: args.workspaceRoot,
    sandbox: args.sandbox,
    settings: {
      default_repetitions: args.repetitions,
      ...(args.parallel ? { parallel_runs: args.parallel } : {}),
    },
    reportFormat,
    onProgress: (testCaseId, rep, _total) => {
      // 最小化进度输出
      process.stderr.write(`  ${testCaseId} rep ${rep}...\n`);
    },
  };

  const runner = new EvalRunner(runnerOpts);

  try {
    const result = await runner.runSuite(suiteName, cases);

    // 如果指定了 --save-traces，将成功的评测运行导出为训练数据
    if (args.saveTraces && result.allRecords.length > 0) {
      const conversations = exportSuccessfulRuns(
        result.allRecords,
        result.aggregateReports,
        100,  // 只导出满分（100%）的运行结果作为训练数据
      );
      if (conversations.length > 0) {
        const jsonl = toJsonl(conversations);
        writeFileSync(args.saveTraces, jsonl + "\n", "utf-8");
        console.log(
          `\n[export] Saved ${conversations.length} training conversations to ${args.saveTraces}`,
        );
      }
    }

    // 整体通过率 >= 70 视为成功（用于 CI 门禁）
    return { ok: result.overallPassRate >= 70, text: result.formattedReport };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `Eval run failed: ${msg}` };
  }
}

/**
 * 列出所有可用的内置测试套件，包含每个套件的用例数量。
 * 同时展示 "all" 虚拟套件（合并所有套件）。
 */
function listSuites(): { ok: boolean; text: string } {
  const names = listBuiltinSuites();
  if (names.length === 0) {
    return { ok: true, text: "No built-in test suites available." };
  }
  const lines = ["Available test suites:"];
  let total = 0;
  for (const name of names) {
    const suite = resolveSuite(name);
    const count = suite?.length ?? 0;
    total += count;
    lines.push(`  - ${name} (${count} cases)`);
  }
  lines.push(`  - all (${total} cases total)`);
  return { ok: true, text: lines.join("\n") };
}

/**
 * M10「先答→纠错」端到端反事实评测（spec §11.4 完整版）。
 *
 * 装配：agent 模型用 resolveEvalModel（OpenAICompatibleModel），judge 用
 * resolveLlmConfig + ChatClient（@paw/memory/longterm，60s 超时、共享 stats）。
 * 返回 ok = passed===true；passed null（无 judged 样本）/ false → fail-closed。
 */
async function runMemoryAdversarialCommand(
  args: EvalCommandArgs,
): Promise<{ ok: boolean; text: string }> {
  const cwd = args.workspaceRoot ?? process.cwd();
  const stats: LlmStats = {
    calls: 0,
    retries: 0,
    failures: 0,
    totalMs: 0,
    estimatedTokens: 0,
  };
  const judgeProvider = args.judgeProvider ?? args.model;
  const judgeCfg = resolveLlmConfig({ provider: judgeProvider, cwd });
  if ("error" in judgeCfg) {
    return { ok: false, text: judgeCfg.error };
  }
  const judge = new ChatClient(judgeCfg, 60_000, stats);
  const model = resolveEvalModel(cwd, args.model);

  try {
    const report = await runMemoryAdversarial({
      model,
      judge,
      provider: args.model,
      judgeProvider,
      maxSamples: args.maxSamples,
      keep: args.keep,
      fixtureTimeoutMs: args.timeoutMs,
      stats,
    });
    const text = args.json
      ? JSON.stringify(report, null, 2)
      : renderMemoryAdversarialReport(report);
    return { ok: report.passed === true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `memory-adversarial run failed: ${msg}` };
  }
}

/**
 * SWE-Exp 配对：同一 probe 上 memory on/off，核心指标 = 最终测试是否通过。
 * 默认 deterministic（需 DATABASE_URL）；`--mode fake` 纯冒烟不碰库。
 */
async function runSweExpCommand(
  args: EvalCommandArgs,
): Promise<{ ok: boolean; text: string }> {
  const mode = args.sweExpMode ?? "deterministic";
  try {
    const report = await runSweExpBuiltin({
      mode,
      maxPairs: args.maxSamples,
      keep: args.keep,
      repoRoot: args.workspaceRoot ?? process.cwd(),
      suiteRunId: args.suiteRunId,
      maxSteps: args.maxSteps,
      timeoutMs: args.timeoutMs,
      modelProvider: args.model,
      skipHarness: args.skipHarness,
    });
    const cwd = args.workspaceRoot ?? process.cwd();
    const outPath =
      args.reportPath ??
      join(cwd, "benchmarks", "swe-exp", "last-run.json");
    try {
      writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch {
      /* 目录可能不存在；仍返回报告正文 */
    }
    const text = args.json
      ? JSON.stringify(report, null, 2)
      : `${renderSweExpReport(report)}\n(report → ${outPath})`;
    return { ok: report.passed === true, text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `swe-exp run failed: ${msg}` };
  }
}

/**
 * 从 settings 配置中解析语言模型。
 *
 * 解析策略（按优先级）：
 * 1. 如果指定了 providerName，在 settings.local.json 的 models 字段中
 *    查找对应的配置（apiKey/baseUrl/model 等），使用 OpenAICompatibleModel 创建
 * 2. 找不到指定 provider 时，回退到 createDefaultLanguageModel 自动检测
 *
 * 设计原因：评测需要对不同模型（DeepSeek、Qwen、OpenAI 等）进行对比，
 * 因此必须支持从配置中精确指定模型参数，同时保留默认检测的兜底能力。
 */
function resolveEvalModel(
  workspaceRoot: string,
  providerName?: string,
): LanguageModel {
  // 未指定 provider → 使用默认检测逻辑
  if (!providerName) {
    return createDefaultLanguageModel(workspaceRoot);
  }

  try {
    const settingsPath = defaultSettingsPath(workspaceRoot);
    const s = loadPawSettingsLocal(settingsPath);
    const provider = providerName.toLowerCase();

    // 在 settings.models 中查找指定 provider 的配置
    const providers = s.models as Record<string, Record<string, unknown>> | undefined;
    const providerConfig = providers?.[provider];

    if (providerConfig) {
      const apiKey = resolveApiKey(s, provider as never) || String(providerConfig.apiKey ?? "");
      const baseUrl = resolveBaseUrl(s, provider as never) || String(providerConfig.baseUrl ?? "https://api.deepseek.com");
      const modelId = resolveModel(s, provider as never, String(providerConfig.model ?? "deepseek-chat"));

      // 使用 OpenAICompatibleModel（兼容 DeepSeek、Qwen 及 OpenAI 等符合 OpenAI API 规范的厂商）
      return new OpenAICompatibleModel({
        apiKey,
        baseUrl,
        model: modelId,
        capabilities: { contextWindow: 128_000, maxOutputTokens: 8_192 },
      });
    }

    // 配置中找不到该 provider，回退到默认模型
    console.warn(`[paw eval] Provider "${providerName}" not found in settings. Using default model.`);
  } catch (e) {
    console.warn(`[paw eval] Failed to resolve model "${providerName}": ${e instanceof Error ? e.message : String(e)}. Using default.`);
  }

  return createDefaultLanguageModel(workspaceRoot);
}
