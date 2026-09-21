/**
 * SWE-Exp 风格配对协议类型（spec §11.3.1 P1）
 *
 * 不移植 SWE-Exp 完整 agent；叠在 SWE-bench 适配器上：
 * 历史 issue 轨迹 → 写入记忆 → 同仓库相似 probe → memory on/off 对照。
 * 核心指标：最终测试是否通过（resolved）。
 */

/** SWE-bench 风格实例（字段子集，足够配对） */
export interface SweInstance {
  readonly instance_id: string;
  readonly repo: string;
  readonly base_commit?: string;
  readonly problem_statement: string;
  readonly version?: string;
}

/**
 * 一对：history 用于无记忆收集轨迹 / 蒸馏；probe 为对照解题题。
 * 同仓库、不同 instance；builtin 夹具可省略真实 commit。
 */
export interface SweExpPair {
  readonly id: string;
  readonly repo: string;
  readonly history: SweInstance;
  readonly probe: SweInstance;
  /** Jaccard 等启发式相似度（0–1）；手工夹具可省略 */
  readonly similarity?: number;
}

/** 单臂（memory on 或 off）结果 */
export interface SweExpArmResult {
  readonly memoryOn: boolean;
  /** 官方 harness / 本地测试：最终测试是否通过 */
  readonly resolved: boolean;
  readonly patchChars?: number;
  readonly steps?: number;
  readonly durationMs?: number;
  readonly recalled?: boolean;
  readonly warnings?: readonly string[];
  /** agent 模式扩展 */
  readonly patch?: string;
  readonly modelCalls?: number;
  readonly totalTokens?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly failureReason?: string | null;
  readonly resolvedSource?: string;
  readonly runStatus?: string;
  readonly memoryNamespace?: string;
}

/** 同一 probe 上 on/off 配对结果 */
export interface SweExpPairResult {
  readonly pairId: string;
  readonly repo: string;
  readonly historyId: string;
  readonly probeId: string;
  readonly off: SweExpArmResult;
  readonly on: SweExpArmResult;
  /**
   * 配对符号：
   * - win：on 通过且 off 未通过
   * - loss：off 通过且 on 未通过
   * - tie：同过或同不过
   */
  readonly outcome: "win" | "loss" | "tie";
}

export interface SweExpPairedStats {
  readonly nPairs: number;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly resolveRateOff: number;
  readonly resolveRateOn: number;
  /** Score(on) − Score(off) */
  readonly delta: number;
  readonly pairedAdvantage: number | null;
  readonly winRateAmongDecisive: number | null;
  readonly signTestP: number | null;
}

export interface SweExpReport {
  readonly suite: "swe-exp";
  readonly generatedAt: string;
  readonly protocol: "swe-exp-pairing";
  readonly mode: "fake" | "deterministic" | "agent" | "external";
  readonly passed: boolean | null;
  readonly paired: SweExpPairedStats;
  readonly details: readonly SweExpPairResult[];
  readonly warnings: string[];
  readonly metrics: Record<string, number | string | null | object>;
}
