/**
 * Token 成本追踪 —— 按模型和运行次数统计费用。
 *
 * 【模块职责】
 * 跟踪每次 LLM 调用的 token 消耗并估算费用。支持：
 * - DeepSeek 官方人民币（CNY）定价（区分 cache-hit / cache-miss）
 * - Anthropic / OpenAI 等美元（USD）模型定价
 * - 自定义模型定价表
 *
 * 【为什么存在】
 * LLM 调用成本是 AI 应用运营的核心关注点。在开发/调试阶段需要知道每次对话花了多少钱；
 * 在生产环境中需要按模型、按用户、按会话聚合成本数据。这个模块提供了统一的成本估算接口。
 *
 * 【关键设计决策】
 * - **区分 cache-hit 和 cache-miss 定价**：DeepSeek（可能还有其他厂商）对缓存命中的
 *   prompt token 收费远低于未命中的。如果不区分会导致成本估算严重偏差。当模型只提供
 *   `promptPer1M`（统一价格）时，cache-hit 回退到 cache-miss 价格（安全侧高估）。
 * - **模型键值模糊匹配**：`resolveModelPricing` 支持多种匹配策略——
 *   精确匹配 → 关键词包含匹配 → 双向外键匹配 → 平均值回退。
 *   这是因为不同 API 对同一模型可能用不同命名（如 `deepseek-chat` vs `DeepSeek-Chat:v2`）。
 * - **计费精度**：费用计算后通过 `Math.round(cost * 1_000_000) / 1_000_000`
 *   保留 6 位小数，避免浮点累加误差。
 * - **CostTracker 类**：单线程安全（同步方法，无异步状态），适合在请求上下文中
 *   实例化并复用。
 * - `estimatedCostUsd` 字段已标记 `@deprecated`，保留仅为向后兼容。
 *
 * 【DeepSeek V4 定价参考（CNY/百万 tokens）】
 *   - Flash: prompt-cache-hit 0.02, prompt-cache-miss 1, completion 2
 *   - Pro:   prompt-cache-hit 0.025, prompt-cache-miss 3, completion 6
 */

/** 货币类型：人民币或美元 */
export type CostCurrency = "CNY" | "USD";

/** 单个模型的定价配置 */
export interface ModelPricing {
  /** 计费货币（默认 USD） */
  readonly currency?: CostCurrency;
  /** 从前缀缓存服务的输入 token 单价（每百万） */
  readonly promptCacheHitPer1M?: number;
  /** 未从缓存服务的输入 token 单价（每百万） */
  readonly promptCacheMissPer1M?: number;
  /** 旧版统一输入价格 —— 当拆分价格缺失时作为 cache-miss 使用 */
  readonly promptPer1M?: number;
  /** 输出 token 单价（每百万） */
  readonly completionPer1M: number;
}

/** 某个时刻的成本快照 */
export interface CostSnapshot {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** 估算费用（当前货币） */
  readonly estimatedCost: number;
  readonly costCurrency: CostCurrency;
  /** @deprecated 与 estimatedCost 相同；保留名称仅为兼容旧调用方 */
  readonly estimatedCostUsd: number;
}

/** 单次 API 调用的用量记录 */
export interface UsageRecord {
  /** 输入的 prompt token 数 */
  readonly promptTokens?: number;
  /** 输出的 completion token 数 */
  readonly completionTokens?: number;
  /** 命中缓存的 prompt token 数 */
  readonly cachedPromptTokens?: number;
}

// ═══════════════════════════════════════════════════
// DeepSeek 定价表（人民币 CNY / 百万 tokens）
// ═══════════════════════════════════════════════════

/** DeepSeek V4-Flash 定价：百万 token 缓存命中 ¥0.02，未命中 ¥1，输出 ¥2 */
const DEEPSEEK_V4_FLASH: ModelPricing = {
  currency: "CNY",
  promptCacheHitPer1M: 0.02,
  promptCacheMissPer1M: 1,
  completionPer1M: 2,
};

/** DeepSeek V4-Pro 定价：百万 token 缓存命中 ¥0.025，未命中 ¥3，输出 ¥6 */
const DEEPSEEK_V4_PRO: ModelPricing = {
  currency: "CNY",
  promptCacheHitPer1M: 0.025,
  promptCacheMissPer1M: 3,
  completionPer1M: 6,
};

