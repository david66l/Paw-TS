/**
 * 熔断器（Circuit Breaker）—— 防止模型 provider 持续不可用时级联失败。
 * ====================================================================
 *
 * 设计模式：标准的 Circuit Breaker 模式，三种状态：
 *
 *   CLOSED（闭合）  → 正常运行，失败被计数
 *   OPEN（断开）    → 快速失败，请求立即被拒绝（不浪费 API 调用）
 *   HALF_OPEN（半开）→ 恢复超时后，允许少量探测请求测试服务是否恢复
 *
 * 状态转移：
 *   CLOSED ──(连续失败 ≥ threshold)──→ OPEN
 *   OPEN   ──(等待 recoveryTimeoutMs)──→ HALF_OPEN
 *   HALF_OPEN ──(探测成功)──→ CLOSED
 *   HALF_OPEN ──(探测失败)──→ OPEN（立即重新断开）
 *
 * 关键参数：
 * - failureThreshold：连续失败多少次后断开（默认 5）
 * - recoveryTimeoutMs：断开后多久尝试恢复（默认 30s）
 * - halfOpenMaxCalls：半开状态下最多允许几个并发探测请求（默认 1）
 *
 * 面试要点：
 * - 为什么需要熔断器？LLM API 不可靠，连续重试浪费 token 且延迟叠加
 * - 为什么有 HALF_OPEN？直接 CLOSED→OPEN→CLOSED 可能在服务刚恢复时
 *   又立即被大量请求打挂。HALF_OPEN 只允许少量探测请求安全验证。
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** 断开前允许的连续失败次数 */
  readonly failureThreshold: number;
  /** 从 OPEN 转为 HALF_OPEN 的恢复等待时间（毫秒） */
  readonly recoveryTimeoutMs: number;
  /** HALF_OPEN 状态下最大并发探测请求数 */
  readonly halfOpenMaxCalls: number;
}

/** 熔断器打开时抛出的异常——不可重试 */
export class CircuitBreakerOpenError extends Error {
  readonly label: string;
  readonly state: CircuitState;
  readonly lastFailureAt?: number;
  readonly failures: number;

  constructor(label: string, state: CircuitState, snapshot: CircuitSnapshot) {
    super(
      `Circuit breaker "${label}" is ${state} ` +
        `(failures=${snapshot.failures}, lastFailure=${snapshot.lastFailureAt ?? "never"})`,
    );
    this.label = label;
    this.state = state;
    this.failures = snapshot.failures;
    this.lastFailureAt = snapshot.lastFailureAt ?? undefined;
  }
}

/** 熔断器状态快照（只读，用于事件上报和调试） */
export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly failures: number;
  readonly successes: number;
  readonly lastFailureAt?: number;
  readonly lastSuccessAt?: number;
  /** HALF_OPEN 状态下的活跃探测请求数 */
  readonly halfOpenCalls: number;
}

/** 默认熔断器参数 */
const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  recoveryTimeoutMs: 30_000,
  halfOpenMaxCalls: 1,
};

export class CircuitBreaker {
  readonly label: string;

  private _state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private lastFailureAt = 0;
  private lastSuccessAt = 0;
  /** HALF_OPEN 状态下当前活跃的探测请求数 */
  private halfOpenCalls = 0;
  /** 进入 OPEN 状态的时间戳 */
  private openedAt = 0;

  private readonly opts: CircuitBreakerOptions;

  constructor(label: string, opts?: Partial<CircuitBreakerOptions>) {
    this.label = label;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /** 获取当前状态（读取时自动检查是否应该从 OPEN 转为 HALF_OPEN） */
  get state(): CircuitState {
    this.tryTransitionToHalfOpen();
    return this._state;
  }

  /**
   * 守卫方法：如果熔断器处于 OPEN 状态则直接抛异常。
   * 调用方必须在每次模型调用前调用此方法。
   *
   * HALF_OPEN 状态下：
   * - 如果活跃探测数 < halfOpenMaxCalls → 放行（计数 +1）
   * - 否则 → 拒绝（防止探测请求过多）
   */
  guard(): void {
    const current = this.state; // 触发 HALF_OPEN 转换检查
    if (current === "open") {
      throw new CircuitBreakerOpenError(this.label, current, this.snapshot());
    }
    if (current === "half_open") {
      if (this.halfOpenCalls >= this.opts.halfOpenMaxCalls) {
        throw new CircuitBreakerOpenError(
          this.label,
          current,
          this.snapshot(),
        );
      }
      this.halfOpenCalls++;
    }
  }

  /** 请求成功后调用 */
  recordSuccess(): void {
    this.successes++;
    this.lastSuccessAt = Date.now();

    if (this._state === "half_open") {
      // 探测成功 → 闭合熔断器，恢复正常
      this.transitionToClosed();
    } else if (this._state === "closed") {
      // 在闭合状态下成功 → 重置失败计数
      this.failures = 0;
    }
  }

  /** 请求失败后调用 */
  recordFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();

    if (this._state === "half_open") {
      // 探测失败 → 立即重新断开
      this.transitionToOpen();
    } else if (
      this._state === "closed" &&
      this.failures >= this.opts.failureThreshold
    ) {
      // 连续失败达到阈值 → 断开
      this.transitionToOpen();
    }
  }

  /** 获取当前状态的只读快照 */
  snapshot(): CircuitSnapshot {
    return {
      state: this._state,
      failures: this.failures,
      successes: this.successes,
      lastFailureAt: this.lastFailureAt || undefined,
      lastSuccessAt: this.lastSuccessAt || undefined,
      halfOpenCalls: this.halfOpenCalls,
    };
  }

  /** 重置到出厂状态（测试用） */
  reset(): void {
    this._state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.lastFailureAt = 0;
    this.lastSuccessAt = 0;
    this.halfOpenCalls = 0;
    this.openedAt = 0;
  }

  /** 尝试从 OPEN 转为 HALF_OPEN（恢复超时已过） */
  private tryTransitionToHalfOpen(): void {
    if (this._state !== "open") return;
    if (Date.now() - this.openedAt >= this.opts.recoveryTimeoutMs) {
      this._state = "half_open";
      this.halfOpenCalls = 0;
    }
  }

  private transitionToOpen(): void {
    this._state = "open";
    this.openedAt = Date.now();
    this.halfOpenCalls = 0;
  }

  private transitionToClosed(): void {
    this._state = "closed";
    this.failures = 0;
    this.halfOpenCalls = 0;
    this.openedAt = 0;
  }
}
