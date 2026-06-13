/**
 * RunEvaluator — offline metrics computation from a recorded event stream.
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
 * Compute {@link RunMetrics} from a chronological sequence of event
 * envelopes. Matches the logic in
 * {@link AgentOrchestrator.initializeRun} so that offline numbers
 * agree with live telemetry.
 */
export function evaluateRunFromEnvelopes(
  envelopes: readonly RunEventEnvelope[],
): RunMetrics {
  let firstTs = -1;
  let lastTs = 0;
  let runId = "";
  let goal = "";
  let status: "completed" | "failed" = "failed";
  let modelLatencyMs = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let toolSuccesses = 0;
  let totalTokens = 0;
  let estimatedCost = 0;
  let costCurrency: "CNY" | "USD" = "USD";
  let steps = 0;
  let truncationCount = 0;
  let pendingModelRequestTs = 0;

  for (const env of envelopes) {
    if (firstTs < 0) {
      firstTs = env.ts;
      runId = env.runId;
    }
    lastTs = env.ts;

    const ev = env.event;
    if (ev.type === "run.started") {
      goal = ev.goal;
    }
    if (ev.type === "run.completed") {
      status = ev.status === "completed" ? "completed" : "failed";
    }
    if (ev.type === "run.failed") {
      status = "failed";
    }

    switch (ev.type) {
      case "model.request": {
        modelCalls++;
        pendingModelRequestTs = env.ts;
        break;
      }
      case "model.done": {
        if (pendingModelRequestTs > 0) {
          modelLatencyMs += env.ts - pendingModelRequestTs;
          pendingModelRequestTs = 0;
        }
        if (ev.usage) {
          totalTokens +=
            (ev.usage.promptTokens ?? 0) +
            (ev.usage.completionTokens ?? 0);
        }
        break;
      }
      case "model.truncated": {
        truncationCount++;
        break;
      }
      case "tool.result": {
        toolCalls++;
        if (ev.ok) toolSuccesses++;
        break;
      }
      case "loop.tick": {
        steps = Math.max(steps, ev.turn);
        break;
      }
      case "cost.update": {
        estimatedCost = ev.estimatedCostUsd ?? (ev as { estimatedCost?: number }).estimatedCost ?? 0;
        costCurrency = ev.costCurrency ?? "USD";
        break;
      }
    }
  }

  return {
    runId,
    goal,
    status,
    durationMs: firstTs < 0 ? 0 : lastTs - firstTs,
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
 * Convenience wrapper: read a JSONL file and compute metrics.
 *
 * @param path Absolute or relative path to a JSONL file where each line
 *   is a JSON-serialised {@link RunEventEnvelope}.
 */
export async function evaluateRunFromJsonl(path: string): Promise<RunMetrics> {
  const text = await readFile(path, "utf-8");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const envelopes: RunEventEnvelope[] = lines.map((line) =>
    JSON.parse(line),
  );
  return evaluateRunFromEnvelopes(envelopes);
}
