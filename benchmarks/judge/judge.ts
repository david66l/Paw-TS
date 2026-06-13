/**
 * LLM-as-a-Judge evaluator for agent responses.
 *
 * Inject any {@link LanguageModel} (DeepSeek-V3, Qwen-Plus, GPT-4o-mini, etc.).
 * The judge returns structured per-dimension scores plus an overall verdict.
 */

import type { LanguageModel } from "../../packages/models/src/index.js";

import { buildJudgePrompt, computeOverall } from "./prompts.js";
import type {
  JudgeConfig,
  JudgeDimensionResult,
  JudgeInput,
  JudgeResult,
} from "./types.js";

interface RawJudgeOutput {
  readonly dimensions?: readonly Partial<JudgeDimensionResult>[];
  readonly verdict?: string;
}

function safeParseJson(text: string): unknown {
  // Strip markdown fences if the model ignored instructions.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function normalizeDimension(
  raw: Partial<JudgeDimensionResult> | undefined,
): JudgeDimensionResult | null {
  if (!raw || !raw.dimension) return null;
  return {
    dimension: raw.dimension,
    score: clampScore(raw.score ?? 1),
    reasoning:
      typeof raw.reasoning === "string" && raw.reasoning.trim()
        ? raw.reasoning.trim()
        : "No reasoning provided.",
  };
}

/**
 * Evaluate an agent response with an LLM judge.
 *
 * @param model A {@link LanguageModel} to use as the judge.
 * @param input The user request and agent response to evaluate.
 * @param config Optional evaluation dimensions and weights.
 * @returns Structured scores and verdict.
 */
export async function judgeResponse(
  model: LanguageModel,
  input: JudgeInput,
  config?: JudgeConfig,
): Promise<JudgeResult> {
  const prompt = buildJudgePrompt(input, config);
  const result = await model.complete([
    { role: "user", content: prompt },
  ]);

  const parsed = safeParseJson(result.text) as RawJudgeOutput | undefined;
  const rawDimensions = parsed?.dimensions ?? [];
  const dimensions = rawDimensions
    .map(normalizeDimension)
    .filter((d): d is JudgeDimensionResult => d !== null);

  const overall = computeOverall(dimensions, config);

  return {
    dimensions,
    overall,
    verdict:
      typeof parsed?.verdict === "string" && parsed.verdict.trim()
        ? parsed.verdict.trim()
        : "No verdict provided.",
  };
}

/**
 * Batch-evaluate multiple agent outputs and report aggregate metrics.
 */
export async function judgeBatch(
  model: LanguageModel,
  inputs: readonly JudgeInput[],
  config?: JudgeConfig,
): Promise<{ readonly results: readonly JudgeResult[]; readonly averageOverall: number }> {
  const results: JudgeResult[] = [];
  for (const input of inputs) {
    results.push(await judgeResponse(model, input, config));
  }
  const averageOverall =
    results.length === 0
      ? 0
      : Math.round(
          (results.reduce((sum, r) => sum + r.overall, 0) / results.length) * 100,
        ) / 100;
  return { results, averageOverall };
}
