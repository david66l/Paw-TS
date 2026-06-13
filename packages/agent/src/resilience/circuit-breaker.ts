/**
 * Circuit Breaker — prevents cascading failures when a model provider
 * is repeatedly unavailable.
 *
 * States:
 *   CLOSED   → normal operation, failures are counted
 *   OPEN     → fast-fail, requests are rejected immediately
 *   HALF_OPEN → after recovery timeout, a limited number of probe
 *                requests are allowed to test if the service recovered.
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. */
  readonly failureThreshold: number;
  /** Time in ms before transitioning OPEN → HALF_OPEN. */
  readonly recoveryTimeoutMs: number;
  /** Max concurrent probe calls in HALF_OPEN state. */
  readonly halfOpenMaxCalls: number;
}

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

export interface CircuitSnapshot {
  readonly state: CircuitState;
  readonly failures: number;
  readonly successes: number;
  readonly lastFailureAt?: number;
  readonly lastSuccessAt?: number;
  readonly halfOpenCalls: number;
}

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
  private halfOpenCalls = 0;
  private openedAt = 0;

  private readonly opts: CircuitBreakerOptions;

  constructor(label: string, opts?: Partial<CircuitBreakerOptions>) {
    this.label = label;
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  get state(): CircuitState {
    this.tryTransitionToHalfOpen();
    return this._state;
  }

  /** Throws if the circuit is OPEN. */
  guard(): void {
    const current = this.state; // triggers HALF_OPEN transition check
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

  /** Call after a successful request. */
  recordSuccess(): void {
    this.successes++;
    this.lastSuccessAt = Date.now();

    if (this._state === "half_open") {
      // Probe succeeded → close the circuit
      this.transitionToClosed();
    } else if (this._state === "closed") {
      this.failures = 0;
    }
  }

  /** Call after a failed request. */
  recordFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();

    if (this._state === "half_open") {
      // Probe failed → reopen immediately
      this.transitionToOpen();
    } else if (
      this._state === "closed" &&
      this.failures >= this.opts.failureThreshold
    ) {
      this.transitionToOpen();
    }
  }

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

  /** Reset to factory state (useful in tests). */
  reset(): void {
    this._state = "closed";
    this.failures = 0;
    this.successes = 0;
    this.lastFailureAt = 0;
    this.lastSuccessAt = 0;
    this.halfOpenCalls = 0;
    this.openedAt = 0;
  }

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
