export const CONTEXT_COMPACTION_LIFECYCLE_POLICY_VERSION_V1 =
  "paw.context-compaction-lifecycle.v1:s2000:x9500:c5:f3:l2:g12000" as const;

export interface ContextCompactionLifecyclePolicyV1 {
  readonly minimumSavingsBasisPoints: number;
  /** Evidence coverage, not ratio alone, is the primary over-compression gate. */
  readonly suspiciousSavingsBasisPoints: number;
  readonly cooldownModelTurns: number;
  readonly circuitBreakerFailures: number;
  readonly lowSavingsBackoffCount: number;
  readonly lowSavingsRegrowthBasisPoints: number;
}

export const DEFAULT_CONTEXT_COMPACTION_LIFECYCLE_POLICY_V1: ContextCompactionLifecyclePolicyV1 =
  Object.freeze({
    minimumSavingsBasisPoints: 2_000,
    suspiciousSavingsBasisPoints: 9_500,
    cooldownModelTurns: 5,
    circuitBreakerFailures: 3,
    lowSavingsBackoffCount: 2,
    lowSavingsRegrowthBasisPoints: 12_000,
  });

export type ContextCompactionAttemptOutcomeV1 = Readonly<{
  modelTurn: number;
  fullInputTokens: number;
  outcome:
    | "committed"
    | "low_savings"
    | "quality_rejected"
    | "error"
    | "cancelled"
    | "unknown";
}>;

export interface ContextCompactionHealthV1 {
  readonly canAttempt: boolean;
  readonly reason:
    | "ready"
    | "cooldown"
    | "circuit_open"
    | "low_savings_backoff";
  readonly consecutiveFailures: number;
  readonly consecutiveLowSavings: number;
  readonly lastAttemptModelTurn?: number;
}

export type ContextCompactionSavingsV1 = Readonly<{
  savingsBasisPoints: number;
  classification: "low" | "acceptable" | "suspiciously_high";
}>;

export function evaluateContextCompactionSavingsV1(
  beforeTokens: number,
  afterTokens: number,
  policy: ContextCompactionLifecyclePolicyV1 = DEFAULT_CONTEXT_COMPACTION_LIFECYCLE_POLICY_V1,
): ContextCompactionSavingsV1 {
  const frozen = freezeContextCompactionLifecyclePolicyV1(policy);
  assertTokenCount(beforeTokens, "before");
  assertTokenCount(afterTokens, "after");
  const savingsBasisPoints =
    beforeTokens === 0
      ? 0
      : Math.floor(((beforeTokens - afterTokens) * 10_000) / beforeTokens);
  return Object.freeze({
    savingsBasisPoints,
    classification:
      savingsBasisPoints < frozen.minimumSavingsBasisPoints
        ? "low"
        : savingsBasisPoints > frozen.suspiciousSavingsBasisPoints
          ? "suspiciously_high"
          : "acceptable",
  });
}

/** Pure reconstruction; callers may derive attempts from durable Journal. */
export function projectContextCompactionHealthV1(
  attempts: readonly ContextCompactionAttemptOutcomeV1[],
  currentModelTurn: number,
  currentFullInputTokens: number,
  policy: ContextCompactionLifecyclePolicyV1 = DEFAULT_CONTEXT_COMPACTION_LIFECYCLE_POLICY_V1,
): ContextCompactionHealthV1 {
  const frozen = freezeContextCompactionLifecyclePolicyV1(policy);
  assertNonNegativeInteger(currentModelTurn, "current model turn");
  assertTokenCount(currentFullInputTokens, "current input");
  let previousTurn = 0;
  let consecutiveFailures = 0;
  let consecutiveLowSavings = 0;
  let lastLowSavingsTokens = 0;
  let lastAttemptModelTurn: number | undefined;
  for (const attempt of attempts) {
    if (
      !Number.isSafeInteger(attempt.modelTurn) ||
      attempt.modelTurn <= 0 ||
      attempt.modelTurn < previousTurn
    ) {
      throw new Error("Context compaction attempt order is invalid");
    }
    assertTokenCount(attempt.fullInputTokens, "attempt input");
    previousTurn = attempt.modelTurn;
    lastAttemptModelTurn = attempt.modelTurn;
    switch (attempt.outcome) {
      case "committed":
        consecutiveFailures = 0;
        consecutiveLowSavings = 0;
        lastLowSavingsTokens = 0;
        break;
      case "low_savings":
        consecutiveFailures = 0;
        consecutiveLowSavings += 1;
        lastLowSavingsTokens = attempt.fullInputTokens;
        break;
      case "quality_rejected":
      case "error":
      case "unknown":
        consecutiveFailures += 1;
        consecutiveLowSavings = 0;
        lastLowSavingsTokens = 0;
        break;
      case "cancelled":
        break;
    }
  }

  if (consecutiveFailures >= frozen.circuitBreakerFailures) {
    return health(
      false,
      "circuit_open",
      consecutiveFailures,
      consecutiveLowSavings,
      lastAttemptModelTurn,
    );
  }
  if (
    consecutiveLowSavings >= frozen.lowSavingsBackoffCount &&
    currentFullInputTokens * 10_000 <=
      lastLowSavingsTokens * frozen.lowSavingsRegrowthBasisPoints
  ) {
    return health(
      false,
      "low_savings_backoff",
      consecutiveFailures,
      consecutiveLowSavings,
      lastAttemptModelTurn,
    );
  }
  if (
    lastAttemptModelTurn !== undefined &&
    currentModelTurn - lastAttemptModelTurn < frozen.cooldownModelTurns
  ) {
    return health(
      false,
      "cooldown",
      consecutiveFailures,
      consecutiveLowSavings,
      lastAttemptModelTurn,
    );
  }
  return health(
    true,
    "ready",
    consecutiveFailures,
    consecutiveLowSavings,
    lastAttemptModelTurn,
  );
}

export function freezeContextCompactionLifecyclePolicyV1(
  policy: ContextCompactionLifecyclePolicyV1,
): ContextCompactionLifecyclePolicyV1 {
  if (
    !isBasisPoints(policy.minimumSavingsBasisPoints) ||
    !isBasisPoints(policy.suspiciousSavingsBasisPoints) ||
    policy.suspiciousSavingsBasisPoints <= policy.minimumSavingsBasisPoints ||
    !Number.isSafeInteger(policy.cooldownModelTurns) ||
    policy.cooldownModelTurns < 0 ||
    !Number.isSafeInteger(policy.circuitBreakerFailures) ||
    policy.circuitBreakerFailures <= 0 ||
    !Number.isSafeInteger(policy.lowSavingsBackoffCount) ||
    policy.lowSavingsBackoffCount <= 0 ||
    !Number.isSafeInteger(policy.lowSavingsRegrowthBasisPoints) ||
    policy.lowSavingsRegrowthBasisPoints < 10_000
  ) {
    throw new Error("Context compaction lifecycle policy is invalid");
  }
  return Object.freeze({ ...policy });
}

function health(
  canAttempt: boolean,
  reason: ContextCompactionHealthV1["reason"],
  consecutiveFailures: number,
  consecutiveLowSavings: number,
  lastAttemptModelTurn: number | undefined,
): ContextCompactionHealthV1 {
  return Object.freeze({
    canAttempt,
    reason,
    consecutiveFailures,
    consecutiveLowSavings,
    ...(lastAttemptModelTurn === undefined ? {} : { lastAttemptModelTurn }),
  });
}

function isBasisPoints(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
}

function assertTokenCount(value: number, name: string): void {
  assertNonNegativeInteger(value, `${name} tokens`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Context compaction ${name} is invalid`);
  }
}