/** DeepSeek 标准定价（V3、Reasoner、通用 chat） */
const DEEPSEEK_STANDARD: ModelPricing = {
  currency: "CNY",
  promptCacheHitPer1M: 0.02,
  promptCacheMissPer1M: 1,
  completionPer1M: 2,
};

/** DeepSeek 模型名称到定价的精确映射 */
const DEEPSEEK_PRICING: Record<string, ModelPricing> = {
  "deepseek-v4-flash": DEEPSEEK_V4_FLASH,
  "deepseek-v4-pro": DEEPSEEK_V4_PRO,
  "deepseek-chat": DEEPSEEK_STANDARD,
  "deepseek-v3": DEEPSEEK_STANDARD,
  "deepseek-reasoner": DEEPSEEK_STANDARD,
};

// ═══════════════════════════════════════════════════
// 默认定价表（Anthropic Claude / OpenAI，美元）
// ═══════════════════════════════════════════════════

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": {
    currency: "USD",
    promptPer1M: 3.0,
    completionPer1M: 15.0,
  },
  "claude-opus-4-7": {
    currency: "USD",
    promptPer1M: 15.0,
    completionPer1M: 75.0,
  },
  "claude-haiku-4-5": {
    currency: "USD",
    promptPer1M: 0.8,
    completionPer1M: 4.0,
  },
  "gpt-4o": { currency: "USD", promptPer1M: 2.5, completionPer1M: 10.0 },
  "gpt-4o-mini": {
    currency: "USD",
    promptPer1M: 0.15,
    completionPer1M: 0.6,
  },
  "gpt-4.5": { currency: "USD", promptPer1M: 75.0, completionPer1M: 150.0 },
  "o3-mini": { currency: "USD", promptPer1M: 1.1, completionPer1M: 4.4 },
};

/**
 * 规范化模型键值。
 *
 * 去除提供商前缀（如 `openai:gpt-4o` → `gpt-4o`），统一为小写，
 * 以便在定价表中进行匹配。
 */
function normalizeModelKey(modelLabel: string): string {
  const trimmed = modelLabel.trim().toLowerCase();
  const colon = trimmed.lastIndexOf(":");
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
}

/**
 * 解析定价的各项费率。
 *
 * 处理 cache-hit/cache-miss 的优先级：
 * - hit: 优先用 `promptCacheHitPer1M`，否则回退到 cache-miss 价格
 * - miss: 优先用 `promptCacheMissPer1M`，否则回退到 `promptPer1M`，再回退到 0
 */
function resolveRates(pricing: ModelPricing): {
  currency: CostCurrency;
  hit: number;
  miss: number;
  completion: number;
} {
  const currency = pricing.currency ?? "USD";
  const miss = pricing.promptCacheMissPer1M ?? pricing.promptPer1M ?? 0;
  // cache-hit 默认等于 cache-miss（当模型不提供拆分价格时的安全高估）
  const hit = pricing.promptCacheHitPer1M ?? miss;
  return {
    currency,
    hit,
    miss,
    completion: pricing.completionPer1M,
  };
}

/**
 * 根据模型标签解析对应的定价。
 *
 * 匹配策略（按优先级）：
 * 1. DeepSeek 精确匹配（内置定价表）
 * 2. 关键词包含 "deepseek" → 按 pro/flash 子类推断
 * 3. 自定义定价表精确匹配
 * 4. 模糊匹配（双向外键包含关系）
 * 5. 无法匹配 → 取自定义定价表的平均值（兜底策略）
 *
 * @param modelLabel  模型标识符（可能包含提供商前缀，如 "openai:gpt-4o"）
 * @param custom      自定义定价表，默认使用内置的 DEFAULT_PRICING
 */
export function resolveModelPricing(
  modelLabel: string,
  custom: Record<string, ModelPricing> = DEFAULT_PRICING,
): ModelPricing {
  const key = normalizeModelKey(modelLabel);

  // 1. DeepSeek 精确匹配
  if (DEEPSEEK_PRICING[key]) return DEEPSEEK_PRICING[key]!;

  // 2. DeepSeek 关键词推断
  if (key.includes("deepseek")) {
    if (key.includes("pro")) return DEEPSEEK_V4_PRO;
    if (key.includes("flash")) return DEEPSEEK_V4_FLASH;
    return DEEPSEEK_STANDARD;
  }

  // 3. 自定义定价表精确匹配
  if (custom[key]) return custom[key]!;

  // 4. 模糊匹配（双向外键包含）
  for (const [name, pricing] of Object.entries(custom)) {
    if (key.includes(name) || name.includes(key)) return pricing;
  }

  // 5. 兜底：取自定义定价表中所有模型的平均值
  return {
    currency: "USD",
    promptPer1M:
      Object.values(custom).reduce(
        (sum, p) => sum + (p.promptCacheMissPer1M ?? p.promptPer1M ?? 0),
        0,
      ) / Math.max(Object.values(custom).length, 1),
    completionPer1M:
      Object.values(custom).reduce((sum, p) => sum + p.completionPer1M, 0) /
      Math.max(Object.values(custom).length, 1),
  };
}

