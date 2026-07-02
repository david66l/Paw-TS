/**
 * 运行评估器（RunEvaluator）——从录制的事件流中离线计算运行指标。
 *
 * ## 模块职责（架构定位）
 * 本模块提供与在线（live）指标累加器完全一致但完全独立的离线计算逻辑。
 * 它从 JSONL 文件或内存中的 `RunEventEnvelope` 数组中重新推导 `RunMetrics`，
 * 用于以下场景：
 *
 * 1. **离线分析（Post-hoc Analysis）**：对已保存的历史运行记录进行复盘分析，
 *    无需重新执行 agent 即可获取完整的效率和质量指标。
 * 2. **遥测交叉验证（Telemetry Cross-check）**：将离线计算结果与编排器
 *    （AgentOrchestrator）的实时累加器结果进行比对，验证遥测数据的准确性。
 *    如果两者不一致，说明在线累加逻辑存在 bug。
 * 3. **测试与调试**：在单元测试中构造特定的事件序列，验证指标计算的正确性。
 *
 * ## 核心设计决策
 * 1. **纯函数设计**：`evaluateRunFromEnvelopes` 是无副作用的纯函数，仅依赖输入
 *    数据，不访问任何外部状态。这使其易于测试和推理。
 * 2. **与在线逻辑对齐**：计算逻辑必须与 `AgentOrchestrator.initializeRun` 中的
 *    实时累加逻辑保持精确一致，确保离线数据和在线数据可互相印证。
 * 3. **事件驱动的增量计算**：通过遍历事件序列逐步更新状态变量（如
 *    `modelLatencyMs` 通过 `model.request` 和 `model.done` 的时间差累加），
 *    而非通过固定公式推导，保留了事件流的时序信息。
 *
 * Reads JSONL files (or in-memory {@link RunEventEnvelope} arrays) and
 * re-derives {@link RunMetrics} independently of the orchestrator's
 * live accumulator. This serves as a cross-check for telemetry accuracy
 * and enables post-hoc analysis of saved runs.
 */

import { readFile } from "node:fs/promises";
import type { RunEventEnvelope } from "./run-events.js";
import type { RunMetrics } from "./run-metrics.js";

/**
 * 从按时间顺序排列的事件信封序列计算运行指标。
 *
 * 该函数模仿 `AgentOrchestrator.initializeRun` 中的实时累加逻辑，
 * 确保离线计算结果与在线遥测数据保持一致，可作为交叉验证依据。
 *
 * 计算过程说明：
 * - **durationMs**：从第一条事件的 ts 到最后一条事件的 ts 的墙钟时间差
 * - **modelLatencyMs**：所有 `model.request` → `model.done` 对的耗时累加和
 * - **modelCalls / toolCalls**：分别统计 `model.request` 和 `tool.result` 事件数
 * - **toolSuccesses**：统计 `tool.result` 中 `ok === true` 的次数
 * - **totalTokens**：累加每次模型调用的 promptTokens + completionTokens
 * - **steps**：取所有 `loop.tick` 事件中的最大 turn 值
 * - **truncationCount**：统计 `model.truncated` 事件的发生次数
 *
 * Compute {@link RunMetrics} from a chronological sequence of event
 * envelopes. Matches the logic in
 * {@link AgentOrchestrator.initializeRun} so that offline numbers
 * agree with live telemetry.
 *
 * @param envelopes - 按时间顺序排列的只读事件信封数组
 * @returns 完整的运行指标对象
 */
