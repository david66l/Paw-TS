/**
 * EvalSettings — 评测系统配置
 * ==============================
 *
 * 【是什么】
 * 定义评测系统的配置接口及其默认值和解析函数。配置存储在 .paw/settings.local.json
 * 的 "eval" 键下，控制评测行为的各个方面。
 *
 * 【为什么】
 * 评测行为需要可调节的参数（重复次数、并行度、评分权重、通过阈值等）。
 * 将这些参数集中管理的好处：
 * - 用户无需每次在 CLI 中重复指定，配置即默认
 * - 不同项目可以有不同的评测标准（如对安全性要求高的项目调高 rule_weight）
 * - 权重可调意味着评分策略可以随项目成熟度演进
 *
 * 【关键设计决策】
 * 1. **passthrough 模式**：EvalSettings 的所有字段都是可选的（partial），
 *    通过 `resolveEvalSettings(overrides)` 合并默认值。这样 eval key 下
 *    的其他未知字段不会导致解析冲突，允许用户在同一 JSON 文件中配置
 *    其他模块。
 * 2. **分数权重设计**：rule_weight (0.6) + llm_weight (0.4) 合为 1，
 *    规则评分占比更高，因为规则评分是确定性的、更可靠的。LLM 评分
 *    作为补充来评估主观维度（流畅度、专业度等）。
 * 3. **默认重复 3 次**：每个测试用例重复运行 3 次以测量稳定性，这是
 *    统计意义上能给出有意义的变异系数的最小样本量。
 */

/** 评测系统配置项 */
export interface EvalSettings {
  /** LLM 评判模型标签（默认 "deepseek-chat"） */
  readonly judge_model?: string;
  /** 每个测试用例的默认重复次数（默认 3） */
  readonly default_repetitions?: number;
  /** 最大并行运行数（默认 4） */
  readonly parallel_runs?: number;
  /** 规则评分的权重，0–1（默认 0.6） */
  readonly rule_weight?: number;
  /** LLM 评分的权重，0–1（默认 0.4） */
  readonly llm_weight?: number;
  /** 通过阈值，0–100（默认 70） */
  readonly pass_threshold?: number;
}

/** 所有评测设置的默认值（所有字段均为 required） */
export const DEFAULT_EVAL_SETTINGS: Required<EvalSettings> = {
  judge_model: "deepseek-chat",
  default_repetitions: 3,
  parallel_runs: 4,
  rule_weight: 0.6,
  llm_weight: 0.4,
  pass_threshold: 70,
};

/**
 * 解析评测设置：将用户覆盖值与默认值合并。
 *
 * 典型的 spread 合并模式——用户只传部分字段，其余用默认值填充，
 * 保证返回的每个字段都有确定值（Required 类型）。
 */
export function resolveEvalSettings(
  overrides?: Partial<EvalSettings>,
): Required<EvalSettings> {
  return { ...DEFAULT_EVAL_SETTINGS, ...overrides };
}
