/**
 * SWE-Exp agent 模式：扩展指标与 checkpoint 类型
 */

import type { SweExpArmResult, SweExpPair, SweInstance } from "./types.js";

/** Lite 实例扩展字段（评测用；禁止把 gold patch 写入 history seed） */
export interface SweBenchLiteInstance extends SweInstance {
  readonly base_commit: string;
  readonly FAIL_TO_PASS?: readonly string[];
  readonly PASS_TO_PASS?: readonly string[];
  /** 仅用于评测对照；history 蒸馏严禁使用 */
  readonly patch?: string;
  readonly test_patch?: string;
  readonly hints_text?: string;
}

export interface SweExpAgentPair extends SweExpPair {
  readonly history: SweBenchLiteInstance;
  readonly probe: SweBenchLiteInstance;
}

export type ArmStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

/** 单臂落盘 checkpoint（中断续跑） */
export interface SweExpArmCheckpoint {
  readonly pairId: string;
  readonly arm: "off" | "on";
  readonly status: ArmStatus;
  readonly runId: string;
  readonly repositoryId: string;
  readonly workspaceRoot?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: SweExpArmResultExtended;
  readonly error?: string;
}

export interface SweExpArmResultExtended extends SweExpArmResult {
  readonly patch?: string;
  readonly modelCalls?: number;
  readonly totalTokens?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly failureReason?: string | null;
  readonly resolvedSource?: "swebench_harness" | "local_smoke" | "none" | "error";
  readonly runStatus?: string;
  readonly memoryNamespace?: string;
}

export interface SweExpRunManifest {
  readonly runId: string;
  readonly createdAt: string;
  readonly protocol: "swe-exp-pairing";
  readonly mode: "agent";
  readonly modelProvider?: string;
  readonly maxSteps: number;
  readonly timeoutMs: number;
  readonly pairs: readonly {
    readonly pairId: string;
    readonly repo: string;
    readonly historyId: string;
    readonly probeId: string;
    readonly probeCommit: string;
    readonly similarity?: number;
  }[];
}

/** History seed 输入：只允许问题描述，禁止 gold */
export interface HistorySeedInput {
  readonly historyId: string;
  readonly repo: string;
  readonly problemStatement: string;
  readonly hintsText?: string;
}