/**
 * 估算单次 API 调用的费用。
 *
 * 计算逻辑：
 * - 缓存命中的 prompt token = min(cachedPromptTokens, promptTokens) * hit 费率
 * - 未命中的 prompt token = (promptTokens - cached) * miss 费率
 * - completion token = completionTokens * completion 费率
 *
 * @param modelLabel  模型标识符
 * @param usage       本次使用的 token 记录
 * @param custom      自定义定价表（可选）
 * @returns 费用金额和货币类型
 */
export function estimateUsageCost(
  modelLabel: string,
  usage: UsageRecord,
  custom?: Record<string, ModelPricing>,
): { cost: number; currency: CostCurrency } {
  const pricing = resolveModelPricing(modelLabel, custom ?? DEFAULT_PRICING);
  const { currency, hit, miss, completion } = resolveRates(pricing);

  const prompt = usage.promptTokens ?? 0;
  // 缓存命中数不能超过总 prompt 数（防御数据异常）
  const cached = Math.min(Math.max(usage.cachedPromptTokens ?? 0, 0), prompt);
  const uncached = prompt - cached;
  const completionTokens = usage.completionTokens ?? 0;

  const cost =
    (cached / 1_000_000) * hit +
    (uncached / 1_000_000) * miss +
    (completionTokens / 1_000_000) * completion;

  // 保留 6 位小数，避免浮点累加误差
  return {
    cost: Math.round(cost * 1_000_000) / 1_000_000,
    currency,
  };
}

/**
 * 成本追踪器 —— 累计多次 API 调用的 token 消耗和费用。
 *
 * 单线程安全（所有方法都是同步的，无异步状态）。
 * 典型用法：
 * ```
 * const tracker = new CostTracker();
 * tracker.record("claude-sonnet-4-6", { promptTokens: 1000, completionTokens: 200 });
 * tracker.record("deepseek-v4-flash", { promptTokens: 500, completionTokens: 100 });
 * console.log(tracker.summary()); // "1,800 tokens (~$0.0052)"
 * ```
 */
export class CostTracker {
  private readonly pricing: Record<string, ModelPricing>;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalCost = 0;
  private costCurrency: CostCurrency = "USD";

  constructor(opts?: { readonly pricing?: Record<string, ModelPricing> }) {
    // 深拷贝默认定价表，防止外部修改影响内部状态
    this.pricing = opts?.pricing ?? { ...DEFAULT_PRICING };
  }

  /** 记录单次模型调用产生的用量 */
  record(modelLabel: string, usage: UsageRecord): void {
    const { cost, currency } = estimateUsageCost(
      modelLabel,
      usage,
      this.pricing,
    );
    this.totalCost += cost;
    this.costCurrency = currency;  // 以最后一次调用的货币类型为准（假设同一次运行用同一货币）
    if (usage.promptTokens) {
      this.promptTokens += usage.promptTokens;
    }
    if (usage.completionTokens) {
      this.completionTokens += usage.completionTokens;
    }
  }

  /** 获取当前累计的成本快照 */
  snapshot(): CostSnapshot {
    const totalTokens = this.promptTokens + this.completionTokens;
    const estimatedCost =
      Math.round(this.totalCost * 1_000_000) / 1_000_000;
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens,
      estimatedCost,
      costCurrency: this.costCurrency,
      estimatedCostUsd: estimatedCost,
    };
  }

  /** 重置所有计数器 */
  reset(): void {
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalCost = 0;
    this.costCurrency = "USD";
  }

  /** 生成人类可读的费用摘要，如 "18,500 tokens (~$0.0052)" */
  summary(): string {
    const s = this.snapshot();
    const sym = s.costCurrency === "CNY" ? "¥" : "$";
    return `${s.totalTokens.toLocaleString()} tokens (~${sym}${s.estimatedCost.toFixed(4)})`;
  }
}