export function evaluateRunFromEnvelopes(
  envelopes: readonly RunEventEnvelope[],
): RunMetrics {
  // 状态变量初始化
  let firstTs = -1;            // 首条事件时间戳（-1 表示未初始化）
  let lastTs = 0;              // 末条事件时间戳
  let runId = "";              // 运行 ID（从首条事件中提取）
  let goal = "";               // 运行目标（从 run.started 事件中提取）
  let status: "completed" | "failed" = "failed";  // 运行状态，默认 failed
  let modelLatencyMs = 0;      // 模型调用延迟累加和（毫秒）
  let modelCalls = 0;          // 模型调用次数
  let toolCalls = 0;           // 工具调用总次数
  let toolSuccesses = 0;       // 工具调用成功次数
  let totalTokens = 0;         // 总 token 消耗
  let estimatedCost = 0;       // 估算费用
  let costCurrency: "CNY" | "USD" = "USD";  // 费用货币单位
  let steps = 0;               // 最大轮次索引
  let truncationCount = 0;     // 输出截断次数
  let pendingModelRequestTs = 0;  // 待处理的模型请求时间戳（用于计算单次延迟）

  // 遍历所有事件，逐步更新状态
  for (const env of envelopes) {
    // 记录首条事件的基本信息
    if (firstTs < 0) {
      firstTs = env.ts;
      runId = env.runId;
    }
    lastTs = env.ts;

    const ev = env.event;

    // —— 运行生命周期事件 ——
    if (ev.type === "run.started") {
      goal = ev.goal;  // 提取运行目标描述
    }
    if (ev.type === "run.completed") {
      status = ev.status === "completed" ? "completed" : "failed";
    }
    if (ev.type === "run.failed") {
      status = "failed";  // 显式标记为失败
    }

    // —— 按事件类型分类处理 ——
    switch (ev.type) {
      // 模型请求发出：记录调用次数和请求时间戳，供后续计算延迟
      case "model.request": {
        modelCalls++;
        pendingModelRequestTs = env.ts;
        break;
      }
      // 模型响应返回：累加本次调用的延迟，统计 token 消耗
      case "model.done": {
        if (pendingModelRequestTs > 0) {
          // 计算单次请求-响应延迟并累加
          modelLatencyMs += env.ts - pendingModelRequestTs;
          pendingModelRequestTs = 0;  // 重置，准备处理下一次请求
        }
        if (ev.usage) {
          // 累加 prompt 和 completion 的 token 消耗
          totalTokens +=
            (ev.usage.promptTokens ?? 0) +
            (ev.usage.completionTokens ?? 0);
        }
        break;
      }
      // 模型输出被截断（finishReason 为 length/max_tokens）
      case "model.truncated": {
        truncationCount++;
        break;
      }
      // 工具调用结果返回
      case "tool.result": {
        toolCalls++;
        if (ev.ok) toolSuccesses++;  // 仅计数成功的工具调用
        break;
      }
      // 循环轮次更新：记录当前达到的最大轮次
      case "loop.tick": {
        steps = Math.max(steps, ev.turn);
        break;
      }
      // 费用更新：记录最新的估算费用和货币单位
      case "cost.update": {
        estimatedCost = ev.estimatedCostUsd ?? 0;
        costCurrency = ev.costCurrency ?? "USD";
        break;
      }
    }
  }

  // 组装最终指标对象
  return {
    runId,
    goal,
    status,
    durationMs: firstTs < 0 ? 0 : lastTs - firstTs,  // 如果没有任何事件，时长为 0
    modelLatencyMs,
    modelCalls,
    toolCalls,
    toolSuccesses,
    totalTokens,
    estimatedCost,
    costCurrency,
    steps,
    truncationCount,
  };
}

/**
 * 便捷封装函数：读取 JSONL 文件并计算指标。
 *
 * JSONL 格式说明：每行是一个完整的 JSON 对象，代表一个 {@link RunEventEnvelope}。
 * 空行会被自动忽略。
 *
 * Convenience wrapper: read a JSONL file and compute metrics.
 *
 * @param path - JSONL 文件的绝对或相对路径，每行为一个 JSON 序列化的 {@link RunEventEnvelope}
 * @returns Promise，解析为计算完成的运行指标
 */
export async function evaluateRunFromJsonl(path: string): Promise<RunMetrics> {
  const text = await readFile(path, "utf-8");
  // 按行分割，去除空白行
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // 将每行 JSON 字符串解析为 RunEventEnvelope 对象
  const envelopes: RunEventEnvelope[] = lines.map((line) =>
    JSON.parse(line),
  );
  return evaluateRunFromEnvelopes(envelopes);
}
