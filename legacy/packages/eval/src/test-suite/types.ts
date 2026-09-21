/**
 * Test Suite Types — 测试套件类型定义
 * =====================================
 *
 * 【是什么】
 * 定义评测系统测试用例的完整类型体系：从测试用例的结构（TestCase）、
 * 规则规范（RuleSpec）、LLM 评判配置（LlmJudgment），到高级抽象如
 * 评估维度（EvalDimension）、测试分类（TestCategory）、Agent 能力标签
 * （AgentCapability）等。
 *
 * 【为什么】
 * 评测系统需要一个表达力足够的 DSL（领域特定语言）来描述"什么是好的
 * Agent 行为"。这套类型提供了：
 * - 确定性检查（RuleSpec 的 10 种规则类型）
 * - 主观评估（LlmJudgment 的维度、参考答案、关键点、反面模式）
 * - 分类和标签（便于报告分组、选择性运行）
 * - 上下文设置（在大模型调用前准备文件和环境变量）
 *
 * 【关键设计决策】
 * 1. **规则类型覆盖**：10 种 RuleType 覆盖了工具调用检查、输出内容检查、
 *    文件操作检查和错误检查四大类，足以描述绝大多数 Agent 行为预期。
 * 2. **LLM 评判配置**：referenceAnswer 建立评分锚点，keyPoints/antiPatterns
 *    提供结构化的检查清单，减少裁判模型的主观偏差。
 * 3. **AgentCapability 标签**：每个测试用例标注其测试的能力维度
 *    （tool_calling/context_management/shell_safety 等），便于按能力筛选运行。
 * 4. **context 字段**：支持在运行用例前创建文件和设置环境变量，
 *    模拟真实的开发场景（如已有代码仓库、特定配置文件等）。
 */

// ── 评测维度 ──

/** LLM 评判的评估维度 */
export type EvalDimension =
  | "correctness"   // 正确性
  | "safety"        // 安全性
  | "conciseness"   // 简洁性
  | "helpfulness"   // 有帮助性
  | "compliance"    // 合规性
  | "accuracy"      // 精确性
  | "completeness"  // 完整性
  | "expertise"      // 专业度
  | "fluency";      // 流畅性

// ── 分类和标签 ──

/** 测试用例分类 */
export type TestCategory = "core" | "edge" | "adversarial" | "high_freq";

/** Agent 能力标签（用于分组运行） */
export type AgentCapability =
  | "tool_calling"
  | "context_management"
  | "memory_retrieval"
  | "shell_safety"
  | "code_generation"
  | "multi_step";

// ── 规则类型 ──

/** 规则类型枚举：10 种确定性检查 */
export type RuleType =
  | "tool_called"             // 指定工具被调用
  | "tool_not_called"         // 指定工具未被调用
  | "tool_args_match"         // 工具调用参数匹配
  | "shell_command_matches"   // Shell 命令匹配模式
  | "file_created"            // 文件被创建
  | "file_contains"           // 文件包含指定内容
  | "output_contains"         // 输出包含指定文本
  | "output_not_contains"     // 输出不包含指定文本
  | "output_matches_regex"    // 输出匹配正则
  | "no_error";               // 无工具执行错误

/** 规则参数的类型联合——不同规则类型有不同形状的参数 */
export type RuleParams =
  | { tool: string }
  | { tool: string; path?: string }
  | { pattern: string }
  | { path: string }
  | { text: string }
  | { regex: string }
  | Record<string, unknown>;

/** 规则规范：一条规则的定义 */
export interface RuleSpec {
  /** 规则类型 */
  readonly type: RuleType;
  /** 规则参数 */
  readonly params: RuleParams;
  /** 规则描述（可选，供报告展示） */
  readonly description?: string;
}

// ── LLM 评判配置 ──

/** LLM 裁判的评判配置 */
export interface LlmJudgment {
  /** 需要评估的维度列表（可覆盖默认的4个基础维度） */
  readonly dimensions?: EvalDimension[];
  /** 参考答案：帮助裁判模型理解"好"的标准 */
  readonly referenceAnswer?: string;
  /** 必须包含的关键点（checklist） */
  readonly keyPoints?: string[];
  /** 禁止出现的反面模式 */
  readonly antiPatterns?: string[];
}

// ── 测试用例 ──

/**
 * 单个测试用例定义。
 *
 * 一个测试用例描述了一个给 Agent 的自然语言任务（goal），
 * 以及如何评估 Agent 的表现（expected）。
 */
export interface TestCase {
  /** 唯一标识符 */
  readonly id: string;
  /** 测试分类 */
  readonly category: TestCategory;
  /** 测试的能力标签 */
  readonly capability: AgentCapability;
  /** 用例名称（供展示） */
  readonly name: string;
  /** 给 Agent 的自然语言目标/任务描述 */
  readonly goal: string;
  /** 可选的上下文设置：在运行前创建的文件和环境变量 */
  readonly context?: {
    /** 文件名 → 文件内容的映射 */
    readonly files?: Record<string, string>;
    /** 环境变量名 → 值的映射 */
    readonly env?: Record<string, string>;
  };
  /** 预期行为和评判标准 */
  readonly expected: {
    /** 确定性规则检查列表 */
    readonly rules?: RuleSpec[];
    /** LLM 主观评判配置 */
    readonly llmJudgment?: LlmJudgment;
  };
  /** 难度等级 1-10（1=最简单，10=最难） */
  readonly difficulty?: number;
  /** 标签列表（用于任意分组和筛选） */
  readonly tags?: string[];
}

// ── 测试套件 ──

/** 测试套件：一组相关测试用例的集合 */
export interface TestSuite {
  /** 套件名称 */
  readonly name: string;
  /** 套件描述 */
  readonly description: string;
  /** 测试用例列表 */
  readonly cases: TestCase[];
}
