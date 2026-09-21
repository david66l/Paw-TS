/**
 * 模型调用的错误分类与重试策略。
 *
 * `classifyError` 决定一次失败的调用是否重试、以及等多久；
 * `ModelRequestTimeoutError` 是 orchestrator 自己抛出的那一种失败。
 */
// ═════════════════════════════════════════════════════════════
// 错误分类 & 重试策略
// ═════════════════════════════════════════════════════════════

/**
 * 可重试错误类型：
 * - rate_limit：429 限流 → 等 Retry-After 或固定阶梯
 * - server_error：5xx 服务端错误 → 指数退避
 * - timeout：请求超时 → 指数退避
 * - network：网络层故障（DNS/连接重置等）→ 指数退避
 * - transient：其他瞬时错误 → 指数退避
 * - non_retryable：不可重试（4xx 认证/参数错误、熔断器打开、未知错误）
 */
export type RetryableErrorType =
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "network"
  | "transient"
  | "non_retryable";

export class ModelRequestTimeoutError extends Error {
  constructor(timeoutMs: number, options?: unknown) {
    super(`Model request timeout after ${timeoutMs}ms`, {
      ...(options === undefined ? {} : { cause: options }),
    });
    this.name = "ModelRequestTimeoutError";
  }
}

export interface ErrorClassification {
  readonly type: RetryableErrorType;
  /** 限流响应中的 Retry-After 时间（毫秒） */
  readonly retryAfterMs?: number;
}

/**
 * 分类错误以决定重试策略。
 *
 * 采用白名单策略：只对明确的瞬时性错误类型启用重试，
 * 未知错误默认不可重试（安全第一，避免对持久性错误反复重试浪费资源）。
 */
export function classifyError(err: unknown): ErrorClassification {
  if (!(err instanceof Error)) {
    // 非 Error 类型的 throw（如 throw "string"）默认不可重试
    return { type: "non_retryable" };
  }
  const msg = err.message;

  if (err instanceof ModelRequestTimeoutError) return { type: "timeout" };

  // 429 限流 — 尝试提取 Retry-After 头
  if (/\b429\b/.test(msg)) {
    const retryAfterMatch = msg.match(/retry[_-]?after[\s:]*(\d+)/i);
    if (retryAfterMatch) {
      const seconds = Number.parseInt(retryAfterMatch[1]!, 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        return { type: "rate_limit", retryAfterMs: seconds * 1000 };
      }
    }
    return { type: "rate_limit" };
  }

  // 5xx 服务端错误（可重试）
  if (/\b5\d\d\b/.test(msg)) return { type: "server_error" };

  // 4xx 客户端错误（不可重试：认证失败、参数错误等）
  if (/\b4\d\d\b/.test(msg)) return { type: "non_retryable" };

  // 超时
  if (/\btimeout\b|ETIMEDOUT/i.test(msg)) return { type: "timeout" };

  // 网络层故障
  if (/fetch|network|ECONN|ENOTFOUND|DNS|ECONNRESET/i.test(msg)) {
    return { type: "network" };
  }

  // 默认：未知错误不重试（白名单策略）
  return { type: "non_retryable" };
}

/** 判断错误是否可以重试 */
export function isRetryable(classification: ErrorClassification): boolean {
  return classification.type !== "non_retryable";
}

/**
 * 计算重试延迟。
 *
 * 策略：
 * - 限流（rate_limit）：
 *   - 有 Retry-After → 按指示等待 + 随机抖动
 *   - 无 Retry-After → 固定阶梯：5s → 10s → 20s
 * - 其他可重试错误（server_error/timeout/network/transient）：
 *   - 指数退避：1s → 2s → 4s...，上限 30s
 *   - 每次叠加 0.5x–1.0x 随机抖动，避免惊群效应
 *
 * 为什么要加抖动（jitter）？
 * 多个并发请求同时失败后，如果都在同一个时间点重试，
 * 可能导致服务端再次过载。随机抖动让重试分散在不同的时间点。
 */
export function computeRetryDelay(attempt: number, classification: ErrorClassification): number {
  const jitter = 0.5 + Math.random() * 0.5; // 0.5x – 1.0x 随机因子

  if (classification.type === "rate_limit") {
    if (classification.retryAfterMs) {
      return classification.retryAfterMs * jitter;
    }
    // 固定阶梯：第1次 5s，第2次 10s，第3次+ 20s
    const fixed = [5_000, 10_000, 20_000];
    return (fixed[attempt - 1] ?? 20_000) * jitter;
  }

  // 指数退避：base = 1000 * 2^(attempt-1)，上限 30s
  const base = 1_000 * 2 ** (attempt - 1);
  return Math.min(base * jitter, 30_000);
}
